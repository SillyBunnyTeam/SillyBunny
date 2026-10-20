#!/usr/bin/env python3
import argparse
import copy
import datetime
import email.utils
import fcntl
import hashlib
import json
import os
import posixpath
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
from collections import deque
from pathlib import Path, PurePosixPath
from urllib.parse import quote, urlsplit


ROOT = Path(__file__).resolve().parent
ABI_ARCHES = {
    'arm64-v8a': ('aarch64', 'EM_AARCH64', 64),
    'armeabi-v7a': ('arm', 'EM_ARM', 32),
    'x86_64': ('x86_64', 'EM_X86_64', 64),
}
PREFIX = 'data/data/com.termux/files/usr/'
SYSTEM_LIBRARIES = {'libc.so', 'libm.so', 'libdl.so', 'liblog.so'}
NATIVE_NAME = re.compile(r'lib[A-Za-z0-9._+-]*\.so\Z')
SHA256 = re.compile(r'[0-9a-fA-F]{64}\Z')
OLD_SHELL = b'/data/data/com.termux/files/usr/bin/sh'
NEW_SHELL = b'/system/bin/sh'
SIGNING_FINGERPRINT = 'CC72CF8BA7DBFA0182877D045A897D96E57CF20C'
SIGNING_KEY_SHA256 = '21c385d5a30107453bd60582d64e2f6e5f5ce11e340ac05e57f943f9c0235420'

# These commands have no call-coverage requirement in the launcher/server HTTPS
# workflows. Keep their payloads and aliases out of nativeLibraryDir/GIT_EXEC_PATH:
# git-daemon, git-http-backend: serve repositories, rather than clone/update them.
# git-http-fetch, git-http-push: obsolete dumb HTTP; smart HTTPS uses remote-http.
# git-imap-send: sends mail; scalar: manages large enlistments; git-shell: SSH server.
# git-sh-i18n--envsubst: supports only the excluded shell-script helpers.
# git-remote-ftp, git-remote-ftps: FTP transports, outside the HTTP(S) install path.
# Perl: git-archimport, git-cvsexportcommit, git-cvsimport, git-cvsserver,
# git-send-email: foreign VCS/mail integration, with no bundled Perl interpreter.
# Python: git-p4: Perforce integration, with no bundled Python interpreter.
# Shell: git-difftool--helper, git-filter-branch, git-gui--askyesno, git-instaweb,
# git-merge-octopus, git-merge-one-file, git-merge-resolve, git-mergetool,
# git-mergetool--lib, git-quiltimport, git-request-pull, git-sh-i18n, git-sh-setup,
# git-submodule, git-subtree, git-web--browse: GUI/web/legacy merge/import/submodule
# workflows, not the built-in stash/checkout/fast-forward update operations.
# Tcl/Tk git-gui/gitk and other package tools/docs/locales are not runtime inputs.
# No termux-exec preload, SSH client, terminal database, optional OpenSSL providers,
# or unused shared libraries are shipped: none is in the selected DT_NEEDED closure.
EXCLUDED_GIT_CORE = {
    'git-daemon', 'git-http-backend', 'git-http-fetch', 'git-http-push',
    'git-imap-send', 'scalar', 'git-shell', 'git-sh-i18n--envsubst',
    'git-remote-ftp', 'git-remote-ftps', 'git-archimport', 'git-cvsexportcommit',
    'git-cvsimport', 'git-cvsserver', 'git-send-email', 'git-p4',
    'git-difftool--helper', 'git-filter-branch', 'git-gui--askyesno', 'git-instaweb',
    'git-merge-octopus', 'git-merge-one-file', 'git-merge-resolve', 'git-mergetool',
    'git-mergetool--lib', 'git-quiltimport', 'git-request-pull', 'git-sh-i18n',
    'git-sh-setup', 'git-submodule', 'git-subtree', 'git-web--browse',
}


def require_tools(*tools):
    for tool in tools:
        if not shutil.which(tool):
            raise ValueError(f'{tool} is required; use Ubuntu 24.04+ with patchelf and python3-pyelftools')


def run(arguments, **kwargs):
    return subprocess.run([str(item) for item in arguments], check=True, **kwargs)


def digest(path):
    result = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            result.update(block)
    return result.hexdigest()


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(mode='w', encoding='utf-8', dir=path.parent, delete=False) as stream:
        temporary = Path(stream.name)
        try:
            stream.write(json.dumps(value, indent=4) + '\n')
            stream.flush()
            os.fsync(stream.fileno())
        except BaseException:
            temporary.unlink(missing_ok=True)
            raise
    try:
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)


