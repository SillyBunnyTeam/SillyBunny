import { afterAll, beforeAll, describe, expect, jest, test } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32, deflateRawSync } from 'node:zlib';

import { parseAppVersionProperties, parseMinAppVersion, ReleaseToolError } from '../android/release/common.mjs';
import {
    ATTRIBUTE_INPUTS,
    canonicalInputsListing,
    computeInputsHash,
    EXTRA_INPUTS,
    inputsHashAtCommit,
    isPureDoc,
} from '../android/release/inputs-hash.mjs';
import { MAX_APK_BYTES, parseUpdateJson, validateManifestBytes, validateManifestText } from '../android/release/manifest-rules.mjs';
import { decideRelease, fetchPreviousReleases } from '../android/release/release-decision.mjs';
import {
    buildManifest,
    checkApkRuntimeManifests,
    checkApksAgainstManifest,
    findBuildTools,
    formatSigningCert,
    generateManifest,
    measureApk,
    parseApksignerOutput,
    parseBadging,
    readApkRuntimeManifest,
    readZipEntry,
    runtimeVersionsFromLock,
    verifyApksWithTools,
} from '../android/release/update-manifest.mjs';

// Temporary git repositories and CLI child processes are slow on Windows.
jest.setTimeout(120_000);

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const releaseScript = name => path.join(repoRoot, 'android', 'release', name);

const HASH_A = 'a1'.repeat(32);
const HASH_B = 'b2'.repeat(32);
const SIGNER = 'a6f296b190227ca0f0f6327ef06f3705f026a81562b10def548addb0f668e0f3';
const OTHER_SIGNER = '88c7b96f568d4735349049df6693a0c029c71a52e45c179345f565e4634da7b8';

let workDir;
let gitEnv;
let repoCount = 0;

beforeAll(() => {
    workDir = mkdtempSync(path.join(tmpdir(), 'sb-android-release-'));
    const home = path.join(workDir, 'home');
    mkdirSync(home);
    writeFileSync(path.join(home, 'gitconfig'), '');
    gitEnv = { ...process.env };
    for (const key of Object.keys(gitEnv)) {
        if (key.startsWith('GIT_')) {
            delete gitEnv[key];
        }
    }
    Object.assign(gitEnv, {
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: path.join(home, 'gitconfig'),
        GIT_DEFAULT_HASH: 'sha1',
        GIT_AUTHOR_NAME: 'test',
        GIT_AUTHOR_EMAIL: 'test@example.invalid',
        GIT_COMMITTER_NAME: 'test',
        GIT_COMMITTER_EMAIL: 'test@example.invalid',
        HOME: home,
        XDG_CONFIG_HOME: home,
    });
});

afterAll(() => {
    if (workDir) {
        rmSync(workDir, { recursive: true, force: true });
    }
});

function git(cwd, ...args) {
    const result = spawnSync('git', args, { cwd, env: gitEnv, encoding: 'utf8' });
    if (result.status !== 0) {
        throw new Error(`git ${args.join(' ')} failed (${result.status}): ${result.stderr}`);
    }
    return result.stdout.trim();
}

function writeFiles(root, files) {
    for (const [name, contents] of Object.entries(files)) {
        const file = path.join(root, name);
        if (contents === null) {
            rmSync(file, { force: true });
        } else {
            mkdirSync(path.dirname(file), { recursive: true });
            writeFileSync(file, contents);
        }
    }
}

function commitAll(repo, message = 'change') {
    git(repo, 'add', '--all');
    git(repo, 'commit', '--quiet', '--allow-empty', '-m', message);
    return git(repo, 'rev-parse', 'HEAD');
}

// A runtime.lock whose node and npm pins fix their payloads, as release-decision.mjs requires by default.
const pinnedBinary = abi => ({
    repository: 'ghcr.io/sillybunnyteam/sillybunny-android-runtime',
    tag: `node-24.22.0-1494da0071c0-${abi}`,
    digest: `sha256:${'d'.repeat(64)}`,
    sha256: 'e'.repeat(64),
    size: 94787384,
});
const PINNED_LOCK = {
    schema: 1,
    node: {
        version: '24.22.0',
        source: { tarball: 'node-v24.22.0.tar.xz', tarballSha256: 'f'.repeat(64) },
        binaries: { 'arm64-v8a': pinnedBinary('arm64-v8a'), 'armeabi-v7a': pinnedBinary('armeabi-v7a') },
    },
    npm: { version: '11.10.0', source: 'node' },
};
// PINNED_LOCK with some fields of one Node binary replaced.
const withNodeBinary = (abi, changes) => ({
    ...PINNED_LOCK,
    node: { ...PINNED_LOCK.node, binaries: { ...PINNED_LOCK.node.binaries, [abi]: { ...PINNED_LOCK.node.binaries[abi], ...changes } } },
});

const BASE_FILES = {
    'android/runtime.lock': `${JSON.stringify(PINNED_LOCK)}\n`,
    'android/app-version.properties': 'versionCode=1\nversionName=1.0.0\n',
    'android/min-app-version': '1\n',
    'android/app/build.gradle.kts': 'plugins {\n    id("app")\n}\n',
    'android/app/src/main/AndroidManifest.xml': '<manifest />\n',
    'android/gradlew': '#!/bin/sh\necho gradle\n',
    'scripts/bootstrap/install.sh': '#!/usr/bin/env bash\necho install\n',
    'scripts/self-update.sh': '#!/usr/bin/env bash\necho update\n',
    'README.md': 'root docs\n',
    'src/server.js': 'export {};\n',
};

function makeRepo(files = {}) {
    const repo = path.join(workDir, `repo-${++repoCount}`);
    mkdirSync(repo, { recursive: true });
    git(repo, 'init', '--quiet');
    git(repo, 'config', 'core.autocrlf', 'false');
    // Keep modes set with `update-index --chmod` on every platform; `add --all` would reset them on Linux.
    git(repo, 'config', 'core.fileMode', 'false');
    writeFiles(repo, { ...BASE_FILES, ...files });
    commitAll(repo, 'base');
    return repo;
}

function hashAt(repo, commit = 'HEAD', defaultRef = 'staging') {
    return inputsHashAtCommit({ repo, commit, defaultRef, env: gitEnv }).inputsHash;
}

function lsEntry(mode, digit, filePath) {
    return { mode, type: mode === '160000' ? 'commit' : 'blob', oid: digit.repeat(40), path: Buffer.from(filePath) };
}

/**
 * A heuristic guard that keeps EXTRA_INPUTS in step with the build: the existing paths outside android/
 * that string literals in the Gradle scripts of `root` (android/*.gradle.kts and android/<module>/*.gradle.kts)
 * name. A literal that starts with ../ (after a leading ${...}/ template) is resolved from android/ and from
 * android/app/; any other literal with a slash is resolved from `root` when its first segment is no entry of
 * android/ or android/app/, so that it cannot be relative to a Gradle project directory.
 */
function gradleNamedPaths(root) {
    const androidDir = path.join(root, 'android');
    const appDir = path.join(androidDir, 'app');
    const projectDirs = [androidDir, ...readdirSync(androidDir, { withFileTypes: true })
        .filter(entry => entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'build')
        .map(entry => path.join(androidDir, entry.name))];
    const gradleFiles = projectDirs.flatMap(directory => readdirSync(directory)
        .filter(name => name.endsWith('.gradle.kts'))
        .map(name => path.join(directory, name)));
    expect(gradleFiles.map(file => path.relative(root, file).replaceAll('\\', '/'))).toContain('android/app/build.gradle.kts');
    const outside = target => {
        const relative = path.relative(root, target).replaceAll('\\', '/');
        const inRepository = relative !== '' && !relative.startsWith('../') && !path.isAbsolute(relative);
        return inRepository && relative !== 'android' && !relative.startsWith('android/') && existsSync(target) ? relative : null;
    };
    const named = new Set();
    for (const file of gradleFiles) {
        for (const [, raw] of readFileSync(file, 'utf8').matchAll(/"([^"\n\\]*)"/g)) {
            const literal = raw.replace(/^\$(?:\{[^}]*\}|[A-Za-z_][A-Za-z0-9_]*)\//, '');
            if (literal.includes('$') || literal.includes(':') || path.isAbsolute(literal) || !literal.includes('/')) {
                continue;
            }
            const first = literal.split('/')[0];
            const targets = literal.startsWith('../')
                ? [path.join(androidDir, literal), path.join(appDir, literal)]
                : [existsSync(path.join(androidDir, first)) || existsSync(path.join(appDir, first)) ? null : path.join(root, literal)];
            for (const relative of targets.filter(Boolean).map(outside)) {
                if (relative !== null) {
                    named.add(relative);
                }
            }
        }
    }
    return [...named].sort();
}

