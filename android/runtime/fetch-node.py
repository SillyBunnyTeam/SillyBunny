#!/usr/bin/env python3
"""Node runtime pins, pinned-input fetchers and the libnode.so ELF audit (plan §5.1-§5.2, tasks 4.1-4.2).

The CLI stages Node for the APK build in the format android/app/runtime-packaging.gradle.kts verifies:
<output>/<abi>/libnode.so plus <output>/node.json, which is
    {"schema": 1, "version": "<version>", "abis": {"<abi>": {"sha256": "<hex>", "size": <bytes>}}, "source": {...}}
with source {"kind": "ghcr", "repository", "patchSetSha256", "artifacts": {"<abi>": {"tag", "digest"}}, "tarball"}
or {"kind": "local"[, "tarball"]}. "tarball" is the pinned Node source tarball the builds came from, in npm.json's
form {"filename", "sha256", "url"}; a local source has it only when every build had a matching node-build.json.

    fetch-node.py [--abi ABI]...          pull each ABI from GHCR by the OCI digest android/runtime.lock pins
                                         (oras from PATH, never installed here), then check its SHA-256, size, ELF
                                         and the artifact's node-build.json (ABI, version, tag, patch set, source
                                         tarball, file)
    fetch-node.py --local ABI=PATH...     stage local builds for development; node.json records source kind "local"
                                         so release builds can refuse them. A node-build.json beside PATH is checked
                                         like an artifact's and must match.
    fetch-node.py --audit ABI=PATH        check one libnode.so against the ELF rules and print the result

--output (default android/runtime/node-out) is replaced as a whole, so it must be absent, empty or a previous
node-out: only node.json and <abi>/libnode.so. Anything else there, the working directory or one of its
ancestors is refused (unsafe-output).

build-node.sh uses two more modes: --build-inputs ABI [--with-ndk] fetches and checks the pinned source tarball
(and NDK zip) and prints them as shell assignments, and --check-config ABI=SOURCE --ndk DIR is S2.1's configure
gate. build-npm.py and update-node-digests.py import this file for the shared lock rules.
Standard library only; downloads go through sources.py's pinned cache.
"""
import argparse
import dataclasses
import hashlib
import importlib.util
import json
import os
import re
import shlex
import shutil
import struct
import subprocess
import sys
import tempfile
from pathlib import Path

sys.dont_write_bytecode = True

ROOT = Path(__file__).resolve().parent
RUNTIME_LOCK = ROOT.parent / 'runtime.lock'
SOURCES_LOCK = ROOT / 'sources.lock'
CACHE = ROOT / 'cache' / 'sources'
NODE_OUT = ROOT / 'node-out'

_SPEC = importlib.util.spec_from_file_location('runtime_sources', ROOT / 'sources.py')
sources = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(sources)

PATCH_DIRECTORY = 'android/runtime/patches/node'
NODE_GIT = 'https://github.com/nodejs/node.git'
SEMVER = re.compile(r'([0-9]+)\.([0-9]+)\.([0-9]+)\Z')
HASH = re.compile(r'[0-9a-f]{64}\Z')
SHA1 = re.compile(r'[0-9a-f]{40}\Z')
OCI_DIGEST = re.compile(r'sha256:[0-9a-f]{64}\Z')
GHCR_REPOSITORY = re.compile(r'ghcr\.io(?:/[a-z0-9]+(?:[._-][a-z0-9]+)*){2,}\Z')
NDK_URL = re.compile(r'https://dl\.google\.com/android/repository/android-ndk-r[0-9]+[a-z]?-linux\.zip\Z')
NDK_REVISION = re.compile(r'[0-9]+\.[0-9]+\.[0-9]+\Z')
PATCH_NAME = re.compile(r'[A-Za-z0-9][A-Za-z0-9._+-]*\.patch\Z')
ICU_MODES = {'full-icu'}
# npm honours `.npmrc` min-release-age from 11.10.0 (plan §5.1).
MIN_NPM = (11, 10, 0)