def pool_filename(filename):
    if not isinstance(filename, str) or not re.fullmatch(r'pool/(?:[A-Za-z0-9_+~:.-]+/)*[A-Za-z0-9_+~:.-]+\.deb', filename):
        raise ValueError(f'Invalid package filename: {filename!r}')
    if any(part in ('.', '..') for part in filename.split('/')):
        raise ValueError(f'Package filename contains traversal: {filename!r}')
    return filename


def validate_lock(lock):
    if not isinstance(lock, dict) or type(lock.get('schema')) is not int or lock['schema'] != 1:
        raise ValueError('runtime.lock must use schema 1')
    if not isinstance(lock.get('abis'), list) or sorted(lock['abis']) != sorted(ABI_ARCHES):
        raise ValueError('runtime.lock must list exactly arm64-v8a, armeabi-v7a and x86_64')
    for key in ('node', 'bun', 'npm'):
        if key not in lock or (lock[key] is not None and not isinstance(lock[key], dict)):
            raise ValueError(f'runtime.lock {key} must be null or an object')
    termux = lock.get('termux', {})
    if not isinstance(termux, dict):
        raise ValueError('runtime.lock termux must be an object')
    repository = urlsplit(termux.get('repository', ''))
    if repository.scheme != 'https' or not repository.hostname or repository.username or repository.password or repository.query or repository.fragment:
        raise ValueError('Termux repository must be a credential-free HTTPS URL')
    for key in ('suite', 'component'):
        if not isinstance(termux.get(key), str) or not re.fullmatch(r'[a-z0-9][a-z0-9-]*', termux[key]):
            raise ValueError(f'Invalid Termux {key}')
    packages = termux.get('packages')
    if not isinstance(packages, list) or not packages:
        raise ValueError('runtime.lock must pin Termux packages')
    names = set()
    for package in packages:
        if not isinstance(package, dict) or not re.fullmatch(r'[a-z0-9][a-z0-9+.-]*', package.get('name', '')):
            raise ValueError('Invalid Termux package name')
        name = package['name']
        if name in names:
            raise ValueError(f'Duplicate Termux package: {name}')
        names.add(name)
        if not isinstance(package.get('version'), str) or not package['version'].strip():
            raise ValueError(f'Missing version: {name}')
        if not isinstance(package.get('debs'), dict) or set(package['debs']) != set(ABI_ARCHES):
            raise ValueError(f'{name} must pin a deb for every ABI')
        for abi, deb in package['debs'].items():
            if not isinstance(deb, dict) or not isinstance(deb.get('sha256'), str) or not SHA256.fullmatch(deb['sha256']):
                raise ValueError(f'Invalid SHA256: {name}/{abi}')
            pool_filename(deb.get('filename'))
    if not {'git', 'bash', 'ca-certificates'}.issubset(names):
        raise ValueError('runtime.lock must include git, bash and ca-certificates')


def download(repository, relative, destination, sha256=None, size=None, fresh=False):
    destination.parent.mkdir(parents=True, exist_ok=True)

    def verify(path):
        if sha256 is not None and digest(path).lower() != sha256.lower():
            raise ValueError(f'SHA256 mismatch: {relative}; remove the corrupt cache file explicitly: {path}')
        if size is not None and path.stat().st_size != size:
            raise ValueError(f'Size mismatch: {relative}: expected {size}, got {path.stat().st_size}')

    if destination.exists() and sha256 is not None:
        verify(destination)
        print(f'Using verified cache: {relative}', flush=True)
        return destination
    require_tools('curl')
    url = repository.rstrip('/') + '/' + quote(relative, safe='/+._~-')
    if fresh:
        url += '?runtime-snapshot=' + os.urandom(8).hex()
    with tempfile.NamedTemporaryFile(dir=destination.parent, suffix='.part', delete=False) as stream:
        temporary = Path(stream.name)
    try:
        print(f'Downloading: {relative}', flush=True)
        run(['curl', '-q', '--fail', '--location', '--silent', '--show-error',
             '--proto', '=https', '--proto-redir', '=https', '--tlsv1.2',
             '--retry', '3', '--connect-timeout', '30', '--max-time', '300',
             '--header', 'Cache-Control: no-cache', '--output', temporary, url])
        verify(temporary)
        temporary.replace(destination)
    finally:
        temporary.unlink(missing_ok=True)
    return destination


