import { describe, expect, test } from '@jest/globals';

import { createSettingsSync } from '../public/scripts/sillybunny-settings-sync.js';

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
});
