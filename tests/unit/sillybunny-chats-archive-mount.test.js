/** @jest-environment jsdom */
/* eslint-disable playwright/no-standalone-expect, playwright/prefer-web-first-assertions -- Jest/jsdom assertions. */
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';

await jest.unstable_mockModule('../../public/scripts/i18n.js', () => ({
    t: (strings, ...values) => strings.reduce((text, part, index) => text + part + (values[index] ?? ''), ''),
    translate: text => text,
}));
await jest.unstable_mockModule('../../public/scripts/popup.js', () => ({ Popup: class {}, POPUP_TYPE: {}, POPUP_RESULT: {} }));

const editor = '../../public/scripts/sillybunny-editor';
const realListShell = await import(`${editor}/list-shell.js`);
const createListEditor = jest.fn();
await jest.unstable_mockModule(`${editor}/list-shell.js`, () => ({ ...realListShell, createListEditor }));

const archive = '../../public/scripts/extensions/sillybunny-chats-archive/src/ui';
const unbindSearch = jest.fn();
const createArchiveSelection = jest.fn();
const renderSidebar = jest.fn();
const renderList = jest.fn();
const deriveView = jest.fn();
await jest.unstable_mockModule(`${archive}/busy.js`, () => ({ stopBusyTask: jest.fn(), syncBusyControls: jest.fn() }));
await jest.unstable_mockModule(`${archive}/menus.js`, () => ({ addViewControls: jest.fn(), archiveMenuSections: jest.fn(() => []) }));
await jest.unstable_mockModule(`${archive}/list.js`, () => ({ bindListKeys: jest.fn(), deriveView, renderList }));
await jest.unstable_mockModule(`${archive}/organization-manager.js`, () => ({ buildOrganizationContent: jest.fn() }));
await jest.unstable_mockModule(`${archive}/organization-save.js`, () => ({ setOrganizationControlsEnabled: jest.fn(), updateOrganizationStatus: jest.fn() }));
await jest.unstable_mockModule(`${archive}/saved-views.js`, () => ({ commitModel: jest.fn() }));
await jest.unstable_mockModule(`${archive}/search.js`, () => ({ bindSearchField: jest.fn(() => unbindSearch) }));
await jest.unstable_mockModule(`${archive}/selection.js`, () => ({ createArchiveSelection, updateSelectionControls: jest.fn() }));
await jest.unstable_mockModule(`${archive}/sidebar.js`, () => ({ bindLocationKeys: jest.fn(), renderSidebar }));
await jest.unstable_mockModule(`${archive}/view-model.js`, () => ({ withLocation: jest.fn((model, entry) => ({ ...model, entry })) }));

const { mountArchive } = await import(`${archive}/root.js`);
const { COLLAPSE_WIDTH } = await import(`${archive}/constants.js`);

const ctx = { translate: text => text };
const settle = () => new Promise(resolve => setTimeout(resolve, 0));
let observers;
let phone;
let pagesWidth;

beforeEach(() => {
    jest.clearAllMocks();
    document.body.replaceChildren();
    observers = [];
    pagesWidth = COLLAPSE_WIDTH - 100;
    global.ResizeObserver = class {
        constructor(callback) {
            this.callback = callback;
            this.observe = jest.fn();
            this.disconnect = jest.fn();
            observers.push(this);
        }
    };
    phone = { matches: false, addEventListener: jest.fn(), removeEventListener: jest.fn() };
    window.matchMedia = jest.fn(() => phone);
    deriveView.mockReturnValue({ locations: { current: { label: 'Alice', key: 'character:alice' } } });
});

afterEach(() => {
    delete global.ResizeObserver;
});

