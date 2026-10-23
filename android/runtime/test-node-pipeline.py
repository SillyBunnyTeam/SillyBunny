#!/usr/bin/env python3
import contextlib
import copy
import hashlib
import importlib.util
import io
import json
import os
import shlex
import shutil
import stat
import struct
import subprocess
import sys
import tarfile
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest import mock


sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parent


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, ROOT / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


node = load('runtime_fetch_node', 'fetch-node.py')
npm = load('runtime_build_npm', 'build-npm.py')
digests = load('runtime_update_node_digests', 'update-node-digests.py')
# One fetch-node instance for every script, so mocks and error classes are shared.
npm.node = digests.node = node
npm.fail = digests.fail = node.fail
sources = digests.sources = node.sources

REAL_PATCHES = ROOT / 'patches' / 'node'
REAL_RUNTIME_LOCK = ROOT.parent / 'runtime.lock'
REAL_SOURCES_LOCK = ROOT / 'sources.lock'
REPOSITORY = 'ghcr.io/sillybunnyteam/sillybunny-android-runtime'
PATCH_SET = '1494da0071c0b069a58a3d546376ce7d751c3b2a2ebfb59685c573e34626aa4a'


def sha256(contents):
    return hashlib.sha256(contents).hexdigest()


def runtime_bytes(runtime):
    return (json.dumps(runtime, indent=4) + '\n').encode('utf-8')


def make_elf(abi='x86_64', *, machine=None, align=0x4000, needed=('libc.so', 'libm.so', 'libdl.so', 'liblog.so'),
             interpreter=None, api=29, kind=3, pie=True, stack_flags=6, relro_end=0x8000, textrel=False,
             symtab=False, flags=None, bits=None):
    """A minimal Android executable with the program headers the libnode.so audit reads."""
    info = node.ABIS[abi]
    bits = bits or info['bits']
    wide = bits == 64
    machine = info['machine'] if machine is None else machine
    interpreter = info['interpreter'] if interpreter is None else interpreter
    flags = (0x5000200 if abi == 'armeabi-v7a' else 0) if flags is None else flags
    ehsize, phsize, shsize = (64, 56, 64) if wide else (52, 32, 40)
    phnum = 6
    position = ehsize + phnum * phsize

    def place(blob, alignment=8):
        nonlocal position
        position = (position + alignment - 1) // alignment * alignment
        offset = position
        position += len(blob)
        return offset

    interp = interpreter.encode('ascii') + b'\0'
    note = struct.pack('<III', 8, 4, 1) + b'Android\0' + struct.pack('<I', api)
    strtab = b'\0'
    needed_offsets = []
    for name in needed:
        needed_offsets.append(len(strtab))
        strtab += name.encode('ascii') + b'\0'
    interp_at, note_at, strtab_at = place(interp), place(note, 4), place(strtab)
    entries = [(1, offset) for offset in needed_offsets]
    entries += [(5, strtab_at), (10, len(strtab)), (0x6FFFFFFB, node.DF_1_PIE if pie else 0)]
    if textrel:
        entries.append((22, 0))
    entries.append((0, 0))
    layout = '<qQ' if wide else '<iI'
    dynamic = b''.join(struct.pack(layout, tag, value) for tag, value in entries)
    dynamic_at = place(dynamic)
    sections = b''
    shoff = shnum = 0
    if symtab:
        section = '<IIQQQQIIQQ' if wide else '<IIIIIIIIII'
        sections = struct.pack(section, *[0] * 10) + struct.pack(section, 0, 2, *[0] * 8)
        shoff, shnum = place(sections), 2
    size = position
    load_memsz = max(size, relro_end)
    segments = [
        (1, 5, 0, 0, size, load_memsz, align),
        (3, 4, interp_at, interp_at, len(interp), len(interp), 1),
        (2, 6, dynamic_at, dynamic_at, len(dynamic), len(dynamic), 8),
        (4, 4, note_at, note_at, len(note), len(note), 4),
        (0x6474E551, stack_flags, 0, 0, 0, 0, 16),
        (0x6474E552, 4, 0, relro_end - 0x1000, 0, 0x1000, 1),
    ]
    data = bytearray(size)
    ident = b'\x7fELF' + bytes([2 if wide else 1, 1, 1]) + b'\0' * 9
    if wide:
        header = struct.pack('<16sHHIQQQIHHHHHH', ident, kind, machine, 1, 0x1000, ehsize, shoff, flags, ehsize,
                             phsize, phnum, shsize if shnum else 0, shnum, 0)
    else:
        header = struct.pack('<16sHHIIIIIHHHHHH', ident, kind, machine, 1, 0x1000, ehsize, shoff, flags, ehsize,
                             phsize, phnum, shsize if shnum else 0, shnum, 0)
    data[:ehsize] = header
    for index, (p_type, p_flags, offset, vaddr, filesz, memsz, p_align) in enumerate(segments):
        if wide:
            entry = struct.pack('<IIQQQQQQ', p_type, p_flags, offset, vaddr, vaddr, filesz, memsz, p_align)
        else:
            entry = struct.pack('<IIIIIIII', p_type, offset, vaddr, vaddr, filesz, memsz, p_flags, p_align)
        data[ehsize + index * phsize:ehsize + (index + 1) * phsize] = entry
    for offset, blob in ((interp_at, interp), (note_at, note), (strtab_at, strtab), (dynamic_at, dynamic)):
        data[offset:offset + len(blob)] = blob
    if shnum:
        data[shoff:shoff + len(sections)] = sections
    return bytes(data)


def tar_member(name, kind='file', contents=b'', mode=0o644, mtime=0, uid=0):
    member = tarfile.TarInfo(name)
    member.mode, member.mtime, member.uid, member.gid = mode, mtime, uid, uid
    if kind == 'file':
        member.size = len(contents)
    elif kind == 'directory':
        member.type = tarfile.DIRTYPE
    else:
        member.type = {'symlink': tarfile.SYMTYPE, 'hardlink': tarfile.LNKTYPE, 'fifo': tarfile.FIFOTYPE}[kind]
        member.linkname = contents.decode('utf-8') if kind != 'fifo' else ''
    return member, contents


def npm_tree(version='11.19.1', prefix='node-v24.22.0/deps/npm/'):
    package = json.dumps({'name': 'npm', 'version': version}).encode('utf-8')
    return [
        ('node-v24.22.0/', 'directory', b'', 0o755),
        ('node-v24.22.0/README.md', 'file', b'node\n', 0o644),
        (prefix, 'directory', b'', 0o755),
        (prefix + 'package.json', 'file', package, 0o644),
        (prefix + 'bin/', 'directory', b'', 0o755),
        (prefix + 'bin/npm-cli.js', 'file', b'#!/usr/bin/env node\n', 0o755),
        (prefix + 'bin/npx-cli.js', 'file', b'#!/usr/bin/env node\n', 0o775),
        (prefix + 'lib/cli.js', 'file', b'module.exports = 1\n', 0o664),
        (prefix + 'node_modules/a-b/c.txt', 'file', b'second\n', 0o644),
        (prefix + 'node_modules/a/b.txt', 'file', b'first\n', 0o600),
        (prefix + 'node_modules/@npmcli/x+y~z/index.js', 'file', b'scoped\n', 0o644),
        (prefix + 'docs/empty.txt', 'file', b'', 0o644),
    ]


def write_tarball(path, members, mtime=0, uid=0):
    with tarfile.open(path, mode='w:xz', format=tarfile.PAX_FORMAT) as archive:
        for name, kind, contents, mode in members:
            member, data = tar_member(name, kind, contents, mode, mtime, uid)
            archive.addfile(member, io.BytesIO(data) if kind == 'file' else None)
    return path


class PipelineTestCase(unittest.TestCase):
    def setUp(self):
        cache = ROOT / 'cache'
        cache.mkdir(exist_ok=True)
        scratch = tempfile.TemporaryDirectory(prefix='node-pipeline-tests-', dir=cache)
        self.addCleanup(scratch.cleanup)
        self.directory = Path(scratch.name)

    def assert_code(self, code, callback, *arguments, **kwargs):
        with self.assertRaises(ValueError) as caught:
            callback(*arguments, **kwargs)
        self.assertEqual(getattr(caught.exception, 'code', None), code, getattr(caught.exception, 'details', None))
        return caught.exception


