import { describe, expect, test } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createSettingsSync } from '../public/scripts/sillybunny-settings-sync.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('settings sync', () => {
    test('knows no settings before the page loads or saves any', () => {
        const sync = createSettingsSync();

        expect(sync.isSynced(sync.getFingerprint('{"username":"User"}'))).toBe(false);
    });

    test('matches the same settings whatever the version and the key order', () => {
        const sync = createSettingsSync();
        sync.remember(sync.getFingerprint('{"_version":3,"username":"User","power_user":{"a":[1,{"b":2,"c":3}]}}'));

        expect(sync.isSynced(sync.getFingerprint('{"power_user":{"a":[1,{"c":3,"b":2}]},"username":"User","_version":7}'))).toBe(true);
    });

    test('finds a change in a nested value, in array order, or in the keys', () => {
        const sync = createSettingsSync();
        sync.remember(sync.getFingerprint('{"username":"User","power_user":{"a":[1,2]}}'));

        expect(sync.isSynced(sync.getFingerprint('{"username":"User","power_user":{"a":[1,3]}}'))).toBe(false);
        expect(sync.isSynced(sync.getFingerprint('{"username":"User","power_user":{"a":[2,1]}}'))).toBe(false);
        expect(sync.isSynced(sync.getFingerprint('{"username":"User","power_user":{"a":[1,2]},"theme":"dark"}'))).toBe(false);
        expect(sync.isSynced(sync.getFingerprint('{"username":"User"}'))).toBe(false);
    });

    test('keeps one remembered state per page', () => {
        const first = createSettingsSync();
        const second = createSettingsSync();
        first.remember(first.getFingerprint('{"username":"User"}'));

        expect(second.isSynced(second.getFingerprint('{"username":"User"}'))).toBe(false);
    });

    test('produces identical SHA-256 fingerprints for live objects and JSON strings including Unicode, toJSON, omitted properties, and >8 KiB buffers without mutation', () => {
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

        const fromObject = sync.getFingerprint(payload);
        const fromJson = sync.getFingerprint(JSON.stringify(payload));
        const withDifferentRootVersion = sync.getFingerprint({ ...payload, _version: 999 });
        const withDifferentNestedVersion = sync.getFingerprint({
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

    test('public/script.js hashes parsed settings on load and live payload before JSON.stringify on save', () => {
        const scriptSource = fs.readFileSync(path.join(repoRoot, 'public', 'script.js'), 'utf8');
        expect(scriptSource).toContain('settingsSync.remember(settingsSync.getFingerprint(settings));');
        const fingerprintIdx = scriptSource.indexOf('const fingerprint = settingsSync.getFingerprint(payload);');
        const stringifyIdx = scriptSource.indexOf('const body = JSON.stringify(payload);', fingerprintIdx);
        expect(fingerprintIdx).toBeGreaterThan(-1);
        expect(stringifyIdx).toBeGreaterThan(fingerprintIdx);
    });
});
