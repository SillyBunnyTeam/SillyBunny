/** @jest-environment jsdom */
/* global globalThis */
/* eslint-disable playwright/no-standalone-expect, playwright/prefer-web-first-assertions -- Jest/jsdom assertions. */
// Page chains: Close on a Popup or openDialog page closes the chain one level at a time, through each
// level's own close path, and stops at the first level that refuses.
import { jest, describe, test, expect, beforeAll, beforeEach, afterEach } from '@jest/globals';
import fs from 'node:fs';

await jest.unstable_mockModule('../../public/lib/dialog-polyfill.esm.js', () => ({
    default: { registerDialog: jest.fn(), reposition: jest.fn() },
}));
await jest.unstable_mockModule('../../public/scripts/RossAscends-mods.js', () => ({
    shouldSendOnEnter: () => true,
}));
await jest.unstable_mockModule('../../public/scripts/i18n.js', () => ({
    t: (strings, ...values) => strings.reduce((text, part, index) => text + part + (values[index] ?? ''), ''),
    translate: text => text,
}));
await jest.unstable_mockModule('../../public/scripts/power-user.js', () => ({
    power_user: { never_resize_avatars: false },
    toastPositionClasses: ['toast-top-center'],
}));
await jest.unstable_mockModule('../../public/scripts/sillybunny-action-menu.js', () => ({
    closeActionMenu: jest.fn(),
    openActionMenu: jest.fn(),
}));
await jest.unstable_mockModule('../../public/scripts/sillybunny-editor/picker.js', () => ({
    closePicker: jest.fn(),
}));
await jest.unstable_mockModule('../../public/scripts/utils.js', () => ({
    clamp: (value, min, max) => Math.min(Math.max(value, min), max),
    removeFromArray: (array, item) => {
        const index = array.indexOf(item);
        if (index >= 0) array.splice(index, 1);
        return index >= 0;
    },
    runAfterAnimation: (control, callback) => callback(control),
    uuidv4: (() => {
        let next = 0;
        return () => `chain-popup-${++next}`;
    })(),
}));

const { Popup, POPUP_TYPE, POPUP_RESULT } = await import('../../public/scripts/popup.js');
const { openDialog } = await import('../../public/scripts/sillybunny-editor/dialog.js');
const { closeChain, coverSurface, registerChainLevel, unregisterChainLevel } = await import('../../public/scripts/sillybunny-editor/page-chain.js');

const settle = async () => { for (let index = 0; index < 30; index++) await Promise.resolve(); };
const templateHtml = fs.readFileSync(new URL('../../public/index.html', import.meta.url), 'utf8')
    .match(/<template id="popup_template"[\s\S]*?<\/template>/)[0];

const media = { sheet: false };
const openDialogs = () => [...document.querySelectorAll('dialog[open]')];
const chainClose = popup => popup.dlg.querySelector('.sb-dialog__chain-close');

/**
 * Shows a framed Popup. DISPLAY popups have no responses, so as pages they get Back and Close.
 * @param {object} [options]
 */
async function showPopup({ type = POPUP_TYPE.DISPLAY, tier = 'dialog', ...options } = {}) {
    const popup = new Popup('<p>Body</p>', type, '', { tier, title: 'Level', ...options });
    const result = popup.show();
    await settle();
    return { popup, result };
}

beforeAll(() => {
    // jsdom does not reflect `inert`, and the chain relies on it to cover a parent.
    Object.defineProperty(HTMLElement.prototype, 'inert', {
        configurable: true,
        get() { return this.hasAttribute('inert'); },
        set(value) { this.toggleAttribute('inert', Boolean(value)); },
    });
    HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
    HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); };
    globalThis.jQuery = class FakeJQuery {};
    globalThis.$ = () => ({ append() {}, cropper() {}, data() {} });
    globalThis.toastr = { options: { positionClass: 'toast-top-center' }, warning: jest.fn() };
    window.matchMedia = () => ({ matches: media.sheet, addEventListener() {}, removeEventListener() {} });
});