class LockFixture(PipelineTestCase):
    """A copy of the committed locks and patch directory in a scratch project."""

    def setUp(self):
        super().setUp()
        self.project = self.directory / 'project'
        self.patches = self.project / node.PATCH_DIRECTORY
        shutil.copytree(REAL_PATCHES, self.patches)
        self.runtime_path = self.project / 'android' / 'runtime.lock'
        self.sources_path = self.project / 'android' / 'runtime' / 'sources.lock'
        self.runtime_path.write_bytes(REAL_RUNTIME_LOCK.read_bytes())
        self.sources_path.write_bytes(REAL_SOURCES_LOCK.read_bytes())
        self.runtime = json.loads(REAL_RUNTIME_LOCK.read_text(encoding='utf-8'))
        self.lock = json.loads(REAL_SOURCES_LOCK.read_text(encoding='utf-8'))

    def write_locks(self, runtime=None, lock=None):
        runtime = self.runtime if runtime is None else runtime
        lock = copy.deepcopy(self.lock if lock is None else lock)
        data = runtime_bytes(runtime)
        lock['runtimeLockSha256'] = sha256(data)
        self.runtime_path.write_bytes(data)
        self.sources_path.write_bytes(sources.json_bytes(lock))

    def pins(self):
        return node.load_pins(self.runtime_path, self.sources_path)

    def edit_runtime(self, change):
        runtime = copy.deepcopy(self.runtime)
        change(runtime)
        self.write_locks(runtime)

    def refresh_patch_pins(self):
        lock = copy.deepcopy(self.lock)
        lock['node']['patches'] = node.patch_pins(self.patches)
        self.lock = lock
        series = node.parse_series((self.patches / 'series').read_text(encoding='utf-8'))
        self.runtime['node']['patchSet']['series'] = series
        self.runtime['node']['patchSet']['sha256'] = node.patch_set_sha256(self.patches, series)
        for abi, binary in self.runtime['node']['binaries'].items():
            binary['tag'] = node.artifact_tag(self.runtime['node']['version'], self.runtime['node']['patchSet']['sha256'], abi)
        self.write_locks()


class PatchSetTests(LockFixture):
    def test_committed_locks_and_patches_load(self):
        pins = node.load_pins(REAL_RUNTIME_LOCK, REAL_SOURCES_LOCK)
        self.assertEqual(pins.version, '24.22.0')
        self.assertEqual(pins.npm_version, '11.19.1')
        self.assertEqual(pins.abis, ['arm64-v8a', 'armeabi-v7a', 'x86_64'])
        self.assertEqual(pins.tag('x86_64'), 'node-24.22.0-1494da0071c0-x86_64')

    def test_patch_set_hash_is_sha256_of_gnu_sha256sum_text_lines_in_series_order(self):
        series = node.parse_series((REAL_PATCHES / 'series').read_text(encoding='utf-8'))
        lines = ''.join(f'{sha256((REAL_PATCHES / name).read_bytes())}  {name}\n' for name in series)
        self.assertEqual(node.patch_set_sha256(REAL_PATCHES, series), sha256(lines.encode('ascii')))
        self.assertEqual(node.patch_set_sha256(REAL_PATCHES, series),
                         '1494da0071c0b069a58a3d546376ce7d751c3b2a2ebfb59685c573e34626aa4a')

    @unittest.skipUnless(shutil.which('sha256sum'), 'GNU sha256sum is not installed')
    def test_patch_set_hash_matches_the_documented_shell_command(self):
        series = node.parse_series((REAL_PATCHES / 'series').read_text(encoding='utf-8'))
        listing = subprocess.run(['sha256sum', '--text', *series], cwd=REAL_PATCHES, check=True,
                                 stdout=subprocess.PIPE).stdout
        self.assertEqual(sha256(listing), node.patch_set_sha256(REAL_PATCHES, series))

    def test_patch_set_hash_covers_content_order_and_names(self):
        series = node.parse_series((self.patches / 'series').read_text(encoding='utf-8'))
        original = node.patch_set_sha256(self.patches, series)
        self.assertNotEqual(node.patch_set_sha256(self.patches, list(reversed(series))), original)
        (self.patches / series[0]).write_bytes((self.patches / series[0]).read_bytes() + b'\n')
        self.assertNotEqual(node.patch_set_sha256(self.patches, series), original)
        renamed = '0009-renamed.patch'
        (self.patches / series[1]).rename(self.patches / renamed)
        self.assertNotEqual(node.patch_set_sha256(self.patches, [series[0], renamed, series[2]]), original)

    def test_patch_pins_match_sources_py_and_the_committed_lock(self):
        pins = node.patch_pins(REAL_PATCHES)
        self.assertEqual(pins, sources.node_patch_pins())
        self.assertEqual(pins, self.lock['node']['patches'])
        self.assertEqual([item['path'].rsplit('/', 1)[1] for item in pins], [
            '0001-v8-x64-posix-trap-sources.patch', '0002-zlib-android-getauxval.patch',
            '0003-v8-arm64-host-trap-sources.patch', 'LICENSE.ST-android', 'series'])

    def test_edited_patch_fails_the_pinned_patch_set_hash(self):
        path = self.patches / '0002-zlib-android-getauxval.patch'
        path.write_bytes(path.read_bytes().replace(b'getauxval', b'getauxvaL', 1))
        self.assert_code('node-patch-set-sha256', self.pins)

    def test_changed_license_or_comment_fails_the_sources_lock_patch_pins(self):
        (self.patches / 'LICENSE.ST-android').write_bytes(b'changed\n')
        self.assert_code('node-patch-pins', self.pins)

    def test_patch_file_missing_from_series_is_rejected(self):
        (self.patches / '0004-extra.patch').write_bytes(b'--- a/x\n+++ b/x\n')
        self.assert_code('node-patch-unlisted', self.pins)

    def test_lock_series_must_equal_the_series_file(self):
        self.edit_runtime(lambda runtime: runtime['node']['patchSet']['series'].reverse())
        self.assert_code('node-series-mismatch', self.pins)

    def test_reordered_series_needs_a_new_hash_and_new_tags(self):
        series = self.patches / 'series'
        lines = series.read_text(encoding='utf-8').split('\n')
        names = [line for line in lines if line and not line.startswith('#')]
        swapped = [names[1] if line == names[0] else names[0] if line == names[1] else line for line in lines]
        series.write_text('\n'.join(swapped), encoding='utf-8')
        self.lock['node']['patches'] = node.patch_pins(self.patches)
        self.runtime['node']['patchSet']['series'] = [names[1], names[0], names[2]]
        self.write_locks()
        self.assert_code('node-patch-set-sha256', self.pins)
        self.refresh_patch_pins()
        pins = self.pins()
        self.assertNotEqual(pins.patch_set, '1494da0071c0b069a58a3d546376ce7d751c3b2a2ebfb59685c573e34626aa4a')
        self.assertEqual(pins.tag('arm64-v8a'), f'node-24.22.0-{pins.patch_set[:12]}-arm64-v8a')


class SeriesTests(unittest.TestCase):
    def test_comments_and_blank_lines_are_skipped_and_order_is_kept(self):
        text = '# reason\n\n0002-b.patch\n# provenance\n0001-a.patch\n'
        self.assertEqual(node.parse_series(text), ['0002-b.patch', '0001-a.patch'])

    def test_committed_series_lists_the_three_s21_patches(self):
        self.assertEqual(node.parse_series((REAL_PATCHES / 'series').read_text(encoding='utf-8')), [
            '0001-v8-x64-posix-trap-sources.patch', '0002-zlib-android-getauxval.patch',
            '0003-v8-arm64-host-trap-sources.patch'])

    def test_unsafe_or_ambiguous_entries_are_rejected(self):
        for text in ('../0001-a.patch\n', 'sub/0001-a.patch\n', '0001-a.diff\n', ' 0001-a.patch\n', '0001-a.patch \n',
                     '0001-a.patch\r\n', '.0001-a.patch\n', '0001-a.patch\n0001-a.patch\n', '-p1.patch\n'):
            with self.subTest(text=text):
                with self.assertRaises(node.NodeError) as caught:
                    node.parse_series(text)
                self.assertEqual(caught.exception.code, 'node-series-entry')

    def test_empty_series_is_rejected(self):
        for text in ('', '# only a comment\n\n'):
            with self.assertRaises(node.NodeError) as caught:
                node.parse_series(text)
            self.assertEqual(caught.exception.code, 'node-series-empty')


