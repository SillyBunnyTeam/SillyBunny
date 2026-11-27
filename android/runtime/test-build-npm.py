#!/usr/bin/env python3
import importlib.util
import io
import json
import sys
import tarfile
import tempfile
import unittest
import zipfile
from pathlib import Path

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parent


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, ROOT / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


node = load('runtime_fetch_node', 'fetch-node.py')
npm = load('runtime_build_npm', 'build-npm.py')
npm.node = node
npm.fail = node.fail

COMMITTED = json.loads((ROOT.parent / 'runtime.lock').read_text(encoding='utf-8'))
NODE_VERSION = COMMITTED['node']['version']
NPM_VERSION = COMMITTED['npm']['version']


def write_tarball(path, members):
    with tarfile.open(path, mode='w:xz', format=tarfile.PAX_FORMAT) as archive:
        for name, kind, contents, mode in members:
            member = tarfile.TarInfo(name)
            member.mode = mode
            if kind == 'file':
                member.size = len(contents)
                archive.addfile(member, io.BytesIO(contents))
            elif kind == 'directory':
                member.type = tarfile.DIRTYPE
                archive.addfile(member)
            elif kind == 'symlink':
                member.type = tarfile.SYMTYPE
                member.linkname = contents.decode('utf-8')
                archive.addfile(member)
    return path


class BuildNpmStripTests(unittest.TestCase):
    def setUp(self):
        scratch = tempfile.TemporaryDirectory(prefix='build-npm-strip-')
        self.addCleanup(scratch.cleanup)
        self.directory = Path(scratch.name)
        self.prefix = f'node-v{NODE_VERSION}/deps/npm/'

    def base_members(self):
        pkg = json.dumps({'name': 'npm', 'version': NPM_VERSION}).encode('utf-8')
        return [
            (f'node-v{NODE_VERSION}/', 'directory', b'', 0o755),
            (f'node-v{NODE_VERSION}/LICENSE', 'file', b'MIT\n', 0o644),
            (self.prefix, 'directory', b'', 0o755),
            (self.prefix + 'LICENSE', 'file', b'Artistic-2.0\n', 0o644),
            (self.prefix + 'package.json', 'file', pkg, 0o644),
            (self.prefix + 'bin/npm-cli.js', 'file', b'#!/usr/bin/env node\n', 0o755),
            (self.prefix + 'bin/npx-cli.js', 'file', b'#!/usr/bin/env node\n', 0o755),
            (self.prefix + 'lib/cli.js', 'file', b'module.exports = 1\n', 0o644),
            (self.prefix + 'node_modules/pkg/index.js', 'file', b'module.exports = 2\n', 0o644),
            (self.prefix + 'node_modules/pkg/LICENSE', 'file', b'ISC\n', 0o644),
            (self.prefix + 'docs/', 'directory', b'', 0o755),
            (self.prefix + 'docs/output/commands/npm-install.html', 'file', b'<html>help</html>\n', 0o644),
            (self.prefix + 'man/', 'directory', b'', 0o755),
            (self.prefix + 'man/man1/npm.1', 'file', b'.TH NPM 1\n', 0o644),
            (self.prefix + 'man/man5/package-json.5', 'file', b'.TH PACKAGE 5\n', 0o644),
        ]

    def test_tarball_entries_and_prepare_strip_docs_and_man_while_keeping_licenses_and_code(self):
        tarball = write_tarball(self.directory / 'node.tar.xz', self.base_members())
        entries = npm.tarball_entries(tarball, NODE_VERSION)
        self.assertEqual(sorted(entries), [
            'LICENSE',
            'bin/npm-cli.js',
            'bin/npx-cli.js',
            'lib/cli.js',
            'node_modules/pkg/LICENSE',
            'node_modules/pkg/index.js',
            'package.json',
        ])
        pins = node.load_pins(ROOT.parent / 'runtime.lock', ROOT / 'sources.lock')
        data, summary = npm.prepare(pins, tarball)
        self.assertEqual(summary['files'], 7)
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            names = [info.filename for info in archive.infolist()]
        self.assertTrue(all(not name.startswith(('docs/', 'man/')) for name in names))
        self.assertIn('bin/npm-cli.js', names)
        self.assertIn('LICENSE', names)

    def test_unsafe_entries_inside_docs_or_man_are_still_rejected(self):
        bad_symlink = [*self.base_members(), (self.prefix + 'docs/link', 'symlink', b'../package.json', 0o777)]
        tarball = write_tarball(self.directory / 'bad.tar.xz', bad_symlink)
        with self.assertRaises(ValueError) as caught:
            npm.tarball_entries(tarball, NODE_VERSION)
        self.assertEqual(getattr(caught.exception, 'code', None), 'npm-entry-type')


if __name__ == '__main__':
    unittest.main()
