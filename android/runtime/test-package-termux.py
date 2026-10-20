#!/usr/bin/env python3
import hashlib
import importlib.util
import io
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