class NodeLockTests(LockFixture):
    def test_binary_tags_follow_version_and_patch_set_prefix(self):
        self.edit_runtime(lambda runtime: runtime['node']['binaries']['x86_64'].update(tag='node-24.22.0-x86_64'))
        self.assert_code('node-binary-tag', self.pins)

    def test_published_fields_are_all_null_or_all_pinned(self):
        self.edit_runtime(lambda runtime: runtime['node']['binaries']['arm64-v8a'].update(digest='sha256:' + 'a' * 64))
        self.assert_code('node-binary-partial', self.pins)

    def test_pinned_fields_need_an_oci_digest_a_sha256_and_a_positive_size(self):
        for digest, file_sha256, size in (('a' * 64, 'b' * 64, 1), ('sha256:' + 'A' * 64, 'b' * 64, 1),
                                          ('sha256:' + 'a' * 64, 'b' * 63, 1), ('sha256:' + 'a' * 64, 'b' * 64, 0),
                                          ('sha256:' + 'a' * 64, 'b' * 64, True)):
            with self.subTest(digest=digest, size=size):
                self.edit_runtime(lambda runtime: runtime['node']['binaries']['x86_64'].update(
                    digest=digest, sha256=file_sha256, size=size))
                self.assert_code('node-binary-pin', self.pins)

    def test_binaries_must_cover_exactly_the_runtime_abis(self):
        self.edit_runtime(lambda runtime: runtime['node']['binaries'].pop('armeabi-v7a'))
        self.assert_code('node-binaries-abis', self.pins)

    def test_repository_must_be_a_ghcr_repository(self):
        self.edit_runtime(lambda runtime: runtime['node']['binaries']['x86_64'].update(
            repository='docker.io/sillybunnyteam/sillybunny-android-runtime'))
        self.assert_code('node-binary-repository', self.pins)

    def test_ndk_api_icu_and_source_pins_are_checked(self):
        cases = [
            ('node-ndk-pin', lambda node_entry: node_entry['ndk'].update(url='https://example.com/android-ndk-r30-linux.zip')),
            ('node-ndk-pin', lambda node_entry: node_entry['ndk'].pop('sha1')),
            ('node-api', lambda node_entry: node_entry.update(api=23)),
            ('node-api', lambda node_entry: node_entry.update(api='29')),
            ('node-icu', lambda node_entry: node_entry.update(icu='small-icu')),
            ('node-source-pin', lambda node_entry: node_entry['source'].update(commit='f14cd3aa')),
            ('node-source-pin', lambda node_entry: node_entry['source'].update(tarballSha256='0' * 64)),
            ('node-patch-set', lambda node_entry: node_entry['patchSet'].update(directory='patches')),
        ]
        for code, change in cases:
            with self.subTest(code=code):
                self.edit_runtime(lambda runtime: change(runtime['node']))
                self.assert_code(code, self.pins)

    def test_npm_comes_from_node_and_supports_min_release_age(self):
        for change in (lambda value: value.update(version='11.9.9'), lambda value: value.update(source='registry'),
                       lambda value: value.update(sha256='0' * 64)):
            with self.subTest():
                runtime = copy.deepcopy(self.runtime)
                change(runtime['npm'])
                lock = copy.deepcopy(self.lock)
                lock['npm']['version'] = runtime['npm']['version']
                self.write_locks(runtime, lock)
                self.assert_code('npm-pin', self.pins)

    def test_versions_must_agree_between_the_two_locks(self):
        self.edit_runtime(lambda runtime: runtime['npm'].update(version='11.20.0'))
        self.assert_code('runtime-section-mismatch', self.pins)

    def test_runtime_lock_bytes_must_match_the_sources_lock_hash(self):
        self.runtime_path.write_bytes(self.runtime_path.read_bytes().replace(b'"api": 29', b'"api":  29'))
        self.assert_code('runtime-lock-sha256', self.pins)


class ElfAuditTests(PipelineTestCase):
    def audit(self, data, abi='x86_64', api=29):
        path = self.directory / f'libnode-{abi}.so'
        path.write_bytes(data)
        return node.audit_elf(path, abi, api)

    def test_valid_executables_pass_for_every_abi(self):
        for abi in node.ABIS:
            with self.subTest(abi=abi):
                result = self.audit(make_elf(abi), abi)
                self.assertEqual(result['machine'], node.ABIS[abi]['machineName'])
                self.assertEqual(result['interpreter'], node.ABIS[abi]['interpreter'])
                self.assertEqual(result['needed'], ['libc.so', 'libm.so', 'libdl.so', 'liblog.so'])
                self.assertEqual(result['androidApi'], 29)
                self.assertEqual([load['align'] for load in result['loads']], [0x4000])
                self.assertEqual(result['relroEnds'], [0x8000])

    def test_each_rule_rejects_its_defect(self):
        cases = [
            ('elf-machine', 'x86_64', {'machine': 183}),
            ('elf-class', 'armeabi-v7a', {'bits': 64}),
            ('elf-load-alignment', 'x86_64', {'align': 0x1000}),
            ('elf-load-alignment', 'armeabi-v7a', {'align': 0x1000}),
            ('elf-load-alignment', 'arm64-v8a', {'align': 0x6000}),
            ('elf-needed', 'x86_64', {'needed': ('libc.so', 'libc++_shared.so')}),
            ('elf-needed', 'x86_64', {'needed': ('libm.so',)}),
            ('elf-interpreter', 'arm64-v8a', {'interpreter': '/system/bin/linker'}),
            ('elf-android-api', 'x86_64', {'api': 30}),
            ('elf-not-pie', 'x86_64', {'kind': 2}),
            ('elf-not-pie', 'x86_64', {'pie': False}),
            ('elf-text-relocations', 'armeabi-v7a', {'textrel': True}),
            ('elf-stack', 'x86_64', {'stack_flags': 7}),
            ('elf-relro', 'arm64-v8a', {'relro_end': 0x7800}),
            ('elf-not-stripped', 'x86_64', {'symtab': True}),
            ('elf-arm-abi', 'armeabi-v7a', {'flags': 0x5000400}),
            ('elf-arm-abi', 'armeabi-v7a', {'flags': 0x4000000}),
        ]
        for code, abi, change in cases:
            with self.subTest(code=code, change=change):
                self.assert_code(code, self.audit, make_elf(abi, **change), abi)

    def test_truncated_and_non_elf_files_are_rejected(self):
        data = make_elf('x86_64')
        self.assert_code('elf-magic', self.audit, b'MZ' + data[2:])
        self.assert_code('elf-truncated', self.audit, data[:100])

    def test_symlinks_are_not_audited(self):
        target = self.directory / 'target.so'
        target.write_bytes(make_elf('x86_64'))
        link = self.directory / 'link.so'
        link.symlink_to(target)
        self.assert_code('not-a-regular-file', node.audit_elf, link, 'x86_64')


class ConfigCheckTests(PipelineTestCase):
    def configured(self, abi, ndk='/opt/android-ndk-r30', **changes):
        variables = {
            'OS': 'android', 'target_arch': node.ABIS[abi]['cpu'], 'host_arch': node.ABIS[abi]['hostArch'],
            'want_separate_host_toolset': 1, 'icu_small': 'false', 'v8_enable_i18n_support': 1,
            'node_use_node_snapshot': 'false', 'node_use_node_code_cache': 'false', 'v8_enable_webassembly': 1,
            'icu_ver_major': '78',
        }
        if abi == 'armeabi-v7a':
            variables.update({'arm_version': '7', 'arm_fpu': 'vfpv3', 'arm_float_abi': 'default', 'arm_thumb': 0})
        variables.update(changes)
        source = self.directory / f'source-{abi}'
        (source / 'out').mkdir(parents=True, exist_ok=True)
        (source / 'config.gypi').write_text('# Do not edit. Generated by the configure script.\n'
                                            + json.dumps({'target_defaults': {}, 'variables': variables}, indent=2),
                                            encoding='utf-8')
        driver = f'{ndk}/toolchains/llvm/prebuilt/linux-x86_64/bin/{node.ABIS[abi]["triple"]}29-clang'
        (source / 'out' / 'Makefile').write_text(f'CC.target ?= {driver}\n', encoding='utf-8')
        return source

    def test_s21_configuration_passes_for_every_abi(self):
        for abi in node.ABIS:
            with self.subTest(abi=abi):
                result = node.check_config(abi, self.configured(abi), '/opt/android-ndk-r30', 29)
                self.assertEqual(result['driver'], node.ABIS[abi]['triple'] + '29-clang')

    def test_wrong_target_host_icu_or_snapshot_settings_fail(self):
        cases = [('x86_64', {'host_arch': 'ia32'}), ('armeabi-v7a', {'host_arch': 'x64'}), ('x86_64', {'icu_small': 'true'}),
                 ('arm64-v8a', {'node_use_node_snapshot': 'true'}), ('x86_64', {'OS': 'linux'}),
                 ('armeabi-v7a', {'arm_fpu': 'neon'}), ('armeabi-v7a', {'arm_float_abi': 'hard'})]
        for abi, change in cases:
            with self.subTest(abi=abi, change=change):
                self.assert_code('node-config', node.check_config, abi, self.configured(abi, **change),
                                 '/opt/android-ndk-r30', 29)

    def test_makefile_must_use_this_ndk_and_api_level_drivers(self):
        source = self.configured('x86_64', ndk='/other/ndk')
        self.assert_code('node-config-makefile', node.check_config, 'x86_64', source, '/opt/android-ndk-r30', 29)
        source = self.configured('x86_64')
        self.assert_code('node-config-makefile', node.check_config, 'x86_64', source, '/opt/android-ndk-r30', 30)


