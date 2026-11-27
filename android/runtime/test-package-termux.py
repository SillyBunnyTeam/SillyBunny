#!/usr/bin/env python3
import hashlib
import importlib.util
import io
import json
import subprocess
import sys
import tarfile
import tempfile
import unittest
from pathlib import Path
from unittest import mock


sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location('package_termux', ROOT / 'package-termux.py')
termux = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(termux)
MIRROR = 'ghcr.io/example/runtime'


def runtime_lock(**changes):
    packages = [{
        'name': name, 'version': '1.0',
        'debs': {abi: {'filename': f'pool/main/{name[0]}/{name}/{name}_1.0_{arch}.deb',
                       'sha256': hashlib.sha256(f'{name} {arch}'.encode()).hexdigest()}
                 for abi, (arch, _, _) in termux.ABI_ARCHES.items()},
    } for name in ('bash', 'ca-certificates', 'git')]
    lock = {
        'schema': 1, 'abis': list(termux.ABI_ARCHES),
        'termux': {'repository': 'https://packages.example.invalid/apt/termux-main', 'suite': 'stable',
                   'component': 'main', 'packages': packages},
        'node': None, 'npm': None, 'bun': None,
    }
    lock.update(changes)
    return lock


def extract_members(payload, members):
    with io.BytesIO() as stream:
        with tarfile.open(fileobj=stream, mode='w') as archive:
            for kind, name, contents in members:
                member = tarfile.TarInfo(name)
                if kind == 'file':
                    member.size = len(contents)
                    archive.addfile(member, io.BytesIO(contents))
                else:
                    member.type = {'symlink': tarfile.SYMTYPE, 'hardlink': tarfile.LNKTYPE}[kind]
                    member.linkname = contents
                    archive.addfile(member)
        stream.seek(0)
        with mock.patch.object(termux.subprocess, 'Popen') as popen:
            process = popen.return_value.__enter__.return_value
            process.stdout = stream
            process.wait.return_value = 0
            payload.extract('git', Path('fixture.deb'))


def elf_metadata(abi='x86_64', **changes):
    machine, bits = {
        'arm64-v8a': ('EM_AARCH64', 64),
        'armeabi-v7a': ('EM_ARM', 32),
        'x86_64': ('EM_X86_64', 64),
    }[abi]
    data = {
        'class': bits, 'machine': machine, 'type': 'ET_DYN', 'littleEndian': True,
        'interpreter': '/system/bin/linker' if bits == 32 else '/system/bin/linker64',
        'needed': ['libc.so', 'libm.so', 'libdl.so', 'liblog.so', 'libbundled.so'],
        'soname': 'libgit.so', 'rpaths': [], 'versionNeeded': [],
        'loads': [{'p_offset': 0x1000, 'p_vaddr': 0x5000, 'p_align': 0x4000}],
    }
    data.update(changes)
    return data


class ScratchTestCase(unittest.TestCase):
    def setUp(self):
        cache = ROOT / 'cache'
        cache.mkdir(exist_ok=True)
        scratch = tempfile.TemporaryDirectory(prefix='termux-tests-', dir=cache)
        self.addCleanup(scratch.cleanup)
        self.directory = Path(scratch.name)


class DownloadTests(ScratchTestCase):
    def test_default_download_refuses_corrupt_cache_without_downloading(self):
        destination = self.directory / 'cached.deb'
        contents = b'corrupt cache contents'
        destination.write_bytes(contents)
        expected = hashlib.sha256(b'pinned package contents').hexdigest()
        with mock.patch.object(termux, 'run') as run, mock.patch.object(termux, 'require_tools') as require_tools:
            with self.assertRaisesRegex(ValueError, 'SHA256 mismatch:'):
                termux.download('https://example.invalid', 'pool/git.deb', destination, expected)
        run.assert_not_called()
        require_tools.assert_not_called()
        self.assertEqual(destination.read_bytes(), contents)
        self.assertEqual(list(self.directory.iterdir()), [destination])

    def test_verified_cache_is_reused_without_tools_or_downloads(self):
        destination = self.directory / 'cached.deb'
        contents = b'pinned package contents'
        destination.write_bytes(contents)
        expected = hashlib.sha256(contents).hexdigest().upper()
        with mock.patch.object(termux, 'run') as run, mock.patch.object(termux, 'require_tools') as require_tools:
            with mock.patch('sys.stdout', new_callable=io.StringIO):
                result = termux.download('https://example.invalid', 'pool/git.deb', destination, expected)
        self.assertEqual(result, destination)
        self.assertEqual(destination.read_bytes(), contents)
        run.assert_not_called()
        require_tools.assert_not_called()


