#!/usr/bin/env python3
import argparse
import concurrent.futures
import fcntl
import fnmatch
import gzip
import hashlib
import io
import json
import os
import posixpath
import re
import shlex
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile
from pathlib import Path, PurePosixPath
from urllib.parse import quote, unquote, urlsplit


ROOT = Path(__file__).resolve().parent
REPOSITORY = 'https://github.com/termux/termux-packages'
RAW = 'https://raw.githubusercontent.com/termux/termux-packages'
HASH = re.compile(r'[0-9a-f]{64}\Z')
COMMIT = re.compile(r'[0-9a-f]{40}\Z')
PACKAGE = re.compile(r'[a-z0-9][a-z0-9+.-]*\Z')
NODE_VERSION = re.compile(r'(?:v)?([0-9]+\.[0-9]+\.[0-9]+)\Z')
NODE_KEYS_COMMIT = '481637f813e912c4aa3622d7964ab426c97b8e8d'
NODE_KEYRING_URL = f'https://raw.githubusercontent.com/nodejs/release-keys/{NODE_KEYS_COMMIT}/gpg-only-active-keys/pubring.kbx'
NODE_KEYRING_SHA256 = '140f2ad5260fd62773b6243ce8e1d3009645d558f121b8262c55e383dc285932'
NODE_SIGNERS = {
    '5BE8A3F6C8A5C01D106C0AD820B1A390B168D356',
    'DD792F5973C6DE52C432CBDAC77ABFA00DDBF2B7',
    'CC68F5A3106FF448322E48ED27F5E38D5B0A215F',
    '890C08DB8579162FEE0DF9DB8BEAB4DFCF555EF4',
    'C82FA3AE1CBEDC6BE46B9360C43CEC45C17AB93C',
    '108F52B48DB57BB0CC439B2997B01419BD92F80A',
    '655F3B5C1FB3FA8D1A0CA6BDE4A7D232B936D2FD',
    'A363A499291CBBC940DD62E41F10027AF002F8B0',
}
BUILD_SELECTION = (
    {'reason': 'build-framework', 'paths': ['build-all.sh', 'build-package.sh', 'clean.sh', 'repo.json', 'scripts']},
    {'reason': 'license-and-repository-inputs', 'paths': ['LICENSE.md', 'packages/termux-keyring', 'packages/termux-licenses']},
    {'reason': 'ndk-header-patching', 'paths': ['ndk-patches']},
    {'reason': 'toolchain-version-reads', 'paths': ['packages/libllvm/build.sh', 'packages/python/build.sh', 'packages/termux-elf-cleaner/build.sh']},
)
EXACT_GZIP_RECOVERIES = {
    '2213a78b773c1f87bc503fcc2914d1f3474e9aaa2cb7fc92ec5dba4867ab71e0': {
        'url': 'https://codeberg.org/api/v1/repos/dnkl/foot/archive/fd187167ccfef3f4538976c353f5798c247cd0d8.tar.gz?rev=fd187167ccfef3f4538976c353f5798c247cd0d8',
        'sha256': '9d6a6222062111d0b8d7156cfbe4dc0bd74fcb9e8a387b0c81b99cc5087c526d',
        'format': 'gzip', 'level': 6, 'mtime': 0,
    },
}


class SourceError(ValueError):
    def __init__(self, code, **details):
        super().__init__(code)
        self.code = code
        self.details = details


def fail(code, **details):
    raise SourceError(code, **details)


def digest(path):
    with input_path(path).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def input_path(value):
    path = Path(value).absolute()
    if '..' in path.parts:
        fail('unsafe-input', path=path.name)
    for part in (*reversed(path.parents), path):
        try:
            mode = part.lstat().st_mode
        except FileNotFoundError:
            continue
        if stat.S_ISLNK(mode) or part != path and not stat.S_ISDIR(mode):
            fail('unsafe-input', path=path.name)
    return path


def json_bytes(value):
    return (json.dumps(value, sort_keys=True, indent=4, ensure_ascii=True) + '\n').encode('utf-8')


def write_atomic(path, contents):
    path = input_path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as stream:
        temporary = Path(stream.name)
        try:
            stream.write(contents)
            stream.flush()
            os.fsync(stream.fileno())
        except BaseException:
            temporary.unlink(missing_ok=True)
            raise
    try:
        temporary.chmod(0o644)
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)