beforeEach(() => {
    media.sheet = false;
    document.body.innerHTML = templateHtml;
    Popup.util.lastResult = null;
});

afterEach(async () => {
    for (const popup of [...Popup.util.popups]) popup.onClosing = null;
    for (const popup of [...Popup.util.popups].reverse()) await popup.completeCancelled();
    for (const host of document.querySelectorAll('.sb-dialog-host')) host.remove();
    Popup.util.popups.length = 0;
    document.body.replaceChildren();
});

describe('Popup child page header', () => {
    test('an immediate-apply page has Back and Close, and a page with responses keeps Cancel and OK only', async () => {
        const root = await showPopup({ type: POPUP_TYPE.CONFIRM });
        const display = await showPopup();
        const back = display.popup.closeButton;
        expect(display.popup.dlg.classList.contains('sb-dialog--page')).toBe(true);
        expect(back.classList.contains('sb-dialog__back')).toBe(true);
        expect(back.getAttribute('aria-label')).toBe('Back');
        expect(chainClose(display.popup).getAttribute('aria-label')).toBe('Close');
        expect(chainClose(display.popup).parentElement).toBe(display.popup.dlg.querySelector('.sb-dialog__header'));
        const confirm = await showPopup({ type: POPUP_TYPE.CONFIRM });
        expect(confirm.popup.dlg.classList.contains('sb-dialog--page')).toBe(true);
        expect(chainClose(confirm.popup)).toBeNull();
        expect(root.popup.dlg.classList.contains('sb-dialog--page')).toBe(false);
        expect(chainClose(root.popup)).toBeNull();
    });

    test('a root Popup keeps one plain Close', async () => {
        const root = await showPopup();
        expect(chainClose(root.popup)).toBeNull();
        expect(root.popup.closeButton.classList.contains('sb-dialog__back')).toBe(false);
    });

    test('Back completes only the child with its button result, as before', async () => {
        const root = await showPopup();
        const child = await showPopup();
        child.popup.closeButton.click();
        await settle();
        expect(await child.result).toBe(POPUP_RESULT.NEGATIVE);
        expect(root.popup.dlg.hasAttribute('open')).toBe(true);
        expect(root.popup.dlg.inert).toBe(false);
    });
});