def parse_control(text):
    records = []
    for stanza in re.split(r'\n\s*\n', text.strip()):
        record = {}
        key = None
        for line in stanza.splitlines():
            if line.startswith((' ', '\t')):
                if key is None:
                    raise ValueError('Control file continuation without field')
                record[key] += '\n' + line[1:]
            else:
                key, value = line.split(':', 1)
                if key in record:
                    raise ValueError(f'Duplicate control field: {key}')
                record[key] = value.lstrip()
        if record:
            records.append(record)
    return records


def authenticate_release(repository, suite, work):
    require_tools('gpg', 'gpgv')
    home = work / 'gnupg'
    home.mkdir(mode=0o700)
    keyring = work / 'termux-autobuilds.gpg'
    run(['gpg', '--no-options', '--batch', '--homedir', home, '--dearmor',
         '--output', keyring, ROOT / 'termux-autobuilds.asc'], stdout=subprocess.PIPE)
    if digest(keyring) != SIGNING_KEY_SHA256:
        raise ValueError('Pinned Termux signing-key bytes changed; review the key and fingerprint before updating')
    key_info = run(['gpg', '--no-options', '--batch', '--homedir', home, '--with-colons',
                    '--show-keys', keyring], stdout=subprocess.PIPE, text=True).stdout.splitlines()
    fingerprints = [line.split(':')[9] for line in key_info if line.startswith('fpr:')]
    if fingerprints != [SIGNING_FINGERPRINT]:
        raise ValueError('Pinned Termux key does not match its primary fingerprint')
    now = datetime.datetime.now(datetime.timezone.utc)
    for line in key_info:
        fields = line.split(':')
        if fields[0] in ('pub', 'sub') and (fields[1] in ('r', 'e', 'd') or (fields[6] and int(fields[6]) <= now.timestamp())):
            raise ValueError('Pinned Termux signing key is revoked, expired or disabled')
    inrelease = download(repository, f'dists/{suite}/InRelease', work / 'InRelease', fresh=True)
    release_path = work / 'Release'
    verified = run(['gpgv', '--homedir', home, '--keyring', keyring, '--status-fd', '1',
                    '--output', release_path, inrelease], stdout=subprocess.PIPE, text=True)
    status = [line.split()[1:] for line in verified.stdout.splitlines() if line.startswith('[GNUPG:] ')]
    signatures = [line for line in status if line[0] == 'VALIDSIG']
    if not signatures or any(line[1] != SIGNING_FINGERPRINT or line[-1] != SIGNING_FINGERPRINT or line[8] not in ('8', '9', '10') for line in signatures):
        raise ValueError('InRelease lacks a SHA256-or-stronger signature from the pinned Termux key')
    if any(line[0] in ('BADSIG', 'ERRSIG', 'EXPKEYSIG', 'EXPSIG', 'REVKEYSIG', 'KEYREVOKED') for line in status):
        raise ValueError('InRelease signature is invalid, revoked or expired')
    records = parse_control(release_path.read_text(encoding='utf-8'))
    if len(records) != 1:
        raise ValueError('Expected exactly one signed Release record')
    release = records[0]
    if release.get('Suite') != suite or release.get('Codename') != suite:
        raise ValueError('Signed Release suite/codename differs from runtime.lock')
    date = email.utils.parsedate_to_datetime(release['Date'])
    # The repository currently omits Valid-Until; bound replay for manual updates.
    if date.tzinfo is None or not datetime.timedelta(days=-1) <= now - date <= datetime.timedelta(days=7):
        raise ValueError('Signed Release Date is outside the last 7 days (or over 1 day in the future)')
    if 'Valid-Until' in release and email.utils.parsedate_to_datetime(release['Valid-Until']) <= now:
        raise ValueError('Signed Release has expired')
    hashes = {}
    for line in release['SHA256'].splitlines():
        if not line.strip():
            continue
        sha256, size, filename = line.split()
        if not SHA256.fullmatch(sha256) or filename in hashes or not size.isdecimal():
            raise ValueError('Malformed or duplicate signed Release SHA256 entry')
        hashes[filename] = (sha256, int(size))
    print(f'Authenticated InRelease: {SIGNING_FINGERPRINT}; Date={release["Date"]}; SHA256={digest(inrelease)}', flush=True)
    return release, hashes


