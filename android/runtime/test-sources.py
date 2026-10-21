#!/usr/bin/env python3
import copy
import gzip
import hashlib
import importlib.util
import io
import json
import os
import shutil
import subprocess
import sys
import tarfile
import tempfile
import unittest
from pathlib import Path
from unittest import mock


sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location('runtime_sources', ROOT / 'sources.py')
sources = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(sources)
NOTICES_SPEC = importlib.util.spec_from_file_location('runtime_notices', ROOT / 'notices.py')
notices = importlib.util.module_from_spec(NOTICES_SPEC)
NOTICES_SPEC.loader.exec_module(notices)
COMMIT = '1' * 40
HISTORY_TIP = '2' * 40
REAL_RUN = subprocess.run
REAL_POPEN = subprocess.Popen


def sha256(contents):
    return hashlib.sha256(contents).hexdigest()


def git_blob(contents):
    return hashlib.sha1(f'blob {len(contents)}\0'.encode('ascii') + contents).hexdigest()


def json_data(value):
    return (json.dumps(value, sort_keys=True, indent=4) + '\n').encode('utf-8')


def gnu_recipe(name, version, source_sha256, patch_sha256):
    header = ('TERMUX_PKG_VERSION=' + version + '\n'
              'TERMUX_PKG_SRCURL="https://mirrors.kernel.org/gnu/' + name + '/' + name
              + '-${TERMUX_PKG_VERSION%.*}.tar.gz"\nTERMUX_PKG_SHA256=' + source_sha256 + '\n')
    checksums = ''.join('\tPATCH_CHECKSUMS[' + number + ']=' + digest + '\n'
                        for number, digest in patch_sha256)
    return header + r'''termux_step_pre_configure() {
    local _MAIN_VERSION="${TERMUX_PKG_VERSION%.*}" _PATCH_VERSION="${TERMUX_PKG_VERSION##*.}"
    (( _PATCH_VERSION == 0 )) && return
    local PATCH_NUM PATCHFILE
    local -A PATCH_CHECKSUMS=()
''' + checksums + r'''
    for PATCH_NUM in $(seq -f '%03g' "${_PATCH_VERSION}"); do
        PATCHFILE=$TERMUX_PKG_CACHEDIR/@NAME@_patch_${PATCH_NUM}.patch
        termux_download \
            "https://mirrors.kernel.org/gnu/@NAME@/@NAME@-${_MAIN_VERSION}-patches/@NAME@${_MAIN_VERSION/./}-$PATCH_NUM" \
            "$PATCHFILE" \
            "${PATCH_CHECKSUMS[$PATCH_NUM]}"
        patch -p0 -i "$PATCHFILE"
    done
}
'''.replace('@NAME@', name)


def tar_bytes(entries, mode='w', metadata=None):
    with io.BytesIO() as stream:
        with tarfile.open(fileobj=stream, mode=mode, format=tarfile.PAX_FORMAT) as archive:
            for kind, name, contents in entries:
                member = tarfile.TarInfo(name)
                member.uid = member.gid = member.mtime = 0
                member.mode = 0o644
                if kind == 'file':
                    member.size = len(contents)
                else:
                    member.type = {
                        'directory': tarfile.DIRTYPE, 'symlink': tarfile.SYMTYPE,
                        'hardlink': tarfile.LNKTYPE, 'fifo': tarfile.FIFOTYPE,
                    }[kind]
                    member.mode = 0o777 if kind == 'symlink' else 0o755
                    if kind in ('symlink', 'hardlink'):
                        member.linkname = contents
                for key, value in (metadata or {}).items():
                    setattr(member, key, value)
                archive.addfile(member, io.BytesIO(contents) if kind == 'file' else None)
        return stream.getvalue()


def no_external_commands(arguments, **kwargs):
    if Path(str(arguments[0])).name != 'zstd':
        raise AssertionError(('unexpected external command', arguments))
    return REAL_RUN(arguments, **kwargs)


def no_external_processes(arguments, **kwargs):
    if not isinstance(arguments, (list, tuple)) or Path(str(arguments[0])).name != 'zstd':
        raise AssertionError(('unexpected external process', arguments))
    return REAL_POPEN(arguments, **kwargs)


class ScratchTestCase(unittest.TestCase):
    def setUp(self):
        cache = ROOT / 'cache'
        cache.mkdir(exist_ok=True)
        scratch = tempfile.TemporaryDirectory(prefix='sources-tests-', dir=cache)
        self.addCleanup(scratch.cleanup)
        self.directory = Path(scratch.name)
        commands = mock.patch.object(sources.subprocess, 'run', side_effect=no_external_commands)
        self.commands = commands.start()
        self.addCleanup(commands.stop)
        processes = mock.patch.object(sources.subprocess, 'Popen', side_effect=no_external_processes)
        processes.start()
        self.addCleanup(processes.stop)

    def assert_source_error(self, code, callback, *arguments, **kwargs):
        with self.assertRaises(sources.SourceError) as error:
            callback(*arguments, **kwargs)
        self.assertEqual(error.exception.code, code)
        return error.exception


class SourceFixture(ScratchTestCase):
    def setUp(self):
        super().setUp()
        self.cache = sources.Cache(self.directory / 'objects', offline=True)
        self.runtime = {
            'schema': 1, 'termux': {'packages': [{'name': 'git', 'version': '1.2.3-2'}]},
            'node': None, 'npm': None, 'bun': None,
        }
        self.runtime_path = self.directory / 'runtime.lock'
        self.sources_path = self.directory / 'sources.lock'
        self.fixture_root = self.directory / 'project' / 'android' / 'runtime'
        self.fixture_root.mkdir(parents=True)
        for name in ('package-termux.py', 'fetch-termux.sh', 'termux-autobuilds.asc', 'sources.py', 'build-sources.sh'):
            (self.fixture_root / name).write_bytes(('fixture ' + name + '\n').encode('ascii'))
        self.runtime_path.write_bytes(json_data(self.runtime))
        upstream = tar_bytes([('file', 'git-1.2.3/COPYING', b'fixture source\n')])
        source = {
            'url': 'https://example.invalid/git-1.2.3.tar', 'sha256': self.cache.store(upstream),
            'filename': 'git-1.2.3.tar',
        }
        recipe = ('TERMUX_PKG_VERSION=1.2.3\nTERMUX_PKG_REVISION=2\n'
                  'TERMUX_PKG_SRCURL=https://example.invalid/git-1.2.3.tar\n'
                  'TERMUX_PKG_SHA256=' + source['sha256'] + '\n').encode('ascii')
        package = {
            'name': 'git', 'version': '1.2.3-2', 'commit': COMMIT, 'recipePath': 'packages/git',
            'evidence': {
                'method': 'first-parent-package-history', 'historyTip': HISTORY_TIP,
                'selected': COMMIT, 'first': COMMIT, 'last': COMMIT, 'before': None,
                'after': HISTORY_TIP, 'matchingDirectoryCommits': 1, 'version': '1.2.3-2',
            },
            'files': [self.file_pin('packages/git/build.sh', recipe, 0o755)],
            'sources': [source], 'sourceStatus': 'upstream-tarballs',
            'license': 'GPL-2.0', 'spdx': 'GPL-2.0-only', 'homepage': 'https://example.invalid/git',
        }
        # Snapshot metadata is separate from unchanged package and upstream pins.
        self.snapshot_files = [
            self.snapshot_pin('build-package.sh', b'#!/bin/sh\nexit 0\n', 0o755),
            self.snapshot_pin('repo.json', b'{"pkg_format":"debian"}\n'),
            self.snapshot_pin('scripts/build.sh', b'fixture build helper\n' + source['sha256'].encode('ascii') + b'\n', 0o755),
            self.snapshot_pin('scripts/properties.sh', b'TERMUX_ARCH=aarch64\n'),
        ]
        self.lock = {
            'schema': 1, 'runtimeLockSha256': sha256(self.runtime_path.read_bytes()),
            'termux': {
                'repository': 'https://github.com/termux/termux-packages', 'historyTip': HISTORY_TIP,
                'packages': [package], 'buildSystems': [{
                    'commit': COMMIT,
                    'selection': [{'reason': 'build-system', 'paths': ['build-package.sh', 'repo.json', 'scripts']}],
                    **sources.snapshot_summary(self.snapshot_files),
                }],
            },
            'node': None, 'npm': None,
        }
        self.save_snapshot()
        self.sources_path.write_bytes(json_data(self.lock))

    def file_pin(self, path, contents, mode=0o644):
        return {
            'path': path, 'sha256': self.cache.store(contents), 'mode': mode, 'type': 'file',
            'url': 'https://raw.githubusercontent.com/termux/termux-packages/' + COMMIT + '/' + path,
        }

    def snapshot_pin(self, path, contents, mode=0o644):
        pin = {
            **self.file_pin(path, contents, mode), 'url': sources.raw_url(COMMIT, path),
            'gitBlob': git_blob(contents), 'size': len(contents),
        }
        if mode == 0o777:
            pin.update({'type': 'symlink', 'target': contents.decode('utf-8')})
        return pin

    def save_snapshot(self):
        self.snapshot_files.sort(key=lambda pin: pin['path'].encode('utf-8'))
        system = self.lock['termux']['buildSystems'][0]
        system.update(sources.snapshot_summary(self.snapshot_files))
        index = sources.snapshot_index_path(system, self.cache)
        index.parent.mkdir(parents=True, exist_ok=True)
        index.write_bytes(sources.snapshot_listing(self.snapshot_files))
        return index

    def save_locks(self):
        self.runtime_path.write_bytes(json_data(self.runtime))
        self.lock['runtimeLockSha256'] = sha256(self.runtime_path.read_bytes())
        self.sources_path.write_bytes(json_data(self.lock))

    def validate(self, lock=None, runtime=None):
        return sources.validate_sources(
            self.lock if lock is None else lock,
            self.runtime if runtime is None else runtime,
            sha256(self.runtime_path.read_bytes()),
        )

    def build(self, name='sources.tar.zst', require_node=False):
        destination = self.directory / name
        with mock.patch.object(sources, 'ROOT', self.fixture_root):
            result = sources.build(self.lock, self.runtime, self.runtime_path, self.sources_path,
                                   self.cache, destination, require_node=require_node)
        return destination, result


class LockTests(SourceFixture):
    def test_minimal_exact_source_and_runtime_pins_are_accepted(self):
        self.assertIsNone(self.validate())

    def test_package_sets_must_match_in_both_directions_without_duplicates(self):
        for change in ('missing-source', 'extra-source', 'extra-runtime', 'duplicate-source', 'renamed-source'):
            with self.subTest(change=change):
                lock, runtime = copy.deepcopy(self.lock), copy.deepcopy(self.runtime)
                if change == 'missing-source':
                    lock['termux']['packages'].clear()
                elif change in ('extra-source', 'duplicate-source'):
                    package = copy.deepcopy(lock['termux']['packages'][0])
                    if change == 'extra-source':
                        package['name'] = 'bash'
                    else:
                        runtime['termux']['packages'].append({'name': 'bash', 'version': '5.3'})
                    lock['termux']['packages'].append(package)
                elif change == 'extra-runtime':
                    runtime['termux']['packages'].append({'name': 'bash', 'version': '5.3'})
                else:
                    lock['termux']['packages'][0]['name'] = 'bash'
                self.assert_source_error('package-set-mismatch', self.validate, lock, runtime)

    def test_version_epoch_and_revision_must_match_exactly(self):
        for version in ('1.2.3', '1.2.3-1', '1:1.2.3-2', 'v1.2.3-2'):
            with self.subTest(version=version):
                lock = copy.deepcopy(self.lock)
                lock['termux']['packages'][0]['version'] = version
                self.assert_source_error('package-version-mismatch', self.validate, lock)

    def test_runtime_lock_byte_hash_is_required(self):
        self.lock['runtimeLockSha256'] = '0' * 64
        self.assert_source_error('runtime-lock-sha256', self.validate)

    def test_invalid_duplicate_runtime_packages_and_non_integer_schemas_are_rejected(self):
        runtime = copy.deepcopy(self.runtime)
        runtime['termux']['packages'] *= 2
        self.assert_source_error('runtime-package-version', self.validate, runtime=runtime)
        for section in ('runtime', 'sources'):
            with self.subTest(section=section):
                lock, runtime = copy.deepcopy(self.lock), copy.deepcopy(self.runtime)
                (runtime if section == 'runtime' else lock)['schema'] = True
                self.assert_source_error(section + '-schema', self.validate, lock, runtime)

    def test_recipe_origin_hash_and_duplicate_file_pins_are_validated(self):
        for change, code in (
            ('origin', 'file-origin-mismatch'), ('hash', 'invalid-pin'),
            ('duplicate', 'duplicate-or-outside-file'), ('outside', 'duplicate-or-outside-file'),
        ):
            with self.subTest(change=change):
                lock = copy.deepcopy(self.lock)
                files = lock['termux']['packages'][0]['files']
                if change == 'origin':
                    files[0]['url'] = files[0]['url'].replace(COMMIT, HISTORY_TIP)
                elif change == 'hash':
                    files[0]['sha256'] = 'not-a-hash'
                elif change == 'duplicate':
                    files.append(copy.deepcopy(files[0]))
                else:
                    files[0]['path'] = 'packages/bash/build.sh'
                self.assert_source_error(code, self.validate, lock)

    def test_recipe_and_complete_build_system_are_required(self):
        for change, code in (
            ('recipe', 'missing-recipe'), ('systems', 'build-system-set-mismatch'),
            ('scripts', 'incomplete-build-system'), ('repo', 'incomplete-build-system'),
            ('entrypoint', 'incomplete-build-system'), ('partial-scripts', 'incomplete-build-system'),
        ):
            with self.subTest(change=change):
                lock = copy.deepcopy(self.lock)
                if change == 'recipe':
                    pin = lock['termux']['packages'][0]['files'][0]
                    pin['path'] = 'packages/git/README'
                    pin['url'] = pin['url'].removesuffix('build.sh') + 'README'
                elif change == 'systems':
                    lock['termux']['buildSystems'].clear()
                else:
                    paths = lock['termux']['buildSystems'][0]['selection'][0]['paths']
                    missing = {'repo': 'repo.json', 'entrypoint': 'build-package.sh'}.get(change, 'scripts')
                    paths.remove(missing)
                    if change == 'partial-scripts':
                        paths.append('scripts/properties.sh')
                self.assert_source_error(code, self.validate, lock)

    def test_missing_range_evidence_and_duplicate_source_filenames_are_rejected(self):
        lock = copy.deepcopy(self.lock)
        del lock['termux']['packages'][0]['evidence']
        self.assert_source_error('missing-range-evidence', self.validate, lock)
        lock = copy.deepcopy(self.lock)
        lock['termux']['packages'][0]['sources'] *= 2
        self.assert_source_error('duplicate-source-filename', self.validate, lock)

    def test_null_node_and_npm_are_valid_but_cannot_disagree_with_runtime(self):
        for key in ('node', 'npm'):
            with self.subTest(key=key):
                lock = copy.deepcopy(self.lock)
                lock[key] = {'version': '1.2.3' if key == 'node' else '11.10.0'}
                self.assert_source_error('runtime-section-mismatch', self.validate, lock)

    def test_json_loader_rejects_duplicate_keys(self):
        path = self.directory / 'duplicate.lock'
        path.write_bytes(b'{"schema": 1, "node": null, "node": {}}')
        self.assert_source_error('duplicate-json-key', sources.load_json, path)


