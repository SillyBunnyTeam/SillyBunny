/** @jest-environment jsdom */
/* eslint-disable playwright/no-standalone-expect, playwright/prefer-web-first-assertions -- Jest/jsdom assertions. */
/* global globalThis */
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';

await jest.unstable_mockModule('../../public/scripts/i18n.js', () => ({
    t: (strings, ...values) => strings.reduce((text, part, index) => text + part + (values[index] ?? ''), ''),
    translate: text => text,
}));
await jest.unstable_mockModule('../../public/scripts/popup.js', () => ({ Popup: class {}, POPUP_TYPE: {}, POPUP_RESULT: {} }));

const { holdEditorsUntilStyled } = await import('../../public/scripts/sillybunny-editor/list-shell.js');

const finish = new Map();
const loadStylesheetAsync = jest.fn(
    (href, { id }) => new Promise((resolve, reject) => finish.set(id, { resolve, reject })),
);
const finishChrome = () => finish.get('deferred-editor-chrome-css').resolve();
const finishShell = () => finish.get('deferred-editor-shell-css').resolve();
const loadedIds = () => loadStylesheetAsync.mock.calls.map(([, { id }]) => id);

const settle = () => new Promise(resolve => setTimeout(resolve, 0));
const characterMenu = () => document.getElementById('rm_ch_create_block');
const groupMenu = () => document.getElementById('rm_group_chats_block');

/** What `selectRightMenuWithAnimation()` does to the menu it shows. */
function show(menu) {
    menu.classList.add('sb-active-right-menu');
    menu.style.display = 'block';
    menu.style.visibility = 'visible';
}

let stop;

beforeEach(() => {
    document.body.innerHTML = '<div id="rm_ch_create_block"></div><div id="rm_group_chats_block"></div>';
    finish.clear();
    loadStylesheetAsync.mockClear();
    globalThis.SillyBunnyAssets = { loadStylesheetAsync };
    stop = holdEditorsUntilStyled();
});

afterEach(() => stop());

describe('editor styles gate', () => {
    test('a menu that turns active before its sheet is ready stays invisible, even against an important rule', async () => {
        show(characterMenu());
        await settle();
        expect(characterMenu().style.getPropertyValue('visibility')).toBe('hidden');
        expect(characterMenu().style.getPropertyPriority('visibility')).toBe('important');
        expect(loadedIds()).toEqual(['deferred-editor-chrome-css']);

        finishChrome();
        await settle();
        expect(characterMenu().style.getPropertyValue('visibility')).toBe('visible');
        expect(characterMenu().style.getPropertyPriority('visibility')).toBe('');
    });

    test('showing the menu again while it is held does not show it', async () => {
        show(characterMenu());
        await settle();
        show(characterMenu());
        await settle();
        expect(characterMenu().style.getPropertyPriority('visibility')).toBe('important');
        expect(loadedIds()).toEqual(['deferred-editor-chrome-css']);
    });

    test('the group editor waits for the list shell as well', async () => {
        show(groupMenu());
        await settle();
        expect(loadedIds().sort()).toEqual(['deferred-editor-chrome-css', 'deferred-editor-shell-css']);
        finishShell();
        await settle();
        expect(groupMenu().style.getPropertyPriority('visibility')).toBe('important');
        finishChrome();
        await settle();
        expect(groupMenu().style.getPropertyValue('visibility')).toBe('visible');
    });

    test('a menu that was closed while held is not shown when the sheet arrives', async () => {
        show(characterMenu());
        await settle();
        characterMenu().classList.remove('sb-active-right-menu');
        characterMenu().style.visibility = 'hidden';
        finishChrome();
        await settle();
        expect(characterMenu().style.getPropertyValue('visibility')).toBe('hidden');
    });

    test('a failed sheet still releases the editor', async () => {
        jest.spyOn(console, 'warn').mockImplementation(() => {});
        show(characterMenu());
        await settle();
        finish.get('deferred-editor-chrome-css').reject(new Error('offline'));
        await settle();
        expect(characterMenu().style.getPropertyValue('visibility')).toBe('visible');
    });

    test('once the sheet is ready, later opens are not held', async () => {
        show(characterMenu());
        await settle();
        finishChrome();
        await settle();
        characterMenu().classList.remove('sb-active-right-menu');
        characterMenu().style.visibility = 'hidden';
        show(characterMenu());
        await settle();
        expect(characterMenu().style.getPropertyValue('visibility')).toBe('visible');
        expect(loadedIds()).toEqual(['deferred-editor-chrome-css']);
    });
});