def resolve_update(lock, cache, work):
    termux = lock['termux']
    release, hashes = authenticate_release(termux['repository'], termux['suite'], work)
    if termux['component'] not in release['Components'].split():
        raise ValueError('Termux component is absent from the signed Release')
    indexes = {}
    for abi, (architecture, _, _) in ABI_ARCHES.items():
        relative = f'{termux["component"]}/binary-{architecture}/Packages'
        if architecture not in release['Architectures'].split() or relative not in hashes:
            raise ValueError(f'Signed Release does not cover {architecture} Packages')
        sha256, size = hashes[relative]
        index = download(termux['repository'], f'dists/{termux["suite"]}/{relative}',
                         work / f'{architecture}.Packages', sha256, size, fresh=True)
        indexes[abi] = parse_control(index.read_text(encoding='utf-8'))
        print(f'Authenticated Packages: {architecture}; SHA256={sha256}', flush=True)
    updated = copy.deepcopy(lock)
    for package in updated['termux']['packages']:
        versions = set()
        for abi, records in indexes.items():
            architecture = ABI_ARCHES[abi][0]
            matches = [item for item in records if item.get('Package') == package['name'] and item.get('Architecture') in (architecture, 'all')]
            if not matches:
                raise ValueError(f'Pinned package absent from authenticated index: {package["name"]}/{abi}')
            selected = matches[0]
            for item in matches[1:]:
                compared = subprocess.run(['dpkg', '--compare-versions', item['Version'], 'gt', selected['Version']])
                if compared.returncode not in (0, 1):
                    raise ValueError(f'Invalid indexed Debian package version: {package["name"]}')
                if compared.returncode == 0:
                    selected = item
            filename = pool_filename(selected['Filename'])
            sha256 = selected['SHA256']
            if not SHA256.fullmatch(sha256):
                raise ValueError(f'Invalid indexed deb SHA256: {filename}')
            download(termux['repository'], filename, cache / 'debs' / (sha256.lower() + '.deb'), sha256, int(selected['Size']))
            package['debs'][abi] = {'filename': filename, 'sha256': sha256.lower()}
            versions.add(selected['Version'])
        if len(versions) != 1:
            raise ValueError(f'Newest {package["name"]} versions differ across ABIs; retry after repository publication completes')
        package['version'] = versions.pop()
    validate_lock(updated)
    fetch_debs(updated, cache)
    return updated


def update_lock(lock, lock_path, cache, dry_run):
    require_tools('gpg', 'gpgv', 'dpkg', 'dpkg-deb')
    # CDN indexes may race a freshly signed Release. Retry whole authenticated
    # snapshots, never accept an index/hash mismatch or unsigned fallback.
    for attempt in range(3):
        try:
            with tempfile.TemporaryDirectory(prefix='termux-index-', dir=cache) as temporary:
                updated = resolve_update(lock, cache, Path(temporary))
            break
        except ValueError as error:
            if attempt == 2 or not str(error).startswith(('SHA256 mismatch:', 'Size mismatch:')) or '/Packages' not in str(error):
                raise
            print(f'Repository snapshot changed; reauthenticating ({attempt + 2}/3): {error}', file=sys.stderr, flush=True)
    changes = [f'{old["name"]}: {old["version"]} -> {new["version"]}'
               for old, new in zip(lock['termux']['packages'], updated['termux']['packages']) if old != new]
    for change in changes:
        print(change)
    if dry_run:
        print(f'Authenticated lock dry run passed: {len(updated["termux"]["packages"])} packages, {len(changes)} changes; runtime.lock not written')
    else:
        write_json(lock_path, updated)
        print(f'Updated authenticated runtime.lock: {len(changes)} changes')


def fetch_debs(lock, cache):
    require_tools('dpkg-deb')
    debs = {}
    for abi, (architecture, _, _) in ABI_ARCHES.items():
        debs[abi] = []
        for package in lock['termux']['packages']:
            pin = package['debs'][abi]
            path = download(lock['termux']['repository'], pin['filename'],
                            cache / 'debs' / (pin['sha256'].lower() + '.deb'), pin['sha256'])
            fields = parse_control(run(['dpkg-deb', '--field', path], stdout=subprocess.PIPE, text=True).stdout)[0]
            if fields.get('Package') != package['name'] or fields.get('Version') != package['version'] or fields.get('Architecture') not in (architecture, 'all'):
                raise ValueError(f'Deb metadata differs from lock: {package["name"]}/{abi}')
            debs[abi].append((package['name'], path))
    return debs


