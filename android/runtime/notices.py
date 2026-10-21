#!/usr/bin/env python3
import argparse
import hashlib
import json
import os
import re
import shutil
import stat
import sys
import tempfile
from pathlib import Path, PurePosixPath
from urllib.parse import quote, urlsplit


sys.dont_write_bytecode = True
ROOT = Path(__file__).absolute().parent
PLACEHOLDER = 'lorum ipsum'
NOTICES_NAME = 'THIRD_PARTY_NOTICES'
INDEX_NAME = 'THIRD_PARTY_NOTICES.json'
SECTIONS = ('android', 'node', 'npm', 'termux')
TERMUX_REPOSITORY = 'https://github.com/termux/termux-packages'
TERMUX_NAME = re.compile(r'[a-z0-9][a-z0-9+.-]*\Z')
NPM_NAME = re.compile(r'(?:@[a-z0-9][a-z0-9._~-]*/)?[a-z0-9][a-z0-9._~-]*\Z')
VERSION = re.compile(r'[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?\Z')
LICENSE_NAME = re.compile(r'(?:(?:un)?licen[cs](?:e|ing)|copying|copyright|notice)', re.IGNORECASE)
SHA256 = re.compile(r'[0-9a-fA-F]{64}\Z')
COMMIT = re.compile(r'[0-9a-fA-F]{40}\Z')


class NoticesError(ValueError):
    def __init__(self, code, **details):
        super().__init__(PLACEHOLDER)
        self.code = code
        self.details = details


def fail(code, **details):
    raise NoticesError(code, **details)


def sha256(contents):
    return hashlib.sha256(contents).hexdigest()


def text(value, field):
    if not isinstance(value, str) or not value or value != value.strip():
        fail('metadata-text', field=field)
    if any(not char.isprintable() for char in value):
        fail('metadata-text', field=field)
    return value


def relative_path(value, field='path'):
    text(value, field)
    parts = value.split('/')
    if any(part in ('', '.', '..') for part in parts) or '\\' in value or ':' in value:
        fail('relative-path', field=field, path=value)
    return value


def https_url(value, field):
    text(value, field)
    try:
        url = urlsplit(value)
        port = url.port
    except ValueError:
        fail('https-url', field=field)
    if (url.scheme != 'https' or not url.hostname or url.username is not None or url.password is not None
            or url.fragment or url.query or '\\' in value or any(char.isspace() for char in value)
            or not value.isascii() or port not in (None, 443)):
        fail('https-url', field=field)
    return value


def spdx_expression(value, field):
    if value is None:
        return None
    text(value, field)
    tokens = re.findall(r'\(|\)|[^\s()]+', value)
    position = 0

    def identifier():
        nonlocal position
        if (position >= len(tokens) or tokens[position] in ('AND', 'OR', 'WITH')
                or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9.+:-]*', tokens[position])):
            fail('spdx-expression', field=field)
        position += 1

    def expression(depth=0):
        nonlocal position
        if depth > 64:
            fail('spdx-expression', field=field)
        while True:
            if position < len(tokens) and tokens[position] == '(':
                position += 1
                expression(depth + 1)
                if position >= len(tokens) or tokens[position] != ')':
                    fail('spdx-expression', field=field)
                position += 1
            else:
                identifier()
                if position < len(tokens) and tokens[position] == 'WITH':
                    position += 1
                    identifier()
            if position >= len(tokens) or tokens[position] not in ('AND', 'OR'):
                return
            position += 1

    expression()
    if position != len(tokens):
        fail('spdx-expression', field=field)
    return value


def safe_path(value):
    try:
        path = Path(value)
    except (TypeError, ValueError):
        fail('input-path')
    if '..' in path.parts or '\\' in str(path) or any(not char.isprintable() for char in str(path)):
        fail('input-path', path=str(path))
    path = path.absolute()
    for current in (*reversed(path.parents), path):
        try:
            mode = current.lstat().st_mode
        except FileNotFoundError:
            continue
        if stat.S_ISLNK(mode):
            fail('symlink', path=str(current))
        if current != path and not stat.S_ISDIR(mode):
            fail('directory', path=str(current))
    return path