class SnapshotLockTests(SourceFixture):
    def evidence(self, path, file_sha256, commit=COMMIT):
        return {
            'commit': commit, 'path': path, 'fileSha256': file_sha256, 'lines': [1],
            'url': f'https://github.com/termux/termux-packages/blob/{commit}/{path}#L1',
        }

    def test_compact_snapshot_keeps_package_and_upstream_pin_formats(self):
        system = self.lock['termux']['buildSystems'][0]
        self.assertEqual(set(system), {'commit', 'selection', 'sha256', 'fileCount', 'totalBytes'})
        package = self.lock['termux']['packages'][0]
        self.assertEqual(set(package['files'][0]), {'path', 'mode', 'type', 'url', 'sha256'})
        self.assertEqual(set(package['sources'][0]), {'url', 'sha256', 'filename'})
        self.assertIsNone(self.validate())

    def test_legacy_per_file_systems_and_extra_or_missing_snapshot_fields_are_rejected(self):
        for change in ('legacy', 'files', 'paths', 'selection', 'sha256', 'fileCount', 'totalBytes'):
            with self.subTest(change=change):
                lock = copy.deepcopy(self.lock)
                system = lock['termux']['buildSystems'][0]
                if change == 'legacy':
                    system.clear()
                    system.update({'commit': COMMIT, 'files': copy.deepcopy(self.snapshot_files)})
                elif change == 'files':
                    system['files'] = copy.deepcopy(self.snapshot_files)
                elif change == 'paths':
                    system['paths'] = ['build-package.sh', 'repo.json', 'scripts']
                else:
                    del system[change]
                self.assert_source_error('snapshot-schema', self.validate, lock)

    def test_snapshot_digest_requires_exact_lowercase_sha256(self):
        for digest in (None, 64, '', 'a' * 63, 'a' * 65, 'A' * 64, 'g' * 64, 'a' * 64 + '\n'):
            with self.subTest(digest=digest):
                lock = copy.deepcopy(self.lock)
                lock['termux']['buildSystems'][0]['sha256'] = digest
                self.assert_source_error('snapshot-integrity', self.validate, lock)

    def test_snapshot_count_requires_a_positive_integer_without_boolean_coercion(self):
        for count in (None, True, False, 0, -1, 4.0, '4'):
            with self.subTest(count=count):
                lock = copy.deepcopy(self.lock)
                lock['termux']['buildSystems'][0]['fileCount'] = count
                self.assert_source_error('snapshot-file-count', self.validate, lock)

    def test_snapshot_total_bytes_requires_a_nonnegative_integer(self):
        for size in (None, True, False, -1, 1.0, '1'):
            with self.subTest(size=size):
                lock = copy.deepcopy(self.lock)
                lock['termux']['buildSystems'][0]['totalBytes'] = size
                self.assert_source_error('snapshot-total-bytes', self.validate, lock)
        lock = copy.deepcopy(self.lock)
        lock['termux']['buildSystems'][0]['totalBytes'] = 0
        self.assertIsNone(self.validate(lock))

    def test_snapshot_selection_must_be_a_nonempty_list_of_exact_rules(self):
        for selection in (None, {}, 'scripts', [], [None], [{}], [{'reason': 'build-system'}],
                          [{'reason': 'build-system', 'paths': ['scripts'], 'extra': True}]):
            with self.subTest(selection=selection):
                lock = copy.deepcopy(self.lock)
                lock['termux']['buildSystems'][0]['selection'] = selection
                self.assert_source_error('snapshot-selection', self.validate, lock)

    def test_snapshot_selection_reasons_use_lowercase_slug_syntax(self):
        for reason in (None, 1, '', '-build', 'Build-system', 'build_system', 'build system', 'build/system', 'build\n'):
            with self.subTest(reason=reason):
                lock = copy.deepcopy(self.lock)
                lock['termux']['buildSystems'][0]['selection'][0]['reason'] = reason
                self.assert_source_error('snapshot-selection', self.validate, lock)

    def test_snapshot_selection_reasons_and_paths_are_sorted_and_unique(self):
        for change, code in (
            ('reason-order', 'snapshot-selection-order'), ('duplicate-reason', 'snapshot-selection-order'),
            ('path-order', 'snapshot-selection-paths'), ('duplicate-path', 'snapshot-selection-paths'),
            ('cross-reason-path', 'snapshot-selection-paths'),
        ):
            with self.subTest(change=change):
                lock = copy.deepcopy(self.lock)
                selection = lock['termux']['buildSystems'][0]['selection']
                selection.append({'reason': 'recipe-imports', 'paths': ['packages/helper/build.sh']})
                if change == 'reason-order':
                    selection.reverse()
                elif change == 'duplicate-reason':
                    selection[1]['reason'] = selection[0]['reason']
                elif change == 'path-order':
                    selection[0]['paths'].reverse()
                elif change == 'duplicate-path':
                    selection[0]['paths'].append('scripts')
                else:
                    selection[1]['paths'] = ['scripts']
                self.assert_source_error(code, self.validate, lock)

    def test_snapshot_selectors_must_be_nonempty_lists_of_canonical_paths(self):
        for paths in (None, [], {}, 'scripts', ['scripts', 'scripts']):
            with self.subTest(paths=paths):
                lock = copy.deepcopy(self.lock)
                lock['termux']['buildSystems'][0]['selection'][0]['paths'] = paths
                self.assert_source_error('snapshot-selection-paths', self.validate, lock)
        for path in ('', '/scripts', '../scripts', './scripts', 'scripts/', 'scripts//build',
                     'scripts/../other', 'scripts\\build', 'scripts\n'):
            with self.subTest(path=path):
                lock = copy.deepcopy(self.lock)
                lock['termux']['buildSystems'][0]['selection'].append({'reason': 'extra', 'paths': [path]})
                self.assert_source_error('unsafe-path', self.validate, lock)

    def test_snapshot_selectors_treat_glob_characters_as_invalid_path_selectors(self):
        for selector in ('scripts/*', 'packages/lib?.*', 'packages/[ab]/build.sh'):
            with self.subTest(selector=selector):
                lock = copy.deepcopy(self.lock)
                lock['termux']['buildSystems'][0]['selection'].append({
                    'reason': 'extra', 'paths': [selector],
                })
                self.assert_source_error('snapshot-selection-paths', self.validate, lock)

    def test_helper_evidence_is_eligible_by_exact_or_directory_selector_only(self):
        for path, accepted in (
            ('scripts/build.sh', True), ('scripts/nested/helper.sh', True),
            ('packages/helper/build.sh', True), ('packages/helper/build.sh/child', True),
            ('scripts-extra/build.sh', False), ('packages/helper/build.sh-extra', False),
            ('packages/libfoo/build.sh', False),
        ):
            with self.subTest(path=path):
                lock = copy.deepcopy(self.lock)
                lock['termux']['buildSystems'][0]['selection'].append({
                    'reason': 'recipe-imports', 'paths': ['packages/helper/build.sh'],
                })
                lock['termux']['packages'][0]['sources'][0]['evidence'] = self.evidence(path, 'a' * 64)
                if accepted:
                    self.assertIsNone(self.validate(lock))
                else:
                    self.assert_source_error('source-evidence', self.validate, lock)

    def test_helper_evidence_still_requires_matching_commit_and_valid_file_digest(self):
        for change in ('commit', 'digest'):
            with self.subTest(change=change):
                lock = copy.deepcopy(self.lock)
                evidence = self.evidence('scripts/build.sh', 'a' * 64)
                evidence['commit' if change == 'commit' else 'fileSha256'] = HISTORY_TIP if change == 'commit' else 'A' * 64
                lock['termux']['packages'][0]['sources'][0]['evidence'] = evidence
                self.assert_source_error('source-evidence', self.validate, lock)


class SnapshotCanonicalTests(ScratchTestCase):
    def pin(self, path='scripts/helper.sh'):
        return {'path': path, 'mode': 0o644, 'gitBlob': 'a' * 40, 'sha256': 'b' * 64, 'size': 1}

    def test_listing_uses_utf8_path_order_ascii_json_and_one_lf_per_row(self):
        files = [
            {**self.pin('scripts/\U00010000'), 'mode': 0o777, 'size': 5},
            {**self.pin('scripts/z'), 'mode': 0o755, 'size': 2},
            {**self.pin('scripts/\ue000'), 'size': 4},
            {**self.pin('scripts/é'), 'size': 3},
            {**self.pin('scripts/quote"name'), 'size': 1},
            {**self.pin('scripts/A'), 'size': 0},
        ]
        expected = (
            b'["scripts/A",420,"' + b'a' * 40 + b'","' + b'b' * 64 + b'",0]\n'
            + b'["scripts/quote\\\"name",420,"' + b'a' * 40 + b'","' + b'b' * 64 + b'",1]\n'
            + b'["scripts/z",493,"' + b'a' * 40 + b'","' + b'b' * 64 + b'",2]\n'
            + b'["scripts/\\u00e9",420,"' + b'a' * 40 + b'","' + b'b' * 64 + b'",3]\n'
            + b'["scripts/\\ue000",420,"' + b'a' * 40 + b'","' + b'b' * 64 + b'",4]\n'
            + b'["scripts/\\ud800\\udc00",511,"' + b'a' * 40 + b'","' + b'b' * 64 + b'",5]\n'
        )
        original = copy.deepcopy(files)
        self.assertEqual(sources.snapshot_listing(files), expected)
        self.assertEqual(sources.snapshot_listing(list(reversed(files))), expected)
        self.assertEqual(sources.snapshot_summary(files), {'sha256': sha256(expected), 'fileCount': 6, 'totalBytes': 15})
        self.assertEqual(files, original)

    def test_summary_hashes_a_literal_empty_blob_record_including_final_newline(self):
        pin = {
            'path': 'scripts/empty', 'mode': 0o644, 'gitBlob': 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391',
            'sha256': 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', 'size': 0,
        }
        expected = (b'["scripts/empty",420,"e69de29bb2d1d6434b8b29ae775ad8c2e48c5391",'
                    b'"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",0]\n')
        self.assertEqual(sources.snapshot_listing([pin]), expected)
        self.assertEqual(sources.snapshot_summary([pin]), {'sha256': sha256(expected), 'fileCount': 1, 'totalBytes': 0})
        self.assertNotEqual(sources.snapshot_summary([pin])['sha256'], sha256(expected[:-1]))

    def test_every_listed_path_mode_blob_hash_and_size_contributes_to_snapshot_digest(self):
        files = [self.pin()]
        original = sources.snapshot_summary(files)
        for key, value in (('path', 'scripts/other.sh'), ('mode', 0o755), ('gitBlob', 'c' * 40),
                           ('sha256', 'd' * 64), ('size', 2)):
            with self.subTest(field=key):
                changed = [{**files[0], key: value}]
                self.assertNotEqual(sources.snapshot_summary(changed)['sha256'], original['sha256'])

    def test_listing_rejects_invalid_mode_and_size_types(self):
        for key, values, code in (
            ('mode', (None, True, False, 0o600, 0o100644, '644'), 'snapshot-mode'),
            ('size', (None, True, False, -1, 1.0, '1'), 'snapshot-file-size'),
        ):
            for value in values:
                with self.subTest(field=key, value=value):
                    self.assert_source_error(code, sources.snapshot_listing, [{**self.pin(), key: value}])

    def test_listing_requires_lowercase_blob_and_sha256_integrity_fields(self):
        for key, values in (
            ('gitBlob', (None, '', 'a' * 39, 'a' * 41, 'A' * 40, 'g' * 40)),
            ('sha256', (None, '', 'b' * 63, 'b' * 65, 'B' * 64, 'g' * 64)),
        ):
            for value in values:
                with self.subTest(field=key, value=value):
                    self.assert_source_error('snapshot-file-integrity', sources.snapshot_listing, [{**self.pin(), key: value}])

    def test_listing_rejects_duplicate_and_unsafe_paths(self):
        self.assert_source_error('snapshot-duplicate-path', sources.snapshot_listing, [self.pin(), self.pin()])
        for path in ('../escape', '/absolute', 'scripts/./helper.sh', 'scripts\\helper.sh', 'scripts/helper\n'):
            with self.subTest(path=path):
                self.assert_source_error('unsafe-path', sources.snapshot_listing, [self.pin(path)])


