#!/usr/bin/env python3
"""npm for the APK: deps/npm of the verified Node source tarball as one deterministic ZIP (plan §2.1, §5.1).

    build-npm.py [--output DIR] [--cache DIR] [--offline] [--provenance npm-provenance.json]

Writes <output>/npm.zip and <output>/npm.json (default android/runtime/npm-out) in the staging-contract
format android/app/runtime-packaging.gradle.kts verifies:
    {"schema": 1, "version": "<npm>", "sha256": "<zip>", "size": <bytes>, "files": <n>, "contentBytes": <bytes>,
     "source": {...}}
The ZIP holds file entries only, sorted by path segments, DEFLATE level 9, 1980-01-01 timestamps, Unix modes
0644/0755 and only paths the app accepts: plain segments of [A-Za-z0-9._@+~-], never `.`, `..`, absolute,
duplicate or link entries. The same inputs give the same bytes with the same Python and zlib.
--provenance checks the version, file count and content size against S2.5's npm-provenance.json.
--output is replaced as a whole, so it must be absent, empty or a previous npm-out holding only npm.zip and
npm.json; anything else there, the working directory or one of its ancestors is refused (unsafe-output).
Standard library only; the tarball comes from sources.py's pinned cache.
"""
import argparse
import hashlib
import importlib.util
import io
import json
import re
import stat
import sys
import tarfile
import tempfile
import zipfile
from pathlib import Path

sys.dont_write_bytecode = True

ROOT = Path(__file__).resolve().parent
_SPEC = importlib.util.spec_from_file_location('runtime_fetch_node', ROOT / 'fetch-node.py')
node = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(node)
fail = node.fail

NPM_OUT = ROOT / 'npm-out'
# What npm-out may hold before it is replaced (fetch-node.py check_output).
NPM_OUT_LAYOUT = {'npm.json': node.FILE, 'npm.zip': node.FILE}
NPM_PATH = 'deps/npm'
# The app's npm.zip rules (NpmArchive, mirrored by runtime-packaging.gradle.kts).
SAFE_SEGMENT = re.compile(r'[A-Za-z0-9._@+~-]+\Z')
MAX_FILES = 20_000
MAX_CONTENT_BYTES = 512 * 1024 * 1024
MAX_ARCHIVE_BYTES = 64 * 1024 * 1024
MAX_PATH = 1024
MAX_DEPTH = 64
ZIP_TIME = (1980, 1, 1, 0, 0, 0)
CLI_PATHS = ('bin/npm-cli.js', 'bin/npx-cli.js')


def safe_relative(path):
    segments = path.split('/')
    if (not path or len(path) > MAX_PATH or len(segments) > MAX_DEPTH
            or any(segment in ('.', '..') or not SAFE_SEGMENT.fullmatch(segment) for segment in segments)):
        fail('npm-unsafe-path', path=path)
    return path


def npm_entries(members, prefix):
    """{relative path: (bytes, mode)} for the regular files under `prefix` in (TarInfo, reader) pairs."""
    entries = {}
    directories = set()
    for member, read in members:
        name = member.name
        if name.rstrip('/') == prefix.rstrip('/'):
            if not member.isdir():
                fail('npm-entry-type', path='.')
            continue
        if not name.startswith(prefix):
            continue
        relative = name[len(prefix):]
        if member.isdir():
            directories.add(safe_relative(relative.rstrip('/')))
            continue
        if not member.isreg():
            fail('npm-entry-type', path=relative)
        safe_relative(relative)
        if relative in entries:
            fail('npm-duplicate', path=relative)
        data = read(member)
        if len(data) != member.size:
            fail('npm-entry-size', path=relative)
        entries[relative] = (data, 0o755 if member.mode & 0o111 else 0o644)
    parents = {path[:index] for path in [*entries, *directories] for index, char in enumerate(path) if char == '/'}
    conflicts = sorted(set(entries) & (parents | directories))
    if conflicts:
        fail('npm-file-is-directory', paths=conflicts[:10])
    if not entries:
        fail('npm-missing')
    return entries


def tarball_entries(tarball, node_version):
    prefix = f'node-v{node_version}/{NPM_PATH}/'
    with tarfile.open(tarball, mode='r:xz') as archive:
        def read(member):
            with archive.extractfile(member) as stream:
                return stream.read()

        return npm_entries(((member, read) for member in archive), prefix)


def check_metadata(entries, version):
    try:
        metadata = json.loads(entries['package.json'][0])
    except (KeyError, ValueError):
        fail('npm-metadata')
    if not isinstance(metadata, dict) or metadata.get('name') != 'npm' or metadata.get('version') != version:
        fail('npm-version-mismatch', expected=version, actual=metadata.get('version') if isinstance(metadata, dict) else None)
    missing = [path for path in CLI_PATHS if path not in entries]
    if missing:
        fail('npm-cli-missing', paths=missing)


def ordered(entries):
    # Path-segment order, the order S2.5's payload used.
    return sorted(entries, key=lambda path: path.split('/'))


def zip_bytes(entries):
    stream = io.BytesIO()
    with zipfile.ZipFile(stream, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=9, allowZip64=False) as archive:
        for name in ordered(entries):
            data, mode = entries[name]
            info = zipfile.ZipInfo(name, date_time=ZIP_TIME)
            info.create_system = 3
            info.external_attr = (stat.S_IFREG | mode) << 16
            archive.writestr(info, data, compress_type=zipfile.ZIP_DEFLATED, compresslevel=9)
    return stream.getvalue()