describe('Close on a Popup chain', () => {
    test('a grandchild Close closes all three and each Popup resolves with its cancel result', async () => {
        const order = [];
        const levels = [];
        for (const name of ['root', 'middle', 'top']) {
            levels.push(await showPopup({ onClosing: () => { order.push(name); return true; } }));
        }
        chainClose(levels[2].popup).click();
        await settle();
        expect(order).toEqual(['top', 'middle', 'root']);
        expect(await Promise.all(levels.map(level => level.result))).toEqual([null, null, null]);
        expect(openDialogs()).toHaveLength(0);
        expect(Popup.util.popups).toHaveLength(0);
    });

    test('cancel results use the INPUT contract: null for a cancelled input popup', async () => {
        const root = await showPopup({ type: POPUP_TYPE.INPUT });
        const child = await showPopup();
        chainClose(child.popup).click();
        await settle();
        expect(await root.result).toBeNull();
        expect(await child.result).toBeNull();
    });

    test('a parent without a Close button of its own gets the cancel result, not a button result', async () => {
        const root = await showPopup({ type: POPUP_TYPE.CONFIRM });
        const child = await showPopup();
        expect(root.popup.closeButton.style.display).toBe('none');
        chainClose(child.popup).click();
        await settle();
        expect(await root.result).toBeNull();
        expect(root.popup.result).toBe(POPUP_RESULT.CANCELLED);
        expect(Popup.util.lastResult.result).toBe(POPUP_RESULT.CANCELLED);
    });

    test('a parent with allowEscapeClose false is closed with the cancel result through its own onClosing', async () => {
        const onClosing = jest.fn(() => true);
        const root = await showPopup({ allowEscapeClose: false, onClosing });
        const child = await showPopup();
        chainClose(child.popup).click();
        await settle();
        expect(onClosing).toHaveBeenCalledTimes(1);
        expect(await root.result).toBeNull();
    });

    test('a parent veto stops the walk and leaves the parent open and interactive', async () => {
        const onClosing = jest.fn(() => false);
        const root = await showPopup({ onClosing });
        const child = await showPopup();
        chainClose(child.popup).click();
        await settle();
        expect(await child.result).toBeNull();
        expect(onClosing).toHaveBeenCalledTimes(1);
        expect(root.popup.dlg.hasAttribute('open')).toBe(true);
        expect(root.popup.dlg.inert).toBe(false);
        expect(root.popup.dlg.hasAttribute('data-sb-covered')).toBe(false);
        expect(root.popup.result).toBeUndefined();
        expect(root.popup.value).toBeUndefined();
        expect(root.popup.onClosing).toBe(onClosing);
        onClosing.mockImplementation(() => true);
        await root.popup.completeCancelled();
        expect(onClosing).toHaveBeenCalledTimes(2);
        expect(await root.result).toBeNull();
    });

    test('while a child onClosing is pending the parent does not start closing, and a refusal closes nothing', async () => {
        let release;
        const childClosing = jest.fn(() => new Promise(resolve => { release = resolve; }));
        const parentClosing = jest.fn(() => true);
        const root = await showPopup({ onClosing: parentClosing });
        const child = await showPopup({ onClosing: childClosing });
        chainClose(child.popup).click();
        await settle();
        expect(childClosing).toHaveBeenCalledTimes(1);
        expect(parentClosing).not.toHaveBeenCalled();
        expect(root.popup.dlg.hasAttribute('open')).toBe(true);
        chainClose(child.popup).click();
        await settle();
        expect(childClosing).toHaveBeenCalledTimes(1);
        release(false);
        await settle();
        expect(parentClosing).not.toHaveBeenCalled();
        expect(openDialogs()).toHaveLength(2);
        expect(child.popup.dlg.inert).toBe(false);
        expect(root.popup.dlg.inert).toBe(true);
        expect(child.popup.result).toBeUndefined();
        expect(Popup.util.lastResult).toBeNull();
        childClosing.mockImplementation(() => true);
        chainClose(child.popup).click();
        await settle();
        expect(openDialogs()).toHaveLength(0);
        expect(await Promise.all([root.result, child.result])).toEqual([null, null]);
    });

    test('when the middle level refuses, the levels above it close and it and those below stay open', async () => {
        // The result that is current when the refusal happens belongs to the level above, which has closed.
        let resultBeforeRefusal;
        const middleClosing = jest.fn(() => {
            resultBeforeRefusal = Popup.util.lastResult;
            return false;
        });
        const rootClosing = jest.fn(() => true);
        const root = await showPopup({ onClosing: rootClosing });
        const middle = await showPopup({ onClosing: middleClosing });
        const top = await showPopup();
        chainClose(top.popup).click();
        await settle();
        expect(await top.result).toBeNull();
        expect(resultBeforeRefusal.result).toBe(POPUP_RESULT.CANCELLED);
        expect(Popup.util.lastResult).toBe(resultBeforeRefusal);
        expect(openDialogs()).toEqual([root.popup.dlg, middle.popup.dlg]);
        expect(middle.popup.result).toBeUndefined();
        expect(middle.popup.value).toBeUndefined();
        expect(middle.popup.onClosing).toBe(middleClosing);
        expect(rootClosing).not.toHaveBeenCalled();
        expect(middle.popup.dlg.inert).toBe(false);
        expect(root.popup.dlg.inert).toBe(true);
        middleClosing.mockImplementation(() => true);
        chainClose(middle.popup).click();
        await settle();
        expect(middleClosing).toHaveBeenCalledTimes(2);
        expect(openDialogs()).toHaveLength(0);
        expect(await Promise.all([root.result, middle.result])).toEqual([null, null]);
    });

    test('Close on a chain root closes only the root', async () => {
        const root = await showPopup({ type: POPUP_TYPE.CONFIRM });
        root.popup.cancelButton.click();
        await settle();
        expect(await root.result).toBe(POPUP_RESULT.NEGATIVE);
    });
});