def directory(value):
    path = safe_path(value)
    if not stat.S_ISDIR(path.lstat().st_mode):
        fail('directory', path=str(path))
    return path


def read_bytes(value):
    path = safe_path(value)
    if not stat.S_ISREG(path.lstat().st_mode):
        fail('regular-file', path=str(path))
    descriptor = os.open(path, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0) | getattr(os, 'O_NONBLOCK', 0))
    with os.fdopen(descriptor, 'rb') as stream:
        if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode):
            fail('regular-file', path=str(path))
        return stream.read()


def json_bytes(contents, label):
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                fail('json-duplicate-key', field=key, path=label)
            result[key] = value
        return result

    def constant(value):
        fail('json-constant', field=value, path=label)

    try:
        result = json.loads(contents.decode('utf-8'), object_pairs_hook=pairs, parse_constant=constant)
    except NoticesError:
        raise
    except (UnicodeDecodeError, ValueError, RecursionError):
        fail('json', path=label)
    if not isinstance(result, dict):
        fail('json-object', path=label)
    return result


def read_json(value):
    path = safe_path(value)
    contents = read_bytes(path)
    return json_bytes(contents, str(path)), contents


def scan_tree(value):
    root = directory(value)
    files = {}
    directories = {''}
    pending = [root]
    while pending:
        parent = pending.pop()
        for path in sorted(parent.iterdir()):
            relative = relative_path(path.relative_to(root).as_posix())
            mode = path.lstat().st_mode
            if stat.S_ISLNK(mode):
                fail('symlink', path=str(path))
            if stat.S_ISDIR(mode):
                directories.add(relative)
                pending.append(path)
            elif stat.S_ISREG(mode):
                files[relative] = path
            else:
                fail('regular-file', path=str(path))
    return root, dict(sorted(files.items())), directories


def license_input(path, relative):
    relative_path(relative, 'license.path')
    contents = read_bytes(path)
    if not contents.strip() or any(byte < 32 and byte not in (9, 10, 12, 13) or byte == 127 for byte in contents):
        fail('license-text', path=str(path))
    try:
        decoded = contents.decode('utf-8')
        encoding = 'utf-8'
    except UnicodeDecodeError:
        # The extracted Termux CeCILL license uses Latin-1; preserve its bytes.
        if any(0x80 <= byte < 0xA0 for byte in contents):
            fail('license-encoding', path=str(path))
        decoded = contents.decode('iso-8859-1')
        encoding = 'iso-8859-1'
    if not decoded.removeprefix('\ufeff').strip() or any(0x80 <= ord(char) < 0xA0 for char in decoded):
        fail('license-text', path=str(path))
    return {'path': relative, 'sha256': sha256(contents), 'encoding': encoding,
            'contents': contents, 'inputPath': safe_path(path)}


def component(identifier, section, name, version, spdx, source_url, licenses):
    for field, value in (('id', identifier), ('name', name), ('version', version)):
        text(value, field)
    if section not in SECTIONS:
        fail('section', section=section)
    spdx_expression(spdx, 'spdx')
    https_url(source_url, 'sourceUrl')
    if not licenses:
        fail('licenses-missing', component=identifier)
    paths = [item['path'] for item in licenses]
    if len(paths) != len(set(paths)):
        fail('license-duplicate', component=identifier)
    return {'id': identifier, 'section': section, 'name': name, 'version': version, 'spdx': spdx,
            'sourceUrl': source_url, 'licenses': sorted(licenses, key=lambda item: item['path'])}


