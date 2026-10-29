#!/usr/bin/env python3
"""Pins published Node builds in android/runtime.lock (plan §5.2, task 4.2).

    update-node-digests.py --plan
        Checks the Node entry against the patch directory and prints the build plan:
        {"version", "npm", "patchSet", "abis": {"<abi>": {"repository", "tag", "digest", "pinned"}}, "needsBuild"}.
        needsBuild is true while any ABI's digest is null; a fully pinned lock needs no build.
    update-node-digests.py --published FILE
        FILE holds {"<abi>": {"repository", "tag", "digest": "sha256:<hex>", "sha256": "<hex>", "size": <bytes>}}
        for every ABI in the lock, as the publish job writes it. Fills binaries.<abi>.digest/sha256/size in
        android/runtime.lock (4-space JSON, key order kept, trailing newline) and sets runtimeLockSha256 in
        android/runtime/sources.lock (sources.py's format) to the new lock bytes. Both are checked before either
        file is replaced, and the same input always gives the same bytes.
    update-node-digests.py --reset
        Drops every published pin (binaries.<abi>.digest/sha256/size become null) and recomputes what the Node
        version, sources.lock and the patch directory determine: node.source tag/tarball/tarballSha256,
        node.patchSet, each binaries.<abi>.tag, sources.lock node.patches and runtimeLockSha256. Run it after a
        Node version change (once sources.py --refresh-lock pinned the new source), a patch-series change or a
        build-node.sh change, so that the next staging push builds and publishes again. Prints
        {"changed", "runtimeLockSha256", "tags": {"<abi>": "<tag>"}}.
"""
import argparse
import copy
import hashlib
import importlib.util
import json
import os
import sys
import tempfile
from pathlib import Path

sys.dont_write_bytecode = True

ROOT = Path(__file__).resolve().parent
_SPEC = importlib.util.spec_from_file_location('runtime_fetch_node', ROOT / 'fetch-node.py')
node = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(node)
fail = node.fail
sources = node.sources

PUBLISHED_KEYS = {'repository', 'tag', 'digest', 'sha256', 'size'}


def runtime_bytes(runtime):
    """android/runtime.lock's own format: 4-space indented JSON in key order, ASCII, one trailing newline."""
    return (json.dumps(runtime, indent=4) + '\n').encode('utf-8')


def plan(pins):
    abis = {}
    for abi in pins.abis:
        binary = pins.binary(abi)
        abis[abi] = {'repository': binary['repository'], 'tag': binary['tag'], 'digest': binary['digest'],
                     'pinned': binary['digest'] is not None}
    return {'version': pins.version, 'npm': pins.npm_version, 'patchSet': pins.patch_set, 'abis': abis,
            'needsBuild': not all(item['pinned'] for item in abis.values())}


def updated_locks(pins, published):
    """The new runtime.lock and sources.lock bytes for `published`, checked like the committed locks."""
    if not isinstance(published, dict) or set(published) != set(pins.abis):
        fail('published-abis', expected=pins.abis, actual=sorted(published) if isinstance(published, dict) else None)
    runtime = copy.deepcopy(pins.runtime)
    for abi in pins.abis:
        item = published[abi]
        binary = runtime['node']['binaries'][abi]
        if not isinstance(item, dict) or set(item) != PUBLISHED_KEYS:
            fail('published-entry', abi=abi)
        if item['repository'] != binary['repository'] or item['tag'] != pins.tag(abi):
            fail('published-reference', abi=abi, repository=item['repository'], tag=item['tag'])
        if (not node.OCI_DIGEST.fullmatch(str(item['digest'])) or not node.HASH.fullmatch(str(item['sha256']))
                or not node.is_count(item['size'])):
            fail('published-pin', abi=abi)
        binary.update({'digest': item['digest'], 'sha256': item['sha256'], 'size': item['size']})
    new_runtime = runtime_bytes(runtime)
    lock = copy.deepcopy(pins.sources)
    lock['runtimeLockSha256'] = hashlib.sha256(new_runtime).hexdigest()
    new_sources = sources.json_bytes(lock)
    check_locks(new_runtime, new_sources, pins.patches)
    return new_runtime, new_sources


def check_locks(new_runtime, new_sources, patches):
    """Checks the bytes about to be written like load_pins checks the committed locks."""
    runtime = node.parse_json(new_runtime, 'runtime.lock')
    lock = node.parse_json(new_sources, 'sources.lock')
    sources.validate_sources(lock, runtime, hashlib.sha256(new_runtime).hexdigest())
    if lock.get('node') is None or lock.get('npm') is None:
        fail('node-unpinned')
    node.validate_node(runtime, lock, patches)