class MirrorDebTests(ScratchTestCase):
    def setUp(self):
        super().setUp()
        self.cache = self.directory / 'cache'
        self.contents = {abi: f'fixture git {arch} deb\n'.encode() for abi, (arch, _, _) in termux.ABI_ARCHES.items()}
        debs = {abi: {'filename': f'pool/main/g/git/git_2.56.0_{arch}.deb',
                      'sha256': hashlib.sha256(self.contents[abi]).hexdigest()}
                for abi, (arch, _, _) in termux.ABI_ARCHES.items()}
        debs['x86_64']['sha256'] = debs['x86_64']['sha256'].upper()
        self.debs = debs
        self.lock = {'termux': {'repository': 'https://packages.example.invalid/apt/termux-main',
                                'packages': [{'name': 'git', 'version': '2.56.0', 'debs': debs}]},
                     'mirror': {'repository': MIRROR}}
        self.served = {}
        self.asked = []
        self.downloaded = []
        for target, replacement in ((termux, 'require_tools'), (termux, 'run'), (termux.sources, 'mirror_blob')):
            patch = mock.patch.object(target, replacement, side_effect=getattr(self, 'fake_' + replacement))
            patch.start()
            self.addCleanup(patch.stop)

    def fake_require_tools(self, *names):
        pass

    def fake_mirror_blob(self, repository, sha256, destination):
        self.assertEqual(repository, MIRROR)
        self.asked.append(sha256)
        if sha256 not in self.served:
            return False
        Path(destination).write_bytes(self.served[sha256])
        return True

    def fake_run(self, arguments, **kwargs):
        values = [str(item) for item in arguments]
        if values[0] == 'dpkg-deb':
            abi = next(abi for abi, pin in self.debs.items() if Path(values[-1]).name == pin['sha256'].lower() + '.deb')
            fields = f'Package: git\nVersion: 2.56.0\nArchitecture: {termux.ABI_ARCHES[abi][0]}\n'
            return subprocess.CompletedProcess(values, 0, stdout=fields, stderr='')
        if values[0] == 'curl':
            self.downloaded.append(values[-1])
            abi = next(abi for abi, pin in self.debs.items() if values[-1].endswith('/' + pin['filename']))
            Path(values[values.index('--output') + 1]).write_bytes(self.contents[abi])
            return subprocess.CompletedProcess(values, 0)
        raise AssertionError(('unexpected command', values))

    def fetch(self, mirror_only=False):
        with mock.patch('sys.stdout', new_callable=io.StringIO):
            return termux.fetch_debs(self.lock, self.cache, mirror_only)

    def digests(self):
        return [self.debs[abi]['sha256'].lower() for abi in termux.ABI_ARCHES]

    def cached(self):
        return sorted(path.name for path in (self.cache / 'debs').iterdir())

    def test_mirror_hit_means_no_origin_download(self):
        self.served = {sha256: self.contents[abi] for abi, sha256 in zip(termux.ABI_ARCHES, self.digests())}
        debs = self.fetch()
        self.assertEqual(self.downloaded, [])
        self.assertEqual(self.asked, self.digests())
        for abi in termux.ABI_ARCHES:
            ((name, path),) = debs[abi]
            self.assertEqual(name, 'git')
            self.assertEqual(path, self.cache / 'debs' / (self.debs[abi]['sha256'].lower() + '.deb'))
            self.assertEqual(path.read_bytes(), self.contents[abi])

    def test_mirror_miss_downloads_from_the_origin(self):
        self.fetch()
        self.assertEqual(self.asked, self.digests())
        self.assertEqual(self.downloaded, [f'https://packages.example.invalid/apt/termux-main/{self.debs[abi]["filename"]}'
                                           for abi in termux.ABI_ARCHES])
        self.assertEqual(self.cached(), sorted(sha256 + '.deb' for sha256 in self.digests()))

    def test_mirror_only_miss_fails_without_an_origin_download(self):
        with self.assertRaisesRegex(ValueError, 'Not in the mirror: pool/main/g/git/git_2.56.0_aarch64.deb'):
            self.fetch(mirror_only=True)
        self.assertEqual(self.downloaded, [])
        self.assertEqual(self.cached(), [])

    def test_mismatching_mirror_bytes_fail_and_leave_nothing_at_the_destination(self):
        self.served = {self.digests()[0]: b'tampered deb'}
        for mirror_only in (False, True):
            with self.subTest(mirror_only=mirror_only):
                with self.assertRaisesRegex(ValueError, 'SHA256 mismatch from the mirror'):
                    self.fetch(mirror_only)
                self.assertEqual(self.downloaded, [])
                self.assertEqual(self.cached(), [])

    def test_cached_deb_needs_no_mirror_request(self):
        destination = self.cache / 'debs' / (self.digests()[0] + '.deb')
        destination.parent.mkdir(parents=True)
        destination.write_bytes(self.contents['arm64-v8a'])
        self.fetch()
        self.assertEqual(self.asked, self.digests()[1:])

    def test_lock_without_mirror_never_asks_the_mirror(self):
        del self.lock['mirror']
        self.fetch()
        self.assertEqual(self.asked, [])
        self.assertEqual(len(self.downloaded), 3)