describe('inputsHash', () => {
    test('pins the canonical v2 listing and its hash', () => {
        const entries = [
            lsEntry('100644', 'b', 'android/runtime.lock'),
            lsEntry('100755', 'f', 'scripts/bootstrap/install.sh'),
            lsEntry('100755', 'a', 'android/gradlew'),
            lsEntry('100644', 'c', 'android/README.md'),
            lsEntry('100644', 'd', 'android/app/src/main/assets/a.md'),
            lsEntry('120000', 'e', 'android/link.md'),
            lsEntry('100644', '2', 'scripts/bootstrap/.gitattributes'),
            lsEntry('100644', '1', '.gitattributes'),
        ];
        const expected = 'sillybunny-android-inputs v2\ndefaultRef release\n'
            + `100644 ${'1'.repeat(40)} .gitattributes\0`
            + `100644 ${'d'.repeat(40)} android/app/src/main/assets/a.md\0`
            + `100755 ${'a'.repeat(40)} android/gradlew\0`
            + `120000 ${'e'.repeat(40)} android/link.md\0`
            + `100644 ${'b'.repeat(40)} android/runtime.lock\0`
            + `100644 ${'2'.repeat(40)} scripts/bootstrap/.gitattributes\0`
            + `100755 ${'f'.repeat(40)} scripts/bootstrap/install.sh\0`;
        expect(canonicalInputsListing(entries, 'release').toString('utf8')).toBe(expected);
        // SHA-256 of `expected`, computed independently with Python's hashlib and sha256sum.
        expect(computeInputsHash(entries, 'release')).toBe('de65713796fdc290bc44b28fd4385c81397b6c738b752bb9fc7d1b68be87d060');
        expect(computeInputsHash([...entries].reverse(), 'release')).toBe(computeInputsHash(entries, 'release'));

        expect(() => canonicalInputsListing([...entries, lsEntry('100644', '3', 'scripts/self-update.sh')], 'release'))
            .toThrow(/"scripts\/self-update\.sh" is not an inputsHash input path/);
        expect(() => canonicalInputsListing([...entries, lsEntry('100644', '3', 'src/.gitattributes')], 'release'))
            .toThrow(/"src\/\.gitattributes" is not an inputsHash input path/);
        const withoutInstaller = entries.filter(entry => entry.path.toString() !== 'scripts/bootstrap/install.sh');
        expect(() => canonicalInputsListing(withoutInstaller, 'release')).toThrow(/^scripts\/bootstrap\/install\.sh is not a tracked regular file$/);
        expect(() => canonicalInputsListing([...withoutInstaller, lsEntry('120000', 'f', 'scripts/bootstrap/install.sh')], 'release'))
            .toThrow(/^scripts\/bootstrap\/install\.sh is not a tracked regular file$/);
    });

    test('names its inputs outside android/ explicitly', () => {
        expect(EXTRA_INPUTS).toEqual(['scripts/bootstrap/install.sh']);
        expect(ATTRIBUTE_INPUTS).toEqual(['.gitattributes', 'scripts/.gitattributes', 'scripts/bootstrap/.gitattributes']);
    });

    test('covers every repository file outside android/ that the Gradle scripts name', () => {
        // The guard must find such references, however they are spelled.
        const fixture = path.join(workDir, `gradle-${++repoCount}`);
        writeFiles(fixture, {
            'android/settings.gradle.kts': 'rootProject.name = "x"\n',
            'android/app/build.gradle.kts': [
                'val installer = rootProject.file("../scripts/bootstrap/install.sh")',
                'val update = file("../../scripts/self-update.sh")',
                'val start = "${rootDir}/../start.sh"',
                'val wrapper = rootDir.parentFile.resolve("scripts/bootstrap/Install-SillyBunny.ps1")',
                'val lock = rootProject.file("runtime.lock")',
                'val trampoline = file("src/main/cpp/npm-trampoline.c")',
                'val url = "https://example.invalid/scripts/self-update.sh"',
                'val absent = rootProject.file("../scripts/absent.sh")',
                '',
            ].join('\n'),
            'android/app/src/main/cpp/npm-trampoline.c': '',
            'android/runtime.lock': '{}\n',
            'scripts/bootstrap/install.sh': '',
            'scripts/bootstrap/Install-SillyBunny.ps1': '',
            'scripts/self-update.sh': '',
            'start.sh': '',
        });
        expect(gradleNamedPaths(fixture)).toEqual(['scripts/bootstrap/Install-SillyBunny.ps1', 'scripts/bootstrap/install.sh', 'scripts/self-update.sh', 'start.sh']);
        expect(gradleNamedPaths(repoRoot).filter(relative => !EXTRA_INPUTS.includes(relative))).toEqual([]);
    });

    test('is stable for a commit, across clones and for unusual path names', () => {
        const repo = makeRepo({ 'android/runtime/naïve file.txt': 'x\n', 'android/z-last.txt': 'z\n' });
        const commit = git(repo, 'rev-parse', 'HEAD');
        const first = inputsHashAtCommit({ repo, commit: 'HEAD', defaultRef: 'staging', env: gitEnv });
        expect(first.inputsHash).toMatch(/^[0-9a-f]{64}$/);
        expect(first.commit).toBe(commit);
        expect(hashAt(repo, commit)).toBe(first.inputsHash);
        const clone = path.join(workDir, `clone-${++repoCount}`);
        git(workDir, 'clone', '--quiet', repo, clone);
        expect(hashAt(clone, commit)).toBe(first.inputsHash);
        expect(first.listing.toString('utf8')).toContain(' android/runtime/naïve file.txt\0');
    });

    test('changes with every tracked change under android/ and ignores the rest of the repository', () => {
        const repo = makeRepo();
        const seen = new Set([hashAt(repo)]);
        const expectNew = () => {
            const hash = hashAt(repo);
            expect(seen.has(hash)).toBe(false);
            seen.add(hash);
        };
        writeFiles(repo, { 'android/app/build.gradle.kts': 'plugins {\n    id("app2")\n}\n' });
        commitAll(repo);
        expectNew();
        writeFiles(repo, { 'android/runtime.lock': '{"schema":1,"node":null}\n' });
        commitAll(repo);
        expectNew();
        git(repo, 'update-index', '--chmod=+x', 'android/gradlew');
        commitAll(repo);
        expectNew();
        git(repo, 'mv', 'android/gradlew', 'android/gradlew2');
        commitAll(repo);
        expectNew();
        writeFiles(repo, { 'android/new.txt': 'new\n' });
        commitAll(repo);
        expectNew();
        writeFiles(repo, { 'android/app/src/main/AndroidManifest.xml': null });
        commitAll(repo);
        expectNew();
        // Restoring an earlier tree restores its hash.
        const restored = hashAt(repo);
        writeFiles(repo, { 'android/new.txt': 'changed\n' });
        commitAll(repo);
        expectNew();
        writeFiles(repo, { 'android/new.txt': 'new\n' });
        commitAll(repo);
        expect(hashAt(repo)).toBe(restored);

        const before = hashAt(repo);
        writeFiles(repo, {
            'README.md': 'changed\n',
            'src/server.js': 'export const x = 1;\n',
            'docs/android.md': 'x\n',
            'scripts/self-update.sh': '#!/usr/bin/env bash\necho changed\n',
            'scripts/bootstrap/Install-SillyBunny.ps1': 'Write-Output x\n',
            'scripts/bootstrap/install.sh.bak': 'backup\n',
            'src/.gitattributes': '*.js text eol=crlf\n',
            'android-notes.txt': 'not under android/\n',
        });
        commitAll(repo);
        expect(hashAt(repo)).toBe(before);
    });

    test('changes with scripts/bootstrap/install.sh and every .gitattributes file that applies to an input', () => {
        const repo = makeRepo();
        const seen = new Set([hashAt(repo)]);
        const expectNew = () => {
            const hash = hashAt(repo);
            expect(seen.has(hash)).toBe(false);
            seen.add(hash);
        };
        writeFiles(repo, { 'scripts/bootstrap/install.sh': '#!/usr/bin/env bash\necho changed installer\n' });
        commitAll(repo);
        expectNew();
        git(repo, 'update-index', '--chmod=+x', 'scripts/bootstrap/install.sh');
        commitAll(repo);
        expectNew();
        for (const file of ['.gitattributes', 'scripts/.gitattributes', 'scripts/bootstrap/.gitattributes', 'android/.gitattributes']) {
            writeFiles(repo, { [file]: '*.sh text eol=crlf\n' });
            commitAll(repo);
            expectNew();
        }
        const listing = inputsHashAtCommit({ repo, defaultRef: 'staging', env: gitEnv }).listing.toString('utf8');
        const paths = listing.split('\0').slice(0, -1).map(record => record.slice(record.lastIndexOf(' ') + 1));
        expect(paths).toEqual([
            '.gitattributes',
            'android/.gitattributes',
            'android/app-version.properties',
            'android/app/build.gradle.kts',
            'android/app/src/main/AndroidManifest.xml',
            'android/gradlew',
            'android/min-app-version',
            'android/runtime.lock',
            'scripts/.gitattributes',
            'scripts/bootstrap/.gitattributes',
            'scripts/bootstrap/install.sh',
        ]);
    });

    test('leaves out pure docs and nothing else', () => {
        const repo = makeRepo();
        const base = hashAt(repo);
        writeFiles(repo, { 'android/README.md': '# notes\n', 'android/runtime/NOTES.MD': 'notes\n' });
        commitAll(repo);
        expect(hashAt(repo)).toBe(base);
        git(repo, 'update-index', '--chmod=+x', 'android/README.md');
        commitAll(repo);
        expect(hashAt(repo)).toBe(base);
        const result = inputsHashAtCommit({ repo, defaultRef: 'staging', env: gitEnv });
        expect(result.excluded.sort()).toEqual(['android/README.md', 'android/runtime/NOTES.MD']);

        const packaged = makeRepo();
        const packagedBase = hashAt(packaged);
        writeFiles(packaged, { 'android/app/src/main/assets/guide.md': 'packaged\n' });
        commitAll(packaged);
        expect(hashAt(packaged)).not.toBe(packagedBase);

        const text = makeRepo();
        const textBase = hashAt(text);
        writeFiles(text, { 'android/notes.txt': 'not markdown\n' });
        commitAll(text);
        expect(hashAt(text)).not.toBe(textBase);

        const linked = makeRepo();
        const linkedBase = hashAt(linked);
        const target = spawnSync('git', ['hash-object', '-w', '--stdin'], { cwd: linked, env: gitEnv, input: 'app/build.gradle.kts', encoding: 'utf8' }).stdout.trim();
        git(linked, 'update-index', '--add', '--cacheinfo', `120000,${target},android/link.md`);
        git(linked, 'commit', '--quiet', '-m', 'symlink');
        expect(hashAt(linked)).not.toBe(linkedBase);

        expect(isPureDoc({ mode: '100644', path: 'android/README.md' })).toBe(true);
        expect(isPureDoc({ mode: '100644', path: 'android/app/src/main/res/raw/help.md' })).toBe(false);
        expect(isPureDoc({ mode: '120000', path: 'android/link.md' })).toBe(false);
        expect(isPureDoc({ mode: '160000', path: 'android/module.md' })).toBe(false);
        expect(isPureDoc({ mode: '100644', path: 'android/readme.markdown' })).toBe(false);
    });

    test('ignores checkout line endings, untracked, ignored and uncommitted files', () => {
        const repo = makeRepo({ '.gitignore': 'android/app/build/\n' });
        const base = hashAt(repo);
        const clone = path.join(workDir, `crlf-${++repoCount}`);
        git(workDir, 'clone', '--quiet', '-c', 'core.autocrlf=true', repo, clone);
        expect(readFileSync(path.join(clone, 'android', 'app', 'build.gradle.kts'), 'utf8')).toContain('\r\n');
        expect(hashAt(clone)).toBe(base);
        writeFiles(clone, {
            'android/app/build/outputs/apk/app.apk': 'generated',
            'android/untracked.txt': 'untracked\n',
            'android/app/build.gradle.kts': 'uncommitted\r\n',
        });
        expect(git(clone, 'status', '--porcelain', '--ignored')).toContain('android/app/build/');
        expect(hashAt(clone)).toBe(base);
    });

    test('depends on defaultRef', () => {
        const repo = makeRepo();
        expect(hashAt(repo, 'HEAD', 'staging')).not.toBe(hashAt(repo, 'HEAD', 'release'));
        expect(() => hashAt(repo, 'HEAD', 'main')).toThrow(/defaultRef must be staging or release/);
    });

    test('refuses commits without android/runtime.lock or scripts/bootstrap/install.sh, unknown commits and option-like revisions', () => {
        const repo = makeRepo({ 'android/runtime.lock': null });
        expect(() => hashAt(repo)).toThrow(/^android\/runtime\.lock is not a tracked regular file$/);
        const empty = makeRepo({ 'android/runtime.lock': null, 'android/app-version.properties': null, 'android/min-app-version': null,
            'android/app/build.gradle.kts': null, 'android/app/src/main/AndroidManifest.xml': null, 'android/gradlew': null });
        expect(() => hashAt(empty)).toThrow(/android\/ is not tracked/);
        expect(() => hashAt(repo, 'f'.repeat(40))).toThrow(/is not a commit/);
        expect(() => hashAt(repo, '--output=x')).toThrow(/invalid commit/);

        const noInstaller = makeRepo({ 'scripts/bootstrap/install.sh': null });
        expect(() => hashAt(noInstaller)).toThrow(/^scripts\/bootstrap\/install\.sh is not a tracked regular file$/);
        const installerDirectory = makeRepo({ 'scripts/bootstrap/install.sh': null, 'scripts/bootstrap/install.sh/run.sh': 'echo\n' });
        expect(() => hashAt(installerDirectory)).toThrow(/^scripts\/bootstrap\/install\.sh is not a tracked regular file$/);
        // A symlink would make the build package bytes that the hash does not cover.
        for (const target of ['scripts/bootstrap/install.sh', 'android/runtime.lock']) {
            const linked = makeRepo({ [target]: null });
            const link = spawnSync('git', ['hash-object', '-w', '--stdin'], { cwd: linked, env: gitEnv, input: 'elsewhere', encoding: 'utf8' }).stdout.trim();
            git(linked, 'update-index', '--add', '--cacheinfo', `120000,${link},${target}`);
            git(linked, 'commit', '--quiet', '-m', 'symlink');
            expect(() => hashAt(linked)).toThrow(`${target} is not a tracked regular file`);
        }
    });
});

describe('app version inputs', () => {
    test('reads app-version.properties like java.util.Properties and the Gradle build', () => {
        expect(parseAppVersionProperties('versionCode=1\nversionName=1.0.0\n')).toEqual({ versionCode: 1, versionName: '1.0.0' });
        expect(parseAppVersionProperties('# c\r\n! c\r\n  versionCode : 007\r\nversionName 1.2.0-rc\r\n')).toEqual({ versionCode: 7, versionName: '1.2.0-rc' });
        expect(parseAppVersionProperties('versionCode=+2100000000\nversionName=x\n').versionCode).toBe(2_100_000_000);
        expect(parseAppVersionProperties(Buffer.from([...Buffer.from('versionCode=3\nversionName=caf'), 0xe9])).versionName).toBe('café');
        for (const text of [
            'versionName=1.0.0\n',
            'versionCode=0\nversionName=1\n',
            'versionCode=2100000001\nversionName=1\n',
            'versionCode=1 \nversionName=1\n',
            'versionCode=1.0\nversionName=1\n',
            'versionCode=-1\nversionName=1\n',
            'versionCode=1\nversionName=\n',
            'versionCode=1\nversionName=\u3000\n',
            'versionCode=1\n',
            'versionCode=1\nversionName=a\\\n  b\n',
        ]) {
            expect(() => parseAppVersionProperties(text)).toThrow(ReleaseToolError);
        }
    });

    test('reads min-app-version like the launcher scripts', () => {
        expect(parseMinAppVersion('1\n')).toBe(1n);
        expect(parseMinAppVersion(' 007 \r\n')).toBe(7n);
        expect(parseMinAppVersion('0')).toBe(0n);
        expect(parseMinAppVersion('99999999999999999999\n')).toBe(99999999999999999999n);
        for (const text of ['', '\n', '1.0', '-1', '1 2', 'one', '1\u00a0']) {
            expect(() => parseMinAppVersion(text)).toThrow(/must contain one decimal integer/);
        }
    });
});

function manifestFixture({ versionCode = 1, prerelease = false, inputsHash = HASH_A, releaseTag, versionName, defaultRef } = {}) {
    return {
        schema: 1,
        versionCode,
        versionName: versionName ?? `1.${versionCode}.0`,
        prerelease,
        releaseTag: releaseTag ?? (prerelease ? `v2.${versionCode}.0-rc.1` : `v2.${versionCode}.0`),
        defaultRef: defaultRef ?? (prerelease ? 'staging' : 'release'),
        minSdk: 29,
        signingCertSha256: SIGNER,
        inputsHash,
        assets: {
            'arm64-v8a': { name: 'SillyBunny-android-arm64-v8a.apk', sha256: 'cd'.repeat(32), size: 131073 },
            'armeabi-v7a': { name: 'SillyBunny-android-armeabi-v7a.apk', sha256: 'ef'.repeat(32), size: 131000 },
        },
        runtime: { node: '24.22.0', bun: null, git: '2.56.0', bash: '5.3.20', npm: '11.10.0' },
    };
}

function releaseOf(manifest, extra = {}) {
    return { tag: manifest.releaseTag, draft: false, prerelease: manifest.prerelease, publishedAt: '2026-10-01T00:00:00Z', manifest, ...extra };
}

function decide({ previous = [], ...rest } = {}) {
    return decideRelease({ prerelease: false, inputsHash: HASH_B, versionCode: 2, versionName: '1.2.0', minAppVersion: 1n, runtimeLock: PINNED_LOCK, previous, ...rest });
}

