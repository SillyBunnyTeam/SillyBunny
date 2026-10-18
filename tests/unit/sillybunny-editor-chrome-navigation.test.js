/** @jest-environment jsdom */
/* eslint-disable playwright/prefer-web-first-assertions -- Jest/jsdom assertions are synchronous. */
import { jest, describe, test, expect, beforeEach, afterEach } from '@jest/globals';

const popupShow = jest.fn();

await jest.unstable_mockModule('../../public/scripts/i18n.js', () => ({
    t: (strings, ...values) => strings.reduce((out, part, index) => out + part + (index < values.length ? values[index] : ''), ''),
    translate: value => value,
}));
const actionMenu = {
    openActionMenu: jest.fn(),
    closeActionMenu: jest.fn(),
    isActionMenuOpen: jest.fn(() => false),
};
await jest.unstable_mockModule('../../public/scripts/sillybunny-action-menu.js', () => actionMenu);
const picker = { isPickerOpen: jest.fn(() => false) };
await jest.unstable_mockModule('../../public/scripts/sillybunny-editor/picker.js', () => picker);
await jest.unstable_mockModule('../../public/scripts/sillybunny-motion.js', () => ({
    animateIn: jest.fn(),
    animateOut: jest.fn((_element, _frames, hide) => hide()),
    prefersReducedMotion: jest.fn(() => true),
    MOTION_EASE_OUT_QUAD: 'linear',
    MOTION_FAST: 0,
}));
await jest.unstable_mockModule('../../public/scripts/popup.js', () => ({
    POPUP_TYPE: { CONFIRM: 'confirm' },
    POPUP_RESULT: { AFFIRMATIVE: 1, NEGATIVE: 0 },
    Popup: jest.fn().mockImplementation(function () {
        this.okButton = document.createElement('button');
        this.show = popupShow;
    }),
}));

const { mountEditorChrome, showDraftRecoveryToast, dismissDraftRecoveryToast } = await import('../../public/scripts/sillybunny-editor/chrome.js');
const { registerEditorNavigation, characterTabGuardSelector, CHARACTER_TAB_GUARD_SELECTOR } = await import('../../public/scripts/sillybunny-editor/navigation.js');

function makeMedia() {
    const media = { matches: false, addEventListener: jest.fn(), removeEventListener: jest.fn() };
    window.matchMedia = jest.fn(() => media);
    return media;
}

function makeChrome(extra = {}) {
    const root = document.createElement('div');
    const header = document.createElement('header');
    const content = document.createElement('div');
    const controls = {
        back: document.createElement('button'),
        cancel: document.createElement('button'),
        save: document.createElement('button'),
        title: document.createElement('h2'),
        dirty: document.createElement('span'),
    };
    controls.dirty.hidden = true;
    header.append(...Object.values(controls));
    root.append(header, content);
    document.body.append(root);
    const handlers = { onBack: jest.fn(), onCancel: jest.fn(), onSave: jest.fn() };
    const chrome = mountEditorChrome({ root, header, content, controls, ...handlers, ...extra });
    return { chrome, root, header, content, controls, handlers };
}

beforeEach(() => {
    document.body.replaceChildren();
    popupShow.mockReset();
    actionMenu.isActionMenuOpen.mockReset().mockReturnValue(false);
    actionMenu.closeActionMenu.mockReset();
    picker.isPickerOpen.mockReset().mockReturnValue(false);
    global.ResizeObserver = class {
        observe = jest.fn();
        disconnect = jest.fn();
    };
    global.requestAnimationFrame = callback => { callback(0); return 1; };
});