class SnapshotCacheTests(SourceFixture):
    def setUp(self):
        super().setUp()
        self.system = self.lock['termux']['buildSystems'][0]
        self.index = sources.snapshot_index_path(self.system, self.cache)

    def write_index(self, contents):
        self.system['sha256'] = sha256(contents)
        path = sources.snapshot_index_path(self.system, self.cache)
        path.write_bytes(contents)
        return path

    def test_cached_snapshot_reconstructs_authenticated_pins_online_and_offline_without_history(self):
        self.assertEqual(self.index, self.cache.directory.parent / 'snapshots' / (self.system['sha256'] + '.jsonl'))
        for offline in (False, True):
            with self.subTest(offline=offline), mock.patch.object(sources, 'history_repository') as history:
                self.cache.offline = offline
                self.assertEqual(sources.build_system_files(self.system, self.cache), self.snapshot_files)
                history.assert_not_called()
        self.commands.assert_not_called()

    def test_corrupt_cached_index_is_rejected_before_listed_objects_or_history_are_used(self):
        files = copy.deepcopy(self.snapshot_files)
        files[2] = self.snapshot_pin('scripts/build.sh', b'tampered build helper\n', 0o755)
        corrupted = sources.snapshot_listing(files)
        self.index.write_bytes(corrupted)
        for offline in (False, True):
            with self.subTest(offline=offline):
                self.cache.offline = offline
                with mock.patch.object(self.cache, 'fetch_all') as fetch, mock.patch.object(self.cache, 'get') as get, \
                        mock.patch.object(sources, 'history_repository') as history:
                    self.assert_source_error('snapshot-mismatch', sources.build_system_files, self.system, self.cache)
                fetch.assert_not_called()
                get.assert_not_called()
                history.assert_not_called()
                self.assertEqual(self.index.read_bytes(), corrupted)
        self.commands.assert_not_called()

    def test_authenticated_but_noncanonical_index_is_rejected_before_fetch(self):
        canonical = self.index.read_bytes()
        for change, contents in (
            ('row-order', b''.join(reversed(canonical.splitlines(keepends=True)))),
            ('spaces', canonical.replace(b',', b', ')),
            ('crlf', canonical.replace(b'\n', b'\r\n')),
            ('missing-final-lf', canonical[:-1]),
        ):
            with self.subTest(change=change):
                self.write_index(contents)
                with mock.patch.object(self.cache, 'fetch_all') as fetch, mock.patch.object(self.cache, 'get') as get:
                    self.assert_source_error('snapshot-index-canonical', sources.build_system_files, self.system, self.cache)
                fetch.assert_not_called()
                get.assert_not_called()
        self.commands.assert_not_called()

    def test_authenticated_malformed_index_rows_are_rejected_before_fetch(self):
        for row in ({}, None, [], ['scripts/build.sh'], ['a', 420, 'b' * 40, 'c' * 64, 1, 'extra']):
            with self.subTest(row=row):
                self.write_index((json.dumps(row, separators=(',', ':')) + '\n').encode('ascii'))
                with mock.patch.object(self.cache, 'fetch_all') as fetch, mock.patch.object(self.cache, 'get') as get:
                    self.assert_source_error('snapshot-index-row', sources.build_system_files, self.system, self.cache)
                fetch.assert_not_called()
                get.assert_not_called()

    def test_authenticated_invalid_json_is_rejected_before_fetch(self):
        self.write_index(b'["scripts/build.sh",\n')
        with mock.patch.object(self.cache, 'fetch_all') as fetch, mock.patch.object(self.cache, 'get') as get:
            with self.assertRaises(ValueError):
                sources.build_system_files(self.system, self.cache)
        fetch.assert_not_called()
        get.assert_not_called()
        self.commands.assert_not_called()

    def test_cached_index_count_and_total_bytes_are_checked_before_fetch(self):
        for field in ('fileCount', 'totalBytes'):
            with self.subTest(field=field):
                system = {**self.system, field: self.system[field] + 1}
                with mock.patch.object(self.cache, 'fetch_all') as fetch, mock.patch.object(self.cache, 'get') as get:
                    self.assert_source_error('snapshot-mismatch', sources.build_system_files, system, self.cache)
                fetch.assert_not_called()
                get.assert_not_called()
        self.commands.assert_not_called()

    def test_offline_snapshot_index_miss_does_not_use_objects_or_history(self):
        self.index.unlink()
        with mock.patch.object(self.cache, 'fetch_all') as fetch, mock.patch.object(self.cache, 'get') as get, \
                mock.patch.object(sources, 'history_repository') as history:
            self.assert_source_error('offline-snapshot-miss', sources.build_system_files, self.system, self.cache)
        fetch.assert_not_called()
        get.assert_not_called()
        history.assert_not_called()
        self.commands.assert_not_called()

    def test_symlinked_snapshot_index_is_rejected_without_reading_or_fetching(self):
        outside = self.directory / 'outside-index'
        contents = self.index.read_bytes()
        outside.write_bytes(contents)
        self.index.unlink()
        self.index.symlink_to(outside)
        with mock.patch.object(self.cache, 'fetch_all') as fetch, mock.patch.object(self.cache, 'get') as get:
            self.assert_source_error('unsafe-snapshot-index', sources.build_system_files, self.system, self.cache)
        fetch.assert_not_called()
        get.assert_not_called()
        self.assertEqual(outside.read_bytes(), contents)
        self.commands.assert_not_called()

    def test_nonregular_snapshot_index_fails_without_blocking_or_fetching(self):
        with tempfile.TemporaryDirectory(prefix='snapshot-index-fifo-') as temporary:
            cache = sources.Cache(Path(temporary) / 'objects', offline=True)
            index = sources.snapshot_index_path(self.system, cache)
            index.parent.mkdir()
            try:
                os.mkfifo(index)
            except OSError as error:
                self.skipTest(f'FIFO creation unsupported: {error}')
            with mock.patch.object(cache, 'fetch_all') as fetch, mock.patch.object(cache, 'get') as get:
                self.assert_source_error('unsafe-snapshot-index', sources.build_system_files, self.system, cache)
            fetch.assert_not_called()
            get.assert_not_called()
        self.commands.assert_not_called()

    def test_corrupt_cached_snapshot_file_is_not_repaired_online_or_offline(self):
        pin = self.snapshot_files[2]
        path = self.cache.directory / pin['sha256']
        path.write_bytes(b'corrupt cached build helper\n')
        for offline in (False, True):
            with self.subTest(offline=offline), mock.patch.object(sources, 'history_repository') as history:
                self.cache.offline = offline
                self.assert_source_error('sha256-mismatch', sources.build_system_files, self.system, self.cache)
                self.assertEqual(path.read_bytes(), b'corrupt cached build helper\n')
                history.assert_not_called()
        self.commands.assert_not_called()

    def test_offline_cached_index_still_requires_every_snapshot_object(self):
        pin = self.snapshot_files[2]
        (self.cache.directory / pin['sha256']).unlink()
        self.assert_source_error('offline-cache-miss', sources.build_system_files, self.system, self.cache)
        self.assertTrue(self.index.is_file())
        self.commands.assert_not_called()

    def test_original_summary_rejects_changed_mode_blob_hash_and_size_before_object_fetch(self):
        for field, value in (('mode', 0o644), ('gitBlob', '0' * 40), ('sha256', '0' * 64), ('size', 999)):
            with self.subTest(field=field):
                files = copy.deepcopy(self.snapshot_files)
                files[2][field] = value
                with mock.patch.object(self.cache, 'fetch_all') as fetch, mock.patch.object(self.cache, 'get') as get:
                    self.assert_source_error('snapshot-mismatch', sources.check_snapshot, self.system, files, self.cache)
                fetch.assert_not_called()
                get.assert_not_called()
        self.commands.assert_not_called()

    def test_authenticated_index_blob_and_size_must_match_actual_cached_bytes(self):
        original = copy.deepcopy(self.snapshot_files)
        for field, value in (('gitBlob', '0' * 40), ('size', self.snapshot_files[2]['size'] + 1)):
            with self.subTest(field=field):
                self.snapshot_files = copy.deepcopy(original)
                self.snapshot_files[2][field] = value
                self.save_snapshot()
                self.assert_source_error('snapshot-file-mismatch', sources.build_system_files, self.system, self.cache)
        self.commands.assert_not_called()

    def test_authenticated_replacement_sha256_cannot_bypass_original_git_blob(self):
        pin = self.snapshot_files[2]
        original = (self.cache.directory / pin['sha256']).read_bytes()
        replacement = b'X' * len(original)
        pin['sha256'] = self.cache.store(replacement)
        self.save_snapshot()
        self.assert_source_error('snapshot-file-mismatch', sources.build_system_files, self.system, self.cache)
        self.commands.assert_not_called()

    def test_snapshot_selection_rejects_unselected_paths_and_empty_selectors(self):
        for change in ('outside', 'prefix-collision', 'selector-prefix-collision',
                       'missing-selected-file', 'missing-properties'):
            with self.subTest(change=change):
                system = copy.deepcopy(self.system)
                files = copy.deepcopy(self.snapshot_files)
                if change == 'missing-selected-file':
                    system['selection'].append({'reason': 'extra', 'paths': ['packages/helper/build.sh']})
                elif change == 'missing-properties':
                    files = [pin for pin in files if pin['path'] != 'scripts/properties.sh']
                else:
                    path = {'outside': 'packages/unselected/build.sh', 'prefix-collision': 'scripts-extra/helper.sh',
                            'selector-prefix-collision': 'packages/helper/build.sh-extra'}[change]
                    if change == 'selector-prefix-collision':
                        system['selection'].append({'reason': 'extra', 'paths': ['packages/helper/build.sh']})
                    files.append(self.snapshot_pin(path, b'not selected\n'))
                files.sort(key=lambda pin: pin['path'].encode('utf-8'))
                system.update(sources.snapshot_summary(files))
                with mock.patch.object(self.cache, 'fetch_all') as fetch, mock.patch.object(self.cache, 'get') as get:
                    self.assert_source_error('snapshot-selection-mismatch', sources.check_snapshot, system, files, self.cache)
                fetch.assert_not_called()
                get.assert_not_called()
        self.commands.assert_not_called()

    def test_symlink_snapshot_uses_raw_utf8_target_bytes_for_blob_hash_and_size(self):
        target = 'é-build.sh'
        self.snapshot_files.extend([
            self.snapshot_pin('scripts/' + target, b'fixture symlink destination\n'),
            self.snapshot_pin('scripts/alias', target.encode('utf-8'), 0o777),
        ])
        self.save_snapshot()
        files = sources.build_system_files(self.system, self.cache)
        pin = next(pin for pin in files if pin['path'] == 'scripts/alias')
        self.assertEqual(pin['target'], target)
        self.assertEqual(pin['size'], 11)
        self.assertEqual(pin['sha256'], sha256(b'\xc3\xa9-build.sh'))
        self.assertEqual(pin['gitBlob'], git_blob(b'\xc3\xa9-build.sh'))
        self.assertEqual(pin['mode'], 0o777)
        self.assertEqual(files, self.snapshot_files)
        self.commands.assert_not_called()

    def test_online_snapshot_miss_authenticates_tree_and_publishes_reusable_index(self):
        self.index.unlink()
        self.cache.offline = False
        with mock.patch.object(sources, 'history_repository', return_value=(self.directory / 'history', HISTORY_TIP)) as history, \
                mock.patch.object(sources, 'pin_tree', return_value=copy.deepcopy(self.snapshot_files)) as tree:
            self.assertEqual(sources.build_system_files(self.system, self.cache), self.snapshot_files)
        history.assert_called_once()
        tree.assert_called_once()
        self.assertEqual(self.index.read_bytes(), sources.snapshot_listing(self.snapshot_files))
        self.cache.offline = True
        self.assertEqual(sources.build_system_files(self.system, self.cache), self.snapshot_files)
        self.commands.assert_not_called()


class CacheTests(ScratchTestCase):
    def test_recorded_gzip_recovery_requires_both_transport_and_original_archive_hashes(self):
        cache = sources.Cache(self.directory / 'objects')
        payload = b'fixture exact archive contents\n' * 64
        transport = gzip.compress(payload, compresslevel=9, mtime=0)
        recovered = bytearray(gzip.compress(payload, compresslevel=6, mtime=0))
        recovered[9] = 3
        recovered = bytes(recovered)
        transport_hash = cache.store(transport)
        expected = sha256(recovered)
        recovery = {'url': 'https://example.invalid/changed.tar.gz', 'sha256': transport_hash,
                    'format': 'gzip', 'level': 6, 'mtime': 0}
        pin = {'url': 'https://example.invalid/original.tar.gz', 'sha256': expected,
               'filename': 'original.tar.gz', 'recovery': recovery}
        with mock.patch.object(sources, 'EXACT_GZIP_RECOVERIES', {expected: recovery}):
            path = cache.get_pin(pin)
            self.assertEqual(path.read_bytes(), recovered)
            self.assertEqual(sources.digest(path), expected)
            path.unlink()
            (cache.directory / transport_hash).write_bytes(b'corrupt transport')
            self.assert_source_error('sha256-mismatch', cache.get_pin, pin)
            self.assertFalse(path.exists())
        self.commands.assert_not_called()

    def test_gzip_recovery_does_not_repair_corrupt_existing_objects_or_offline_misses(self):
        cache = sources.Cache(self.directory / 'objects', offline=True)
        pin = {'url': 'https://example.invalid/original.tar.gz', 'sha256': 'a' * 64,
               'recovery': {'url': 'https://example.invalid/transport.tar.gz', 'sha256': 'b' * 64}}
        self.assert_source_error('offline-cache-miss', cache.get_pin, pin)
        path = cache.directory / pin['sha256']
        path.write_bytes(b'corrupt original archive')
        self.assert_source_error('sha256-mismatch', cache.get_pin, pin)
        self.assertEqual(path.read_bytes(), b'corrupt original archive')
        self.commands.assert_not_called()

    def test_corrupt_cached_source_or_recipe_fails_without_redownload(self):
        cache = sources.Cache(self.directory / 'objects')
        for label in ('upstream.tar.xz', 'build.sh'):
            with self.subTest(input=label):
                expected = sha256(label.encode())
                destination = cache.directory / expected
                destination.write_bytes(b'corrupt cache contents')
                self.assert_source_error('sha256-mismatch', cache.get,
                                         'https://example.invalid/' + label, expected)
                self.assertEqual(destination.read_bytes(), b'corrupt cache contents')
        self.commands.assert_not_called()

    def test_verified_cache_is_reused_and_offline_miss_never_downloads(self):
        cache = sources.Cache(self.directory / 'objects', offline=True)
        expected = cache.store(b'pinned source contents')
        path = cache.get('https://example.invalid/source.tar', expected)
        self.assertEqual(path.read_bytes(), b'pinned source contents')
        self.assert_source_error('offline-cache-miss', cache.get,
                                 'https://example.invalid/missing.tar', '0' * 64)
        self.commands.assert_not_called()

    def test_only_credential_free_https_urls_are_accepted_even_when_cached(self):
        cache = sources.Cache(self.directory / 'objects')
        expected = cache.store(b'pinned source contents')
        for url in (
            'http://example.invalid/source.tar', 'ftp://example.invalid/source.tar',
            'file:///etc/passwd', '//example.invalid/source.tar', 'https:///source.tar',
            'https://user:pass@example.invalid/source.tar', 'https://example.invalid/source.tar#fragment',
            'https://example.invalid/with space.tar', 'https://example.invalid/line\n.tar',
            'https://example.invalid/part\\source.tar',
        ):
            with self.subTest(url=url):
                self.assert_source_error('invalid-https-url', cache.get, url, expected)
        self.commands.assert_not_called()

    def test_download_enforces_https_redirects_and_verifies_before_publication(self):
        cache = sources.Cache(self.directory / 'objects')
        contents = b'pinned source contents'
        expected = sha256(contents)
        calls = []

        def curl(arguments, **kwargs):
            calls.append([str(item) for item in arguments])
            Path(arguments[arguments.index('--output') + 1]).write_bytes(contents)
            return subprocess.CompletedProcess(arguments, 0, stdout=b'', stderr=b'')

        with mock.patch.object(sources, 'require_tools'), mock.patch.object(sources.subprocess, 'run', side_effect=curl):
            path = cache.get('https://example.invalid/source.tar', expected)
        self.assertEqual(path.read_bytes(), contents)
        self.assertEqual(len(calls), 1)
        arguments = calls[0]
        self.assertEqual(arguments[arguments.index('--proto') + 1], '=https')
        self.assertEqual(arguments[arguments.index('--proto-redir') + 1], '=https')
        self.assertIn('--tlsv1.2', arguments)
        self.assertEqual(list(cache.directory.iterdir()), [path])

    def test_tampered_download_is_not_published_and_partial_file_is_removed(self):
        cache = sources.Cache(self.directory / 'objects')
        expected = sha256(b'pinned contents')

        def curl(arguments, **kwargs):
            Path(arguments[arguments.index('--output') + 1]).write_bytes(b'tampered contents')
            return subprocess.CompletedProcess(arguments, 0, stdout=b'', stderr=b'')

        with mock.patch.object(sources, 'require_tools'), mock.patch.object(sources.subprocess, 'run', side_effect=curl):
            self.assert_source_error('sha256-mismatch', cache.get,
                                     'https://example.invalid/source.tar', expected)
        self.assertEqual(list(cache.directory.iterdir()), [])

    def test_symlink_cache_object_is_rejected_without_following_it(self):
        cache = sources.Cache(self.directory / 'objects')
        outside = self.directory / 'outside'
        outside.write_bytes(b'pinned contents')
        expected = sha256(outside.read_bytes())
        (cache.directory / expected).symlink_to(outside)
        self.assert_source_error('unsafe-cache-object', cache.get,
                                 'https://example.invalid/source.tar', expected)
        self.assertEqual(outside.read_bytes(), b'pinned contents')
        self.commands.assert_not_called()