describe('openDialog over a framed Popup', () => {
    test('opens as a page over the Popup and Back returns focus to the opener inside it', async () => {
        const root = await showPopup({ type: POPUP_TYPE.CONFIRM, tier: 'window' });
        const opener = root.popup.okButton;
        opener.focus();
        const dialog = openDialog({ title: 'Page', content: document.createElement('p') });
        expect(document.querySelectorAll('.sb-dialog-host')).toHaveLength(1);
        expect(dialog.surface.classList.contains('sb-dialog--page')).toBe(true);
        expect(dialog.root.dataset.presentation).toBe('floating');
        expect(dialog.root.querySelector('.sb-dialog-scrim').hidden).toBe(true);
        expect(root.popup.dlg.inert).toBe(true);
        expect(root.popup.dlg.hasAttribute('data-sb-covered')).toBe(true);
        expect(dialog.headerStart.querySelector('.sb-dialog__back')).not.toBeNull();
        expect(dialog.headerEnd.querySelector('.sb-dialog__close')).not.toBeNull();
        dialog.headerStart.querySelector('.sb-dialog__back').click();
        expect(await dialog.closed).toEqual({ response: 'back' });
        expect(root.popup.dlg.inert).toBe(false);
        expect(root.popup.dlg.hasAttribute('data-sb-covered')).toBe(false);
        expect(root.popup.dlg.hasAttribute('open')).toBe(true);
        expect(document.activeElement).toBe(opener);
    });

    test('a page with responses has Cancel as Back and no Close', async () => {
        await showPopup({ type: POPUP_TYPE.CONFIRM, tier: 'window' });
        const dialog = openDialog({ title: 'Form', responses: { affirmative: { label: 'Save' } } });
        expect(dialog.root.querySelector('.sb-dialog__close')).toBeNull();
        expect(dialog.root.querySelector('.sb-dialog__back')).toBeNull();
        dialog.root.querySelector('.sb-dialog__cancel').click();
        expect(await dialog.closed).toEqual({ response: 'cancel' });
    });

    test('Escape pops one level only', async () => {
        const root = await showPopup({ tier: 'window' });
        const dialog = openDialog({ title: 'Page' });
        dialog.root.dispatchEvent(new Event('cancel', { cancelable: true }));
        expect(await dialog.closed).toEqual({ response: 'back' });
        expect(root.popup.dlg.hasAttribute('open')).toBe(true);
    });

    test('an Alert over a Popup stays an Alert', async () => {
        const root = await showPopup({ tier: 'window' });
        const { openAlert } = await import('../../public/scripts/sillybunny-editor/dialog.js');
        void openAlert({ heading: 'Sure?', responses: [{ id: 'ok', label: 'OK' }] });
        const alert = document.querySelector('.sb-dialog-host');
        expect(alert.dataset.tier).toBe('alert');
        expect(alert.querySelector('.sb-dialog--page')).toBeNull();
        expect(root.popup.dlg.inert).toBe(false);
    });

    test('Close on the page closes the Popup beneath it with its cancel result', async () => {
        const closing = jest.fn(() => true);
        const root = await showPopup({ tier: 'window', onClosing: closing });
        const dialog = openDialog({ title: 'Page' });
        dialog.headerEnd.querySelector('.sb-dialog__close').click();
        await settle();
        expect(await dialog.closed).toEqual({ response: 'close' });
        expect(closing).toHaveBeenCalledTimes(1);
        expect(await root.result).toBeNull();
        expect(openDialogs()).toHaveLength(0);
    });

    test('a three-deep chain of openDialog, Popup and openDialog closes from the top', async () => {
        const rootCanClose = jest.fn(() => true);
        const rootDialog = openDialog({ title: 'Root', canClose: rootCanClose });
        const popup = await showPopup({ tier: 'window' });
        expect(popup.popup.dlg.classList.contains('sb-dialog--page')).toBe(true);
        const topDialog = openDialog({ title: 'Top' });
        expect(topDialog.surface.classList.contains('sb-dialog--page')).toBe(true);
        topDialog.headerEnd.querySelector('.sb-dialog__close').click();
        await settle();
        expect(await topDialog.closed).toEqual({ response: 'close' });
        expect(await popup.result).toBeNull();
        expect(await rootDialog.closed).toEqual({ response: 'close' });
        expect(rootCanClose).toHaveBeenCalledWith('close');
        expect(openDialogs()).toHaveLength(0);
    });

    test('a Popup page Close reaches an openDialog root and honours its canClose veto', async () => {
        let allow = false;
        const rootDialog = openDialog({ title: 'Root', canClose: () => allow });
        const popup = await showPopup({ tier: 'window' });
        chainClose(popup.popup).click();
        await settle();
        expect(await popup.result).toBeNull();
        expect(rootDialog.isOpen).toBe(true);
        expect(rootDialog.surface.closest('dialog').inert).toBe(false);
        expect(rootDialog.surface.inert).toBe(false);
        allow = true;
        rootDialog.close();
        expect(await rootDialog.closed).toEqual({ response: 'close' });
    });

    test('an openDialog level that vetoes stops the walk and the Popup above it is already closed', async () => {
        const rootDialog = openDialog({ title: 'Root', canClose: () => false });
        const popup = await showPopup({ tier: 'window' });
        const topDialog = openDialog({ title: 'Top' });
        topDialog.headerEnd.querySelector('.sb-dialog__close').click();
        await settle();
        expect(await topDialog.closed).toEqual({ response: 'close' });
        expect(await popup.result).toBeNull();
        expect(rootDialog.isOpen).toBe(true);
        expect(openDialogs()).toEqual([rootDialog.root]);
        rootDialog.forceClose();
        await rootDialog.closed;
    });
});

