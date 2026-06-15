import { describe, expect, test } from '@jest/globals';

import { getSettingsVersion, prepareSettingsSave } from '../src/settings-version.js';

describe('settings version guard', () => {
    test('initializes unversioned settings on first guarded save', () => {
        const result = prepareSettingsSave({ username: 'User' }, { username: 'Old User' });

        expect(result).toMatchObject({ ok: true, version: 1 });
        expect(result.settings).toMatchObject({ username: 'User', _version: 1 });
    });

    test('increments when the incoming version matches disk', () => {
        const result = prepareSettingsSave({ _version: 3, username: 'User' }, { _version: 3, username: 'Old User' });

        expect(result).toMatchObject({ ok: true, version: 4 });
        expect(result.settings).toMatchObject({ username: 'User', _version: 4 });
    });

    test('rejects stale settings from another open device or tab', () => {
        const result = prepareSettingsSave({ _version: 2, username: 'Stale User' }, { _version: 3, username: 'Current User' });

        expect(result).toEqual({ ok: false, currentVersion: 3 });
    });

    test('rejects mismatched versions after restores or manual file changes', () => {
        const result = prepareSettingsSave({ _version: 5, username: 'Open Tab User' }, { _version: 3, username: 'Restored User' });

        expect(result).toEqual({ ok: false, currentVersion: 3 });
    });

    test('normalizes invalid settings versions to zero', () => {
        expect(getSettingsVersion({ _version: -1 })).toBe(0);
        expect(getSettingsVersion({ _version: 'not-a-number' })).toBe(0);
        expect(getSettingsVersion({ _version: '7' })).toBe(7);
    });
});