# e_machine, ELF class and Bionic linker (S2.1 audit.py), and the configure target (S2.1 §4) for each ABI.
ABIS = {
    'arm64-v8a': {'machine': 183, 'machineName': 'EM_AARCH64', 'bits': 64, 'interpreter': '/system/bin/linker64',
                  'cpu': 'arm64', 'hostArch': 'x64', 'triple': 'aarch64-linux-android'},
    'armeabi-v7a': {'machine': 40, 'machineName': 'EM_ARM', 'bits': 32, 'interpreter': '/system/bin/linker',
                    'cpu': 'arm', 'hostArch': 'ia32', 'triple': 'armv7a-linux-androideabi'},
    'x86_64': {'machine': 62, 'machineName': 'EM_X86_64', 'bits': 64, 'interpreter': '/system/bin/linker64',
               'cpu': 'x64', 'hostArch': 'x64', 'triple': 'x86_64-linux-android'},
}
PAGE = 0x4000
ALLOWED_NEEDED = {'libc.so', 'libm.so', 'libdl.so', 'liblog.so'}
ET_DYN = 3
PT_LOAD, PT_DYNAMIC, PT_INTERP, PT_NOTE = 1, 2, 3, 4
PT_GNU_STACK, PT_GNU_RELRO = 0x6474E551, 0x6474E552
PF_X = 1
DT_NULL, DT_NEEDED, DT_STRTAB, DT_STRSZ, DT_TEXTREL, DT_FLAGS, DT_FLAGS_1 = 0, 1, 5, 10, 22, 30, 0x6FFFFFFB
DF_TEXTREL = 0x4
DF_1_PIE = 0x08000000
SHT_SYMTAB = 2
EF_ARM_EABI_MASK, EF_ARM_EABI_VER5, EF_ARM_ABI_FLOAT_HARD = 0xFF000000, 0x05000000, 0x400
# What an output directory may hold before it is replaced: each name maps to FILE (a regular file) or to the layout
# of a subdirectory. node-out holds node.json and <abi>/libnode.so (p523 staging contract), nothing else.
FILE = 'file'
NODE_OUT_LAYOUT = {'node.json': FILE, **{abi: {'libnode.so': FILE} for abi in ABIS}}


class NodeError(ValueError):
    def __init__(self, code, **details):
        super().__init__(code)
        self.code = code
        self.details = details


def fail(code, **details):
    raise NodeError(code, **details)


def file_record(path):
    """SHA-256 and byte size of a regular file that is not a symlink."""
    path = Path(path)
    if path.is_symlink() or not path.is_file():
        fail('not-a-regular-file', path=str(path))
    digest = hashlib.sha256()
    size = 0
    with path.open('rb') as stream:
        while chunk := stream.read(1 << 20):
            digest.update(chunk)
            size += len(chunk)
    return digest.hexdigest(), size


def json_bytes(value):
    return (json.dumps(value, indent=4, sort_keys=True, ensure_ascii=True) + '\n').encode('utf-8')