describe('a veto handler that opens a page', () => {
    function vetoWithPage(outcome) {
        const state = { page: null };
        state.onClosing = jest.fn(async () => {
            state.page = new Popup('<p>Page</p>', POPUP_TYPE.DISPLAY, '', { tier: 'dialog', title: 'Page' });
            await state.page.show();
            return outcome;
        });
        return state;
    }

    test('a chain Close from that page does not complete the Popup a second time, and a refusal stands', async () => {
        const veto = vetoWithPage(false);
        const root = await showPopup({ type: POPUP_TYPE.CONFIRM, tier: 'window', onClosing: veto.onClosing });
        root.popup.okButton.click();
        await settle();
        expect(veto.onClosing).toHaveBeenCalledTimes(1);
        expect(veto.page.dlg.classList.contains('sb-dialog--page')).toBe(true);
        chainClose(veto.page).click();
        await settle();
        expect(veto.onClosing).toHaveBeenCalledTimes(1);
        expect(openDialogs()).toEqual([root.popup.dlg]);
        expect(root.popup.result).toBeUndefined();
        expect(root.popup.dlg.inert).toBe(false);
    });

    test('an openDialog canClose that opens a page is awaited, not asked again by the chain Close', async () => {
        let page;
        const canClose = jest.fn(async () => {
            page = new Popup('<p>Page</p>', POPUP_TYPE.DISPLAY, '', { tier: 'dialog', title: 'Page' });
            await page.show();
            return true;
        });
        const dialog = openDialog({ title: 'Root', canClose });
        dialog.close();
        await settle();
        expect(page.dlg.classList.contains('sb-dialog--page')).toBe(true);
        chainClose(page).click();
        await settle();
        expect(canClose).toHaveBeenCalledTimes(1);
        expect(await dialog.closed).toEqual({ response: 'close' });
    });

    test('when the handler then allows the close, the Popup closes once with its own result', async () => {
        const veto = vetoWithPage(true);
        const root = await showPopup({ type: POPUP_TYPE.CONFIRM, tier: 'window', onClosing: veto.onClosing });
        root.popup.okButton.click();
        await settle();
        chainClose(veto.page).click();
        await settle();
        expect(veto.onClosing).toHaveBeenCalledTimes(1);
        expect(await root.result).toBe(POPUP_RESULT.AFFIRMATIVE);
        expect(openDialogs()).toHaveLength(0);
    });
});

