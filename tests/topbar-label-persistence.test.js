/** @jest-environment jsdom */
import { afterEach, describe, expect, jest, test } from '@jest/globals';
import { importTabsModule } from './util/tabs-harness.js';

let loaded = null;

afterEach(() => {
    loaded?.cleanup();
    loaded = null;
    jest.restoreAllMocks();
});

async function openLabelControls({ storage = {}, mobile = false } = {}) {
    loaded?.cleanup();
    loaded = await importTabsModule({ storage, mobile });
    loaded.shell.openTab('right', 'appearance');
    await loaded.flush();
    loaded.shell.openTab('right', 'interface');
    await loaded.flush();
    return loaded;
}

function readCheckedParts() {
    return [...document.querySelectorAll('[data-sb-topbar-label-part]')]
        .filter(el => el instanceof HTMLInputElement && el.checked)
        .map(el => el.getAttribute('data-sb-topbar-label-part'));
}

function toggleLabelPart(partId, checked) {
    const input = /** @type {HTMLInputElement} */ (document.getElementById(`sb-topbar-label-desktop-${partId}`));
    expect(input).toBeInstanceOf(HTMLInputElement);
    input.checked = checked;
    input.dispatchEvent(new Event('change', { bubbles: true }));
}

function setCustomTextInput(value) {
    const input = /** @type {HTMLInputElement} */ (document.getElementById('sb-topbar-custom-text-input'));
    expect(input).toBeInstanceOf(HTMLInputElement);
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('top bar label preference persistence', () => {
    test('retains the label parts and the custom text across reloads', async () => {
        await openLabelControls({ storage: {} });
        toggleLabelPart('ctx', true);
        toggleLabelPart('custom', true);
        setCustomTextInput('My label');

        // Re-open the shell keeping the same localStorage.
        loaded.cleanup();
        loaded = await importTabsModule({ storage: null });
        loaded.shell.openTab('right', 'appearance');
        await loaded.flush();
        loaded.shell.openTab('right', 'interface');
        await loaded.flush();

        expect(readCheckedParts()).toEqual(['ctx', 'char', 'custom']);
        expect(/** @type {HTMLInputElement} */ (document.getElementById('sb-topbar-custom-text-input')).value).toBe('My label');
    });

    test('reads the one stored list at every width, with ["char"] as the default', async () => {
        await openLabelControls({ storage: {} });
        expect(readCheckedParts()).toEqual(['char']);

        await openLabelControls({ storage: { 'sb-topbar-label-desktop-parts': '["ctx","custom"]' } });
        expect(readCheckedParts()).toEqual(['ctx', 'custom']);
    });

    test('shows the same list in the bar at 390 and at 1440', async () => {
        const storage = {
            'sb-topbar-label-desktop-parts': '["char","custom"]',
            'sb-topbar-label-mobile-part': 'ctx',
            'sb-topbar-label-custom-text': 'Pinned',
        };
        await openLabelControls({ storage, mobile: false });
        expect(readCheckedParts()).toEqual(['char', 'custom']);
        const desktopTitle = document.getElementById('sb-brand-title')?.textContent;

        await openLabelControls({ storage, mobile: true });
        expect(readCheckedParts()).toEqual(['char', 'custom']);
        expect(document.getElementById('sb-brand-title')?.textContent).toBe(desktopTitle);

        toggleLabelPart('ctx', true);
        expect(readCheckedParts()).toEqual(['ctx', 'char', 'custom']);
        loaded.setViewport({ width: 1440, height: 900 });
        expect(readCheckedParts()).toEqual(['ctx', 'char', 'custom']);
    });

    describe('migration from the phone value', () => {
        test.each([
            ['a part', 'ctx', ['ctx']],
            ['an empty value', '', []],
            ['an unknown value', 'nonsense', []],
        ])('seeds the list from %s when only the phone key exists', async (_name, phone, expected) => {
            await openLabelControls({ storage: { 'sb-topbar-label-mobile-part': phone } });

            expect(readCheckedParts()).toEqual(expected);
            expect(window.localStorage.getItem('sb-topbar-label-desktop-parts')).toBe(JSON.stringify(expected));

            window.dispatchEvent(new Event('pagehide'));
            expect(window.localStorage.getItem('sb-topbar-label-mobile-part')).toBe(phone);
        });

        test('keeps the list when both keys exist, and does not touch the phone key', async () => {
            await openLabelControls({
                storage: {
                    'sb-topbar-label-desktop-parts': '["char","ctx"]',
                    'sb-topbar-label-mobile-part': 'custom',
                },
            });

            expect(readCheckedParts()).toEqual(['ctx', 'char']);
            expect(window.localStorage.getItem('sb-topbar-label-desktop-parts')).toBe('["char","ctx"]');
            expect(window.localStorage.getItem('sb-topbar-label-mobile-part')).toBe('custom');
        });

        test('writes nothing for label keys when neither key exists', async () => {
            window.localStorage.clear();
            const setItemSpy = jest.spyOn(Storage.prototype, 'setItem');
            loaded = await importTabsModule({ storage: null });
            loaded.shell.openTab('right', 'appearance');
            await loaded.flush();
            loaded.shell.openTab('right', 'interface');
            await loaded.flush();

            const labelWrites = setItemSpy.mock.calls.filter(([key]) => String(key).startsWith('sb-topbar-label-'));
            expect(labelWrites).toEqual([]);
            expect(readCheckedParts()).toEqual(['char']);
        });

        test('never writes the phone key, and a later change to the list wins over the phone value', async () => {
            window.localStorage.clear();
            window.localStorage.setItem('sb-topbar-label-mobile-part', 'ctx');
            const setItemSpy = jest.spyOn(Storage.prototype, 'setItem');

            loaded = await importTabsModule({ storage: null });
            loaded.shell.openTab('right', 'appearance');
            await loaded.flush();
            loaded.shell.openTab('right', 'interface');
            await loaded.flush();

            toggleLabelPart('char', true);
            expect(setItemSpy.mock.calls.map(([key]) => key)).not.toContain('sb-topbar-label-mobile-part');

            loaded.cleanup();
            loaded = await importTabsModule({ storage: null });
            loaded.shell.openTab('right', 'appearance');
            await loaded.flush();
            loaded.shell.openTab('right', 'interface');
            await loaded.flush();
            expect(readCheckedParts()).toEqual(['ctx', 'char']);
        });
    });

    test('retries an unsaved choice after a transient browser storage failure instead of resetting on reload', async () => {
        await openLabelControls({ storage: {} });
        const origSetItem = Storage.prototype.setItem;
        let failOnce = true;
        jest.spyOn(Storage.prototype, 'setItem').mockImplementation(function (key, value) {
            if (failOnce && key === 'sb-topbar-label-custom-text') {
                failOnce = false;
                throw new Error('Storage unavailable');
            }
            return origSetItem.call(this, key, value);
        });

        setCustomTextInput('My label');
        expect(window.localStorage.getItem('sb-topbar-label-custom-text')).toBeNull();

        window.dispatchEvent(new Event('pagehide'));
        expect(window.localStorage.getItem('sb-topbar-label-custom-text')).toBe('My label');

        loaded.cleanup();
        loaded = await importTabsModule({ storage: null });
        loaded.shell.openTab('right', 'appearance');
        await loaded.flush();
        loaded.shell.openTab('right', 'interface');
        await loaded.flush();
        expect(/** @type {HTMLInputElement} */ (document.getElementById('sb-topbar-custom-text-input')).value).toBe('My label');
    });

    test('retries failed settings without dropping other writes or reverting a newer choice', async () => {
        await openLabelControls({ storage: {} });
        const origSetItem = Storage.prototype.setItem;
        let writable = false;
        jest.spyOn(Storage.prototype, 'setItem').mockImplementation(function (key, value) {
            if (!writable && key === 'sb-topbar-label-custom-text') {
                throw new Error('Storage unavailable');
            }
            return origSetItem.call(this, key, value);
        });

        setCustomTextInput('First label');
        toggleLabelPart('ctx', true);
        setCustomTextInput('Second label');

        expect(window.localStorage.getItem('sb-topbar-label-desktop-parts')).toBe('["ctx","char"]');
        expect(window.localStorage.getItem('sb-topbar-label-custom-text')).toBeNull();

        writable = true;
        window.dispatchEvent(new Event('pagehide'));

        expect(window.localStorage.getItem('sb-topbar-label-custom-text')).toBe('Second label');

        loaded.cleanup();
        loaded = await importTabsModule({ storage: null });
        loaded.shell.openTab('right', 'appearance');
        await loaded.flush();
        loaded.shell.openTab('right', 'interface');
        await loaded.flush();
        expect(/** @type {HTMLInputElement} */ (document.getElementById('sb-topbar-custom-text-input')).value).toBe('Second label');
    });
});