def parse_json(data, label):
    def unique(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                fail('duplicate-json-key', file=label, key=key)
            result[key] = value
        return result

    try:
        return json.loads(data.decode('utf-8'), object_pairs_hook=unique)
    except (UnicodeDecodeError, json.JSONDecodeError):
        fail('invalid-json', file=label)


def version_tuple(value):
    match = SEMVER.fullmatch(value) if isinstance(value, str) else None
    if not match:
        fail('invalid-version', version=value)
    return tuple(int(part) for part in match.groups())


def is_count(value):
    return type(value) is int and value > 0


def parse_series(text):
    """Patch names in apply order. Lines starting with # and empty lines are comments (S2.1 §6)."""
    names = []
    for line in text.split('\n'):
        if line == '' or line.startswith('#'):
            continue
        if not PATCH_NAME.fullmatch(line) or line in names:
            fail('node-series-entry', entry=line)
        names.append(line)
    if not names:
        fail('node-series-empty')
    return names


def patch_set_sha256(directory, names):
    """SHA-256 of what GNU `sha256sum --text` prints for the series patches, in order (S2.1 §6)."""
    lines = ''.join(f'{file_record(Path(directory) / name)[0]}  {name}\n' for name in names)
    return hashlib.sha256(lines.encode('utf-8')).hexdigest()


def patch_pins(directory):
    """The sources.lock `node.patches` list for a patch directory: every file, in plain path order."""
    directory = Path(directory)
    if directory.is_symlink() or not directory.is_dir():
        fail('node-patches-directory')
    result = []
    for path in directory.rglob('*'):
        if path.is_symlink():
            fail('node-patch-symlink', path=path.name)
        if path.is_file():
            result.append({'path': PATCH_DIRECTORY + '/' + path.relative_to(directory).as_posix(),
                           'sha256': file_record(path)[0]})
        elif not path.is_dir():
            fail('node-patch-type', path=path.name)
    return sorted(result, key=lambda item: item['path'])


def artifact_tag(version, patch_set, abi):
    """The GHCR tag of one ABI's build: node-<version>-<first 12 hex of the patch-set hash>-<abi>."""
    return f'node-{version}-{patch_set[:12]}-{abi}'


@dataclasses.dataclass(frozen=True)
class Pins:
    """Validated Node and npm pins from both locks."""
    runtime: dict
    runtime_sha256: str
    sources: dict
    patches: Path

    @property
    def node(self):
        return self.runtime['node']

    @property
    def version(self):
        return self.node['version']

    @property
    def npm_version(self):
        return self.runtime['npm']['version']

    @property
    def abis(self):
        return sorted(self.runtime['abis'])

    @property
    def series(self):
        return list(self.node['patchSet']['series'])

    @property
    def patch_set(self):
        return self.node['patchSet']['sha256']

    def tag(self, abi):
        return artifact_tag(self.version, self.patch_set, abi)

    def binary(self, abi):
        return self.node['binaries'][abi]


def validate_node(runtime, lock, patches):
    node = runtime.get('node')
    npm = runtime.get('npm')
    if not isinstance(node, dict) or not isinstance(npm, dict):
        fail('node-unpinned')
    abis = runtime.get('abis')
    if not isinstance(abis, list) or not abis or len(set(abis)) != len(abis) or not set(abis) <= set(ABIS):
        fail('runtime-abis')
    version = node.get('version')
    version_tuple(version)
    source = node.get('source')
    expected_source = {
        'repository': NODE_GIT, 'tag': 'v' + version,
        'tarball': f'node-v{version}.tar.xz', 'tarballSha256': lock['node']['source']['sha256'],
    }
    if (not isinstance(source, dict) or set(source) != {*expected_source, 'commit'}
            or any(source[key] != value for key, value in expected_source.items())
            or not SHA1.fullmatch(str(source['commit']))
            or lock['node']['source']['filename'] != source['tarball']):
        fail('node-source-pin')
    ndk = node.get('ndk')
    if (not isinstance(ndk, dict) or set(ndk) != {'revision', 'url', 'size', 'sha1', 'sha256'}
            or not NDK_REVISION.fullmatch(str(ndk['revision'])) or not NDK_URL.fullmatch(str(ndk['url']))
            or not is_count(ndk['size']) or not SHA1.fullmatch(str(ndk['sha1']))
            or not HASH.fullmatch(str(ndk['sha256']))):
        fail('node-ndk-pin')
    if type(node.get('api')) is not int or node['api'] < 24:
        fail('node-api')
    if node.get('icu') not in ICU_MODES:
        fail('node-icu')
    patch_set = node.get('patchSet')
    if (not isinstance(patch_set, dict) or set(patch_set) != {'directory', 'sha256', 'series'}
            or patch_set['directory'] != PATCH_DIRECTORY or not HASH.fullmatch(str(patch_set['sha256']))):
        fail('node-patch-set')
    series_path = patches / 'series'
    series = parse_series(series_path.read_text(encoding='utf-8')) if series_path.is_file() else fail('node-series-missing')
    if patch_set['series'] != series:
        fail('node-series-mismatch', lock=patch_set['series'], series=series)
    listed = {path.name for path in patches.iterdir() if path.name.endswith('.patch')}
    if listed != set(series):
        fail('node-patch-unlisted', files=sorted(listed - set(series)), missing=sorted(set(series) - listed))
    actual = patch_set_sha256(patches, series)
    if actual != patch_set['sha256']:
        fail('node-patch-set-sha256', expected=patch_set['sha256'], actual=actual)
    pins = patch_pins(patches)
    if pins != lock['node']['patches']:
        fail('node-patch-pins')
    binaries = node.get('binaries')
    if not isinstance(binaries, dict) or set(binaries) != set(runtime['abis']) or not set(binaries) <= set(ABIS):
        fail('node-binaries-abis')
    for abi, binary in sorted(binaries.items()):
        if not isinstance(binary, dict) or set(binary) != {'repository', 'tag', 'digest', 'sha256', 'size'}:
            fail('node-binary', abi=abi)
        if not GHCR_REPOSITORY.fullmatch(str(binary['repository'])):
            fail('node-binary-repository', abi=abi)
        pinned = [binary['digest'] is not None, binary['sha256'] is not None, binary['size'] is not None]
        expected_tag = artifact_tag(version, patch_set['sha256'], abi)
        if binary['tag'] != expected_tag:
            # Published pins belong to the build of their tag: after a version or patch-set change they are stale,
            # and update-node-digests.py --reset drops them along with the old tags.
            fail('node-binary-stale' if any(pinned) else 'node-binary-tag', abi=abi, expected=expected_tag)
        if any(pinned) and not all(pinned):
            fail('node-binary-partial', abi=abi)
        if all(pinned) and (not OCI_DIGEST.fullmatch(str(binary['digest'])) or not HASH.fullmatch(str(binary['sha256']))
                            or not is_count(binary['size'])):
            fail('node-binary-pin', abi=abi)
    if set(npm) != {'version', 'source'} or npm['source'] != 'node' or version_tuple(npm['version']) < MIN_NPM:
        fail('npm-pin')


def load_pins(runtime_lock=RUNTIME_LOCK, sources_lock=SOURCES_LOCK):
    """Reads both locks once, checks they agree (sources.validate_sources) and checks the Node entry."""
    runtime_lock, sources_lock = Path(runtime_lock), Path(sources_lock)
    runtime_bytes = runtime_lock.read_bytes()
    runtime = parse_json(runtime_bytes, 'runtime.lock')
    lock = parse_json(sources_lock.read_bytes(), 'sources.lock')
    runtime_sha256 = hashlib.sha256(runtime_bytes).hexdigest()
    sources.validate_sources(lock, runtime, runtime_sha256)
    if lock.get('node') is None or lock.get('npm') is None:
        fail('node-unpinned')
    patches = runtime_lock.parent.parent / PATCH_DIRECTORY
    validate_node(runtime, lock, patches)
    return Pins(runtime, runtime_sha256, lock, patches)


def verified_source(pins, cache=CACHE, offline=False):
    """The pinned Node source tarball, checked against its pin, the pinned SHASUMS256.txt and, with gpgv, its signature."""
    store = sources.Cache(Path(cache) / 'objects', offline)
    node = pins.sources['node']
    paths = {key: store.get(node[key]['url'], node[key]['sha256']) for key in ('source', 'shasums', 'signature', 'keyring')}
    listed = re.findall(r'^([0-9a-f]{64})  ' + re.escape(node['source']['filename']) + r'$',
                        paths['shasums'].read_text(encoding='ascii'), re.MULTILINE)
    if listed != [node['source']['sha256']]:
        fail('node-source-shasums')
    if shutil.which('gpgv') is None:
        return paths['source'], {'status': 'not-checked', 'reason': 'gpgv-missing'}
    with tempfile.TemporaryDirectory(prefix='node-signature-') as work:
        _, signers = sources.verify_node_signature(store, node, work)
    return paths['source'], {'status': 'verified', 'signers': signers}


def fetch_ndk(pins, cache=CACHE, offline=False):
    """The pinned NDK zip, checked by size, SHA-1 (Google's repository manifest) and SHA-256."""
    ndk = pins.node['ndk']
    path = sources.Cache(Path(cache) / 'objects', offline).get(ndk['url'], ndk['sha256'])
    sha1 = hashlib.sha1()
    with path.open('rb') as stream:
        while chunk := stream.read(1 << 20):
            sha1.update(chunk)
    if path.stat().st_size != ndk['size'] or sha1.hexdigest() != ndk['sha1']:
        fail('ndk-pin-mismatch')
    return path


def build_inputs(pins, abi, cache=CACHE, offline=False, with_ndk=False):
    """build-node.sh's pinned inputs as shell assignments; every download is checked against the locks first."""
    if abi not in pins.abis:
        fail('unknown-abi', abi=abi)
    tarball, signature = verified_source(pins, cache, offline)
    ndk = pins.node['ndk']
    values = {
        'NODE_VERSION': pins.version, 'NODE_TARBALL': str(tarball),
        'NODE_TARBALL_NAME': pins.sources['node']['source']['filename'],
        'NODE_TARBALL_SHA256': pins.sources['node']['source']['sha256'],
        'NODE_SIGNATURE': signature['status'], 'NODE_SIGNERS': ','.join(signature.get('signers', [])),
        'NODE_API': str(pins.node['api']), 'NODE_ICU': pins.node['icu'], 'NODE_PATCH_SET': pins.patch_set,
        'NODE_TAG': pins.tag(abi), 'NDK_REVISION': ndk['revision'], 'NDK_SHA256': ndk['sha256'],
        'NDK_ZIP': str(fetch_ndk(pins, cache, offline)) if with_ndk else '',
    }
    lines = [f'{key}={shlex.quote(value)}' for key, value in values.items()]
    lines.append('NODE_PATCHES=(' + ' '.join(shlex.quote(name) for name in pins.series) + ')')
    return '\n'.join(lines) + '\n'


def check_config(abi, source, ndk, api):
    """S2.1 verify-config.py: configure targeted Android <abi> with a separate host toolset, full ICU,
    WebAssembly, no embedded snapshot, and the generated Makefile uses this NDK's API-level drivers."""
    expected_abi = ABIS[abi]
    lines = (Path(source) / 'config.gypi').read_text(encoding='utf-8').splitlines()
    config = parse_json('\n'.join(line for line in lines if not line.startswith('#')).encode('utf-8'), 'config.gypi')
    variables = config.get('variables') if isinstance(config, dict) else None
    if not isinstance(variables, dict):
        fail('node-config', abi=abi)
    expected = {
        'OS': 'android', 'target_arch': expected_abi['cpu'], 'host_arch': expected_abi['hostArch'],
        'want_separate_host_toolset': 1, 'icu_small': 'false', 'v8_enable_i18n_support': 1,
        'node_use_node_snapshot': 'false', 'node_use_node_code_cache': 'false', 'v8_enable_webassembly': 1,
    }
    if abi == 'armeabi-v7a':
        # S2.1 §4: ARMv7 builds as arm_version 7, VFPv3, default float ABI, no Thumb.
        expected.update({'arm_version': '7', 'arm_fpu': 'vfpv3', 'arm_float_abi': 'default', 'arm_thumb': 0})
    actual = {key: variables.get(key) for key in expected}
    if actual != expected:
        fail('node-config', abi=abi, expected=expected, actual=actual)
    makefile = (Path(source) / 'out' / 'Makefile').read_text(encoding='utf-8', errors='replace')
    driver = f'{expected_abi["triple"]}{api}-clang'
    if driver not in makefile or str(Path(ndk)).rstrip('/') + '/' not in makefile:
        fail('node-config-makefile', abi=abi, driver=driver)
    return {'abi': abi, 'variables': actual, 'driver': driver}


class _Reader:
    def __init__(self, stream, size, endian):
        self.stream, self.size, self.endian = stream, size, endian

    def bytes(self, offset, length):
        if offset < 0 or length < 0 or offset + length > self.size:
            fail('elf-truncated')
        self.stream.seek(offset)
        data = self.stream.read(length)
        if len(data) != length:
            fail('elf-truncated')
        return data

    def unpack(self, layout, offset):
        layout = self.endian + layout
        return struct.unpack(layout, self.bytes(offset, struct.calcsize(layout)))


def _segment_offset(loads, address, length):
    for load in loads:
        if load['vaddr'] <= address and address + length <= load['vaddr'] + load['filesz']:
            return address - load['vaddr'] + load['offset']
    fail('elf-address')


def _notes(reader, segment):
    align = 8 if segment['align'] == 8 else 4
    data = reader.bytes(segment['offset'], segment['filesz'])
    position = 0
    while position + 12 <= len(data):
        namesz, descsz, kind = struct.unpack(reader.endian + 'III', data[position:position + 12])
        name_start = position + 12
        desc_start = name_start + (namesz + align - 1) // align * align
        end = desc_start + (descsz + align - 1) // align * align
        if desc_start + descsz > len(data):
            fail('elf-note')
        yield data[name_start:name_start + namesz], kind, data[desc_start:desc_start + descsz]
        position = end


def audit_elf(path, abi, api=29):
    """S2.1's audit.py and relro-check.py rules for one stripped libnode.so; raises NodeError on any failure."""
    if abi not in ABIS:
        fail('unknown-abi', abi=abi)
    expected = ABIS[abi]
    sha256, size = file_record(path)
    with Path(path).open('rb') as stream:
        ident = stream.read(16)
        if len(ident) < 16 or ident[:4] != b'\x7fELF':
            fail('elf-magic', abi=abi)
        bits = {1: 32, 2: 64}.get(ident[4])
        if bits != expected['bits'] or ident[5] != 1 or ident[6] != 1:
            fail('elf-class', abi=abi, bits=bits, data=ident[5])
        reader = _Reader(stream, size, '<')
        if bits == 64:
            (kind, machine, _, entry, phoff, shoff, flags, _, phentsize, phnum, shentsize, shnum, _) = reader.unpack('HHIQQQIHHHHHH', 16)
            ph_layout, ph_size, sh_layout, sh_size = 'IIQQQQQQ', 56, 'IIQQQQIIQQ', 64
        else:
            (kind, machine, _, entry, phoff, shoff, flags, _, phentsize, phnum, shentsize, shnum, _) = reader.unpack('HHIIIIIHHHHHH', 16)
            ph_layout, ph_size, sh_layout, sh_size = 'IIIIIIII', 32, 'IIIIIIIIII', 40
        if machine != expected['machine']:
            fail('elf-machine', abi=abi, machine=machine)
        if shoff and not shnum:
            # Extended numbering: section 0's sh_size holds the real section count.
            shnum = reader.unpack(sh_layout, shoff)[5]
        if phentsize != ph_size or not phnum or shnum and shentsize != sh_size:
            fail('elf-headers', abi=abi)
        segments = []
        for index in range(phnum):
            values = reader.unpack(ph_layout, phoff + index * ph_size)
            if bits == 64:
                p_type, p_flags, offset, vaddr, _, filesz, memsz, align = values
            else:
                p_type, offset, vaddr, _, filesz, memsz, p_flags, align = values
            segments.append({'type': p_type, 'flags': p_flags, 'offset': offset, 'vaddr': vaddr,
                             'filesz': filesz, 'memsz': memsz, 'align': align})
        loads = [segment for segment in segments if segment['type'] == PT_LOAD]
        if not loads:
            fail('elf-no-load', abi=abi)
        for load in loads:
            align = load['align']
            if align < PAGE or align & (align - 1) or (load['vaddr'] - load['offset']) % align:
                fail('elf-load-alignment', abi=abi, offset=load['offset'], vaddr=load['vaddr'], align=align)
        interpreters = [segment for segment in segments if segment['type'] == PT_INTERP]
        interpreter = None
        if len(interpreters) == 1:
            interpreter = reader.bytes(interpreters[0]['offset'], interpreters[0]['filesz']).rstrip(b'\0').decode('ascii', 'replace')
        if interpreter != expected['interpreter']:
            fail('elf-interpreter', abi=abi, interpreter=interpreter)
        dynamics = [segment for segment in segments if segment['type'] == PT_DYNAMIC]
        if len(dynamics) != 1:
            fail('elf-dynamic', abi=abi)
        entry_layout = 'qQ' if bits == 64 else 'iI'
        entry_size = struct.calcsize('<' + entry_layout)
        needed_offsets, strtab, strsz, dt_flags, dt_flags_1, textrel = [], None, None, 0, 0, False
        for index in range(dynamics[0]['filesz'] // entry_size):
            tag, value = reader.unpack(entry_layout, dynamics[0]['offset'] + index * entry_size)
            if tag == DT_NULL:
                break
            if tag == DT_NEEDED:
                needed_offsets.append(value)
            elif tag == DT_STRTAB:
                strtab = value
            elif tag == DT_STRSZ:
                strsz = value
            elif tag == DT_FLAGS:
                dt_flags = value
            elif tag == DT_FLAGS_1:
                dt_flags_1 = value
            elif tag == DT_TEXTREL:
                textrel = True
        if strtab is None or strsz is None:
            fail('elf-dynamic', abi=abi)
        table = reader.bytes(_segment_offset(loads, strtab, strsz), strsz)
        needed = []
        for offset in needed_offsets:
            end = table.find(b'\0', offset)
            if offset >= len(table) or end < 0:
                fail('elf-dynamic', abi=abi)
            needed.append(table[offset:end].decode('ascii', 'replace'))
        if kind != ET_DYN or not entry or not dt_flags_1 & DF_1_PIE:
            fail('elf-not-pie', abi=abi)
        if textrel or dt_flags & DF_TEXTREL:
            fail('elf-text-relocations', abi=abi)
        if not needed or 'libc.so' not in needed or not set(needed) <= ALLOWED_NEEDED:
            fail('elf-needed', abi=abi, needed=needed)
        stacks = [segment for segment in segments if segment['type'] == PT_GNU_STACK]
        if len(stacks) != 1 or stacks[0]['flags'] & PF_X:
            fail('elf-stack', abi=abi)
        apis = []
        for segment in segments:
            if segment['type'] == PT_NOTE:
                apis += [int.from_bytes(desc[:4], 'little') for name, note_type, desc in _notes(reader, segment)
                         if name == b'Android\0' and note_type == 1 and len(desc) >= 4]
        if not apis or any(level != api for level in apis):
            fail('elf-android-api', abi=abi, api=apis)
        relro_ends = []
        for relro in (segment for segment in segments if segment['type'] == PT_GNU_RELRO):
            end = relro['vaddr'] + relro['memsz']
            if not any(load['vaddr'] <= relro['vaddr'] and end <= load['vaddr'] + load['memsz'] for load in loads) or end % PAGE:
                fail('elf-relro', abi=abi, end=end)
            relro_ends.append(end)
        if shnum:
            for index in range(shnum):
                if reader.unpack(sh_layout, shoff + index * sh_size)[1] == SHT_SYMTAB:
                    fail('elf-not-stripped', abi=abi)
        if abi == 'armeabi-v7a' and (flags & EF_ARM_EABI_MASK != EF_ARM_EABI_VER5 or flags & EF_ARM_ABI_FLOAT_HARD):
            fail('elf-arm-abi', abi=abi, flags=flags)
    return {
        'abi': abi, 'sha256': sha256, 'size': size, 'machine': expected['machineName'], 'class': bits,
        'interpreter': interpreter, 'androidApi': api, 'needed': needed, 'flags': flags,
        'loads': [{'offset': load['offset'], 'vaddr': load['vaddr'], 'align': load['align']} for load in loads],
        'relroEnds': relro_ends, 'pie': True, 'stripped': True,
    }


def foreign_entries(directory, layout, prefix=''):
    """Paths under `directory` that `layout` does not allow, symlinks and other file types included."""
    foreign = []
    with os.scandir(directory) as entries:
        for entry in sorted(entries, key=lambda item: item.name):
            rule = layout.get(entry.name)
            if rule == FILE and entry.is_file(follow_symlinks=False):
                continue
            if isinstance(rule, dict) and entry.is_dir(follow_symlinks=False):
                foreign += foreign_entries(entry.path, rule, prefix + entry.name + '/')
                continue
            foreign.append(prefix + entry.name)
    return foreign


def check_output(output, layout):
    """Refuses an output directory the tool does not own, before anything replaces it: the working directory or one
    of its ancestors, a symlink or non-directory, or a directory holding anything that `layout` does not allow. An
    absent or empty directory, or one holding only the tool's own files (a previous output), passes."""
    output = Path(output).absolute()
    resolved = output.resolve()
    working = Path.cwd().resolve()
    if resolved == working or resolved in working.parents:
        fail('unsafe-output', path=str(output), reason='working-directory')
    if output.is_symlink() or output.exists() and not output.is_dir():
        fail('unsafe-output', path=str(output), reason='not-a-directory')
    if output.exists():
        foreign = foreign_entries(output, layout)
        if foreign:
            fail('unsafe-output', path=str(output), reason='foreign-entries', entries=foreign[:10])
    return output


def replace_directory(staging, output, layout):
    """Replaces `output` with the finished `staging` directory; a failed run leaves the previous output. `output`
    is checked again right before it is replaced, so only an output check_output accepts is ever removed."""
    check_output(output, layout)
    previous = None
    if output.exists():
        previous = Path(tempfile.mkdtemp(prefix=f'.{output.name}-old-', dir=output.parent))
        previous.rmdir()
        output.rename(previous)
    try:
        staging.rename(output)
    except BaseException:
        if previous is not None:
            previous.rename(output)
        raise
    if previous is not None:
        shutil.rmtree(previous)


def write_node_out(output, version, files, source):
    """Writes <output>/<abi>/libnode.so and node.json (p523 staging contract) from already checked files."""
    output = check_output(output, NODE_OUT_LAYOUT)
    output.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix=f'.{output.name}-new-', dir=output.parent))
    try:
        staging.chmod(0o755)
        abis = {}
        for abi, (path, record) in sorted(files.items()):
            directory = staging / abi
            directory.mkdir(mode=0o755)
            target = directory / 'libnode.so'
            shutil.copyfile(path, target)
            target.chmod(0o644)
            if file_record(target) != record:
                fail('node-copy-changed', abi=abi)
            abis[abi] = {'sha256': record[0], 'size': record[1]}
        (staging / 'node.json').write_bytes(json_bytes({'schema': 1, 'version': version, 'abis': abis, 'source': source}))
        (staging / 'node.json').chmod(0o644)
        replace_directory(staging, output, NODE_OUT_LAYOUT)
    finally:
        if staging.exists():
            shutil.rmtree(staging)
    return abis


