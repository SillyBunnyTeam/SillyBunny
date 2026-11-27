/** @jest-environment jsdom */
import { afterEach, describe, expect, jest, test } from '@jest/globals';
import { importTabsModule } from './util/tabs-harness.js';

let loaded = null;

afterEach(() => {
    loaded?.cleanup();
    loaded = null;
    jest.restoreAllMocks();
});

describe('retired top bar scale keys', () => {
    test('booting the shell neither reads nor writes retired scale keys and leaves no scale CSS properties', async () => {
        window.localStorage.clear();
        window.localStorage.setItem('sb-topbar-scale-desktop', '130');
        window.localStorage.setItem('sb-topbar-scale-mobile', '80');

        const getItemSpy = jest.spyOn(Storage.prototype, 'getItem');
        const setItemSpy = jest.spyOn(Storage.prototype, 'setItem');

        loaded = await importTabsModule({ storage: null });

        const touchedScaleKeys = [
            ...getItemSpy.mock.calls.map(([key]) => key),
            ...setItemSpy.mock.calls.map(([key]) => key),
        ].filter(key => String(key).startsWith('sb-topbar-scale-'));

        expect(touchedScaleKeys).toEqual([]);
        expect(document.documentElement.style.getPropertyValue('--sb-topbar-scale-desktop')).toBe('');
        expect(document.documentElement.style.getPropertyValue('--sb-topbar-scale-mobile')).toBe('');
        expect(window.localStorage.getItem('sb-topbar-scale-desktop')).toBe('130');
        expect(window.localStorage.getItem('sb-topbar-scale-mobile')).toBe('80');
    });

    test('getTopbarScale always returns 100 and setTopbarScale is a safe no-op regardless of stored keys', async () => {
        loaded = await importTabsModule({
            storage: {
                'sb-topbar-scale-desktop': '130',
                'sb-topbar-scale-mobile': '80',
            },
        });

        expect(loaded.shell.getTopbarScale('desktop')).toBe(100);
        expect(loaded.shell.getTopbarScale('mobile')).toBe(100);

        loaded.shell.setTopbarScale('desktop', 135);
        loaded.shell.setTopbarScale('mobile', 80);

        expect(loaded.shell.getTopbarScale('desktop')).toBe(100);
        expect(loaded.shell.getTopbarScale('mobile')).toBe(100);
        expect(document.documentElement.style.getPropertyValue('--sb-topbar-scale-desktop')).toBe('');
        expect(document.documentElement.style.getPropertyValue('--sb-topbar-scale-mobile')).toBe('');
    });
});