describe('a page whose covered level is removed by code', () => {
    test('a Popup page closes itself with its cancel result', async () => {
        const root = await showPopup({ tier: 'window' });
        const page = await showPopup();
        await root.popup.completeCancelled();
        await settle();
        expect(await page.result).toBeNull();
        expect(openDialogs()).toHaveLength(0);
    });

    test('an openDialog page goes back, and its canClose can still veto', async () => {
        const root = await showPopup({ tier: 'window' });
        let allow = false;
        const dialog = openDialog({ title: 'Page', canClose: () => allow });
        await root.popup.completeCancelled();
        await settle();
        expect(dialog.isOpen).toBe(true);
        allow = true;
        dialog.headerEnd.querySelector('.sb-dialog__close').click();
        await settle();
        expect(await dialog.closed).toEqual({ response: 'close' });
    });

    test('an openDialog page closes like a chain Close when the Popup under it closes', async () => {
        const root = await showPopup({ tier: 'window' });
        const dialog = openDialog({ title: 'Page' });
        await root.popup.completeCancelled();
        expect(await dialog.closed).toEqual({ response: 'close' });
        expect(document.querySelectorAll('.sb-dialog-host')).toHaveLength(0);
    });

    test('a Popup page over an openDialog root closes when the root is closed by code', async () => {
        const root = openDialog({ tier: 'window', title: 'Root' });
        const page = await showPopup();
        root.forceClose();
        await settle();
        expect(await page.result).toBeNull();
        expect(openDialogs()).toHaveLength(0);
    });

    test('the cascade closes the pages top first and leaves the removed Popup\'s own result as the last result', async () => {
        const order = [];
        const root = await showPopup({ type: POPUP_TYPE.CONFIRM, tier: 'window' });
        const middle = await showPopup({ onClosing: () => { order.push('middle'); return true; } });
        const top = await showPopup({ onClosing: () => { order.push('top'); return true; } });
        await root.popup.completeAffirmative();
        await settle();
        expect(order).toEqual(['top', 'middle']);
        expect(await Promise.all([root.result, middle.result, top.result])).toEqual([POPUP_RESULT.AFFIRMATIVE, null, null]);
        expect(Popup.util.lastResult.result).toBe(POPUP_RESULT.AFFIRMATIVE);
        expect(openDialogs()).toHaveLength(0);
    });

    test('the cascade stops at a page that refuses, and the pages below it stay open', async () => {
        const root = await showPopup({ tier: 'window' });
        const middle = await showPopup({ onClosing: () => false });
        const top = await showPopup();
        await root.popup.completeCancelled();
        await settle();
        expect(await top.result).toBeNull();
        expect(openDialogs()).toEqual([middle.popup.dlg]);
    });

    describe('a page that stays open after its covered level is gone', () => {
        const emptyRect = { top: 0, left: 0, width: 0, height: 0 };
        // A removed surface has no layout, as in a browser.
        const withLayout = node => {
            node.getBoundingClientRect = function () {
                return this.isConnected ? { top: 20, left: 30, width: 300, height: 200 } : emptyRect;
            };
        };

        test('a Popup page keeps its last rectangle on resize and takes over the dim', async () => {
            const root = await showPopup({ tier: 'window' });
            withLayout(root.popup.dlg);
            const veto = jest.fn(() => false);
            const page = await showPopup({ onClosing: veto });
            expect(page.popup.dlg.style.getPropertyValue('--sb-page-width')).toBe('300px');
            await root.popup.completeCancelled();
            await settle();
            expect(veto).toHaveBeenCalledTimes(1);
            expect(page.popup.dlg.hasAttribute('open')).toBe(true);
            window.dispatchEvent(new Event('resize'));
            await settle();
            for (const [name, value] of [['top', '20px'], ['left', '30px'], ['width', '300px'], ['height', '200px']]) {
                expect(page.popup.dlg.style.getPropertyValue(`--sb-page-${name}`)).toBe(value);
            }
            expect(page.popup.dlg.hasAttribute('data-covers-popup')).toBe(true);
        });

        test('an openDialog page keeps its last rectangle and dims through its host', async () => {
            const root = await showPopup({ tier: 'window' });
            withLayout(root.popup.dlg);
            const dialog = openDialog({ title: 'Page', canClose: () => false });
            await root.popup.completeCancelled();
            await settle();
            expect(dialog.isOpen).toBe(true);
            window.dispatchEvent(new Event('resize'));
            await settle();
            expect(dialog.surface.style.getPropertyValue('--sb-page-width')).toBe('300px');
            expect(dialog.surface.style.getPropertyValue('--sb-page-height')).toBe('200px');
            expect(dialog.surface.hasAttribute('data-covers-popup')).toBe(true);
            dialog.forceClose();
        });

        test('it leaves the dim to another dialog that is still beneath it', async () => {
            const base = await showPopup({ tier: 'window' });
            const middle = await showPopup();
            const top = await showPopup({ onClosing: () => false });
            expect(top.popup.dlg.hasAttribute('data-covers-popup')).toBe(true);
            await middle.popup.completeCancelled();
            await settle();
            expect(openDialogs()).toEqual([base.popup.dlg, top.popup.dlg]);
            expect(top.popup.dlg.hasAttribute('data-covers-popup')).toBe(false);
        });
    });
});