def check_zip(data, entries):
    """Re-reads the archive the way the app does and compares every entry with its source file."""
    if len(data) > MAX_ARCHIVE_BYTES:
        fail('npm-archive-too-large', size=len(data))
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        if archive.testzip() is not None:
            fail('npm-archive-crc')
        infos = archive.infolist()
        if [info.filename for info in infos] != ordered(entries):
            fail('npm-archive-entries')
        for info in infos:
            source, mode = entries[info.filename]
            if (info.is_dir() or info.flag_bits & 0x2041 or info.compress_type != zipfile.ZIP_DEFLATED
                    or info.date_time != ZIP_TIME or info.external_attr >> 16 != stat.S_IFREG | mode
                    or archive.read(info) != source):
                fail('npm-archive-entry', path=info.filename)
    if len(entries) > MAX_FILES or sum(len(item[0]) for item in entries.values()) > MAX_CONTENT_BYTES:
        fail('npm-archive-limits')


def check_provenance(provenance, summary):
    """S2.5 cross-check: same npm version, file count and content size as its verified payload."""
    try:
        expected = {'version': provenance['version'], 'files': provenance['archive']['fileCount'],
                    'contentBytes': provenance['archive']['uncompressedFileBytes']}
        source_count = provenance['source']['fileCount']
    except (KeyError, TypeError):
        fail('npm-provenance-format')
    actual = {key: summary[key] for key in expected}
    if actual != expected or source_count != summary['files']:
        fail('npm-provenance-mismatch', expected=expected, actual=actual)
    return summary['sha256'] == provenance['archive'].get('sha256')


def prepare(pins, tarball):
    """The npm.zip bytes and the npm.json object for the pinned Node source tarball."""
    entries = tarball_entries(tarball, pins.version)
    check_metadata(entries, pins.npm_version)
    data = zip_bytes(entries)
    check_zip(data, entries)
    summary = {
        'schema': 1,
        'version': pins.npm_version,
        'sha256': hashlib.sha256(data).hexdigest(),
        'size': len(data),
        'files': len(entries),
        'contentBytes': sum(len(item[0]) for item in entries.values()),
        'source': {
            'kind': 'node-source-tarball',
            'node': pins.version,
            'path': NPM_PATH,
            'tarball': node.pinned_tarball(pins),
        },
    }
    return data, summary


def write_output(output, data, summary):
    """Replaces <output> with npm.zip and npm.json; a failed run leaves the previous output."""
    output = node.check_output(output, NPM_OUT_LAYOUT)
    output.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix=f'.{output.name}-new-', dir=output.parent))
    try:
        staging.chmod(0o755)
        (staging / 'npm.zip').write_bytes(data)
        (staging / 'npm.json').write_bytes(node.json_bytes(summary))
        for path in staging.iterdir():
            path.chmod(0o644)
        node.replace_directory(staging, output, NPM_OUT_LAYOUT)
    finally:
        if staging.exists():
            for path in staging.iterdir():
                path.unlink()
            staging.rmdir()


class Parser(argparse.ArgumentParser):
    def error(self, message):
        self.exit(2, 'TODO(copy)\n')

    def format_usage(self):
        return 'TODO(copy)\n'

    def format_help(self):
        return 'TODO(copy)\n'


def main(arguments=None):
    parser = Parser(add_help=False, description='TODO(copy)')
    parser.add_argument('-h', '--help', action='help', help='TODO(copy)')
    parser.add_argument('--runtime-lock', type=Path, default=node.RUNTIME_LOCK, help='TODO(copy)')
    parser.add_argument('--sources-lock', type=Path, default=node.SOURCES_LOCK, help='TODO(copy)')
    parser.add_argument('--cache', type=Path, default=node.CACHE, help='TODO(copy)')
    parser.add_argument('--offline', action='store_true', help='TODO(copy)')
    parser.add_argument('--output', type=Path, default=NPM_OUT, help='TODO(copy)')
    parser.add_argument('--provenance', type=Path, help='TODO(copy)')
    args = parser.parse_args(arguments)
    pins = node.load_pins(args.runtime_lock, args.sources_lock)
    # Refuse an output this tool does not own before reading or downloading the tarball.
    node.check_output(args.output, NPM_OUT_LAYOUT)
    provenance = node.parse_json(args.provenance.read_bytes(), 'provenance') if args.provenance else None
    tarball, signature = node.verified_source(pins, args.cache, args.offline)
    data, summary = prepare(pins, tarball)
    result = {key: summary[key] for key in ('version', 'sha256', 'size', 'files', 'contentBytes')}
    if provenance is not None:
        result['provenanceArchiveMatch'] = check_provenance(provenance, summary)
    write_output(args.output, data, summary)
    result.update({'output': str(args.output), 'signature': signature['status']})
    print(json.dumps(result, sort_keys=True))


if __name__ == '__main__':
    try:
        main()
    except (node.NodeError, node.sources.SourceError) as error:
        print('TODO(copy)', file=sys.stderr)
        print(json.dumps({'code': error.code, **error.details}, sort_keys=True, default=str), file=sys.stderr)
        sys.exit(1)
    except (OSError, ValueError, tarfile.TarError, zipfile.BadZipFile) as error:
        print('TODO(copy)', file=sys.stderr)
        print(json.dumps({'code': type(error).__name__}, sort_keys=True), file=sys.stderr)
        sys.exit(1)
