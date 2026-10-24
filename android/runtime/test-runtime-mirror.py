#!/usr/bin/env python3
import contextlib
import copy
import hashlib
import importlib.util
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock


sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location('runtime_mirror', ROOT / 'runtime-mirror.py')
mirror = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(mirror)
sources = mirror.sources
termux = mirror.termux
COMMIT = '1' * 40
HISTORY_TIP = '2' * 40
REPOSITORY = 'ghcr.io/example/runtime'
SHARED = b'fixture patch that is a recipe file and a build-system file\n'
PACKAGES = (('bash', '5.3.20'), ('ca-certificates', '1:2026.10.20-1'), ('git', '2.56.0'))


def sha256(contents):
    return hashlib.sha256(contents).hexdigest()


def git_blob(contents):
    return hashlib.sha1(f'blob {len(contents)}\0'.encode('ascii') + contents).hexdigest()


def json_data(value):
    return (json.dumps(value, indent=4) + '\n').encode('utf-8')


class MirrorFixture(unittest.TestCase):
    """A consistent runtime.lock and sources.lock in a scratch directory, with every input of the set in the build
    caches under self.cache, and self.blobs holding every input by SHA-256."""

    with_node = True

    def setUp(self):
        cache = ROOT / 'cache'
        cache.mkdir(exist_ok=True)
        scratch = tempfile.TemporaryDirectory(prefix='runtime-mirror-tests-', dir=cache)
        self.addCleanup(scratch.cleanup)
        self.directory = Path(scratch.name)
        self.cache = self.directory / 'cache'
        self.store = sources.Cache(self.cache / 'sources' / 'objects', offline=True)
        self.blobs = {}
        tokens = mock.patch.dict(sources._mirror_tokens, clear=True)
        tokens.start()
        self.addCleanup(tokens.stop)
        for module in (sources, termux):
            tools = mock.patch.object(module, 'require_tools')
            tools.start()
            self.addCleanup(tools.stop)
        self.runtime = {
            'schema': 1, 'abis': list(termux.ABI_ARCHES),
            'termux': {'repository': 'https://packages.example.invalid/apt/termux-main', 'suite': 'stable',
                       'component': 'main', 'packages': []},
            'node': None, 'bun': None, 'npm': None, 'mirror': {'repository': REPOSITORY},
        }
        self.controls = {}
        packages = []
        for name, version in PACKAGES:
            debs = {}
            for abi, (arch, _, _) in termux.ABI_ARCHES.items():
                arch = 'all' if name == 'ca-certificates' else arch
                contents = f'{name} {version} {arch} deb\n'.encode('ascii')
                debs[abi] = {'filename': f'pool/main/{name[0]}/{name}/{name}_{version}_{arch}.deb',
                             'sha256': self.blob(contents)}
                self.controls[sha256(contents)] = f'Package: {name}\nVersion: {version}\nArchitecture: {arch}\n'
                path = self.cache / 'debs' / (sha256(contents) + '.deb')
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(contents)
            self.runtime['termux']['packages'].append({'name': name, 'version': version, 'debs': debs})
            files = [self.recipe_pin(f'packages/{name}/build.sh', f'TERMUX_PKG_VERSION={version}\n'.encode('ascii'))]
            if name == 'git':
                files.append(self.recipe_pin('packages/git/shared.patch', SHARED))
            upstream = [] if name == 'ca-certificates' else [{
                'url': f'https://example.invalid/{name}-{version}.tar.gz',
                'sha256': self.keep(f'{name} upstream source\n'.encode('ascii')), 'filename': f'{name}-{version}.tar.gz',
            }]
            packages.append({
                'name': name, 'version': version, 'commit': COMMIT, 'recipePath': f'packages/{name}',
                'evidence': {'method': 'first-parent-package-history', 'historyTip': HISTORY_TIP, 'selected': COMMIT,
                             'first': COMMIT, 'last': COMMIT, 'before': None, 'after': HISTORY_TIP},
                'files': files, 'sources': upstream,
                'sourceStatus': 'upstream-tarballs' if upstream else 'in-recipe-directory',
            })
        self.system_files = [
            self.snapshot_pin('build-package.sh', b'#!/bin/sh\nexit 0\n', 0o755),
            self.snapshot_pin('repo.json', b'{"pkg_format":"debian"}\n'),
            self.snapshot_pin('scripts/properties.sh', b'TERMUX_ARCH=aarch64\n'),
            self.snapshot_pin('scripts/shared.patch', SHARED),
        ]
        system = {'commit': COMMIT,
                  'selection': [{'reason': 'build-system', 'paths': ['build-package.sh', 'repo.json', 'scripts']}],
                  **sources.snapshot_summary(self.system_files)}
        listing = sources.snapshot_listing(self.system_files)
        self.blob(listing)
        index = sources.snapshot_index_path(system, self.store)
        index.parent.mkdir(parents=True, exist_ok=True)
        index.write_bytes(listing)
        self.lock = {
            'schema': 1, 'runtimeLockSha256': None,
            'termux': {'repository': sources.REPOSITORY, 'historyTip': HISTORY_TIP, 'packages': packages,
                       'buildSystems': [system]},
            'node': None, 'npm': None,
        }
        if self.with_node:
            keyring = self.keep(b'fixture public keyring')
            patch = mock.patch.object(sources, 'NODE_KEYRING_SHA256', keyring)
            patch.start()
            self.addCleanup(patch.stop)
            self.lock['node'] = {
                'version': '1.2.3', 'patches': [],
                **{key: {'url': 'https://nodejs.org/dist/v1.2.3/' + filename, 'filename': filename,
                         'sha256': self.keep(f'fixture {filename}\n'.encode('ascii'))}
                   for key, filename in (('source', 'node-v1.2.3.tar.xz'), ('shasums', 'SHASUMS256.txt'),
                                         ('signature', 'SHASUMS256.txt.sig'))},
                'keyring': {'url': sources.NODE_KEYRING_URL, 'sha256': keyring, 'filename': 'node-release-keys.kbx'},
            }
            self.lock['npm'] = {'version': '11.10.0', 'source': 'node'}
            self.runtime['node'] = {'version': '1.2.3', 'binaries': {
                abi: {'repository': REPOSITORY, 'digest': None} for abi in termux.ABI_ARCHES}}
            self.runtime['npm'] = {'version': '11.10.0', 'source': 'node'}
        self.runtime_path = self.directory / 'runtime.lock'
        self.sources_path = self.directory / 'sources.lock'
        self.save_locks()

    def blob(self, contents):
        self.blobs[sha256(contents)] = contents
        return sha256(contents)

    def keep(self, contents):
        self.blob(contents)
        return self.store.store(contents)

    def recipe_pin(self, path, contents):
        return {'path': path, 'sha256': self.keep(contents), 'mode': 0o644, 'type': 'file',
                'url': sources.raw_url(COMMIT, path)}

    def snapshot_pin(self, path, contents, mode=0o644):
        return {**self.recipe_pin(path, contents), 'mode': mode, 'gitBlob': git_blob(contents), 'size': len(contents)}

    def save_locks(self):
        data = json_data(self.runtime)
        self.runtime_path.write_bytes(data)
        self.lock['runtimeLockSha256'] = sha256(data)
        self.sources_path.write_bytes(sources.json_bytes(self.lock))

    def tag(self):
        return mirror.tag(self.runtime, self.lock)


