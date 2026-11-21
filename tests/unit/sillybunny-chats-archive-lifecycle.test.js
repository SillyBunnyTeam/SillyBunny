/** @jest-environment jsdom */
/* eslint-disable playwright/no-standalone-expect, playwright/prefer-web-first-assertions -- Jest/jsdom assertions. */
/* global globalThis */
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';

const SENTINEL = new Error('openDialog reached');

await jest.unstable_mockModule('../../public/scripts/i18n.js', () => ({
    t: (strings, ...values) => strings.reduce((text, part, index) => text + part + (values[index] ?? ''), ''),
    translate: text => text,
}));
await jest.unstable_mockModule('../../public/scripts/popup.js', () => ({ Popup: class {}, POPUP_TYPE: {}, POPUP_RESULT: {} }));

const editor = '../../public/scripts/sillybunny-editor';
const realDialog = await import(`${editor}/dialog.js`);
const realListShell = await import(`${editor}/list-shell.js`);
const openDialog = jest.fn(() => {
    throw SENTINEL;
});
const loadListEditorStyles = jest.fn();
await jest.unstable_mockModule(`${editor}/dialog.js`, () => ({ ...realDialog, openDialog }));
await jest.unstable_mockModule(`${editor}/list-shell.js`, () => ({ ...realListShell, loadListEditorStyles }));

const archiveRoot = '../../public/scripts/extensions/sillybunny-chats-archive';
const uiOpenArchive = jest.fn();
const uiCloseArchive = jest.fn(async () => {});
const loadArchiveUi = jest.fn(() => ({ openArchive: uiOpenArchive, closeArchive: uiCloseArchive }));
await jest.unstable_mockModule(`${archiveRoot}/src/ui.js`, () => loadArchiveUi());

const { closeArchive, openArchive } = await import(`${archiveRoot}/src/ui/archive.js`);

const settle = () => new Promise(resolve => setTimeout(resolve, 0));
const ctx = { translate: text => text, characters: [], groups: [] };

beforeEach(() => {
    openDialog.mockClear();
    loadListEditorStyles.mockReset();
    loadListEditorStyles.mockResolvedValue(undefined);
});

describe('openArchive while its styles load', () => {
    test('opens the dialog once the styles are in', async () => {
        await expect(openArchive(ctx)).rejects.toBe(SENTINEL);
        expect(openDialog).toHaveBeenCalledTimes(1);
    });

    test('a close during the wait cancels the open before any dialog exists', async () => {
        let finishStyles;
        loadListEditorStyles.mockReturnValue(new Promise(resolve => {
            finishStyles = resolve;
        }));
        const opening = openArchive(ctx);
        await closeArchive();
        finishStyles();
        await expect(opening).resolves.toBeUndefined();
        expect(openDialog).not.toHaveBeenCalled();
    });

    test('a close that finished earlier does not stop a later open', async () => {
        await closeArchive();
        await expect(openArchive(ctx)).rejects.toBe(SENTINEL);
        expect(openDialog).toHaveBeenCalledTimes(1);
    });
});

describe('the entry point', () => {
    const BUTTON_ID = 'sbca_drawer_button';
    let entry;
    let eventSource;
    let instance = 0;

    async function freshEntry() {
        instance++;
        return import(`${archiveRoot}/index.js?instance=${instance}`);
    }

    beforeEach(async () => {
        loadArchiveUi.mockClear();
        uiOpenArchive.mockClear();
        uiCloseArchive.mockClear();
        document.body.innerHTML = '<div id="rm_buttons_container"></div>';
        eventSource = { on: jest.fn(), removeListener: jest.fn() };
        globalThis.SillyTavern = {
            getContext: () => ({ ...ctx, eventSource, eventTypes: { APP_READY: 'app_ready' } }),
        };
        entry = await freshEntry();
    });

    afterEach(async () => {
        await entry.disable();
        delete globalThis.SillyTavern;
        document.body.replaceChildren();
    });

    test('an enabled extension adds its button without loading the archive', async () => {
        await entry.enable();
        expect(document.getElementById(BUTTON_ID)).not.toBeNull();
        expect(loadArchiveUi).not.toHaveBeenCalled();
    });

    test('deactivating before the first open never imports the archive', async () => {
        await entry.enable();
        await entry.disable();
        expect(document.getElementById(BUTTON_ID)).toBeNull();
        expect(loadArchiveUi).not.toHaveBeenCalled();
        expect(uiCloseArchive).not.toHaveBeenCalled();
    });

    test('the button opens the archive from the control that was used', async () => {
        await entry.enable();
        const button = document.getElementById(BUTTON_ID);
        button.click();
        await settle();
        expect(loadArchiveUi).toHaveBeenCalledTimes(1);
        expect(uiOpenArchive).toHaveBeenCalledTimes(1);
        expect(uiOpenArchive.mock.calls[0][1]).toBe(button);
    });

    test('an open that is still importing is dropped when the extension is deactivated', async () => {
        await entry.enable();
        document.getElementById(BUTTON_ID).click();
        await entry.disable();
        await settle();
        expect(uiOpenArchive).not.toHaveBeenCalled();
    });

    test('deactivating closes an archive that is open', async () => {
        await entry.enable();
        document.getElementById(BUTTON_ID).click();
        await settle();
        await entry.disable();
        expect(uiCloseArchive).toHaveBeenCalledTimes(1);
        expect(document.getElementById(BUTTON_ID)).toBeNull();
    });
});