function fakeListEditor(config) {
    const sidebar = document.createElement('div');
    const selected = document.createElement('button');
    selected.className = 'sbca-location';
    selected.setAttribute('aria-pressed', 'true');
    sidebar.append(selected);
    document.body.append(sidebar);
    config.renderList(sidebar);
    return { config, sidebar, selected, collapsed: true, isOpen: false, selectedKey: null, layout: jest.fn(), destroy: jest.fn(), deselectNow: jest.fn(), selectItem: jest.fn() };
}

function fakeDialog() {
    const root = document.createElement('dialog');
    const surface = document.createElement('div');
    const pagesNode = document.createElement('div');
    Object.defineProperty(pagesNode, 'clientWidth', { get: () => pagesWidth });
    const page = document.createElement('div');
    pagesNode.append(page);
    const body = document.createElement('div');
    const pushed = [];
    const dialog = {
        root,
        surface,
        page,
        body,
        search: null,
        isOpen: true,
        push: jest.fn(spec => {
            let close;
            const closed = new Promise(resolve => { close = resolve; });
            const handle = { spec, page: document.createElement('div'), closed, isOpen: true, forceClose: jest.fn(() => close({ response: 'back' })), close: () => close({ response: 'back' }), setTitle: jest.fn() };
            pushed.push(handle);
            return handle;
        }),
    };
    return { dialog, pushed, pagesNode };
}

function mount() {
    const { dialog, pushed, pagesNode } = fakeDialog();
    document.body.append(dialog.root, pagesNode);
    const state = { closed: false, selectedKey: null, model: {} };
    const ui = { pages: [], filterButtons: new Set(), listPage: null };
    let listEditor;
    createListEditor.mockImplementation(config => {
        listEditor = fakeListEditor(config);
        return listEditor;
    });
    createArchiveSelection.mockReturnValue({ isActive: false, exit: jest.fn(), destroy: jest.fn() });
    const cleanup = mountArchive(ctx, state, ui, dialog);
    const chooseLocation = renderSidebar.mock.calls.at(-1)[3];
    return { cleanup, state, ui, dialog, pushed, chooseLocation, get listEditor() { return listEditor; } };
}

const resizeCallback = () => observers.at(-1).callback;

describe('a failed mount', () => {
    test('releases the layout watchers and the search binding when the list editor cannot be built', () => {
        createListEditor.mockImplementation(() => {
            throw new Error('list editor failed');
        });
        const { dialog } = fakeDialog();
        const ui = { pages: [], filterButtons: new Set(), listPage: null };

        expect(() => mountArchive(ctx, { closed: false, model: {} }, ui, dialog)).toThrow('list editor failed');

        expect(observers).toHaveLength(1);
        expect(observers[0].disconnect).toHaveBeenCalledTimes(1);
        const [type, handler] = phone.addEventListener.mock.calls[0];
        expect(phone.removeEventListener).toHaveBeenCalledWith(type, handler);
        expect(unbindSearch).toHaveBeenCalledTimes(1);
    });

    test('also destroys the list editor and the selection when a later step throws', () => {
        const selection = { isActive: false, exit: jest.fn(), destroy: jest.fn() };
        createArchiveSelection.mockReturnValue(selection);
        let listEditor;
        createListEditor.mockImplementation(config => {
            listEditor = fakeListEditor(config);
            return listEditor;
        });
        renderList.mockImplementationOnce(() => {
            throw new Error('first render failed');
        });
        const { dialog } = fakeDialog();
        const ui = { pages: [], filterButtons: new Set(), listPage: null };

        expect(() => mountArchive(ctx, { closed: false, model: {} }, ui, dialog)).toThrow('first render failed');

        expect(observers[0].disconnect).toHaveBeenCalledTimes(1);
        expect(phone.removeEventListener).toHaveBeenCalledTimes(1);
        expect(selection.destroy).toHaveBeenCalledTimes(1);
        expect(listEditor.destroy).toHaveBeenCalledTimes(1);
    });

    test('a successful mount releases the same things only through the returned cleanup', () => {
        const mounted = mount();

        expect(observers[0].disconnect).not.toHaveBeenCalled();
        expect(phone.removeEventListener).not.toHaveBeenCalled();
        mounted.cleanup();

        expect(observers[0].disconnect).toHaveBeenCalledTimes(1);
        expect(phone.removeEventListener).toHaveBeenCalledTimes(1);
        expect(unbindSearch).toHaveBeenCalledTimes(1);
        expect(mounted.listEditor.destroy).toHaveBeenCalledTimes(1);
    });
});