class Payload:
    def __init__(self, directory):
        self.directory = directory
        self.entries = {}
        directory.mkdir(parents=True)

    def extract(self, package, deb):
        # Keep archive links virtual and regular files in a flat object store.
        # No archive-controlled path or symlink is ever written to the host tree;
        # this also preserves case-distinct package names on WSL's NTFS mounts.
        with subprocess.Popen(['dpkg-deb', '--fsys-tarfile', str(deb)], stdout=subprocess.PIPE) as process:
            try:
                with tarfile.open(fileobj=process.stdout, mode='r|') as archive:
                    for member in archive:
                        if member.isdir():
                            continue
                        name = self.path(member.name)
                        if member.isfile():
                            target = self.directory / hashlib.sha256(name.encode()).hexdigest()
                            with archive.extractfile(member) as source:
                                if name in self.entries:
                                    contents = source.read()
                                    if self.entries[name][0] != 'file' or hashlib.sha256(contents).hexdigest() != digest(target):
                                        raise ValueError(f'Conflicting package file: {name}')
                                else:
                                    with target.open('wb') as stream:
                                        shutil.copyfileobj(source, stream)
                            entry = ('file', target, package)
                        elif member.issym() or member.islnk():
                            target = member.linkname
                            if member.issym() and not target.startswith('/'):
                                target = posixpath.join(posixpath.dirname(name), target)
                            entry = ('link', self.path(posixpath.normpath(target).lstrip('/')), package)
                        else:
                            raise ValueError(f'Unsupported package member: {name}')
                        if name in self.entries and self.entries[name] != entry:
                            raise ValueError(f'Overlapping package ownership: {name}')
                        self.entries[name] = entry
                if process.wait() != 0:
                    raise ValueError(f'dpkg-deb extraction failed: {package}')
            except BaseException:
                process.kill()
                raise

    @staticmethod
    def path(name):
        path = PurePosixPath(name)
        normalized = str(path)
        if path.is_absolute() or '..' in path.parts or '\\' in name or not normalized.startswith(PREFIX):
            raise ValueError(f'Package path escapes Termux prefix: {name!r}')
        return normalized

    def resolve(self, name):
        name = self.path(name)
        for _ in range(40):
            if name not in self.entries:
                raise ValueError(f'Missing package file or broken symlink: {name}')
            kind, target, package = self.entries[name]
            if kind == 'file':
                return target, package
            name = target
        raise ValueError(f'Package symlink loop: {name}')


def inspect_elf(path):
    from elftools.elf.elffile import ELFFile
    with path.open('rb') as stream:
        elf = ELFFile(stream)
        data = {'class': elf.elfclass, 'machine': elf['e_machine'], 'type': elf['e_type'],
                'littleEndian': elf.little_endian, 'interpreter': None, 'needed': [],
                'soname': None, 'rpaths': [], 'loads': [], 'versionNeeded': []}
        for segment in elf.iter_segments():
            if segment['p_type'] == 'PT_LOAD':
                data['loads'].append({key: segment[key] for key in ('p_offset', 'p_vaddr', 'p_align')})
            elif segment['p_type'] == 'PT_INTERP':
                data['interpreter'] = segment.get_interp_name()
            elif segment['p_type'] == 'PT_DYNAMIC':
                for tag in segment.iter_tags():
                    if tag.entry.d_tag == 'DT_NEEDED':
                        data['needed'].append(tag.needed)
                    elif tag.entry.d_tag == 'DT_SONAME':
                        data['soname'] = tag.soname
                    elif tag.entry.d_tag in ('DT_RPATH', 'DT_RUNPATH'):
                        data['rpaths'].append(tag.entry.d_tag)
        versions = elf.get_section_by_name('.gnu.version_r')
        if versions is not None:
            data['versionNeeded'] = [version.name for version, _ in versions.iter_versions()]
        return data


def native_name(soname):
    match = re.fullmatch(r'(lib.+)\.so(?:\.([0-9.]+))?', soname)
    if not match:
        raise ValueError(f'Cannot map shared-library SONAME: {soname}')
    return match[1] + (match[2].replace('.', '_') if match[2] else '') + '.so'