def load_json(path):
    def unique(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                fail('duplicate-json-key', key=key)
            result[key] = value
        return result

    return json.loads(input_path(path).read_text(encoding='utf-8'), object_pairs_hook=unique)


def https_url(value):
    if not isinstance(value, str) or any(ord(char) <= 32 or ord(char) == 127 for char in value):
        fail('invalid-https-url', url=value)
    parsed = urlsplit(value)
    if parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password or parsed.fragment or '\\' in value:
        fail('invalid-https-url', url=value)
    try:
        parsed.port
    except ValueError:
        fail('invalid-https-url', url=value)
    return value


def safe_path(value):
    if not isinstance(value, str) or not value or '\\' in value or ':' in value or any(ord(char) < 32 or ord(char) == 127 for char in value):
        fail('unsafe-path', path=value)
    path = PurePosixPath(value)
    if path.is_absolute() or any(part in ('', '.', '..') for part in value.split('/')) or str(path) != value:
        fail('unsafe-path', path=value)
    return value


def safe_link(name, target):
    safe_path(name)
    if not isinstance(target, str) or not target or target.startswith('/') or '\\' in target or ':' in target or any(ord(char) < 32 for char in target):
        fail('unsafe-link', path=name, target=target)
    resolved = posixpath.normpath(posixpath.join(posixpath.dirname(name), target))
    safe_path(resolved)
    return resolved


def check_links(kinds, targets):
    directories = {str(parent) for name in kinds for parent in PurePosixPath(name).parents}
    for name, (kind, target) in targets.items():
        parts = ([] if kind == 'hardlink' else name.split('/')[:-1]) + target.split('/')
        stack = []
        hops = 0
        while parts:
            part = parts.pop(0)
            if part in ('', '.'):
                continue
            if part == '..':
                if not stack:
                    fail('unsafe-link', path=name, target=target)
                stack.pop()
                continue
            stack.append(part)
            current = '/'.join(stack)
            if current in targets:
                hops += 1
                if hops > 40:
                    fail('archive-link-cycle', path=name)
                link_kind, link_target = targets[current]
                if link_kind == 'hardlink':
                    if parts:
                        fail('archive-link-parent', path=name)
                    stack = []
                else:
                    stack.pop()
                parts = link_target.split('/') + parts
            elif parts and current in kinds and kinds[current] != 'directory':
                fail('archive-link-parent', path=name)
        resolved = '/'.join(stack) or '.'
        if resolved not in kinds and resolved not in directories:
            fail('archive-link-missing', path=name, target=resolved)


def run(arguments, **kwargs):
    return subprocess.run([str(item) for item in arguments], check=True, **kwargs)


def require_tools(*names):
    for name in names:
        if not shutil.which(name):
            fail('missing-tool', tool=name)


class Cache:
    def __init__(self, directory, offline=False):
        self.directory = input_path(directory)
        self.offline = offline
        self.directory.mkdir(parents=True, exist_ok=True)

    def get(self, url, sha256):
        https_url(url)
        if not isinstance(sha256, str) or not HASH.fullmatch(sha256):
            fail('invalid-sha256', url=url)
        destination = self.directory / sha256
        if destination.is_symlink():
            fail('unsafe-cache-object', sha256=sha256)
        if destination.exists():
            if not destination.is_file() or digest(destination) != sha256:
                fail('sha256-mismatch', url=url, sha256=sha256)
            return destination
        if self.offline:
            fail('offline-cache-miss', url=url, sha256=sha256)
        require_tools('curl')
        with tempfile.NamedTemporaryFile(dir=self.directory, suffix='.part', delete=False) as stream:
            temporary = Path(stream.name)
        try:
            run(['curl', '-q', '--fail', '--location', '--silent', '--show-error',
                 '--proto', '=https', '--proto-redir', '=https', '--tlsv1.2',
                 '--retry', '3', '--connect-timeout', '30', '--max-time', '600',
                 '--output', temporary, url], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            if digest(temporary) != sha256:
                fail('sha256-mismatch', url=url, sha256=sha256)
            temporary.chmod(0o644)
            temporary.replace(destination)
        finally:
            temporary.unlink(missing_ok=True)
        return destination

    def store(self, contents):
        sha256 = hashlib.sha256(contents).hexdigest()
        path = self.directory / sha256
        if path.is_symlink() or (path.exists() and digest(path) != sha256):
            fail('sha256-mismatch', sha256=sha256)
        if not path.exists():
            write_atomic(path, contents)
        return sha256

    def fetch_all(self, pins):
        unique = {}
        for pin in pins:
            unique.setdefault(pin['sha256'], pin)
        with concurrent.futures.ThreadPoolExecutor(max_workers=12) as executor:
            pending = [executor.submit(self.get_pin, pin) for _, pin in sorted(unique.items())]
            for result in pending:
                result.result()

    def get_pin(self, pin):
        destination = self.directory / pin['sha256']
        recovery = pin.get('recovery')
        if recovery is None or destination.exists() or destination.is_symlink() or self.offline:
            return self.get(pin['url'], pin['sha256'])
        if recovery != EXACT_GZIP_RECOVERIES.get(pin['sha256']):
            fail('unsupported-source-recovery')
        # The archived output must match the original recipe hash, not merely
        # uncompressed contents. The changed transport bytes are pinned too.
        transport = self.get(recovery['url'], recovery['sha256'])
        with tempfile.NamedTemporaryFile(dir=self.directory, suffix='.part', delete=False) as stream:
            temporary = Path(stream.name)
            try:
                recovered = gzip.compress(gzip.decompress(transport.read_bytes()),
                                          compresslevel=recovery['level'], mtime=recovery['mtime'])
                stream.write(recovered)
                stream.flush()
                os.fsync(stream.fileno())
            except BaseException:
                temporary.unlink(missing_ok=True)
                raise
        try:
            # Python's streaming gzip header uses OS=255; this reviewed historical
            # archive uses OS=3. Header flags/mtime and output integrity stay fixed.
            with temporary.open('r+b') as stream:
                header = stream.read(10)
                if header[:9] != b'\x1f\x8b\x08\x00\x00\x00\x00\x00\x00':
                    fail('source-recovery-header')
                stream.seek(9)
                stream.write(b'\x03')
            if digest(temporary) != pin['sha256']:
                fail('source-recovery-sha256', sha256=pin['sha256'])
            temporary.chmod(0o644)
            temporary.replace(destination)
        finally:
            temporary.unlink(missing_ok=True)
        return self.get(pin['url'], pin['sha256'])


def validate_runtime(runtime):
    if not isinstance(runtime, dict) or type(runtime.get('schema')) is not int or runtime['schema'] != 1:
        fail('runtime-schema')
    termux = runtime.get('termux')
    if not isinstance(termux, dict) or not isinstance(termux.get('packages'), list) or not termux['packages']:
        fail('runtime-packages')
    packages = {}
    for item in termux['packages']:
        if not isinstance(item, dict) or not isinstance(item.get('name'), str) or not PACKAGE.fullmatch(item['name']):
            fail('runtime-package-name')
        if item['name'] in packages or not isinstance(item.get('version'), str) or not item['version'].strip():
            fail('runtime-package-version', package=item['name'])
        packages[item['name']] = item['version']
    for key in ('node', 'npm', 'bun'):
        if key not in runtime or (runtime[key] is not None and not isinstance(runtime[key], dict)):
            fail('runtime-section', section=key)
        if key in ('node', 'npm') and runtime[key] is not None and not isinstance(runtime[key].get('version'), str):
            fail('runtime-section-version', section=key)
    if runtime['bun'] is not None:
        fail('unsupported-runtime', section='bun')
    return packages


def validate_pin(pin):
    if not isinstance(pin, dict) or not isinstance(pin.get('sha256'), str) or not HASH.fullmatch(pin['sha256']):
        fail('invalid-pin')
    https_url(pin.get('url'))


def validate_files(files, commit, prefix=None):
    if not isinstance(files, list) or not files:
        fail('missing-files', commit=commit)
    names = set()
    for item in files:
        validate_pin(item)
        path = safe_path(item.get('path'))
        if path in names or (prefix and not path.startswith(prefix + '/')):
            fail('duplicate-or-outside-file', path=path)
        names.add(path)
        if item['url'] != raw_url(commit, path):
            fail('file-origin-mismatch', path=path)
        if 'gitBlob' in item and not COMMIT.fullmatch(str(item['gitBlob'])):
            fail('file-git-blob', path=path)
        if item.get('type', 'file') not in ('file', 'symlink') or type(item.get('mode')) is not int:
            fail('invalid-file-type', path=path)
        if item.get('type', 'file') == 'symlink':
            safe_link(path, item.get('target'))
            if item['mode'] != 0o777 or hashlib.sha256(item['target'].encode()).hexdigest() != item['sha256']:
                fail('invalid-symlink', path=path)
        elif item['mode'] not in (0o644, 0o755):
            fail('invalid-file-mode', path=path)
    if [item['path'] for item in files] != sorted(names):
        fail('unsorted-files', commit=commit)
    return names


def snapshot_paths(system):
    selection = system.get('selection')
    if not isinstance(selection, list) or not selection:
        fail('snapshot-selection')
    paths, reasons = set(), []
    for rule in selection:
        if (not isinstance(rule, dict) or set(rule) != {'reason', 'paths'}
                or not isinstance(rule['reason'], str) or not re.fullmatch(r'[a-z0-9][a-z0-9-]*', rule['reason'])):
            fail('snapshot-selection')
        reasons.append(rule['reason'])
        if not isinstance(rule['paths'], list) or not rule['paths']:
            fail('snapshot-selection-paths')
        selected = [safe_path(path) for path in rule['paths']]
        if (selected != sorted(set(selected)) or paths.intersection(selected)
                or any(any(char in path for char in '*?[]') for path in selected)):
            fail('snapshot-selection-paths')
        paths.update(selected)
    if reasons != sorted(set(reasons)):
        fail('snapshot-selection-order')
    if 'scripts' not in paths or not {'build-package.sh', 'repo.json'}.issubset(paths):
        fail('incomplete-build-system', commit=system.get('commit'))
    return sorted(paths)


def selected_path(path, selectors):
    return any(path == selector or path.startswith(selector + '/') for selector in selectors)


def snapshot_listing(files):
    # Canonical listing v1; buildSystems[].sha256 is the SHA256 of these bytes.
    # One row per file, sorted by UTF-8 path bytes; every row, the last too, is
    # json.dumps([path, mode, gitBlob, sha256, size], ensure_ascii=True,
    # separators=(',', ':')) + '\n'. mode is 420, 493 or 511 (0644, 0755, 0777
    # symlink); gitBlob (Git SHA-1) and sha256 are lowercase hex of the file
    # bytes, size is their length, and a symlink's bytes are its UTF-8 target.
    if not isinstance(files, list) or any(not isinstance(item, dict) for item in files):
        fail('snapshot-files')
    rows, names = [], set()
    for item in sorted(files, key=lambda item: safe_path(item.get('path')).encode('utf-8')):
        path = safe_path(item.get('path'))
        if path in names:
            fail('snapshot-duplicate-path', path=path)
        names.add(path)
        if type(item.get('mode')) is not int or item['mode'] not in (0o644, 0o755, 0o777):
            fail('snapshot-mode', path=path)
        if (not isinstance(item.get('gitBlob'), str) or not COMMIT.fullmatch(item['gitBlob'])
                or not isinstance(item.get('sha256'), str) or not HASH.fullmatch(item['sha256'])):
            fail('snapshot-file-integrity', path=path)
        if type(item.get('size')) is not int or item['size'] < 0:
            fail('snapshot-file-size', path=path)
        rows.append(json.dumps([path, item['mode'], item['gitBlob'], item['sha256'], item['size']],
                               ensure_ascii=True, separators=(',', ':')) + '\n')
    return ''.join(rows).encode('ascii')


def snapshot_summary(files):
    listing = snapshot_listing(files)
    return {'sha256': hashlib.sha256(listing).hexdigest(), 'fileCount': len(files),
            'totalBytes': sum(item['size'] for item in files)}


def validate_snapshot(system):
    if not isinstance(system, dict) or set(system) != {'commit', 'selection', 'sha256', 'fileCount', 'totalBytes'}:
        fail('snapshot-schema')
    if (not isinstance(system['commit'], str) or not COMMIT.fullmatch(system['commit'])
            or not isinstance(system['sha256'], str) or not HASH.fullmatch(system['sha256'])):
        fail('snapshot-integrity')
    if type(system['fileCount']) is not int or system['fileCount'] <= 0:
        fail('snapshot-file-count')
    if type(system['totalBytes']) is not int or system['totalBytes'] < 0:
        fail('snapshot-total-bytes')
    return snapshot_paths(system)


def snapshot_index_path(system, cache):
    return cache.directory.parent / 'snapshots' / (system['sha256'] + '.jsonl')


def check_snapshot(system, files, cache):
    selectors = validate_snapshot(system)
    if snapshot_summary(files) != {key: system[key] for key in ('sha256', 'fileCount', 'totalBytes')}:
        fail('snapshot-mismatch', commit=system['commit'])
    names = validate_files(files, system['commit'])
    if (not {'build-package.sh', 'repo.json', 'scripts/properties.sh'}.issubset(names)
            or any(not selected_path(name, selectors) for name in names)
            or any(not any(name == selector or name.startswith(selector + '/') for name in names) for selector in selectors)):
        fail('snapshot-selection-mismatch', commit=system['commit'])
    cache.fetch_all(files)
    for item in files:
        contents = cache.get(item['url'], item['sha256']).read_bytes()
        if len(contents) != item['size'] or hashlib.sha1(f'blob {len(contents)}\0'.encode() + contents).hexdigest() != item['gitBlob']:
            fail('snapshot-file-mismatch', path=item['path'])
        if item['mode'] == 0o777:
            target = contents.decode('utf-8')
            safe_link(item['path'], target)
            if item.get('type') != 'symlink' or item.get('target') != target:
                fail('snapshot-file-mismatch', path=item['path'])
        elif item.get('type', 'file') != 'file':
            fail('snapshot-file-mismatch', path=item['path'])
    return files


def build_system_files(system, cache, repository=None):
    selectors = validate_snapshot(system)
    index = snapshot_index_path(system, cache)
    try:
        input_path(index)
    except SourceError:
        fail('unsafe-snapshot-index')
    try:
        metadata = index.lstat()
    except FileNotFoundError:
        metadata = None
    if metadata is not None and not stat.S_ISREG(metadata.st_mode):
        fail('unsafe-snapshot-index')
    descriptor = None
    if metadata is not None:
        try:
            descriptor = os.open(index, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        except OSError:
            fail('unsafe-snapshot-index')
    if descriptor is not None:
        try:
            if not stat.S_ISREG(os.fstat(descriptor).st_mode):
                fail('unsafe-snapshot-index')
            with os.fdopen(descriptor, 'rb') as stream:
                descriptor = None
                contents = stream.read()
        finally:
            if descriptor is not None:
                os.close(descriptor)
        if hashlib.sha256(contents).hexdigest() != system['sha256']:
            fail('snapshot-mismatch', commit=system['commit'])
        files = []
        for line in contents.splitlines():
            row = json.loads(line)
            if not isinstance(row, list) or len(row) != 5:
                fail('snapshot-index-row')
            path, mode, blob, sha256, size = row
            pin = {'path': path, 'mode': mode, 'gitBlob': blob, 'sha256': sha256, 'size': size,
                   'url': raw_url(system['commit'], path), 'type': 'symlink' if mode == 0o777 else 'file'}
            files.append(pin)
        if snapshot_listing(files) != contents:
            fail('snapshot-index-canonical')
        # Authenticate the entire index before any URL/content derived from it is used.
        if snapshot_summary(files) != {key: system[key] for key in ('sha256', 'fileCount', 'totalBytes')}:
            fail('snapshot-mismatch', commit=system['commit'])
        cache.fetch_all(files)
        for pin in files:
            if pin['type'] == 'symlink':
                pin['target'] = cache.get(pin['url'], pin['sha256']).read_text(encoding='utf-8')
        return check_snapshot(system, files, cache)
    if cache.offline:
        fail('offline-snapshot-miss', sha256=system['sha256'])
    if repository is None:
        existing = cache.directory.parent / 'termux-history'
        repository, _ = history_repository(cache.directory.parent, existing=existing if existing.exists() else None)
    files = pin_tree(repository, system['commit'], selectors, cache, include_size=True)
    check_snapshot(system, files, cache)
    write_atomic(index, snapshot_listing(files))
    return files


def validate_sources(lock, runtime, runtime_sha256):
    packages = validate_runtime(runtime)
    if not isinstance(lock, dict) or type(lock.get('schema')) is not int or lock['schema'] != 1:
        fail('sources-schema')
    if lock.get('runtimeLockSha256') != runtime_sha256:
        fail('runtime-lock-sha256')
    termux = lock.get('termux')
    if not isinstance(termux, dict) or termux.get('repository') != REPOSITORY or not COMMIT.fullmatch(str(termux.get('historyTip', ''))):
        fail('sources-repository')
    listed = termux.get('packages')
    if not isinstance(listed, list) or len(listed) != len(packages):
        fail('package-set-mismatch')
    names = set()
    commits = set()
    for item in listed:
        if not isinstance(item, dict) or item.get('name') not in packages or item['name'] in names:
            fail('package-set-mismatch')
        name = item['name']
        names.add(name)
        if item.get('version') != packages[name]:
            fail('package-version-mismatch', package=name)
        commit = item.get('commit', '')
        if not COMMIT.fullmatch(str(commit)):
            fail('invalid-commit', package=name)
        commits.add(commit)
        recipe = safe_path(item.get('recipePath'))
        if not recipe.startswith('packages/') or len(recipe.split('/')) != 2:
            fail('invalid-recipe-path', package=name)
        paths = validate_files(item.get('files'), commit, recipe)
        if recipe + '/build.sh' not in paths:
            fail('missing-recipe', package=name)
        evidence = item.get('evidence')
        if not isinstance(evidence, dict) or evidence.get('selected') != commit or evidence.get('last') != commit:
            fail('missing-range-evidence', package=name)
        for key in ('first', 'last', 'historyTip'):
            if not COMMIT.fullmatch(str(evidence.get(key, ''))):
                fail('invalid-range-evidence', package=name, field=key)
        if evidence['historyTip'] != termux['historyTip'] or evidence.get('method') != 'first-parent-package-history':
            fail('invalid-range-evidence', package=name)
        for key in ('before', 'after'):
            if evidence.get(key) is not None and not COMMIT.fullmatch(str(evidence[key])):
                fail('invalid-range-evidence', package=name, field=key)
        if not isinstance(item.get('sources'), list):
            fail('missing-upstream-sources', package=name)
        if item.get('sourceStatus') not in ('upstream-tarballs', 'in-recipe-directory'):
            fail('invalid-source-status', package=name)
        filenames = set()
        for source in item['sources']:
            validate_pin(source)
            if 'recovery' in source and source['recovery'] != EXACT_GZIP_RECOVERIES.get(source['sha256']):
                fail('unsupported-source-recovery')
            filename = safe_path(source.get('filename'))
            if '/' in filename or filename in filenames:
                fail('duplicate-source-filename', package=name, filename=filename)
            filenames.add(filename)
        if not item['sources'] and item.get('sourceStatus') != 'in-recipe-directory':
            fail('missing-upstream-sources', package=name)
    if [item['name'] for item in listed] != sorted(names):
        fail('unsorted-packages')
    systems = termux.get('buildSystems')
    if not isinstance(systems, list) or len(systems) != len(commits):
        fail('build-system-set-mismatch')
    seen = set()
    for system in systems:
        if not isinstance(system, dict) or system.get('commit') not in commits or system['commit'] in seen:
            fail('build-system-set-mismatch')
        seen.add(system['commit'])
        validate_snapshot(system)
    if [item['commit'] for item in systems] != sorted(seen):
        fail('unsorted-build-systems')
    files_by_commit = {}
    for item in listed:
        for pin in item['files']:
            key = (item['commit'], pin['path'])
            if key in files_by_commit and files_by_commit[key] != pin:
                fail('conflicting-recipe-file', path=pin['path'])
            files_by_commit[key] = pin
    for item in listed:
        for source in item['sources']:
            if 'evidence' not in source:
                continue
            evidence = source['evidence']
            if not isinstance(evidence, dict) or evidence.get('commit') != item['commit']:
                fail('source-evidence')
            path = safe_path(evidence.get('path'))
            pin = files_by_commit.get((item['commit'], path))
            system = next(system for system in systems if system['commit'] == item['commit'])
            if (not HASH.fullmatch(str(evidence.get('fileSha256', '')))
                    or pin is not None and pin['sha256'] != evidence['fileSha256']
                    or pin is None and not selected_path(path, snapshot_paths(system))):
                fail('source-evidence', path=path)
            if not isinstance(evidence.get('lines'), list) or not evidence['lines'] or any(type(line) is not int or line <= 0 for line in evidence['lines']):
                fail('source-evidence-lines', path=path)
            expected_evidence_url = f'{REPOSITORY}/blob/{item["commit"]}/{quote(path, safe="/+._~-")}#L{min(evidence["lines"])}'
            if evidence.get('url') != expected_evidence_url:
                fail('source-evidence-url', path=path)
    for key in ('node', 'npm'):
        if key not in lock:
            fail('missing-runtime-section', section=key)
        section = lock.get(key)
        if runtime[key] is None:
            if section is not None:
                fail('runtime-section-mismatch', section=key)
        elif not isinstance(section, dict) or section.get('version') != runtime[key].get('version', '').removeprefix('v'):
            fail('runtime-section-mismatch', section=key)
    if lock.get('node') is not None:
        node = lock['node']
        version = node.get('version')
        if not isinstance(version, str) or not NODE_VERSION.fullmatch(version):
            fail('node-version')
        base = f'https://nodejs.org/dist/v{version}/'
        expected = {'source': f'node-v{version}.tar.xz', 'shasums': 'SHASUMS256.txt', 'signature': 'SHASUMS256.txt.sig'}
        for key, filename in expected.items():
            validate_pin(node.get(key))
            if node[key].get('filename') != filename or node[key]['url'] != base + filename:
                fail('node-official-origin', field=key)
        if node.get('keyring') != {'url': NODE_KEYRING_URL, 'sha256': NODE_KEYRING_SHA256, 'filename': 'node-release-keys.kbx'}:
            fail('node-keyring-pin')
        if not isinstance(node.get('patches'), list):
            fail('node-patch-list')
        seen = set()
        for patch in node['patches']:
            path = safe_path(patch.get('path'))
            if path in seen or not path.startswith('android/runtime/patches/node/') or not HASH.fullmatch(str(patch.get('sha256', ''))):
                fail('node-patch-pin', path=path)
            seen.add(path)
        if [item['path'] for item in node['patches']] != sorted(seen):
            fail('unsorted-node-patches')
    if lock.get('npm') is not None and (lock.get('node') is None or lock['npm'].get('source') != 'node'):
        fail('npm-source-mismatch')


def raw_url(commit, path):
    return f'{RAW}/{commit}/{quote(safe_path(path), safe="/+._~-")}'


def source_filename(url):
    name = unquote(PurePosixPath(urlsplit(https_url(url)).path).name)
    safe_path(name)
    if '/' in name:
        fail('source-filename', url=url)
    return name


def unique_source_filenames(pins):
    counts = {}
    for pin in pins:
        counts[pin['filename']] = counts.get(pin['filename'], 0) + 1
    return [{**pin, 'filename': pin['sha256'][:12] + '-' + pin['filename']} if counts[pin['filename']] > 1 else pin for pin in pins]


def inspect_tar(path):
    entries = {}
    targets = {}
    with tarfile.open(path, mode='r:*') as archive:
        for member in archive:
            name = member.name
            while name.startswith('./'):
                name = name[2:]
            if member.isdir():
                name = name.rstrip('/')
                if name in ('', '.'):
                    continue
            safe_path(name)
            if name in entries:
                fail('duplicate-tar-member', path=name)
            if member.issym():
                safe_link(name, member.linkname)
                targets[name] = ('symlink', member.linkname)
                kind = 'symlink'
            elif member.islnk():
                target = member.linkname.removeprefix('./')
                safe_path(target)
                targets[name] = ('hardlink', target)
                kind = 'hardlink'
            elif member.isfile():
                kind = 'file'
            elif member.isdir():
                kind = 'directory'
            else:
                fail('unsupported-tar-member', path=name)
            entries[name] = kind
        check_tar_padding(archive.fileobj, archive.offset)
    for name in entries:
        for parent in PurePosixPath(name).parents:
            if str(parent) in entries and entries[str(parent)] != 'directory':
                fail('tar-member-parent', path=name)
    check_links(entries, targets)
    return entries


def check_tar_padding(stream, offset):
    stream.seek(offset)
    padding = 0
    for block in iter(lambda: stream.read(1024 * 1024), b''):
        if block.strip(b'\0'):
            fail('archive-trailing-data')
        padding += len(block)
    if padding < 1024 or padding % 512:
        fail('archive-terminator')


class Members:
    def __init__(self):
        self.files = {}

    def add(self, name, path=None, contents=None, mode=0o644, url=None, commit=None, target=None):
        safe_path(name)
        if name == 'MANIFEST.json' or name in self.files:
            fail('duplicate-archive-member', path=name)
        if target is not None:
            safe_link(name, target)
            contents = target.encode('utf-8')
            mode = 0o777
        if path is not None:
            path = input_path(path)
            if path.is_symlink() or not path.is_file():
                fail('unsafe-input', path=name)
            sha256, size = digest(path), path.stat().st_size
        else:
            if not isinstance(contents, bytes):
                fail('missing-member-content', path=name)
            sha256, size = hashlib.sha256(contents).hexdigest(), len(contents)
        if mode not in (0o644, 0o755, 0o777) or (target is None and mode == 0o777):
            fail('invalid-file-mode', path=name)
        record = {'path': name, 'sha256': sha256, 'size': size, 'mode': mode,
                  'type': 'symlink' if target is not None else 'file',
                  'origin': {'url': url, 'commit': commit}}
        if target is not None:
            record['target'] = target
        self.files[name] = (record, path, contents)

    def check(self):
        for name, (record, _, _) in self.files.items():
            for parent in PurePosixPath(name).parents:
                if str(parent) in self.files:
                    fail('archive-member-parent', path=name)
            if record['type'] == 'symlink':
                safe_link(name, record['target'])
        check_links({name: entry[0]['type'] for name, entry in self.files.items()},
                    {name: ('symlink', entry[0]['target']) for name, entry in self.files.items() if entry[0]['type'] == 'symlink'})

    def write(self, destination, manifest, work):
        self.check()
        manifest['members'] = [self.files[name][0] for name in sorted(self.files)]
        manifest['manifestSelfExcluded'] = True
        manifest_data = json_bytes(manifest)
        tar_path = Path(work) / 'sources.tar'
        with tarfile.open(tar_path, mode='w', format=tarfile.PAX_FORMAT, encoding='utf-8') as archive:
            for name in sorted(['MANIFEST.json', *self.files]):
                info = tarfile.TarInfo(name)
                info.uid = info.gid = info.mtime = 0
                info.uname = info.gname = ''
                if name == 'MANIFEST.json':
                    info.mode = 0o644
                    info.size = len(manifest_data)
                    archive.addfile(info, io.BytesIO(manifest_data))
                    continue
                record, path, contents = self.files[name]
                info.mode = record['mode']
                if record['type'] == 'symlink':
                    info.type = tarfile.SYMTYPE
                    info.linkname = record['target']
                    archive.addfile(info)
                else:
                    info.size = record['size']
                    with path.open('rb') if path is not None else io.BytesIO(contents) as stream:
                        before = stream.tell()
                        archive.addfile(info, stream)
                        if stream.tell() - before != info.size:
                            fail('archive-input-size', path=name)
        require_tools('zstd')
        packed = Path(work) / 'sources.tar.zst'
        with packed.open('wb') as stream:
            run(['zstd', '--single-thread', '-19', '--no-dictID', '--check', '--quiet', '--stdout', tar_path], stdout=stream, stderr=subprocess.PIPE)
        verify_archive(packed, work)
        destination = input_path(destination)
        destination.parent.mkdir(parents=True, exist_ok=True)
        with packed.open('rb') as source, tempfile.NamedTemporaryFile(dir=destination.parent, delete=False) as output:
            temporary = Path(output.name)
            try:
                shutil.copyfileobj(source, output)
                output.flush()
                os.fsync(output.fileno())
            except BaseException:
                temporary.unlink(missing_ok=True)
                raise
        try:
            temporary.chmod(0o644)
            temporary.replace(destination)
        finally:
            temporary.unlink(missing_ok=True)
        return {'archive': destination.name, 'sha256': digest(destination), 'size': destination.stat().st_size, 'members': len(self.files) + 1}


def verify_archive(path, work=None):
    require_tools('zstd')
    # A build unpacks beside its own temporary files (under --cache); --verify uses the system temporary directory.
    # Neither needs a writable checkout.
    with tempfile.TemporaryDirectory(prefix='sources-verify-', dir=work) as temporary:
        unpacked = Path(temporary) / 'sources.tar'
        with unpacked.open('wb') as output:
            result = subprocess.run(['zstd', '--decompress', '--quiet', '--stdout', str(path)],
                                    stdout=output, stderr=subprocess.PIPE)
            if result.returncode != 0:
                fail('zstd-verification', status=result.returncode)
        return verify_tar(unpacked)


def verify_tar(path):
    observed = {}
    manifest = None
    previous = ''
    with Path(path).open('rb') as raw:
        with tarfile.open(fileobj=raw, mode='r:') as archive:
            for member in archive:
                safe_path(member.name)
                if member.name <= previous:
                    fail('unsorted-or-duplicate-archive', path=member.name)
                previous = member.name
                if member.uid != 0 or member.gid != 0 or member.mtime != 0 or member.uname or member.gname:
                    fail('archive-metadata', path=member.name)
                if member.issym():
                    safe_link(member.name, member.linkname)
                    data = member.linkname.encode('utf-8')
                    sha256, size = hashlib.sha256(data).hexdigest(), len(data)
                    kind = 'symlink'
                    if member.mode != 0o777:
                        fail('archive-mode', path=member.name)
                elif member.isfile():
                    if member.mode not in (0o644, 0o755):
                        fail('archive-mode', path=member.name)
                    with archive.extractfile(member) as stream:
                        if member.name == 'MANIFEST.json':
                            if member.size > 32 * 1024 * 1024:
                                fail('manifest-size')
                            manifest = json.loads(stream.read())
                            continue
                        sha256 = hashlib.file_digest(stream, 'sha256').hexdigest()
                    size, kind = member.size, 'file'
                else:
                    fail('archive-member-type', path=member.name)
                observed[member.name] = {'sha256': sha256, 'size': size, 'mode': member.mode, 'type': kind}
                if kind == 'symlink':
                    observed[member.name]['target'] = member.linkname
            end = archive.offset
        # Seekable verification includes read-ahead bytes and the consumed EOF
        # record; tar readers disagree about data hidden behind zero records.
        check_tar_padding(raw, end)
    if not isinstance(manifest, dict) or manifest.get('schema') != 1 or manifest.get('manifestSelfExcluded') is not True:
        fail('manifest-schema')
    records = manifest.get('members')
    if not isinstance(records, list) or len(records) != len(observed):
        fail('manifest-members')
    seen = []
    links = Members()
    for record in records:
        if not isinstance(record, dict):
            fail('manifest-member')
        name = safe_path(record.get('path'))
        if name in seen or name not in observed:
            fail('manifest-member', path=name)
        seen.append(name)
        if any(record.get(key) != value for key, value in observed[name].items()):
            fail('manifest-digest', path=name)
        origin = record.get('origin')
        if not isinstance(origin, dict) or set(origin) != {'url', 'commit'}:
            fail('manifest-origin', path=name)
        if origin['url'] is not None:
            https_url(origin['url'])
        if origin['commit'] is not None and not COMMIT.fullmatch(str(origin['commit'])):
            fail('manifest-origin', path=name)
        links.files[name] = (record, None, None)
    if seen != sorted(observed):
        fail('manifest-order')
    links.check()
    if not HASH.fullmatch(str(manifest.get('runtimeLockSha256', ''))):
        fail('manifest-runtime-hash')
    return manifest


def node_patch_pins():
    directory = ROOT / 'patches' / 'node'
    if directory.is_symlink():
        fail('node-patches-directory')
    if not directory.exists():
        return []
    if directory.is_symlink() or not directory.is_dir():
        fail('node-patches-directory')
    result = []
    for path in sorted(directory.rglob('*')):
        if path.is_symlink():
            fail('node-patch-symlink', path=path.name)
        if path.is_file():
            result.append({'path': 'android/runtime/patches/node/' + path.relative_to(directory).as_posix(), 'sha256': digest(path)})
        elif not path.is_dir():
            fail('node-patch-type', path=path.name)
    # Paths sort by component; the lock requires plain string order of 'path'.
    return sorted(result, key=lambda item: item['path'])


def verify_node_signature(cache, node, work):
    require_tools('gpgv')
    paths = {key: cache.get(node[key]['url'], node[key]['sha256']) for key in ('source', 'shasums', 'signature', 'keyring')}
    home = Path(work) / 'gnupg'
    home.mkdir(mode=0o700, exist_ok=True)
    result = run(['gpgv', '--homedir', home, '--keyring', paths['keyring'], '--status-fd', '1',
                  paths['signature'], paths['shasums']], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    status = [line.split()[1:] for line in result.stdout.splitlines() if line.startswith('[GNUPG:] ')]
    valid = [line for line in status if line[0] == 'VALIDSIG']
    if not valid or any(len(line) < 11 or line[-1] not in NODE_SIGNERS or line[8] not in ('8', '9', '10') for line in valid):
        fail('node-signature-signer')
    if any(line[0] in ('BADSIG', 'ERRSIG', 'EXPKEYSIG', 'EXPSIG', 'REVKEYSIG', 'KEYREVOKED') for line in status):
        fail('node-signature-status')
    shasums = {}
    for line in paths['shasums'].read_text(encoding='ascii').splitlines():
        match = re.fullmatch(r'([0-9a-f]{64})\s{2}([^\s]+)', line)
        if not match or match[2] in shasums:
            fail('node-shasums-format')
        shasums[match[2]] = match[1]
    if shasums.get(node['source']['filename']) != node['source']['sha256']:
        fail('node-source-shasums')
    return paths, sorted({line[-1] for line in valid})


def node_npm_version(path, node_version):
    name = f'node-v{node_version}/deps/npm/package.json'
    with tarfile.open(path, mode='r:xz') as archive:
        try:
            member = archive.getmember(name)
        except KeyError:
            fail('node-npm-missing')
        if not member.isfile() or member.size > 1024 * 1024:
            fail('node-npm-metadata')
        with archive.extractfile(member) as stream:
            metadata = json.load(stream)
        if metadata.get('name') != 'npm' or not isinstance(metadata.get('version'), str):
            fail('node-npm-metadata')
        return metadata['version']


def build(lock, runtime, runtime_path, sources_path, cache, destination, require_node=False):
    runtime_data = Path(runtime_path).read_bytes()
    sources_data = Path(sources_path).read_bytes()
    if json.loads(runtime_data) != runtime or json.loads(sources_data) != lock:
        fail('lock-changed-during-read')
    runtime_sha256 = hashlib.sha256(runtime_data).hexdigest()
    sources_sha256 = hashlib.sha256(sources_data).hexdigest()
    validate_sources(lock, runtime, runtime_sha256)
    if require_node and (lock.get('node') is None or lock.get('npm') is None):
        fail('node-and-npm-required')
    pins = []
    recipe_files = {}
    for item in lock['termux']['packages']:
        for pin in item['files']:
            key = (item['commit'], pin['path'])
            if key in recipe_files and recipe_files[key] != pin:
                fail('conflicting-recipe-file', path=pin['path'])
            recipe_files[key] = pin
    for package in lock['termux']['packages']:
        pins += package['files'] + package['sources']
    if lock.get('node') is not None:
        pins += [lock['node'][key] for key in ('source', 'shasums', 'signature', 'keyring')]
    cache.fetch_all(pins)
    for system in lock['termux']['buildSystems']:
        for pin in build_system_files(system, cache):
            key = (system['commit'], pin['path'])
            if key in recipe_files:
                if ({name: value for name, value in pin.items() if name != 'size'}
                        != {name: value for name, value in recipe_files[key].items() if name != 'size'}):
                    fail('conflicting-recipe-file', path=pin['path'])
            else:
                recipe_files[key] = pin
    for package in lock['termux']['packages']:
        for source in package['sources']:
            evidence = source.get('evidence')
            if evidence is not None:
                pin = recipe_files.get((package['commit'], evidence['path']))
                if pin is None or pin['sha256'] != evidence['fileSha256']:
                    fail('source-evidence', path=evidence['path'])
                lines = cache.get(pin['url'], pin['sha256']).read_text(encoding='utf-8').splitlines()
                actual = [index for index, line in enumerate(lines, 1) if source['sha256'] in line]
                if evidence['lines'] != actual:
                    fail('source-evidence-lines', path=evidence['path'])
        recipe = next(item for item in package['files'] if item['path'] == package['recipePath'] + '/build.sh')
        text = cache.get(recipe['url'], recipe['sha256']).read_text(encoding='utf-8')
        if recipe_version(text) != package['version']:
            fail('recipe-version-mismatch', package=package['name'])
        def read_recipe(path):
            pin = recipe_files.get((package['commit'], path))
            if pin is None:
                fail('missing-recipe-import', path=path)
            return cache.get(pin['url'], pin['sha256']).read_text(encoding='utf-8')

        upstream, _ = recipe_sources(text, read_recipe)
        if upstream != [{key: value for key, value in item.items() if key in ('url', 'sha256', 'filename', 'recipeUrl')} for item in package['sources']]:
            fail('recipe-sources-mismatch', package=package['name'])
    with tempfile.TemporaryDirectory(prefix='sources-build-', dir=cache.directory.parent) as temporary:
        work = Path(temporary)
        members = Members()
        for (commit, path), item in sorted(recipe_files.items()):
            cached = cache.get(item['url'], item['sha256'])
            members.add(f'termux/{commit}/{path}', path=None if item.get('type') == 'symlink' else cached,
                        mode=item['mode'], url=item['url'], commit=commit, target=item.get('target'))
        for package in lock['termux']['packages']:
            for source in package['sources']:
                path = cache.get_pin(source)
                if tarfile.is_tarfile(path):
                    inspect_tar(path)
                members.add(f'upstream/{package["name"]}/{source["filename"]}', path=path,
                            url=source['url'], commit=package['commit'])
        manifest = {'schema': 1, 'runtimeLockSha256': runtime_sha256, 'sourcesLockSha256': sources_sha256,
                    'compression': {'format': 'zstd', 'level': 19, 'threads': 1},
                    'termux': [{'name': item['name'], 'version': item['version'], 'commit': item['commit'],
                                'evidence': item['evidence'], 'mappingCaveats': item.get('mappingCaveats', [])}
                               for item in lock['termux']['packages']],
                    'node': {'status': 'not-bundled-yet'}, 'npm': {'status': 'not-bundled-yet'},
                    'nodePatches': {'status': 'not-bundled-yet' if node_patch_pins() else 'no-patches', 'files': []},
                    'bun': {'status': 'not-bundled-yet'},
                    'coverage': {'binaryBuildProvenance': 'not-available', 'hermeticToolchain': 'not-included',
                                 'buildOnlyDependencies': 'not-included', 'androidLibraries': 'not-included',
                                 'externalBuildTools': 'not-fetched'}}
        manifest['sourceRecoveries'] = [
            {'path': f'upstream/{package["name"]}/{source["filename"]}', **source['recovery']}
            for package in lock['termux']['packages'] for source in package['sources'] if 'recovery' in source
        ]
        if lock.get('node') is not None:
            node = lock['node']
            paths, signers = verify_node_signature(cache, node, work)
            inspect_tar(paths['source'])
            actual_patches = node_patch_pins()
            if actual_patches != node['patches']:
                fail('node-patches-changed')
            for key, path in sorted(paths.items()):
                members.add('node/' + node[key]['filename'], path=path, url=node[key]['url'])
            for patch in actual_patches:
                path = ROOT.parent.parent / patch['path']
                members.add(patch['path'], path=path)
            manifest['node'] = {'status': 'bundled', 'version': node['version'], 'signatureFingerprints': signers}
            manifest['nodePatches'] = {'status': 'included' if actual_patches else 'no-patches', 'files': actual_patches}
            if lock.get('npm') is not None:
                version = node_npm_version(paths['source'], node['version'])
                if version != lock['npm']['version']:
                    fail('npm-version-mismatch', expected=lock['npm']['version'], actual=version)
                manifest['npm'] = {'status': 'bundled', 'version': version, 'source': 'node'}
        return members.write(destination, manifest, work)


def git_environment():
    environment = dict(os.environ)
    for key in list(environment):
        if key.startswith('GIT_'):
            del environment[key]
    environment.update({'GIT_CONFIG_NOSYSTEM': '1', 'GIT_CONFIG_GLOBAL': '/dev/null', 'GIT_TERMINAL_PROMPT': '0'})
    return environment


def git(repository, *arguments, **kwargs):
    return run(['git', '-c', 'protocol.allow=never', '-c', 'protocol.https.allow=always',
                '-c', 'http.sslVerify=true', '-c', 'http.followRedirects=false', '-C', repository,
                *arguments], env=git_environment(), **kwargs)


def history_repository(directory, offline=False, existing=None):
    require_tools('git')
    repository = Path(existing) if existing else Path(directory) / 'termux-history'
    if repository.is_symlink():
        fail('unsafe-history-repository')
    if not repository.exists():
        if offline:
            fail('offline-history-miss')
        run(['git', '-c', 'protocol.allow=never', '-c', 'protocol.https.allow=always',
             '-c', 'http.sslVerify=true', '-c', 'http.followRedirects=false',
             'clone', '--filter=blob:none', '--no-checkout', '--single-branch', '--no-tags',
             '--branch', 'master', REPOSITORY + '.git', repository], env=git_environment(),
            stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    remote = git(repository, 'remote', 'get-url', 'origin', stdout=subprocess.PIPE, text=True).stdout.strip()
    if remote.removesuffix('.git').rstrip('/') != REPOSITORY:
        fail('history-origin-mismatch')
    if git(repository, 'rev-parse', '--is-shallow-repository', stdout=subprocess.PIPE, text=True).stdout.strip() != 'false':
        fail('shallow-history')
    if git(repository, 'config', '--get', 'remote.origin.partialclonefilter', stdout=subprocess.PIPE, text=True).stdout.strip() != 'blob:none':
        fail('non-blobless-history')
    if not offline and existing is None:
        git(repository, 'fetch', '--no-tags', '--filter=blob:none', 'origin', 'master', stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    try:
        tip = git(repository, 'rev-parse', '--verify', 'refs/remotes/origin/master', stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True).stdout.strip()
    except subprocess.CalledProcessError:
        tip = git(repository, 'rev-parse', '--verify', 'refs/heads/master', stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True).stdout.strip()
    if not COMMIT.fullmatch(tip):
        fail('invalid-history-tip')
    return repository, tip


def git_bytes(repository, commit, path):
    return git(repository, 'show', f'{commit}:{safe_path(path)}', stdout=subprocess.PIPE, stderr=subprocess.PIPE).stdout


def expand_shell(value, variables):
    def replacement(match):
        expression = match[1] if match[1] is not None else match[2]
        parsed = re.fullmatch(r'([A-Za-z_][A-Za-z0-9_]*)(?:\[([0-9]+)\])?(.*)', expression)
        if not parsed or parsed[1] not in variables:
            fail('unresolved-recipe-variable', expression=expression)
        result, operation = variables[parsed[1]], parsed[3]
        if isinstance(result, list):
            index = int(parsed[2] or '0')
            if index >= len(result) or result[index] is None:
                fail('unresolved-recipe-variable', expression=expression)
            result = result[index]
        elif parsed[2] not in (None, '0'):
            fail('unresolved-recipe-variable', expression=expression)
        if not operation:
            return result
        slicing = re.fullmatch(r':(-?[0-9]+)(?::([0-9]+))?', operation)
        if slicing:
            start = int(slicing[1])
            return result[start:] if slicing[2] is None else result[start:start + int(slicing[2])]
        if operation.startswith(('#', '%')):
            operator = operation[0]
            longest = operation.startswith(operator * 2)
            pattern = operation[2 if longest else 1:]
            indexes = range(len(result) + 1)
            if operator == '#':
                indexes = reversed(indexes) if longest else indexes
                return next((result[index:] for index in indexes if fnmatch.fnmatchcase(result[:index], pattern)), result)
            indexes = indexes if longest else reversed(indexes)
            return next((result[:index] for index in indexes if fnmatch.fnmatchcase(result[index:], pattern)), result)
        if operation.startswith('/'):
            global_replace = operation.startswith('//')
            pieces = operation[2 if global_replace else 1:].split('/', 1)
            if len(pieces) == 1:
                pieces.append('')
            if any(char in pieces[0] for char in '*?['):
                fail('unsupported-recipe-expansion', expression=expression)
            return result.replace(pieces[0], pieces[1], -1 if global_replace else 1)
        fail('unsupported-recipe-expansion', expression=expression)

    if '$(' in value or '`' in value:
        fail('executable-recipe-expansion', value=value)
    expanded = re.sub(r'\$\{([^{}]+)\}|\$([A-Za-z_][A-Za-z0-9_]*)', replacement, value)
    if '$' in expanded:
        fail('unsupported-recipe-expansion', value=value)
    return expanded


IMPORT = re.compile(r'\$\(\. "\$TERMUX_SCRIPTDIR/((?:packages|x11-packages)/[a-z0-9+.-]+/build\.sh)"; echo "\$(TERMUX_PKG_(?:VERSION|SRCURL|SHA256))"\)')
DATE_SUBSTITUTION = re.compile(r"\$\(sed 's/\\\./-/g' <<< (\$\{[A-Za-z_][A-Za-z0-9_]*(?::[0-9]+)?\})\)")


def data_substitutions(expression, variables, read_recipe=None, trail=()):
    def imported(match):
        path, variable = match.groups()
        if read_recipe is None:
            return '__UNRESOLVED_IMPORT__'
        if path in trail or len(trail) >= 8:
            fail('recipe-import-cycle', path=path)
        values, pending = recipe_variables(read_recipe(path), read_recipe, (*trail, path))
        value = values.get(variable)
        if isinstance(value, list):
            value = value[0] if value else None
        if variable in pending or not isinstance(value, str) or not re.fullmatch(r'[A-Za-z0-9./_:+~?=&%-]+', value):
            fail('recipe-import-value', path=path, variable=variable)
        return value

    expression = IMPORT.sub(imported, expression)
    return DATE_SUBSTITUTION.sub(lambda match: expand_shell(match[1], variables).replace('.', '-'), expression)


def recipe_variables(text, read_recipe=None, trail=()):
    variables = {'TERMUX_PKG_REVISION': '0', 'TERMUX_PKG_EPOCH': '0'}
    pending = {}
    lines = text.splitlines()
    index = 0
    while index < len(lines):
        line = lines[index]
        index += 1
        match = re.match(r'^([A-Za-z_][A-Za-z0-9_]*)=(.*)$', line)
        if not match:
            continue
        name, expression = match.groups()
        if expression.lstrip().startswith('('):
            while not re.search(r'\)\s*(?:#.*)?$', expression):
                if index == len(lines):
                    fail('unterminated-recipe-array', variable=name)
                expression += '\n' + lines[index]
                index += 1
            expression = expression.strip()[1:expression.rfind(')')]
            is_array = True
        else:
            is_array = False
            while True:
                try:
                    shlex.split(expression, comments=True, posix=True)
                    break
                except ValueError:
                    if index == len(lines):
                        fail('unterminated-recipe-value', variable=name)
                    expression += '\n' + lines[index]
                    index += 1
        pending[name] = (expression, is_array)
    for _ in range(len(pending) + 1):
        changed = False
        for name, (expression, is_array) in list(pending.items()):
            try:
                prepared = data_substitutions(expression, variables, read_recipe, trail)
                values = [expand_shell(token, variables) for token in shlex.split(prepared, comments=True, posix=True)]
            except (SourceError, ValueError):
                continue
            if not is_array and len(values) > 1:
                continue
            variables[name] = values if is_array else (values[0] if values else '')
            del pending[name]
            changed = True
        if not changed:
            break
    return variables, pending


def recipe_version(text):
    variables, unresolved = recipe_variables(text)
    if 'TERMUX_PKG_VERSION' not in variables or any(key in unresolved for key in ('TERMUX_PKG_VERSION', 'TERMUX_PKG_EPOCH', 'TERMUX_PKG_REVISION')):
        fail('unresolved-recipe-version', variables=sorted(unresolved))
    version = variables['TERMUX_PKG_VERSION']
    if isinstance(version, list):
        version = version[0] if version else None
    epoch = variables.get('TERMUX_PKG_EPOCH', '0')
    revision = variables.get('TERMUX_PKG_REVISION', '0')
    if not isinstance(version, str) or not version or not str(epoch).isdecimal() or not str(revision).isdecimal():
        fail('invalid-recipe-version')
    if epoch != '0' and ':' not in version:
        version = epoch + ':' + version
    if revision != '0' or '-' in version:
        version += '-' + revision
    return version


def recipe_sources(text, read_recipe=None):
    variables, unresolved = recipe_variables(text, read_recipe)
    urls = variables.get('TERMUX_PKG_SRCURL', [])
    checksums = variables.get('TERMUX_PKG_SHA256', [])
    if 'TERMUX_PKG_SRCURL' in unresolved or 'TERMUX_PKG_SHA256' in unresolved:
        fail('unresolved-recipe-sources', variables=sorted(unresolved))
    urls = [urls] if isinstance(urls, str) and urls else urls
    checksums = [checksums] if isinstance(checksums, str) and checksums else checksums
    if not isinstance(urls, list) or not isinstance(checksums, list) or len(urls) != len(checksums):
        fail('recipe-source-checksum-count')
    result = []
    for url, sha256 in zip(urls, checksums):
        if '__UNRESOLVED_IMPORT__' in url or '__UNRESOLVED_IMPORT__' in sha256:
            fail('unresolved-recipe-import')
        if url.startswith('http://'):
            original = url
            url = 'https://' + url[len('http://'):]
        else:
            original = None
        pin = {'url': https_url(url), 'sha256': sha256.lower(), 'filename': source_filename(url)}
        if original:
            pin['recipeUrl'] = original
        validate_pin(pin)
        result.append(pin)
    logical = re.sub(r'\\\s*\n\s*', ' ', text)
    for command in re.finditer(r'^\s*termux_download\s+([^\n]+)', logical, re.MULTILINE):
        try:
            arguments = shlex.split(command[1], comments=True)
        except ValueError:
            fail('unsupported-recipe-download')
        if len(arguments) != 3:
            fail('unsupported-recipe-download')
        url_expression, _, checksum_expression = arguments
        if '${PATCH_CHECKSUMS[$PATCH_NUM]}' == checksum_expression:
            version = variables.get('TERMUX_PKG_VERSION')
            if not isinstance(version, str) or not re.fullmatch(r'[0-9]+\.[0-9]+\.[0-9]+', version):
                fail('unsupported-patch-version')
            main, count = version.rsplit('.', 1)
            checksums = re.findall(r'^\s*PATCH_CHECKSUMS\[([0-9]{3})\]=([0-9a-f]{64})\s*$', text, re.MULTILINE)
            mapping = dict(checksums)
            expected = [f'{index:03d}' for index in range(1, int(count) + 1)]
            if len(mapping) != len(checksums) or sorted(mapping) != expected:
                fail('patch-checksum-count')
            for number in expected:
                url = expand_shell(url_expression, {**variables, '_MAIN_VERSION': main, '_PATCH_VERSION': count, 'PATCH_NUM': number})
                result.append({'url': https_url(url), 'sha256': mapping[number], 'filename': source_filename(url)})
        else:
            url = expand_shell(url_expression, variables)
            checksum = expand_shell(checksum_expression, variables)
            pin = {'url': https_url(url), 'sha256': checksum, 'filename': source_filename(url)}
            validate_pin(pin)
            if pin not in result:
                result.append(pin)
    if re.search(r'^\s*(?:curl|wget|git\s+clone)\s', logical, re.MULTILINE):
        fail('unsupported-recipe-download')
    return unique_source_filenames(result), variables


def tree_entries(repository, commit, paths):
    output = git(repository, 'ls-tree', '-rz', commit, '--', *[safe_path(path) for path in paths], stdout=subprocess.PIPE).stdout
    result = []
    for row in output.split(b'\0'):
        if not row:
            continue
        metadata, filename = row.split(b'\t', 1)
        mode, kind, oid = metadata.decode('ascii').split()
        path = safe_path(filename.decode('utf-8'))
        if kind != 'blob' or mode not in ('100644', '100755', '120000'):
            fail('unsupported-git-member', path=path)
        result.append((path, mode, oid))
    return sorted(result)


def pin_tree(repository, commit, paths, cache, available=None, include_size=False):
    entries = tree_entries(repository, commit, paths)
    if not entries:
        fail('empty-git-tree', commit=commit)
    # Hydrate missing blobs in one transfer instead of one request per file.
    objects = sorted({entry[2] for entry in entries})
    if available is None:
        available = set(git(repository, 'cat-file', '--batch-all-objects', '--unordered', '--batch-check=%(objectname)',
                            stdout=subprocess.PIPE).stdout.decode('ascii').splitlines())
    missing = sorted(set(objects) - available)
    if missing:
        git(repository, 'fetch', '--no-tags', '--no-write-fetch-head', '--filter=blob:none', '--stdin', 'origin',
            input=('\n'.join(missing) + '\n').encode(), stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        available.update(missing)
    output = git(repository, 'cat-file', '--batch', input=('\n'.join(objects) + '\n').encode(), stdout=subprocess.PIPE).stdout
    blobs = {}
    position = 0
    for oid in objects:
        end = output.index(b'\n', position)
        header = output[position:end].decode('ascii').split()
        if len(header) != 3 or header[0] != oid or header[1] != 'blob':
            fail('git-blob-missing', object=oid)
        size = int(header[2])
        contents = output[end + 1:end + 1 + size]
        if output[end + 1 + size:end + 2 + size] != b'\n' or hashlib.sha1(f'blob {size}\0'.encode() + contents).hexdigest() != oid:
            fail('git-blob-integrity', object=oid)
        blobs[oid] = contents
        position = end + size + 2
    result = []
    for path, mode, oid in entries:
        contents = blobs[oid]
        sha256 = cache.store(contents)
        pin = {'path': path, 'sha256': sha256, 'url': raw_url(commit, path),
               'mode': 0o755 if mode == '100755' else 0o644, 'type': 'file', 'gitBlob': oid}
        if mode == '120000':
            target = contents.decode('utf-8')
            safe_link(path, target)
            pin.update({'type': 'symlink', 'mode': 0o777, 'target': target})
        if include_size:
            pin['size'] = len(contents)
        result.append(pin)
    return result


def find_recipe(repository, tip, name):
    direct = f'packages/{name}/build.sh'
    output = git(repository, 'ls-tree', '-r', '--name-only', tip, '--', 'packages', stdout=subprocess.PIPE, text=True).stdout.splitlines()
    candidates = set()
    if direct in output:
        candidates.add(f'packages/{name}')
    for path in output:
        if PurePosixPath(path).name == name + '.subpackage.sh':
            candidates.add(str(PurePosixPath(path).parent))
    if len(candidates) != 1:
        fail('recipe-directory-ambiguous', package=name, candidates=sorted(candidates))
    return candidates.pop()


def resolve_range(repository, tip, recipe, expected):
    commits = git(repository, 'log', '--first-parent', '--format=%H', tip, '--', recipe,
                  stdout=subprocess.PIPE, text=True).stdout.splitlines()
    if not commits:
        fail('missing-recipe-history', recipe=recipe)
    matches = []
    after = None
    before = None
    after_version = None
    before_version = None
    texts = {}
    # A range is bounded by the first nonmatching package-directory state.
    for commit in commits:
        try:
            text = git_bytes(repository, commit, recipe + '/build.sh').decode('utf-8')
            version = recipe_version(text)
        except subprocess.CalledProcessError:
            version = None
            text = ''
        if version == expected:
            matches.append(commit)
            texts[commit] = text
        elif matches:
            before = commit
            before_version = version
            break
        else:
            after = commit
            after_version = version
    if not matches:
        fail('recipe-version-not-found', recipe=recipe, version=expected)
    evidence = {'method': 'first-parent-package-history', 'historyTip': tip,
                'selected': matches[0], 'first': matches[-1], 'last': matches[0],
                'before': before, 'after': after, 'matchingDirectoryCommits': len(matches),
                'beforeVersion': before_version, 'afterVersion': after_version, 'version': expected}
    parents = git(repository, 'show', '-s', '--format=%P', matches[-1], stdout=subprocess.PIPE, text=True).stdout.split()
    end_parents = git(repository, 'show', '-s', '--format=%P', after, stdout=subprocess.PIPE, text=True).stdout.split() if after else []
    evidence.update({'rangeStartParent': parents[0] if parents else None, 'rangeEnd': end_parents[0] if end_parents else tip,
                     'openAtHistoryTip': after is None,
                     'commitUrl': f'{REPOSITORY}/commit/{matches[0]}',
                     'commitSubject': git(repository, 'show', '-s', '--format=%s', matches[0], stdout=subprocess.PIPE, text=True).stdout.strip()})
    evidence['ciNoBuild'] = '%ci:no-build' in git(repository, 'show', '-s', '--format=%B', matches[0], stdout=subprocess.PIPE, text=True).stdout
    return matches[0], evidence, texts[matches[0]]


def spdx_identifier(license_value, package=None):
    aliases = {'GPL-2.0': 'GPL-2.0-only', 'GPL-3.0': 'GPL-3.0-only',
               'LGPL-2.1': 'LGPL-2.1-only', 'LGPL-3.0': 'LGPL-3.0-only',
               'GPL-2.0+': 'GPL-2.0-or-later', 'GPL-3.0+': 'GPL-3.0-or-later',
               'LGPL-2.1+': 'LGPL-2.1-or-later', 'LGPL-3.0+': 'LGPL-3.0-or-later'}
    components = {'bash': 'GPL-3.0-or-later', 'readline': 'GPL-3.0-or-later',
                  'git': 'GPL-2.0-only', 'libcurl': 'curl', 'libiconv': 'LGPL-2.1-or-later AND GPL-3.0-or-later',
                  'libandroid-support': 'Apache-2.0 AND MIT AND BSD-2-Clause',
                  'libssh2': 'BSD-3-Clause', 'pcre2': '(BSD-3-Clause WITH PCRE2-exception) AND BSD-2-Clause', 'zlib': 'Zlib'}
    if package in components:
        return components[package]
    if not isinstance(license_value, str):
        return None
    if license_value in aliases:
        return aliases[license_value]
    if re.fullmatch(r'(?:[A-Za-z0-9.+-]+)(?: (?:AND|OR|WITH) [A-Za-z0-9.+-]+)*', license_value):
        return license_value
    return None


def refresh_download(url, directory, filename):
    https_url(url)
    require_tools('curl')
    path = Path(directory) / filename
    run(['curl', '-q', '--fail', '--location', '--silent', '--show-error',
         '--proto', '=https', '--proto-redir', '=https', '--tlsv1.2', '--retry', '3',
         '--connect-timeout', '30', '--max-time', '600', '--output', path, url],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    return path


def refresh_node(runtime, cache):
    if runtime['node'] is None:
        if runtime['npm'] is not None:
            fail('npm-without-node')
        return None, None
    version = runtime['node'].get('version')
    if not isinstance(version, str) or not NODE_VERSION.fullmatch(version):
        fail('node-version')
    version = version.removeprefix('v')
    base = f'https://nodejs.org/dist/v{version}/'
    keyring = {'url': NODE_KEYRING_URL, 'sha256': NODE_KEYRING_SHA256, 'filename': 'node-release-keys.kbx'}
    cache.get(keyring['url'], keyring['sha256'])
    with tempfile.TemporaryDirectory(prefix='node-refresh-', dir=cache.directory.parent) as temporary:
        work = Path(temporary)
        node = {'version': version, 'keyring': keyring, 'patches': node_patch_pins()}
        for key, filename in (('shasums', 'SHASUMS256.txt'), ('signature', 'SHASUMS256.txt.sig')):
            path = refresh_download(base + filename, work, filename)
            node[key] = {'url': base + filename, 'sha256': cache.store(path.read_bytes()), 'filename': filename}
        shasums = (work / 'SHASUMS256.txt').read_text(encoding='ascii')
        filename = f'node-v{version}.tar.xz'
        matches = re.findall(r'^([0-9a-f]{64})  ' + re.escape(filename) + r'$', shasums, re.MULTILINE)
        if len(matches) != 1:
            fail('node-source-shasums')
        node['source'] = {'url': base + filename, 'sha256': matches[0], 'filename': filename}
        # Authenticate checksums before downloading the much larger source object.
        require_tools('gpgv')
        home = work / 'verify-home'
        home.mkdir(mode=0o700)
        checked = run(['gpgv', '--homedir', home, '--keyring', cache.get(keyring['url'], keyring['sha256']),
                       '--status-fd', '1', work / 'SHASUMS256.txt.sig', work / 'SHASUMS256.txt'],
                      stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        valid = [line.split()[2:] for line in checked.stdout.splitlines() if line.startswith('[GNUPG:] VALIDSIG ')]
        if not valid or any(len(line) < 10 or line[-1] not in NODE_SIGNERS or line[7] not in ('8', '9', '10') for line in valid):
            fail('node-signature-signer')
        source = cache.get(node['source']['url'], node['source']['sha256'])
        verify_node_signature(cache, node, work)
        inspect_tar(source)
        npm = None
        if runtime['npm'] is not None:
            actual = node_npm_version(source, version)
            if runtime['npm'].get('version') != actual:
                fail('npm-version-mismatch', expected=runtime['npm'].get('version'), actual=actual)
            npm = {'version': actual, 'source': 'node'}
    return node, npm


def annotate_sources(pins, text, commit, path, imports):
    documents = {path: text, **imports}
    result = []
    for pin in pins:
        origin = next((name for name, contents in documents.items() if pin['sha256'] in contents), None)
        if origin is None:
            fail('source-checksum-evidence', url=pin['url'])
        contents = documents[origin]
        lines = [index for index, line in enumerate(contents.splitlines(), 1) if pin['sha256'] in line]
        kind = 'upstream-patch' if '-patches/' in pin['url'] else 'build-tool-binary' if pin['filename'].endswith('.jar') else 'upstream-source'
        result.append({**pin, 'kind': kind, 'evidence': {'commit': commit, 'path': origin,
                       'fileSha256': hashlib.sha256(contents.encode('utf-8')).hexdigest(), 'lines': lines,
                       'url': f'{REPOSITORY}/blob/{commit}/{quote(origin, safe="/+._~-")}#L{lines[0]}'}})
    return result


def refresh(runtime, runtime_path, cache, repository=None, history_tip=None):
    packages = validate_runtime(runtime)
    repository, tip = history_repository(cache.directory.parent, cache.offline, repository)
    if history_tip is not None:
        if not COMMIT.fullmatch(history_tip):
            fail('invalid-history-tip')
        git(repository, 'cat-file', '-e', history_tip + '^{commit}', stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        tip = history_tip
    available = set(git(repository, 'cat-file', '--batch-all-objects', '--unordered', '--batch-check=%(objectname)',
                        stdout=subprocess.PIPE).stdout.decode('ascii').splitlines())
    lock = {'schema': 1, 'runtimeLockSha256': digest(runtime_path),
            'termux': {'repository': REPOSITORY, 'historyTip': tip, 'packages': [], 'buildSystems': []},
            'node': None, 'npm': None}
    for name, version in sorted(packages.items()):
        recipe = find_recipe(repository, tip, name)
        commit, evidence, text = resolve_range(repository, tip, recipe, version)
        imports = {}

        def read_recipe(path):
            if path not in imports:
                imports[path] = git_bytes(repository, commit, path).decode('utf-8')
            return imports[path]

        sources, variables = recipe_sources(text, read_recipe)
        license_value = variables.get('TERMUX_PKG_LICENSE')
        homepage = variables.get('TERMUX_PKG_HOMEPAGE')
        if homepage and homepage.startswith('http://'):
            homepage = 'https://' + homepage[len('http://'):]
        package_sources = annotate_sources(sources, text, commit, recipe + '/build.sh', imports)
        for source in package_sources:
            recovery = EXACT_GZIP_RECOVERIES.get(source['sha256'])
            if recovery is not None:
                source['recovery'] = recovery
        package = {'name': name, 'version': version, 'commit': commit, 'recipePath': recipe,
                   'evidence': evidence, 'files': pin_tree(repository, commit, [recipe], cache, available),
                   'sources': package_sources,
                   'imports': sorted(imports), 'license': license_value, 'spdx': spdx_identifier(license_value, name),
                   'homepage': https_url(homepage) if homepage else None,
                   'sourceStatus': 'upstream-tarballs' if sources else 'in-recipe-directory'}
        caveats = ['history-derived-not-build-attestation']
        if evidence['ciNoBuild']:
            caveats.append('selected-touch-ci-no-build')
        if imports:
            caveats.append('cross-recipe-values-at-selected-commit')
        if any(source['kind'] == 'build-tool-binary' for source in package['sources']):
            caveats.append('recipe-pins-build-tool-binary-not-tool-source')
        if re.search(r'\btermux_setup_rust\b', text):
            caveats.append('rustup-bootstrap-not-recipe-sha256-pinned-not-fetched')
        package['mappingCaveats'] = caveats
        lock['termux']['packages'].append(package)
    for commit in sorted({item['commit'] for item in lock['termux']['packages']}):
        selection = [{'reason': rule['reason'], 'paths': list(rule['paths'])} for rule in BUILD_SELECTION]
        paths = {path for rule in selection for path in rule['paths']}
        imports, rust = set(), False
        for item in lock['termux']['packages']:
            if item['commit'] == commit:
                imports.update(path for path in item['imports'] if not selected_path(path, paths))
                if re.search(r'\btermux_setup_rust\b', git_bytes(repository, commit, item['recipePath'] + '/build.sh').decode('utf-8')):
                    rust = True
        if rust:
            rust_path = 'packages/rust/build.sh'
            imports.discard(rust_path)
            selection.append({'reason': 'rust-toolchain-version-read', 'paths': [rust_path]})
            paths.add(rust_path)
        if imports:
            selection.append({'reason': 'recipe-value-imports', 'paths': sorted(imports)})
            paths.update(imports)
        files = pin_tree(repository, commit, sorted(paths), cache, available, include_size=True)
        # Historical optional paths are retained only when present in this tree.
        selection = [{'reason': rule['reason'], 'paths': [path for path in rule['paths']
                      if any(selected_path(pin['path'], [path]) for pin in files)]} for rule in selection]
        system = {'commit': commit, 'selection': sorted((rule for rule in selection if rule['paths']), key=lambda rule: rule['reason']),
                  **snapshot_summary(files)}
        check_snapshot(system, files, cache)
        write_atomic(snapshot_index_path(system, cache), snapshot_listing(files))
        lock['termux']['buildSystems'].append(system)
    lock['node'], lock['npm'] = refresh_node(runtime, cache)
    validate_sources(lock, runtime, digest(runtime_path))
    return lock


class Parser(argparse.ArgumentParser):
    def error(self, message):
        self.exit(2, 'TODO(copy)\n')

    def format_usage(self):
        return 'TODO(copy)\n'

    def format_help(self):
        return 'TODO(copy)\n'


def main():
    parser = Parser(add_help=False, description='TODO(copy)')
    parser.add_argument('-h', '--help', action='help', help='TODO(copy)')
    parser.add_argument('--runtime-lock', type=Path, default=ROOT.parent / 'runtime.lock', help='TODO(copy)')
    parser.add_argument('--sources-lock', type=Path, default=ROOT / 'sources.lock', help='TODO(copy)')
    parser.add_argument('--cache', type=Path, default=ROOT / 'cache' / 'sources', help='TODO(copy)')
    parser.add_argument('--output', type=Path, default=ROOT / 'out' / 'SillyBunny-android-sources.tar.zst', help='TODO(copy)')
    parser.add_argument('--offline', action='store_true', help='TODO(copy)')
    parser.add_argument('--require-node', action='store_true', help='TODO(copy)')
    parser.add_argument('--refresh-lock', action='store_true', help='TODO(copy)')
    parser.add_argument('--dry-run', action='store_true', help='TODO(copy)')
    parser.add_argument('--history-repo', type=Path, help='TODO(copy)')
    parser.add_argument('--history-tip', help='TODO(copy)')
    parser.add_argument('--verify', type=Path, help='TODO(copy)')
    args = parser.parse_args()
    if args.verify:
        manifest = verify_archive(args.verify)
        print(json.dumps({'verified': len(manifest['members']) + 1, 'sha256': digest(args.verify)}, sort_keys=True))
        return
    if args.dry_run and not args.refresh_lock or (args.history_repo or args.history_tip) and not args.refresh_lock:
        parser.error('TODO(copy)')
    cache = Cache(args.cache / 'objects', args.offline)
    with (args.cache / '.sources.lock').open('a') as guard:
        fcntl.flock(guard, fcntl.LOCK_EX)
        runtime = load_json(args.runtime_lock)
        validate_runtime(runtime)
        if args.refresh_lock:
            if args.offline:
                fail('offline-refresh-unsupported')
            lock = refresh(runtime, args.runtime_lock, cache, args.history_repo, args.history_tip)
            if args.require_node and (lock['node'] is None or lock['npm'] is None):
                fail('node-and-npm-required')
            if not args.dry_run:
                write_atomic(args.sources_lock, json_bytes(lock))
            print(json.dumps({'packages': len(lock['termux']['packages']), 'historyTip': lock['termux']['historyTip'],
                              'sourcesLockSha256': hashlib.sha256(json_bytes(lock)).hexdigest(), 'written': not args.dry_run}, sort_keys=True))
        else:
            lock = load_json(args.sources_lock)
            result = build(lock, runtime, args.runtime_lock, args.sources_lock, cache, args.output, args.require_node)
            print(json.dumps(result, sort_keys=True))


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, subprocess.CalledProcessError, tarfile.TarError) as error:
        print('TODO(copy)', file=sys.stderr)
        if isinstance(error, SourceError):
            print(json.dumps({'code': error.code, **error.details}, sort_keys=True), file=sys.stderr)
        else:
            print(json.dumps({'code': type(error).__name__}, sort_keys=True), file=sys.stderr)
        sys.exit(1)
