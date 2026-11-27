/* eslint-disable playwright/no-standalone-expect -- Jest test.each tables are not Playwright tests. */
import { describe, expect, test } from '@jest/globals';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { posix } from 'node:path';

const REPOSITORY = 'https://github.com/termux/termux-packages';
const RAW = 'https://raw.githubusercontent.com/termux/termux-packages';
const HASH = /^[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const PACKAGE = /^[a-z0-9][a-z0-9+.-]*$/;
const NODE_VERSION = /^[0-9]+\.[0-9]+\.[0-9]+$/;
const NODE_KEYRING = {
    url: 'https://raw.githubusercontent.com/nodejs/release-keys/481637f813e912c4aa3622d7964ab426c97b8e8d/gpg-only-active-keys/pubring.kbx',
    sha256: '140f2ad5260fd62773b6243ce8e1d3009645d558f121b8262c55e383dc285932',
    filename: 'node-release-keys.kbx',
};
const FOOT_SOURCE_SHA256 = '2213a78b773c1f87bc503fcc2914d1f3474e9aaa2cb7fc92ec5dba4867ab71e0';
const FOOT_RECOVERY = {
    url: 'https://codeberg.org/api/v1/repos/dnkl/foot/archive/fd187167ccfef3f4538976c353f5798c247cd0d8.tar.gz?rev=fd187167ccfef3f4538976c353f5798c247cd0d8',
    sha256: '9d6a6222062111d0b8d7156cfbe4dc0bd74fcb9e8a387b0c81b99cc5087c526d',
    format: 'gzip',
    level: 6,
    mtime: 0,
};

function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function matches(value, pattern) {
    return typeof value === 'string' && pattern.exec(value)?.[0] === value;
}

// Python's sorted() orders str by code point, which is the order of the UTF-8 bytes.
function byCodePoint(left, right) {
    return Buffer.compare(Buffer.from(left), Buffer.from(right));
}

function sha256(contents) {
    return createHash('sha256').update(contents).digest('hex');
}

function validateHttpsUrl(value) {
    assert.ok(typeof value === 'string' && /^https:\/\/[^/?#]/i.test(value) && !/[\x00-\x20\x7f\\]/.test(value), 'invalid-https-url');
    let url;
    try {
        url = new URL(value);
    } catch {
        assert.fail('invalid-https-url');
    }
    assert.ok(url.protocol === 'https:' && url.hostname && !url.username && !url.password && !url.hash, 'invalid-https-url');
}

function validatePath(value) {
    assert.ok(typeof value === 'string' && value.length > 0 && !/[\x00-\x1f\x7f\\:]/.test(value), 'unsafe-path');
    assert.ok(!value.startsWith('/') && value.split('/').every(part => part !== '' && part !== '.' && part !== '..'), 'unsafe-path');
    return value;
}

function rawUrl(commit, path) {
    const encoded = path.split('/').map(part => encodeURIComponent(part)
        .replace(/[!'()*]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`)
        .replace(/%2B/g, '+')).join('/');
    return `${RAW}/${commit}/${encoded}`;
}

function validatePin(pin) {
    assert.ok(isObject(pin) && matches(pin.sha256, HASH), 'invalid-pin');
    validateHttpsUrl(pin.url);
}

function validateFiles(files, commit, prefix) {
    assert.ok(Array.isArray(files) && files.length > 0, 'missing-files');
    const names = new Set();
    for (const file of files) {
        validatePin(file);
        const path = validatePath(file.path);
        assert.ok(!names.has(path) && (!prefix || path.startsWith(`${prefix}/`)), 'duplicate-or-outside-file');
        names.add(path);
        assert.equal(file.url, rawUrl(commit, path), 'file-origin-mismatch');
        const type = file.type === undefined ? 'file' : file.type;
        assert.ok(['file', 'symlink'].includes(type) && Number.isInteger(file.mode), 'invalid-file-type');
        if (type === 'symlink') {
            const target = file.target;
            assert.ok(typeof target === 'string' && target.length > 0 && !target.startsWith('/') && !/[\x00-\x1f\\:]/.test(target), 'unsafe-link');
            validatePath(posix.join(posix.dirname(path), target).replace(/\/$/, ''));
            assert.ok(file.mode === 0o777 && file.sha256 === sha256(target), 'invalid-symlink');
        } else {
            assert.ok([0o644, 0o755].includes(file.mode), 'invalid-file-mode');
        }
    }
    assert.deepEqual(files.map(file => file.path), [...names].sort(byCodePoint), 'unsorted-files');
    return names;
}

function selectedPath(path, selectors) {
    return selectors.some(selector => path === selector || path.startsWith(`${selector}/`));
}

function validateSnapshot(system) {
    assert.ok(isObject(system), 'snapshot-schema');
    assert.deepEqual(Object.keys(system).sort(), ['commit', 'fileCount', 'selection', 'sha256', 'totalBytes'], 'snapshot-schema');
    assert.ok(matches(system.commit, COMMIT) && matches(system.sha256, HASH), 'snapshot-integrity');
    assert.ok(Number.isInteger(system.fileCount) && system.fileCount > 0, 'snapshot-file-count');
    assert.ok(Number.isInteger(system.totalBytes) && system.totalBytes >= 0, 'snapshot-total-bytes');
    assert.ok(Array.isArray(system.selection) && system.selection.length > 0, 'snapshot-selection');
    const paths = new Set();
    const reasons = new Set();
    for (const rule of system.selection) {
        assert.ok(isObject(rule) && matches(rule.reason, /^[a-z0-9][a-z0-9-]*$/), 'snapshot-selection');
        assert.deepEqual(Object.keys(rule).sort(), ['paths', 'reason'], 'snapshot-selection');
        assert.ok(Array.isArray(rule.paths) && rule.paths.length > 0, 'snapshot-selection-paths');
        const selected = rule.paths.map(path => validatePath(path));
        assert.ok(selected.every(path => !['*', '?', '[', ']'].some(character => path.includes(character)) && !paths.has(path)), 'snapshot-selection-paths');
        assert.deepEqual(selected, [...new Set(selected)].sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right))), 'snapshot-selection-paths');
        for (const path of selected) {
            paths.add(path);
        }
        assert.ok(!reasons.has(rule.reason), 'snapshot-selection-order');
        reasons.add(rule.reason);
    }
    assert.deepEqual(system.selection.map(rule => rule.reason), [...reasons].sort(), 'snapshot-selection-order');
    assert.ok(['build-package.sh', 'repo.json', 'scripts'].every(path => paths.has(path)) && selectedPath('scripts/properties.sh', [...paths]), 'incomplete-build-system');
    return [...paths];
}

function evidenceUrl(commit, path, lines) {
    return `${rawUrl(commit, path).replace(RAW, `${REPOSITORY}/blob`)}#L${Math.min(...lines)}`;
}

function validateSourceEvidence(lock, required = false) {
    const files = new Map();
    for (const pkg of lock.termux.packages) {
        for (const file of pkg.files) {
            const key = `${pkg.commit}/${file.path}`;
            if (files.has(key)) {
                assert.deepEqual(file, files.get(key), 'conflicting-recipe-file');
            }
            files.set(key, file);
        }
    }
    for (const pkg of lock.termux.packages) {
        for (const source of pkg.sources) {
            if (required) {
                assert.ok(['upstream-source', 'upstream-patch', 'build-tool-binary'].includes(source.kind), 'source-kind');
                assert.ok(Object.hasOwn(source, 'evidence'), 'source-evidence');
            }
            if (!Object.hasOwn(source, 'evidence')) {
                continue;
            }
            const evidence = source.evidence;
            assert.ok(isObject(evidence) && evidence.commit === pkg.commit, 'source-evidence');
            const path = validatePath(evidence.path);
            assert.ok(matches(evidence.fileSha256, HASH), 'source-evidence');
            const file = files.get(`${pkg.commit}/${path}`);
            if (file) {
                assert.equal(evidence.fileSha256, file.sha256, 'source-evidence');
            } else {
                // Helper recipes are authenticated by the expanded snapshot during the build.
                assert.ok(!path.startsWith(`${pkg.recipePath}/`), 'source-evidence');
                const system = lock.termux.buildSystems.find(system => system.commit === pkg.commit);
                assert.ok(selectedPath(path, validateSnapshot(system)), 'source-evidence');
            }
            assert.ok(Array.isArray(evidence.lines) && evidence.lines.length > 0 && evidence.lines.every(line => Number.isInteger(line) && line > 0), 'source-evidence-lines');
            assert.equal(evidence.url, evidenceUrl(pkg.commit, path, evidence.lines), 'source-evidence-url');
        }
    }
}

function validateSourcesLock(lock, runtimeBytes) {
    const runtime = JSON.parse(runtimeBytes.toString('utf8'));
    assert.ok(isObject(runtime) && runtime.schema === 1, 'runtime-schema');
    assert.ok(isObject(runtime.termux) && Array.isArray(runtime.termux.packages) && runtime.termux.packages.length > 0, 'runtime-packages');
    const packages = new Map();
    for (const pkg of runtime.termux.packages) {
        assert.ok(isObject(pkg) && matches(pkg.name, PACKAGE), 'runtime-package-name');
        assert.ok(!packages.has(pkg.name) && typeof pkg.version === 'string' && pkg.version.trim() !== '', 'runtime-package-version');
        packages.set(pkg.name, pkg.version);
    }
    for (const key of ['node', 'npm', 'bun']) {
        assert.ok(runtime[key] === null || isObject(runtime[key]), 'runtime-section');
    }
    assert.equal(runtime.bun, null, 'unsupported-runtime');
    assert.ok(isObject(lock) && lock.schema === 1, 'sources-schema');
    assert.equal(lock.runtimeLockSha256, sha256(runtimeBytes), 'runtime-lock-sha256');
    const termux = lock.termux;
    assert.ok(isObject(termux) && termux.repository === REPOSITORY && matches(termux.historyTip, COMMIT), 'sources-repository');
    validateHttpsUrl(termux.repository);
    assert.ok(Array.isArray(termux.packages) && termux.packages.length === packages.size, 'package-set-mismatch');
    const names = new Set();
    const commits = new Set();
    for (const pkg of termux.packages) {
        assert.ok(isObject(pkg) && packages.has(pkg.name) && !names.has(pkg.name), 'package-set-mismatch');
        names.add(pkg.name);
        assert.equal(pkg.version, packages.get(pkg.name), 'package-version-mismatch');
        assert.ok(matches(pkg.commit, COMMIT), 'invalid-commit');
        commits.add(pkg.commit);
        const recipe = validatePath(pkg.recipePath);
        assert.ok(recipe.startsWith('packages/') && recipe.split('/').length === 2, 'invalid-recipe-path');
        const paths = validateFiles(pkg.files, pkg.commit, recipe);
        assert.ok(paths.has(`${recipe}/build.sh`), 'missing-recipe');
        const evidence = pkg.evidence;
        assert.ok(isObject(evidence) && evidence.selected === pkg.commit && evidence.last === pkg.commit, 'missing-range-evidence');
        for (const key of ['first', 'last', 'historyTip']) {
            assert.ok(matches(evidence[key], COMMIT), 'invalid-range-evidence');
        }
        assert.ok(evidence.historyTip === termux.historyTip && evidence.method === 'first-parent-package-history', 'invalid-range-evidence');
        for (const key of ['before', 'after']) {
            assert.ok(evidence[key] == null || matches(evidence[key], COMMIT), 'invalid-range-evidence');
        }
        assert.ok(Array.isArray(pkg.sources), 'missing-upstream-sources');
        assert.ok(['upstream-tarballs', 'in-recipe-directory'].includes(pkg.sourceStatus), 'invalid-source-status');
        const filenames = new Set();
        for (const source of pkg.sources) {
            validatePin(source);
            if (source.recovery !== undefined) {
                assert.equal(source.sha256, FOOT_SOURCE_SHA256, 'unsupported-source-recovery');
                assert.deepEqual(source.recovery, FOOT_RECOVERY, 'unsupported-source-recovery');
            }
            const filename = validatePath(source.filename);
            assert.ok(!filename.includes('/') && !filenames.has(filename), 'duplicate-source-filename');
            filenames.add(filename);
        }
        assert.ok(pkg.sources.length > 0 || pkg.sourceStatus === 'in-recipe-directory', 'missing-upstream-sources');
    }
    assert.deepEqual(termux.packages.map(pkg => pkg.name), [...names].sort(), 'unsorted-packages');
    const systems = termux.buildSystems;
    assert.ok(Array.isArray(systems) && systems.length === commits.size, 'build-system-set-mismatch');
    const seen = new Set();
    for (const system of systems) {
        assert.ok(isObject(system) && commits.has(system.commit) && !seen.has(system.commit), 'build-system-set-mismatch');
        seen.add(system.commit);
        validateSnapshot(system);
    }
    assert.deepEqual(systems.map(system => system.commit), [...seen].sort(), 'unsorted-build-systems');
    validateSourceEvidence(lock);
    for (const key of ['node', 'npm']) {
        assert.ok(Object.hasOwn(lock, key), 'missing-runtime-section');
        const section = lock[key];
        assert.ok(section === null || isObject(section), 'runtime-section-mismatch');
        if (runtime[key] === null) {
            assert.equal(section, null, 'runtime-section-mismatch');
        } else {
            assert.ok(isObject(section) && typeof runtime[key].version === 'string' && typeof section.version === 'string' && section.version.trim() !== '', 'runtime-section-mismatch');
            assert.equal(section.version, runtime[key].version.replace(/^v/, ''), 'runtime-section-mismatch');
        }
    }
    if (lock.node !== null) {
        const node = lock.node;
        assert.ok(matches(node.version, NODE_VERSION), 'node-version');
        const base = `https://nodejs.org/dist/v${node.version}/`;
        const expected = {
            source: `node-v${node.version}.tar.xz`,
            shasums: 'SHASUMS256.txt',
            signature: 'SHASUMS256.txt.sig',
        };
        for (const [key, filename] of Object.entries(expected)) {
            validatePin(node[key]);
            assert.ok(node[key].filename === filename && node[key].url === base + filename, 'node-official-origin');
        }
        assert.deepEqual(node.keyring, NODE_KEYRING, 'node-keyring-pin');
        assert.ok(Array.isArray(node.patches), 'node-patch-list');
        const patches = new Set();
        for (const patch of node.patches) {
            assert.ok(isObject(patch), 'node-patch-pin');
            const path = validatePath(patch.path);
            assert.ok(!patches.has(path) && path.startsWith('android/runtime/patches/node/') && matches(patch.sha256, HASH), 'node-patch-pin');
            patches.add(path);
        }
        assert.deepEqual(node.patches.map(patch => patch.path), [...patches].sort(byCodePoint), 'unsorted-node-patches');
    }
    assert.ok(lock.npm === null || (lock.node !== null && lock.npm.source === 'node'), 'npm-source-mismatch');
}

function filePin(commit, path, metadata = {}) {
    return {
        path,
        url: rawUrl(commit, path),
        sha256: sha256(metadata.target ?? path),
        mode: 0o644,
        type: 'file',
        ...metadata,
    };
}

function snapshotFile(path, contents = path, mode = 0o644) {
    const bytes = Buffer.from(contents);
    return {
        path,
        mode,
        gitBlob: createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex'),
        sha256: sha256(bytes),
        size: bytes.length,
    };
}

function snapshotListing(files) {
    // Match sources.py: UTF-8 path order, ensure_ascii compact JSON arrays, one LF per row.
    const rows = [...files].sort((left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path))).map(file => {
        const row = JSON.stringify([file.path, file.mode, file.gitBlob, file.sha256, file.size]);
        return `${row.replace(/[\u007f-\uffff]/g, character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`)}\n`;
    });
    return Buffer.from(rows.join(''), 'ascii');
}

function snapshotSummary(files) {
    return {
        sha256: sha256(snapshotListing(files)),
        fileCount: files.length,
        totalBytes: files.reduce((total, file) => total + file.size, 0),
    };
}

function buildSystemFixture(commit) {
    const files = ['build-package.sh', 'repo.json', 'scripts/properties.sh'].map(path => snapshotFile(path));
    return {
        commit,
        selection: [{ reason: 'build-framework', paths: ['build-package.sh', 'repo.json', 'scripts'] }],
        ...snapshotSummary(files),
    };
}

function createFixture() {
    const historyTip = '3'.repeat(40);
    const runtime = {
        schema: 1,
        termux: {
            packages: [
                { name: 'alpha', version: '1:2.3.4-5' },
                { name: 'beta', version: '6.7.8+fixture-2' },
            ],
        },
        node: null,
        npm: null,
        bun: null,
    };
    const packages = runtime.termux.packages.map((pkg, index) => {
        const commit = String(index + 1).repeat(40);
        const recipePath = `packages/${index === 0 ? 'shared-recipe' : pkg.name}`;
        return {
            ...pkg,
            commit,
            recipePath,
            evidence: {
                method: 'first-parent-package-history',
                first: commit,
                last: commit,
                selected: commit,
                historyTip,
                before: null,
                after: historyTip,
            },
            files: ['build.sh', 'fix.patch'].map(name => filePin(commit, `${recipePath}/${name}`)),
            sourceStatus: 'upstream-tarballs',
            sources: [{
                filename: `${pkg.name}.tar.xz`,
                url: `https://example.invalid/${pkg.name}.tar.xz`,
                sha256: sha256(`${pkg.name} upstream`),
                kind: 'upstream-source',
                evidence: {
                    commit,
                    path: `${recipePath}/build.sh`,
                    fileSha256: sha256(`${recipePath}/build.sh`),
                    lines: [7],
                    url: evidenceUrl(commit, `${recipePath}/build.sh`, [7]),
                },
            }],
        };
    });
    return {
        runtime,
        lock: {
            schema: 1,
            runtimeLockSha256: sha256(JSON.stringify(runtime)),
            termux: {
                repository: REPOSITORY,
                historyTip,
                packages,
                buildSystems: packages.map(pkg => buildSystemFixture(pkg.commit)),
            },
            node: null,
            npm: null,
        },
    };
}