def package_map(value, label):
    if not isinstance(value, list) or not value:
        fail('package-list', field=label)
    packages = {}
    for package in value:
        if (not isinstance(package, dict) or not isinstance(package.get('name'), str)
                or not TERMUX_NAME.fullmatch(package['name'])):
            fail('package-name', field=label)
        name = package['name']
        text(package.get('version'), label + '.version')
        if name in packages:
            fail('component-duplicate', component='termux/' + name)
        packages[name] = package
    return packages


def validate_locks(runtime, sources, runtime_sha256):
    for label, value in (('runtime', runtime), ('sources', sources)):
        if type(value.get('schema')) is not int or value['schema'] != 1:
            fail('schema', field=label)
        if not isinstance(value.get('termux'), dict):
            fail('termux', field=label)
    for name in ('node', 'npm', 'bun'):
        if name not in runtime or runtime[name] is not None and not isinstance(runtime[name], dict):
            fail('runtime-section', field=name)
    if runtime['bun'] is not None:
        fail('unsupported-runtime', field='bun')
    for name in ('node', 'npm'):
        pin = runtime[name]
        if name not in sources:
            fail('sources-runtime-section', field=name)
        source = sources[name]
        if pin is None:
            if source is not None:
                fail('runtime-source-mismatch', field=name)
            continue
        version = text(pin.get('version'), name + '.version').removeprefix('v')
        if not VERSION.fullmatch(version):
            fail('runtime-version', field=name)
        if not isinstance(source, dict) or source.get('version') != version:
            fail('runtime-source-mismatch', field=name)
    if runtime['npm'] is not None and (runtime['node'] is None or sources['npm'].get('source') != 'node'):
        fail('npm-source-mismatch')
    if (not isinstance(sources.get('runtimeLockSha256'), str)
            or not SHA256.fullmatch(sources['runtimeLockSha256'])
            or sources['runtimeLockSha256'].lower() != runtime_sha256):
        fail('runtime-lock-sha256')
    termux = sources['termux']
    if termux.get('repository') != TERMUX_REPOSITORY:
        fail('termux-repository')
    if not isinstance(termux.get('historyTip'), str) or not COMMIT.fullmatch(termux['historyTip']):
        fail('termux-history-tip')
    pinned = package_map(runtime['termux'].get('packages'), 'runtime.termux.packages')
    packages = package_map(termux.get('packages'), 'sources.termux.packages')
    if {name: item['version'] for name, item in pinned.items()} != {name: item['version'] for name, item in packages.items()}:
        fail('package-mismatch')
    for name, package in packages.items():
        if not isinstance(package.get('commit'), str) or not COMMIT.fullmatch(package['commit']):
            fail('recipe-commit', component='termux/' + name)
        recipe = relative_path(package.get('recipePath'), 'recipePath')
        if not recipe.startswith('packages/') or len(recipe.split('/')) != 2:
            fail('recipe-path', component='termux/' + name)
        text(package.get('license'), 'license')
        if 'spdx' not in package:
            fail('metadata-missing', field='spdx', component='termux/' + name)
        spdx_expression(package['spdx'], 'spdx')
        if 'homepage' not in package:
            fail('metadata-missing', field='homepage', component='termux/' + name)
        if package['homepage'] is not None:
            https_url(package['homepage'], 'homepage')
    return packages


def termux_components(packages, licenses_root):
    _, files, directories = scan_tree(licenses_root)
    roots = {path.split('/')[0] for path in directories if path}
    if roots != set(packages) or any('/' not in path for path in files):
        fail('license-package-mismatch')
    result = []
    for name, package in sorted(packages.items()):
        prefix = name + '/'
        licenses = [license_input(path, relative.removeprefix(prefix))
                    for relative, path in files.items() if relative.startswith(prefix)]
        source_url = TERMUX_REPOSITORY + '/tree/' + package['commit'].lower() + '/' + package['recipePath']
        result.append(component('termux/' + name, 'termux', name, package['version'], package['spdx'], source_url, licenses))
    return result