class ArchivePathTests(ScratchTestCase):
    def inspect(self, entries):
        path = self.directory / 'upstream.tar'
        path.write_bytes(tar_bytes(entries))
        return sources.inspect_tar(path)

    def test_archive_paths_reject_traversal_absolute_and_noncanonical_names(self):
        for name in (
            '', '/absolute', '../escape', 'root/../../escape', 'root/../data',
            './data', 'root/./data', 'root//data', 'root/data/', 'root\\data',
            'C:/data', 'root/data\0suffix', 'root/data\n',
        ):
            with self.subTest(name=name):
                self.assert_source_error('unsafe-path', sources.safe_path, name)

    def test_upstream_tar_accepts_confined_relative_symlinks_and_hardlinks(self):
        entries = self.inspect([
            ('directory', './root/', b''), ('file', './root/data', b'source'),
            ('directory', 'root/subdir/', b''), ('symlink', 'root/subdir/alias', '../data'),
            ('hardlink', 'root/copy', './root/data'),
        ])
        self.assertEqual(entries, {
            'root': 'directory', 'root/data': 'file', 'root/subdir': 'directory',
            'root/subdir/alias': 'symlink', 'root/copy': 'hardlink',
        })
        self.assertEqual(sources.safe_link('root/subdir/alias', '../data'), 'root/data')

    def test_upstream_tar_rejects_escaping_members_links_and_special_files(self):
        for entry, code in (
            (('file', '../escape', b'data'), 'unsafe-path'),
            (('file', '/absolute', b'data'), 'unsafe-path'),
            (('file', 'root/../escape', b'data'), 'unsafe-path'),
            (('symlink', 'root/link', '/etc/passwd'), 'unsafe-link'),
            (('symlink', 'root/link', '../../escape'), 'unsafe-path'),
            (('symlink', 'root/link', '..\\escape'), 'unsafe-link'),
            (('hardlink', 'root/link', '../escape'), 'unsafe-path'),
            (('hardlink', 'root/link', '/etc/passwd'), 'unsafe-path'),
            (('fifo', 'root/pipe', b''), 'unsupported-tar-member'),
        ):
            with self.subTest(entry=entry):
                self.assert_source_error(code, self.inspect, [entry])

    def test_upstream_tar_rejects_duplicates_after_dot_prefix_normalization(self):
        self.assert_source_error('duplicate-tar-member', self.inspect, [
            ('file', 'root/data', b'first'), ('file', './root/data', b'second'),
        ])

    def test_upstream_tar_rejects_hidden_members_after_its_zero_terminators(self):
        contents = bytearray(tar_bytes([('file', 'root/data', b'data')]))
        hidden = tarfile.TarInfo('../hidden')
        hidden.size = 4
        payload = hidden.tobuf() + b'EVIL' + b'\0' * 508
        contents[2048:2048 + len(payload)] = payload
        path = self.directory / 'hidden.tar'
        path.write_bytes(contents)
        self.assert_source_error('archive-trailing-data', sources.inspect_tar, path)

    def test_upstream_tar_rejects_file_and_symlink_parents_in_either_order(self):
        for parent in (('symlink', 'root/alias', 'target'), ('file', 'root/alias', b'data')):
            for reverse in (False, True):
                with self.subTest(parent=parent[0], reverse=reverse):
                    entries = [parent, ('file', 'root/alias/child', b'child')]
                    self.assert_source_error('tar-member-parent', self.inspect,
                                             list(reversed(entries)) if reverse else entries)

    def test_members_reject_duplicate_reserved_and_escaping_paths(self):
        members = sources.Members()
        members.add('root/data', contents=b'first')
        for name, code in (
            ('root/data', 'duplicate-archive-member'), ('MANIFEST.json', 'duplicate-archive-member'),
            ('../escape', 'unsafe-path'), ('/absolute', 'unsafe-path'),
        ):
            with self.subTest(name=name):
                self.assert_source_error(code, members.add, name, contents=b'second')

    def test_members_accept_relative_file_directory_and_chain_symlinks(self):
        members = sources.Members()
        members.add('root/data', contents=b'data')
        members.add('root/subdir/file', contents=b'nested')
        members.add('root/alias', target='data')
        members.add('root/chain', target='alias')
        members.add('root/directory', target='subdir')
        self.assertIsNone(members.check())

    def test_members_reject_dangling_and_cyclic_links(self):
        for links, code in (
            ([('root/alias', 'missing')], 'archive-link-missing'),
            ([('root/alias', 'alias')], 'archive-link-cycle'),
            ([('root/first', 'second'), ('root/second', 'first')], 'archive-link-cycle'),
        ):
            with self.subTest(links=links):
                members = sources.Members()
                for name, target in links:
                    members.add(name, target=target)
                self.assert_source_error(code, members.check)

    def test_members_reject_file_or_symlink_as_archive_path_parent(self):
        for target in (None, 'data'):
            with self.subTest(target=target):
                members = sources.Members()
                members.add('root/data', contents=b'data')
                members.add('root/parent', contents=b'parent', target=target)
                members.add('root/parent/child', contents=b'child')
                self.assert_source_error('archive-member-parent', members.check)

    def test_symlink_intermediate_components_are_resolved_before_parent_segments(self):
        entries = [
            ('directory', 'root', b''), ('directory', 'root/inner', b''),
            ('file', 'root/data', b'data'), ('file', 'data', b'root-level data'),
            ('symlink', 'root/inner/up', '..'),
            ('symlink', 'root/inner/alias', 'up/../data'),
        ]
        self.assertEqual(self.inspect(entries)['root/inner/alias'], 'symlink')
        members = sources.Members()
        for kind, name, contents in entries:
            if kind == 'file':
                members.add(name, contents=contents)
            elif kind == 'symlink':
                members.add(name, target=contents)
        self.assertIsNone(members.check())

    def test_lexically_confined_symlink_cannot_escape_via_another_symlink(self):
        entries = [
            ('directory', 'root', b''), ('directory', 'root/inner', b''),
            ('file', 'root/data', b'data'), ('file', 'data', b'root-level data'),
            ('symlink', 'root/inner/up', '..'),
            ('symlink', 'root/inner/alias', 'up/../../data'),
        ]
        self.assert_source_error('unsafe-link', self.inspect, entries)
        members = sources.Members()
        for kind, name, contents in entries:
            if kind == 'file':
                members.add(name, contents=contents)
            elif kind == 'symlink':
                members.add(name, target=contents)
        self.assert_source_error('unsafe-link', members.check)

    def test_members_reject_symlink_input_files(self):
        regular = self.directory / 'regular'
        regular.write_bytes(b'contents')
        link = self.directory / 'link'
        link.symlink_to(regular)
        self.assert_source_error('unsafe-input', sources.Members().add, 'payload/data', path=link)

    def test_members_reject_input_files_beneath_symlink_parents(self):
        directory = self.directory / 'regular'
        directory.mkdir()
        (directory / 'data').write_bytes(b'contents')
        link = self.directory / 'link'
        link.symlink_to(directory, target_is_directory=True)
        with self.assertRaises(sources.SourceError):
            sources.Members().add('payload/data', path=link / 'data')