class FakeRegistry:
    """Answers curl and dpkg-deb for the code under test: GHCR token, manifest and blob requests, origin downloads
    and deb control fields. statuses forces the HTTP status of the next registry requests."""

    def __init__(self, fixture, manifests=(), blobs=None, origin=None, statuses=(), token_status=b'200'):
        self.fixture = fixture
        self.manifests = set(manifests)
        self.blobs = dict(blobs or {})
        self.origin = dict(origin or {})
        self.statuses = list(statuses)
        self.token_status = token_status
        self.tokens = 0
        self.calls = []

    def __call__(self, arguments, **kwargs):
        values = [str(item) for item in arguments]
        if values[0] == 'dpkg-deb':
            return subprocess.CompletedProcess(values, 0, stdout=self.fixture.controls[Path(values[-1]).stem], stderr='')
        if values[0] != 'curl':
            raise AssertionError(('unexpected command', values))
        self.calls.append((values, kwargs.get('input')))
        url = values[-1]
        if url.startswith('https://ghcr.io/token?'):
            self.tokens += 1
            body = json.dumps({'token': f'fixture-token-{self.tokens}'}).encode('ascii')
            Path(values[values.index('--output') + 1]).write_bytes(body)
            return subprocess.CompletedProcess(values, 0, stdout=self.token_status, stderr=b'')
        output = Path(values[values.index('--output') + 1])
        if url.startswith('https://ghcr.io/v2/example/runtime/'):
            kind, name = url.removeprefix('https://ghcr.io/v2/example/runtime/').split('/')
            found = name in self.manifests if kind == 'manifests' else name.removeprefix('sha256:') in self.blobs
            status = self.statuses.pop(0) if self.statuses else 200 if found else 404
            if output != Path(os.devnull):
                output.write_bytes(self.blobs[name.removeprefix('sha256:')] if status == 200 else b'{"errors":[]}')
            return subprocess.CompletedProcess(values, 0, stdout=str(status).encode('ascii'), stderr=b'')
        if url not in self.origin:
            raise subprocess.CalledProcessError(22, values)
        output.write_bytes(self.origin[url])
        return subprocess.CompletedProcess(values, 0, stdout=b'', stderr=b'')

    def urls(self):
        return [values[-1] for values, _ in self.calls]