def node_component(node_source):
    _, files, _ = scan_tree(node_source)
    for required in ('LICENSE', 'src/node_version.h'):
        if required not in files:
            fail('node-input', field=required)
    try:
        header = read_bytes(files['src/node_version.h']).decode('utf-8')
    except UnicodeDecodeError:
        fail('node-version')
    version = []
    for name in ('MAJOR_VERSION', 'MINOR_VERSION', 'PATCH_VERSION', 'VERSION_IS_RELEASE'):
        matches = re.findall(r'^\s*#\s*define\s+NODE_' + name + r'\s+([0-9]+)\s*$', header, re.MULTILINE)
        if len(matches) != 1:
            fail('node-version', field=name)
        version.append(int(matches[0]))
    if version.pop() != 1:
        fail('node-release')
    version_string = '.'.join(str(number) for number in version)
    source_url = 'https://nodejs.org/dist/v' + version_string + '/node-v' + version_string + '.tar.xz'
    # Node's composite LICENSE includes dependencies with licenses beyond MIT.
    return component('node', 'node', 'node', version_string, None, source_url,
                     [license_input(files['LICENSE'], 'LICENSE')])


def is_license_path(relative):
    parts = PurePosixPath(relative).parts
    if any(LICENSE_NAME.match(part) for part in parts[:-1]):
        return True
    return bool(LICENSE_NAME.match(parts[-1]) and PurePosixPath(relative).suffix.lower()
                not in {'.js', '.cjs', '.mjs', '.ts', '.tsx', '.jsx', '.py', '.c', '.cc', '.h', '.cpp'})


def npm_spdx(metadata):
    aliases = {'Apache 2.0': 'Apache-2.0', 'BSD 2-Clause': 'BSD-2-Clause', 'BSD 3-Clause': 'BSD-3-Clause'}

    def declaration(value):
        if isinstance(value, dict):
            value = value.get('type')
        if not isinstance(value, str):
            fail('npm-license-metadata')
        return aliases.get(value, value)

    value = metadata.get('license')
    if value is not None:
        value = declaration(value)
    if 'licenses' in metadata:
        licenses = metadata['licenses']
        if not isinstance(licenses, list) or not licenses:
            fail('npm-license-metadata')
        values = sorted({declaration(item) for item in licenses})
        legacy = values[0] if len(values) == 1 else '(' + ' OR '.join(values) + ')'
        if value is not None and value != legacy:
            fail('npm-license-conflict')
        value = legacy
    if value is None or value in ('UNLICENSED', 'UNLICENCED'):
        return None
    if value.startswith('SEE LICENSE IN '):
        relative_path(value.removeprefix('SEE LICENSE IN '), 'license')
        return None
    return spdx_expression(value, 'license')