class NpmArchiveTests(LockFixture):
    def entries(self, members):
        pairs = [tar_member(name, kind, contents, mode) for name, kind, contents, mode in members]
        return npm.npm_entries(((member, lambda item, data=contents: data) for member, contents in pairs),
                               'node-v24.22.0/deps/npm/')

    def test_archive_is_sorted_by_path_segments_with_fixed_times_and_normalised_modes(self):
        data = npm.zip_bytes(self.entries(npm_tree()))
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            infos = archive.infolist()
            self.assertEqual([info.filename for info in infos], [
                'bin/npm-cli.js', 'bin/npx-cli.js', 'docs/empty.txt', 'lib/cli.js',
                'node_modules/@npmcli/x+y~z/index.js', 'node_modules/a/b.txt', 'node_modules/a-b/c.txt',
                'package.json'])
            modes = {info.filename: info.external_attr >> 16 for info in infos}
            self.assertEqual(modes['bin/npx-cli.js'], stat.S_IFREG | 0o755)
            self.assertEqual(modes['lib/cli.js'], stat.S_IFREG | 0o644)
            self.assertEqual(modes['node_modules/a/b.txt'], stat.S_IFREG | 0o644)
            for info in infos:
                self.assertEqual(info.date_time, (1980, 1, 1, 0, 0, 0))
                self.assertEqual((info.create_system, info.compress_type, info.flag_bits & 0x2049, info.extra),
                                 (3, zipfile.ZIP_DEFLATED, 0, b''))
                self.assertFalse(info.is_dir())

    def test_same_files_give_the_same_bytes_whatever_the_tar_order_times_and_owners(self):
        first = write_tarball(self.directory / 'first.tar.xz', npm_tree(), mtime=0, uid=0)
        second = write_tarball(self.directory / 'second.tar.xz', list(reversed(npm_tree())), mtime=1_700_000_000, uid=1000)
        one = npm.zip_bytes(npm.tarball_entries(first, '24.22.0'))
        two = npm.zip_bytes(npm.tarball_entries(second, '24.22.0'))
        self.assertEqual(one, two)
        self.assertEqual(one, npm.zip_bytes(npm.tarball_entries(first, '24.22.0')))

    def test_links_special_files_and_unsafe_paths_are_rejected(self):
        prefix = 'node-v24.22.0/deps/npm/'
        cases = [
            ('npm-entry-type', (prefix + 'bin/npm', 'symlink', b'npm-cli.js', 0o777)),
            ('npm-entry-type', (prefix + 'bin/npm2', 'hardlink', prefix.encode() + b'bin/npm-cli.js', 0o644)),
            ('npm-entry-type', (prefix + 'fifo', 'fifo', b'', 0o644)),
            ('npm-unsafe-path', (prefix + 'lib/../../etc/passwd', 'file', b'x', 0o644)),
            ('npm-unsafe-path', (prefix + 'lib/./x.js', 'file', b'x', 0o644)),
            ('npm-unsafe-path', (prefix + 'lib/a b.js', 'file', b'x', 0o644)),
            ('npm-unsafe-path', (prefix + 'lib//x.js', 'file', b'x', 0o644)),
            ('npm-unsafe-path', (prefix + 'lib/café.js', 'file', b'x', 0o644)),
            ('npm-duplicate', (prefix + 'lib/cli.js', 'file', b'again', 0o644)),
            ('npm-file-is-directory', (prefix + 'lib/cli.js/inner.js', 'file', b'x', 0o644)),
        ]
        for code, member in cases:
            with self.subTest(code=code, member=member[0]):
                self.assert_code(code, self.entries, [*npm_tree(), member])

    def test_deps_npm_must_be_present_with_matching_version_and_both_clis(self):
        self.assert_code('npm-missing', self.entries, npm_tree()[:2])
        entries = self.entries(npm_tree(version='11.19.0'))
        self.assert_code('npm-version-mismatch', npm.check_metadata, entries, '11.19.1')
        entries = self.entries([member for member in npm_tree() if not member[0].endswith('npx-cli.js')])
        self.assert_code('npm-cli-missing', npm.check_metadata, entries, '11.19.1')
        entries = self.entries([member for member in npm_tree() if not member[0].endswith('package.json')])
        self.assert_code('npm-metadata', npm.check_metadata, entries, '11.19.1')

    def test_archive_check_compares_every_entry_with_its_source(self):
        entries = self.entries(npm_tree())
        data = npm.zip_bytes(entries)
        npm.check_zip(data, entries)
        changed = dict(entries)
        changed['lib/cli.js'] = (b'changed\n', 0o644)
        self.assert_code('npm-archive-entry', npm.check_zip, data, changed)
        fewer = {path: value for path, value in entries.items() if path != 'docs/empty.txt'}
        self.assert_code('npm-archive-entries', npm.check_zip, data, fewer)
        with mock.patch.object(npm, 'MAX_FILES', 3):
            self.assert_code('npm-archive-limits', npm.check_zip, data, entries)

    def test_provenance_check_compares_version_file_count_and_content_size(self):
        entries = self.entries(npm_tree())
        data = npm.zip_bytes(entries)
        summary = {'version': '11.19.1', 'files': len(entries), 'contentBytes': sum(len(item[0]) for item in entries.values()),
                   'sha256': sha256(data)}
        provenance = {'version': '11.19.1', 'source': {'fileCount': len(entries)},
                      'archive': {'fileCount': len(entries), 'uncompressedFileBytes': summary['contentBytes'],
                                  'sha256': sha256(data)}}
        self.assertTrue(npm.check_provenance(provenance, summary))
        provenance['archive']['sha256'] = '0' * 64
        self.assertFalse(npm.check_provenance(provenance, summary))
        for change in (lambda value: value.update(version='11.19.0'),
                       lambda value: value['archive'].update(fileCount=1),
                       lambda value: value['source'].update(fileCount=1)):
            broken = copy.deepcopy(provenance)
            change(broken)
            self.assert_code('npm-provenance-mismatch', npm.check_provenance, broken, summary)
        self.assert_code('npm-provenance-format', npm.check_provenance, {'version': '11.19.1'}, summary)

    def test_cli_writes_npm_zip_and_the_p523_npm_json(self):
        tarball = write_tarball(self.directory / 'node.tar.xz', npm_tree())
        output = self.directory / 'npm-out'
        output.mkdir()
        # A previous npm-out is replaced.
        (output / 'npm.zip').write_bytes(b'old archive')
        (output / 'npm.json').write_text('{}', encoding='utf-8')
        stdout = io.StringIO()
        with mock.patch.object(node, 'verified_source', return_value=(tarball, {'status': 'verified'})) as verified, \
                contextlib.redirect_stdout(stdout):
            npm.main(['--runtime-lock', str(self.runtime_path), '--sources-lock', str(self.sources_path),
                      '--output', str(output), '--offline', '--cache', str(self.directory / 'cache')])
        self.assertTrue(verified.call_args.args[2])
        self.assertEqual(sorted(path.name for path in output.iterdir()), ['npm.json', 'npm.zip'])
        archive = (output / 'npm.zip').read_bytes()
        record = json.loads((output / 'npm.json').read_text(encoding='utf-8'))
        source = self.lock['node']['source']
        self.assertEqual(record, {
            'schema': 1, 'version': '11.19.1', 'sha256': sha256(archive), 'size': len(archive), 'files': 8,
            'contentBytes': sum(len(contents) for name, kind, contents, mode in npm_tree()
                                if kind == 'file' and '/deps/npm/' in name),
            'source': {'kind': 'node-source-tarball', 'node': '24.22.0', 'path': 'deps/npm',
                       'tarball': {'filename': source['filename'], 'sha256': source['sha256'], 'url': source['url']}},
        })
        self.assertEqual((output / 'npm.json').read_bytes(), node.json_bytes(record))
        self.assertEqual(json.loads(stdout.getvalue())['sha256'], sha256(archive))

    def test_cli_refuses_an_output_it_does_not_own_before_reading_the_tarball(self):
        arguments = ['--runtime-lock', str(self.runtime_path), '--sources-lock', str(self.sources_path), '--offline']
        workspace = self.directory / 'workspace'
        (workspace / 'notes').mkdir(parents=True)
        (workspace / 'notes' / 'todo.txt').write_text('uncommitted work', encoding='utf-8')
        (workspace / 'README').write_text('keep me', encoding='utf-8')
        node_out = self.directory / 'node-out'
        (node_out / 'x86_64').mkdir(parents=True)
        (node_out / 'x86_64' / 'libnode.so').write_bytes(b'elf')
        (node_out / 'node.json').write_text('{}', encoding='utf-8')
        cases = [(workspace, ['README', 'notes'], self.directory), (node_out, ['node.json', 'x86_64'], self.directory),
                 (workspace / 'notes' / 'todo.txt', None, self.directory), (Path('.'), None, workspace),
                 (Path('..'), None, workspace / 'notes')]
        with mock.patch.object(node, 'verified_source') as verified:
            for output, entries, working in cases:
                with self.subTest(output=str(output)), contextlib.chdir(working):
                    error = self.assert_code('unsafe-output', npm.main, [*arguments, '--output', str(output)])
                    self.assertEqual(error.details.get('entries'), entries)
        verified.assert_not_called()
        self.assertEqual((workspace / 'notes' / 'todo.txt').read_text(encoding='utf-8'), 'uncommitted work')
        self.assertEqual(sorted(path.name for path in node_out.iterdir()), ['node.json', 'x86_64'])

    def test_failed_run_keeps_the_previous_output(self):
        tarball = write_tarball(self.directory / 'node.tar.xz', npm_tree(version='11.18.0'))
        output = self.directory / 'npm-out'
        output.mkdir()
        (output / 'npm.json').write_text('previous', encoding='utf-8')
        with mock.patch.object(node, 'verified_source', return_value=(tarball, {'status': 'verified'})):
            self.assert_code('npm-version-mismatch', npm.main, [
                '--runtime-lock', str(self.runtime_path), '--sources-lock', str(self.sources_path),
                '--output', str(output)])
        self.assertEqual((output / 'npm.json').read_text(encoding='utf-8'), 'previous')