describe('release decision (§6.1)', () => {
    test('builds the first release when there is no previous release', () => {
        const stable = decide();
        expect(stable).toMatchObject({ action: 'build', previous: null, prerelease: false, defaultRef: 'release', versionCode: 2, highestPreviousVersionCode: null });
        expect(stable.reasons[0]).toMatch(/no previous release/);
        expect(decide({ prerelease: true })).toMatchObject({ action: 'build', defaultRef: 'staging' });
    });

    test('re-attaches when inputsHash matches the most recent release of the same channel', () => {
        const previous = [releaseOf(manifestFixture({ versionCode: 2, inputsHash: HASH_B, versionName: '1.2.0' }))];
        const decision = decide({ previous });
        expect(decision).toMatchObject({ action: 'reattach', versionCode: 2, highestPreviousVersionCode: 2 });
        expect(decision.previous).toMatchObject({ tag: 'v2.2.0', releaseTag: 'v2.2.0', versionCode: 2, inputsHash: HASH_B, draft: false });
        expect(decision.previous.assets).toEqual({ 'arm64-v8a': 'SillyBunny-android-arm64-v8a.apk', 'armeabi-v7a': 'SillyBunny-android-armeabi-v7a.apk' });
        expect(decision.reasons[0]).toMatch(/inputsHash matches the most recent stable release v2\.2\.0/);
    });

    test('builds when inputsHash changed and versionCode is higher than every previous release', () => {
        const previous = [releaseOf(manifestFixture({ versionCode: 1, inputsHash: HASH_A }))];
        const decision = decide({ previous });
        expect(decision).toMatchObject({ action: 'build', versionCode: 2, highestPreviousVersionCode: 1 });
        expect(decision.previous).toMatchObject({ tag: 'v2.1.0', inputsHash: HASH_A });
    });

    test('fails when versionCode is not higher than the highest previous versionCode', () => {
        const previous = [releaseOf(manifestFixture({ versionCode: 2, inputsHash: HASH_A }))];
        expect(() => decide({ previous })).toThrow(/versionCode 2 in android\/app-version\.properties must be greater than 2.*\(v2\.2\.0\)/);
        expect(() => decide({ previous, versionCode: 1, versionName: '1.1.0' })).toThrow(/must be greater than 2/);
    });

    test('compares inputsHash with the most recent same-channel release only', () => {
        const previous = [
            releaseOf(manifestFixture({ versionCode: 4, inputsHash: HASH_A }), { publishedAt: '2026-09-01T00:00:00Z' }),
            releaseOf(manifestFixture({ versionCode: 3, inputsHash: HASH_B }), { publishedAt: '2026-08-01T00:00:00Z' }),
        ];
        expect(decide({ previous, versionCode: 5 })).toMatchObject({ action: 'build', previous: { tag: 'v2.4.0' } });
        expect(() => decide({ previous, versionCode: 3, versionName: '1.3.0' })).toThrow(/must be greater than 4/);
    });

    test('rebuilds a stable release after a release candidate and never re-attaches across channels', () => {
        const candidate = releaseOf(manifestFixture({ versionCode: 1, prerelease: true, inputsHash: HASH_A }));
        expect(() => decide({ previous: [candidate], versionCode: 1, versionName: '1.0.0' })).toThrow(/must be greater than 1.*v2\.1\.0-rc\.1/);
        expect(decide({ previous: [candidate] })).toMatchObject({ action: 'build', previous: null, highestPreviousVersionCode: 1, defaultRef: 'release' });

        const sameHash = releaseOf(manifestFixture({ versionCode: 2, prerelease: true, inputsHash: HASH_B, versionName: '1.2.0' }));
        expect(() => decide({ previous: [sameHash] })).toThrow(/must be greater than 2/);
        expect(decide({ previous: [sameHash], prerelease: true })).toMatchObject({ action: 'reattach', previous: { tag: 'v2.2.0-rc.1' } });
    });

    test('fails when min-app-version is greater than the versionCode attached to the release', () => {
        expect(() => decide({ minAppVersion: 3n })).toThrow(/android\/min-app-version 3 is greater than versionCode 2/);
        expect(decide({ minAppVersion: 2n })).toMatchObject({ action: 'build', minAppVersion: 2 });
        expect(decide({ minAppVersion: '0\n' })).toMatchObject({ action: 'build', minAppVersion: 0 });
        const previous = [releaseOf(manifestFixture({ versionCode: 2, inputsHash: HASH_B, versionName: '1.2.0' }))];
        expect(() => decide({ previous, minAppVersion: 3n })).toThrow(/greater than versionCode 2 of the re-attached release v2\.2\.0/);
    });

    test('counts drafts for the versionCode rule but never re-attaches them', () => {
        const draft = releaseOf(manifestFixture({ versionCode: 5, inputsHash: HASH_A }), { draft: true });
        expect(() => decide({ previous: [draft], versionCode: 5, versionName: '1.5.0' })).toThrow(/greater than 5.*a draft/);
        expect(decide({ previous: [draft], versionCode: 6 })).toMatchObject({ action: 'build', previous: null, highestPreviousVersionCode: 5 });
        const matchingDraft = releaseOf(manifestFixture({ versionCode: 2, inputsHash: HASH_B, versionName: '1.2.0' }), { draft: true });
        expect(() => decide({ previous: [matchingDraft] })).toThrow(/must be greater than 2/);
    });

    test('breaks versionCode ties by publishedAt, then by list order', () => {
        const original = manifestFixture({ versionCode: 2, inputsHash: HASH_B, versionName: '1.2.0', releaseTag: 'v2.0.0' });
        const older = releaseOf(original, { tag: 'v2.0.0', publishedAt: '2026-08-01T00:00:00Z' });
        const newer = releaseOf(original, { tag: 'v2.0.1', publishedAt: '2026-09-01T00:00:00Z' });
        expect(decide({ previous: [older, newer] }).previous).toMatchObject({ tag: 'v2.0.1', releaseTag: 'v2.0.0' });
        const first = releaseOf(original, { tag: 'v2.0.2', publishedAt: null });
        const second = releaseOf(original, { tag: 'v2.0.3', publishedAt: null });
        expect(decide({ previous: [first, second] }).previous.tag).toBe('v2.0.2');
    });

    test('requires a re-attached manifest to carry this release version and defaultRef', () => {
        const previous = [releaseOf(manifestFixture({ versionCode: 2, inputsHash: HASH_B, versionName: '1.2.0' }))];
        expect(() => decide({ previous, versionCode: 3 })).toThrow(/carries versionCode 2 and versionName "1\.2\.0", not 3/);
        expect(() => decide({ previous, versionName: '1.2.1' })).toThrow(/carries versionCode 2/);
        const wrongRef = [releaseOf(manifestFixture({ versionCode: 2, inputsHash: HASH_B, versionName: '1.2.0', defaultRef: 'staging' }))];
        expect(() => decide({ previous: wrongRef })).toThrow(/has defaultRef staging; a stable release needs release/);
    });

    test('accepts bare manifests and raw manifest text', () => {
        const manifest = manifestFixture({ versionCode: 2, inputsHash: HASH_B, versionName: '1.2.0' });
        expect(decide({ previous: [manifest] })).toMatchObject({ action: 'reattach', previous: { tag: 'v2.2.0', draft: false, publishedAt: null } });
        expect(decide({ previous: [{ manifest: JSON.stringify(manifest) }] })).toMatchObject({ action: 'reattach' });
    });

    test('rejects previous manifests the app would reject', () => {
        const text = JSON.stringify(manifestFixture({ versionCode: 1 }));
        for (const raw of [
            text.replace('"versionCode":1', '"versionCode":1.0'),
            text.replace('{', '{"schema":1,'),
            text.replace('"versionCode":1', '"versionCode":"1"'),
            `\uFEFF${text}`,
        ]) {
            expect(() => decide({ previous: [{ tag: 'v2.1.0', manifest: raw }] })).toThrow(/previous release v2\.1\.0: android-update\.json/);
        }
        const unusableTag = manifestFixture({ versionCode: 1, releaseTag: 'v2.1.0:bad' });
        expect(() => decide({ previous: [unusableTag] })).toThrow(/releaseTag cannot form the stable download URL/);
        const mismatch = releaseOf(manifestFixture({ versionCode: 1 }), { prerelease: true });
        expect(() => decide({ previous: [mismatch] })).toThrow(/is a prerelease but its android-update\.json says prerelease false/);
        expect(() => decide({ previous: [releaseOf(manifestFixture(), { draft: 'no' })] })).toThrow(/"draft" must be a boolean/);
        expect(() => decide({ previous: {} })).toThrow(/must be a JSON array/);
    });

    test('validates its own inputs', () => {
        expect(() => decide({ prerelease: 'false' })).toThrow(/prerelease must be true or false/);
        expect(() => decide({ inputsHash: HASH_B.toUpperCase() })).toThrow(/inputsHash must be 64 lowercase hex digits/);
        expect(() => decide({ versionCode: 0 })).toThrow(/versionCode must be an integer/);
        expect(() => decide({ minAppVersion: -1 })).toThrow(/minAppVersion must be a non-negative integer/);
        expect(() => decide({ allowUnpinnedRuntime: 'yes' })).toThrow(/allowUnpinnedRuntime must be true or false/);
    });

    test('applies the app\'s versionName rule before anything is built', () => {
        // java.util.Properties keeps a trailing tab and the Gradle build only rejects blank names, but
        // android-update.json allows at most 128 characters and no control characters.
        const rule = 'must be a non-blank string of at most 128 characters without control characters, as android-update.json requires';
        expect(() => decide({ versionName: ' ' })).toThrow(`versionName " " ${rule}`);
        expect(() => decide({ versionName: '1.0.0\t' })).toThrow(`versionName "1.0.0\\t" ${rule}`);
        expect(() => decide({ versionName: 'x'.repeat(129) })).toThrow(`versionName "${'x'.repeat(40)}"... (129 characters) ${rule}`);
        expect(() => decide({ versionName: 'a\u007f' })).toThrow(rule);
        expect(() => decide({ versionName: undefined })).toThrow(`versionName (undefined) ${rule}`);
        expect(decide({ versionName: 'x'.repeat(128), versionCode: 2 })).toMatchObject({ action: 'build', versionName: 'x'.repeat(128) });
    });

    test('refuses an unpinned node or npm in android/runtime.lock unless allowed, and then only builds', () => {
        const unpinned = { schema: 1, node: null, npm: null };
        // Task 4.1 leaves a binary's digest, SHA-256 and size null until android-runtime.yml first publishes it.
        const unpublished = withNodeBinary('arm64-v8a', { digest: null, sha256: null, size: null });
        expect(() => decide({ runtimeLock: unpinned })).toThrow('android/runtime.lock does not pin node and npm yet, so inputsHash cannot show that the bundled node and npm payloads are unchanged; pin them, or pass --allow-unpinned-runtime to allow a build (never a re-attach)');
        expect(() => decide({ runtimeLock: { ...PINNED_LOCK, npm: null } })).toThrow(/^android\/runtime\.lock does not pin npm yet/);
        expect(() => decide({ runtimeLock: unpublished })).toThrow(/^android\/runtime\.lock does not pin node yet/);
        expect(decide()).toMatchObject({ action: 'build', unpinnedRuntime: [] });

        const built = decide({ runtimeLock: unpinned, allowUnpinnedRuntime: true });
        expect(built).toMatchObject({ action: 'build', versionCode: 2, unpinnedRuntime: ['node', 'npm'] });
        expect(built.reasons).toContain('android/runtime.lock does not pin node and npm; --allow-unpinned-runtime allows this build, and inputsHash does not cover those payloads');
        const changed = [releaseOf(manifestFixture({ versionCode: 1, inputsHash: HASH_A }))];
        expect(decide({ previous: changed, runtimeLock: unpinned, allowUnpinnedRuntime: true })).toMatchObject({ action: 'build', highestPreviousVersionCode: 1 });

        // A matching inputsHash cannot prove that the unpinned payloads are unchanged, so there is no re-attach.
        const matching = [releaseOf(manifestFixture({ versionCode: 2, inputsHash: HASH_B, versionName: '1.2.0' }))];
        expect(decide({ previous: matching })).toMatchObject({ action: 'reattach' });
        expect(() => decide({ previous: matching, runtimeLock: unpublished, allowUnpinnedRuntime: true }))
            .toThrow('inputsHash matches the most recent stable release v2.2.0, but android/runtime.lock does not pin node, so a re-attach could skip a change to those payloads; bump versionCode in android/app-version.properties to build');

        for (const lock of [undefined, null, [], { schema: 2, node: null, npm: null }, { schema: 1, node: { digest: 'x' } }, { schema: 1, npm: '11.10.0' }, { schema: 1, node: { version: '' } }]) {
            expect(() => decide({ runtimeLock: lock, allowUnpinnedRuntime: true }))
                .toThrow(/^android\/runtime\.lock (must be a schema 1 lock|pins (node|npm) without a "version" string)$/);
        }
    });

    test('counts node and npm as pinned only once android/runtime.lock fixes their payload bytes', () => {
        const unpinnedIn = runtimeLock => decide({ runtimeLock, allowUnpinnedRuntime: true }).unpinnedRuntime;
        const withNode = changes => ({ ...PINNED_LOCK, node: { ...PINNED_LOCK.node, ...changes } });
        expect(unpinnedIn(PINNED_LOCK)).toEqual([]);

        // Each release ABI needs the published binary's OCI digest, SHA-256 and size.
        for (const abi of ['arm64-v8a', 'armeabi-v7a']) {
            for (const changes of [{ digest: null }, { sha256: null }, { size: null }, { digest: 'd'.repeat(64) }, { digest: `sha256:${'D'.repeat(64)}` },
                { sha256: 'e'.repeat(63) }, { size: 0 }, { size: 1.5 }, { size: '94787384' }]) {
                expect(unpinnedIn(withNodeBinary(abi, changes))).toEqual(['node']);
            }
            const others = Object.fromEntries(Object.entries(PINNED_LOCK.node.binaries).filter(([name]) => name !== abi));
            expect(unpinnedIn(withNode({ binaries: others }))).toEqual(['node']);
        }
        expect(unpinnedIn(withNode({ binaries: null }))).toEqual(['node']);
        expect(unpinnedIn(withNode({ binaries: undefined }))).toEqual(['node']);
        // Release APKs bundle only the ARM binaries, so an unpublished x86_64 test binary does not count.
        expect(unpinnedIn(withNode({ binaries: { ...PINNED_LOCK.node.binaries, x86_64: { digest: null, sha256: null, size: null } } }))).toEqual([]);

        // npm comes from the Node source's deps/npm, so the source tarball's SHA-256 pins both.
        for (const source of [undefined, null, {}, { tarballSha256: null }, { tarballSha256: 'F'.repeat(64) }]) {
            expect(unpinnedIn(withNode({ source }))).toEqual(['node', 'npm']);
        }
        expect(unpinnedIn({ ...PINNED_LOCK, node: null })).toEqual(['node', 'npm']);
        for (const npm of [{ version: '11.10.0' }, { version: '11.10.0', source: 'registry' }]) {
            expect(unpinnedIn({ ...PINNED_LOCK, npm })).toEqual(['npm']);
        }
    });
});

function fakeResponse(status, { body = '', headers = {} } = {}) {
    const bytes = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    return {
        status,
        ok: status >= 200 && status < 300,
        headers: { get: name => headers[name.toLowerCase()] ?? null },
        json: async () => JSON.parse(bytes.toString('utf8')),
        arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    };
}

function fakeGitHub(routes) {
    const calls = [];
    const fetch = async (url, init) => {
        calls.push({ url, headers: init.headers, redirect: init.redirect });
        const route = routes[url];
        return route === undefined ? fakeResponse(404) : route();
    };
    return { fetch, calls };
}