def npm_components(npm_root):
    _, files, directories = scan_tree(npm_root)
    roots = {''}
    for relative in sorted(directories):
        if PurePosixPath(relative).name != 'node_modules':
            continue
        prefix = relative + '/'
        children = {path for path in directories if path.startswith(prefix) and '/' not in path[len(prefix):]}
        stray_files = [path for path in files if path.startswith(prefix) and '/' not in path[len(prefix):]]
        if any(PurePosixPath(path).name != '.package-lock.json' for path in stray_files):
            fail('npm-layout', path=relative)
        for child in sorted(children):
            basename = PurePosixPath(child).name
            if basename == '.bin':
                continue
            if basename.startswith('@'):
                scoped = {path for path in directories if path.startswith(child + '/') and '/' not in path[len(child) + 1:]}
                if not scoped or any(path.startswith(child + '/') and '/' not in path[len(child) + 1:] for path in files):
                    fail('npm-scope', path=child)
                roots.update(scoped)
            else:
                roots.add(child)
    metadata = {}
    for root in sorted(roots):
        json_path = root + '/package.json' if root else 'package.json'
        if json_path not in files:
            fail('npm-package-json', path=json_path)
        package, _ = read_json(files[json_path])
        name, version = package.get('name'), package.get('version')
        if not isinstance(name, str) or not NPM_NAME.fullmatch(name):
            fail('npm-name', path=json_path)
        if not isinstance(version, str) or not VERSION.fullmatch(version):
            fail('npm-version', path=json_path)
        if not root and name != 'npm':
            fail('npm-root-name')
        spdx = npm_spdx(package)
        references = set()
        declarations = [package.get('license'), *package.get('licenses', [])]
        for declaration in declarations:
            if isinstance(declaration, dict):
                declaration = declaration.get('type')
            if isinstance(declaration, str) and declaration.startswith('SEE LICENSE IN '):
                reference = relative_path(declaration.removeprefix('SEE LICENSE IN '), 'license')
                referenced_path = root + '/' + reference if root else reference
                if referenced_path not in files or 'node_modules' in PurePosixPath(reference).parts:
                    fail('npm-license-reference', path=referenced_path)
                references.add(reference)
        metadata[root] = (name, version, spdx, references)
    owned_licenses = {root: [] for root in roots}
    longest_roots = sorted(roots, key=lambda value: (-len(value), value))
    for relative, path in files.items():
        owner = next(root for root in longest_roots if not root or relative.startswith(root + '/'))
        local = relative[len(owner) + 1:] if owner else relative
        if 'node_modules' not in PurePosixPath(local).parts and (is_license_path(local) or local in metadata[owner][3]):
            owned_licenses[owner].append(license_input(path, local))
    result = []
    for root, (name, version, spdx, _) in sorted(metadata.items()):
        source_url = 'https://registry.npmjs.org/' + quote(name, safe='@/') + '/-/' + name.split('/')[-1] + '-' + version + '.tgz'
        identifier = 'npm/' + root if root else 'npm'
        result.append(component(identifier, 'npm', name, version, spdx, source_url, owned_licenses[root]))
    return result


def android_components(android_libraries):
    path = safe_path(android_libraries)
    document, _ = read_json(path)
    if type(document.get('schema')) is not int or document['schema'] != 1 or not isinstance(document.get('libraries'), list):
        fail('android-schema')
    result = []
    for library in document['libraries']:
        if not isinstance(library, dict):
            fail('android-library')
        for field in ('name', 'version', 'spdx', 'sourceUrl', 'licenses'):
            if field not in library:
                fail('metadata-missing', field=field)
        name = text(library['name'], 'name')
        if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._:+-]*', name):
            fail('android-name')
        if not isinstance(library['licenses'], list) or not library['licenses']:
            fail('licenses-missing', component='android/' + name)
        licenses = []
        for relative in library['licenses']:
            relative_path(relative, 'licenses')
            licenses.append(license_input(path.parent / relative, relative))
        result.append(component('android/' + name, 'android', name, library['version'], library['spdx'], library['sourceUrl'], licenses))
    return result


def validate_components(components):
    identifiers = set()
    identities = {}
    for item in components:
        if item['id'] in identifiers:
            fail('component-duplicate', component=item['id'])
        identifiers.add(item['id'])
        identity = (item['section'], item['name'], item['version'])
        metadata = (item['spdx'], item['sourceUrl'], tuple((license['path'], license['sha256']) for license in item['licenses']))
        if identity in identities and identities[identity] != metadata:
            fail('metadata-conflict', component=item['id'])
        identities[identity] = metadata