class MirrorLockTests(ScratchTestCase):
    def test_mirror_field_is_checked_as_sources_validate_runtime_checks_it(self):
        termux.validate_lock(runtime_lock())
        valid = [{'repository': MIRROR}, {'repository': 'ghcr.io/sillybunnyteam/sillybunny-android-runtime'}]
        invalid = [None, {}, 'ghcr.io/example/runtime', {'repository': MIRROR, 'tag': 'inputs'},
                   {'repository': 'docker.io/example/runtime'}, {'repository': 'ghcr.io/example'},
                   {'repository': 'ghcr.io/Example/runtime'}, {'repository': MIRROR + ':inputs-0123456789ab'},
                   {'repository': MIRROR + '@sha256:' + '0' * 64}, {'repository': None}]
        for mirror in valid + invalid:
            with self.subTest(mirror=mirror):
                lock = runtime_lock(mirror=mirror)
                try:
                    termux.sources.validate_runtime(lock)
                except termux.sources.SourceError as error:
                    self.assertEqual(error.code, 'runtime-mirror')
                    self.assertIn(mirror, invalid)
                    with self.assertRaisesRegex(ValueError, 'runtime.lock mirror must be'):
                        termux.validate_lock(lock)
                else:
                    self.assertIn(mirror, valid)
                    termux.validate_lock(lock)

    def main(self, lock, *arguments):
        root = self.directory / 'android' / 'runtime'
        root.mkdir(parents=True, exist_ok=True)
        (root.parent / 'runtime.lock').write_text(json.dumps(lock), encoding='utf-8')
        with mock.patch.object(termux, 'ROOT', root), mock.patch.object(termux, 'build') as build, \
                mock.patch.object(termux, 'update_lock') as update, \
                mock.patch.object(sys, 'argv', ['package-termux.py', *arguments]), \
                mock.patch('sys.stderr', new_callable=io.StringIO):
            termux.main()
        update.assert_not_called()
        return build

    def test_command_line_passes_mirror_only_to_the_build(self):
        lock = runtime_lock(mirror={'repository': MIRROR})
        root = self.directory / 'android' / 'runtime'
        for arguments, mirror_only in (((), False), (('--mirror-only',), True)):
            with self.subTest(arguments=arguments):
                build = self.main(lock, *arguments)
                build.assert_called_once_with(lock, root.parent / 'runtime.lock', root / 'cache', mirror_only)

    def test_mirror_only_needs_a_lock_mirror_and_cannot_update_the_lock(self):
        for lock, arguments in ((runtime_lock(), ('--mirror-only',)),
                                (runtime_lock(mirror={'repository': MIRROR}), ('--mirror-only', '--update-lock'))):
            with self.subTest(arguments=arguments):
                with self.assertRaises(SystemExit) as caught:
                    self.main(lock, *arguments)
                self.assertEqual(caught.exception.code, 2)