class TagTests(MirrorFixture):
    def test_tag_hashes_the_sorted_root_set(self):
        roots = sorted({deb['sha256'] for package in self.runtime['termux']['packages'] for deb in package['debs'].values()}
                       | {pin['sha256'] for pin in sources.download_pins(self.lock)}
                       | {self.lock['termux']['buildSystems'][0]['sha256']})
        self.assertEqual(mirror.root_digests(self.runtime, self.lock), roots)
        self.assertEqual(len(roots), 7 + 10 + 1)
        body = json.dumps({'schema': 1, 'digests': roots}, separators=(',', ':')).encode('ascii')
        self.assertEqual(self.tag(), 'inputs-' + sha256(body)[:12])

    def test_tag_does_not_depend_on_order_case_or_node_binaries(self):
        expected = self.tag()
        runtime, lock = copy.deepcopy(self.runtime), copy.deepcopy(self.lock)
        runtime['termux']['packages'].reverse()
        for package in runtime['termux']['packages']:
            package['debs'] = dict(reversed(list(package['debs'].items())))
            for deb in package['debs'].values():
                deb['sha256'] = deb['sha256'].upper()
        lock['termux']['packages'].reverse()
        for package in lock['termux']['packages']:
            package['files'].reverse()
        runtime['node']['binaries']['x86_64'].update(digest='sha256:' + 'f' * 64, sha256='e' * 64, size=1)
        self.assertEqual(mirror.tag(runtime, lock), expected)

    def test_recovery_transport_is_not_in_the_root_set(self):
        lock = copy.deepcopy(self.lock)
        lock['termux']['packages'][0]['sources'][0]['recovery'] = {'url': 'https://example.invalid/transport.tar.gz',
                                                                   'sha256': 'b' * 64}
        self.assertNotIn('b' * 64, mirror.root_digests(self.runtime, lock))
        self.assertEqual(mirror.tag(self.runtime, lock), self.tag())

    def test_every_kind_of_root_pin_changes_the_tag(self):
        changes = {
            'deb': lambda runtime, lock: runtime['termux']['packages'][0]['debs']['x86_64'].update(sha256='a' * 64),
            'recipe file': lambda runtime, lock: lock['termux']['packages'][2]['files'][0].update(sha256='a' * 64),
            'upstream source': lambda runtime, lock: lock['termux']['packages'][0]['sources'][0].update(sha256='a' * 64),
            'node source': lambda runtime, lock: lock['node']['source'].update(sha256='a' * 64),
            'listing': lambda runtime, lock: lock['termux']['buildSystems'][0].update(sha256='a' * 64),
        }
        expected = self.tag()
        for label, change in changes.items():
            with self.subTest(change=label):
                runtime, lock = copy.deepcopy(self.runtime), copy.deepcopy(self.lock)
                change(runtime, lock)
                self.assertNotEqual(mirror.tag(runtime, lock), expected)