@unittest.skipUnless(shutil.which('zstd'), 'zstd')
class ArchiveBuildTests(SourceFixture):
    def unpack(self, path):
        result = REAL_RUN(['zstd', '--decompress', '--quiet', '--stdout', str(path)],
                          check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        return tarfile.open(fileobj=io.BytesIO(result.stdout), mode='r:')

    def pack(self, contents, name='tampered.tar.zst'):
        path = self.directory / name
        with path.open('wb') as output:
            REAL_RUN(['zstd', '--single-thread', '-1', '--check', '--quiet', '--stdout'],
                     input=contents, stdout=output, stderr=subprocess.PIPE, check=True)
        return path

    def test_clean_and_offline_builds_are_byte_identical_with_normalized_metadata(self):
        first, first_result = self.build('first.tar.zst')
        for path in self.cache.directory.iterdir():
            os.utime(path, (1234567890, 1234567890))
        self.cache.offline = False
        second, second_result = self.build('second.tar.zst')
        self.cache.offline = True
        third, third_result = self.build('offline.tar.zst')
        self.assertEqual(first.read_bytes(), second.read_bytes())
        self.assertEqual(first.read_bytes(), third.read_bytes())
        self.assertEqual(first_result['sha256'], sha256(first.read_bytes()))
        self.assertEqual(first_result['sha256'], second_result['sha256'])
        self.assertEqual(first_result['sha256'], third_result['sha256'])
        executable_names = {
            'termux/' + COMMIT + '/build-package.sh', 'termux/' + COMMIT + '/packages/git/build.sh',
            'termux/' + COMMIT + '/scripts/build.sh',
        }
        with self.unpack(first) as archive:
            members = archive.getmembers()
            self.assertEqual([member.name for member in members], sorted(member.name for member in members))
            for member in members:
                with self.subTest(member=member.name):
                    self.assertEqual((member.mtime, member.uid, member.gid, member.uname, member.gname),
                                     (0, 0, 0, '', ''))
                    expected = 0o755 if member.name in executable_names else 0o644
                    self.assertEqual(member.mode, expected)
            manifest = json.load(archive.extractfile('MANIFEST.json'))
            records = {record['path']: record for record in manifest['members']}
            self.assertEqual(set(records), {member.name for member in members} - {'MANIFEST.json'})
            self.assertEqual(set(records), executable_names | {
                'termux/' + COMMIT + '/repo.json', 'termux/' + COMMIT + '/scripts/properties.sh',
                'upstream/git/git-1.2.3.tar',
            })
            for name, record in records.items():
                with self.subTest(record=name):
                    contents = archive.extractfile(name).read()
                    self.assertEqual(record['sha256'], sha256(contents))
                    self.assertEqual(record['size'], len(contents))
            self.assertEqual(records['upstream/git/git-1.2.3.tar']['origin'], {
                'url': 'https://example.invalid/git-1.2.3.tar', 'commit': COMMIT,
            })
        self.assertEqual(manifest['runtimeLockSha256'], sha256(self.runtime_path.read_bytes()))
        self.assertEqual(manifest['sourcesLockSha256'], sha256(self.sources_path.read_bytes()))
        self.assertEqual(manifest['compression'], {'format': 'zstd', 'level': 19, 'threads': 1})
        self.assertEqual(manifest['node'], {'status': 'not-bundled-yet'})
        self.assertEqual(manifest['npm'], {'status': 'not-bundled-yet'})
        self.assertEqual(manifest['nodePatches'], {'status': 'no-patches', 'files': []})
        self.assertEqual(sources.verify_archive(first), manifest)
        self.assertTrue(all(Path(str(call.args[0][0])).name == 'zstd' for call in self.commands.call_args_list))

    def test_strict_node_gate_fails_before_fetch_and_preserves_previous_output(self):
        output = self.directory / 'sources.tar.zst'
        output.write_bytes(b'previous verified archive')
        self.assert_source_error('node-and-npm-required', self.build, require_node=True)
        self.assertEqual(output.read_bytes(), b'previous verified archive')
        self.commands.assert_not_called()

    def test_tampered_cached_source_or_recipe_preserves_previous_output(self):
        output = self.directory / 'sources.tar.zst'
        for key in ('files', 'sources'):
            with self.subTest(input=key):
                pin = self.lock['termux']['packages'][0][key][0]
                cached = self.cache.directory / pin['sha256']
                original = cached.read_bytes()
                output.write_bytes(b'previous verified archive')
                try:
                    cached.write_bytes(b'corrupted cached input')
                    self.assert_source_error('sha256-mismatch', self.build)
                    self.assertEqual(output.read_bytes(), b'previous verified archive')
                finally:
                    cached.write_bytes(original)
        self.commands.assert_not_called()

    def assert_snapshot_change_preserves_previous_output(self, files):
        system = self.lock['termux']['buildSystems'][0]
        original = copy.deepcopy(system)
        index = sources.snapshot_index_path(system, self.cache)
        changed_listing = sources.snapshot_listing(files)
        files.sort(key=lambda pin: pin['path'].encode('utf-8'))
        self.assertNotEqual(sources.snapshot_summary(files), {
            key: original[key] for key in ('sha256', 'fileCount', 'totalBytes')
        })
        output = self.directory / 'sources.tar.zst'
        self.cache.offline = False
        for location in ('cached-index', 'fetched-tree'):
            with self.subTest(location=location):
                output.write_bytes(b'previous verified archive')
                if location == 'cached-index':
                    index.write_bytes(changed_listing)
                else:
                    index.unlink()
                with mock.patch.object(sources, 'history_repository', return_value=(self.directory / 'history', HISTORY_TIP)) as history, \
                        mock.patch.object(sources, 'pin_tree', return_value=copy.deepcopy(files)) as tree:
                    self.assert_source_error('snapshot-mismatch', self.build)
                self.assertEqual(output.read_bytes(), b'previous verified archive')
                self.assertEqual(system, original)
                if location == 'cached-index':
                    history.assert_not_called()
                    tree.assert_not_called()
                    self.assertEqual(index.read_bytes(), changed_listing)
                else:
                    history.assert_called_once()
                    tree.assert_called_once()
                    self.assertFalse(index.exists())
        self.commands.assert_not_called()

    def test_changed_snapshot_file_with_recomputed_pins_rejects_original_summary_and_preserves_output(self):
        files = copy.deepcopy(self.snapshot_files)
        original = (self.cache.directory / files[2]['sha256']).read_bytes()
        files[2] = self.snapshot_pin('scripts/build.sh', original.replace(b'fixture', b'changed'), 0o755)
        self.assertEqual(files[2]['size'], self.snapshot_files[2]['size'])
        self.assertEqual([pin['path'] for pin in files], [pin['path'] for pin in self.snapshot_files])
        self.assert_snapshot_change_preserves_previous_output(files)

    def test_added_snapshot_file_rejects_original_summary_and_preserves_output(self):
        files = copy.deepcopy(self.snapshot_files)
        files.append(self.snapshot_pin('scripts/extra-helper.sh', b'added selected build helper\n', 0o755))
        self.assert_snapshot_change_preserves_previous_output(files)

    def test_removed_snapshot_file_rejects_original_summary_and_preserves_output(self):
        files = [copy.deepcopy(pin) for pin in self.snapshot_files if pin['path'] != 'scripts/build.sh']
        self.assert_snapshot_change_preserves_previous_output(files)

    def test_bad_cached_snapshot_listing_never_fetches_any_listing_derived_object(self):
        system = self.lock['termux']['buildSystems'][0]
        index = sources.snapshot_index_path(system, self.cache)
        files = copy.deepcopy(self.snapshot_files)
        files[2] = self.snapshot_pin('scripts/build.sh', b'untrusted listing object\n', 0o755)
        (self.cache.directory / files[2]['sha256']).unlink()
        index.write_bytes(sources.snapshot_listing(files))
        self.cache.offline = False
        output = self.directory / 'sources.tar.zst'
        output.write_bytes(b'previous verified archive')
        with mock.patch.object(self.cache, 'fetch_all', wraps=self.cache.fetch_all) as fetch, \
                mock.patch.object(sources, 'history_repository') as history:
            self.assert_source_error('snapshot-mismatch', self.build)
        expected = self.lock['termux']['packages'][0]['files'] + self.lock['termux']['packages'][0]['sources']
        fetch.assert_called_once_with(expected)
        history.assert_not_called()
        self.assertFalse((self.cache.directory / files[2]['sha256']).exists())
        self.assertEqual(output.read_bytes(), b'previous verified archive')
        self.commands.assert_not_called()

    def test_offline_snapshot_index_miss_preserves_previous_output_without_history(self):
        system = self.lock['termux']['buildSystems'][0]
        sources.snapshot_index_path(system, self.cache).unlink()
        output = self.directory / 'sources.tar.zst'
        output.write_bytes(b'previous verified archive')
        with mock.patch.object(sources, 'history_repository') as history:
            self.assert_source_error('offline-snapshot-miss', self.build)
        self.assertEqual(output.read_bytes(), b'previous verified archive')
        history.assert_not_called()
        self.commands.assert_not_called()

    def test_selected_helper_source_evidence_is_checked_against_actual_snapshot_bytes(self):
        helper = self.snapshot_files[2]
        source = self.lock['termux']['packages'][0]['sources'][0]
        evidence = {
            'commit': COMMIT, 'path': helper['path'], 'fileSha256': '0' * 64, 'lines': [1],
            'url': f'https://github.com/termux/termux-packages/blob/{COMMIT}/{helper["path"]}#L1',
        }
        source['evidence'] = evidence
        self.save_locks()
        self.assertIsNone(self.validate())
        output = self.directory / 'sources.tar.zst'
        output.write_bytes(b'previous verified archive')
        self.assert_source_error('source-evidence', self.build)
        self.assertEqual(output.read_bytes(), b'previous verified archive')
        evidence['fileSha256'] = helper['sha256']
        evidence['lines'] = [999]
        evidence['url'] = evidence['url'].rsplit('#L', 1)[0] + '#L999'
        self.save_locks()
        self.assert_source_error('source-evidence-lines', self.build)
        self.assertEqual(output.read_bytes(), b'previous verified archive')
        evidence['lines'] = [2]
        evidence['url'] = evidence['url'].rsplit('#L', 1)[0] + '#L2'
        self.save_locks()
        built, _ = self.build()
        manifest = sources.verify_archive(built)
        records = {record['path']: record for record in manifest['members']}
        self.assertEqual(records[f'termux/{COMMIT}/{helper["path"]}']['sha256'], helper['sha256'])

    def test_selected_helper_without_claimed_checksum_cannot_supply_evidence(self):
        helper = self.snapshot_files[3]
        self.lock['termux']['packages'][0]['sources'][0]['evidence'] = {
            'commit': COMMIT, 'path': helper['path'], 'fileSha256': helper['sha256'], 'lines': [1],
            'url': f'https://github.com/termux/termux-packages/blob/{COMMIT}/{helper["path"]}#L1',
        }
        self.save_locks()
        self.assertIsNone(self.validate())
        output = self.directory / 'sources.tar.zst'
        output.write_bytes(b'previous verified archive')
        self.assert_source_error('source-evidence-lines', self.build)
        self.assertEqual(output.read_bytes(), b'previous verified archive')
        self.commands.assert_not_called()

    def test_recipe_version_and_upstream_pins_must_agree_with_recipe_bytes(self):
        original = copy.deepcopy(self.lock)
        for change, code in (('version', 'recipe-version-mismatch'), ('source', 'recipe-sources-mismatch')):
            with self.subTest(change=change):
                self.lock = copy.deepcopy(original)
                package = self.lock['termux']['packages'][0]
                pin = package['files'][0]
                contents = (self.cache.directory / pin['sha256']).read_bytes()
                if change == 'version':
                    contents = contents.replace(b'1.2.3', b'1.2.4', 1)
                else:
                    contents = contents.replace(b'example.invalid', b'other.invalid')
                pin['sha256'] = self.cache.store(contents)
                self.save_locks()
                self.assert_source_error(code, self.build)
        self.commands.assert_not_called()

    def test_lock_objects_must_match_the_files_read_for_building(self):
        self.runtime_path.write_bytes(json_data({**self.runtime, 'extra': True}))
        self.assert_source_error('lock-changed-during-read', self.build)
        self.commands.assert_not_called()

    def test_lock_cannot_omit_gnu_hook_patch_downloads_from_corresponding_sources(self):
        package = self.lock['termux']['packages'][0]
        package.update({'name': 'bash', 'version': '5.3.2', 'recipePath': 'packages/bash'})
        package['evidence']['version'] = '5.3.2'
        self.runtime['termux']['packages'] = [{'name': 'bash', 'version': '5.3.2'}]
        base = b'fixture GNU bash source\n'
        patch1, patch2 = b'fixture GNU patch 001\n', b'fixture GNU patch 002\n'
        base_sha256 = self.cache.store(base)
        checksums = [('001', self.cache.store(patch1)), ('002', self.cache.store(patch2))]
        recipe = gnu_recipe('bash', '5.3.2', base_sha256, checksums).encode('ascii')
        package['files'] = [self.file_pin('packages/bash/build.sh', recipe, 0o755)]
        package['sources'] = [{
            'url': 'https://mirrors.kernel.org/gnu/bash/bash-5.3.tar.gz',
            'sha256': base_sha256, 'filename': 'bash-5.3.tar.gz',
        }]
        self.save_locks()
        self.assert_source_error('recipe-sources-mismatch', self.build)
        self.commands.assert_not_called()

    def test_member_insertion_order_does_not_change_archive_bytes_and_symlinks_are_normalized(self):
        entries = [
            ('root/z-last', {'contents': b'last'}),
            ('root/bin/tool', {'contents': b'#!/bin/sh\n', 'mode': 0o755}),
            ('root/a-first', {'contents': b'first'}),
            ('root/tool', {'target': 'bin/tool'}),
        ]
        outputs = []
        for index, ordered in enumerate((entries, list(reversed(entries)))):
            members = sources.Members()
            for name, options in ordered:
                members.add(name, **options)
            work = self.directory / f'work-{index}'
            work.mkdir()
            path = self.directory / f'order-{index}.tar.zst'
            members.write(path, {'schema': 1, 'runtimeLockSha256': 'a' * 64}, work)
            outputs.append(path)
        self.assertEqual(outputs[0].read_bytes(), outputs[1].read_bytes())
        with self.unpack(outputs[0]) as archive:
            link = archive.getmember('root/tool')
            self.assertTrue(link.issym())
            self.assertEqual((link.linkname, link.mode, link.uid, link.gid, link.mtime),
                             ('bin/tool', 0o777, 0, 0, 0))
            self.assertEqual(archive.getmember('root/bin/tool').mode, 0o755)
            self.assertEqual(archive.getmember('root/a-first').mode, 0o644)

    def test_verifier_rejects_changed_content_manifest_hash_size_mode_and_origin(self):
        original, _ = self.build()
        with self.unpack(original) as archive:
            entries = [('file', member.name, archive.extractfile(member).read()) for member in archive]
        for change, code in (
            ('content', 'manifest-digest'), ('sha256', 'manifest-digest'), ('size', 'manifest-digest'),
            ('mode', 'manifest-digest'), ('origin', 'invalid-https-url'), ('missing-record', 'manifest-members'),
            ('duplicate-record', 'manifest-member'), ('record-order', 'manifest-order'),
        ):
            with self.subTest(change=change):
                modified = copy.deepcopy(entries)
                manifest_index = next(index for index, item in enumerate(modified) if item[1] == 'MANIFEST.json')
                manifest = json.loads(modified[manifest_index][2])
                if change == 'content':
                    index = next(index for index, item in enumerate(modified) if item[1].endswith('git-1.2.3.tar'))
                    kind, name, _ = modified[index]
                    modified[index] = (kind, name, b'tampered upstream archive')
                elif change in ('sha256', 'size', 'mode'):
                    manifest['members'][0][change] = {'sha256': '0' * 64, 'size': -1, 'mode': 0o600}[change]
                elif change == 'origin':
                    manifest['members'][0]['origin']['url'] = 'http://example.invalid/source'
                elif change == 'duplicate-record':
                    manifest['members'][1] = copy.deepcopy(manifest['members'][0])
                elif change == 'record-order':
                    manifest['members'].reverse()
                else:
                    manifest['members'].pop()
                modified[manifest_index] = ('file', 'MANIFEST.json', json_data(manifest))
                # Preserve the original modes so each mutation exercises its intended check.
                with io.BytesIO() as stream:
                    with self.unpack(original) as reference, tarfile.open(fileobj=stream, mode='w') as rewritten:
                        for _, name, contents in modified:
                            member = copy.copy(reference.getmember(name))
                            member.size = len(contents)
                            rewritten.addfile(member, io.BytesIO(contents))
                    tampered = self.pack(stream.getvalue())
                self.assert_source_error(code, sources.verify_archive, tampered)

    def test_verifier_rejects_unsafe_duplicate_unsorted_or_non_normalized_archive_members(self):
        for entries, metadata, code in (
            ([('file', '../escape', b'data')], None, 'unsafe-path'),
            ([('file', 'a', b'first'), ('file', 'a', b'second')], None, 'unsorted-or-duplicate-archive'),
            ([('file', 'z', b'last'), ('file', 'a', b'first')], None, 'unsorted-or-duplicate-archive'),
            ([('file', 'a', b'data')], {'mtime': 1}, 'archive-metadata'),
            ([('file', 'a', b'data')], {'uid': 1}, 'archive-metadata'),
            ([('file', 'a', b'data')], {'gid': 1}, 'archive-metadata'),
            ([('file', 'a', b'data')], {'mode': 0o600}, 'archive-mode'),
        ):
            with self.subTest(code=code, metadata=metadata, entries=entries):
                path = self.pack(tar_bytes(entries, metadata=metadata))
                self.assert_source_error(code, sources.verify_archive, path)

    def test_verifier_checks_zstd_frame_checksum_and_rejects_trailing_data(self):
        original, _ = self.build()
        contents = original.read_bytes()
        corrupted = self.directory / 'corrupted-frame.tar.zst'
        corrupted.write_bytes(contents[:-1] + bytes([contents[-1] ^ 1]))
        with self.assertRaises((sources.SourceError, tarfile.TarError)):
            sources.verify_archive(corrupted)
        with self.unpack(original) as archive:
            stream = archive.fileobj.getvalue()
        trailing = self.pack(stream + b'non-tar trailing data')
        self.assert_source_error('archive-trailing-data', sources.verify_archive, trailing)

    def test_verifier_rejects_hidden_members_and_nonzero_bytes_inside_tar_padding(self):
        original, _ = self.build()
        with self.unpack(original) as archive:
            data = archive.fileobj.getvalue()
            end = max(member.offset_data + (member.size + 511) // 512 * 512 for member in archive)
        hidden = tarfile.TarInfo('../hidden')
        hidden.size = 4
        payloads = (b'EVIL', hidden.tobuf() + b'EVIL' + b'\0' * 508)
        for payload in payloads:
            with self.subTest(payloadBytes=len(payload)):
                changed = bytearray(data)
                position = end + 1024
                if len(changed) < position + len(payload):
                    changed.extend(b'\0' * (position + len(payload) - len(changed)))
                changed[position:position + len(payload)] = payload
                self.assert_source_error('archive-trailing-data', sources.verify_archive,
                                         self.pack(bytes(changed)))

    def test_verifier_requires_two_complete_zero_terminator_records(self):
        original, _ = self.build()
        with self.unpack(original) as archive:
            data = archive.fileobj.getvalue()
            end = max(member.offset_data + (member.size + 511) // 512 * 512 for member in archive)
        for padding in (b'', b'\0' * 512, b'\0' * 1025):
            with self.subTest(paddingBytes=len(padding)):
                self.assert_source_error('archive-terminator', sources.verify_archive,
                                         self.pack(data[:end] + padding))


class RecipeTests(ScratchTestCase):
    def test_ca_certificate_epoch_and_exact_sed_date_expansion_are_parsed_without_execution(self):
        recipe = r'''TERMUX_PKG_HOMEPAGE=https://curl.se/docs/caextract.html
TERMUX_PKG_LICENSE="MPL-2.0"
TERMUX_PKG_VERSION="1:2026.10.20"
TERMUX_PKG_SRCURL=https://curl.se/ca/cacert-$(sed 's/\./-/g' <<< ${TERMUX_PKG_VERSION:2}).pem
TERMUX_PKG_SHA256=796f1389bfea13c0ed78f663b765baaff54a508e5483786bd6ece73c5e3e3cbe
'''
        self.assertEqual(sources.recipe_version(recipe), '1:2026.10.20')
        pins, _ = sources.recipe_sources(recipe)
        self.assertEqual(pins, [{
            'url': 'https://curl.se/ca/cacert-2026-10-20.pem',
            'filename': 'cacert-2026-10-20.pem',
            'sha256': '796f1389bfea13c0ed78f663b765baaff54a508e5483786bd6ece73c5e3e3cbe',
        }])
        self.commands.assert_not_called()

    def test_ca_hook_download_is_pinned_and_primary_source_download_is_not_duplicated(self):
        recipe = r'''TERMUX_PKG_VERSION="1:2026.10.20"
TERMUX_PKG_SRCURL=https://curl.se/ca/cacert-$(sed 's/\./-/g' <<< ${TERMUX_PKG_VERSION:2}).pem
TERMUX_PKG_SHA256=796f1389bfea13c0ed78f663b765baaff54a508e5483786bd6ece73c5e3e3cbe
termux_step_make_install() {
    termux_download $TERMUX_PKG_SRCURL \
        $CERTFILE \
        $TERMUX_PKG_SHA256
    termux_download \
        https://github.com/use-sparingly/keyutil/releases/download/0.4.0/keyutil-0.4.0.jar \
        $KEYUTIL_JAR \
        18f1d2c82839d84949b1ad015343c509e81ef678c24db6112acc6c0761314610
}
'''
        pins, _ = sources.recipe_sources(recipe)
        self.assertEqual(len(pins), 2)
        self.assertEqual(pins[0]['filename'], 'cacert-2026-10-20.pem')
        self.assertEqual(pins[1], {
            'url': 'https://github.com/use-sparingly/keyutil/releases/download/0.4.0/keyutil-0.4.0.jar',
            'sha256': '18f1d2c82839d84949b1ad015343c509e81ef678c24db6112acc6c0761314610',
            'filename': 'keyutil-0.4.0.jar',
        })
        self.commands.assert_not_called()

    def test_ncurses_imports_use_pinned_recipe_reader_and_preserve_primary_array_version(self):
        recipe = '''_SNAPSHOT_COMMIT=5f58399b2de47ed14bdfe3a0cb149293b27893d5
TERMUX_PKG_VERSION=(6.6.20260307+really6.5.20250830
                    9.31
                    "$(. "$TERMUX_SCRIPTDIR/x11-packages/kitty/build.sh"; echo "$TERMUX_PKG_VERSION")"
                    "$(. "$TERMUX_SCRIPTDIR/x11-packages/alacritty/build.sh"; echo "$TERMUX_PKG_VERSION")"
                    "$(. "$TERMUX_SCRIPTDIR/x11-packages/foot/build.sh"; echo "$TERMUX_PKG_VERSION")")
TERMUX_PKG_SRCURL=("https://github.com/ThomasDickey/ncurses-snapshots/archive/${_SNAPSHOT_COMMIT}.tar.gz"
                   "https://dist.schmorp.de/rxvt-unicode/Attic/rxvt-unicode-${TERMUX_PKG_VERSION[1]}.tar.bz2"
                   "$(. "$TERMUX_SCRIPTDIR/x11-packages/kitty/build.sh"; echo "$TERMUX_PKG_SRCURL")"
                   "$(. "$TERMUX_SCRIPTDIR/x11-packages/alacritty/build.sh"; echo "$TERMUX_PKG_SRCURL")"
                   "$(. "$TERMUX_SCRIPTDIR/x11-packages/foot/build.sh"; echo "$TERMUX_PKG_SRCURL")")
TERMUX_PKG_SHA256=(28cd102efe6a2610e830cc79cf270da6ff0427b2022900a9a36d2761522f9576
                   aaa13fcbc149fe0f3f391f933279580f74a96fd312d6ed06b8ff03c2d46672e8
                   "$(. "$TERMUX_SCRIPTDIR/x11-packages/kitty/build.sh"; echo "$TERMUX_PKG_SHA256")"
                   "$(. "$TERMUX_SCRIPTDIR/x11-packages/alacritty/build.sh"; echo "$TERMUX_PKG_SHA256")"
                   "$(. "$TERMUX_SCRIPTDIR/x11-packages/foot/build.sh"; echo "$TERMUX_PKG_SHA256")")
'''
        imported = {
            'x11-packages/kitty/build.sh': '''TERMUX_PKG_VERSION=0.46.2
TERMUX_PKG_SRCURL="https://github.com/kovidgoyal/kitty/releases/download/v${TERMUX_PKG_VERSION}/kitty-${TERMUX_PKG_VERSION}.tar.xz"
TERMUX_PKG_SHA256=e8ea44b13a1c70032a35128a8c4c8c29c90a7cfbe0ad4f6aa2927a057d10f83e
''',
            'x11-packages/alacritty/build.sh': '''TERMUX_PKG_VERSION=0.16.1
TERMUX_PKG_SRCURL="https://github.com/alacritty/alacritty/archive/refs/tags/v${TERMUX_PKG_VERSION}.tar.gz"
TERMUX_PKG_SHA256=b7240df4a52c004470977237a276185fc97395d59319480d67cad3c4347f395e
''',
            'x11-packages/foot/build.sh': '''TERMUX_PKG_VERSION=1.26.1
TERMUX_PKG_SRCURL=https://codeberg.org/dnkl/foot/archive/${TERMUX_PKG_VERSION}.tar.gz
TERMUX_PKG_SHA256=2213a78b773c1f87bc503fcc2914d1f3474e9aaa2cb7fc92ec5dba4867ab71e0
''',
        }
        self.assertEqual(sources.recipe_version(recipe), '6.6.20260307+really6.5.20250830')
        pins, variables = sources.recipe_sources(recipe, imported.__getitem__)
        self.assertEqual(variables['TERMUX_PKG_VERSION'], [
            '6.6.20260307+really6.5.20250830', '9.31', '0.46.2', '0.16.1', '1.26.1',
        ])
        self.assertEqual(pins, [
            {'url': 'https://github.com/ThomasDickey/ncurses-snapshots/archive/5f58399b2de47ed14bdfe3a0cb149293b27893d5.tar.gz',
             'filename': '5f58399b2de47ed14bdfe3a0cb149293b27893d5.tar.gz',
             'sha256': '28cd102efe6a2610e830cc79cf270da6ff0427b2022900a9a36d2761522f9576'},
            {'url': 'https://dist.schmorp.de/rxvt-unicode/Attic/rxvt-unicode-9.31.tar.bz2',
             'filename': 'rxvt-unicode-9.31.tar.bz2',
             'sha256': 'aaa13fcbc149fe0f3f391f933279580f74a96fd312d6ed06b8ff03c2d46672e8'},
            {'url': 'https://github.com/kovidgoyal/kitty/releases/download/v0.46.2/kitty-0.46.2.tar.xz',
             'filename': 'kitty-0.46.2.tar.xz',
             'sha256': 'e8ea44b13a1c70032a35128a8c4c8c29c90a7cfbe0ad4f6aa2927a057d10f83e'},
            {'url': 'https://github.com/alacritty/alacritty/archive/refs/tags/v0.16.1.tar.gz',
             'filename': 'v0.16.1.tar.gz',
             'sha256': 'b7240df4a52c004470977237a276185fc97395d59319480d67cad3c4347f395e'},
            {'url': 'https://codeberg.org/dnkl/foot/archive/1.26.1.tar.gz',
             'filename': '1.26.1.tar.gz',
             'sha256': '2213a78b773c1f87bc503fcc2914d1f3474e9aaa2cb7fc92ec5dba4867ab71e0'},
        ])
        self.assert_source_error('unresolved-recipe-import', sources.recipe_sources, recipe)
        self.commands.assert_not_called()

    def test_gnu_hook_downloads_include_every_numbered_patch_without_running_loop(self):
        for name, version, source_hash, checksums, expected in (
            ('bash', '5.3.2', '0d5cd86965f869a26cf64f4b71be7b96f90a3ba8b3d74e27e8e9d9d5550f31ba', [
                ('001', '1f608434364af86b9b45c8b0ea3fb3b165fb830d27697e6cdfc7ac17dee3287f'),
                ('002', 'e385548a00130765ec7938a56fbdca52447ab41fabc95a25f19ade527e282001'),
            ], ['bash-5.3.tar.gz', 'bash53-001', 'bash53-002']),
            ('readline', '8.3.2', 'fe5383204467828cd495ee8d1d3c037a7eba1389c22bc6a041f627976f9061cc', [
                ('001', '21f0a03106dbe697337cd25c70eb0edbaa2bdb6d595b45f83285cdd35bac84de'),
                ('002', 'e27364396ba9f6debf7cbaaf1a669e2b2854241ae07f7eca74ca8a8ba0c97472'),
            ], ['readline-8.3.tar.gz', 'readline83-001', 'readline83-002']),
        ):
            with self.subTest(package=name):
                pins, _ = sources.recipe_sources(gnu_recipe(name, version, source_hash, checksums))
                self.assertEqual([pin['filename'] for pin in pins], expected)
                self.assertEqual([pin['sha256'] for pin in pins], [source_hash, checksums[0][1], checksums[1][1]])
                self.assertEqual(pins[1]['url'], 'https://mirrors.kernel.org/gnu/' + name
                                 + '/' + name + '-' + version.rsplit('.', 1)[0] + '-patches/' + expected[1])
        self.commands.assert_not_called()

    def test_gnu_missing_duplicate_and_excess_patch_checksums_fail_closed(self):
        for checksums in (
            [('001', 'a' * 64)],
            [('001', 'a' * 64), ('001', 'b' * 64), ('002', 'c' * 64)],
            [('001', 'a' * 64), ('002', 'b' * 64), ('003', 'c' * 64)],
        ):
            with self.subTest(checksums=checksums):
                recipe = gnu_recipe('bash', '5.3.2', 'd' * 64, checksums)
                self.assert_source_error('patch-checksum-count', sources.recipe_sources, recipe)
        self.commands.assert_not_called()

    def test_unpinned_hook_network_commands_are_rejected_without_execution(self):
        for command in ('curl https://example.invalid/unpinned', 'wget https://example.invalid/unpinned',
                        'git clone https://example.invalid/unpinned'):
            with self.subTest(command=command):
                recipe = ('TERMUX_PKG_VERSION=1.2.3\ntermux_step_pre_configure() {\n    '
                          + command + '\n}\n')
                self.assert_source_error('unsupported-recipe-download', sources.recipe_sources, recipe)
        self.commands.assert_not_called()

    def test_libandroid_version_array_and_indexed_source_urls_are_parsed(self):
        recipe = '''TERMUX_PKG_VERSION=(29
                    4)
TERMUX_PKG_REVISION=1
TERMUX_PKG_LICENSE_FILE="LICENSE.txt, wcwidth-${TERMUX_PKG_VERSION[1]}/LICENSE.txt"
TERMUX_PKG_SRCURL=(https://github.com/termux/libandroid-support/archive/refs/tags/v${TERMUX_PKG_VERSION[0]}.tar.gz
                   https://github.com/termux/wcwidth/archive/refs/tags/v${TERMUX_PKG_VERSION[1]}.tar.gz)
TERMUX_PKG_SHA256=(8f74ce0f9cf70ec29f548696c248cac0ba560a2d8916a0fe1cf9316d5f167a80
                   08489e00f797ffb3b71f9c1894c83e5ebe12c90a2ee0e1f9dc7c6eb29a2ff1a8)
'''
        self.assertEqual(sources.recipe_version(recipe), '29-1')
        pins, variables = sources.recipe_sources(recipe)
        self.assertEqual(pins, [
            {'url': 'https://github.com/termux/libandroid-support/archive/refs/tags/v29.tar.gz',
             'filename': 'v29.tar.gz', 'sha256': '8f74ce0f9cf70ec29f548696c248cac0ba560a2d8916a0fe1cf9316d5f167a80'},
            {'url': 'https://github.com/termux/wcwidth/archive/refs/tags/v4.tar.gz',
             'filename': 'v4.tar.gz', 'sha256': '08489e00f797ffb3b71f9c1894c83e5ebe12c90a2ee0e1f9dc7c6eb29a2ff1a8'},
        ])
        self.assertEqual(variables['TERMUX_PKG_LICENSE_FILE'], 'LICENSE.txt, wcwidth-4/LICENSE.txt')
        self.commands.assert_not_called()

    def test_epoch_revision_defaults_and_embedded_epoch_are_preserved(self):
        for recipe, expected in (
            ('TERMUX_PKG_VERSION=1.2.3\n', '1.2.3'),
            ('TERMUX_PKG_VERSION=1.2.3\nTERMUX_PKG_REVISION=4\n', '1.2.3-4'),
            ('TERMUX_PKG_VERSION=1.2.3\nTERMUX_PKG_EPOCH=2\n', '2:1.2.3'),
            ('TERMUX_PKG_VERSION=1.2.3\nTERMUX_PKG_EPOCH=2\nTERMUX_PKG_REVISION=4\n', '2:1.2.3-4'),
            ('TERMUX_PKG_VERSION=2:1.2.3\nTERMUX_PKG_EPOCH=2\nTERMUX_PKG_REVISION=4\n', '2:1.2.3-4'),
            ('TERMUX_PKG_VERSION="6.6.20260307+really6.5.20250830"\n', '6.6.20260307+really6.5.20250830'),
            ('TERMUX_PKG_VERSION=1.0-beta\n', '1.0-beta-0'),
            ('TERMUX_PKG_VERSION=1.0-beta\nTERMUX_PKG_REVISION=0\n', '1.0-beta-0'),
            ('TERMUX_PKG_VERSION=1.0-beta\nTERMUX_PKG_EPOCH=2\n', '2:1.0-beta-0'),
            ('TERMUX_PKG_VERSION=1.0-beta\nTERMUX_PKG_REVISION=4\n', '1.0-beta-4'),
        ):
            with self.subTest(recipe=recipe):
                self.assertEqual(sources.recipe_version(recipe), expected)
        self.commands.assert_not_called()

    def test_recipe_variables_expand_source_arrays_without_executing_recipe_functions(self):
        recipe = '''TERMUX_PKG_VERSION=1.2.3
TERMUX_PKG_EPOCH=1
TERMUX_PKG_REVISION=7
_MAJOR=${TERMUX_PKG_VERSION%%.*}
_ROOT=https://example.invalid/releases/${_MAJOR}
TERMUX_PKG_SRCURL=(
    "${_ROOT}/pkg-${TERMUX_PKG_VERSION}.tar.xz"
    "${_ROOT}/patch-${TERMUX_PKG_VERSION//./_}.tar.gz" # second input
)
TERMUX_PKG_SHA256=(
    ''' + 'A' * 64 + '''
    ''' + 'b' * 64 + '''
)
termux_step_pre_configure() {
    touch should-never-exist
}
'''
        pins, variables = sources.recipe_sources(recipe)
        self.assertEqual(pins, [
            {'url': 'https://example.invalid/releases/1/pkg-1.2.3.tar.xz',
             'sha256': 'a' * 64, 'filename': 'pkg-1.2.3.tar.xz'},
            {'url': 'https://example.invalid/releases/1/patch-1_2_3.tar.gz',
             'sha256': 'b' * 64, 'filename': 'patch-1_2_3.tar.gz'},
        ])
        self.assertEqual(variables['_MAJOR'], '1')
        self.assertEqual(sources.recipe_version(recipe), '1:1.2.3-7')
        self.commands.assert_not_called()

    def test_forward_variables_slices_and_literal_replacements_are_resolved(self):
        recipe = '''TERMUX_PKG_VERSION=${_VERSION}
_VERSION=3.4.5
_TAG=v${_VERSION}
_SHORT=${_VERSION:0:3}
TERMUX_PKG_SRCURL="https://example.invalid/${_TAG#v}/${_SHORT}/pkg-${_VERSION/./_}.tar.xz"
TERMUX_PKG_SHA256=''' + 'c' * 64 + '\n'
        pins, _ = sources.recipe_sources(recipe)
        self.assertEqual(sources.recipe_version(recipe), '3.4.5')
        self.assertEqual(pins[0]['url'], 'https://example.invalid/3.4.5/3.4/pkg-3_4.5.tar.xz')

    def test_http_recipe_url_is_upgraded_and_original_recorded_without_fetching(self):
        pins, _ = sources.recipe_sources('TERMUX_PKG_SRCURL=http://example.invalid/source.tar\n'
                                         'TERMUX_PKG_SHA256=' + 'd' * 64 + '\n')
        self.assertEqual(pins, [{
            'url': 'https://example.invalid/source.tar', 'sha256': 'd' * 64,
            'filename': 'source.tar', 'recipeUrl': 'http://example.invalid/source.tar',
        }])
        self.commands.assert_not_called()

    def test_executable_or_unresolved_recipe_sources_and_versions_are_rejected(self):
        marker = self.directory / 'executed'
        for expression in ('$(touch ' + str(marker) + ')', '`touch ' + str(marker) + '`', '${MISSING}'):
            with self.subTest(expression=expression):
                recipe = 'TERMUX_PKG_VERSION="' + expression + '"\n'
                self.assert_source_error('unresolved-recipe-version', sources.recipe_version, recipe)
                recipe = ('TERMUX_PKG_SRCURL="https://example.invalid/' + expression + '.tar"\n'
                          'TERMUX_PKG_SHA256=' + 'e' * 64 + '\n')
                self.assert_source_error('unresolved-recipe-sources', sources.recipe_sources, recipe)
                self.assertFalse(marker.exists())
        self.commands.assert_not_called()

    def test_missing_checksums_skip_checksums_and_unsafe_source_names_fail_closed(self):
        for recipe, code in (
            ('TERMUX_PKG_SRCURL=https://example.invalid/source.tar\n', 'recipe-source-checksum-count'),
            ('TERMUX_PKG_SRCURL=https://example.invalid/source.tar\nTERMUX_PKG_SHA256=SKIP\n', 'invalid-pin'),
            ('TERMUX_PKG_SRCURL=ftp://example.invalid/source.tar\nTERMUX_PKG_SHA256=' + 'f' * 64, 'invalid-https-url'),
            ('TERMUX_PKG_SRCURL=https://example.invalid/%2e%2e\nTERMUX_PKG_SHA256=' + 'f' * 64, 'unsafe-path'),
            ('TERMUX_PKG_SRCURL=https://example.invalid/a%2fb.tar\nTERMUX_PKG_SHA256=' + 'f' * 64, 'source-filename'),
        ):
            with self.subTest(recipe=recipe):
                self.assert_source_error(code, sources.recipe_sources, recipe)

    def test_negative_or_non_numeric_epoch_and_revision_are_rejected(self):
        for variable in ('TERMUX_PKG_EPOCH', 'TERMUX_PKG_REVISION'):
            for value in ('-1', 'bad', '(1 2)'):
                with self.subTest(variable=variable, value=value):
                    recipe = 'TERMUX_PKG_VERSION=1.2.3\n' + variable + '=' + value + '\n'
                    self.assert_source_error('invalid-recipe-version', sources.recipe_version, recipe)


class HistoryTests(ScratchTestCase):
    def history(self, states):
        def git(arguments, **kwargs):
            values = [str(item) for item in arguments]
            if values[0] != 'git':
                raise AssertionError(values)
            if 'log' in values:
                self.assertIn('--first-parent', values)
                self.assertEqual(values[-2:], ['--', 'packages/git'])
                return subprocess.CompletedProcess(values, 0, stdout='\n'.join(states) + ('\n' if states else ''))
            if 'show' in values:
                if '-s' in values:
                    if '--format=%s' in values:
                        return subprocess.CompletedProcess(values, 0, stdout='fixture package directory change\n')
                    if '--format=%B' in values:
                        return subprocess.CompletedProcess(values, 0, stdout='fixture package directory change\n')
                    self.assertIn('--format=%P', values)
                    commits = list(states)
                    index = commits.index(values[-1])
                    parent = commits[index + 1] if index + 1 < len(commits) else ''
                    return subprocess.CompletedProcess(values, 0, stdout=parent + ('\n' if parent else ''))
                commit, path = values[-1].split(':', 1)
                self.assertEqual(path, 'packages/git/build.sh')
                contents = states[commit]
                if contents is None:
                    raise subprocess.CalledProcessError(128, values, stderr=b'missing recipe')
                return subprocess.CompletedProcess(values, 0, stdout=contents.encode('utf-8'))
            raise AssertionError(values)
        return mock.patch.object(sources.subprocess, 'run', side_effect=git)

    def test_latest_directory_commit_in_matching_range_includes_patch_only_touch(self):
        commits = [str(index) * 40 for index in range(9, 2, -1)]
        newer, boundary, patch_only, first, before, older_match, oldest = commits
        matching = 'TERMUX_PKG_VERSION=1.2.3\nTERMUX_PKG_EPOCH=1\nTERMUX_PKG_REVISION=2\n'
        states = {
            newer: 'TERMUX_PKG_VERSION=2.0.0\n',
            boundary: 'TERMUX_PKG_VERSION=1.2.3\nTERMUX_PKG_REVISION=3\n',
            patch_only: matching, first: matching,
            before: 'TERMUX_PKG_VERSION=1.2.2\n',
            older_match: matching, oldest: 'TERMUX_PKG_VERSION=1.0.0\n',
        }
        with self.history(states):
            selected, evidence, text = sources.resolve_range('fixture-history', newer, 'packages/git', '1:1.2.3-2')
        self.assertEqual(selected, patch_only)
        self.assertEqual(text, matching)
        self.assertEqual(evidence['selected'], patch_only)
        self.assertEqual(evidence['last'], patch_only)
        self.assertEqual(evidence['first'], first)
        self.assertEqual(evidence['after'], boundary)
        self.assertEqual(evidence['before'], before)
        self.assertEqual(evidence['historyTip'], newer)
        self.assertEqual(evidence['matchingDirectoryCommits'], 2)
        self.assertEqual(evidence['method'], 'first-parent-package-history')
        self.assertEqual(evidence['beforeVersion'], '1.2.2')
        self.assertEqual(evidence['afterVersion'], '1.2.3-3')
        self.assertEqual(evidence['rangeStartParent'], before)
        self.assertEqual(evidence['rangeEnd'], patch_only)
        self.assertIs(evidence['openAtHistoryTip'], False)

    def test_matching_tip_and_creation_commit_have_open_boundaries(self):
        latest, first = 'a' * 40, 'b' * 40
        states = {latest: 'TERMUX_PKG_VERSION=1.2.3\n', first: 'TERMUX_PKG_VERSION=1.2.3\n'}
        with self.history(states):
            selected, evidence, _ = sources.resolve_range('fixture-history', latest, 'packages/git', '1.2.3')
        self.assertEqual(selected, latest)
        self.assertEqual(evidence['first'], first)
        self.assertIsNone(evidence['before'])
        self.assertIsNone(evidence['after'])
        self.assertIsNone(evidence['rangeStartParent'])
        self.assertEqual(evidence['rangeEnd'], latest)
        self.assertIs(evidence['openAtHistoryTip'], True)

    def test_missing_history_and_absent_exact_version_fail_instead_of_guessing(self):
        for states, code in (
            ({}, 'missing-recipe-history'),
            ({'a' * 40: 'TERMUX_PKG_VERSION=1.2.3\n'}, 'recipe-version-not-found'),
            ({'a' * 40: None}, 'recipe-version-not-found'),
        ):
            with self.subTest(states=states):
                with self.history(states):
                    self.assert_source_error(code, sources.resolve_range, 'fixture-history', 'a' * 40,
                                             'packages/git', '1.2.3-1')

    def test_subpackage_recipe_is_found_and_ambiguous_directories_are_rejected(self):
        listings = (
            ('packages/curl/build.sh\npackages/curl/libcurl.subpackage.sh\n', 'packages/curl'),
            ('packages/git/build.sh\n', 'packages/git'),
            ('packages/libcurl/build.sh\npackages/curl/libcurl.subpackage.sh\n', None),
        )
        for listing, expected in listings:
            with self.subTest(listing=listing):
                result = subprocess.CompletedProcess([], 0, stdout=listing)
                with mock.patch.object(sources.subprocess, 'run', return_value=result):
                    if expected is None:
                        self.assert_source_error('recipe-directory-ambiguous', sources.find_recipe,
                                                 'fixture-history', HISTORY_TIP, 'libcurl')
                    else:
                        name = 'git' if expected == 'packages/git' else 'libcurl'
                        self.assertEqual(sources.find_recipe('fixture-history', HISTORY_TIP, name), expected)


class NodeFixture(SourceFixture):
    def setUp(self):
        super().setUp()
        self.signer = 'C82FA3AE1CBEDC6BE46B9360C43CEC45C17AB93C'
        self.gpg_status = self.signature_status()
        keyring_sha256 = self.cache.store(b'fixture public keyring')
        keyring = mock.patch.object(sources, 'NODE_KEYRING_SHA256', keyring_sha256)
        keyring.start()
        self.addCleanup(keyring.stop)
        contents = tar_bytes([
            ('file', 'node-v1.2.3/LICENSE', b'fixture Node composite license\r\n'),
            ('file', 'node-v1.2.3/deps/npm/package.json', json_data({'name': 'npm', 'version': '11.10.0'})),
            ('file', 'node-v1.2.3/deps/npm/LICENSE', b'fixture npm license\n'),
        ], mode='w:xz')
        source = self.node_pin('node-v1.2.3.tar.xz', contents)
        shasums = (source['sha256'] + '  node-v1.2.3.tar.xz\n').encode('ascii')
        self.node = {
            'version': '1.2.3', 'source': source,
            'shasums': self.node_pin('SHASUMS256.txt', shasums),
            'signature': self.node_pin('SHASUMS256.txt.sig', b'fixture detached signature'),
            'keyring': {
                'url': sources.NODE_KEYRING_URL, 'sha256': keyring_sha256,
                'filename': 'node-release-keys.kbx',
            },
            'patches': [],
        }
        self.runtime['node'] = {'version': 'v1.2.3'}
        self.runtime['npm'] = {'version': '11.10.0'}
        self.lock['node'] = self.node
        self.lock['npm'] = {'version': '11.10.0', 'source': 'node'}
        self.save_locks()
        self.remote_contents = {
            pin['url']: (self.cache.directory / pin['sha256']).read_bytes()
            for pin in (self.node[key] for key in ('source', 'shasums', 'signature'))
        }
        real_require_tools = sources.require_tools

        def require_tools(*names):
            real_require_tools(*(name for name in names if name != 'gpgv'))

        tools = mock.patch.object(sources, 'require_tools', side_effect=require_tools)
        tools.start()
        self.addCleanup(tools.stop)
        self.commands.side_effect = self.command

    def signature_status(self, signer=None, hash_algorithm='10'):
        fingerprint = self.signer if signer is None else signer
        return ('[GNUPG:] NEWSIG\n[GNUPG:] VALIDSIG ' + fingerprint
                + ' 2026-10-21 1792537200 0 4 0 1 ' + hash_algorithm + ' 00 ' + fingerprint + '\n')

    def node_pin(self, filename, contents):
        return {
            'url': 'https://nodejs.org/dist/v1.2.3/' + filename,
            'sha256': self.cache.store(contents), 'filename': filename,
        }

    def command(self, arguments, **kwargs):
        values = [str(item) for item in arguments]
        if values[0] == 'gpgv':
            self.assertEqual(values[values.index('--status-fd') + 1], '1')
            self.assertIn('--keyring', values)
            return subprocess.CompletedProcess(values, 0, stdout=self.gpg_status, stderr='')
        if values[0] == 'curl':
            self.assertIn(values[-1], self.remote_contents)
            Path(values[values.index('--output') + 1]).write_bytes(self.remote_contents[values[-1]])
            return subprocess.CompletedProcess(values, 0, stdout=b'', stderr=b'')
        return no_external_commands(arguments, **kwargs)


class NodeTests(NodeFixture):
    def test_official_node_pins_and_embedded_npm_version_are_accepted(self):
        self.assertIsNone(self.validate())
        source = self.cache.directory / self.node['source']['sha256']
        self.assertEqual(sources.node_npm_version(source, '1.2.3'), '11.10.0')
        paths, signers = sources.verify_node_signature(self.cache, self.node, self.directory)
        self.assertEqual(signers, [self.signer])
        self.assertEqual(paths['source'].read_bytes(), source.read_bytes())

    def test_node_origin_and_trusted_keyring_pins_cannot_be_replaced(self):
        for key, code in (('source', 'node-official-origin'), ('keyring', 'node-keyring-pin')):
            with self.subTest(key=key):
                lock = copy.deepcopy(self.lock)
                lock['node'][key]['url'] = 'https://example.invalid/' + lock['node'][key]['filename']
                self.assert_source_error(code, self.validate, lock)

    def test_signature_requires_allowed_primary_signer_and_strong_digest(self):
        for status in ('', self.signature_status('0' * 40), self.signature_status(hash_algorithm='2')):
            with self.subTest(status=status):
                self.gpg_status = status
                self.assert_source_error('node-signature-signer', sources.verify_node_signature,
                                         self.cache, self.node, self.directory)

    def test_bad_expired_or_revoked_signature_status_is_rejected(self):
        for status in ('BADSIG', 'ERRSIG', 'EXPKEYSIG', 'EXPSIG', 'REVKEYSIG', 'KEYREVOKED'):
            with self.subTest(status=status):
                self.gpg_status = self.signature_status() + '[GNUPG:] ' + status + ' fixture\n'
                self.assert_source_error('node-signature-status', sources.verify_node_signature,
                                         self.cache, self.node, self.directory)

    def test_gpg_verification_failure_has_no_unsigned_fallback(self):
        def command(arguments, **kwargs):
            raise subprocess.CalledProcessError(1, arguments, output='[GNUPG:] BADSIG fixture\n')

        self.commands.side_effect = command
        with self.assertRaises(subprocess.CalledProcessError):
            sources.verify_node_signature(self.cache, self.node, self.directory)

    def test_signed_checksum_must_match_source_pin_and_have_unique_canonical_rows(self):
        original = copy.deepcopy(self.node['shasums'])
        row = self.remote_contents[original['url']]
        for contents, code in (
            (b'0' * 64 + b'  node-v1.2.3.tar.xz\n', 'node-source-shasums'),
            (row + row, 'node-shasums-format'),
            (b'invalid checksum row\n', 'node-shasums-format'),
            (row.replace(b'  ', b' *'), 'node-shasums-format'),
        ):
            with self.subTest(contents=contents):
                self.node['shasums'] = {**original, 'sha256': self.cache.store(contents)}
                self.assert_source_error(code, sources.verify_node_signature,
                                         self.cache, self.node, self.directory)

    def test_tampered_cached_node_signature_checksum_or_source_fails_before_gpg(self):
        for key in ('signature', 'shasums', 'source'):
            with self.subTest(key=key):
                path = self.cache.directory / self.node[key]['sha256']
                original = path.read_bytes()
                try:
                    path.write_bytes(b'tampered cached Node input')
                    self.assert_source_error('sha256-mismatch', sources.verify_node_signature,
                                             self.cache, self.node, self.directory)
                finally:
                    path.write_bytes(original)
        self.commands.assert_not_called()

    def test_embedded_npm_metadata_must_be_present_regular_and_identify_npm(self):
        member = 'node-v1.2.3/deps/npm/package.json'
        for entries, code in (
            ([('file', 'node-v1.2.3/LICENSE', b'license')], 'node-npm-missing'),
            ([('symlink', member, '../../package.json')], 'node-npm-metadata'),
            ([('file', member, json_data({'name': 'other', 'version': '11.10.0'}))], 'node-npm-metadata'),
            ([('file', member, json_data({'name': 'npm', 'version': 11}))], 'node-npm-metadata'),
        ):
            with self.subTest(entries=entries):
                path = self.directory / 'node-metadata.tar.xz'
                path.write_bytes(tar_bytes(entries, mode='w:xz'))
                self.assert_source_error(code, sources.node_npm_version, path, '1.2.3')

    def test_patch_scan_is_sorted_hashes_every_file_and_rejects_symlinks(self):
        patches = self.fixture_root / 'patches' / 'node'
        patches.mkdir(parents=True)
        (patches / 'z.patch').write_bytes(b'last patch\n')
        (patches / 'a.patch').write_bytes(b'first patch\n')
        with mock.patch.object(sources, 'ROOT', self.fixture_root):
            self.assertEqual(sources.node_patch_pins(), [
                {'path': 'android/runtime/patches/node/a.patch', 'sha256': sha256(b'first patch\n')},
                {'path': 'android/runtime/patches/node/z.patch', 'sha256': sha256(b'last patch\n')},
            ])
            # Nested patches use the same string order that validate_sources requires.
            (patches / 'a').mkdir()
            (patches / 'a' / 'x.patch').write_bytes(b'nested patch\n')
            (patches / 'a-b.patch').write_bytes(b'hyphen patch\n')
            pins = sources.node_patch_pins()
            self.assertEqual([pin['path'] for pin in pins], [
                'android/runtime/patches/node/a-b.patch', 'android/runtime/patches/node/a.patch',
                'android/runtime/patches/node/a/x.patch', 'android/runtime/patches/node/z.patch',
            ])
            self.node['patches'] = pins
            self.assertIsNone(self.validate())
            (patches / 'link.patch').symlink_to(patches / 'a.patch')
            self.assert_source_error('node-patch-symlink', sources.node_patch_pins)

    def test_refresh_authenticates_shasums_before_fetching_source(self):
        self.gpg_status = self.signature_status('0' * 40)
        (self.cache.directory / self.node['source']['sha256']).unlink()
        with mock.patch.object(sources, 'ROOT', self.fixture_root):
            self.assert_source_error('node-signature-signer', sources.refresh_node, self.runtime, self.cache)
        curls = [call.args[0][-1] for call in self.commands.call_args_list if call.args[0][0] == 'curl']
        self.assertEqual(curls, [self.node['shasums']['url'], self.node['signature']['url']])

    @unittest.skipUnless(shutil.which('zstd'), 'zstd')
    def test_strict_node_build_includes_verified_source_and_matching_patch(self):
        patches = self.fixture_root / 'patches' / 'node'
        patches.mkdir(parents=True)
        contents = b'fixture Android patch\n'
        (patches / 'android.patch').write_bytes(contents)
        self.node['patches'] = [{
            'path': 'android/runtime/patches/node/android.patch', 'sha256': sha256(contents),
        }]
        self.save_locks()
        output, _ = self.build(require_node=True)
        manifest = sources.verify_archive(output)
        self.assertEqual(manifest['node'], {
            'status': 'bundled', 'version': '1.2.3', 'signatureFingerprints': [self.signer],
        })
        self.assertEqual(manifest['npm'], {'status': 'bundled', 'version': '11.10.0', 'source': 'node'})
        self.assertEqual(manifest['nodePatches'], {'status': 'included', 'files': self.node['patches']})
        records = {record['path']: record for record in manifest['members']}
        self.assertEqual(records['node/node-v1.2.3.tar.xz']['sha256'], self.node['source']['sha256'])
        self.assertEqual(records['android/runtime/patches/node/android.patch']['sha256'], sha256(contents))

    def test_changed_patch_or_embedded_npm_version_fails_before_output_publication(self):
        patches = self.fixture_root / 'patches' / 'node'
        patches.mkdir(parents=True)
        patch = patches / 'android.patch'
        patch.write_bytes(b'unpinned patch\n')
        self.assert_source_error('node-patches-changed', self.build)
        self.node['patches'] = [{
            'path': 'android/runtime/patches/node/android.patch', 'sha256': sha256(b'original pinned patch\n'),
        }]
        self.save_locks()
        self.assert_source_error('node-patches-changed', self.build)
        patch.unlink()
        self.node['patches'] = []
        self.runtime['npm']['version'] = '11.99.0'
        self.lock['npm']['version'] = '11.99.0'
        self.save_locks()
        error = self.assert_source_error('npm-version-mismatch', self.build)
        self.assertEqual(error.details, {'expected': '11.99.0', 'actual': '11.10.0'})
        self.assertFalse((self.directory / 'sources.tar.zst').exists())

    def test_strict_gate_also_rejects_pinned_node_with_unpinned_npm(self):
        self.runtime['npm'] = None
        self.lock['npm'] = None
        self.save_locks()
        self.assert_source_error('node-and-npm-required', self.build, require_node=True)
        self.commands.assert_not_called()


class NoticesTests(SourceFixture):
    def setUp(self):
        super().setUp()
        self.licenses = self.directory / 'licenses'
        (self.licenses / 'git').mkdir(parents=True)
        self.license_bytes = b'fixture license\r\nCopyright \xc2\xa9\t2026\n\n'
        (self.licenses / 'git' / 'copyright').write_bytes(self.license_bytes)

    def assert_notices_error(self, code, callback, *arguments, **kwargs):
        with self.assertRaises(notices.NoticesError) as error:
            callback(*arguments, **kwargs)
        self.assertEqual(error.exception.code, code)
        return error.exception

    def generate(self, **kwargs):
        return notices.generate(self.runtime_path, self.sources_path, self.licenses, **kwargs)

    def npm_package(self, root, name, version, license_contents=b'fixture npm license\n'):
        root.mkdir(parents=True, exist_ok=True)
        (root / 'package.json').write_bytes(json_data({'name': name, 'version': version, 'license': 'MIT'}))
        (root / 'LICENSE').write_bytes(license_contents)

    def npm_tree(self):
        root = self.directory / 'npm'
        self.npm_package(root, 'npm', '11.10.0', b'root npm license\r\n')
        self.npm_package(root / 'node_modules' / 'alpha', 'alpha', '1.0.0', b'alpha first license\n')
        self.npm_package(root / 'node_modules' / '@scope' / 'zeta', '@scope/zeta', '2.0.0', b'scoped license\n')
        self.npm_package(root / 'node_modules' / 'alpha' / 'node_modules' / 'alpha',
                         'alpha', '3.0.0', b'alpha nested license\n')
        (root / 'license-helper.js').write_bytes(b'this is code, not license text\n')
        return root

    def android_input(self, libraries):
        path = self.directory / 'android-libraries.json'
        path.write_bytes(json_data({'schema': 1, 'libraries': libraries}))
        return path

    def android_library(self):
        (self.directory / 'android-LICENSE').write_bytes(b'Android library verbatim\r\n')
        return {
            'name': 'org.example:library', 'version': '1.0.0', 'spdx': 'Apache-2.0',
            'sourceUrl': 'https://example.invalid/android/library', 'licenses': ['android-LICENSE'],
        }

    def test_verbatim_license_bytes_sorted_index_and_byte_offsets_are_deterministic(self):
        package = copy.deepcopy(self.lock['termux']['packages'][0])
        package.update({'name': 'bash', 'version': '5.3', 'recipePath': 'packages/bash',
                        'license': 'GPL-3.0+', 'spdx': 'GPL-3.0-or-later'})
        self.runtime['termux']['packages'].append({'name': 'bash', 'version': '5.3'})
        self.lock['termux']['packages'].append(package)
        (self.licenses / 'bash').mkdir()
        latin1 = b'licence fran\xe7aise\r\n'
        (self.licenses / 'bash' / 'z-license').write_bytes(latin1)
        (self.licenses / 'bash' / 'a-license').write_bytes(b'first license\n')
        self.save_locks()
        first, index = self.generate()
        for path in self.licenses.rglob('*'):
            os.utime(path, (1234567890, 1234567890))
        second, second_index = self.generate()
        self.assertEqual(first, second)
        self.assertEqual(index, second_index)
        self.assertEqual([item['id'] for item in index['components']], ['termux/bash', 'termux/git'])
        self.assertEqual([item['path'] for item in index['components'][0]['licenses']], ['a-license', 'z-license'])
        self.assertEqual(index['notices'], {
            'file': 'THIRD_PARTY_NOTICES', 'sha256': sha256(first), 'byteLength': len(first),
        })
        self.assertEqual(index['runtimeLockSha256'], sha256(self.runtime_path.read_bytes()))
        self.assertEqual(index['sourcesLockSha256'], sha256(self.sources_path.read_bytes()))
        expected = {'termux/bash': {'a-license': b'first license\n', 'z-license': latin1},
                    'termux/git': {'copyright': self.license_bytes}}
        for item in index['components']:
            for license in item['licenses']:
                with self.subTest(component=item['id'], license=license['path']):
                    start = license['offset']
                    payload = first[start:start + license['length']]
                    self.assertEqual(payload, expected[item['id']][license['path']])
                    self.assertEqual(license['sha256'], sha256(payload))
        self.assertEqual(index['components'][0]['licenses'][1]['encoding'], 'iso-8859-1')
        self.assertEqual(index['sections']['node']['status'], 'not-bundled')
        self.assertEqual(index['sections']['npm']['status'], 'not-bundled')
        self.assertEqual(index['sections']['android']['status'], 'not-supplied')
        self.assertIsNone(notices.validate_output(first, index))

    def test_npm_nested_and_scoped_dependencies_keep_their_own_license_texts(self):
        root = self.npm_tree()
        components = notices.npm_components(root)
        actual = {item['id']: (item['name'], item['version'], item['licenses'][0]['contents']) for item in components}
        self.assertEqual(actual, {
            'npm': ('npm', '11.10.0', b'root npm license\r\n'),
            'npm/node_modules/alpha': ('alpha', '1.0.0', b'alpha first license\n'),
            'npm/node_modules/@scope/zeta': ('@scope/zeta', '2.0.0', b'scoped license\n'),
            'npm/node_modules/alpha/node_modules/alpha': ('alpha', '3.0.0', b'alpha nested license\n'),
        })
        self.assertTrue(all([license['path'] for license in item['licenses']] == ['LICENSE'] for item in components))
        scoped = next(item for item in components if item['name'] == '@scope/zeta')
        self.assertEqual(scoped['sourceUrl'], 'https://registry.npmjs.org/@scope/zeta/-/zeta-2.0.0.tgz')

    def test_npm_dependency_without_its_own_license_fails_instead_of_inheriting_root(self):
        root = self.npm_tree()
        (root / 'node_modules' / '@scope' / 'zeta' / 'LICENSE').unlink()
        self.assert_notices_error('licenses-missing', notices.npm_components, root)

    def test_npm_symlinks_and_conflicting_duplicate_component_metadata_are_rejected(self):
        root = self.npm_tree()
        (root / 'node_modules' / 'alias').symlink_to(root / 'node_modules' / 'alpha', target_is_directory=True)
        self.assert_notices_error('symlink', notices.npm_components, root)
        (root / 'node_modules' / 'alias').unlink()
        nested = root / 'node_modules' / 'alpha' / 'node_modules' / 'alpha'
        self.npm_package(nested, 'alpha', '1.0.0', b'different license for same version\n')
        self.assert_notices_error('metadata-conflict', notices.validate_components, notices.npm_components(root))

    def test_android_schema_uses_relative_license_inputs_and_supports_empty_placeholder(self):
        path = self.android_input([self.android_library()])
        items = notices.android_components(path)
        self.assertEqual(len(items), 1)
        self.assertEqual(items[0]['id'], 'android/org.example:library')
        self.assertEqual(items[0]['licenses'][0]['contents'], b'Android library verbatim\r\n')
        _, index = self.generate(android_libraries=path)
        self.assertEqual(index['sections']['android'], {
            'status': 'bundled', 'inputStatus': 'provided', 'components': ['android/org.example:library'],
        })
        path = self.android_input([])
        _, index = self.generate(android_libraries=path)
        self.assertEqual(index['sections']['android'], {
            'status': 'placeholder', 'inputStatus': 'provided', 'components': [],
        })

    def test_android_schema_duplicate_components_missing_fields_and_license_escape_are_rejected(self):
        library = self.android_library()
        for change, code in (
            ('schema', 'android-schema'), ('missing-field', 'metadata-missing'),
            ('escape', 'relative-path'), ('duplicate', 'component-duplicate'),
        ):
            with self.subTest(change=change):
                document = {'schema': 1, 'libraries': [copy.deepcopy(library)]}
                if change == 'schema':
                    document['schema'] = True
                elif change == 'missing-field':
                    del document['libraries'][0]['spdx']
                elif change == 'escape':
                    document['libraries'][0]['licenses'] = ['../escape']
                else:
                    document['libraries'] *= 2
                path = self.directory / 'android-libraries.json'
                path.write_bytes(json_data(document))
                self.assert_notices_error(code, self.generate, android_libraries=path)

    def test_node_composite_license_is_preserved_and_version_is_read_from_header(self):
        root = self.directory / 'node'
        (root / 'src').mkdir(parents=True)
        contents = b'Node license\r\nDependency license follows\n'
        (root / 'LICENSE').write_bytes(contents)
        (root / 'src' / 'node_version.h').write_bytes(
            b'#define NODE_MAJOR_VERSION 1\n#define NODE_MINOR_VERSION 2\n'
            b'#define NODE_PATCH_VERSION 3\n#define NODE_VERSION_IS_RELEASE 1\n')
        item = notices.node_component(root)
        self.assertEqual(item['version'], '1.2.3')
        self.assertIsNone(item['spdx'])
        self.assertEqual(item['licenses'][0]['contents'], contents)
        self.runtime['node'] = {'version': 'v1.2.3'}
        self.lock['node'] = {'version': '1.2.3'}
        self.save_locks()
        _, index = self.generate(node_source=root)
        self.assertEqual(index['sections']['node']['status'], 'bundled')
        self.runtime['node']['version'] = 'v1.2.4'
        self.lock['node']['version'] = '1.2.4'
        self.save_locks()
        self.assert_notices_error('runtime-version-mismatch', self.generate, node_source=root)

    def test_null_runtime_sections_require_node_gate_and_missing_termux_licenses_fail_closed(self):
        self.assert_notices_error('runtime-unpinned', self.generate, require_node=True)
        (self.licenses / 'git' / 'copyright').unlink()
        self.assert_notices_error('licenses-missing', self.generate)

    def test_termux_license_set_and_lock_versions_must_match(self):
        (self.licenses / 'unbundled').mkdir()
        self.assert_notices_error('license-package-mismatch', self.generate)
        (self.licenses / 'unbundled').rmdir()
        self.lock['termux']['packages'][0]['version'] = '0.0.0'
        self.save_locks()
        self.assert_notices_error('package-mismatch', self.generate)

    def test_symlinked_license_file_or_input_parent_is_rejected(self):
        original = self.licenses / 'git' / 'copyright'
        target = self.directory / 'license-copy'
        target.write_bytes(original.read_bytes())
        original.unlink()
        original.symlink_to(target)
        self.assert_notices_error('symlink', self.generate)
        original.unlink()
        original.write_bytes(self.license_bytes)
        link = self.directory / 'linked-licenses'
        link.symlink_to(self.licenses, target_is_directory=True)
        self.assert_notices_error('symlink', notices.generate,
                                 self.runtime_path, self.sources_path, link)

    def test_notices_and_index_tampering_is_detected(self):
        contents, index = self.generate()
        self.assert_notices_error('notices-sha256', notices.validate_output, contents + b'tampered', index)
        changed = copy.deepcopy(index)
        changed['components'][0]['licenses'][0]['sha256'] = '0' * 64
        self.assert_notices_error('license-sha256', notices.validate_output, contents, changed)
        changed = copy.deepcopy(index)
        changed['components'][0]['licenses'][0]['offset'] = -1
        self.assert_notices_error('index-license-range', notices.validate_output, contents, changed)

    def test_publish_preserves_runtime_assets_and_rebuilds_byte_identical_pair(self):
        output = self.directory / 'published-assets'
        runtime = output / 'runtime' / 'certs'
        runtime.mkdir(parents=True)
        retained = runtime / 'cert.pem'
        retained.write_bytes(b'preexisting runtime asset\n')
        contents, index = self.generate(output_root=output)
        notices.publish(contents, index, output)
        first_index = (output / 'THIRD_PARTY_NOTICES.json').read_bytes()
        self.assertEqual((output / 'THIRD_PARTY_NOTICES').read_bytes(), contents)
        self.assertEqual(json.loads(first_index), index)
        self.assertEqual(retained.read_bytes(), b'preexisting runtime asset\n')
        notices.publish(contents, index, output)
        self.assertEqual((output / 'THIRD_PARTY_NOTICES.json').read_bytes(), first_index)
        self.assertEqual((output / 'THIRD_PARTY_NOTICES').read_bytes(), contents)
        self.assertEqual(retained.read_bytes(), b'preexisting runtime asset\n')

    def test_publish_rejects_invalid_pair_and_symlinked_assets_without_replacing_output(self):
        output = self.directory / 'published-assets'
        contents, index = self.generate(output_root=output)
        notices.publish(contents, index, output)
        self.assert_notices_error('notices-sha256', notices.publish, contents + b'tampered', index, output)
        self.assertEqual((output / 'THIRD_PARTY_NOTICES').read_bytes(), contents)
        (output / 'runtime-link').symlink_to(self.licenses, target_is_directory=True)
        self.assert_notices_error('symlink', notices.publish, contents, index, output)
        self.assertEqual((output / 'THIRD_PARTY_NOTICES').read_bytes(), contents)

    def test_output_cannot_overlap_input_directories(self):
        self.assert_notices_error('output-input-overlap', self.generate, output_root=self.licenses)


if __name__ == '__main__':
    unittest.main(verbosity=2)
