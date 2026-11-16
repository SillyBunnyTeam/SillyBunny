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

const {
    mountEditorChrome, createDirtyMark, createTokenReadout, createSummaryRow, setSummaryText, attachToLabelRow,
    showDraftRecoveryToast, dismissDraftRecoveryToast,
} = await import('../../public/scripts/sillybunny-editor/chrome.js');
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

    test('reset scrolls to the top only on request', () => {
        makeMedia();
        const { chrome, content } = makeChrome();
        content.scrollTop = 240;
        chrome.reset();
        expect(content.scrollTop).toBe(240);
        chrome.reset({ scrollToTop: true });
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

describe('mountEditorChrome shared header', () => {
    const names = header => [...header.children].map(node => node.dataset.slot);
    const make = (tag, slot) => {
        const node = document.createElement(tag);
        node.dataset.slot = slot;
        return node;
    };

    function slotted(extra = {}) {
        const root = document.createElement('div');
        const header = document.createElement('header');
        const content = document.createElement('div');
        const controls = {
            back: make('button', 'back'), title: make('input', 'title'), dirty: make('span', 'dirty'),
            more: make('button', 'more'), cancel: make('button', 'cancel'), save: make('button', 'save'),
            ...extra.controls,
        };
        // Appended in the order an editor with a toolbar menu or a late readout would have built them.
        header.append(controls.save, controls.cancel, controls.title, controls.dirty, controls.back);
        for (const node of [...(controls.modes ?? []), ...(extra.inHeader ?? [])]) header.append(node);
        root.append(header, content);
        document.body.append(root);
        const toolbar = extra.toolbar ?? null;
        if (toolbar) root.append(toolbar);
        const handlers = { onBack: jest.fn(), onCancel: jest.fn(), onSave: jest.fn() };
        const chrome = mountEditorChrome({ root, header, content, toolbar, ...handlers, ...extra, controls });
        return { chrome, root, header, controls, toolbar };
    }

    test('orders the header Back, title, dirty mark, count, Edit/Preview, item menu, Cancel, Save and moves a toolbar menu into it', () => {
        makeMedia();
        const modes = ['modes', 'toggle'].map(slot => make('div', slot));
        const toolbar = document.createElement('div');
        const more = make('button', 'more');
        toolbar.append(more);
        const readout = createTokenReadout();
        readout.dataset.slot = 'tokens';
        const { header } = slotted({ toolbar, tokens: { element: readout }, controls: { modes, more } });
        expect(names(header)).toEqual(['back', 'title', 'dirty', 'tokens', 'modes', 'toggle', 'more', 'cancel', 'save']);
        expect(toolbar.contains(more)).toBe(false);
    });

    test('keeps a wrapper that holds the item menu in the menu place', () => {
        makeMedia();
        const wrapper = make('div', 'actions');
        const more = document.createElement('button');
        wrapper.append(document.createElement('button'), more);
        const { header } = slotted({ controls: { more }, inHeader: [wrapper] });
        expect(names(header)).toEqual(['back', 'title', 'dirty', 'actions', 'cancel', 'save']);
        expect(wrapper.contains(more)).toBe(true);
    });

    test('tooltips: Cancel and Save say their word, Back says Back, and the item menu takes the label the editor gives it', () => {
        makeMedia();
        const { chrome, controls } = slotted({ itemMenuLabel: 'Entry Actions' });
        chrome.render({ mode: 'edit', dirty: true, title: 'Entry' });
        expect(controls.cancel.title).toBe('Cancel');
        expect(controls.save.title).toBe('Save');
        chrome.render({ mode: 'create', dirty: true, title: 'Entry' });
        expect(controls.save.title).toBe('Create');
        chrome.render({ mode: 'create', dirty: true, title: 'Entry', saveLabel: 'Save' });
        expect(controls.save.textContent).toBe('Save');
        expect(controls.save.title).toBe('Save');
        expect(controls.back.title).toBe('Back');
        expect(controls.back.dataset.sbCopyPlaceholder).toBeUndefined();
        expect(controls.more.title).toBe('Entry Actions');
        expect(controls.more.getAttribute('aria-label')).toBe('Entry Actions');
        expect(controls.more.dataset.sbCopyPlaceholder).toBeUndefined();
    });

    test('keeps the accessible names that the editors set', () => {
        makeMedia();
        const back = document.createElement('button');
        back.setAttribute('aria-label', 'Back to groups');
        back.className = 'sb-editor-icon-button';
        back.title = 'Back to groups';
        const { controls } = slotted({ controls: { back } });
        expect(controls.back.getAttribute('aria-label')).toBe('Back to groups');
    });

    test('the readout shows the full count in the header and the short count, with the full one in its name, in the row', () => {
        makeMedia();
        const row = document.createElement('div');
        const readout = createTokenReadout({ warning: { href: 'https://example.test/limits', title: 'About limits' } });
        const { chrome } = slotted({ tokens: { element: readout, row: { host: row } } });
        const phone = row.querySelector('.sb-editor-tokens--row');
        expect(readout.hidden).toBe(true);
        expect(phone.hidden).toBe(true);

        chrome.setTokens({ total: 79, permanent: 46 });
        expect(readout.hidden).toBe(false);
        expect(readout.querySelector('.sb-editor-tokens__value').textContent).toBe('79 Tokens (46 Permanent)');
        expect(phone.hidden).toBe(false);
        expect(phone.querySelector('.sb-editor-tokens__value').textContent).toBe('79 Tokens');
        expect(phone.getAttribute('aria-label')).toBe('79 Tokens (46 Permanent)');
        expect(phone.querySelector('.sb-editor-tokens__value').getAttribute('aria-hidden')).toBe('true');
        expect(phone.classList.contains('is-over-budget')).toBe(false);
        expect(readout.querySelector('.sb-editor-tokens__warning').style.display).toBe('none');

        chrome.setTokens({ total: 5000, overBudget: true });
        expect(readout.classList.contains('is-over-budget')).toBe(true);
        expect(phone.classList.contains('is-over-budget')).toBe(true);
        expect(phone.getAttribute('aria-label')).toBe('5000 Tokens');
        // The context warning goes with the count and keeps the link of the header's.
        expect(phone.querySelector('.sb-editor-tokens__warning').getAttribute('href')).toBe('https://example.test/limits');
        expect(phone.querySelector('.sb-editor-tokens__warning').style.display).toBe('');
        expect(phone.querySelector('[id]')).toBeNull();

        chrome.setTokens(null);
        expect(readout.hidden).toBe(true);
        expect(phone.hidden).toBe(true);
    });

    test('an editor that gives no readout has none, and a header-built readout is placed after the dirty mark', () => {
        makeMedia();
        const { chrome, header } = slotted();
        expect(() => chrome.setTokens({ total: 1 })).not.toThrow();
        expect(header.querySelector('.sb-editor-tokens')).toBeNull();
        const built = slotted({ tokens: {} });
        expect(names(built.header)).toEqual(['back', 'title', 'dirty', undefined, 'more', 'cancel', 'save']);
        expect(built.header.children[3].classList.contains('sb-editor-tokens')).toBe(true);
    });

    test('a changed count reruns the toolbar overflow pass', () => {
        makeMedia();
        const toolbar = document.createElement('div');
        const candidate = document.createElement('button');
        candidate.id = 'overflow_candidate';
        candidate.title = 'Duplicate';
        candidate.getBoundingClientRect = () => ({ width: 40 });
        toolbar.append(candidate);
        const row = toolbar;
        // The toolbar fits until the count is long enough to push it over.
        let width = 100;
        Object.defineProperty(toolbar, 'clientWidth', { get: () => 120 });
        Object.defineProperty(toolbar, 'scrollWidth', { get: () => width });
        const { chrome } = slotted({
            toolbar, overflowCandidates: ['#overflow_candidate'],
            tokens: { element: createTokenReadout(), row: { host: row } },
        });
        chrome.scheduleOverflow();
        expect(candidate.classList.contains('sb-editor-toolbar-collapsed')).toBe(false);
        width = 180;
        chrome.setTokens({ total: 79, permanent: 46 });
        expect(candidate.classList.contains('sb-editor-toolbar-collapsed')).toBe(true);
        width = 100;
        chrome.setTokens({ total: 1 });
        expect(candidate.classList.contains('sb-editor-toolbar-collapsed')).toBe(false);
    });

    test('the dirty mark is the shared dot named by its label, and the summary row and label row helpers place their parts', () => {
        const mark = createDirtyMark('sb-test-dirty');
        expect(mark.hidden).toBe(true);
        expect(mark.className).toBe('sb-editor-dirty sb-test-dirty');
        expect(mark.querySelector('.sb-editor-dirty-dot').getAttribute('aria-hidden')).toBe('true');
        expect(mark.getAttribute('aria-label')).toBe('Unsaved changes');

        const host = document.createElement('div');
        const summary = document.createElement('button');
        host.append(summary);
        const row = createSummaryRow(summary);
        expect(host.firstElementChild).toBe(row);
        expect(row.firstElementChild).toBe(summary);
        expect(summary.classList.contains('sb-editor-summary')).toBe(true);
        setSummaryText(summary, 'Persona', 'In-chat @ Depth · Depth 7 ›');
        expect(summary.textContent).toBe('In-chat @ Depth · Depth 7 ›');
        expect(summary.getAttribute('aria-label')).toBe('Persona: In-chat @ Depth · Depth 7 ›');

        const section = document.createElement('section');
        const labelRow = Object.assign(document.createElement('div'), { className: 'ds-pref-group-header' });
        section.append(labelRow);
        const expand = document.createElement('button');
        expect(attachToLabelRow(section, expand)).toBe(true);
        expect(labelRow.classList.contains('sb-editor-label-row')).toBe(true);
        expect(labelRow.lastElementChild).toBe(expand);
        expect(attachToLabelRow(document.createElement('section'), expand)).toBe(false);

        const field = document.createElement('div');
        const fieldLabelRow = Object.assign(document.createElement('div'), { className: 'sb-editor-label-row' });
        const unrelated = Object.assign(document.createElement('div'), { className: 'sb-editor-label-row' });
        field.append(fieldLabelRow, document.createElement('textarea'), unrelated);
        const extra = document.createElement('button');
        expect(attachToLabelRow(field, extra)).toBe(true);
        expect(fieldLabelRow.lastElementChild).toBe(extra);
        expect(unrelated.childElementCount).toBe(0);
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
    test('removes control listeners', () => {
        makeMedia();
        const { chrome, controls, handlers } = makeChrome();
        chrome.dispose();
        controls.back.click();
        controls.save.disabled = false;
        controls.save.click();
        expect(handlers.onBack).not.toHaveBeenCalled();
        expect(handlers.onSave).not.toHaveBeenCalled();
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

    test('the header and toolbar stay in view while the sheet scrolls down, on a phone too', () => {
        const media = makeMedia();
        media.matches = true;
        const { header, content } = makeChrome();
        Object.defineProperty(content, 'scrollHeight', { value: 2000 });
        Object.defineProperty(content, 'clientHeight', { value: 400 });
        for (const top of [100, 500, 900]) {
            content.scrollTop = top;
            content.dispatchEvent(new Event('scroll'));
        }
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

    test('both guard selectors cover the settings page close button', () => {
        const close = document.createElement('button');
        close.id = 'sb-settings-close';
        expect(close.matches(CHARACTER_TAB_GUARD_SELECTOR)).toBe(true);
        expect(close.matches(characterTabGuardSelector('persona'))).toBe(true);
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