class StageTests(MirrorFixture):
    def stage(self, registry=None):
        registry = registry or FakeRegistry(self)
        with mock.patch.object(subprocess, 'run', side_effect=registry), \
                mock.patch('sys.stdout', new_callable=io.StringIO):
            rows = mirror.stage(self.runtime, self.lock, self.directory / 'stage', self.cache)
        return rows, registry

    def expected_titles(self):
        files = {pin['path']: pin['sha256'] for pin in self.system_files}
        listing = self.lock['termux']['buildSystems'][0]['sha256']
        titles = {
            **{f'debs/{name}_{version}_{arch}.deb': (mirror.DEB, self.runtime['termux']['packages'][index]['debs'][abi]['sha256'])
               for index, (name, version) in enumerate(PACKAGES) if name != 'ca-certificates'
               for abi, (arch, _, _) in termux.ABI_ARCHES.items()},
            'debs/ca-certificates_1%3a2026.10.20-1_all.deb': (
                mirror.DEB, self.runtime['termux']['packages'][1]['debs']['x86_64']['sha256']),
            f'snapshots/{listing}.jsonl': (mirror.LISTING, listing),
            **{f'objects/{files[path]}': (mirror.BLOB, files[path])
               for path in ('build-package.sh', 'repo.json', 'scripts/properties.sh')},
        }
        for package in self.lock['termux']['packages']:
            for pin in package['files']:
                titles[f'termux/{COMMIT}/{pin["path"]}'] = (mirror.BLOB, pin['sha256'])
            for pin in package['sources']:
                titles[f'upstream/{package["name"]}/{pin["filename"]}'] = (mirror.BLOB, pin['sha256'])
        for key in ('source', 'shasums', 'signature', 'keyring'):
            pin = self.lock['node'][key]
            titles['node/' + pin['filename']] = (mirror.BLOB, pin['sha256'])
        return titles

    def assert_staged(self, rows):
        expected = self.expected_titles()
        self.assertEqual(len(expected), 21)
        self.assertEqual({title: (media_type, digest) for title, media_type, digest in rows}, expected)
        self.assertEqual([title for title, _, _ in rows], sorted(expected))
        self.assertEqual(len({digest for _, _, digest in rows}), len(rows))
        stage = self.directory / 'stage'
        staged = sorted(path.relative_to(stage).as_posix() for path in stage.rglob('*') if path.is_file())
        self.assertEqual(staged, sorted([*expected, 'oras-files', 'reference']))
        for title, (_, digest) in expected.items():
            self.assertEqual(sha256((stage / title).read_bytes()), digest, title)
        self.assertEqual((stage / 'oras-files').read_text(encoding='utf-8'),
                         ''.join(f'{title}:{expected[title][0]}\n' for title in sorted(expected)))
        self.assertEqual((stage / 'reference').read_text(encoding='ascii'), f'{REPOSITORY}:{self.tag()}\n')

    def test_stage_writes_one_titled_file_per_digest_and_the_oras_inputs(self):
        rows, registry = self.stage()
        self.assert_staged(rows)
        self.assertEqual(registry.calls, [])
        self.assertNotIn(f'objects/{sha256(SHARED)}', [title for title, _, _ in rows])

    def test_stage_reads_missing_inputs_from_the_mirror_before_the_origin(self):
        listing = self.lock['termux']['buildSystems'][0]['sha256']
        missing = [self.runtime['termux']['packages'][0]['debs']['x86_64']['sha256'],
                   self.lock['termux']['packages'][0]['sources'][0]['sha256'],
                   self.system_files[0]['sha256']]
        for digest in missing:
            path = self.store.directory / digest
            path.unlink(missing_ok=True)
            (self.cache / 'debs' / (digest + '.deb')).unlink(missing_ok=True)
        sources.snapshot_index_path(self.lock['termux']['buildSystems'][0], self.store).unlink()
        git_source = self.lock['termux']['packages'][2]['sources'][0]
        (self.store.directory / git_source['sha256']).unlink()
        registry = FakeRegistry(self, blobs={digest: self.blobs[digest] for digest in [*missing, listing]},
                                origin={git_source['url']: self.blobs[git_source['sha256']]})
        rows, _ = self.stage(registry)
        self.assert_staged(rows)
        asked = sorted(url.rsplit(':', 1)[1] for url in registry.urls() if url.startswith('https://ghcr.io/v2/'))
        self.assertEqual(asked, sorted([*missing, listing, git_source['sha256']]))
        self.assertEqual([url for url in registry.urls() if not url.startswith('https://ghcr.io/')], [git_source['url']])

    def test_stage_refuses_a_directory_that_is_not_empty_before_fetching(self):
        stage = self.directory / 'stage'
        stage.mkdir()
        (stage / 'stale').write_bytes(b'')
        with mock.patch.object(mirror, 'fetch') as fetch:
            with self.assertRaises(sources.SourceError) as caught:
                mirror.stage(self.runtime, self.lock, stage, self.cache)
        self.assertEqual(caught.exception.code, 'stage-not-empty')
        fetch.assert_not_called()

    def test_stage_fails_closed_when_a_cached_input_changes_after_the_fetch(self):
        pin = self.lock['termux']['packages'][0]['sources'][0]
        fetch = mirror.fetch

        def changed(runtime, lock, cache):
            store, systems = fetch(runtime, lock, cache)
            (store.directory / pin['sha256']).write_bytes(b'changed after the fetch')
            return store, systems

        # oras would push the changed bytes under their own digest, so a tag would exist without the pinned blob.
        with mock.patch.object(mirror, 'fetch', side_effect=changed):
            with self.assertRaises(sources.SourceError) as caught:
                self.stage()
        self.assertEqual((caught.exception.code, caught.exception.details),
                         ('sha256-mismatch', {'sha256': pin['sha256']}))
        stage = self.directory / 'stage'
        self.assertEqual([path.exists() for path in (stage / 'oras-files', stage / 'reference')], [False, False])

    def test_two_digests_with_one_title_fail_the_stage(self):
        debs = self.runtime['termux']['packages'][0]['debs']
        debs['x86_64']['filename'] = debs['arm64-v8a']['filename']
        with self.assertRaises(sources.SourceError) as caught:
            self.stage()
        title = 'debs/' + debs['arm64-v8a']['filename'].rsplit('/', 1)[1]
        self.assertEqual((caught.exception.code, caught.exception.details), ('mirror-title-conflict', {'title': title}))
        self.assertEqual(list((self.directory / 'stage').iterdir()), [])