const API = 'https://api.example.test';
const LIST_URL = page => `${API}/repos/team/app/releases?per_page=2&page=${page}`;
const assetUrl = id => `${API}/repos/team/app/releases/assets/${id}`;

function manifestAsset(id, size = 100) {
    return { name: 'android-update.json', url: assetUrl(id), size, browser_download_url: `https://downloads.example.test/${id}` };
}

describe('fetching previous releases', () => {
    test('lists every page, downloads each android-update.json and keeps the token on the API host', async () => {
        const draftManifest = JSON.stringify(manifestFixture({ versionCode: 3 }));
        const stableManifest = JSON.stringify(manifestFixture({ versionCode: 2 }));
        const { fetch, calls } = fakeGitHub({
            [LIST_URL(1)]: () => fakeResponse(200, { body: [
                { tag_name: 'v2.3.0', draft: true, prerelease: false, published_at: null, assets: [manifestAsset(1), { name: 'notes.txt', url: assetUrl(9) }] },
                { tag_name: 'v1.0.0', draft: false, prerelease: false, published_at: '2026-01-01T00:00:00Z', assets: [] },
            ] }),
            [LIST_URL(2)]: () => fakeResponse(200, { body: [
                { tag_name: 'v2.4.0', draft: true, prerelease: false, published_at: null, assets: [manifestAsset(3)] },
                { tag_name: 'v2.2.0', draft: false, prerelease: false, published_at: '2026-09-01T00:00:00Z', assets: [manifestAsset(2)] },
            ] }),
            [LIST_URL(3)]: () => fakeResponse(200, { body: [] }),
            [assetUrl(1)]: () => fakeResponse(200, { body: draftManifest }),
            [assetUrl(2)]: () => fakeResponse(302, { headers: { location: 'https://objects.example.test/asset?signature=private' } }),
            'https://objects.example.test/asset?signature=private': () => fakeResponse(200, { body: stableManifest }),
        });
        const entries = await fetchPreviousReleases({ repository: 'team/app', token: 'secret-token', fetch, apiUrl: API, excludeTag: 'v2.4.0', perPage: 2 });
        expect(entries).toEqual([
            { tag: 'v2.3.0', draft: true, prerelease: false, publishedAt: null, manifest: draftManifest },
            { tag: 'v2.2.0', draft: false, prerelease: false, publishedAt: '2026-09-01T00:00:00Z', manifest: stableManifest },
        ]);
        expect(calls.every(call => call.redirect === 'manual')).toBe(true);
        for (const call of calls) {
            const onApi = call.url.startsWith(`${API}/`);
            expect(call.headers.Authorization === 'Bearer secret-token').toBe(onApi);
        }
        expect(calls.find(call => call.url === assetUrl(2)).headers.Accept).toBe('application/octet-stream');
        expect(calls.some(call => call.url === assetUrl(3))).toBe(false);
        expect(decideRelease({ prerelease: false, inputsHash: HASH_B, versionCode: 4, versionName: '1.4.0', minAppVersion: 1n, runtimeLock: PINNED_LOCK, previous: entries }))
            .toMatchObject({ action: 'build', previous: { tag: 'v2.2.0' }, highestPreviousVersionCode: 3 });
    });

    test('works without a token', async () => {
        const { fetch, calls } = fakeGitHub({ [LIST_URL(1)]: () => fakeResponse(200, { body: [] }) });
        expect(await fetchPreviousReleases({ repository: 'team/app', fetch, apiUrl: API, perPage: 2 })).toEqual([]);
        expect(calls[0].headers.Authorization).toBeUndefined();
    });

    test('fails clearly on HTTP errors, unusable assets and redirects without leaking secrets', async () => {
        const failures = [
            [{ [LIST_URL(1)]: () => fakeResponse(403) }, /GET https:\/\/api\.example\.test\/repos\/team\/app\/releases failed: HTTP 403/],
            [{ [LIST_URL(1)]: () => fakeResponse(200, { body: { message: 'x' } }) }, /is not a JSON array/],
            [{ [LIST_URL(1)]: () => fakeResponse(200, { body: [{ tag_name: 'v1', assets: [manifestAsset(1, 3 * 1024 * 1024)] }] }) }, /larger than 2 MiB/],
            [{
                [LIST_URL(1)]: () => fakeResponse(200, { body: [{ tag_name: 'v1', assets: [manifestAsset(1)] }] }),
                [assetUrl(1)]: () => fakeResponse(200, { body: Buffer.from([0x7b, 0xff, 0x7d]) }),
            }, /release v1: .*not valid UTF-8/],
            [{
                [LIST_URL(1)]: () => fakeResponse(200, { body: [{ tag_name: 'v1', assets: [manifestAsset(1)] }] }),
                [assetUrl(1)]: () => fakeResponse(302, { headers: { location: 'http://objects.example.test/asset?signature=private' } }),
            }, /redirected to an unusable location/],
            [{
                [LIST_URL(1)]: () => fakeResponse(200, { body: [{ tag_name: 'v1', assets: [manifestAsset(1)] }] }),
                [assetUrl(1)]: () => fakeResponse(302, { headers: { location: 'https://objects.example.test/asset?signature=private' } }),
                'https://objects.example.test/asset?signature=private': () => fakeResponse(500),
            }, /GET https:\/\/objects\.example\.test\/asset failed: HTTP 500/],
            [{ [LIST_URL(1)]: () => fakeResponse(200, { body: [{ tag_name: 'v1', assets: [manifestAsset(1), manifestAsset(2)] }] }) }, /unusable android-update\.json asset list/],
        ];
        for (const [routes, message] of failures) {
            const { fetch } = fakeGitHub(routes);
            const failure = fetchPreviousReleases({ repository: 'team/app', token: 'secret-token', fetch, apiUrl: API, perPage: 2 });
            await expect(failure).rejects.toThrow(message);
            await expect(failure).rejects.not.toThrow(/secret-token|signature=private/);
        }
        const full = fakeGitHub({ [LIST_URL(1)]: () => fakeResponse(200, { body: [{ tag_name: 'a' }, { tag_name: 'b' }] }) });
        await expect(fetchPreviousReleases({ repository: 'team/app', fetch: full.fetch, apiUrl: API, perPage: 2, maxPages: 1 })).rejects.toThrow(/more than 2 releases/);
        await expect(fetchPreviousReleases({ repository: 'team', fetch: full.fetch })).rejects.toThrow(/owner\/name/);
        await expect(fetchPreviousReleases({ repository: 'team/app', fetch: full.fetch, apiUrl: 'http://api.example.test' })).rejects.toThrow(/must use https/);
    });
});

// The base manifest of the app's own UpdateManifestTest fixture, with both release ABIs.
function manifestText(mutate = () => {}) {
    const manifest = manifestFixture({ versionCode: 2 });
    mutate(manifest);
    return JSON.stringify(manifest);
}

const DEVICE = { abi: 'arm64-v8a', sdk: 29 };
const accepts = (text, options = DEVICE) => validateManifestText(text, options);
const rejects = (text, options = DEVICE) => expect(() => validateManifestText(text, options)).toThrow(ReleaseToolError);

describe('android-update.json validation mirrors UpdateManifest.kt', () => {
    test('accepts the fixture, selects ABIs and normalizes hashes', () => {
        const text = manifestText(manifest => {
            manifest.signingCertSha256 = SIGNER.toUpperCase().match(/../g).join(':');
            manifest.inputsHash = 'EF'.repeat(32);
            manifest.assets['armeabi-v7a'].sha256 = 'CD'.repeat(32);
            manifest.extra = { unknown: [1, 'two', null] };
        });
        const manifest = accepts(text);
        expect(manifest).toMatchObject({ versionCode: 2n, signingCert: SIGNER, inputsHash: 'ef'.repeat(32), minSdk: 29 });
        expect(accepts(text, { abi: 'armeabi-v7a', sdk: 29 }).assets['armeabi-v7a'].sha256).toBe('cd'.repeat(32));
        expect(accepts(text, {}).versionName).toBe('1.2.0');
    });

    test('requires every schema field with its exact type', () => {
        const invalid = {
            schema: ['1', true, 0, 2, null],
            versionCode: ['2', false, 0, -1, null],
            versionName: [2, true, '', ' ', '\u3000', 'a\u007f', 'x'.repeat(129), null],
            prerelease: ['false', 0, null],
            releaseTag: [2, false, '', '\t', 'x'.repeat(257), null],
            defaultRef: [2, false, 'main', 'Release', null],
            minSdk: ['29', true, 0, -1, 30, null],
            signingCertSha256: [false, 1, 'a'.repeat(63), 'gg'.repeat(32), `${SIGNER}:`, null],
            inputsHash: [false, 1, 'a'.repeat(65), 'ab:'.repeat(32), null],
            assets: [false, 'assets', {}, [], null],
            runtime: [false, 'runtime', {}, null],
        };
        for (const [field, values] of Object.entries(invalid)) {
            rejects(manifestText(manifest => delete manifest[field]));
            for (const value of values) {
                rejects(manifestText(manifest => {
                    manifest[field] = value;
                }));
            }
        }
        rejects(manifestText().replace('"minSdk":29', '"minSdk":9223372036854775807'));
        rejects(manifestText().replace('"minSdk":29', '"minSdk":2147483648'), {});
        expect(accepts(manifestText().replace('"minSdk":29', '"minSdk":2147483647'), {}).minSdk).toBe(2147483647);
    });

    test('rejects fractional, exponential, overflowing and coerced integers', () => {
        const valid = manifestText();
        for (const number of ['2.0', '2e0', '2E+1', '9223372036854775808', 'NaN', 'Infinity', '02', '+2', '-0']) {
            rejects(valid.replace('"versionCode":2', `"versionCode":${number}`));
        }
        rejects(valid.replace('"schema":1', '"schema":1.0'));
        rejects(valid.replace('"minSdk":29', '"minSdk":29.0'));
        expect(accepts(valid.replace('"versionCode":2', '"versionCode":9223372036854775807')).versionCode).toBe(9223372036854775807n);
    });

    test('validates every asset without path or ABI traversal', () => {
        for (const name of ['../update.apk', '/update.apk', 'a/b.apk', 'a\\b.apk', 'a%2fb.apk', 'a?b.apk', 'a#b.apk', 'a..b.apk', '.apk', 'a.apk.exe', 'a\u0000.apk', 'a.APK', `${'a'.repeat(193)}.apk`]) {
            rejects(manifestText(manifest => {
                manifest.assets['armeabi-v7a'].name = name;
            }));
        }
        // [A-Za-z0-9][A-Za-z0-9._-]{0,191}\.apk: at most 192 characters before ".apk".
        for (const name of [`${'a'.repeat(192)}.apk`, 'a_b-c.d.apk', '0.apk']) {
            expect(accepts(manifestText(manifest => {
                manifest.assets['armeabi-v7a'].name = name;
            }), { abi: 'armeabi-v7a', sdk: 29 }).assets['armeabi-v7a'].name).toBe(name);
        }
        rejects(manifestText(manifest => {
            manifest.assets['armeabi-v7a'].name = manifest.assets['arm64-v8a'].name;
        }));
        const extraAsset = (abi, name = 'extra.apk') => manifestText(manifest => {
            manifest.assets[abi] = { ...manifest.assets['arm64-v8a'], name };
        });
        for (const abi of ['../arm64-v8a', 'arm64/v8a', 'ARM64', '', 'a'.repeat(33), '_x', '-x']) {
            rejects(extraAsset(abi));
        }
        expect(Object.keys(accepts(extraAsset(`x86_64-${'a'.repeat(25)}`)).assets)).toHaveLength(3);
        const manyAssets = count => manifestText(manifest => {
            for (let index = 0; index < count; index++) {
                manifest.assets[`abi${index}`] = { ...manifest.assets['arm64-v8a'], name: `a${index}.apk` };
            }
        });
        expect(Object.keys(accepts(manyAssets(14)).assets)).toHaveLength(16);
        rejects(manyAssets(15));
        rejects(manifestText(manifest => {
            manifest.assets['arm64-v8a'] = 'SillyBunny-android-arm64-v8a.apk';
        }));
        rejects(manifestText(), { abi: 'x86_64', sdk: 29 });
        rejects(manifestText(), { abi: '../arm64-v8a', sdk: 29 });
    });

    test('enforces a positive bounded integer asset size and a SHA-256 hash', () => {
        for (const size of [0, -1, '12', true, MAX_APK_BYTES + 1, null]) {
            rejects(manifestText(manifest => {
                manifest.assets['arm64-v8a'].size = size;
            }));
        }
        expect(accepts(manifestText(manifest => {
            manifest.assets['arm64-v8a'].size = MAX_APK_BYTES;
        })).assets['arm64-v8a'].size).toBe(MAX_APK_BYTES);
        const valid = manifestText();
        for (const number of ['131073.0', '131073e0', '9223372036854775808']) {
            rejects(valid.replace('"size":131073', `"size":${number}`));
        }
        for (const hash of ['a'.repeat(63), 'ab:'.repeat(32), 'xx'.repeat(32), `${'ab'.repeat(32)} `]) {
            rejects(manifestText(manifest => {
                manifest.assets['arm64-v8a'].sha256 = hash;
            }));
        }
    });

    test('requires the runtime fields with a nullable bun only', () => {
        for (const field of ['node', 'git', 'bash', 'npm', 'bun']) {
            rejects(manifestText(manifest => delete manifest.runtime[field]));
        }
        for (const field of ['node', 'git', 'bash', 'npm']) {
            for (const value of [42, false, '', ' ', null]) {
                rejects(manifestText(manifest => {
                    manifest.runtime[field] = value;
                }));
            }
        }
        rejects(manifestText(manifest => {
            manifest.runtime.bun = 1;
        }));
        expect(accepts(manifestText(manifest => {
            manifest.runtime.bun = '1.3.0';
        })).runtime.bun).toBe('1.3.0');
    });

    test('rejects hostile syntax, duplicate keys, trailing data and broken Unicode', () => {
        const valid = manifestText();
        const hostile = [
            '', 'null', '[]', '"text"', '{', `/* comment */${valid}`, `${valid} {}`, `${valid} trailing`,
            valid.replace('{', '{"schema":1,'),
            valid.replace('{', '{"unknown":"raw\nnewline",'),
            `${valid.slice(0, -1)},}`,
            valid.replace('"schema"', '\'schema\''),
            valid.replace('"prerelease":false', '"prerelease":FALSE'),
            valid.replace('"versionName":"1.2.0"', '"versionName":"\\q"'),
            valid.replace('"versionName":"1.2.0"', '"versionName":"\\ud800"'),
            valid.replace('"versionName":"1.2.0"', '"versionName":"\ud800"'),
            valid.replace('{', '{"\\udc00":1,'),
            valid.replace('{', '{\f'),
            valid.replace('"schema":1', '"schema" = 1'),
            `\uFEFF${valid}`,
        ];
        for (const text of hostile) {
            rejects(text);
        }
        expect(accepts(valid.replace('"versionName":"1.2.0"', '"versionName":"\\u0031.2\\/0 \\ud83d\\ude00"')).versionName).toBe('1.2/0 \u{1f600}');
    });

    test('bounds depth, entries, values, literal length and size', () => {
        const valid = manifestText();
        const extra = value => `${valid.slice(0, -1)},"extra":${value}}`;
        expect(accepts(extra(`{"${'k'.repeat(256)}":1}`)).schema).toBe(1);
        rejects(extra(`{"${'k'.repeat(257)}":1}`));
        expect(accepts(extra(`{${Array.from({ length: 4096 }, (_, index) => `"k${index}":0`).join(',')}}`)).schema).toBe(1);
        rejects(extra(`{${Array.from({ length: 4097 }, (_, index) => `"k${index}":0`).join(',')}}`));
        accepts(extra(`${'['.repeat(31)}0${']'.repeat(31)}`));
        rejects(extra(`${'['.repeat(32)}0${']'.repeat(32)}`));
        accepts(extra(`[${Array(4096).fill('0').join(',')}]`));
        rejects(extra(`[${Array(4097).fill('0').join(',')}]`));
        const nested = count => `[${Array(count).fill(`[${Array(4096).fill('0').join(',')}]`).join(',')}]`;
        accepts(extra(nested(7)));
        rejects(extra(nested(8)));
        accepts(extra('1'.repeat(1023)));
        rejects(extra('1'.repeat(1024)));
        rejects(extra(`"${'é'.repeat(1024 * 1024)}"`));
        expect(() => validateManifestText(valid, { abi: 'arm64-v8a', sdk: 0 })).toThrow(/device SDK/);
        expect(() => parseUpdateJson(`{"a":"${'x'.repeat(2 * 1024 * 1024)}"}`)).toThrow(/larger than 2 MiB/);
    });

    test('decodes downloaded bytes like UpdateHttpClient.fetchJson', () => {
        const valid = manifestText();
        expect(validateManifestBytes(Buffer.from(valid, 'utf8'), DEVICE).versionCode).toBe(2n);
        expect(() => validateManifestBytes(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(valid)]), DEVICE)).toThrow(/strictTokens/);
        expect(() => validateManifestBytes(Buffer.from(valid.replace('1.2.0', '1.2.ÿ'), 'latin1'), DEVICE)).toThrow(/not valid UTF-8/);
        expect(() => validateManifestBytes(Buffer.alloc(2 * 1024 * 1024 + 1, 0x20), DEVICE)).toThrow(/larger than 2 MiB/);
    });

    test('applies the stable channel rules of UpdateRepository on request', () => {
        rejects(manifestText(manifest => {
            manifest.prerelease = true;
        }), { stableChannel: true });
        expect(accepts(manifestText(manifest => {
            manifest.prerelease = true;
        }), { stableChannel: false }).prerelease).toBe(true);
        const tagged = tag => manifestText(manifest => {
            manifest.releaseTag = tag;
        });
        for (const tag of ['v2.0.0:x', 'v2.0.0.lock', '.v2', 'v2.', 'v2..0', 'v@{2}', 'v 2', 'v2\u00a0', 'v2\u0085', 'v2\u2028', 'v2\ud800',
            'v2~1', 'v2^', 'v2*', 'v2[', 'v2%', 'v2?', 'v2#', 'a/b', 'a\\b', 'x'.repeat(257)]) {
            rejects(tagged(tag), { stableChannel: true });
        }
        // The parser alone accepts any short text tag; only the stable download URL needs more.
        expect(accepts(tagged('v2.0.0:x'), {}).releaseTag).toBe('v2.0.0:x');
        for (const tag of ['v2.0.0-rc.1', 'v2.0.0+build.5', 'v2_0@1', 'v2.0.0-\u00fc', 'x'.repeat(256)]) {
            expect(accepts(tagged(tag), { stableChannel: true }).releaseTag).toBe(tag);
        }
    });
});