describe('coverSurface', () => {
    test('a covered surface that left the document no longer moves the page, even before the chain notices', () => {
        const covered = document.createElement('div');
        const page = document.createElement('div');
        document.body.append(covered, page);
        covered.getBoundingClientRect = function () {
            return this.isConnected ? { top: 20, left: 30, width: 300, height: 200 } : { top: 0, left: 0, width: 0, height: 0 };
        };
        const cover = coverSurface(covered, page);
        covered.remove();
        window.dispatchEvent(new Event('resize'));
        expect(page.style.getPropertyValue('--sb-page-width')).toBe('300px');
        expect(page.style.getPropertyValue('--sb-page-height')).toBe('200px');
        cover.release();
    });
});

describe('closeChain re-entry', () => {
    test('a walk that reaches a level another walk is closing stops there and leaves the result to that walk', async () => {
        const rootSurface = document.createElement('div');
        const pageSurface = document.createElement('div');
        const topSurface = document.createElement('div');
        let nested;
        const closeRoot = jest.fn(async () => {
            nested = await closeChain(page);
            return true;
        });
        const root = registerChainLevel({ surface: rootSurface, close: closeRoot });
        const closePage = jest.fn(async () => true);
        const page = registerChainLevel({ surface: pageSurface, close: closePage, covered: rootSurface });
        const closeTop = jest.fn(async () => true);
        const top = registerChainLevel({ surface: topSurface, close: closeTop, covered: rootSurface });
        expect(await closeChain(top)).toBe(true);
        expect(closeTop).toHaveBeenCalledTimes(1);
        expect(closeRoot).toHaveBeenCalledTimes(1);
        expect(closePage).toHaveBeenCalledTimes(1);
        expect(nested).toBe(false);
        for (const level of [top, page, root]) unregisterChainLevel(level);
    });

    test('a second Close on the same level shares the running walk', async () => {
        let release;
        const close = jest.fn(() => new Promise(resolve => { release = resolve; }));
        const level = registerChainLevel({ surface: document.createElement('div'), close });
        const first = closeChain(level);
        const second = closeChain(level);
        expect(second).toBe(first);
        release(true);
        expect(await first).toBe(true);
        expect(close).toHaveBeenCalledTimes(1);
        unregisterChainLevel(level);
    });
});