class ShellPatchTests(ScratchTestCase):
    def test_exactly_one_literal_is_nul_padded_without_changing_length(self):
        before, after = b'\x7fELF\x01\x02', b'\0untouched trailer\xff'
        contents = before + termux.OLD_SHELL + b'\0' + after
        replacement = termux.NEW_SHELL + b'\0' * (len(termux.OLD_SHELL) - len(termux.NEW_SHELL))
        for name in ('libgit.so', 'libgit-remote-http.so'):
            with self.subTest(name=name):
                path = self.directory / name
                path.write_bytes(contents)
                termux.patch_shell(path)
                patched = path.read_bytes()
                self.assertEqual(len(patched), len(contents))
                self.assertEqual(patched, before + replacement + b'\0' + after)
                self.assertNotIn(termux.OLD_SHELL, patched)

    def test_missing_multiple_and_unterminated_literals_leave_file_unchanged(self):
        cases = {
            'zero': b'\x7fELFno shell literal\0',
            'already patched': termux.NEW_SHELL + b'\0',
            'multiple': (termux.OLD_SHELL + b'\0') * 2,
            'unterminated': termux.OLD_SHELL,
            'longer path': termux.OLD_SHELL + b'-extra\0',
            'one terminated plus one unterminated': termux.OLD_SHELL + b'\0' + termux.OLD_SHELL,
        }
        path = self.directory / 'libgit.so'
        for label, contents in cases.items():
            with self.subTest(case=label):
                path.write_bytes(contents)
                with self.assertRaisesRegex(ValueError, 'exactly one NUL-terminated'):
                    termux.patch_shell(path)
                self.assertEqual(path.read_bytes(), contents)


class PoolFilenameTests(unittest.TestCase):
    def test_accepts_relative_pool_debs_with_debian_version_characters(self):
        for filename in (
            'pool/main/g/git/git_2.56.0_aarch64.deb',
            'pool/main/c/ca-certificates/ca-certificates_1:2026.09.25_all.deb',
            'pool/main/l/libc++/libc++_30~rc1-1_arm.deb',
        ):
            with self.subTest(filename=filename):
                self.assertEqual(termux.pool_filename(filename), filename)

    def test_rejects_invalid_or_escaping_pool_paths(self):
        for filename in (
            None, 42, '', 'git.deb', '/pool/git.deb', 'https://example.invalid/pool/git.deb',
            'pool/../git.deb', 'pool/main/./git.deb', 'pool/main//git.deb',
            'pool/%2e%2e/git.deb', 'pool/main\\git.deb', 'pool/git.deb/extra',
            'pool/git.deb?query', 'pool/git.deb#fragment', 'pool/git.deb\n',
            'pool/git package.deb', 'pool/git.tar.gz',
        ):
            with self.subTest(filename=filename):
                with self.assertRaises(ValueError):
                    termux.pool_filename(filename)