function addHelperEvidence(fixture, path = 'x11-packages/helper/build.sh') {
    const pkg = fixture.lock.termux.packages[0];
    const system = fixture.lock.termux.buildSystems.find(system => system.commit === pkg.commit);
    const file = snapshotFile(path);
    system.selection.push({ reason: 'recipe-value-imports', paths: [path] });
    Object.assign(system, snapshotSummary([
        ...['build-package.sh', 'repo.json', 'scripts/properties.sh'].map(path => snapshotFile(path)),
        file,
    ]));
    pkg.sources[0].evidence = {
        commit: pkg.commit,
        path,
        fileSha256: file.sha256,
        lines: [7],
        url: evidenceUrl(pkg.commit, path, [7]),
    };
}

function addNodeFixture(fixture) {
    fixture.runtime.node = { version: 'v1.2.3' };
    fixture.runtime.npm = { version: '4.5.6' };
    fixture.lock.node = {
        version: '1.2.3',
        keyring: { ...NODE_KEYRING },
        patches: [{ path: 'android/runtime/patches/node/fix.patch', sha256: sha256('node patch') }],
    };
    for (const [key, filename] of Object.entries({
        source: 'node-v1.2.3.tar.xz',
        shasums: 'SHASUMS256.txt',
        signature: 'SHASUMS256.txt.sig',
    })) {
        fixture.lock.node[key] = { filename, url: `https://nodejs.org/dist/v1.2.3/${filename}`, sha256: sha256(filename) };
    }
    fixture.lock.npm = { version: '4.5.6', source: 'node' };
    fixture.lock.runtimeLockSha256 = sha256(JSON.stringify(fixture.runtime));
}

