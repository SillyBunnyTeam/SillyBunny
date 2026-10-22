/* eslint-disable playwright/no-standalone-expect -- Jest test.each tables are not Playwright tests. */
import { describe, expect, test } from '@jest/globals';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const runtimeLock = JSON.parse(readFileSync(new URL('../android/runtime.lock', import.meta.url), 'utf8'));
const ABIS = ['arm64-v8a', 'armeabi-v7a', 'x86_64'];
const NODE_PATCHES = new URL('../android/runtime/patches/node/', import.meta.url);

function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sha256(contents) {
    return createHash('sha256').update(contents).digest('hex');
}

function versionAtLeast(version, minimum) {
    const parts = version.split('.').map(Number);
    for (let index = 0; index < minimum.length; index++) {
        if (parts[index] !== minimum[index]) {
            return parts[index] > minimum[index];
        }
    }
    return true;
}

describe('Android runtime lock', () => {
    test('uses schema version 1', () => {
        expect(isObject(runtimeLock)).toBe(true);
        expect(runtimeLock.schema).toBe(1);
    });

    test('lists exactly the three supported ABIs without duplicates', () => {
        expect(Array.isArray(runtimeLock.abis)).toBe(true);
        expect(runtimeLock.abis).toHaveLength(ABIS.length);
        expect(new Set(runtimeLock.abis).size).toBe(ABIS.length);
        expect([...runtimeLock.abis].sort()).toEqual([...ABIS].sort());
    });

    test('pins the Termux main repository, suite and component', () => {
        expect(isObject(runtimeLock.termux)).toBe(true);
        expect(runtimeLock.termux).toMatchObject({
            repository: 'https://packages-cf.termux.dev/apt/termux-main',
            suite: 'stable',
            component: 'main',
        });
    });

    test('pins a nonempty package list with unique names and nonempty versions', () => {
        const packages = runtimeLock.termux.packages;
        expect(Array.isArray(packages)).toBe(true);
        expect(packages.length).toBeGreaterThan(0);

        for (const pkg of packages) {
            expect(isObject(pkg)).toBe(true);
            expect(typeof pkg.name).toBe('string');
            expect(pkg.name.trim()).not.toBe('');
            expect(typeof pkg.version).toBe('string');
            expect(pkg.version.trim()).not.toBe('');
        }

        expect(new Set(packages.map(pkg => pkg.name)).size).toBe(packages.length);
    });

    test.each(ABIS)('pins a safe .deb filename and SHA256 for every %s package', abi => {
        const packages = runtimeLock.termux.packages;
        expect(Array.isArray(packages)).toBe(true);
        expect(packages.length).toBeGreaterThan(0);

        for (const pkg of packages) {
            expect(isObject(pkg.debs)).toBe(true);
            const deb = pkg.debs[abi];
            expect(isObject(deb)).toBe(true);
            expect(deb.filename).toMatch(/^pool\/(?:[A-Za-z0-9_+~:.-]+\/)*[A-Za-z0-9_+~:.-]+\.deb$/);
            expect(deb.filename).toBe(deb.filename.trim());
            expect(deb.filename.split('/')).not.toContain('.');
            expect(deb.filename.split('/')).not.toContain('..');
            expect(deb.sha256).toMatch(/^[a-f0-9]{64}$/i);
            expect(deb.sha256).toHaveLength(64);
        }
    });

    test.each(['node', 'bun', 'npm'])('keeps %s metadata null or a JSON object', section => {
        const metadata = runtimeLock[section];
        expect(metadata === null || isObject(metadata)).toBe(true);
    });

    test('pins Node by source tarball, NDK, API level and ICU mode', () => {
        const node = runtimeLock.node;
        expect(Object.keys(node).sort()).toEqual(['api', 'binaries', 'icu', 'ndk', 'patchSet', 'source', 'version']);
        expect(node.version).toMatch(/^\d+\.\d+\.\d+$/);
        expect(node.source).toEqual({
            repository: 'https://github.com/nodejs/node.git',
            tag: `v${node.version}`,
            commit: expect.stringMatching(/^[0-9a-f]{40}$/),
            tarball: `node-v${node.version}.tar.xz`,
            tarballSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        });
        expect(node.ndk).toEqual({
            revision: expect.stringMatching(/^\d+\.\d+\.\d+$/),
            url: expect.stringMatching(/^https:\/\/dl\.google\.com\/android\/repository\/android-ndk-r\d+[a-z]?-linux\.zip$/),
            size: expect.any(Number),
            sha1: expect.stringMatching(/^[0-9a-f]{40}$/),
            sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        });
        expect(Number.isInteger(node.ndk.size) && node.ndk.size > 0).toBe(true);
        expect(node.api).toBe(29);
        expect(node.icu).toBe('full-icu');
    });

    test('derives the Node patch-set hash from the series files in order', () => {
        const { patchSet } = runtimeLock.node;
        expect(patchSet.directory).toBe('android/runtime/patches/node');
        const series = readFileSync(new URL('series', NODE_PATCHES), 'utf8').split('\n').filter(line => line !== '' && !line.startsWith('#'));
        expect(patchSet.series).toEqual(series);
        // GNU `sha256sum --text` output for the series files, hashed again (S2.1 §6).
        const listing = series.map(name => `${sha256(readFileSync(new URL(name, NODE_PATCHES)))}  ${name}\n`).join('');
        expect(patchSet.sha256).toBe(sha256(listing));
    });

    test.each(ABIS)('names the %s Node artifact by version and patch set, with publish fields null or pinned together', abi => {
        const { version, patchSet, binaries } = runtimeLock.node;
        expect(Object.keys(binaries).sort()).toEqual([...ABIS].sort());
        const binary = binaries[abi];
        expect(Object.keys(binary).sort()).toEqual(['digest', 'repository', 'sha256', 'size', 'tag']);
        expect(binary.repository).toBe('ghcr.io/sillybunnyteam/sillybunny-android-runtime');
        expect(binary.tag).toBe(`node-${version}-${patchSet.sha256.slice(0, 12)}-${abi}`);
        const published = [binary.digest, binary.sha256, binary.size];
        if (published.every(value => value === null)) {
            return;
        }
        expect(binary.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
        expect(binary.sha256).toMatch(/^[0-9a-f]{64}$/);
        expect(Number.isInteger(binary.size) && binary.size > 0).toBe(true);
    });

    test('takes npm 11.10.0 or newer from the Node source', () => {
        expect(runtimeLock.npm).toEqual({ version: expect.stringMatching(/^\d+\.\d+\.\d+$/), source: 'node' });
        expect(versionAtLeast(runtimeLock.npm.version, [11, 10, 0])).toBe(true);
    });
});