describe('mountEditorChrome header-only mode', () => {
    test('mounts without a toolbar or More button and renders state', () => {
        makeMedia();
        const { chrome, controls } = makeChrome();
        chrome.render({ mode: 'edit', dirty: true, title: 'Entry' });
        expect(controls.title.textContent).toBe('Entry');
        expect(controls.save.disabled).toBe(false);
        expect(controls.cancel.disabled).toBe(false);
        expect(controls.dirty.hidden).toBe(false);
        expect(() => chrome.scheduleOverflow()).not.toThrow();
    });

    test('does not observe resizes when there is no toolbar', () => {
        makeMedia();
        const observe = jest.fn();
        global.ResizeObserver = class { observe = observe; disconnect = jest.fn(); };
        makeChrome();
        expect(observe).not.toHaveBeenCalled();
    });

    test('reset reveals hidden chrome and scrolls to the top only on request', () => {
        makeMedia();
        const { chrome, header, content } = makeChrome();
        header.classList.add('sb-editor-chrome-hidden');
        content.scrollTop = 240;
        chrome.reset();
        expect(header.classList.contains('sb-editor-chrome-hidden')).toBe(false);
        expect(content.scrollTop).toBe(240);
        header.classList.add('sb-editor-chrome-hidden');
        chrome.reset({ scrollToTop: true });
        expect(header.classList.contains('sb-editor-chrome-hidden')).toBe(false);
        expect(content.scrollTop).toBe(0);
    });

    test('wires back, cancel and save', () => {
        makeMedia();
        const { controls, handlers } = makeChrome();
        controls.back.click();
        controls.cancel.disabled = false;
        controls.cancel.click();
        controls.save.disabled = false;
        controls.save.click();
        expect(handlers.onBack).toHaveBeenCalledTimes(1);
        expect(handlers.onCancel).toHaveBeenCalledTimes(1);
        expect(handlers.onSave).toHaveBeenCalledTimes(1);
    });

    test('names retained icon actions after tooltip extraction and forwards the avatar picker', () => {
        makeMedia();
        const { root } = makeChrome();
        root.innerHTML += '<div class="sb-editor-icon-button" data-sttt--title="Connected Personas"><i class="fa-solid fa-face-smile"></i></div>'
            + '<div class="ds-field-header"><label>Description</label><a class="notes-link"><span class="fa-solid fa-question"></span></a></div>'
            + '<button data-sb-avatar-input="avatar-input"></button><input id="avatar-input" type="file" hidden>';
        const input = root.querySelector('#avatar-input');
        const click = jest.spyOn(input, 'click').mockImplementation(() => {});
        const chrome = mountEditorChrome({
            root, header: document.createElement('header'), content: document.createElement('div'),
            controls: { back: document.createElement('button'), cancel: document.createElement('button'), save: document.createElement('button'), title: document.createElement('span'), dirty: document.createElement('span') },
            onBack() {}, onCancel() {}, onSave() {},
        });
        expect(root.querySelector('.sb-editor-icon-button').getAttribute('aria-label')).toBe('Connected Personas');
        expect(root.querySelector('.notes-link').getAttribute('aria-label')).toBe('Description');
        expect([...root.querySelectorAll('.fa-solid')].every(icon => icon.getAttribute('aria-hidden') === 'true')).toBe(true);
        root.querySelector('button[data-sb-avatar-input]').click();
        expect(click).toHaveBeenCalledTimes(1);
        chrome.dispose();
    });

    test('inline rename has a name and Escape cancels without leaving', () => {
        makeMedia();
        const titleButton = document.createElement('button');
        titleButton.id = 'editor_title_button';
        const title = document.createElement('span');
        titleButton.append(title);
        document.body.append(titleButton);
        const commit = jest.fn();
        const chrome = mountEditorChrome({
            root: document.body, header: document.createElement('header'), content: document.createElement('div'),
            controls: { back: document.createElement('button'), cancel: document.createElement('button'), save: document.createElement('button'), title, titleButton, dirty: document.createElement('span') },
            rename: { getValue: () => 'Alice', commit }, onBack() {}, onCancel() {}, onSave() {},
        });
        chrome.render({ mode: 'edit', title: 'Alice', dirty: false });
        titleButton.click();
        const input = document.querySelector('.sb-editor-title-input');
        expect(input.getAttribute('aria-label')).toBe('Rename');
        input.value = 'Abandoned';
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
        expect(commit).not.toHaveBeenCalled();
        expect(document.activeElement).toBe(titleButton);
        chrome.dispose();
    });
});