class FakeOras(LockFixture):
    """Pins fixture executables in the locks and serves them from a fake oras on PATH."""

    def setUp(self):
        super().setUp()
        self.bin = self.directory / 'bin'
        self.bin.mkdir()
        self.blobs = self.directory / 'blobs'
        self.log = self.directory / 'oras.log'
        self.output = self.directory / 'node-out'
        self.elves = {abi: make_elf(abi) for abi in node.ABIS}
        self.digests = {abi: 'sha256:' + sha256(b'manifest ' + abi.encode()) for abi in node.ABIS}
        environment = mock.patch.dict(os.environ, {'PATH': f'{self.bin}{os.pathsep}{os.environ.get("PATH", "")}',
                                                   'FAKE_ORAS_LOG': str(self.log), 'FAKE_ORAS_BLOBS': str(self.blobs)})
        environment.start()
        self.addCleanup(environment.stop)

    def install_oras(self, status=0):
        script = self.bin / 'oras'
        script.write_text(f'''#!{sys.executable}
import json, os, shutil, sys
with open(os.environ['FAKE_ORAS_LOG'], 'a') as stream:
    stream.write(json.dumps(sys.argv[1:]) + '\\n')
if {status}:
    sys.exit({status})
command, flag, output, reference = sys.argv[1:]
assert (command, flag) == ('pull', '--output')
blob = os.path.join(os.environ['FAKE_ORAS_BLOBS'], reference.rpartition('@')[2].replace(':', '-'))
for name in os.listdir(blob):
    shutil.copyfile(os.path.join(blob, name), os.path.join(output, name))
''', encoding='utf-8')
        script.chmod(0o755)

    def tarball(self):
        """The pinned Node source tarball as node.json and npm.json name it."""
        source = self.lock['node']['source']
        return {'filename': source['filename'], 'sha256': source['sha256'], 'url': source['url']}

    def build_record(self, abi, data, record=()):
        """The node-build.json build-node.sh writes beside `data`, updated with `record`."""
        source = self.lock['node']['source']
        build = {'schema': 1, 'abi': abi, 'version': '24.22.0', 'tag': f'node-24.22.0-1494da0071c0-{abi}',
                 'patchSet': {'sha256': PATCH_SET},
                 'libnode': {'sha256': sha256(data), 'size': len(data)},
                 'source': {'tarball': source['filename'], 'sha256': source['sha256'], 'signature': 'verified',
                            'signers': ['C82FA3AE1CBEDC6BE46B9360C43CEC45C17AB93C']}}
        build.update(record)
        return build

    def publish(self, abi, data=None, served=None, record=()):
        """Pins `data` (default: the valid executable) for `abi`; the registry serves `served` (default: data)
        with the node-build.json build-node.sh writes, updated with `record`."""
        data = self.elves[abi] if data is None else data
        directory = self.blobs / self.digests[abi].replace(':', '-')
        directory.mkdir(parents=True, exist_ok=True)
        (directory / 'libnode.so').write_bytes(data if served is None else served)
        (directory / 'node-build.json').write_bytes(node.json_bytes(self.build_record(abi, data, record)))
        self.runtime['node']['binaries'][abi].update(digest=self.digests[abi], sha256=sha256(data), size=len(data))

    def local_build(self, abi, record=None, name=None):
        """A build directory as build-node.sh leaves it: libnode.so, plus node-build.json updated with `record`
        unless `record` is None. Returns the libnode.so path."""
        directory = self.directory / 'builds' / (name or abi)
        directory.mkdir(parents=True)
        (directory / 'libnode.so').write_bytes(self.elves[abi])
        if record is not None:
            (directory / 'node-build.json').write_bytes(node.json_bytes(self.build_record(abi, self.elves[abi], record)))
        return directory / 'libnode.so'

    def node_json(self):
        return json.loads((self.output / 'node.json').read_text(encoding='utf-8'))

    def entries(self, directory=None):
        return sorted(path.relative_to(directory or self.output).as_posix() for path in (directory or self.output).rglob('*'))

    def run_cli(self, *arguments):
        stdout = io.StringIO()
        with contextlib.redirect_stdout(stdout):
            node.main(['--runtime-lock', str(self.runtime_path), '--sources-lock', str(self.sources_path),
                       '--output', str(self.output), *arguments])
        return json.loads(stdout.getvalue())

    def calls(self):
        if not self.log.exists():
            return []
        return [json.loads(line) for line in self.log.read_text(encoding='utf-8').splitlines()]