def patch_shell(path):
    data = path.read_bytes()
    if data.count(OLD_SHELL) != 1 or data.count(OLD_SHELL + b'\0') != 1:
        raise ValueError(f'Expected exactly one NUL-terminated Git SHELL_PATH literal: {path.name}')
    patched = data.replace(OLD_SHELL, NEW_SHELL.ljust(len(OLD_SHELL), b'\0'))
    if len(patched) != len(data) or OLD_SHELL in patched:
        raise ValueError(f'Git SHELL_PATH patch failed: {path.name}')
    path.write_bytes(patched)


def validate_elf(path, abi, names):
    data = inspect_elf(path)
    _, machine, bits = ABI_ARCHES[abi]
    if not NATIVE_NAME.fullmatch(path.name):
        raise ValueError(f'Invalid APK native filename: {path.name}')
    if data['machine'] != machine or data['class'] != bits or not data['littleEndian'] or data['type'] != 'ET_DYN':
        raise ValueError(f'Wrong ELF architecture/type: {abi}/{path.name}')
    if data['rpaths']:
        raise ValueError(f'RPATH/RUNPATH remains: {abi}/{path.name}')
    unresolved = set(data['needed']) - names - SYSTEM_LIBRARIES
    if unresolved:
        raise ValueError(f'Unresolved DT_NEEDED: {abi}/{path.name}: {sorted(unresolved)}')
    if data['soname'] is not None and data['soname'] != path.name:
        raise ValueError(f'SONAME differs from APK filename: {abi}/{path.name}')
    if data['interpreter'] not in (None, '/system/bin/linker' if bits == 32 else '/system/bin/linker64'):
        raise ValueError(f'Unexpected ELF interpreter: {abi}/{path.name}')
    if not data['loads']:
        raise ValueError(f'No ELF LOAD segments: {abi}/{path.name}')
    for load in data['loads']:
        alignment = load['p_align']
        if alignment <= 0 or alignment & (alignment - 1) or (load['p_vaddr'] - load['p_offset']) % alignment:
            raise ValueError(f'Invalid ELF LOAD alignment: {abi}/{path.name}')
        if bits == 64 and (alignment < 0x4000 or (load['p_vaddr'] - load['p_offset']) % 0x4000):
            raise ValueError(f'64-bit ELF LOAD is not 16 KB aligned: {abi}/{path.name}')
    return data


def copy_file(source, destination, executable=False):
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(source, destination)
    destination.chmod(0o755 if executable else 0o644)