describe('Android sources lock', () => {
    test('validates the checked-in sources against the raw runtime lock', () => {
        const runtimeBytes = readFileSync(new URL('../android/runtime.lock', import.meta.url));
        const lock = JSON.parse(readFileSync(new URL('../android/runtime/sources.lock', import.meta.url), 'utf8'));
        expect(() => validateSourcesLock(lock, runtimeBytes)).not.toThrow();
    });

    test('records immutable recipe checksum evidence for every checked-in upstream input', () => {
        const lock = JSON.parse(readFileSync(new URL('../android/runtime/sources.lock', import.meta.url), 'utf8'));
        expect(() => validateSourceEvidence(lock, true)).not.toThrow();
    });

    test('keeps the checked-in sources lock below 200000 bytes', () => {
        const bytes = readFileSync(new URL('../android/runtime/sources.lock', import.meta.url));
        expect(bytes.length).toBeLessThan(200000);
    });

    test('accepts matching packages without assuming runtime order, versions or recipe directory names', () => {
        const fixture = createFixture();
        fixture.runtime.termux.packages.reverse();
        const bytes = Buffer.from(JSON.stringify(fixture.runtime));
        fixture.lock.runtimeLockSha256 = sha256(bytes);
        expect(() => validateSourcesLock(fixture.lock, bytes)).not.toThrow();
    });

    test('matches the canonical UTF-8 sorted snapshot digest and changes it for add, remove, or replace', () => {
        const files = [
            snapshotFile('zeta', 'z'),
            snapshotFile('a', 'a'),
            snapshotFile('é', 'accent'),
            snapshotFile('界', 'cjk', 0o755),
            snapshotFile('\ue000', 'bmp'),
            snapshotFile('\u{1f600}', 'a', 0o777),
        ];
        const summary = snapshotSummary(files);
        expect(summary).toEqual({
            sha256: '48569769548526a580660ecb1398a7425893fc9a73137d2876ae6574097e9b77',
            fileCount: 6,
            totalBytes: 15,
        });
        const listing = snapshotListing(files).toString('ascii');
        expect(listing.trimEnd().split('\n').map(line => JSON.parse(line)[0])).toEqual(['a', 'zeta', 'é', '界', '\ue000', '\u{1f600}']);
        expect(listing).toContain('"\\u00e9"');
        expect(listing).toContain('"\\ud83d\\ude00"');
        expect(snapshotListing([...files].reverse())).toEqual(snapshotListing(files));
        expect(snapshotSummary(files.map(file => file.path === 'a' ? snapshotFile('a', 'changed') : file)).sha256).not.toBe(summary.sha256);
        expect(snapshotSummary([...files, snapshotFile('added', 'new')]).sha256).not.toBe(summary.sha256);
        expect(snapshotSummary(files.slice(1)).sha256).not.toBe(summary.sha256);
    });

    test('binds the digest to raw bytes rather than reserialized JSON', () => {
        const fixture = createFixture();
        const bytes = Buffer.from(`${JSON.stringify(fixture.runtime, null, 4)}\n`);
        fixture.lock.runtimeLockSha256 = sha256(bytes);
        expect(() => validateSourcesLock(fixture.lock, bytes)).not.toThrow();
        expect(() => validateSourcesLock(fixture.lock, Buffer.from(JSON.stringify(fixture.runtime)))).toThrow('runtime-lock-sha256');
    });

    test('shares a build-system entry when multiple packages use the same commit', () => {
        const fixture = createFixture();
        const [first, second] = fixture.lock.termux.packages;
        second.commit = first.commit;
        second.evidence.first = first.commit;
        second.evidence.last = first.commit;
        second.evidence.selected = first.commit;
        second.files = second.files.map(file => ({ ...file, url: rawUrl(first.commit, file.path) }));
        for (const source of second.sources) {
            source.evidence.commit = first.commit;
            source.evidence.url = evidenceUrl(first.commit, source.evidence.path, source.evidence.lines);
        }
        fixture.lock.termux.buildSystems.pop();
        expect(() => validateSourcesLock(fixture.lock, Buffer.from(JSON.stringify(fixture.runtime)))).not.toThrow();
    });

    test('allows no upstream tarballs only when the sources live in the recipe directory', () => {
        const fixture = createFixture();
        fixture.lock.termux.packages[0].sources = [];
        fixture.lock.termux.packages[0].sourceStatus = 'in-recipe-directory';
        expect(() => validateSourcesLock(fixture.lock, Buffer.from(JSON.stringify(fixture.runtime)))).not.toThrow();
    });

    test('pins the changed gzip transport and retains the original recipe digest during recovery', () => {
        const fixture = createFixture();
        const pin = fixture.lock.termux.packages[0].sources[0];
        pin.sha256 = FOOT_SOURCE_SHA256;
        pin.recovery = { ...FOOT_RECOVERY };
        expect(() => validateSourcesLock(fixture.lock, Buffer.from(JSON.stringify(fixture.runtime)))).not.toThrow();
        pin.recovery.sha256 = '0'.repeat(64);
        expect(() => validateSourcesLock(fixture.lock, Buffer.from(JSON.stringify(fixture.runtime)))).toThrow('unsupported-source-recovery');
        pin.recovery = { ...FOOT_RECOVERY };
        pin.sha256 = '0'.repeat(64);
        expect(() => validateSourcesLock(fixture.lock, Buffer.from(JSON.stringify(fixture.runtime)))).toThrow('unsupported-source-recovery');
    });

    test('accepts safe relative symlinks and percent-encoded immutable file origins', () => {
        const fixture = createFixture();
        const pkg = fixture.lock.termux.packages[0];
        pkg.files.push(filePin(pkg.commit, `${pkg.recipePath}/link.patch`, { type: 'symlink', mode: 0o777, target: 'fix.patch' }));
        pkg.files.push(filePin(pkg.commit, `${pkg.recipePath}/z C++'s.patch`, { mode: 0o755 }));
        expect(() => validateSourcesLock(fixture.lock, Buffer.from(JSON.stringify(fixture.runtime)))).not.toThrow();
    });

    test('accepts compact snapshots with recursive union selectors and no committed file listing', () => {
        const fixture = createFixture();
        const system = fixture.lock.termux.buildSystems[0];
        system.selection.push({ reason: 'recipe-value-imports', paths: ['packages/helper'] });
        expect(() => validateSourcesLock(fixture.lock, Buffer.from(JSON.stringify(fixture.runtime)))).not.toThrow();
        expect(Object.hasOwn(system, 'files')).toBe(false);
        const selectors = validateSnapshot(system);
        expect(selectedPath('scripts/build/deep/helper.sh', selectors)).toBe(true);
        expect(selectedPath('packages/helper/deep/build.sh', selectors)).toBe(true);
        expect(selectedPath('scripts-other/properties.sh', validateSnapshot(system))).toBe(false);
    });

    test('accepts Unicode selectors in codepoint order used by Python sorted()', () => {
        const fixture = createFixture();
        fixture.lock.termux.buildSystems[0].selection.push({
            reason: 'recipe-value-imports',
            paths: ['\ue000', '\u{1f600}'],
        });
        expect(() => validateSourcesLock(fixture.lock, Buffer.from(JSON.stringify(fixture.runtime)))).not.toThrow();
    });

    test('accepts zero total bytes without assuming the current snapshot count or content size', () => {
        const fixture = createFixture();
        const system = fixture.lock.termux.buildSystems[0];
        Object.assign(system, snapshotSummary(['build-package.sh', 'repo.json', 'scripts/properties.sh'].map(path => snapshotFile(path, ''))));
        expect(() => validateSourcesLock(fixture.lock, Buffer.from(JSON.stringify(fixture.runtime)))).not.toThrow();
    });

    test('accepts helper-recipe evidence selected at the package commit without a per-file framework pin', () => {
        const fixture = createFixture();
        addHelperEvidence(fixture);
        const system = fixture.lock.termux.buildSystems[0];
        system.selection[1].paths = ['x11-packages/helper'];
        expect(() => validateSourcesLock(fixture.lock, Buffer.from(JSON.stringify(fixture.runtime)))).not.toThrow();
        expect(() => validateSourceEvidence(fixture.lock, true)).not.toThrow();
        expect(Object.hasOwn(system, 'files')).toBe(false);
    });

    test('accepts percent-encoded helper evidence URLs anchored to the earliest referenced line', () => {
        const fixture = createFixture();
        addHelperEvidence(fixture, 'x11-packages/helper/z C++\'s.sh');
        const evidence = fixture.lock.termux.packages[0].sources[0].evidence;
        evidence.lines = [12, 7];
        evidence.url = evidenceUrl(evidence.commit, evidence.path, evidence.lines);
        expect(() => validateSourcesLock(fixture.lock, Buffer.from(JSON.stringify(fixture.runtime)))).not.toThrow();
    });

    test.each([
        ['mutable branch name', system => system.commit = 'main'],
        ['short commit', system => system.commit = 'a'.repeat(39)],
        ['commit with a newline', system => system.commit += '\n'],
    ])('rejects malformed snapshot commits: %s', (label, mutate) => {
        const fixture = createFixture();
        const system = fixture.lock.termux.buildSystems[0];
        mutate(system);
        expect(() => validateSnapshot(system)).toThrow('snapshot-integrity');
    });

    test.each([
        ['missing digest', system => delete system.sha256, 'snapshot-schema'],
        ['malformed digest', system => system.sha256 = 'not-a-hash', 'snapshot-integrity'],
        ['uppercase digest', system => system.sha256 = 'A'.repeat(64), 'snapshot-integrity'],
        ['short digest', system => system.sha256 = 'a'.repeat(63), 'snapshot-integrity'],
        ['digest with a trailing newline', system => system.sha256 += '\n', 'snapshot-integrity'],
        ['nonstring digest', system => system.sha256 = 0, 'snapshot-integrity'],
        ['legacy per-file list', system => system.files = [filePin(system.commit, 'build-package.sh')], 'snapshot-schema'],
        ['empty per-file list', system => system.files = [], 'snapshot-schema'],
        ['legacy paths field', system => system.paths = ['scripts'], 'snapshot-schema'],
        ['missing file count', system => delete system.fileCount, 'snapshot-schema'],
        ['zero file count', system => system.fileCount = 0, 'snapshot-file-count'],
        ['negative file count', system => system.fileCount = -1, 'snapshot-file-count'],
        ['boolean file count', system => system.fileCount = true, 'snapshot-file-count'],
        ['fractional file count', system => system.fileCount = 1.5, 'snapshot-file-count'],
        ['string file count', system => system.fileCount = '3', 'snapshot-file-count'],
        ['null file count', system => system.fileCount = null, 'snapshot-file-count'],
        ['missing total bytes', system => delete system.totalBytes, 'snapshot-schema'],
        ['negative total bytes', system => system.totalBytes = -1, 'snapshot-total-bytes'],
        ['boolean total bytes', system => system.totalBytes = false, 'snapshot-total-bytes'],
        ['fractional total bytes', system => system.totalBytes = 0.5, 'snapshot-total-bytes'],
        ['string total bytes', system => system.totalBytes = '0', 'snapshot-total-bytes'],
        ['null total bytes', system => system.totalBytes = null, 'snapshot-total-bytes'],
        ['missing selection', system => delete system.selection, 'snapshot-schema'],
        ['null selection', system => system.selection = null, 'snapshot-selection'],
        ['empty selection', system => system.selection = [], 'snapshot-selection'],
        ['non-array selection', system => system.selection = {}, 'snapshot-selection'],
        ['non-object rule', system => system.selection[0] = null, 'snapshot-selection'],
        ['missing reason', system => delete system.selection[0].reason, 'snapshot-selection'],
        ['empty reason', system => system.selection[0].reason = '', 'snapshot-selection'],
        ['nonstring reason', system => system.selection[0].reason = 1, 'snapshot-selection'],
        ['uppercase reason', system => system.selection[0].reason = 'Build-framework', 'snapshot-selection'],
        ['underscored reason', system => system.selection[0].reason = 'build_framework', 'snapshot-selection'],
        ['reason starting with a hyphen', system => system.selection[0].reason = '-build-framework', 'snapshot-selection'],
        ['reason with a trailing newline', system => system.selection[0].reason += '\n', 'snapshot-selection'],
        ['extra rule field', system => system.selection[0].files = [], 'snapshot-selection'],
        ['missing rule paths', system => delete system.selection[0].paths, 'snapshot-selection'],
        ['non-array rule paths', system => system.selection[0].paths = 'scripts', 'snapshot-selection-paths'],
        ['empty rule paths', system => system.selection[0].paths = [], 'snapshot-selection-paths'],
        ['duplicate reason', system => system.selection.push({ reason: 'build-framework', paths: ['ndk-patches'] }), 'snapshot-selection-order'],
        ['unsorted reasons', system => system.selection.unshift({ reason: 'toolchain-version-reads', paths: ['packages/python/build.sh'] }), 'snapshot-selection-order'],
        ['duplicate selector in one rule', system => system.selection[0].paths.push('scripts'), 'snapshot-selection-paths'],
        ['duplicate selector across reasons', system => system.selection.push({ reason: 'recipe-value-imports', paths: ['scripts'] }), 'snapshot-selection-paths'],
        ['unsorted selectors', system => system.selection[0].paths.reverse(), 'snapshot-selection-paths'],
        ['missing build-package.sh', system => system.selection[0].paths.shift(), 'incomplete-build-system'],
        ['missing repo.json', system => system.selection[0].paths.splice(1, 1), 'incomplete-build-system'],
        ['missing scripts', system => system.selection[0].paths.pop(), 'incomplete-build-system'],
        ['properties.sh instead of recursive scripts', system => system.selection[0].paths[2] = 'scripts/properties.sh', 'incomplete-build-system'],
        ['similar scripts prefix', system => system.selection[0].paths[2] = 'scripts-other', 'incomplete-build-system'],
    ])('rejects invalid compact snapshots: %s', (label, mutate, code) => {
        const fixture = createFixture();
        mutate(fixture.lock.termux.buildSystems[0]);
        expect(() => validateSourcesLock(fixture.lock, Buffer.from(JSON.stringify(fixture.runtime)))).toThrow(code);
    });

    test.each([
        null, '', '.', '..', '../escape', '/absolute', 'C:/absolute', 'scripts/../escape',
        'scripts/./helper.sh', 'scripts//helper.sh', 'scripts/', 'scripts\\helper.sh', 'scripts/helper.sh\n',
    ])('rejects unsafe snapshot selectors: %s', path => {
        const fixture = createFixture();
        fixture.lock.termux.buildSystems[0].selection[0].paths[2] = path;
        expect(() => validateSourcesLock(fixture.lock, Buffer.from(JSON.stringify(fixture.runtime)))).toThrow('unsafe-path');
    });

    test.each(['scripts/*', 'scripts/**', 'scripts/?.sh', 'scripts/[ab].sh'])('rejects glob snapshot selectors: %s', path => {
        const fixture = createFixture();
        fixture.lock.termux.buildSystems[0].selection[0].paths[2] = path;
        expect(() => validateSourcesLock(fixture.lock, Buffer.from(JSON.stringify(fixture.runtime)))).toThrow('snapshot-selection-paths');
    });

    test.each([
        ['wrong evidence commit', fixture => fixture.lock.termux.packages[0].sources[0].evidence.commit = fixture.lock.termux.packages[1].commit, 'source-evidence'],
        ['unselected helper path', fixture => fixture.lock.termux.buildSystems[0].selection.pop(), 'source-evidence'],
        ['helper selected only at a different commit', fixture => {
            const rule = fixture.lock.termux.buildSystems[0].selection.pop();
            fixture.lock.termux.buildSystems[1].selection.push(rule);
        }, 'source-evidence'],
        ['helper path only shares the selector prefix', fixture => fixture.lock.termux.buildSystems[0].selection[1].paths = ['x11-packages/help'], 'source-evidence'],
        ['malformed helper hash', fixture => fixture.lock.termux.packages[0].sources[0].evidence.fileSha256 = 'invalid', 'source-evidence'],
        ['uppercase helper hash', fixture => fixture.lock.termux.packages[0].sources[0].evidence.fileSha256 = 'A'.repeat(64), 'source-evidence'],
        ['helper hash with a trailing newline', fixture => fixture.lock.termux.packages[0].sources[0].evidence.fileSha256 += '\n', 'source-evidence'],
        ['missing helper hash', fixture => delete fixture.lock.termux.packages[0].sources[0].evidence.fileSha256, 'source-evidence'],
        ['missing evidence lines', fixture => delete fixture.lock.termux.packages[0].sources[0].evidence.lines, 'source-evidence-lines'],
        ['empty evidence lines', fixture => fixture.lock.termux.packages[0].sources[0].evidence.lines = [], 'source-evidence-lines'],
        ['zero evidence line', fixture => fixture.lock.termux.packages[0].sources[0].evidence.lines = [0], 'source-evidence-lines'],
        ['boolean evidence line', fixture => fixture.lock.termux.packages[0].sources[0].evidence.lines = [true], 'source-evidence-lines'],
        ['fractional evidence line', fixture => fixture.lock.termux.packages[0].sources[0].evidence.lines = [1.5], 'source-evidence-lines'],
        ['string evidence line', fixture => fixture.lock.termux.packages[0].sources[0].evidence.lines = ['7'], 'source-evidence-lines'],
        ['mutable evidence URL', fixture => fixture.lock.termux.packages[0].sources[0].evidence.url = `${REPOSITORY}/blob/master/x11-packages/helper/build.sh#L7`, 'source-evidence-url'],
        ['wrong evidence URL line', fixture => fixture.lock.termux.packages[0].sources[0].evidence.url = fixture.lock.termux.packages[0].sources[0].evidence.url.replace('#L7', '#L8'), 'source-evidence-url'],
        ['unsafe helper path', fixture => fixture.lock.termux.packages[0].sources[0].evidence.path = '../helper/build.sh', 'unsafe-path'],
    ])('rejects invalid helper evidence: %s', (label, mutate, code) => {
        const fixture = createFixture();
        addHelperEvidence(fixture);
        mutate(fixture);
        expect(() => validateSourcesLock(fixture.lock, Buffer.from(JSON.stringify(fixture.runtime)))).toThrow(code);
    });

    test('compares own-recipe checksum evidence to the retained package file pin', () => {
        const fixture = createFixture();
        fixture.lock.termux.buildSystems[0].selection.push({ reason: 'recipe-value-imports', paths: [fixture.lock.termux.packages[0].recipePath] });
        fixture.lock.termux.packages[0].sources[0].evidence.fileSha256 = '0'.repeat(64);
        expect(() => validateSourcesLock(fixture.lock, Buffer.from(JSON.stringify(fixture.runtime)))).toThrow('source-evidence');
    });

    test('rejects own-recipe evidence when its per-file pin is absent', () => {
        const fixture = createFixture();
        const pkg = fixture.lock.termux.packages[0];
        pkg.sources[0].evidence.path = `${pkg.recipePath}/fix.patch`;
        pkg.sources[0].evidence.fileSha256 = pkg.files[1].sha256;
        pkg.sources[0].evidence.url = evidenceUrl(pkg.commit, pkg.sources[0].evidence.path, pkg.sources[0].evidence.lines);
        pkg.files.pop();
        expect(() => validateSourcesLock(fixture.lock, Buffer.from(JSON.stringify(fixture.runtime)))).toThrow('source-evidence');
    });

    test('requires checksum evidence when validating all upstream inputs', () => {
        const fixture = createFixture();
        delete fixture.lock.termux.packages[0].sources[0].evidence;
        expect(() => validateSourceEvidence(fixture.lock, true)).toThrow('source-evidence');
    });

    test.each([
        ['missing from sources', fixture => fixture.lock.termux.packages.pop(), 'package-set-mismatch'],
        ['missing from runtime', fixture => fixture.runtime.termux.packages.pop(), 'package-set-mismatch'],
        ['source version differs', fixture => fixture.lock.termux.packages[0].version += '-1', 'package-version-mismatch'],
        ['runtime version differs', fixture => fixture.runtime.termux.packages[0].version += '-1', 'package-version-mismatch'],
        ['same count but a different package', fixture => fixture.lock.termux.packages[1].name = 'gamma', 'package-set-mismatch'],
        ['duplicate source name', fixture => fixture.lock.termux.packages[1].name = 'alpha', 'package-set-mismatch'],
        ['duplicate runtime name', fixture => fixture.runtime.termux.packages[1].name = 'alpha', 'runtime-package-version'],
        ['unsorted source names', fixture => fixture.lock.termux.packages.reverse(), 'unsorted-packages'],
    ])('rejects package drift: %s', (label, mutate, code) => {
        const fixture = createFixture();
        mutate(fixture);
        const bytes = Buffer.from(JSON.stringify(fixture.runtime));
        fixture.lock.runtimeLockSha256 = sha256(bytes);
        expect(() => validateSourcesLock(fixture.lock, bytes)).toThrow(code);
    });

    test.each([
        ['wrong schema', lock => lock.schema = 2, 'sources-schema'],
        ['boolean schema', lock => lock.schema = true, 'sources-schema'],
        ['wrong runtime digest', lock => lock.runtimeLockSha256 = '0'.repeat(64), 'runtime-lock-sha256'],
        ['unofficial repository', lock => lock.termux.repository = 'https://github.com/example/termux-packages', 'sources-repository'],
        ['HTTP repository', lock => lock.termux.repository = REPOSITORY.replace('https:', 'http:'), 'sources-repository'],
        ['mutable history tip', lock => lock.termux.historyTip = 'master', 'sources-repository'],
        ['mutable package commit', lock => lock.termux.packages[0].commit = 'master', 'invalid-commit'],
        ['nested recipe path', lock => lock.termux.packages[0].recipePath += '/nested', 'invalid-recipe-path'],
        ['recipe without build.sh', lock => lock.termux.packages[0].files.shift(), 'missing-recipe'],
        ['missing evidence', lock => delete lock.termux.packages[0].evidence, 'missing-range-evidence'],
        ['wrong selected commit', lock => lock.termux.packages[0].evidence.selected = '4'.repeat(40), 'missing-range-evidence'],
        ['wrong range end', lock => lock.termux.packages[0].evidence.last = '4'.repeat(40), 'missing-range-evidence'],
        ['mutable range start', lock => lock.termux.packages[0].evidence.first = 'HEAD~1', 'invalid-range-evidence'],
        ['different evidence history tip', lock => lock.termux.packages[0].evidence.historyTip = '4'.repeat(40), 'invalid-range-evidence'],
        ['unsupported evidence method', lock => lock.termux.packages[0].evidence.method = 'version-only', 'invalid-range-evidence'],
        ['mutable preceding boundary', lock => lock.termux.packages[0].evidence.before = 'HEAD~2', 'invalid-range-evidence'],
        ['mutable following boundary', lock => lock.termux.packages[0].evidence.after = 'HEAD', 'invalid-range-evidence'],
        ['missing source array', lock => delete lock.termux.packages[0].sources, 'missing-upstream-sources'],
        ['missing source status', lock => delete lock.termux.packages[0].sourceStatus, 'invalid-source-status'],
        ['unsupported source status', lock => lock.termux.packages[0].sourceStatus = 'unknown', 'invalid-source-status'],
        ['unexplained empty sources', lock => lock.termux.packages[0].sources = [], 'missing-upstream-sources'],
        ['duplicate upstream filename', lock => lock.termux.packages[0].sources.push({ ...lock.termux.packages[0].sources[0] }), 'duplicate-source-filename'],
        ['nested upstream filename', lock => lock.termux.packages[0].sources[0].filename = 'nested/source.tar.xz', 'duplicate-source-filename'],
        ['malformed upstream digest', lock => lock.termux.packages[0].sources[0].sha256 = 'not-a-hash', 'invalid-pin'],
        ['digest with a trailing newline', lock => lock.termux.packages[0].sources[0].sha256 += '\n', 'invalid-pin'],
        ['HTTP upstream', lock => lock.termux.packages[0].sources[0].url = 'http://example.invalid/source.tar.xz', 'invalid-https-url'],
        ['malformed HTTPS upstream', lock => lock.termux.packages[0].sources[0].url = 'https:example.invalid/source.tar.xz', 'invalid-https-url'],
        ['credentialed upstream', lock => lock.termux.packages[0].sources[0].url = 'https://user:password@example.invalid/source.tar.xz', 'invalid-https-url'],
        ['fragmented upstream', lock => lock.termux.packages[0].sources[0].url += '#fragment', 'invalid-https-url'],
        ['malformed file digest', lock => lock.termux.packages[0].files[0].sha256 = 'x'.repeat(64), 'invalid-pin'],
        ['mutable file origin', lock => lock.termux.packages[0].files[0].url = `${RAW}/master/packages/shared-recipe/build.sh`, 'file-origin-mismatch'],
        ['wrong file origin commit', lock => lock.termux.packages[0].files[0].url = `${RAW}/${'4'.repeat(40)}/packages/shared-recipe/build.sh`, 'file-origin-mismatch'],
        ['outside recipe file', lock => lock.termux.packages[0].files[0] = filePin(lock.termux.packages[0].commit, 'packages/shared-recipe-other/build.sh'), 'duplicate-or-outside-file'],
        ['duplicate recipe file', lock => lock.termux.packages[0].files.push({ ...lock.termux.packages[0].files[0] }), 'duplicate-or-outside-file'],
        ['unsorted recipe files', lock => lock.termux.packages[0].files.reverse(), 'unsorted-files'],
        ['unsafe file mode', lock => lock.termux.packages[0].files[0].mode = 0o666, 'invalid-file-mode'],
        ['string file mode', lock => lock.termux.packages[0].files[0].mode = '0644', 'invalid-file-type'],
        ['unsupported file type', lock => lock.termux.packages[0].files[0].type = 'directory', 'invalid-file-type'],
        ['missing build system', lock => lock.termux.buildSystems.pop(), 'build-system-set-mismatch'],
        ['extra build system', lock => lock.termux.buildSystems.push({ ...lock.termux.buildSystems[0] }), 'build-system-set-mismatch'],
        ['duplicate build-system commit', lock => lock.termux.buildSystems[1].commit = lock.termux.buildSystems[0].commit, 'build-system-set-mismatch'],
        ['unreferenced build-system commit', lock => lock.termux.buildSystems[1].commit = '4'.repeat(40), 'build-system-set-mismatch'],
        ['unsorted build systems', lock => lock.termux.buildSystems.reverse(), 'unsorted-build-systems'],
        ['missing Node metadata', lock => delete lock.node, 'missing-runtime-section'],
        ['missing npm metadata', lock => delete lock.npm, 'missing-runtime-section'],
        ['unexpected Node metadata', lock => lock.node = {}, 'runtime-section-mismatch'],
        ['unexpected npm metadata', lock => lock.npm = {}, 'runtime-section-mismatch'],
    ])('rejects invalid source locks: %s', (label, mutate, code) => {
        const fixture = createFixture();
        mutate(fixture.lock);
        expect(() => validateSourcesLock(fixture.lock, Buffer.from(JSON.stringify(fixture.runtime)))).toThrow(code);
    });

    test.each([
        '../escape', '/absolute', 'C:/absolute', 'packages/shared-recipe/../escape',
        'packages/shared-recipe/./build.sh', 'packages//build.sh', 'packages\\build.sh', 'packages/build.sh\n',
    ])('rejects unsafe recipe member paths: %s', path => {
        const fixture = createFixture();
        fixture.lock.termux.packages[0].files[0].path = path;
        expect(() => validateSourcesLock(fixture.lock, Buffer.from(JSON.stringify(fixture.runtime)))).toThrow('unsafe-path');
    });

    test.each(['../escape.tar.xz', '/absolute.tar.xz', 'source\\escape.tar.xz', '..', 'C:source.tar.xz'])('rejects unsafe upstream filenames: %s', filename => {
        const fixture = createFixture();
        fixture.lock.termux.packages[0].sources[0].filename = filename;
        expect(() => validateSourcesLock(fixture.lock, Buffer.from(JSON.stringify(fixture.runtime)))).toThrow('unsafe-path');
    });

    test.each([
        ['escaping target', { target: '../../../escape' }, 'unsafe-path'],
        ['absolute target', { target: '/outside' }, 'unsafe-link'],
        ['backslash target', { target: '..\\outside' }, 'unsafe-link'],
        ['wrong link mode', { mode: 0o644 }, 'invalid-symlink'],
        ['wrong link digest', { sha256: '0'.repeat(64) }, 'invalid-symlink'],
    ])('rejects invalid symlink pins: %s', (label, metadata, code) => {
        const fixture = createFixture();
        const pkg = fixture.lock.termux.packages[0];
        pkg.files.push(filePin(pkg.commit, `${pkg.recipePath}/link.patch`, { type: 'symlink', mode: 0o777, target: 'fix.patch', ...metadata }));
        expect(() => validateSourcesLock(fixture.lock, Buffer.from(JSON.stringify(fixture.runtime)))).toThrow(code);
    });

    test('pins every file of the checked-in Node patch directory in path order', () => {
        const lock = JSON.parse(readFileSync(new URL('../android/runtime/sources.lock', import.meta.url), 'utf8'));
        const directory = new URL('../android/runtime/patches/node/', import.meta.url);
        // Like sources.node_patch_pins(): every regular file below the directory, no links or other types.
        const list = (prefix = '') => readdirSync(new URL(prefix, directory), { withFileTypes: true }).flatMap(entry => {
            if (entry.isDirectory()) {
                return list(`${prefix}${entry.name}/`);
            }
            expect([entry.name, entry.isFile()]).toEqual([entry.name, true]);
            return [`${prefix}${entry.name}`];
        });
        const pins = list().map(relative => ({
            path: `android/runtime/patches/node/${relative}`,
            sha256: sha256(readFileSync(new URL(relative, directory))),
        })).sort((left, right) => byCodePoint(left.path, right.path));
        expect(pins.map(pin => pin.path.split('/').pop())).toEqual([
            '0001-v8-x64-posix-trap-sources.patch',
            '0002-zlib-android-getauxval.patch',
            '0003-v8-arm64-host-trap-sources.patch',
            'LICENSE.ST-android',
            'series',
        ]);
        expect(lock.node.patches).toEqual(pins);
    });

    test('pins the Node tarball and npm version that android/runtime.lock names', () => {
        const runtime = JSON.parse(readFileSync(new URL('../android/runtime.lock', import.meta.url), 'utf8'));
        const lock = JSON.parse(readFileSync(new URL('../android/runtime/sources.lock', import.meta.url), 'utf8'));
        expect(lock.node.version).toBe(runtime.node.version);
        expect(lock.node.source).toEqual({
            filename: runtime.node.source.tarball,
            url: `https://nodejs.org/dist/v${runtime.node.version}/${runtime.node.source.tarball}`,
            sha256: runtime.node.source.tarballSha256,
        });
        expect(lock.npm).toEqual({ version: runtime.npm.version, source: 'node' });
    });

    test('accepts coherent Node and npm metadata with official integrity pins', () => {
        const fixture = createFixture();
        addNodeFixture(fixture);
        expect(() => validateSourcesLock(fixture.lock, Buffer.from(JSON.stringify(fixture.runtime)))).not.toThrow();
    });

    test.each([
        ['missing pinned Node', fixture => fixture.lock.node = null, 'runtime-section-mismatch'],
        ['different Node version', fixture => fixture.lock.node.version = '1.2.4', 'runtime-section-mismatch'],
        ['missing pinned npm', fixture => fixture.lock.npm = null, 'runtime-section-mismatch'],
        ['different npm version', fixture => fixture.lock.npm.version = '4.5.7', 'runtime-section-mismatch'],
        ['malformed matching Node versions', fixture => { fixture.runtime.node.version = 'not-a-version'; fixture.lock.node.version = 'not-a-version'; }, 'node-version'],
        ['unofficial source URL', fixture => fixture.lock.node.source.url = 'https://example.invalid/node.tar.xz', 'node-official-origin'],
        ['wrong source filename', fixture => fixture.lock.node.source.filename = '../node.tar.xz', 'node-official-origin'],
        ['malformed source digest', fixture => fixture.lock.node.source.sha256 = 'invalid', 'invalid-pin'],
        ['missing checksum list', fixture => delete fixture.lock.node.shasums, 'invalid-pin'],
        ['missing checksum signature', fixture => delete fixture.lock.node.signature, 'invalid-pin'],
        ['wrong keyring', fixture => fixture.lock.node.keyring.sha256 = '0'.repeat(64), 'node-keyring-pin'],
        ['missing patches list', fixture => delete fixture.lock.node.patches, 'node-patch-list'],
        ['traversing patch', fixture => fixture.lock.node.patches[0].path = 'android/runtime/patches/node/../escape', 'unsafe-path'],
        ['outside patch', fixture => fixture.lock.node.patches[0].path = 'android/runtime/patches/other/fix.patch', 'node-patch-pin'],
        ['duplicate patch', fixture => fixture.lock.node.patches.push({ ...fixture.lock.node.patches[0] }), 'node-patch-pin'],
        ['unsorted patches', fixture => fixture.lock.node.patches.unshift({ path: 'android/runtime/patches/node/z.patch', sha256: sha256('z patch') }), 'unsorted-node-patches'],
        ['malformed patch digest', fixture => fixture.lock.node.patches[0].sha256 = 'invalid', 'node-patch-pin'],
        ['npm from another source', fixture => fixture.lock.npm.source = 'registry', 'npm-source-mismatch'],
        ['npm without Node', fixture => { fixture.runtime.node = null; fixture.lock.node = null; }, 'npm-source-mismatch'],
    ])('rejects incoherent Node and npm metadata: %s', (label, mutate, code) => {
        const fixture = createFixture();
        addNodeFixture(fixture);
        mutate(fixture);
        const bytes = Buffer.from(JSON.stringify(fixture.runtime));
        fixture.lock.runtimeLockSha256 = sha256(bytes);
        expect(() => validateSourcesLock(fixture.lock, bytes)).toThrow(code);
    });
});
