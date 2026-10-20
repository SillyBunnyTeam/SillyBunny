/* eslint-disable playwright/no-standalone-expect -- Jest test.each tables are not Playwright tests. */
import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';

const runtimeLock = JSON.parse(readFileSync(new URL('../android/runtime.lock', import.meta.url), 'utf8'));
const ABIS = ['arm64-v8a', 'armeabi-v7a', 'x86_64'];

function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
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
});