class PayloadTests(ScratchTestCase):
    def test_virtual_relative_absolute_and_hard_links_resolve_to_regular_file(self):
        payload = termux.Payload(self.directory / 'objects')
        binary = termux.PREFIX + 'bin/git'
        core = termux.PREFIX + 'libexec/git-core/'
        members = [
            ('file', binary, b'regular executable contents'),
            ('symlink', core + 'git-upload-pack', '../../bin/git'),
            ('symlink', core + 'git-receive-pack', '/' + binary),
            ('hardlink', core + 'git-upload-archive', './' + binary),
            ('symlink', core + 'git', 'git-upload-pack'),
        ]
        extract_members(payload, members)
        source, owner = payload.resolve(binary)
        self.assertEqual(owner, 'git')
        self.assertEqual(source.read_bytes(), members[0][2])
        self.assertTrue(source.is_file())
        self.assertFalse(source.is_symlink())
        self.assertEqual(list(payload.directory.iterdir()), [source])
        for _, name, _ in members[1:]:
            with self.subTest(name=name):
                self.assertEqual(payload.entries[name][0], 'link')
                self.assertEqual(payload.resolve(name), (source, 'git'))

    def test_normalizes_safe_payload_paths(self):
        self.assertEqual(termux.Payload.path('./' + termux.PREFIX + 'bin//git'), termux.PREFIX + 'bin/git')

    def test_rejects_paths_outside_termux_prefix(self):
        for name in (
            '/' + termux.PREFIX + 'bin/git', '../' + termux.PREFIX + 'bin/git',
            termux.PREFIX + 'bin/../git', termux.PREFIX + 'bin\\git',
            'data/data/com.termux/files/usr2/bin/git', 'data/data/com.termux/files/home/git',
        ):
            with self.subTest(name=name):
                with self.assertRaisesRegex(ValueError, 'escapes Termux prefix'):
                    termux.Payload.path(name)

    def test_extraction_rejects_escaping_members_and_virtual_link_targets(self):
        alias = termux.PREFIX + 'libexec/git-core/escape'
        cases = [
            ('file', '../../escape', b'outside'),
            ('file', termux.PREFIX + '../escape', b'outside'),
            ('symlink', alias, '/etc/passwd'),
            ('symlink', alias, '../../../home/escape'),
            ('symlink', alias, '..\\..\\escape'),
            ('hardlink', alias, 'data/data/com.termux/files/home/escape'),
        ]
        for index, member in enumerate(cases):
            with self.subTest(member=member):
                payload = termux.Payload(self.directory / f'objects-{index}')
                with self.assertRaisesRegex(ValueError, 'escapes Termux prefix'):
                    extract_members(payload, [member])
                self.assertEqual(payload.entries, {})
                self.assertEqual(list(payload.directory.iterdir()), [])

    def test_missing_files_and_broken_virtual_links_fail_closed(self):
        payload = termux.Payload(self.directory / 'objects')
        alias = termux.PREFIX + 'bin/alias'
        missing = termux.PREFIX + 'bin/missing'
        extract_members(payload, [('symlink', alias, 'missing')])
        for name in (missing, alias):
            with self.subTest(name=name):
                with self.assertRaisesRegex(ValueError, 'Missing package file or broken symlink'):
                    payload.resolve(name)

    def test_self_and_two_link_loops_fail_closed(self):
        first, second = termux.PREFIX + 'bin/first', termux.PREFIX + 'bin/second'
        cases = [
            [('symlink', first, 'first')],
            [('symlink', first, 'second'), ('symlink', second, 'first')],
        ]
        for index, members in enumerate(cases):
            with self.subTest(links=len(members)):
                payload = termux.Payload(self.directory / f'objects-{index}')
                extract_members(payload, members)
                with self.assertRaisesRegex(ValueError, 'Package symlink loop'):
                    payload.resolve(first)
                self.assertEqual(list(payload.directory.iterdir()), [])


