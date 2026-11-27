/* global globalThis */
import { afterEach, describe, expect, jest, test } from '@jest/globals';
import { createHash } from 'node:crypto';

import { createSettingsSync } from '../public/scripts/sillybunny-settings-sync.js';

describe('settings sync', () => {
    test('knows no settings before the page loads or saves any', async () => {
        const sync = createSettingsSync();

        expect(sync.isSynced(await sync.getFingerprint('{"username":"User"}'))).toBe(false);
    });

    test('matches the same settings whatever the version and the key order', async () => {
        const sync = createSettingsSync();
        sync.remember(await sync.getFingerprint('{"_version":3,"username":"User","power_user":{"a":[1,{"b":2,"c":3}]}}'));

        expect(sync.isSynced(await sync.getFingerprint('{"power_user":{"a":[1,{"c":3,"b":2}]},"username":"User","_version":7}'))).toBe(true);
    });

    test('finds a change in a nested value, in array order, or in the keys', async () => {
        const sync = createSettingsSync();
        sync.remember(await sync.getFingerprint('{"username":"User","power_user":{"a":[1,2]}}'));

        expect(sync.isSynced(await sync.getFingerprint('{"username":"User","power_user":{"a":[1,3]}}'))).toBe(false);
        expect(sync.isSynced(await sync.getFingerprint('{"username":"User","power_user":{"a":[2,1]}}'))).toBe(false);
        expect(sync.isSynced(await sync.getFingerprint('{"username":"User","power_user":{"a":[1,2]},"theme":"dark"}'))).toBe(false);
        expect(sync.isSynced(await sync.getFingerprint('{"username":"User"}'))).toBe(false);
    });

    test('keeps one remembered state per page', async () => {
        const first = createSettingsSync();
        const second = createSettingsSync();
        first.remember(await first.getFingerprint('{"username":"User"}'));

        expect(second.isSynced(await second.getFingerprint('{"username":"User"}'))).toBe(false);
    });

    test('produces identical SHA-256 fingerprints for live objects and JSON strings including Unicode, toJSON, omitted properties, and >8 KiB buffers without mutation', async () => {
        const sync = createSettingsSync();
        const longUnicode = 'Reisen 🐇✨ こんにちは café — '.repeat(600);
        const payload = {
            _version: 42,
            username: 'Reisen 🐇✨ こんにちは café',
            quotes: 'line1\nline2\t"quoted"\\slash\u0007',
            longUnicode,
            nested: {
                _version: 9,
                b: [1, -0, null, true, false, undefined, () => 'ignored', Symbol('x'), NaN, Infinity],
                a: {
                    z: 'last',
                    a: 'first',
                    dropMe: undefined,
                    fn: () => {},
                    sym: Symbol('skip'),
                    custom: { toJSON: () => ({ serialized: 'ok', count: 3 }) },
                },
            },
        };
        const snapshot = structuredClone({
            _version: payload._version,
            username: payload.username,
            nestedVersion: payload.nested._version,
        });

        const fromObject = await sync.getFingerprint(payload);
        const fromJson = await sync.getFingerprint(JSON.stringify(payload));
        const withDifferentRootVersion = await sync.getFingerprint({ ...payload, _version: 999 });
        const withDifferentNestedVersion = await sync.getFingerprint({
            ...payload,
            nested: { ...payload.nested, _version: 10 },
        });

        expect(fromObject).toBe(fromJson);
        expect(fromObject).toBe(withDifferentRootVersion);
        expect(fromObject).not.toBe(withDifferentNestedVersion);
        expect(payload._version).toBe(snapshot._version);
        expect(payload.username).toBe(snapshot.username);
        expect(payload.nested._version).toBe(snapshot.nestedVersion);
    });

    test('is the SHA-256 of the sorted JSON without the root version, with its length in bytes', async () => {
        const sync = createSettingsSync();
        const canonical = '{"a":[1,{"b":2,"c":"é日本😀"}],"z":"x"}';
        const expected = `v1:${Buffer.byteLength(canonical)}:${createHash('sha256').update(canonical).digest('hex')}`;

        expect(await sync.getFingerprint('{"z":"x","_version":8,"a":[1,{"c":"é日本😀","b":2}]}')).toBe(expected);
    });

    test('hashes with crypto.subtle where the page has it', async () => {
        const sync = createSettingsSync();
        const digest = jest.spyOn(globalThis.crypto.subtle, 'digest');

        const fingerprint = await sync.getFingerprint('{"username":"User","_version":4}');

        expect(digest).toHaveBeenCalledTimes(1);
        expect(digest.mock.calls[0][0]).toBe('SHA-256');
        expect(fingerprint).toBe(`v1:19:${createHash('sha256').update('{"username":"User"}').digest('hex')}`);
        digest.mockRestore();
    });

    describe('where crypto.subtle is missing or fails', () => {
        const cryptoDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
        const settings = JSON.stringify({ _version: 2, name: 'User', big: 'Reisen 🐇 café '.repeat(2000), list: [3, 2, 1] });

        afterEach(() => {
            Object.defineProperty(globalThis, 'crypto', cryptoDescriptor);
        });

        test('gives the same fingerprint without crypto.subtle, as on a page served over plain HTTP', async () => {
            const sync = createSettingsSync();
            const native = await sync.getFingerprint(settings);

            Object.defineProperty(globalThis, 'crypto', { value: undefined, configurable: true, writable: true });
            const withoutSubtle = await sync.getFingerprint(settings);

            expect(withoutSubtle).toBe(native);
            expect(native).toMatch(/^v1:\d+:[a-f0-9]{64}$/);
        });

        test('gives the same fingerprint when crypto.subtle refuses to digest', async () => {
            const sync = createSettingsSync();
            const native = await sync.getFingerprint(settings);
            const digest = jest.fn(async () => {
                throw new Error('digest refused');
            });

            Object.defineProperty(globalThis, 'crypto', { value: { subtle: { digest } }, configurable: true, writable: true });
            const afterRefusal = await sync.getFingerprint(settings);

            expect(digest).toHaveBeenCalledTimes(1);
            expect(afterRefusal).toBe(native);
        });
    });
});