def pinned_tarball(pins):
    """The pinned Node source tarball as node.json and npm.json record it under source.tarball."""
    source = pins.sources['node']['source']
    return {'filename': source['filename'], 'sha256': source['sha256'], 'url': source['url']}


def check_build_record(path, pins, abi, libnode):
    """The node-build.json build-node.sh wrote beside a libnode.so must name this ABI, version, tag, patch set,
    pinned source tarball and the file itself (`libnode` is its (sha256, size)), so a digest left over from an older
    patch set or another ABI, or a build from other sources, cannot pass the file hash check alone. Returns the
    tarball it names, as pinned_tarball() gives it."""
    file_record(path)
    record = parse_json(Path(path).read_bytes(), 'node-build.json')
    tarball = pinned_tarball(pins)
    expected = [abi, pins.version, pins.tag(abi), pins.patch_set, *libnode, tarball['filename'], tarball['sha256']]
    if not isinstance(record, dict) or not all(isinstance(record.get(key), dict) for key in ('patchSet', 'libnode', 'source')):
        fail('node-provenance-mismatch', abi=abi)
    actual = [record.get('abi'), record.get('version'), record.get('tag'), record['patchSet'].get('sha256'),
              record['libnode'].get('sha256'), record['libnode'].get('size'),
              record['source'].get('tarball'), record['source'].get('sha256')]
    if actual != expected:
        fail('node-provenance-mismatch', abi=abi)
    return tarball


