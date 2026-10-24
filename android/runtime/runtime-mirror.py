#!/usr/bin/env python3
"""Plans, checks and stages the input mirror: a copy of every input that a release build downloads by SHA-256 pin
(the Termux debs, the sources.lock URL pins, the build-system listings and the files they list) in the GHCR
repository that runtime.lock's mirror.repository names. Builds read it blob by blob through sources.py. Here it is
one OCI artifact per pinned set, tagged inputs-<12 hex>, with one layer per unique digest.

    runtime-mirror.py --plan        prints {"reference": "<repository>:<tag>", "present": true|false}
    runtime-mirror.py --check       fails with mirror-missing unless the tag exists
    runtime-mirror.py --stage DIR   fetches every input, mirror first, into the build caches, then writes one file per
                                    digest to DIR under its layer title, DIR/oras-files (title:mediaType per line,
                                    in oras push argument form) and DIR/reference

Every registry request is an anonymous read; publishing is the workflow's oras push of a staged directory.
"""
import argparse
import fcntl
import hashlib
import importlib.util
import json
import os
import subprocess
import sys
from pathlib import Path, PurePosixPath

sys.dont_write_bytecode = True

ROOT = Path(__file__).resolve().parent
_SPEC = importlib.util.spec_from_file_location('package_termux', ROOT / 'package-termux.py')
termux = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(termux)
sources = termux.sources

SCHEMA = 1
DEB = 'application/vnd.debian.binary-package'
LISTING = 'application/vnd.sillybunnyteam.android.snapshot.v1+jsonl'
BLOB = 'application/octet-stream'