class PlanAndCheckTests(MirrorFixture):
    def main(self, registry, *arguments):
        stdout = io.StringIO()
        with mock.patch.object(subprocess, 'run', side_effect=registry), contextlib.redirect_stdout(stdout):
            mirror.main(['--runtime-lock', str(self.runtime_path), '--sources-lock', str(self.sources_path), *arguments])
        return stdout.getvalue()

    def assert_code(self, code, callback, *arguments):
        with self.assertRaises(sources.SourceError) as caught:
            callback(*arguments)
        self.assertEqual(caught.exception.code, code)
        return caught.exception

    def test_present_tag_is_reported_and_passes_the_check(self):
        registry = FakeRegistry(self, manifests=[self.tag()])
        reference = f'{REPOSITORY}:{self.tag()}'
        self.assertEqual(self.main(registry, '--plan'), json.dumps({'reference': reference, 'present': True}) + '\n')
        self.assertEqual(self.main(registry, '--check'), '')
        self.assertEqual(registry.tokens, 1)
        values, data = registry.calls[1]
        self.assertEqual(values[-1], f'https://ghcr.io/v2/example/runtime/manifests/{self.tag()}')
        self.assertIn('--head', values)
        self.assertEqual(data, b'Authorization: Bearer fixture-token-1\nAccept: ' + sources.MANIFEST_TYPES.encode() + b'\n')

    def test_missing_tag_is_reported_absent_and_fails_the_check(self):
        registry = FakeRegistry(self)
        reference = f'{REPOSITORY}:{self.tag()}'
        self.assertEqual(self.main(registry, '--plan'), json.dumps({'reference': reference, 'present': False}) + '\n')
        error = self.assert_code('mirror-missing', self.main, registry, '--check')
        self.assertEqual(error.details, {'reference': reference, 'status': 404})

    def test_refused_token_is_replaced_once(self):
        registry = FakeRegistry(self, manifests=[self.tag()], statuses=[401])
        self.assertIn('"present": true', self.main(registry, '--plan'))
        self.assertEqual(registry.tokens, 2)

    def test_package_that_is_missing_or_private_has_no_tag(self):
        for registry in (FakeRegistry(self, manifests=[self.tag()], token_status=b'403'),
                         FakeRegistry(self, manifests=[self.tag()], statuses=[403] * 4)):
            with self.subTest(token_status=registry.token_status, statuses=registry.statuses):
                sources._mirror_tokens.clear()
                self.assertIn('"present": false', self.main(registry, '--plan'))
                # The status tells a refused reader (private or absent package) from a missing tag (404).
                error = self.assert_code('mirror-missing', self.main, registry, '--check')
                self.assertEqual(error.details, {'reference': f'{REPOSITORY}:{self.tag()}', 'status': 403})

    def test_unexpected_answer_or_no_answer_is_not_a_plan(self):
        def unreachable(arguments, **kwargs):
            raise subprocess.CalledProcessError(6, arguments)

        for registry, details in ((FakeRegistry(self, statuses=[500]), {'status': 500}),
                                  (FakeRegistry(self, token_status=b'500'), {'status': '500'}),
                                  (unreachable, {'exit': 6})):
            with self.subTest(details=details):
                sources._mirror_tokens.clear()
                error = self.assert_code('mirror-unreachable', self.main, registry, '--plan')
                self.assertEqual(error.details, details)

    def test_lock_without_a_mirror_cannot_plan(self):
        del self.runtime['mirror']
        self.save_locks()
        self.assert_code('mirror-unset', self.main, FakeRegistry(self), '--plan')