const RUNTIME = { node: '24.22.0', bun: null, git: '2.56.0', bash: '5.3.20', npm: '11.10.0' };
const RUNTIME_VERSIONS = { node: '24.22.0', npm: '11.10.0', git: '2.56.0', bash: '5.3.20' };
const ASSETS = { 'arm64-v8a': { sha256: 'cd'.repeat(32), size: 1000 }, 'armeabi-v7a': { sha256: 'ef'.repeat(32), size: 900 } };

// A minimal ZIP writer for APK fixtures. Entries are deflated (method 8) unless they say otherwise;
// `raw` replaces the stored bytes, and `crc`/`size` override the recorded values. `beforeDirectory`
// stands in for the APK Signing Block that sits between the entries and the central directory.
function zipArchive(entries, { beforeDirectory = Buffer.alloc(0), comment = '' } = {}) {
    const records = [];
    const directory = [];
    let offset = 0;
    for (const { name, data, method = 8, flags = 0, crc, size, raw } of entries) {
        const nameBytes = Buffer.from(name, 'utf8');
        const content = Buffer.from(data);
        const stored = raw ?? (method === 8 ? deflateRawSync(content) : content);
        const fields = (header, at) => {
            header.writeUInt16LE(flags, at);
            header.writeUInt16LE(method, at + 2);
            header.writeUInt32LE(crc ?? crc32(content), at + 8);
            header.writeUInt32LE(stored.length, at + 12);
            header.writeUInt32LE(size ?? content.length, at + 16);
            header.writeUInt16LE(nameBytes.length, at + 20);
        };
        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4);
        fields(local, 6);
        const central = Buffer.alloc(46);
        central.writeUInt32LE(0x02014b50, 0);
        central.writeUInt16LE(20, 4);
        central.writeUInt16LE(20, 6);
        fields(central, 8);
        central.writeUInt32LE(offset, 42);
        records.push(local, nameBytes, stored);
        directory.push(central, nameBytes);
        offset += local.length + nameBytes.length + stored.length;
    }
    const centralDirectory = Buffer.concat(directory);
    const commentBytes = Buffer.from(comment, 'utf8');
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(entries.length, 8);
    end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(centralDirectory.length, 12);
    end.writeUInt32LE(offset + beforeDirectory.length, 16);
    end.writeUInt16LE(commentBytes.length, 20);
    return Buffer.concat([...records, beforeDirectory, centralDirectory, end, commentBytes]);
}

// An APK stand-in with the assets/runtime-manifest.json that runtime-packaging.gradle.kts writes.
function fakeApk({ versions = RUNTIME_VERSIONS, abis = ['arm64-v8a', 'armeabi-v7a'], padding = 4096, runtimeManifest, withRuntimeManifest = true } = {}) {
    const entries = [{ name: 'AndroidManifest.xml', data: randomBytes(padding), method: 0 }];
    if (withRuntimeManifest) {
        const natives = Object.fromEntries(abis.map(abi => [abi, { natives: { 'libnode.so': { sha256: '00'.repeat(32), size: 1 } } }]));
        entries.push({ name: 'assets/runtime-manifest.json', data: runtimeManifest ?? JSON.stringify({ schema: 1, versions, abis: natives }) });
    }
    return zipArchive(entries, { beforeDirectory: randomBytes(4096) });
}
const FIELDS = {
    prerelease: false,
    releaseTag: 'v2.0.0',
    inputsHash: HASH_A,
    signingCertSha256: SIGNER,
    minSdk: 29,
    versionCode: 2,
    versionName: '1.2.0',
    assets: ASSETS,
    runtime: RUNTIME,
};

function lockFixture(overrides = {}) {
    const deb = { filename: 'pool/main/x.deb', sha256: '00'.repeat(32) };
    return {
        schema: 1,
        abis: ['arm64-v8a', 'armeabi-v7a', 'x86_64'],
        termux: {
            repository: 'https://packages-cf.termux.dev/apt/termux-main',
            packages: [
                { name: 'bash', version: '5.3.20', debs: { 'arm64-v8a': deb } },
                { name: 'git', version: '2.56.0', debs: { 'arm64-v8a': deb } },
                { name: 'libcurl', version: '8.23.0', debs: { 'arm64-v8a': deb } },
            ],
        },
        node: null,
        bun: null,
        npm: null,
        ...overrides,
    };
}

describe('android-update.json generation (§5.4)', () => {
    test('builds the schema v1 manifest the app accepts on both ABIs', () => {
        const { manifest, text } = buildManifest(FIELDS);
        expect(Object.keys(manifest)).toEqual(['schema', 'versionCode', 'versionName', 'prerelease', 'releaseTag', 'defaultRef', 'minSdk',
            'signingCertSha256', 'inputsHash', 'assets', 'runtime']);
        expect(manifest).toMatchObject({ schema: 1, defaultRef: 'release', signingCertSha256: SIGNER.toUpperCase().match(/../g).join(':') });
        expect(manifest.assets).toEqual({
            'arm64-v8a': { name: 'SillyBunny-android-arm64-v8a.apk', sha256: 'cd'.repeat(32), size: 1000 },
            'armeabi-v7a': { name: 'SillyBunny-android-armeabi-v7a.apk', sha256: 'ef'.repeat(32), size: 900 },
        });
        expect(manifest.runtime).toEqual(RUNTIME);
        expect(text.endsWith('}\n')).toBe(true);
        expect(JSON.parse(text)).toEqual(manifest);
        for (const abi of ['arm64-v8a', 'armeabi-v7a']) {
            expect(validateManifestText(text, { abi, sdk: 29, stableChannel: true }).signingCert).toBe(SIGNER);
        }
        const candidate = buildManifest({ ...FIELDS, prerelease: true, releaseTag: 'v2.0.0-rc.1', defaultRef: 'staging' }).manifest;
        expect(candidate).toMatchObject({ prerelease: true, defaultRef: 'staging' });
        expect(formatSigningCert(SIGNER.toUpperCase().match(/../g).join(':').toLowerCase())).toBe(manifest.signingCertSha256);
    });

    test('rejects every input the app or the release rules would reject', () => {
        const cases = [
            [{ prerelease: 'false' }, /prerelease must be true or false/],
            [{ defaultRef: 'staging' }, /defaultRef staging does not match a stable release/],
            [{ prerelease: true, releaseTag: 'v2.0.0-rc.1', defaultRef: 'release' }, /does not match a prerelease/],
            [{ versionCode: 0 }, /versionCode must be an integer/],
            [{ versionCode: 2_100_000_001 }, /versionCode must be an integer/],
            [{ versionCode: 1.5 }, /versionCode must be an integer/],
            [{ versionName: ' ' }, /versionName must be/],
            [{ versionName: 'a\u0007' }, /versionName must be/],
            [{ versionName: 'x'.repeat(129) }, /versionName must be/],
            [{ releaseTag: '' }, /releaseTag/],
            [{ releaseTag: 'v2:0' }, /releaseTag "v2:0" cannot form/],
            [{ releaseTag: 'v2.0.0.lock' }, /releaseTag/],
            [{ releaseTag: 'v 2' }, /releaseTag/],
            [{ inputsHash: HASH_A.toUpperCase() }, /inputsHash must be 64 lowercase hex digits/],
            [{ inputsHash: 'ab' }, /inputsHash/],
            [{ minSdk: 0 }, /minSdk must be a positive integer/],
            [{ signingCertSha256: 'a'.repeat(63) }, /signing certificate SHA-256/],
            [{ assets: { 'arm64-v8a': ASSETS['arm64-v8a'] } }, /exactly arm64-v8a and armeabi-v7a, not arm64-v8a$/],
            [{ assets: { ...ASSETS, x86_64: ASSETS['arm64-v8a'] } }, /not arm64-v8a, armeabi-v7a, x86_64/],
            [{ assets: { ...ASSETS, 'arm64-v8a': { sha256: 'CD'.repeat(32), size: 1000 } } }, /arm64-v8a APK sha256/],
            [{ assets: { ...ASSETS, 'arm64-v8a': { sha256: 'cd'.repeat(32), size: 0 } } }, /arm64-v8a APK size/],
            [{ assets: { ...ASSETS, 'arm64-v8a': { sha256: 'cd'.repeat(32), size: MAX_APK_BYTES + 1 } } }, /arm64-v8a APK size/],
            [{ runtime: { ...RUNTIME, bun: '1.4.3' } }, /runtime\.bun must be null/],
            [{ runtime: { ...RUNTIME, node: '' } }, /runtime\.node/],
            [{ runtime: { ...RUNTIME, npm: null } }, /runtime\.npm/],
        ];
        for (const [override, message] of cases) {
            expect(() => buildManifest({ ...FIELDS, ...override })).toThrow(message);
        }
    });

    test('reads runtime versions from android/runtime.lock', () => {
        expect(runtimeVersionsFromLock(lockFixture(), { nodeVersion: '24.22.0', npmVersion: '11.10.0' })).toEqual(RUNTIME);
        const pinned = lockFixture({ node: { version: '24.22.0', abis: {} }, npm: { version: '11.10.0' } });
        expect(runtimeVersionsFromLock(pinned)).toEqual(RUNTIME);
        expect(runtimeVersionsFromLock(pinned, { nodeVersion: '24.22.0' })).toEqual(RUNTIME);
        // The real lock: explicit versions only for the pins it still leaves null, so this keeps passing
        // once task 4.1 pins node and npm, whatever versions it pins.
        const committed = JSON.parse(readFileSync(path.join(repoRoot, 'android', 'runtime.lock'), 'utf8'));
        const versions = runtimeVersionsFromLock(committed, {
            nodeVersion: committed.node === null ? '24.22.0' : undefined,
            npmVersion: committed.npm === null ? '11.10.0' : undefined,
        });
        expect(versions.git).toBe(committed.termux.packages.find(pin => pin.name === 'git').version);
        expect(versions.bash).toBe(committed.termux.packages.find(pin => pin.name === 'bash').version);
        expect(versions.node).toBe(committed.node === null ? '24.22.0' : committed.node.version);
        expect(versions.npm).toBe(committed.npm === null ? '11.10.0' : committed.npm.version);

        const failures = [
            [lockFixture(), { npmVersion: '11.10.0' }, /does not pin node yet; pass --node-version/],
            [lockFixture(), { nodeVersion: '24.22.0' }, /does not pin npm yet; pass --npm-version/],
            [pinned, { nodeVersion: '24.23.0' }, /--node-version 24\.23\.0 differs from node 24\.22\.0/],
            [lockFixture({ node: { digest: 'x' } }), { npmVersion: '1' }, /pins node without a "version" string/],
            [lockFixture({ bun: { version: '1.4.3' } }), { nodeVersion: '1', npmVersion: '1' }, /pins bun/],
            [lockFixture({ schema: 2 }), {}, /schema 1 lock/],
            [lockFixture({ termux: { packages: [{ name: 'bash', version: '5.3.20' }] } }), { nodeVersion: '1', npmVersion: '1' }, /exactly one Termux git package/],
            [lockFixture({ termux: { packages: [{ name: 'git', version: '1' }, { name: 'bash', version: '1' }, { name: 'bash', version: '2' }] } }),
                { nodeVersion: '1', npmVersion: '1' }, /exactly one Termux bash package/],
        ];
        for (const [lock, explicit, message] of failures) {
            expect(() => runtimeVersionsFromLock(lock, explicit)).toThrow(message);
        }
    });
});