test('entity-scoped draft dismissal leaves another editor recovery toast untouched', () => {
    let hidden;
    const toast = { find: jest.fn(() => ({ on: jest.fn() })) };
    global.toastr = {
        info: jest.fn((_body, _title, options) => { hidden = options.onHidden; return toast; }),
        clear: jest.fn(() => hidden()),
    };
    try {
        showDraftRecoveryToast({ ts: 1 }, { restore() {}, discard() {} }, 'group:g1');
        dismissDraftRecoveryToast('character:alice.png');
        expect(global.toastr.clear).not.toHaveBeenCalled();
        dismissDraftRecoveryToast('group:g1');
        expect(global.toastr.clear).toHaveBeenCalledWith(toast, { force: true });
    } finally {
        dismissDraftRecoveryToast();
        delete global.toastr;
    }
});

describe('mountEditorChrome dispose', () => {
    test('removes control listeners and the media-query listener', () => {
        const media = makeMedia();
        const { chrome, controls, handlers } = makeChrome();
        const handler = media.addEventListener.mock.calls[0][1];
        chrome.dispose();
        controls.back.click();
        controls.save.disabled = false;
        controls.save.click();
        expect(handlers.onBack).not.toHaveBeenCalled();
        expect(handlers.onSave).not.toHaveBeenCalled();
        expect(media.removeEventListener).toHaveBeenCalledWith('change', handler);
    });

    test('disconnects the toolbar resize observer', () => {
        makeMedia();
        const disconnect = jest.fn();
        global.ResizeObserver = class { observe = jest.fn(); disconnect = disconnect; };
        const toolbar = document.createElement('div');
        const { chrome } = makeChrome({ toolbar });
        chrome.dispose();
        expect(disconnect).toHaveBeenCalled();
    });

    test('closes its open More menu without restoring focus', () => {
        makeMedia();
        const more = document.createElement('button');
        const root = document.createElement('div');
        const header = document.createElement('header');
        const controls = {
            back: document.createElement('button'), cancel: document.createElement('button'),
            save: document.createElement('button'), title: document.createElement('h2'),
            dirty: document.createElement('span'), more,
        };
        const withMenu = mountEditorChrome({ root, header, content: document.createElement('div'), controls, onBack() {}, onCancel() {}, onSave() {} });
        actionMenu.isActionMenuOpen.mockImplementation(trigger => trigger === more);
        withMenu.dispose();
        expect(actionMenu.closeActionMenu).toHaveBeenCalledWith({ animate: false, restoreFocus: false });
    });

    test('leaves a closed or foreign menu alone', () => {
        makeMedia();
        const { chrome } = makeChrome();
        actionMenu.isActionMenuOpen.mockReturnValue(true);
        chrome.dispose();
        expect(actionMenu.closeActionMenu).not.toHaveBeenCalled();
    });

    test('scrollHide: false never hides the header', () => {
        const media = makeMedia();
        media.matches = true;
        const { header, content } = makeChrome({ scrollHide: false });
        Object.defineProperty(content, 'scrollHeight', { value: 2000 });
        Object.defineProperty(content, 'clientHeight', { value: 400 });
        content.scrollTop = 500;
        content.dispatchEvent(new Event('scroll'));
        expect(header.classList.contains('sb-editor-chrome-hidden')).toBe(false);
    });
});