@unittest.skipIf(os.name == 'nt', 'the fake oras is a POSIX executable script')
class FetchTests(FakeOras):
    def test_pulls_each_abi_by_its_pinned_digest_and_writes_the_p523_layout(self):
        self.install_oras()
        for abi in node.ABIS:
            self.publish(abi)
        self.write_locks()
        result = self.run_cli()
        self.assertEqual(result['source'], 'ghcr')
        references = sorted(call[3] for call in self.calls())
        self.assertEqual(references, sorted(f'{REPOSITORY}@{digest}' for digest in self.digests.values()))
        self.assertTrue(all(call[:2] == ['pull', '--output'] for call in self.calls()))
        self.assertEqual(self.node_json(), {
            'schema': 1, 'version': '24.22.0',
            'abis': {abi: {'sha256': sha256(data), 'size': len(data)} for abi, data in self.elves.items()},
            'source': {'kind': 'ghcr', 'repository': REPOSITORY, 'patchSetSha256': PATCH_SET,
                       'artifacts': {abi: {'tag': f'node-24.22.0-1494da0071c0-{abi}', 'digest': self.digests[abi]}
                                     for abi in node.ABIS},
                       'tarball': self.tarball()},
        })
        # npm.json names the same tarball object, so one comparison with runtime.lock serves both files.
        self.assertEqual(self.tarball(), {'filename': 'node-v24.22.0.tar.xz',
                                          'sha256': self.runtime['node']['source']['tarballSha256'],
                                          'url': 'https://nodejs.org/dist/v24.22.0/node-v24.22.0.tar.xz'})
        for abi, data in self.elves.items():
            self.assertEqual((self.output / abi / 'libnode.so').read_bytes(), data)
        self.assertEqual(sorted(path.name for path in self.output.iterdir()), sorted([*node.ABIS, 'node.json']))

    def test_selected_abis_only(self):
        self.install_oras()
        self.publish('x86_64')
        self.write_locks()
        result = self.run_cli('--abi', 'x86_64')
        self.assertEqual(sorted(result['abis']), ['x86_64'])
        self.assertEqual(len(self.calls()), 1)

    def test_null_digest_is_refused_before_oras_runs(self):
        self.install_oras()
        self.assert_code('node-digest-unpinned', self.run_cli)
        self.assert_code('node-digest-unpinned', self.run_cli, '--abi', 'arm64-v8a')
        self.assertEqual(self.calls(), [])
        self.assertFalse(self.output.exists())

    def test_missing_oras_is_reported_and_never_installed(self):
        self.publish('x86_64')
        self.write_locks()
        with mock.patch.dict(os.environ, {'PATH': str(self.bin)}):
            self.assert_code('missing-tool', self.run_cli, '--abi', 'x86_64')
        self.assertEqual(sorted(path.name for path in self.bin.iterdir()), [])

    def test_wrong_hash_or_size_from_the_registry_is_rejected_and_keeps_the_previous_output(self):
        self.install_oras()
        self.output.mkdir()
        (self.output / 'node.json').write_text('previous', encoding='utf-8')
        other = make_elf('x86_64', needed=('libc.so',))
        for served in (other, self.elves['x86_64'] + b'\0'):
            with self.subTest(size=len(served)):
                self.publish('x86_64', served=served)
                self.write_locks()
                self.assert_code('node-binary-mismatch', self.run_cli, '--abi', 'x86_64')
                self.assertEqual((self.output / 'node.json').read_text(encoding='utf-8'), 'previous')

    def test_artifact_build_record_must_match_the_current_pins(self):
        self.install_oras()
        source = self.lock['node']['source']
        cases = [{'patchSet': {'sha256': '0' * 64}}, {'abi': 'arm64-v8a'}, {'version': '24.21.0'},
                 {'tag': 'node-24.22.0-000000000000-x86_64'}, {'libnode': {'sha256': '0' * 64, 'size': 1}}, {'libnode': None},
                 {'source': {'tarball': 'node-v24.21.0.tar.xz', 'sha256': source['sha256']}},
                 {'source': {'tarball': source['filename'], 'sha256': '0' * 64}}, {'source': None}]
        for change in cases:
            with self.subTest(change=change):
                self.publish('x86_64', record=change)
                self.write_locks()
                self.assert_code('node-provenance-mismatch', self.run_cli, '--abi', 'x86_64')
        (self.blobs / self.digests['x86_64'].replace(':', '-') / 'node-build.json').unlink()
        self.assert_code('not-a-regular-file', self.run_cli, '--abi', 'x86_64')
        self.assertFalse(self.output.exists())

    def test_pinned_file_must_still_pass_the_elf_audit(self):
        self.install_oras()
        self.publish('x86_64', data=make_elf('x86_64', align=0x1000))
        self.write_locks()
        self.assert_code('elf-load-alignment', self.run_cli, '--abi', 'x86_64')

    def test_failed_pull_and_missing_file_are_errors(self):
        self.install_oras(status=1)
        self.publish('x86_64')
        self.write_locks()
        self.assert_code('oras-pull', self.run_cli, '--abi', 'x86_64')
        self.install_oras()
        (self.blobs / self.digests['x86_64'].replace(':', '-') / 'libnode.so').unlink()
        self.assert_code('not-a-regular-file', self.run_cli, '--abi', 'x86_64')

    def test_local_mode_audits_and_records_source_kind_local(self):
        local = self.directory / 'build' / 'libnode.so'
        local.parent.mkdir()
        local.write_bytes(self.elves['x86_64'])
        result = self.run_cli('--local', f'x86_64={local}')
        self.assertEqual(result['source'], 'local')
        self.assertEqual(self.node_json(), {'schema': 1, 'version': '24.22.0', 'source': {'kind': 'local'},
                                            'abis': {'x86_64': {'sha256': sha256(self.elves['x86_64']), 'size': len(self.elves['x86_64'])}}})
        self.assertEqual((self.output / 'x86_64' / 'libnode.so').read_bytes(), self.elves['x86_64'])
        self.assertEqual(self.calls(), [])

    def test_local_mode_names_the_tarball_when_every_build_has_a_matching_record(self):
        x86 = self.local_build('x86_64', record={})
        arm = self.local_build('arm64-v8a', record={})
        self.assertEqual(self.run_cli('--local', f'x86_64={x86}', '--local', f'arm64-v8a={arm}')['source'], 'local')
        self.assertEqual(self.node_json()['source'], {'kind': 'local', 'tarball': self.tarball()})
        self.assertEqual(self.entries(), ['arm64-v8a', 'arm64-v8a/libnode.so', 'node.json', 'x86_64', 'x86_64/libnode.so'])

    def test_local_mode_leaves_the_tarball_out_unless_every_build_has_a_record(self):
        x86 = self.local_build('x86_64', record={})
        arm = self.local_build('arm64-v8a')
        self.run_cli('--local', f'x86_64={x86}', '--local', f'arm64-v8a={arm}')
        self.assertEqual(self.node_json()['source'], {'kind': 'local'})
        # A record that is present is still checked.
        bad = self.local_build('x86_64', record={'tag': 'node-24.22.0-000000000000-x86_64'}, name='bad')
        self.assert_code('node-provenance-mismatch', self.run_cli, '--local', f'x86_64={bad}', '--local', f'arm64-v8a={arm}')

    def test_local_record_must_describe_the_build_and_the_pins(self):
        self.output.mkdir()
        (self.output / 'node.json').write_text('previous', encoding='utf-8')
        source = self.lock['node']['source']
        cases = [{'abi': 'arm64-v8a'}, {'version': '24.21.0'}, {'tag': 'node-24.22.0-000000000000-x86_64'},
                 {'patchSet': {'sha256': '0' * 64}}, {'libnode': {'sha256': '0' * 64, 'size': 1}},
                 {'libnode': {'sha256': sha256(self.elves['x86_64']), 'size': 1}},
                 # The record format before the tarball check: source.tarball held the tarball's SHA-256.
                 {'source': {'tarball': source['sha256'], 'sha256': source['sha256']}},
                 {'source': {'tarball': source['filename'], 'sha256': '0' * 64}}, {'source': None}]
        for index, change in enumerate(cases):
            with self.subTest(change=change):
                path = self.local_build('x86_64', record=change, name=f'case-{index}')
                self.assert_code('node-provenance-mismatch', self.run_cli, '--local', f'x86_64={path}')
                self.assertEqual((self.output / 'node.json').read_text(encoding='utf-8'), 'previous')
        path = self.local_build('x86_64', name='record-directory')
        (path.parent / 'node-build.json').mkdir()
        self.assert_code('not-a-regular-file', self.run_cli, '--local', f'x86_64={path}')
        self.assertEqual(self.entries(), ['node.json'])

    def test_previous_output_or_an_empty_directory_is_replaced_whole(self):
        x86 = self.local_build('x86_64')
        arm = self.local_build('arm64-v8a', record={})
        self.output.mkdir()
        self.run_cli('--local', f'x86_64={x86}', '--local', f'arm64-v8a={arm}')
        self.assertEqual(self.entries(), ['arm64-v8a', 'arm64-v8a/libnode.so', 'node.json', 'x86_64', 'x86_64/libnode.so'])
        self.run_cli('--local', f'x86_64={x86}')
        self.assertEqual(self.entries(), ['node.json', 'x86_64', 'x86_64/libnode.so'])
        self.assertEqual(sorted(self.node_json()['abis']), ['x86_64'])
        self.assertEqual([path.name for path in self.output.parent.iterdir() if path.name.startswith('.node-out-')], [])

    def test_output_holding_anything_else_is_refused_before_anything_is_fetched(self):
        self.install_oras()
        for abi in node.ABIS:
            self.publish(abi)
        self.write_locks()
        (self.output / 'notes').mkdir(parents=True)
        (self.output / 'notes' / 'todo.txt').write_text('uncommitted work', encoding='utf-8')
        (self.output / 'README').write_text('keep me', encoding='utf-8')
        error = self.assert_code('unsafe-output', self.run_cli)
        self.assertEqual((error.details['reason'], error.details['entries']), ('foreign-entries', ['README', 'notes']))
        self.assertEqual(self.calls(), [])
        local = self.local_build('x86_64')
        self.assert_code('unsafe-output', self.run_cli, '--local', f'x86_64={local}')
        self.assertEqual(self.entries(), ['README', 'notes', 'notes/todo.txt'])
        self.assertEqual((self.output / 'notes' / 'todo.txt').read_text(encoding='utf-8'), 'uncommitted work')

    def test_unexpected_entries_inside_a_node_out_are_refused(self):
        local = self.local_build('x86_64')

        def extra_file(output):
            (output / 'x86_64').mkdir()
            (output / 'x86_64' / 'libnode.so').write_bytes(b'old')
            (output / 'x86_64' / 'notes.txt').write_text('mine', encoding='utf-8')

        def symlinked_abi(output):
            (self.directory / 'elsewhere').mkdir(exist_ok=True)
            (output / 'x86_64').symlink_to(self.directory / 'elsewhere', target_is_directory=True)

        def symlinked_file(output):
            (output / 'x86_64').mkdir()
            (output / 'x86_64' / 'libnode.so').symlink_to(local)

        cases = [
            (extra_file, ['x86_64/notes.txt']),
            (lambda output: (output / 'node.json').mkdir(), ['node.json']),
            (lambda output: (output / 'x86_64').write_bytes(b'file'), ['x86_64']),
            (lambda output: (output / 'mips').mkdir(), ['mips']),
            (lambda output: (output / 'npm.json').write_text('{}', encoding='utf-8'), ['npm.json']),
            (symlinked_abi, ['x86_64']),
            (symlinked_file, ['x86_64/libnode.so']),
        ]
        for prepare, entries in cases:
            with self.subTest(entries=entries):
                shutil.rmtree(self.output, ignore_errors=True)
                self.output.mkdir()
                prepare(self.output)
                error = self.assert_code('unsafe-output', self.run_cli, '--local', f'x86_64={local}')
                self.assertEqual(error.details['entries'], entries)
                self.assertFalse((self.output / 'node.json').is_file())

    def test_replace_directory_checks_the_output_it_replaces(self):
        staging = self.directory / 'staging'
        staging.mkdir()
        (staging / 'node.json').write_text('{}', encoding='utf-8')
        self.output.mkdir()
        (self.output / 'README').write_text('keep me', encoding='utf-8')
        self.assert_code('unsafe-output', node.replace_directory, staging, self.output, node.NODE_OUT_LAYOUT)
        self.assertEqual(self.entries(), ['README'])
        self.assertEqual(self.entries(staging), ['node.json'])

    def test_working_directory_and_its_ancestors_are_refused(self):
        local = self.local_build('x86_64')
        checkout = self.directory / 'checkout'
        (checkout / '.git').mkdir(parents=True)
        (checkout / '.git' / 'HEAD').write_text('ref: refs/heads/main\n', encoding='utf-8')
        (checkout / 'src').mkdir()
        (checkout / 'src' / 'work.txt').write_text('unpushed work', encoding='utf-8')
        empty = self.directory / 'empty'
        empty.mkdir()
        for working, output in ((checkout, '.'), (checkout / 'src', '..'), (checkout / 'src', str(self.directory)),
                                (empty, '.'), (empty, str(empty))):
            with self.subTest(working=working.name, output=output), contextlib.chdir(working):
                error = self.assert_code('unsafe-output', self.run_cli, '--local', f'x86_64={local}', '--output', output)
                self.assertEqual(error.details['reason'], 'working-directory')
        self.assertEqual(self.entries(checkout), ['.git', '.git/HEAD', 'src', 'src/work.txt'])
        self.assertEqual(list(empty.iterdir()), [])

    def test_local_mode_rejects_wrong_architecture_and_bad_arguments(self):
        local = self.directory / 'libnode.so'
        local.write_bytes(self.elves['arm64-v8a'])
        self.assert_code('elf-machine', self.run_cli, '--local', f'x86_64={local}')
        for arguments in (['--local', f'mips={local}'], ['--local', str(local)],
                          ['--local', f'x86_64={local}', '--local', f'x86_64={local}'],
                          ['--local', f'x86_64={local}', '--abi', 'x86_64']):
            with self.subTest(arguments=arguments):
                with self.assertRaises(SystemExit) as caught, contextlib.redirect_stderr(io.StringIO()) as stderr:
                    self.run_cli(*arguments)
                self.assertEqual(caught.exception.code, 2)
                self.assertEqual(stderr.getvalue(), 'TODO(copy)\n')
        self.assertFalse(self.output.exists())

    def test_output_symlink_is_not_replaced(self):
        local = self.directory / 'libnode.so'
        local.write_bytes(self.elves['x86_64'])
        target = self.directory / 'elsewhere'
        target.mkdir()
        self.output.symlink_to(target, target_is_directory=True)
        self.assert_code('unsafe-output', self.run_cli, '--local', f'x86_64={local}')
        self.assertEqual(list(target.iterdir()), [])