const APKSIGNER_V3 = digest => [
    'Verifies',
    'Verified using v1 scheme (JAR signing): false',
    'Verified using v3 scheme (APK Signature Scheme v3): true',
    'Number of signers: 1',
    'V3.0 Signer: certificate DN: CN=p7 test a',
    `V3.0 Signer: certificate SHA-256 digest: ${digest}`,
    'V3.0 Signer: certificate SHA-1 digest: 5974a4fbd3a69622ef5270f705bd7dc8fbf70630',
    `V3.0 Signer: public key SHA-256 digest: ${'55'.repeat(32)}`,
    '',
].join('\n');
const APKSIGNER_TWO = [
    'Verifies',
    'Number of signers: 2',
    `V2 Signer #1: certificate SHA-256 digest: ${SIGNER}`,
    `V2 Signer #2: certificate SHA-256 digest: ${OTHER_SIGNER}`,
    '',
].join('\n');

function badging({ abi, packageName = 'io.github.sillybunnyteam.sillybunny', versionCode = 2, versionName = '1.2.0', minSdk = 29, debuggable = false, native } = {}) {
    return [
        `package: name='${packageName}' versionCode='${versionCode}' versionName='${versionName}' platformBuildVersionName='17' platformBuildVersionCode='37' compileSdkVersion='37' compileSdkVersionCodename='17'`,
        `minSdkVersion:'${minSdk}'`,
        'targetSdkVersion:\'37\'',
        'application: label=\'SillyBunny\' icon=\'res/E4.xml\'',
        ...(debuggable ? ['application-debuggable'] : []),
        `native-code: ${native ?? `'${abi}'`}`,
        '',
    ].join('\n');
}

const TOOLS = { apksigner: { command: 'apksigner', args: [] }, aapt2: { command: 'aapt2', args: ['--x'] } };
const APK_FILES = { 'arm64-v8a': '/apks/app-arm64-v8a.apk', 'armeabi-v7a': '/apks/app-armeabi-v7a.apk' };

function fakeTools({ signer = () => ({ status: 0, stdout: APKSIGNER_V3(SIGNER), stderr: '' }), badge = abi => ({ status: 0, stdout: badging({ abi }), stderr: '' }) } = {}) {
    const calls = [];
    const run = (command, args) => {
        calls.push([command, ...args]);
        const file = args.at(-1);
        const abi = file.includes('armeabi-v7a') ? 'armeabi-v7a' : 'arm64-v8a';
        return { error: null, ...(command === 'apksigner' ? signer(abi) : badge(abi)) };
    };
    return { run, calls };
}