describe('the layout watchers', () => {
    test('watch the shared phone query', () => {
        mount();

        expect(window.matchMedia).toHaveBeenCalledWith('(max-width: 768px)');
    });

    test('treat the collapse width itself as wide and one pixel less as collapsed, as the list editor does', async () => {
        const mounted = mount();
        mounted.chooseLocation({ type: 'character', value: 'alice' });
        expect(mounted.pushed).toHaveLength(1);

        pagesWidth = COLLAPSE_WIDTH - 1;
        resizeCallback()();
        expect(mounted.pushed[0].forceClose).not.toHaveBeenCalled();

        pagesWidth = COLLAPSE_WIDTH;
        resizeCallback()();
        expect(mounted.pushed[0].forceClose).toHaveBeenCalledTimes(1);
        await settle();
    });

    test('never call the list page wide on a phone viewport, whatever the width', () => {
        const mounted = mount();
        mounted.chooseLocation({ type: 'character', value: 'alice' });
        phone.matches = true;
        pagesWidth = COLLAPSE_WIDTH * 3;

        resizeCallback()();

        expect(mounted.pushed[0].forceClose).not.toHaveBeenCalled();
    });
});

describe('the focus that follows widening', () => {
    async function widen(mounted) {
        pagesWidth = COLLAPSE_WIDTH + 200;
        resizeCallback()();
        await settle();
    }

    test('moves to the selected location once the split view reports its layout', async () => {
        const mounted = mount();
        mounted.chooseLocation({ type: 'character', value: 'alice' });
        await widen(mounted);
        expect(mounted.ui.listPage).toBeNull();
        expect(mounted.ui.splitFocusPending).toBe(true);

        mounted.listEditor.collapsed = false;
        mounted.listEditor.isOpen = true;
        mounted.listEditor.selectedKey = 'character:alice';
        mounted.listEditor.config.onCollapseChange(false);
        await settle();

        expect(mounted.ui.splitFocusPending).toBe(false);
        expect(document.activeElement).toBe(mounted.listEditor.selected);
    });

    test('is dropped when a list page that the layout did not close goes away', async () => {
        const mounted = mount();
        mounted.chooseLocation({ type: 'character', value: 'alice' });
        await widen(mounted);
        expect(mounted.ui.splitFocusPending).toBe(true);

        pagesWidth = COLLAPSE_WIDTH - 100;
        mounted.chooseLocation({ type: 'character', value: 'alice' });
        expect(mounted.pushed).toHaveLength(2);
        expect(mounted.ui.splitFocusPending).toBe(false);

        mounted.ui.splitFocusPending = true;
        mounted.pushed[1].close();
        await settle();

        expect(mounted.ui.listPage).toBeNull();
        expect(mounted.ui.splitFocusPending).toBe(false);
    });

    test('a collapse change that arrives after a Back does not steal focus', async () => {
        const mounted = mount();
        mounted.chooseLocation({ type: 'character', value: 'alice' });
        await widen(mounted);
        pagesWidth = COLLAPSE_WIDTH - 100;
        mounted.chooseLocation({ type: 'character', value: 'alice' });
        mounted.pushed[1].close();
        await settle();
        const elsewhere = document.createElement('button');
        document.body.append(elsewhere);
        elsewhere.focus();

        mounted.listEditor.collapsed = false;
        mounted.listEditor.config.onCollapseChange(false);
        await settle();

        expect(document.activeElement).toBe(elsewhere);
    });
});