def render(components, sections, runtime_sha256, sources_sha256):
    validate_components(components)
    output = bytearray(b'THIRD_PARTY_NOTICES\n\n')
    records = []
    for section in SECTIONS:
        output.extend(('## ' + section + '\n\n').encode('utf-8'))
        for item in sorted((item for item in components if item['section'] == section), key=lambda value: value['id']):
            start = len(output)
            header = '### ' + item['name'] + '\nversion: ' + item['version'] + '\n'
            if item['spdx'] is not None:
                header += 'SPDX: ' + item['spdx'] + '\n'
            header += 'sourceUrl: ' + item['sourceUrl'] + '\n\n'
            output.extend(header.encode('utf-8'))
            licenses = []
            for license in item['licenses']:
                output.extend(('#### ' + license['path'] + '\n\n').encode('utf-8'))
                licenses.append({key: license[key] for key in ('path', 'sha256', 'encoding')})
                licenses[-1].update({'offset': len(output), 'length': len(license['contents'])})
                output.extend(license['contents'])
                output.extend(b'\n\n')
            record = {key: item[key] for key in ('id', 'section', 'name', 'version', 'spdx', 'sourceUrl')}
            record.update({'offset': start, 'length': len(output) - start, 'licenses': licenses})
            records.append(record)
    contents = bytes(output)
    index = {'schema': 1, 'runtimeLockSha256': runtime_sha256, 'sourcesLockSha256': sources_sha256,
             'notices': {'file': NOTICES_NAME, 'sha256': sha256(contents), 'byteLength': len(contents)},
             'sections': sections, 'components': records}
    validate_output(contents, index)
    return contents, index


def generate(runtime_lock=ROOT.parent / 'runtime.lock', sources_lock=ROOT / 'sources.lock',
             licenses_root=ROOT / 'out' / 'licenses', node_source=None, npm_root=None,
             android_libraries=None, require_node=False, output_root=None):
    runtime, runtime_bytes = read_json(runtime_lock)
    sources, sources_bytes = read_json(sources_lock)
    runtime_sha256 = sha256(runtime_bytes)
    packages = validate_locks(runtime, sources, runtime_sha256)
    components = termux_components(packages, licenses_root)
    sections = {'termux': {'status': 'bundled', 'inputStatus': 'provided'}}
    optional_inputs = (('node', node_source, node_component), ('npm', npm_root, npm_components))
    for name, source, loader in optional_inputs:
        pin = runtime[name]
        if require_node and (not isinstance(pin, dict) or not pin):
            fail('runtime-unpinned', field=name)
        if (require_node or pin is not None) and source is None:
            fail('runtime-license-input', field=name)
        items = []
        if source is not None:
            loaded = loader(source)
            items = [loaded] if isinstance(loaded, dict) else loaded
            version = next(item['version'] for item in items if item['id'] == name)
            if pin is not None:
                if pin['version'].removeprefix('v') != version:
                    fail('runtime-version-mismatch', field=name)
            components.extend(items)
        sections[name] = {'status': 'not-bundled' if pin is None else 'bundled',
                          'inputStatus': 'not-supplied' if source is None else 'provided'}
    libraries = [] if android_libraries is None else android_components(android_libraries)
    if require_node and not libraries:
        fail('android-license-input')
    components.extend(libraries)
    sections['android'] = {'status': 'not-supplied' if android_libraries is None else 'bundled' if libraries else 'placeholder',
                           'inputStatus': 'not-supplied' if android_libraries is None else 'provided'}
    for section in SECTIONS:
        sections[section]['components'] = sorted(item['id'] for item in components if item['section'] == section)
    if output_root is not None:
        output = safe_path(output_root)
        inputs = [runtime_lock, sources_lock, licenses_root]
        inputs += [path for path in (node_source, npm_root, android_libraries) if path is not None]
        inputs += [license['inputPath'] for item in components for license in item['licenses']]
        for value in inputs:
            path = safe_path(value)
            if path == output or output in path.parents or path in output.parents:
                fail('output-input-overlap', path=str(path))
    return render(components, sections, runtime_sha256, sha256(sources_bytes))


