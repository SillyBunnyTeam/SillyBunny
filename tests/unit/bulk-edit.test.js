/** @jest-environment jsdom */
/* global globalThis */
/* eslint-disable playwright/no-standalone-expect, playwright/prefer-web-first-assertions -- Jest/jsdom assertions. */
import { jest, describe, test, expect, beforeEach, afterEach } from '@jest/globals';

let onStateChange;
const handlers = new Map();
const overlay = {
    legacyRowSelectionEnabled: false,
    addStateChangeCallback: callback => { onStateChange = callback; },
    selectState: jest.fn(), browseState: jest.fn(), updateSelectedCount: jest.fn(),
    handleContextMenuDelete: jest.fn(), toggleSingleCharacter: jest.fn(), onPageLoad: jest.fn(),
};
const chain = {
    show: jest.fn(), hide: jest.fn(), each: jest.fn(), addClass: jest.fn(), removeClass: jest.fn(), remove: jest.fn(),
};
await jest.unstable_mockModule('../../public/script.js', () => ({ characterGroupOverlay: overlay }));
await jest.unstable_mockModule('../../public/scripts/BulkEditOverlay.js', () => ({
    BulkEditOverlay: {}, BulkEditOverlayState: { select: 1, browse: 0 }, CharacterContextMenu: jest.fn(),
}));
await jest.unstable_mockModule('../../public/scripts/events.js', () => ({ event_types: {}, eventSource: { on: jest.fn() } }));
const { initBulkEdit } = await import('../../public/scripts/bulk-edit.js');

beforeEach(() => {
    jest.clearAllMocks();
    handlers.clear();
    overlay.legacyRowSelectionEnabled = false;
    globalThis.$ = selector => ({
        ...chain,
        on: (_type, handler) => { handlers.set(selector, handler); },
    });
    jest.spyOn(console, 'debug').mockImplementation(() => {});
    jest.spyOn(console, 'log').mockImplementation(() => {});
    initBulkEdit();
});

afterEach(() => {
    delete globalThis.$;
    jest.restoreAllMocks();
});

describe('legacy bulk transports', () => {
    test('all three button transports ignore clicks while the shared list owns selection', async () => {
        await handlers.get('#bulkEditButton')();
        await handlers.get('#bulkSelectAllButton')();
        await handlers.get('#bulkDeleteButton')();
        expect(overlay.selectState).not.toHaveBeenCalled();
        expect(overlay.toggleSingleCharacter).not.toHaveBeenCalled();
        expect(overlay.handleContextMenuDelete).not.toHaveBeenCalled();
        expect(chain.each).not.toHaveBeenCalled();
    });

    test('shared mode ignores select events but still cleans up legacy browse transports', () => {
        onStateChange(1);
        expect(chain.show).not.toHaveBeenCalled();
        expect(chain.each).not.toHaveBeenCalled();
        onStateChange(0);
        expect(chain.hide).toHaveBeenCalledTimes(1);
        expect(chain.remove).toHaveBeenCalledTimes(1);
    });

    test('the upstream button paths remain enabled after restoring the legacy flag', async () => {
        overlay.legacyRowSelectionEnabled = true;
        handlers.get('#bulkEditButton')();
        expect(overlay.selectState).toHaveBeenCalledTimes(1);
        expect(chain.each).toHaveBeenCalledTimes(1);
        await handlers.get('#bulkDeleteButton')();
        expect(overlay.handleContextMenuDelete).toHaveBeenCalledTimes(1);
        onStateChange(0);
    });
});