class DigestUpdateTests(FakeOras):
    def published(self):
        result = {}
        for abi in node.ABIS:
            data = self.elves[abi]
            result[abi] = {'repository': REPOSITORY, 'tag': f'node-24.22.0-1494da0071c0-{abi}',
                           'digest': self.digests[abi], 'sha256': sha256(data), 'size': len(data)}
        return result

    def run_updater(self, *arguments):
        stdout = io.StringIO()
        with contextlib.redirect_stdout(stdout):
            digests.main(['--runtime-lock', str(self.runtime_path), '--sources-lock', str(self.sources_path), *arguments])
        return json.loads(stdout.getvalue())

    def test_plan_reports_a_build_while_any_digest_is_null(self):
        plan = self.run_updater('--plan')
        self.assertEqual(plan, {
            'version': '24.22.0', 'npm': '11.19.1',
            'patchSet': '1494da0071c0b069a58a3d546376ce7d751c3b2a2ebfb59685c573e34626aa4a',
            'abis': {abi: {'repository': REPOSITORY, 'tag': f'node-24.22.0-1494da0071c0-{abi}', 'digest': None,
                           'pinned': False} for abi in node.ABIS},
            'needsBuild': True,
        })

    def test_published_digests_change_only_the_binaries_and_the_runtime_lock_hash(self):
        original_runtime = self.runtime_path.read_text(encoding='utf-8')
        original_sources = json.loads(self.sources_path.read_text(encoding='utf-8'))
        published = self.directory / 'published.json'
        published.write_text(json.dumps(self.published()), encoding='utf-8')
        result = self.run_updater('--published', str(published))
        expected = original_runtime
        for abi, item in self.published().items():
            block = (f'"tag": "{item["tag"]}",\n'
                     '                "digest": null,\n                "sha256": null,\n                "size": null\n')
            self.assertEqual(expected.count(block), 1, abi)
            expected = expected.replace(block, (
                f'"tag": "{item["tag"]}",\n                "digest": "{item["digest"]}",\n'
                f'                "sha256": "{item["sha256"]}",\n                "size": {item["size"]}\n'))
        self.assertEqual(self.runtime_path.read_text(encoding='utf-8'), expected)
        new_sources = json.loads(self.sources_path.read_text(encoding='utf-8'))
        self.assertEqual(new_sources['runtimeLockSha256'], sha256(expected.encode('utf-8')))
        original_sources['runtimeLockSha256'] = new_sources['runtimeLockSha256']
        self.assertEqual(new_sources, original_sources)
        self.assertEqual(self.sources_path.read_bytes(), sources.json_bytes(new_sources))
        self.assertEqual(result, {'changed': True, 'runtimeLockSha256': sha256(expected.encode('utf-8')),
                                  'abis': {abi: item['digest'] for abi, item in self.published().items()}})
        self.assertFalse(self.run_updater('--plan')['needsBuild'])
        before = (self.runtime_path.read_bytes(), self.sources_path.read_bytes())
        self.assertFalse(self.run_updater('--published', str(published))['changed'])
        self.assertEqual((self.runtime_path.read_bytes(), self.sources_path.read_bytes()), before)

    def test_updated_locks_feed_the_fetcher(self):
        self.install_oras()
        for abi in node.ABIS:
            self.publish(abi)
        published = self.directory / 'published.json'
        published.write_text(json.dumps(self.published()), encoding='utf-8')
        self.run_updater('--published', str(published))
        self.assertEqual(sorted(self.run_cli()['abis']), sorted(node.ABIS))

    def tags(self, version='24.22.0', patch_set=PATCH_SET):
        return {abi: f'node-{version}-{patch_set[:12]}-{abi}' for abi in sorted(node.ABIS)}

    def test_pins_whose_tag_no_longer_matches_are_stale(self):
        for abi in node.ABIS:
            self.publish(abi)
        self.edit_runtime(lambda runtime: runtime['node']['binaries']['x86_64'].update(tag='node-24.21.0-1494da0071c0-x86_64'))
        error = self.assert_code('node-binary-stale', self.pins)
        self.assertEqual(error.details, {'abi': 'x86_64', 'expected': 'node-24.22.0-1494da0071c0-x86_64'})

    def test_reset_drops_the_published_pins_and_restores_the_unpublished_locks(self):
        original = (self.runtime_path.read_bytes(), self.sources_path.read_bytes())
        self.assertEqual(self.run_updater('--reset'),
                         {'changed': False, 'runtimeLockSha256': sha256(original[0]), 'tags': self.tags()})
        self.assertEqual((self.runtime_path.read_bytes(), self.sources_path.read_bytes()), original)
        published = self.directory / 'published.json'
        published.write_text(json.dumps(self.published()), encoding='utf-8')
        self.run_updater('--published', str(published))
        self.assertFalse(self.run_updater('--plan')['needsBuild'])
        self.assertEqual(self.run_updater('--reset'),
                         {'changed': True, 'runtimeLockSha256': sha256(original[0]), 'tags': self.tags()})
        self.assertEqual((self.runtime_path.read_bytes(), self.sources_path.read_bytes()), original)
        self.assertTrue(self.run_updater('--plan')['needsBuild'])

    def test_reset_rekeys_the_locks_after_a_patch_series_change(self):
        for abi in node.ABIS:
            self.publish(abi)
        self.write_locks()
        series = self.patches / 'series'
        lines = series.read_text(encoding='utf-8').split('\n')
        names = [line for line in lines if line and not line.startswith('#')]
        series.write_text('\n'.join(names[1] if line == names[0] else names[0] if line == names[1] else line
                                    for line in lines), encoding='utf-8')
        self.assert_code('node-series-mismatch', self.pins)
        result = self.run_updater('--reset')
        reordered = [names[1], names[0], names[2]]
        patch_set = node.patch_set_sha256(self.patches, reordered)
        self.assertEqual(result['tags'], self.tags(patch_set=patch_set))
        expected = copy.deepcopy(self.runtime)
        expected['node']['patchSet'].update(series=reordered, sha256=patch_set)
        for abi, binary in expected['node']['binaries'].items():
            binary.update(tag=self.tags(patch_set=patch_set)[abi], digest=None, sha256=None, size=None)
        self.assertEqual(self.runtime_path.read_bytes(), runtime_bytes(expected))
        lock = json.loads(self.sources_path.read_text(encoding='utf-8'))
        self.assertEqual(lock['node']['patches'], node.patch_pins(self.patches))
        self.assertEqual(lock['runtimeLockSha256'], sha256(runtime_bytes(expected)))
        self.assertEqual(self.pins().patch_set, patch_set)
        self.assertTrue(self.run_updater('--plan')['needsBuild'])

    def test_reset_rekeys_the_locks_after_a_node_version_change(self):
        # sources.py --refresh-lock pinned the new version's source; runtime.lock still names the old builds.
        for abi in node.ABIS:
            self.publish(abi)
        self.runtime['node']['version'] = '24.23.0'
        lock = copy.deepcopy(self.lock)
        lock['node']['version'] = '24.23.0'
        for key, filename in (('source', 'node-v24.23.0.tar.xz'), ('shasums', 'SHASUMS256.txt'),
                              ('signature', 'SHASUMS256.txt.sig')):
            lock['node'][key].update(url=f'https://nodejs.org/dist/v24.23.0/{filename}', filename=filename)
        lock['node']['source']['sha256'] = 'ab' * 32
        self.write_locks(lock=lock)
        self.assert_code('node-source-pin', self.pins)
        self.assertEqual(self.run_updater('--reset')['tags'], self.tags(version='24.23.0'))
        pins = self.pins()
        self.assertEqual(pins.node['source'], {
            'repository': 'https://github.com/nodejs/node.git', 'tag': 'v24.23.0',
            # The tag's commit is not derived; the procedure sets it by hand.
            'commit': self.runtime['node']['source']['commit'],
            'tarball': 'node-v24.23.0.tar.xz', 'tarballSha256': 'ab' * 32})
        for abi in node.ABIS:
            self.assertEqual(pins.binary(abi), {'repository': REPOSITORY, 'tag': self.tags(version='24.23.0')[abi],
                                                'digest': None, 'sha256': None, 'size': None})
        self.assertTrue(self.run_updater('--plan')['needsBuild'])

    def test_reset_writes_nothing_unless_the_result_validates(self):
        # runtime.lock names a version that sources.lock does not pin yet.
        self.edit_runtime(lambda runtime: runtime['node'].update(version='24.23.0'))
        before = (self.runtime_path.read_bytes(), self.sources_path.read_bytes())
        self.assert_code('runtime-section-mismatch', self.run_updater, '--reset')
        self.assertEqual((self.runtime_path.read_bytes(), self.sources_path.read_bytes()), before)
        self.edit_runtime(lambda runtime: runtime['node'].pop('binaries'))
        before = (self.runtime_path.read_bytes(), self.sources_path.read_bytes())
        self.assert_code('node-reset-input', self.run_updater, '--reset')
        self.assertEqual((self.runtime_path.read_bytes(), self.sources_path.read_bytes()), before)

    def test_invalid_publications_leave_both_locks_untouched(self):
        cases = [
            ('published-abis', lambda value: value.pop('x86_64')),
            ('published-abis', lambda value: value.update(mips=value['x86_64'])),
            ('published-entry', lambda value: value['x86_64'].pop('size')),
            ('published-entry', lambda value: value['x86_64'].update(extra=1)),
            ('published-reference', lambda value: value['x86_64'].update(tag='node-24.22.0-000000000000-x86_64')),
            ('published-reference', lambda value: value['x86_64'].update(repository='ghcr.io/other/repository')),
            ('published-pin', lambda value: value['x86_64'].update(digest='sha256:short')),
            ('published-pin', lambda value: value['x86_64'].update(sha256='A' * 64)),
            ('published-pin', lambda value: value['x86_64'].update(size=False)),
        ]
        before = (self.runtime_path.read_bytes(), self.sources_path.read_bytes())
        for code, change in cases:
            with self.subTest(code=code):
                value = self.published()
                change(value)
                published = self.directory / 'published.json'
                published.write_text(json.dumps(value), encoding='utf-8')
                self.assert_code(code, self.run_updater, '--published', str(published))
                self.assertEqual((self.runtime_path.read_bytes(), self.sources_path.read_bytes()), before)