class ElfValidationTests(unittest.TestCase):
    def validate(self, data, abi='x86_64', name='libgit.so', names=('libgit.so', 'libbundled.so')):
        path = Path(name)
        with mock.patch.object(termux, 'inspect_elf', return_value=data) as inspect:
            result = termux.validate_elf(path, abi, set(names))
        inspect.assert_called_once_with(path)
        return result

    def test_accepts_matching_architectures_and_resolved_dependencies(self):
        for abi in ('arm64-v8a', 'armeabi-v7a', 'x86_64'):
            with self.subTest(abi=abi):
                data = elf_metadata(abi)
                self.assertIs(self.validate(data, abi), data)

    def test_rejects_wrong_machine_class_byte_order_and_type(self):
        for abi in ('arm64-v8a', 'armeabi-v7a', 'x86_64'):
            for field, value in (
                ('machine', 'EM_386'), ('class', 64 if abi == 'armeabi-v7a' else 32),
                ('littleEndian', False), ('type', 'ET_EXEC'),
            ):
                with self.subTest(abi=abi, field=field):
                    data = elf_metadata(abi)
                    data[field] = value
                    with self.assertRaisesRegex(ValueError, 'Wrong ELF architecture/type'):
                        self.validate(data, abi)

    def test_unresolved_needed_including_non_allowlisted_android_libraries_is_rejected(self):
        for needed in ('libmissing.so', 'libandroid.so', 'libz.so', 'libc++_shared.so', 'libc.so.6'):
            with self.subTest(needed=needed):
                data = elf_metadata()
                data['needed'].append(needed)
                with self.assertRaisesRegex(ValueError, 'Unresolved DT_NEEDED') as error:
                    self.validate(data)
                self.assertIn(needed, str(error.exception))

    def test_needed_must_be_present_in_output_set(self):
        with self.assertRaisesRegex(ValueError, 'Unresolved DT_NEEDED.*libbundled.so'):
            self.validate(elf_metadata(), names={'libgit.so'})

    def test_rejects_either_rpath_tag(self):
        for tag in ('DT_RPATH', 'DT_RUNPATH'):
            with self.subTest(tag=tag):
                with self.assertRaisesRegex(ValueError, 'RPATH/RUNPATH remains'):
                    self.validate(elf_metadata(rpaths=[tag]))

    def test_rejects_invalid_apk_native_names(self):
        for name in ('git', 'git.so', 'Libgit.so', 'libgit.so.1', 'libgit space.so', 'libgit@.so', 'libgit.so\n'):
            with self.subTest(name=name):
                with self.assertRaisesRegex(ValueError, 'Invalid APK native filename'):
                    self.validate(elf_metadata(soname=None), name=name)

    def test_accepts_permitted_native_name_punctuation(self):
        for name in ('libgit-remote-http.so', 'libc++.so', 'libpcre2-8.so', 'libname_1.2.so'):
            with self.subTest(name=name):
                data = elf_metadata(soname=name)
                self.assertIs(self.validate(data, name=name), data)

    def test_rejects_stale_soname_and_unexpected_interpreter(self):
        for changes, message in (
            ({'soname': 'libgit.so.1'}, 'SONAME differs'),
            ({'interpreter': '/system/bin/linker'}, 'Unexpected ELF interpreter'),
            ({'interpreter': '/data/data/com.termux/files/usr/bin/linker64'}, 'Unexpected ELF interpreter'),
        ):
            with self.subTest(changes=changes):
                with self.assertRaisesRegex(ValueError, message):
                    self.validate(elf_metadata(**changes))

    def test_every_64bit_load_requires_at_least_16k_alignment(self):
        for abi in ('arm64-v8a', 'x86_64'):
            for alignment in (0x1000, 0x2000):
                with self.subTest(abi=abi, alignment=alignment):
                    data = elf_metadata(abi)
                    data['loads'].append({'p_offset': 0, 'p_vaddr': 0x4000, 'p_align': alignment})
                    with self.assertRaisesRegex(ValueError, '64-bit ELF LOAD is not 16 KB aligned'):
                        self.validate(data, abi)

    def test_rejects_missing_or_malformed_load_segments(self):
        with self.assertRaisesRegex(ValueError, 'No ELF LOAD segments'):
            self.validate(elf_metadata(loads=[]))
        for load in (
            {'p_offset': 0, 'p_vaddr': 0, 'p_align': 0},
            {'p_offset': 0, 'p_vaddr': 0, 'p_align': -0x1000},
            {'p_offset': 0, 'p_vaddr': 0, 'p_align': 0x3000},
            {'p_offset': 0x1000, 'p_vaddr': 0x2000, 'p_align': 0x4000},
        ):
            with self.subTest(load=load):
                with self.assertRaisesRegex(ValueError, 'Invalid ELF LOAD alignment'):
                    self.validate(elf_metadata(loads=[load]))

    def test_valid_32bit_4k_load_need_not_be_16k_congruent(self):
        data = elf_metadata('armeabi-v7a', loads=[{'p_offset': 0x1000, 'p_vaddr': 0x2000, 'p_align': 0x1000}])
        self.assertIs(self.validate(data, 'armeabi-v7a'), data)


if __name__ == '__main__':
    unittest.main(verbosity=2)