def validate_output(contents, index):
    if type(index.get('schema')) is not int or index['schema'] != 1:
        fail('index-schema')
    for field in ('runtimeLockSha256', 'sourcesLockSha256'):
        if not isinstance(index.get(field), str) or not SHA256.fullmatch(index[field]):
            fail('index-sha256', field=field)
    notices = index.get('notices')
    if (not isinstance(notices, dict) or notices.get('file') != NOTICES_NAME
            or type(notices.get('byteLength')) is not int or notices['byteLength'] != len(contents)
            or notices.get('sha256') != sha256(contents)):
        fail('notices-sha256')
    components = index.get('components')
    sections = index.get('sections')
    if not isinstance(components, list) or not isinstance(sections, dict) or set(sections) != set(SECTIONS):
        fail('index-components')
    identifiers = set()
    ordered = []
    previous_end = 0
    for item in components:
        if not isinstance(item, dict) or item.get('section') not in SECTIONS:
            fail('index-component')
        for field in ('id', 'name', 'version'):
            text(item.get(field), field)
        spdx_expression(item.get('spdx'), 'spdx')
        https_url(item.get('sourceUrl'), 'sourceUrl')
        if item['id'] in identifiers:
            fail('component-duplicate', component=item['id'])
        identifiers.add(item['id'])
        ordered.append((item['section'], item['id']))
        start, length = item.get('offset'), item.get('length')
        if (type(start) is not int or type(length) is not int or start < previous_end
                or length <= 0 or start + length > len(contents)):
            fail('index-component-range', component=item['id'])
        previous_end = start + length
        licenses = item.get('licenses')
        if not isinstance(licenses, list) or not licenses:
            fail('licenses-missing', component=item['id'])
        paths = []
        license_end = start
        for license in licenses:
            if not isinstance(license, dict):
                fail('index-license')
            paths.append(relative_path(license.get('path'), 'license.path'))
            offset, size = license.get('offset'), license.get('length')
            if (type(offset) is not int or type(size) is not int or offset < license_end
                    or size <= 0 or offset + size > start + length):
                fail('index-license-range', component=item['id'])
            license_end = offset + size
            payload = contents[offset:license_end]
            if license.get('sha256') != sha256(payload):
                fail('license-sha256', component=item['id'], path=license['path'])
            encoding = license.get('encoding')
            if encoding not in ('utf-8', 'iso-8859-1'):
                fail('index-license-encoding')
            try:
                payload.decode(encoding)
            except UnicodeDecodeError:
                fail('index-license-encoding')
        if paths != sorted(set(paths)):
            fail('license-duplicate', component=item['id'])
    if ordered != sorted(ordered):
        fail('index-component-order')
    for name in SECTIONS:
        section = sections[name]
        expected = sorted(item['id'] for item in components if item['section'] == name)
        if (not isinstance(section, dict) or section.get('components') != expected
                or section.get('status') not in ('bundled', 'not-bundled', 'not-supplied', 'placeholder')
                or section.get('inputStatus') not in ('provided', 'not-supplied')):
            fail('index-section', section=name)


def write_bytes(path, contents, mode=0o644):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open('xb') as stream:
        stream.write(contents)
        stream.flush()
        os.fsync(stream.fileno())
    path.chmod(mode)