class BuildInputTests(LockFixture):
    def run_inputs(self, *arguments):
        stdout = io.StringIO()
        with contextlib.redirect_stdout(stdout):
            node.main(['--runtime-lock', str(self.runtime_path), '--sources-lock', str(self.sources_path), *arguments])
        return stdout.getvalue()

    @unittest.skipUnless(shutil.which('bash'), 'bash is not installed')
    def test_build_inputs_are_shell_assignments_of_the_pins(self):
        tarball = self.directory / "object with 'quote"
        signature = {'status': 'verified', 'signers': ['C82FA3AE1CBEDC6BE46B9360C43CEC45C17AB93C']}
        with mock.patch.object(node, 'verified_source', return_value=(tarball, signature)), \
                mock.patch.object(node, 'fetch_ndk', return_value=self.directory / 'ndk.zip') as ndk:
            text = self.run_inputs('--build-inputs', 'armeabi-v7a', '--offline')
            ndk.assert_not_called()
            with_ndk = self.run_inputs('--build-inputs', 'armeabi-v7a', '--with-ndk')
            ndk.assert_called_once()
        script = self.directory / 'inputs.sh'
        script.write_text(text, encoding='utf-8')
        shown = subprocess.run(['bash', '-c', 'set -eu; . "$1"; printf "%s\\n" "$NODE_TARBALL" "$NODE_TARBALL_NAME" "$NODE_TAG" '
                                '"$NODE_SIGNATURE" "$NODE_SIGNERS" "$NODE_API" "$NODE_ICU" "$NDK_REVISION" "[$NDK_ZIP]" '
                                '"${NODE_PATCHES[@]}"', 'inputs', str(script)],
                               check=True, stdout=subprocess.PIPE, text=True).stdout.splitlines()
        self.assertEqual(shown, [str(tarball), 'node-v24.22.0.tar.xz', 'node-24.22.0-1494da0071c0-armeabi-v7a', 'verified',
                                 'C82FA3AE1CBEDC6BE46B9360C43CEC45C17AB93C', '29', 'full-icu', '30.0.16248370', '[]',
                                 '0001-v8-x64-posix-trap-sources.patch', '0002-zlib-android-getauxval.patch',
                                 '0003-v8-arm64-host-trap-sources.patch'])
        self.assertIn(f"NDK_ZIP={shlex.quote(str(self.directory / 'ndk.zip'))}\n", with_ndk)

    def test_ndk_zip_is_checked_by_size_sha1_and_sha256(self):
        contents = b'fixture ndk zip'
        cache = self.directory / 'cache'
        (cache / 'objects').mkdir(parents=True)
        (cache / 'objects' / sha256(contents)).write_bytes(contents)
        ndk = {'size': len(contents), 'sha1': hashlib.sha1(contents).hexdigest(), 'sha256': sha256(contents)}
        self.edit_runtime(lambda runtime: runtime['node']['ndk'].update(ndk))
        self.assertEqual(node.fetch_ndk(self.pins(), cache, offline=True).read_bytes(), contents)
        self.edit_runtime(lambda runtime: runtime['node']['ndk'].update(ndk, sha1='0' * 40))
        self.assert_code('ndk-pin-mismatch', node.fetch_ndk, self.pins(), cache, offline=True)
        self.edit_runtime(lambda runtime: runtime['node']['ndk'].update(ndk, sha256='0' * 64))
        self.assert_code('offline-cache-miss', node.fetch_ndk, self.pins(), cache, offline=True)

    def test_source_must_be_listed_in_the_pinned_shasums(self):
        paths = {}
        for key, contents in (('source', b'tarball'), ('shasums', b'listing'), ('signature', b'sig'), ('keyring', b'keys')):
            paths[key] = self.directory / key
            paths[key].write_bytes(contents)
        node_lock = self.lock['node']
        listing = f'{node_lock["source"]["sha256"]}  {node_lock["source"]["filename"]}\n'

        class FakeCache:
            def __init__(self, directory, offline):
                self.offline = offline

            def get(self, url, sha):
                key = next(key for key in paths if node_lock[key]['url'] == url)
                return paths[key]

        with mock.patch.object(sources, 'Cache', FakeCache), mock.patch.object(node.shutil, 'which', return_value=None):
            paths['shasums'].write_text(listing, encoding='ascii')
            self.assertEqual(node.verified_source(self.pins(), self.directory, offline=True),
                             (paths['source'], {'status': 'not-checked', 'reason': 'gpgv-missing'}))
            paths['shasums'].write_text(listing.replace(node_lock['source']['sha256'], '0' * 64), encoding='ascii')
            self.assert_code('node-source-shasums', node.verified_source, self.pins(), self.directory, True)


class BuildScriptTests(unittest.TestCase):
    SCRIPT = ROOT / 'build-node.sh'

    def test_recipe_keeps_s21_flags_and_gates(self):
        text = self.SCRIPT.read_text(encoding='utf-8')
        for fragment in ("LDFLAGS='-Wl,-z,max-page-size=16384 -Wl,-z,common-page-size=16384 -static-libstdc++'",
                         'CC_host="$toolchain/clang -m32" CXX_host="$toolchain/clang++ -m32" LINK_host=\'g++ -m32\'',
                         './android-configure "$ndk" "$NODE_API" "$arch"', "grep -q 'INFO: configure completed successfully'",
                         '--check-config', '--strip-all', '--audit', 'patch --batch --forward --fuzz=0',
                         'make -j"$jobs"', 'GYP_CROSSCOMPILE=1'):
            self.assertIn(fragment, text)

    @unittest.skipUnless(shutil.which('bash'), 'bash is not installed')
    def test_script_parses_and_refuses_unknown_abis_and_job_counts(self):
        subprocess.run(['bash', '-n', str(self.SCRIPT)], check=True)
        for arguments, environment, code in ((['mips'], {}, 'unknown-abi'), ([], {}, 'usage'),
                                             (['x86_64'], {'NODE_BUILD_JOBS': '0'}, 'invalid-jobs'),
                                             (['x86_64'], {'NODE_BUILD_JOBS': '4; rm -rf /'}, 'invalid-jobs')):
            with self.subTest(arguments=arguments, environment=environment):
                result = subprocess.run(['bash', str(self.SCRIPT), *arguments], stdout=subprocess.PIPE,
                                        stderr=subprocess.PIPE, text=True, env={**os.environ, **environment})
                self.assertEqual(result.returncode, 1)
                lines = result.stderr.splitlines()
                self.assertEqual(lines[0], 'TODO(copy)')
                self.assertEqual(json.loads(lines[1])['code'], code)


if __name__ == '__main__':
    unittest.main(verbosity=2)