describe('focus after a page closes', () => {
    test('returns to the control the covered Popup last had focus on', async () => {
        const root = await showPopup({ type: POPUP_TYPE.TEXT, tier: 'window' });
        root.popup.content.innerHTML = '<input id="first"><input id="second">';
        root.popup.content.querySelector('#second').focus();
        const child = await showPopup();
        document.activeElement.blur();
        child.popup.closeButton.click();
        await settle();
        expect(document.activeElement).toBe(root.popup.content.querySelector('#second'));
    });

    test('a covered Popup that never had focus gets its first visible control, not the body', async () => {
        const rects = jest.spyOn(HTMLElement.prototype, 'getClientRects').mockReturnValue([{}]);
        try {
            const root = await showPopup({ type: POPUP_TYPE.CONFIRM, tier: 'window' });
            root.popup.content.innerHTML = '<input id="only">';
            const child = await showPopup();
            document.activeElement.blur();
            child.popup.closeButton.click();
            await settle();
            expect(root.popup.dlg.contains(document.activeElement)).toBe(true);
            expect(document.activeElement).not.toBe(document.body);
        } finally {
            rects.mockRestore();
        }
    });
});

describe('pages over a bottom sheet', () => {
    test('a Popup page over a sheet takes the sheet shape and keeps the dim', async () => {
        media.sheet = true;
        const root = await showPopup({ tier: 'window' });
        expect(root.popup.dlg.dataset.presentation).toBe('sheet');
        const child = await showPopup();
        const grandchild = await showPopup();
        for (const page of [child, grandchild]) {
            expect(page.popup.dlg.dataset.presentation).toBe('floating');
            expect(page.popup.dlg.hasAttribute('data-covers-sheet')).toBe(true);
        }
        expect(child.popup.dlg.hasAttribute('data-covers-popup')).toBe(true);
    });

    test('an openDialog page over a sheet Popup takes the sheet shape and dims through its host', async () => {
        media.sheet = true;
        await showPopup({ tier: 'window' });
        const dialog = openDialog({ title: 'Page' });
        expect(dialog.surface.hasAttribute('data-covers-sheet')).toBe(true);
        expect(dialog.surface.hasAttribute('data-covers-popup')).toBe(true);
        expect(dialog.root.classList.contains('sb-dialog-host--page')).toBe(true);
        expect(dialog.root.dataset.presentation).toBe('floating');
        expect(dialog.root.querySelector('.sb-dialog-scrim').hidden).toBe(true);
    });

    test('floating parents and openDialog parents add no sheet hook, and only Popup parents mark covers-popup', async () => {
        const popup = await showPopup({ tier: 'window' });
        const page = await showPopup();
        expect(page.popup.dlg.hasAttribute('data-covers-sheet')).toBe(false);
        await popup.popup.completeCancelled();
        await settle();
        const root = openDialog({ tier: 'window', title: 'Root' });
        const over = await showPopup();
        expect(over.popup.dlg.hasAttribute('data-covers-popup')).toBe(false);
        expect(over.popup.dlg.hasAttribute('data-covers-sheet')).toBe(false);
        root.forceClose();
    });

    test('only a page over a Popup that dims keeps the dim: Popup roots, pages and openDialog roots', async () => {
        const dims = node => node.hasAttribute('data-covers-popup');
        // Popup root, Popup page, openDialog page: each level over a Popup that dims keeps the dim.
        const popupRoot = await showPopup({ tier: 'window' });
        const popupPage = await showPopup();
        const hostOverPage = openDialog({ title: 'Page' });
        expect([dims(popupPage.popup.dlg), dims(hostOverPage.surface)]).toEqual([true, true]);
        const popupOverHost = await showPopup();
        expect(dims(popupOverHost.popup.dlg)).toBe(false);
        hostOverPage.forceClose();
        await popupRoot.popup.completeCancelled();
        await settle();
        expect(openDialogs()).toHaveLength(0);

        // openDialog root: its own scrim dims, so no page over it adds a second dim.
        const hostRoot = openDialog({ tier: 'window', title: 'Root' });
        const pageOverRoot = await showPopup();
        const hostOverPopupPage = openDialog({ title: 'Page' });
        const popupOverThat = await showPopup();
        expect(dims(pageOverRoot.popup.dlg)).toBe(false);
        expect(dims(hostOverPopupPage.surface)).toBe(false);
        expect(dims(popupOverThat.popup.dlg)).toBe(false);
        hostRoot.forceClose();
        await settle();
    });
});