def publish(contents, index, output_root=ROOT / 'out' / 'assets'):
    import fcntl

    validate_output(contents, index)
    output = safe_path(output_root)
    output.parent.mkdir(parents=True, exist_ok=True)
    directory(output.parent)
    guard_path = safe_path(output.parent / '.notices.lock')
    descriptor = os.open(guard_path, os.O_CREAT | os.O_RDWR | getattr(os, 'O_NOFOLLOW', 0)
                         | getattr(os, 'O_NONBLOCK', 0), 0o600)
    with os.fdopen(descriptor, 'a') as guard:
        if not stat.S_ISREG(os.fstat(guard.fileno()).st_mode):
            fail('regular-file', path=str(guard_path))
        fcntl.flock(guard, fcntl.LOCK_EX)
        existing = {}
        directories = {''}
        mode = 0o755
        if output.exists():
            _, existing, directories = scan_tree(output)
            mode = stat.S_IMODE(output.stat().st_mode)
        work = Path(tempfile.mkdtemp(prefix='notices-', dir=output.parent))
        preserve_work = False
        try:
            staged = work / 'assets'
            staged.mkdir(mode=0o755)
            # The output also owns runtime assets; preserve them without following links.
            for relative in sorted(directories - {''}):
                (staged / relative).mkdir(parents=True, exist_ok=True)
            for relative, source in existing.items():
                if relative not in (NOTICES_NAME, INDEX_NAME):
                    write_bytes(staged / relative, read_bytes(source), stat.S_IMODE(source.stat().st_mode))
            write_bytes(staged / NOTICES_NAME, contents)
            index_bytes = (json.dumps(index, indent=4, sort_keys=True, ensure_ascii=True, allow_nan=False) + '\n').encode('utf-8')
            write_bytes(staged / INDEX_NAME, index_bytes)
            staged_contents = read_bytes(staged / NOTICES_NAME)
            staged_index, staged_index_bytes = read_json(staged / INDEX_NAME)
            validate_output(staged_contents, staged_index)
            if staged_contents != contents or staged_index_bytes != index_bytes:
                fail('publication-validation')
            for relative in sorted(directories - {''}, reverse=True):
                (staged / relative).chmod(stat.S_IMODE((output / relative).stat().st_mode))
            staged.chmod(mode)
            previous = work / 'previous'
            safe_path(output)
            try:
                if output.exists():
                    output.rename(previous)
                # One directory rename publishes the validated pair, never mixed files.
                staged.rename(output)
            except BaseException:
                if previous.exists():
                    try:
                        if output.exists():
                            fail('publication-target-conflict')
                        previous.rename(output)
                    except BaseException:
                        preserve_work = True
                        fail('publication-rollback', path=str(previous))
                raise
        finally:
            if not preserve_work:
                shutil.rmtree(work)
    return index


def build(runtime_lock=ROOT.parent / 'runtime.lock', sources_lock=ROOT / 'sources.lock',
          licenses_root=ROOT / 'out' / 'licenses', node_source=None, npm_root=None,
          android_libraries=None, require_node=False, output_root=ROOT / 'out' / 'assets'):
    contents, index = generate(runtime_lock, sources_lock, licenses_root, node_source, npm_root,
                               android_libraries, require_node, output_root)
    return publish(contents, index, output_root)


class PlaceholderParser(argparse.ArgumentParser):
    def format_help(self):
        return PLACEHOLDER + '\n'

    def format_usage(self):
        return PLACEHOLDER + '\n'

    def error(self, message):
        self.exit(2, json.dumps({'message': PLACEHOLDER, 'code': 'cli-arguments'}, sort_keys=True) + '\n')


def main(arguments=None):
    parser = PlaceholderParser(description=PLACEHOLDER, usage=PLACEHOLDER)
    parser.add_argument('--runtime-lock', type=Path, default=ROOT.parent / 'runtime.lock', help=PLACEHOLDER)
    parser.add_argument('--sources-lock', type=Path, default=ROOT / 'sources.lock', help=PLACEHOLDER)
    parser.add_argument('--licenses-root', type=Path, default=ROOT / 'out' / 'licenses', help=PLACEHOLDER)
    parser.add_argument('--output-root', type=Path, default=ROOT / 'out' / 'assets', help=PLACEHOLDER)
    parser.add_argument('--node-source', type=Path, help=PLACEHOLDER)
    parser.add_argument('--npm-root', type=Path, help=PLACEHOLDER)
    parser.add_argument('--android-libraries', type=Path, help=PLACEHOLDER)
    parser.add_argument('--require-node', action='store_true', help=PLACEHOLDER)
    args = parser.parse_args(arguments)
    build(**vars(args))


if __name__ == '__main__':
    try:
        main()
    except NoticesError as error:
        print(json.dumps({'message': PLACEHOLDER, 'code': error.code, 'details': error.details}, sort_keys=True), file=sys.stderr)
        sys.exit(1)
    except OSError as error:
        print(json.dumps({'message': PLACEHOLDER, 'code': 'filesystem', 'errno': error.errno, 'path': error.filename}, sort_keys=True), file=sys.stderr)
        sys.exit(1)