describe('editor navigation guards', () => {
    const registrations = [];
    const register = registration => registrations.push(registerEditorNavigation(registration));
    afterEach(() => registrations.splice(0).forEach(unregister => unregister()));

    function makeSession(dirty = true) {
        return {
            isOpen: () => true,
            isDirty: () => dirty,
            save: jest.fn(async () => true),
            discard: jest.fn(),
            flushDraft: jest.fn(),
        };
    }

    test('characterTabGuardSelector excludes only the named tab', () => {
        const selector = characterTabGuardSelector('world-info');
        const own = document.createElement('button');
        own.dataset.sbCharacterTab = 'world-info';
        const other = document.createElement('button');
        other.dataset.sbCharacterTab = 'editor';
        expect(own.matches(selector)).toBe(false);
        expect(other.matches(selector)).toBe(true);
        expect(other.matches(CHARACTER_TAB_GUARD_SELECTOR)).toBe(false);
    });

    // jsdom cannot create trusted events, so the intercept path is covered by e2e; here the
    // replayed (untrusted) click must pass straight through to the target.
    test('untrusted replays pass a custom guardSelector untouched', () => {
        register({ session: makeSession(true), isActive: () => true, close: jest.fn(), guardSelector: '.sb-test-guarded' });
        const guarded = document.createElement('button');
        guarded.className = 'sb-test-guarded';
        const spy = jest.fn();
        guarded.addEventListener('click', spy);
        document.body.append(guarded);
        const event = new MouseEvent('click', { bubbles: true, cancelable: true });
        guarded.dispatchEvent(event);
        expect(spy).toHaveBeenCalledTimes(1);
        expect(event.defaultPrevented).toBe(false);
    });

    test('dirty Escape is guarded by default', () => {
        popupShow.mockResolvedValue(0);
        register({ session: makeSession(true), isActive: () => true, close: jest.fn(), guardSelector: '.none' });
        const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
        document.body.dispatchEvent(event);
        expect(event.defaultPrevented).toBe(true);
        expect(popupShow).toHaveBeenCalled();
    });

    test('clean Escape consumes the event and follows the registered Back route', async () => {
        const close = jest.fn();
        register({ session: makeSession(false), isActive: () => true, close });
        const bubble = jest.fn();
        document.body.addEventListener('keydown', bubble, { once: true });
        const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
        document.body.dispatchEvent(event);
        await Promise.resolve();
        expect(event.defaultPrevented).toBe(true);
        expect(bubble).not.toHaveBeenCalled();
        expect(close).toHaveBeenCalledTimes(1);
        expect(popupShow).not.toHaveBeenCalled();
        document.body.removeEventListener('keydown', bubble);
    });

    test('an open picker owns Escape before the dirty check runs', () => {
        const session = makeSession(true);
        const isDirty = jest.spyOn(session, 'isDirty');
        register({ session, isActive: () => true, close: jest.fn(), guardSelector: '.none' });
        picker.isPickerOpen.mockReturnValue(true);
        const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
        document.body.dispatchEvent(event);
        expect(event.defaultPrevented).toBe(false);
        expect(isDirty).not.toHaveBeenCalled();
        expect(popupShow).not.toHaveBeenCalled();
    });

    test.each(['popup', 'tag-manager', 'action-menu', 'inline-rename'])('a %s owns clean Escape', async owner => {
        const close = jest.fn();
        register({ session: makeSession(false), isActive: () => true, close });
        const field = document.createElement('input');
        document.body.append(field);
        if (owner === 'popup') document.body.insertAdjacentHTML('beforeend', '<dialog class="popup" open></dialog>');
        if (owner === 'tag-manager') {
            document.body.insertAdjacentHTML('beforeend', '<dialog class="sb-tag-manager-host" open></dialog>');
            document.querySelector('.sb-tag-manager-host').append(field);
        }
        if (owner === 'action-menu') actionMenu.isActionMenuOpen.mockReturnValue(true);
        if (owner === 'inline-rename') field.className = 'sb-editor-title-input';
        field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
        await Promise.resolve();
        expect(close).not.toHaveBeenCalled();
        expect(popupShow).not.toHaveBeenCalled();
    });

    test('group search receives Escape before editor navigation', async () => {
        const close = jest.fn();
        register({ session: makeSession(false), isActive: () => true, close });
        const field = document.createElement('input');
        field.id = 'rm_group_members_filter';
        const clear = jest.fn();
        field.addEventListener('keydown', clear);
        document.body.append(field);
        field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
        await Promise.resolve();
        expect(clear).toHaveBeenCalledTimes(1);
        expect(close).not.toHaveBeenCalled();
    });

    test('escape: false leaves a dirty Escape to the editor shell', () => {
        const session = makeSession(true);
        const close = jest.fn();
        register({ session, isActive: () => true, close, escape: false, guardSelector: '.none' });
        const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
        document.body.dispatchEvent(event);
        expect(event.defaultPrevented).toBe(false);
        expect(popupShow).not.toHaveBeenCalled();
    });

    test('Ctrl+S saves the active registered editor', () => {
        const session = makeSession(true);
        register({ session, isActive: () => true, close: jest.fn(), escape: false });
        const event = new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true, cancelable: true });
        document.body.dispatchEvent(event);
        expect(event.defaultPrevented).toBe(true);
        expect(session.save).toHaveBeenCalled();
    });
});