def package_abi(payload, abi, output):
    units = {}
    by_source = {}
    metadata = {}
    candidates = {}
    used_packages = set()

    def elf(path):
        if path not in metadata:
            metadata[path] = inspect_elf(path)
        return metadata[path]

    def add(name, source):
        path, owner = payload.resolve(PREFIX + source)
        if path in by_source:
            return by_source[path]
        if name in units or not NATIVE_NAME.fullmatch(name):
            raise ValueError(f'Invalid/colliding native name: {name}')
        units[name] = (path, source, owner)
        by_source[path] = name
        used_packages.add(owner)
        return name

    git_name = add('libgit.so', 'bin/git')
    add('libbash.so', 'bin/bash')
    http_name = add('libgit-remote-http.so', 'libexec/git-core/git-remote-http')
    git_path = units[git_name][0]
    http_path = units[http_name][0]
    git_hash = digest(git_path)
    http_hash = digest(http_path)
    source_hashes = {}

    def source_hash(path):
        if path not in source_hashes:
            source_hashes[path] = digest(path)
        return source_hashes[path]

    links = {}
    for name in sorted(payload.entries):
        if name.startswith(PREFIX + 'lib/') and '.so' in PurePosixPath(name).name:
            path, _ = payload.resolve(name)
            with path.open('rb') as stream:
                if stream.read(4) != b'\x7fELF':
                    continue
            data = elf(path)
            if data['interpreter'] is not None:
                continue
            for alias in {PurePosixPath(name).name, data['soname']} - {None}:
                candidates.setdefault(alias, set()).add(path)
        if name.startswith(PREFIX + 'libexec/git-core/'):
            helper = name.removeprefix(PREFIX + 'libexec/git-core/')
            if '/' in helper or helper in EXCLUDED_GIT_CORE:
                continue
            if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._+-]*', helper):
                raise ValueError(f'Invalid git-core link basename: {helper!r}')
            path, _ = payload.resolve(name)
            if path == git_path or source_hash(path) == git_hash:
                links[helper] = git_name
            elif helper in ('git-remote-http', 'git-remote-https') and (path == http_path or source_hash(path) == http_hash):
                links[helper] = http_name
            else:
                raise ValueError(f'Unreviewed git-core helper; classify it before updating the runtime: {helper}')
    if links.get('git-remote-http') != http_name or links.get('git-remote-https') != http_name:
        raise ValueError('Git HTTP and HTTPS aliases are required')
    for helper in ('git-upload-pack', 'git-receive-pack', 'git-upload-archive'):
        if links.get(helper) != git_name:
            raise ValueError(f'Required built-in Git alias missing: {helper}')

    queue = deque(units)
    visited = set()
    rename = {}
    while queue:
        name = queue.popleft()
        if name in visited:
            continue
        visited.add(name)
        for needed in elf(units[name][0])['needed']:
            if needed in SYSTEM_LIBRARIES:
                continue
            paths = candidates.get(needed, set())
            if len(paths) != 1:
                raise ValueError(f'Missing/ambiguous shared library: {name} needs {needed}; pin its package')
            path = next(iter(paths))
            source = next(key.removeprefix(PREFIX) for key, entry in payload.entries.items() if entry[0] == 'file' and entry[1] == path)
            mapped = add(native_name(elf(path)['soname'] or needed), source)
            rename[needed] = mapped
            queue.append(mapped)

    libraries = output / abi / 'jniLibs'
    libraries.mkdir(parents=True)
    records = []
    for name, (source, source_name, owner) in sorted(units.items()):
        destination = libraries / name
        copy_file(source, destination, executable=True)
        shell_patched = name in ('libgit.so', 'libgit-remote-http.so')
        if shell_patched:
            patch_shell(destination)
        before = elf(source)
        argv = ['patchelf', '--page-size', '16384', '--remove-rpath']
        for needed in before['needed']:
            if needed in rename and rename[needed] != needed:
                argv += ['--replace-needed', needed, rename[needed]]
        if before['soname'] is not None and before['soname'] != name:
            argv += ['--set-soname', name]
        run(argv + [destination])
        after = validate_elf(destination, abi, set(units))
        if after['needed'] != [rename.get(item, item) for item in before['needed']] or after['versionNeeded'] != [rename.get(item, item) for item in before['versionNeeded']]:
            raise ValueError(f'Dynamic dependency/version rewrite differs from selection: {abi}/{name}')
        if shell_patched and OLD_SHELL in destination.read_bytes():
            raise ValueError(f'Git SHELL_PATH remains after patchelf: {abi}/{name}')
        records.append({'name': name, 'package': owner, 'source': source_name,
                        'sourceSha256': digest(source), 'shellLiteralPatches': int(shell_patched), **after})

    assets = output / abi / 'assets' / 'runtime'
    templates = PREFIX + 'share/git-core/templates/'
    template_count = 0
    for name in sorted(payload.entries):
        if name.startswith(templates):
            source, owner = payload.resolve(name)
            used_packages.add(owner)
            copy_file(source, assets / 'git-templates' / name.removeprefix(templates))
            template_count += 1
    if template_count == 0:
        raise ValueError('Git templates are missing')
    source, owner = payload.resolve(PREFIX + 'etc/tls/cert.pem')
    if b'-----BEGIN CERTIFICATE-----' not in source.read_bytes():
        raise ValueError('CA bundle does not contain PEM certificates')
    used_packages.add(owner)
    copy_file(source, assets / 'certs' / 'cert.pem')
    # Two whitespace-separated columns, sorted by GIT_EXEC_PATH basename.
    # Targets are filenames under ApplicationInfo.nativeLibraryDir, never copies.
    (assets / 'git-core-links.txt').write_text(''.join(f'{name}\t{target}\n' for name, target in sorted(links.items())), encoding='utf-8')
    (assets / 'git-core-links.txt').chmod(0o644)

    licenses = output / abi / 'licenses'
    license_owners = set()
    for package in sorted(used_packages | {'termux-licenses'}):
        doc_prefix = PREFIX + f'share/doc/{package}/'
        copied = 0
        for name in sorted(payload.entries):
            if name.startswith(doc_prefix) and re.match(r'(?:licen[cs]e|copying|copyright)', PurePosixPath(name).name, re.IGNORECASE):
                source, owner = payload.resolve(name)
                license_owners.add(owner)
                copy_file(source, licenses / package / name.removeprefix(doc_prefix))
                copied += 1
        if not copied:
            raise ValueError(f'No packaged license/copyright files: {package}')
    common_licenses = PREFIX + 'share/LICENSES/'
    for name in sorted(payload.entries):
        if name.startswith(common_licenses):
            source, owner = payload.resolve(name)
            if owner in license_owners:
                copy_file(source, licenses / owner / name.removeprefix(common_licenses))
    return records, used_packages | license_owners, len(links)