def reset_locks(runtime_lock, sources_lock):
    """The locks with every published pin dropped and the derived Node fields recomputed (see --reset). The current
    locks may fail validation, which is why this exists; the result must pass it."""
    runtime = node.parse_json(Path(runtime_lock).read_bytes(), 'runtime.lock')
    lock = node.parse_json(Path(sources_lock).read_bytes(), 'sources.lock')
    patches = Path(runtime_lock).parent.parent / node.PATCH_DIRECTORY
    if not (patches / 'series').is_file():
        fail('node-series-missing')
    series = node.parse_series((patches / 'series').read_text(encoding='utf-8'))
    patch_set = node.patch_set_sha256(patches, series)
    try:
        entry, source = runtime['node'], lock['node']['source']
        version = entry['version']
        entry['source'].update(tag='v' + version, tarball=source['filename'], tarballSha256=source['sha256'])
        entry['patchSet'].update(series=series, sha256=patch_set)
        for abi in runtime['abis']:
            entry['binaries'][abi].update(tag=node.artifact_tag(version, patch_set, abi), digest=None, sha256=None, size=None)
        lock['node']['patches'] = node.patch_pins(patches)
    except (KeyError, TypeError, AttributeError):
        fail('node-reset-input')
    new_runtime = runtime_bytes(runtime)
    lock['runtimeLockSha256'] = hashlib.sha256(new_runtime).hexdigest()
    new_sources = sources.json_bytes(lock)
    check_locks(new_runtime, new_sources, patches)
    return new_runtime, new_sources, {abi: entry['binaries'][abi]['tag'] for abi in sorted(runtime['abis'])}


def write_files(contents):
    """Writes every (path, bytes) pair to a temporary sibling first, then renames them into place."""
    staged = []
    try:
        for path, data in contents:
            with tempfile.NamedTemporaryFile(dir=path.parent, prefix=f'.{path.name}-', delete=False) as stream:
                staged.append((Path(stream.name), path))
                stream.write(data)
                stream.flush()
                os.fsync(stream.fileno())
            Path(stream.name).chmod(0o644)
        for temporary, path in staged:
            temporary.replace(path)
    finally:
        for temporary, _ in staged:
            temporary.unlink(missing_ok=True)


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
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument('--plan', action='store_true', help='TODO(copy)')
    mode.add_argument('--published', type=Path, help='TODO(copy)')
    mode.add_argument('--reset', action='store_true', help='TODO(copy)')
    args = parser.parse_args(arguments)
    if args.reset:
        new_runtime, new_sources, tags = reset_locks(args.runtime_lock, args.sources_lock)
        changed = new_runtime != args.runtime_lock.read_bytes() or new_sources != args.sources_lock.read_bytes()
        if changed:
            write_files([(args.runtime_lock, new_runtime), (args.sources_lock, new_sources)])
        print(json.dumps({'changed': changed, 'runtimeLockSha256': hashlib.sha256(new_runtime).hexdigest(), 'tags': tags},
                         sort_keys=True))
        return
    pins = node.load_pins(args.runtime_lock, args.sources_lock)
    if args.plan:
        print(json.dumps(plan(pins), sort_keys=True))
        return
    published = node.parse_json(args.published.read_bytes(), 'published')
    new_runtime, new_sources = updated_locks(pins, published)
    changed = new_runtime != args.runtime_lock.read_bytes() or new_sources != args.sources_lock.read_bytes()
    if changed:
        write_files([(args.runtime_lock, new_runtime), (args.sources_lock, new_sources)])
    print(json.dumps({'changed': changed, 'runtimeLockSha256': hashlib.sha256(new_runtime).hexdigest(),
                      'abis': {abi: published[abi]['digest'] for abi in pins.abis}}, sort_keys=True))


if __name__ == '__main__':
    try:
        main()
    except (node.NodeError, sources.SourceError) as error:
        print('TODO(copy)', file=sys.stderr)
        print(json.dumps({'code': error.code, **error.details}, sort_keys=True, default=str), file=sys.stderr)
        sys.exit(1)
    except (OSError, ValueError) as error:
        print('TODO(copy)', file=sys.stderr)
        print(json.dumps({'code': type(error).__name__}, sort_keys=True), file=sys.stderr)
        sys.exit(1)