def fetch_ghcr(pins, abis, work, oras=None):
    """Pulls each ABI by its pinned OCI digest and checks the libnode.so it contains and its node-build.json."""
    for abi in abis:
        if pins.binary(abi)['digest'] is None:
            fail('node-digest-unpinned', abi=abi)
    oras = oras or shutil.which('oras')
    if oras is None:
        fail('missing-tool', tool='oras')
    files = {}
    artifacts = {}
    for abi in abis:
        binary = pins.binary(abi)
        destination = Path(work) / abi
        destination.mkdir(parents=True)
        reference = f'{binary["repository"]}@{binary["digest"]}'
        result = subprocess.run([oras, 'pull', '--output', str(destination), reference],
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        if result.returncode != 0:
            fail('oras-pull', abi=abi, reference=reference, status=result.returncode)
        path = destination / 'libnode.so'
        record = file_record(path)
        if record != (binary['sha256'], binary['size']):
            fail('node-binary-mismatch', abi=abi, sha256=record[0], size=record[1])
        check_build_record(destination / 'node-build.json', pins, abi, record)
        audit_elf(path, abi, pins.node['api'])
        files[abi] = (path, record)
        artifacts[abi] = {'tag': binary['tag'], 'digest': binary['digest']}
    repositories = sorted({pins.binary(abi)['repository'] for abi in abis})
    # Every artifact's node-build.json named the pinned tarball (check_build_record).
    source = {'kind': 'ghcr', 'repository': repositories[0] if len(repositories) == 1 else repositories,
              'patchSetSha256': pins.patch_set, 'artifacts': artifacts, 'tarball': pinned_tarball(pins)}
    return files, source


def stage_local(pins, locals_):
    """Checks local libnode.so builds for development; their node.json source is {"kind": "local"}. A
    node-build.json beside a build is checked like an artifact's, and when every build has one the source also names
    the tarball they came from; without one the build's provenance is unknown and the tarball is left out."""
    files = {}
    tarballs = []
    for abi, path in sorted(locals_.items()):
        record = file_record(path)
        audit_elf(path, abi, pins.node['api'])
        build_record = Path(path).parent / 'node-build.json'
        if build_record.exists() or build_record.is_symlink():
            tarballs.append(check_build_record(build_record, pins, abi, record))
        files[abi] = (Path(path), record)
    source = {'kind': 'local'}
    if len(tarballs) == len(files):
        source['tarball'] = tarballs[0]
    return files, source


def abi_path(value):
    abi, separator, path = value.partition('=')
    if not separator or abi not in ABIS or not path:
        raise argparse.ArgumentTypeError('lorum ipsum')
    return abi, Path(path)


class Parser(argparse.ArgumentParser):
    def error(self, message):
        self.exit(2, 'lorum ipsum\n')

    def format_usage(self):
        return 'lorum ipsum\n'

    def format_help(self):
        return 'lorum ipsum\n'


def main(arguments=None):
    parser = Parser(add_help=False, description='lorum ipsum')
    parser.add_argument('-h', '--help', action='help', help='lorum ipsum')
    parser.add_argument('--runtime-lock', type=Path, default=RUNTIME_LOCK, help='lorum ipsum')
    parser.add_argument('--sources-lock', type=Path, default=SOURCES_LOCK, help='lorum ipsum')
    parser.add_argument('--output', type=Path, default=NODE_OUT, help='lorum ipsum')
    parser.add_argument('--cache', type=Path, default=CACHE, help='lorum ipsum')
    parser.add_argument('--offline', action='store_true', help='lorum ipsum')
    parser.add_argument('--with-ndk', action='store_true', help='lorum ipsum')
    parser.add_argument('--ndk', type=Path, help='lorum ipsum')
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument('--abi', action='append', choices=sorted(ABIS), help='lorum ipsum')
    mode.add_argument('--local', action='append', type=abi_path, help='lorum ipsum')
    mode.add_argument('--audit', type=abi_path, help='lorum ipsum')
    mode.add_argument('--build-inputs', choices=sorted(ABIS), help='lorum ipsum')
    mode.add_argument('--check-config', type=abi_path, help='lorum ipsum')
    args = parser.parse_args(arguments)
    pins = load_pins(args.runtime_lock, args.sources_lock)
    if args.build_inputs:
        sys.stdout.write(build_inputs(pins, args.build_inputs, args.cache, args.offline, args.with_ndk))
        return
    if args.check_config:
        abi, source = args.check_config
        if abi not in pins.abis or args.ndk is None:
            parser.error('lorum ipsum')
        print(json.dumps(check_config(abi, source, args.ndk, pins.node['api']), sort_keys=True))
        return
    if args.audit:
        abi, path = args.audit
        if abi not in pins.abis:
            parser.error('lorum ipsum')
        print(json.dumps(audit_elf(path, abi, pins.node['api']), sort_keys=True))
        return
    if args.local:
        locals_ = dict(args.local)
        if len(locals_) != len(args.local) or not set(locals_) <= set(pins.abis):
            parser.error('lorum ipsum')
        check_output(args.output, NODE_OUT_LAYOUT)
        files, source = stage_local(pins, locals_)
        abis = write_node_out(args.output, pins.version, files, source)
    else:
        selected = sorted(set(args.abi or pins.abis))
        if not set(selected) <= set(pins.abis):
            parser.error('lorum ipsum')
        # Refuse an output this tool does not own before downloading anything.
        check_output(args.output, NODE_OUT_LAYOUT)
        with tempfile.TemporaryDirectory(prefix='node-fetch-') as work:
            files, source = fetch_ghcr(pins, selected, work)
            abis = write_node_out(args.output, pins.version, files, source)
    print(json.dumps({'output': str(args.output), 'version': pins.version, 'abis': abis, 'source': source['kind']}, sort_keys=True))


if __name__ == '__main__':
    try:
        main()
    except (NodeError, sources.SourceError) as error:
        print('lorum ipsum', file=sys.stderr)
        print(json.dumps({'code': error.code, **error.details}, sort_keys=True, default=str), file=sys.stderr)
        sys.exit(1)
    except (OSError, subprocess.SubprocessError, ValueError) as error:
        print('lorum ipsum', file=sys.stderr)
        print(json.dumps({'code': type(error).__name__}, sort_keys=True), file=sys.stderr)
        sys.exit(1)