@unittest.skipUnless(shutil.which('sh'), 'sh')
class CommandLineTests(MirrorFixture):
    with_node = False

    def setUp(self):
        super().setUp()
        self.bin = self.directory / 'bin'
        self.bin.mkdir()
        curl = self.bin / 'curl'
        curl.write_text('#!/bin/sh\nprevious=\nfor argument; do\n'
                        '    [ "$previous" = --output ] && output=$argument\n'
                        '    previous=$argument\n    url=$argument\ndone\ncase $url in\n'
                        "    https://ghcr.io/token\\?*) printf '{\"token\":\"fixture-token\"}' > \"$output\"; printf 200 ;;\n"
                        "    https://ghcr.io/v2/example/runtime/manifests/*) printf '%s' \"$FIXTURE_STATUS\" ;;\n"
                        '    *) exit 7 ;;\nesac\n', encoding='ascii')
        curl.chmod(0o755)

    def run_script(self, status, *arguments):
        environment = {**os.environ, 'PATH': f'{self.bin}{os.pathsep}{os.environ.get("PATH", "")}',
                       'FIXTURE_STATUS': status}
        return subprocess.run([sys.executable, '-I', '-B', str(ROOT / 'runtime-mirror.py'),
                               '--runtime-lock', str(self.runtime_path), '--sources-lock', str(self.sources_path),
                               *arguments], env=environment, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                              text=True, check=False)

    def test_exit_codes_and_output_follow_the_contract(self):
        reference = f'{REPOSITORY}:{self.tag()}'
        for status, present in (('200', True), ('404', False)):
            with self.subTest(mode='--plan', status=status):
                result = self.run_script(status, '--plan')
                self.assertEqual((result.returncode, result.stderr), (0, ''))
                self.assertEqual(result.stdout, json.dumps({'reference': reference, 'present': present}) + '\n')
        result = self.run_script('200', '--check')
        self.assertEqual((result.returncode, result.stdout, result.stderr), (0, '', ''))
        result = self.run_script('404', '--check')
        self.assertEqual((result.returncode, result.stdout), (1, ''))
        self.assertEqual(result.stderr.splitlines(),
                         ['TODO(copy)', json.dumps({'code': 'mirror-missing', 'reference': reference, 'status': 404})])
        result = self.run_script('503', '--plan')
        self.assertEqual((result.returncode, result.stdout), (1, ''))
        self.assertEqual(json.loads(result.stderr.splitlines()[-1]), {'code': 'mirror-unreachable', 'status': 503})
        result = self.run_script('200')
        self.assertEqual((result.returncode, result.stdout, result.stderr), (2, '', 'TODO(copy)\n'))


if __name__ == '__main__':
    unittest.main(verbosity=2)