describe('APK checks with apksigner and aapt2', () => {
    const manifest = buildManifest(FIELDS).manifest;

    test('parses real apksigner and aapt2 output', () => {
        expect(parseApksignerOutput(APKSIGNER_V3(SIGNER.toUpperCase()))).toEqual({ signerCount: 1, digests: [SIGNER] });
        expect(parseApksignerOutput(`Signer #1 certificate DN: CN=x\nSigner #1 certificate SHA-256 digest: ${SIGNER}\n`)).toEqual({ signerCount: null, digests: [SIGNER] });
        expect(parseApksignerOutput(`${APKSIGNER_V3(SIGNER)}Source Stamp Signer: certificate SHA-256 digest: ${OTHER_SIGNER}\n`).digests).toEqual([SIGNER]);
        expect(parseApksignerOutput(APKSIGNER_TWO)).toEqual({ signerCount: 2, digests: [SIGNER, OTHER_SIGNER] });
        expect(parseBadging(badging({ abi: 'arm64-v8a' }))).toEqual({
            packageName: 'io.github.sillybunnyteam.sillybunny', versionCode: '2', versionName: '1.2.0', minSdk: 29, nativeCode: ['arm64-v8a'], debuggable: false,
        });
        expect(parseBadging('package: name=\'a\' versionCode=\'1\' versionName=\'1\'\nsdkVersion:\'21\'\nnative-code: \'arm64-v8a\' \'x86_64\'\napplication-debuggable\n'))
            .toMatchObject({ minSdk: 21, nativeCode: ['arm64-v8a', 'x86_64'], debuggable: true });
    });

    test('accepts matching APKs and runs each tool on each APK', () => {
        const { run, calls } = fakeTools();
        const notes = verifyApksWithTools({ apks: APK_FILES, manifest, tools: TOOLS, run });
        expect(notes).toEqual([`apksigner and aapt2 checked 2 APKs: versionCode 2, signer ${manifest.signingCertSha256}`]);
        expect(calls).toEqual([
            ['apksigner', 'verify', '--verbose', '--print-certs', APK_FILES['arm64-v8a']],
            ['aapt2', '--x', 'dump', 'badging', APK_FILES['arm64-v8a']],
            ['apksigner', 'verify', '--verbose', '--print-certs', APK_FILES['armeabi-v7a']],
            ['aapt2', '--x', 'dump', 'badging', APK_FILES['armeabi-v7a']],
        ]);
    });

    test('rejects APKs that do not match the manifest', () => {
        const cases = [
            [{ signer: () => ({ status: 1, stdout: 'DOES NOT VERIFY\n', stderr: 'ERROR: Missing META-INF/MANIFEST.MF\n' }) }, /apksigner does not verify the arm64-v8a APK: ERROR: Missing META-INF\/MANIFEST\.MF/],
            [{ signer: () => ({ status: 0, stdout: APKSIGNER_V3(OTHER_SIGNER), stderr: '' }) }, /signed by certificate 88c7b96f/],
            [{ signer: () => ({ status: 0, stdout: APKSIGNER_TWO, stderr: '' }) }, /has 2 signers/],
            [{ signer: () => ({ status: 0, stdout: `V3.0 Signer: certificate SHA-256 digest: ${SIGNER}\nV3.1 Signer: certificate SHA-256 digest: ${OTHER_SIGNER}\n`, stderr: '' }) }, /has 2 signers/],
            [{ signer: () => ({ status: 0, stdout: 'Verifies\n', stderr: '' }) }, /has 0 signers/],
            [{ signer: abi => ({ status: 0, stdout: APKSIGNER_V3(abi === 'armeabi-v7a' ? OTHER_SIGNER : SIGNER), stderr: '' }) }, /armeabi-v7a APK is signed by certificate 88c7/],
            [{ badge: abi => ({ status: 0, stdout: badging({ abi, versionCode: 3 }), stderr: '' }) }, /versionCode 3 is not 2/],
            [{ badge: abi => ({ status: 0, stdout: badging({ abi, versionName: '1.2.1' }), stderr: '' }) }, /versionName "1\.2\.1" is not "1\.2\.0"/],
            [{ badge: abi => ({ status: 0, stdout: badging({ abi, packageName: 'io.github.sillybunnyteam.sillybunny.debug' }), stderr: '' }) }, /package io\.github\.sillybunnyteam\.sillybunny\.debug is not/],
            [{ badge: abi => ({ status: 0, stdout: badging({ abi, debuggable: true }), stderr: '' }) }, /it is debuggable/],
            [{ badge: abi => ({ status: 0, stdout: badging({ abi, minSdk: 30 }), stderr: '' }) }, /minSdk 30 is not 29/],
            [{ badge: () => ({ status: 0, stdout: badging({ abi: 'x86_64' }), stderr: '' }) }, /native code is x86_64, not arm64-v8a alone/],
            [{ badge: abi => ({ status: 0, stdout: badging({ abi, native: '\'arm64-v8a\' \'armeabi-v7a\'' }), stderr: '' }) }, /native code is arm64-v8a armeabi-v7a/],
            [{ badge: () => ({ status: 1, stdout: '', stderr: 'error: not an APK\n' }) }, /aapt2 cannot read the arm64-v8a APK: error: not an APK/],
        ];
        for (const [behaviour, message] of cases) {
            const { run } = fakeTools(behaviour);
            expect(() => verifyApksWithTools({ apks: APK_FILES, manifest, tools: TOOLS, run })).toThrow(message);
        }
    });

    test('skips a missing tool with a note, or fails in require mode', () => {
        const { run, calls } = fakeTools();
        expect(verifyApksWithTools({ apks: APK_FILES, manifest, tools: { apksigner: null, aapt2: null }, run }))
            .toEqual([expect.stringMatching(/^apksigner not found .*skipped its APK checks$/), expect.stringMatching(/^aapt2 not found/)]);
        expect(calls).toEqual([]);
        expect(verifyApksWithTools({ apks: APK_FILES, manifest, tools: { ...TOOLS, aapt2: null }, run }))
            .toEqual([expect.stringMatching(/^aapt2 not found/), expect.stringMatching(/^apksigner checked 2 APKs/)]);
        expect(() => verifyApksWithTools({ apks: APK_FILES, manifest, tools: { ...TOOLS, apksigner: null }, mode: 'require', run })).toThrow(/apksigner was not found and --verify-tools require/);
    });

    test('finds the tools in the newest SDK build-tools', () => {
        const sdk = path.join(workDir, `sdk-${++repoCount}`);
        writeFiles(sdk, {
            'build-tools/9.0.0/aapt2': '',
            'build-tools/36.0.0/aapt2': '',
            'build-tools/37.0.0/aapt2': '',
            'build-tools/37.0.0/apksigner': '',
            'build-tools/37.0.0/aapt2.exe': '',
            'build-tools/37.0.0/apksigner.bat': '',
            'build-tools/37.0.0/lib/apksigner.jar': '',
        });
        const linux = findBuildTools({ env: { ANDROID_HOME: sdk, PATH: '' }, platform: 'linux' });
        expect(linux.aapt2.path).toBe(path.join(sdk, 'build-tools', '37.0.0', 'aapt2'));
        expect(linux.apksigner).toEqual({ command: path.join(sdk, 'build-tools', '37.0.0', 'apksigner'), args: [], path: path.join(sdk, 'build-tools', '37.0.0', 'apksigner') });
        const java = path.join(workDir, 'jdk');
        const windows = findBuildTools({ env: { ANDROID_SDK_ROOT: sdk, JAVA_HOME: java }, platform: 'win32' });
        expect(windows.aapt2.path).toBe(path.join(sdk, 'build-tools', '37.0.0', 'aapt2.exe'));
        expect(windows.apksigner).toEqual({ command: path.join(java, 'bin', 'java.exe'), args: ['-jar', path.join(sdk, 'build-tools', '37.0.0', 'lib', 'apksigner.jar')], path: path.join(sdk, 'build-tools', '37.0.0', 'lib', 'apksigner.jar') });
        expect(findBuildTools({ env: { PATH: path.join(sdk, 'build-tools', '36.0.0') }, platform: 'linux' })).toEqual({
            apksigner: null,
            aapt2: { command: path.join(sdk, 'build-tools', '36.0.0', 'aapt2'), args: [], path: path.join(sdk, 'build-tools', '36.0.0', 'aapt2') },
        });
        expect(findBuildTools({ env: {}, platform: 'linux' })).toEqual({ apksigner: null, aapt2: null });
        expect(() => findBuildTools({ env: { AAPT2: path.join(sdk, 'missing') }, platform: 'linux' })).toThrow(/^aapt2 .*missing \(AAPT2\) does not exist$/);
    });

    test('fails on a configured tool it cannot run, and discovery skips such candidates', () => {
        const sdk = path.join(workDir, `sdk-${++repoCount}`);
        writeFiles(sdk, {
            'bin/apksigner.bat': '',
            'build-tools/38.0.0/apksigner.bat': '',
            'build-tools/37.0.0/apksigner.bat': '',
            'build-tools/37.0.0/lib/apksigner.jar': '',
        });
        const bat = path.join(sdk, 'bin', 'apksigner.bat');
        const jar = path.join(sdk, 'bin', 'lib', 'apksigner.jar');
        expect(() => findBuildTools({ env: {}, platform: 'win32', apksigner: bat }))
            .toThrow(`apksigner ${bat} (--apksigner) cannot be run: ${jar}, the jar it wraps, does not exist`);
        expect(() => findBuildTools({ env: { APKSIGNER: bat }, platform: 'win32' }))
            .toThrow(`apksigner ${bat} (APKSIGNER) cannot be run: ${jar}, the jar it wraps, does not exist`);
        expect(() => findBuildTools({ env: { AAPT2: sdk }, platform: 'linux' })).toThrow(`aapt2 ${sdk} (AAPT2) is not a file`);
        // The newest build-tools lacks the jar, so the next one is used; a PATH copy without it is not a tool.
        const discovered = findBuildTools({ env: { ANDROID_HOME: sdk, PATH: path.join(sdk, 'bin') }, platform: 'win32' });
        expect(discovered.apksigner.path).toBe(path.join(sdk, 'build-tools', '37.0.0', 'lib', 'apksigner.jar'));
        expect(findBuildTools({ env: { PATH: path.join(sdk, 'bin') }, platform: 'win32' }).apksigner).toBeNull();
    });

    test('generates a manifest from APK files and checks them', async () => {
        const dir = path.join(workDir, `apks-${++repoCount}`);
        const contents = { 'arm64-v8a': fakeApk({ padding: 4096 }), 'armeabi-v7a': fakeApk({ padding: 3000 }) };
        writeFiles(dir, { 'app-arm64-v8a-release.apk': contents['arm64-v8a'], 'app-armeabi-v7a-release.apk': contents['armeabi-v7a'], 'empty.apk': '' });
        const apks = { 'arm64-v8a': path.join(dir, 'app-arm64-v8a-release.apk'), 'armeabi-v7a': path.join(dir, 'app-armeabi-v7a-release.apk') };
        const sizes = { 'arm64-v8a': contents['arm64-v8a'].length, 'armeabi-v7a': contents['armeabi-v7a'].length };
        const { run } = fakeTools();
        const fields = { ...FIELDS };
        delete fields.assets;
        delete fields.runtime;
        const result = await generateManifest({ ...fields, apks, runtimeLock: lockFixture(), nodeVersion: '24.22.0', npmVersion: '11.10.0', tools: TOOLS, run });
        for (const abi of ['arm64-v8a', 'armeabi-v7a']) {
            expect(result.manifest.assets[abi]).toEqual({
                name: `SillyBunny-android-${abi}.apk`,
                sha256: createHash('sha256').update(contents[abi]).digest('hex'),
                size: sizes[abi],
            });
        }
        const runtimeNote = 'assets/runtime-manifest.json of 2 APKs matches: node 24.22.0, npm 11.10.0, git 2.56.0, bash 5.3.20, ABIs arm64-v8a, armeabi-v7a';
        expect(result.notes).toEqual([runtimeNote, expect.stringMatching(/^apksigner and aapt2 checked 2 APKs/)]);
        const skipped = await generateManifest({ ...fields, apks, runtimeLock: lockFixture(), nodeVersion: '24.22.0', npmVersion: '11.10.0', verifyTools: 'skip', run: () => {
            throw new Error('tools must not run');
        } });
        expect(skipped.text).toBe(result.text);
        expect(skipped.notes).toEqual([runtimeNote, expect.stringMatching(/--verify-tools skip/)]);

        const failures = [
            [{ apks: { 'arm64-v8a': apks['arm64-v8a'] } }, /exactly arm64-v8a and armeabi-v7a/],
            [{ apks: { ...apks, 'armeabi-v7a': path.join(dir, 'missing.apk') } }, /armeabi-v7a APK .* cannot be read: ENOENT/],
            [{ apks: { ...apks, 'armeabi-v7a': dir } }, /is not a regular file/],
            [{ apks: { ...apks, 'armeabi-v7a': path.join(dir, 'empty.apk') } }, /is 0 bytes/],
            [{ verifyTools: 'maybe' }, /--verify-tools must be auto, require, skip/],
            [{ nodeVersion: undefined }, /pass --node-version/],
        ];
        for (const [override, message] of failures) {
            await expect(generateManifest({ ...fields, apks, runtimeLock: lockFixture(), nodeVersion: '24.22.0', npmVersion: '11.10.0', tools: TOOLS, run, ...override }))
                .rejects.toThrow(message);
        }
        expect(await measureApk('arm64-v8a', apks['arm64-v8a'])).toEqual({ sha256: createHash('sha256').update(contents['arm64-v8a']).digest('hex'), size: sizes['arm64-v8a'] });

        // A re-attach checks downloaded files against the manifest they came with.
        const parsed = validateManifestText(result.text);
        expect(await checkApksAgainstManifest(parsed, apks)).toEqual(['arm64-v8a', 'armeabi-v7a']);
        writeFiles(dir, { 'same-size.apk': randomBytes(sizes['armeabi-v7a']) });
        const reattachFailures = [
            [{ ...apks, 'armeabi-v7a': path.join(dir, 'same-size.apk') },
                new RegExp(`armeabi-v7a APK .*same-size\\.apk has ${sizes['armeabi-v7a']} bytes and SHA-256 [0-9a-f]{64}; android-update\\.json lists ${sizes['armeabi-v7a']} bytes`)],
            [{ ...apks, 'arm64-v8a': apks['armeabi-v7a'] }, new RegExp(`arm64-v8a APK .* has ${sizes['armeabi-v7a']} bytes .* lists ${sizes['arm64-v8a']} bytes`)],
            [{ 'arm64-v8a': apks['arm64-v8a'] }, /must be exactly the manifest's arm64-v8a, armeabi-v7a, not arm64-v8a$/],
            [{ ...apks, x86_64: apks['arm64-v8a'] }, /not arm64-v8a, armeabi-v7a, x86_64$/],
            [{ ...apks, 'armeabi-v7a': path.join(dir, 'missing.apk') }, /cannot be read: ENOENT/],
        ];
        for (const [files, message] of reattachFailures) {
            await expect(checkApksAgainstManifest(parsed, files)).rejects.toThrow(message);
        }
    });
});

describe('the runtime that each APK bundles', () => {
    test('must be the manifest runtime, built for exactly the release ABIs', async () => {
        const dir = path.join(workDir, `runtime-${++repoCount}`);
        const files = {
            good: fakeApk(),
            node: fakeApk({ versions: { ...RUNTIME_VERSIONS, node: '24.23.0' } }),
            noNpm: fakeApk({ versions: { node: '24.22.0', git: '2.56.0', bash: '5.3.20' } }),
            x86: fakeApk({ abis: ['arm64-v8a', 'armeabi-v7a', 'x86_64'] }),
            single: fakeApk({ abis: ['armeabi-v7a'] }),
            missing: fakeApk({ withRuntimeManifest: false }),
            notJson: fakeApk({ runtimeManifest: '{"schema":1,' }),
            noAbis: fakeApk({ runtimeManifest: JSON.stringify({ schema: 1, versions: RUNTIME_VERSIONS }) }),
            notZip: randomBytes(500),
        };
        writeFiles(dir, Object.fromEntries(Object.entries(files).map(([name, bytes]) => [`${name}.apk`, bytes])));
        const apk = name => path.join(dir, `${name}.apk`);
        const manifest = buildManifest(FIELDS).manifest;
        const good = { 'arm64-v8a': apk('good'), 'armeabi-v7a': apk('good') };
        expect(checkApkRuntimeManifests(manifest, good))
            .toBe('assets/runtime-manifest.json of 2 APKs matches: node 24.22.0, npm 11.10.0, git 2.56.0, bash 5.3.20, ABIs arm64-v8a, armeabi-v7a');
        expect(readApkRuntimeManifest('arm64-v8a', apk('x86'))).toEqual({ versions: RUNTIME_VERSIONS, abis: ['arm64-v8a', 'armeabi-v7a', 'x86_64'] });
        const cases = [
            ['node', 'the armeabi-v7a APK\'s assets/runtime-manifest.json names node 24.23.0, but android-update.json would say 24.22.0'],
            ['noNpm', 'the armeabi-v7a APK\'s assets/runtime-manifest.json names no npm version, but android-update.json would say 11.10.0'],
            ['x86', 'the armeabi-v7a APK\'s assets/runtime-manifest.json describes the ABIs arm64-v8a, armeabi-v7a, x86_64, not exactly arm64-v8a, armeabi-v7a; build release APKs without -PincludeX86_64'],
            ['single', 'describes the ABIs armeabi-v7a, not exactly arm64-v8a, armeabi-v7a'],
            ['missing', `the armeabi-v7a APK ${apk('missing')} has no assets/runtime-manifest.json; release builds package it (runtime-packaging.gradle.kts)`],
            ['notJson', 'the armeabi-v7a APK\'s assets/runtime-manifest.json is not schema 1 JSON with "versions" and "abis"'],
            ['noAbis', 'is not schema 1 JSON with "versions" and "abis"'],
            ['notZip', `the armeabi-v7a APK ${apk('notZip')} cannot be read as an APK: it has no ZIP end of central directory record`],
        ];
        for (const [name, message] of cases) {
            expect(() => checkApkRuntimeManifests(manifest, { ...good, 'armeabi-v7a': apk(name) })).toThrow(message);
        }

        // Generation applies the check whatever --verify-tools says; a lock pin the APKs do not bundle fails.
        const fields = { ...FIELDS };
        delete fields.assets;
        delete fields.runtime;
        const skip = { verifyTools: 'skip', run: () => {
            throw new Error('tools must not run');
        } };
        await expect(generateManifest({ ...fields, ...skip, apks: { ...good, 'arm64-v8a': apk('x86') }, runtimeLock: lockFixture(), nodeVersion: '24.22.0', npmVersion: '11.10.0' }))
            .rejects.toThrow(/arm64-v8a APK's assets\/runtime-manifest\.json describes the ABIs arm64-v8a, armeabi-v7a, x86_64/);
        const pinned = lockFixture({ node: { version: '24.23.0' }, npm: { version: '11.10.0' } });
        await expect(generateManifest({ ...fields, ...skip, apks: good, runtimeLock: pinned }))
            .rejects.toThrow('the arm64-v8a APK\'s assets/runtime-manifest.json names node 24.22.0, but android-update.json would say 24.23.0');
        await expect(generateManifest({ ...fields, ...skip, apks: good, runtimeLock: lockFixture(), nodeVersion: '24.22.0', npmVersion: '11.19.1' }))
            .rejects.toThrow(/names npm 11\.10\.0, but android-update\.json would say 11\.19\.1/);
    });

    test('is read from the APK as a ZIP entry, stored or deflated', () => {
        const dir = path.join(workDir, `zip-${++repoCount}`);
        mkdirSync(dir, { recursive: true });
        const name = 'assets/runtime-manifest.json';
        const json = JSON.stringify({ schema: 1, versions: RUNTIME_VERSIONS, abis: {}, padding: 'abc'.repeat(3000) });
        // git archive is an independent ZIP writer: -0 stores the entries, -9 deflates them.
        const repo = makeRepo({ [name]: json, 'assets/random.bin': randomBytes(5000) });
        for (const level of ['-0', '-9']) {
            const archive = path.join(dir, `git${level}.zip`);
            git(repo, 'archive', '--format=zip', level, '-o', archive, 'HEAD');
            expect(readZipEntry(archive, name).toString('utf8')).toBe(json);
            expect(readZipEntry(archive, 'assets/random.bin')).toEqual(readFileSync(path.join(repo, 'assets', 'random.bin')));
            expect(readZipEntry(archive, 'assets/runtime-manifest.jso')).toBeNull();
        }

        const write = (file, bytes) => {
            writeFileSync(path.join(dir, file), bytes);
            return path.join(dir, file);
        };
        const entry = { name, data: json };
        const stored = write('stored.zip', zipArchive([{ name: 'a', data: 'x', method: 0 }, { ...entry, method: 0 }], { comment: 'a trailing comment', beforeDirectory: randomBytes(70_000) }));
        expect(readZipEntry(stored, name).toString('utf8')).toBe(json);
        const valid = zipArchive([entry]);
        // A copy of `valid` with some bytes changed; `mutate` receives the copy and its end record offset.
        const corrupt = mutate => {
            const bytes = Buffer.from(valid);
            mutate(bytes, bytes.length - 22);
            return bytes;
        };
        const failures = [
            [zipArchive([entry, entry]), `it has more than one ${name} entry`],
            [zipArchive([{ ...entry, flags: 1 }]), `its ${name} entry is encrypted`],
            [zipArchive([{ ...entry, crc: 1 }]), `its ${name} entry fails the size or CRC-32 check`],
            [zipArchive([{ ...entry, size: json.length + 1 }]), `its ${name} entry fails the size or CRC-32 check`],
            [zipArchive([{ ...entry, method: 12 }]), `its ${name} entry uses the unsupported compression method 12`],
            [zipArchive([{ ...entry, raw: Buffer.from([0xff, 0xff, 0xff]) }]), `its ${name} entry cannot be inflated`],
            [zipArchive([{ ...entry, data: 'x'.repeat(2 * 1024 * 1024 + 1) }]), `its ${name} entry is larger than 2 MiB`],
            [corrupt((bytes, end) => {
                bytes.writeUInt16LE(0xffff, end + 8);
                bytes.writeUInt16LE(0xffff, end + 10);
            }), 'multi-disk and ZIP64 archives are not supported'],
            [corrupt((bytes, end) => bytes.writeUInt16LE(1, end + 4)), 'multi-disk and ZIP64 archives are not supported'],
            [corrupt((bytes, end) => bytes.writeUInt32LE(0, bytes.readUInt32LE(end + 16))), 'its central directory is corrupt'],
            [corrupt(bytes => bytes.writeUInt32LE(0, 0)), `the local header of its ${name} entry is corrupt`],
            [corrupt((bytes, end) => bytes.writeUInt32LE(0x7fffffff, end + 16)), 'its central directory lies outside the file'],
            [valid.subarray(0, valid.length - 1), 'it has no ZIP end of central directory record'],
            [Buffer.alloc(0), 'it has no ZIP end of central directory record'],
        ];
        failures.forEach(([bytes, message], index) => {
            expect(() => readZipEntry(write(`bad-${index}.zip`, bytes), name)).toThrow(message);
        });
    });
});

function runNode(script, args, options = {}) {
    return spawnSync(process.execPath, [releaseScript(script), ...args], { encoding: 'utf8', env: gitEnv, ...options });
}

describe('command-line interfaces', () => {
    test('inputs-hash prints the hash or the listing and reports errors on one line', () => {
        const repo = makeRepo();
        const result = runNode('inputs-hash.mjs', ['--repo', repo, '--default-ref', 'release']);
        expect(result.status).toBe(0);
        expect(result.stdout).toBe(`${hashAt(repo, 'HEAD', 'release')}\n`);
        const listing = runNode('inputs-hash.mjs', ['--repo', repo, '--default-ref', 'release', '--commit', 'HEAD', '--list']);
        expect(listing.stdout.startsWith('sillybunny-android-inputs v2\ndefaultRef release\n')).toBe(true);
        // The six android/ files of BASE_FILES and scripts/bootstrap/install.sh.
        expect(listing.stdout.split('\0').filter(Boolean)).toHaveLength(7);
        expect(listing.stdout).toContain(' scripts/bootstrap/install.sh\0');
        const usage = runNode('inputs-hash.mjs', ['--repo', repo]);
        expect(usage.status).toBe(2);
        expect(usage.stderr).toBe('inputs-hash: --default-ref is required\n');
        const unknown = runNode('inputs-hash.mjs', ['--repo', repo, '--default-ref', 'release', '--commit', 'missing']);
        expect(unknown.status).toBe(1);
        expect(unknown.stderr).toMatch(/^inputs-hash: missing is not a commit in .*\n$/);
        expect(runNode('inputs-hash.mjs', ['--bogus']).status).toBe(2);
    });

    test('release-decision follows a release candidate, its stable release and a re-attach', () => {
        const repo = makeRepo();
        const previousFile = path.join(workDir, `previous-${++repoCount}.json`);
        writeFileSync(previousFile, '[]\n');
        const first = runNode('release-decision.mjs', ['--repo', repo, '--prerelease', 'true', '--previous', previousFile]);
        expect(first.status).toBe(0);
        const candidate = JSON.parse(first.stdout);
        expect(candidate).toMatchObject({ action: 'build', defaultRef: 'staging', versionCode: 1, versionName: '1.0.0', minAppVersion: 1, commit: git(repo, 'rev-parse', 'HEAD') });
        expect(candidate.inputsHash).toBe(hashAt(repo, 'HEAD', 'staging'));

        const candidateManifest = manifestFixture({ versionCode: 1, versionName: '1.0.0', prerelease: true, inputsHash: candidate.inputsHash, releaseTag: 'v2.0.0-rc.1' });
        writeFileSync(previousFile, JSON.stringify([releaseOf(candidateManifest)]));
        const again = JSON.parse(runNode('release-decision.mjs', ['--repo', repo, '--prerelease', 'true', '--previous', previousFile]).stdout);
        expect(again).toMatchObject({ action: 'reattach', previous: { tag: 'v2.0.0-rc.1' }, versionCode: 1 });

        const blocked = runNode('release-decision.mjs', ['--repo', repo, '--prerelease', 'false', '--previous', previousFile]);
        expect(blocked.status).toBe(1);
        expect(blocked.stdout).toBe('');
        expect(blocked.stderr).toMatch(/^release-decision: versionCode 1 in android\/app-version\.properties must be greater than 1, .*v2\.0\.0-rc\.1.*\n$/);

        writeFiles(repo, { 'android/app-version.properties': 'versionCode=2\nversionName=1.0.1\n' });
        commitAll(repo, 'bump');
        const stable = JSON.parse(runNode('release-decision.mjs', ['--repo', repo, '--prerelease', 'false', '--previous', previousFile]).stdout);
        expect(stable).toMatchObject({ action: 'build', defaultRef: 'release', versionCode: 2, previous: null, highestPreviousVersionCode: 1 });
        expect(stable.inputsHash).toBe(hashAt(repo, 'HEAD', 'release'));

        writeFiles(repo, { 'android/min-app-version': '3\n' });
        commitAll(repo, 'minimum');
        const minimum = runNode('release-decision.mjs', ['--repo', repo, '--prerelease', 'false', '--previous', previousFile]);
        expect(minimum.status).toBe(1);
        expect(minimum.stderr).toMatch(/min-app-version 3 is greater than versionCode 2/);

        expect(runNode('release-decision.mjs', ['--repo', repo, '--prerelease', 'false']).status).toBe(2);
        expect(runNode('release-decision.mjs', ['--repo', repo, '--prerelease', 'yes', '--previous', previousFile]).status).toBe(2);
        expect(runNode('release-decision.mjs', ['--repo', repo, '--prerelease', 'false', '--previous', previousFile, '--exclude-tag', 'v1']).status).toBe(2);
        writeFileSync(previousFile, '{not json');
        expect(runNode('release-decision.mjs', ['--repo', repo, '--prerelease', 'false', '--previous', previousFile]).stderr).toMatch(/is not JSON/);
    });

    test('release-decision refuses an unpinned runtime.lock unless allowed, and then never re-attaches', () => {
        const repo = makeRepo({ 'android/runtime.lock': '{"schema":1,"node":null,"npm":null}\n' });
        const previousFile = path.join(workDir, `previous-${++repoCount}.json`);
        writeFileSync(previousFile, '[]\n');
        const args = ['--repo', repo, '--prerelease', 'true', '--previous', previousFile];
        const refused = runNode('release-decision.mjs', args);
        expect(refused.status).toBe(1);
        expect(refused.stdout).toBe('');
        expect(refused.stderr).toBe('release-decision: android/runtime.lock does not pin node and npm yet, so inputsHash cannot show that the bundled node and npm payloads are unchanged; pin them, or pass --allow-unpinned-runtime to allow a build (never a re-attach)\n');

        const allowed = runNode('release-decision.mjs', [...args, '--allow-unpinned-runtime']);
        expect(allowed.status).toBe(0);
        const decision = JSON.parse(allowed.stdout);
        expect(decision).toMatchObject({ action: 'build', versionCode: 1, unpinnedRuntime: ['node', 'npm'], inputsHash: hashAt(repo, 'HEAD', 'staging') });

        // The same commit again: its inputsHash matches the release just made, but the payloads may differ.
        const candidate = manifestFixture({ versionCode: 1, versionName: '1.0.0', prerelease: true, inputsHash: decision.inputsHash });
        writeFileSync(previousFile, JSON.stringify([releaseOf(candidate)]));
        const again = runNode('release-decision.mjs', [...args, '--allow-unpinned-runtime']);
        expect(again.status).toBe(1);
        expect(again.stderr).toMatch(/^release-decision: inputsHash matches the most recent prerelease release v2\.1\.0-rc\.1, but android\/runtime\.lock does not pin node and npm, .*bump versionCode in android\/app-version\.properties to build\n$/);

        writeFiles(repo, { 'android/runtime.lock': 'not json\n' });
        commitAll(repo, 'broken lock');
        expect(runNode('release-decision.mjs', [...args, '--allow-unpinned-runtime']).stderr)
            .toMatch(/^release-decision: android\/runtime\.lock at [0-9a-f]{40} is not JSON: /);
        expect(runNode('release-decision.mjs', [...args, '--allow-unpinned-runtime=yes']).status).toBe(2);
    });

    test('update-manifest writes a manifest that its validator accepts', () => {
        const dir = path.join(workDir, `cli-${++repoCount}`);
        const arm64 = fakeApk({ padding: 2048 });
        const armv7 = fakeApk({ padding: 1024 });
        writeFiles(dir, {
            'arm64.apk': arm64,
            'armv7.apk': armv7,
            'runtime.lock': JSON.stringify(lockFixture()),
            'app-version.properties': 'versionCode=7\nversionName=1.7.0\n',
        });
        const out = path.join(dir, 'android-update.json');
        const common = ['--prerelease', 'false', '--release-tag', 'v2.1.0', '--inputs-hash', HASH_A, '--signing-cert-sha256', SIGNER,
            '--min-sdk', '29', '--apk', `arm64-v8a=${path.join(dir, 'arm64.apk')}`, '--apk', `armeabi-v7a=${path.join(dir, 'armv7.apk')}`,
            '--runtime-lock', path.join(dir, 'runtime.lock'), '--node-version', '24.22.0', '--npm-version', '11.10.0', '--verify-tools', 'skip'];
        const generated = runNode('update-manifest.mjs', [...common, '--app-version', path.join(dir, 'app-version.properties'), '--out', out]);
        expect(generated.status).toBe(0);
        expect(generated.stderr).toBe('update-manifest: assets/runtime-manifest.json of 2 APKs matches: node 24.22.0, npm 11.10.0, git 2.56.0, bash 5.3.20, ABIs arm64-v8a, armeabi-v7a\n'
            + 'update-manifest: --verify-tools skip: the APKs were not checked with apksigner or aapt2\n');
        expect(JSON.parse(readFileSync(out, 'utf8'))).toMatchObject({ versionCode: 7, versionName: '1.7.0', defaultRef: 'release', releaseTag: 'v2.1.0' });
        const printed = runNode('update-manifest.mjs', [...common, '--version-code', '7', '--version-name', '1.7.0']);
        expect(printed.stdout).toBe(readFileSync(out, 'utf8'));

        const valid = runNode('update-manifest.mjs', ['--validate', out, '--abi', 'armeabi-v7a', '--sdk', '29', '--prerelease', 'false']);
        expect(valid.status).toBe(0);
        expect(JSON.parse(valid.stdout)).toMatchObject({ valid: true, versionCode: '7', prerelease: false, abis: ['arm64-v8a', 'armeabi-v7a'] });
        const wrongChannel = runNode('update-manifest.mjs', ['--validate', out, '--prerelease', 'true']);
        expect(wrongChannel.status).toBe(1);
        expect(wrongChannel.stderr).toBe('update-manifest: android-update.json prerelease is false, expected true\n');

        // The re-attach check: the downloaded manifest and APKs of the previous release.
        const apkArgs = ['--apk', `arm64-v8a=${path.join(dir, 'arm64.apk')}`, '--apk', `armeabi-v7a=${path.join(dir, 'armv7.apk')}`];
        const reattach = runNode('update-manifest.mjs', ['--validate', out, '--prerelease', 'false', '--inputs-hash', HASH_A, ...apkArgs]);
        expect(reattach.status).toBe(0);
        expect(JSON.parse(reattach.stdout)).toMatchObject({
            inputsHash: HASH_A,
            assets: { 'arm64-v8a': 'SillyBunny-android-arm64-v8a.apk', 'armeabi-v7a': 'SillyBunny-android-armeabi-v7a.apk' },
            checkedApks: ['arm64-v8a', 'armeabi-v7a'],
        });
        const otherHash = runNode('update-manifest.mjs', ['--validate', out, '--inputs-hash', HASH_B, ...apkArgs]);
        expect(otherHash.status).toBe(1);
        expect(otherHash.stderr).toBe(`update-manifest: android-update.json inputsHash is ${HASH_A}, expected ${HASH_B}\n`);
        expect(runNode('update-manifest.mjs', ['--validate', out, '--inputs-hash', HASH_A.toUpperCase()]).status).toBe(2);
        const swapped = runNode('update-manifest.mjs', ['--validate', out, '--apk', `arm64-v8a=${path.join(dir, 'armv7.apk')}`,
            '--apk', `armeabi-v7a=${path.join(dir, 'arm64.apk')}`]);
        expect(swapped.status).toBe(1);
        expect(swapped.stderr).toMatch(new RegExp(`^update-manifest: the arm64-v8a APK .*armv7\\.apk has ${armv7.length} bytes and SHA-256 [0-9a-f]{64}; android-update\\.json lists ${arm64.length} bytes and [0-9a-f]{64}\\n$`));
        const wrongRuntime = runNode('update-manifest.mjs', [...common.map(arg => (arg === '11.10.0' ? '11.19.1' : arg)), '--version-code', '7', '--version-name', '1']);
        expect(wrongRuntime.status).toBe(1);
        expect(wrongRuntime.stderr).toBe('update-manifest: the arm64-v8a APK\'s assets/runtime-manifest.json names npm 11.10.0, but android-update.json would say 11.19.1\n');
        const partial = runNode('update-manifest.mjs', ['--validate', out, ...apkArgs.slice(0, 2)]);
        expect(partial.status).toBe(1);
        expect(partial.stderr).toBe('update-manifest: the APKs must be exactly the manifest\'s arm64-v8a, armeabi-v7a, not arm64-v8a\n');

        writeFileSync(out, readFileSync(out, 'utf8').replace('"versionCode": 7', '"versionCode": 7.0'));
        expect(runNode('update-manifest.mjs', ['--validate', out]).status).toBe(1);

        expect(runNode('update-manifest.mjs', [...common, '--default-ref', 'staging', '--version-code', '7', '--version-name', '1']).stderr)
            .toMatch(/^update-manifest: defaultRef staging does not match a stable release, which uses release\n$/);
        expect(runNode('update-manifest.mjs', [...common, '--version-code', '7']).status).toBe(2);
        expect(runNode('update-manifest.mjs', ['--validate', out, '--out', 'x']).stderr).toBe('update-manifest: --out cannot be used with --validate\n');
        expect(runNode('update-manifest.mjs', ['--validate', out, '--apk', 'arm64-v8a']).status).toBe(2);
        expect(runNode('update-manifest.mjs', [...common, '--version-code', '7', '--version-name', '1', '--apk', 'arm64-v8a=x.apk']).stderr)
            .toBe('update-manifest: --apk arm64-v8a is given twice\n');
        const oneApk = common.slice();
        oneApk.splice(oneApk.indexOf(`armeabi-v7a=${path.join(dir, 'armv7.apk')}`) - 1, 2);
        const missingAbi = runNode('update-manifest.mjs', [...oneApk, '--version-code', '7', '--version-name', '1']);
        expect(missingAbi.status).toBe(1);
        expect(missingAbi.stderr).toBe('update-manifest: release APKs must be exactly arm64-v8a and armeabi-v7a, not arm64-v8a\n');
        const missing = runNode('update-manifest.mjs', common.filter(arg => arg !== '--prerelease' && arg !== 'false'));
        expect(missing.status).toBe(2);
        expect(missing.stderr).toBe('update-manifest: --prerelease is required\n');
    });
});