def inventory(directory, prefix=''):
    return [{'path': prefix + path.relative_to(directory).as_posix(), 'size': path.stat().st_size, 'sha256': digest(path)}
            for path in sorted(directory.rglob('*')) if path.is_file()]


def build(lock, lock_path, cache):
    require_tools('patchelf', 'dpkg-deb')
    try:
        import elftools  # noqa: F401
    except ImportError as error:
        raise ValueError('python3-pyelftools is required (system Python; invoked with python3 -I)') from error
    version = run(['patchelf', '--version'], stdout=subprocess.PIPE, text=True).stdout.strip()
    match = re.search(r'(\d+)\.(\d+)', version)
    if not match or tuple(map(int, match.groups())) < (0, 18):
        raise ValueError(f'patchelf 0.18+ is required for 16 KB packaging; found {version}')
    debs = fetch_debs(lock, cache)
    with tempfile.TemporaryDirectory(prefix='termux-build-', dir=cache) as temporary:
        work = Path(temporary)
        output = work / 'out'
        pinned = {package['name'] for package in lock['termux']['packages']}
        for index, abi in enumerate(ABI_ARCHES):
            payload = Payload(work / abi)
            for name, deb in debs[abi]:
                payload.extract(name, deb)
            records, used, link_count = package_abi(payload, abi, output)
            if used != pinned:
                raise ValueError(f'Lock package set differs from shipped files: unused={sorted(pinned - used)}, unpinned={sorted(used - pinned)}')
            for shared in ('assets', 'licenses'):
                source = output / abi / shared
                destination = output / shared
                if index == 0:
                    shutil.move(source, destination)
                else:
                    if inventory(source) != inventory(destination):
                        raise ValueError(f'{shared} differ between ABIs; cannot publish shared assets/notices')
                    shutil.rmtree(source)
            files = inventory(output / abi / 'jniLibs', f'{abi}/jniLibs/')
            files += inventory(output / 'assets', 'assets/') + inventory(output / 'licenses', 'licenses/')
            manifest = {'schema': 1, 'abi': abi, 'termuxArchitecture': ABI_ARCHES[abi][0],
                        'lockSha256': digest(lock_path), 'patchelfVersion': version,
                        'gitCoreLinkCount': link_count, 'elfs': records,
                        'files': files, 'totalBytes': sum(item['size'] for item in files)}
            write_json(output / abi / 'runtime-files.json', manifest)
            native_bytes = sum(path.stat().st_size for path in (output / abi / 'jniLibs').iterdir())
            print(f'Validated {abi}: {len(records)} ELFs, {native_bytes} native bytes, {link_count} git-core links; architecture/NEEDED/RPATH/LOAD/name checks passed', flush=True)
        destination = ROOT / 'out'
        previous = work / 'previous-out'
        if destination.exists():
            destination.rename(previous)
        try:
            output.rename(destination)
        except BaseException:
            if previous.exists():
                previous.rename(destination)
            raise
        print(f'Published verified Termux runtime: {destination}', flush=True)


def main():
    parser = argparse.ArgumentParser(description='Fetch and validate the pinned Android Termux native payload.')
    parser.add_argument('--update-lock', action='store_true', help='Resolve the pinned package names through an authenticated live repository index.')
    parser.add_argument('--dry-run', action='store_true', help='Verify the complete lock update without rewriting runtime.lock; requires --update-lock.')
    args = parser.parse_args()
    if args.dry_run and not args.update_lock:
        parser.error('--dry-run requires --update-lock')
    lock_path = ROOT.parent / 'runtime.lock'
    cache = ROOT / 'cache'
    cache.mkdir(parents=True, exist_ok=True)
    with (cache / '.fetch-termux.lock').open('a') as guard:
        fcntl.flock(guard, fcntl.LOCK_EX)
        lock = json.loads(lock_path.read_text(encoding='utf-8'))
        validate_lock(lock)
        if args.update_lock:
            update_lock(lock, lock_path, cache, args.dry_run)
        else:
            build(lock, lock_path, cache)


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, subprocess.CalledProcessError, tarfile.TarError) as error:
        print(f'Termux runtime: {error}', file=sys.stderr)
        sys.exit(1)