def read_json(path):
    """The parsed file and the SHA-256 of the bytes it was parsed from."""
    data = sources.input_path(path).read_bytes()

    def unique(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                sources.fail('duplicate-json-key', key=key)
            result[key] = value
        return result

    return json.loads(data.decode('utf-8'), object_pairs_hook=unique), hashlib.sha256(data).hexdigest()


def load_locks(runtime_path, sources_path):
    runtime, runtime_sha256 = read_json(runtime_path)
    lock, _ = read_json(sources_path)
    termux.validate_lock(runtime)
    sources.validate_sources(lock, runtime, runtime_sha256)
    if 'mirror' not in runtime:
        sources.fail('mirror-unset')
    return runtime, lock


def root_digests(runtime, lock):
    """The listings pin the build-system files by SHA-256, so these digests fix the whole set."""
    debs = {deb['sha256'].lower() for package in runtime['termux']['packages'] for deb in package['debs'].values()}
    pins = {pin['sha256'] for pin in sources.download_pins(lock)}
    listings = {system['sha256'] for system in lock['termux']['buildSystems']}
    return sorted(debs | pins | listings)


def tag(runtime, lock):
    """Node binary digests are not in the set, so the change that pins them keeps the tag and publishes nothing. A
    new SCHEMA gives every set a new tag, which a change to the staged layout needs."""
    body = json.dumps({'schema': SCHEMA, 'digests': root_digests(runtime, lock)}, separators=(',', ':'))
    return 'inputs-' + hashlib.sha256(body.encode('ascii')).hexdigest()[:12]


def reference(runtime, lock):
    return f'{runtime["mirror"]["repository"]}:{tag(runtime, lock)}'


def manifest_status(target):
    """The HTTP status of an anonymous HEAD of the tag's manifest: 200 when the tag exists, 404 when the package does
    not have it, and 401 or 403 when GHCR refuses an anonymous reader, as it does for a package that does not exist
    yet or is private. Builds read anonymously, so only 200 means that they can read the set. Any other answer fails
    with mirror-unreachable."""
    repository, name = target.rsplit(':', 1)
    status = sources.mirror_status(repository, 'manifests/' + name, os.devnull, head=True)
    if status not in (200, 401, 403, 404):
        sources.fail('mirror-unreachable', status=status)
    return status


def fetch(runtime, lock, cache):
    """Fetches every input into the build caches under cache, mirror first. Returns the sources cache and the files
    of each build system."""
    termux.fetch_debs(runtime, cache)
    store = sources.Cache(cache / 'sources' / 'objects', mirror=runtime['mirror']['repository'])
    store.fetch_all(sources.download_pins(lock))
    return store, [(system, sources.build_system_files(system, store)) for system in lock['termux']['buildSystems']]


def layers(runtime, lock, cache, store, systems):
    """{sha256: (title, media type, cached file)}. A digest with several roles takes the title of its first role in
    this order: deb, sources archive member, listing, build-system file; within a role, the smallest title."""
    candidates = []
    for package in runtime['termux']['packages']:
        for deb in package['debs'].values():
            sha256 = deb['sha256'].lower()
            # apt names its archive files with an epoch's colon written as %3a, which also keeps the title a valid
            # file name on Windows when somebody pulls the set.
            name = PurePosixPath(deb['filename']).name.replace(':', '%3a')
            candidates.append((sha256, 0, 'debs/' + name, DEB, cache / 'debs' / (sha256 + '.deb')))
    names = {}
    for package in lock['termux']['packages']:
        for pin in package['files']:
            names.setdefault(pin['sha256'], []).append(f'termux/{package["commit"]}/{pin["path"]}')
        for pin in package['sources']:
            names.setdefault(pin['sha256'], []).append(f'upstream/{package["name"]}/{pin["filename"]}')
    if lock.get('node') is not None:
        for key in ('source', 'shasums', 'signature', 'keyring'):
            pin = lock['node'][key]
            names.setdefault(pin['sha256'], []).append('node/' + pin['filename'])
    for pin in sources.download_pins(lock):
        for title in names.get(pin['sha256'], ['objects/' + pin['sha256']]):
            candidates.append((pin['sha256'], 1, title, BLOB, store.directory / pin['sha256']))
    for system, files in systems:
        candidates.append((system['sha256'], 2, f'snapshots/{system["sha256"]}.jsonl', LISTING,
                           sources.snapshot_index_path(system, store)))
        for pin in files:
            candidates.append((pin['sha256'], 3, 'objects/' + pin['sha256'], BLOB, store.directory / pin['sha256']))
    chosen = {}
    for sha256, _, title, media_type, path in sorted(candidates):
        chosen.setdefault(sha256, (title, media_type, path))
    owners = {}
    for sha256, (title, _, _) in chosen.items():
        if owners.setdefault(title, sha256) != sha256:
            sources.fail('mirror-title-conflict', title=title)
    return chosen


def copy_checked(source, target, sha256):
    checksum = hashlib.sha256()
    with sources.input_path(source).open('rb') as reader, target.open('xb') as writer:
        for block in iter(lambda: reader.read(1 << 20), b''):
            checksum.update(block)
            writer.write(block)
    if checksum.hexdigest() != sha256:
        sources.fail('sha256-mismatch', sha256=sha256)
    target.chmod(0o644)


def stage(runtime, lock, directory, cache):
    """Writes the set to directory, which must be absent or empty. Returns the (title, media type, sha256) rows of
    oras-files in order."""
    directory = sources.input_path(directory)
    if directory.exists() and (not directory.is_dir() or any(directory.iterdir())):
        sources.fail('stage-not-empty')
    store, systems = fetch(runtime, lock, cache)
    rows = []
    directory.mkdir(parents=True, exist_ok=True)
    for sha256, (title, media_type, path) in sorted(layers(runtime, lock, cache, store, systems).items(),
                                                     key=lambda item: item[1][0]):
        target = directory / title
        target.parent.mkdir(parents=True, exist_ok=True)
        copy_checked(path, target, sha256)
        rows.append((title, media_type, sha256))
    (directory / 'oras-files').write_text(''.join(f'{title}:{media_type}\n' for title, media_type, _ in rows),
                                          encoding='utf-8')
    (directory / 'reference').write_text(reference(runtime, lock) + '\n', encoding='ascii')
    return rows


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
    parser.add_argument('--runtime-lock', type=Path, default=ROOT.parent / 'runtime.lock', help='TODO(copy)')
    parser.add_argument('--sources-lock', type=Path, default=ROOT / 'sources.lock', help='TODO(copy)')
    parser.add_argument('--cache', type=Path, default=ROOT / 'cache', help='TODO(copy)')
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument('--plan', action='store_true', help='TODO(copy)')
    mode.add_argument('--check', action='store_true', help='TODO(copy)')
    mode.add_argument('--stage', type=Path, metavar='DIR', help='TODO(copy)')
    args = parser.parse_args(arguments)
    runtime, lock = load_locks(args.runtime_lock, args.sources_lock)
    target = reference(runtime, lock)
    if args.stage is not None:
        (args.cache / 'sources').mkdir(parents=True, exist_ok=True)
        with (args.cache / '.fetch-termux.lock').open('a') as debs, \
                (args.cache / 'sources' / '.sources.lock').open('a') as pins:
            fcntl.flock(debs, fcntl.LOCK_EX)
            fcntl.flock(pins, fcntl.LOCK_EX)
            rows = stage(runtime, lock, args.stage, args.cache)
        size = sum((args.stage / title).stat().st_size for title, _, _ in rows)
        print(json.dumps({'reference': target, 'files': len(rows), 'bytes': size}, sort_keys=True))
    elif args.plan:
        print(json.dumps({'reference': target, 'present': manifest_status(target) == 200}))
    else:
        status = manifest_status(target)
        if status != 200:
            sources.fail('mirror-missing', reference=target, status=status)


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, subprocess.CalledProcessError) as error:
        print('TODO(copy)', file=sys.stderr)
        if isinstance(error, sources.SourceError):
            print(json.dumps({'code': error.code, **error.details}, sort_keys=True, default=str), file=sys.stderr)
        else:
            # package-termux.py's errors carry their reason in plain English, as its own command line prints them.
            print(json.dumps({'code': type(error).__name__, 'message': str(error)}, sort_keys=True), file=sys.stderr)
        sys.exit(1)
