/** @jest-environment jsdom */
/* eslint-disable playwright/no-standalone-expect, playwright/prefer-web-first-assertions -- Jest/jsdom assertions. */
import { jest, describe, test, expect, beforeEach, afterEach } from '@jest/globals';

const openActionMenu = jest.fn();
const closeActionMenu = jest.fn();
const closePicker = jest.fn();
await jest.unstable_mockModule('../../public/scripts/sillybunny-action-menu.js', () => ({
    openActionMenu, closeActionMenu, MOBILE_QUERY: '(max-width: 768px)', positionPopover: jest.fn(),
}));
await jest.unstable_mockModule('../../public/scripts/sillybunny-editor/picker.js', () => ({ closePicker, openPicker: jest.fn() }));
await jest.unstable_mockModule('../../public/scripts/i18n.js', () => ({
    t: (strings, ...values) => strings.reduce((text, part, index) => text + part + (values[index] ?? ''), ''),
    translate: text => text,
}));

const { openDialog, openAlert, getTopmostDialog, hostOverlayLayer, bindSheetGestures } = await import('../../public/scripts/sillybunny-editor/dialog.js');
const { OVERLAY_SHEET_QUERY, LAYOUT_MOBILE_QUERY } = await import('../../public/scripts/sillybunny-editor/breakpoints.js');

const settle = async () => { for (let index = 0; index < 10; index++) await Promise.resolve(); };
let sheet;
let opener;

function pointer(node, type, clientY, timeStamp = 0) {
    const event = new MouseEvent(type, { bubbles: true, clientY });
    Object.defineProperty(event, 'timeStamp', { value: timeStamp });
    node.dispatchEvent(event);
}

function escape(host) {
    const event = new Event('cancel', { cancelable: true });
    host.dispatchEvent(event);
    return event;
}

beforeEach(() => {
    jest.clearAllMocks();
    sheet = { matches: false, listeners: new Set(), addEventListener(_type, listener) { this.listeners.add(listener); }, removeEventListener(_type, listener) { this.listeners.delete(listener); } };
    window.matchMedia = query => (query === OVERLAY_SHEET_QUERY ? sheet : { matches: false, addEventListener() {}, removeEventListener() {} });
    HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
    HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); };
    opener = document.createElement('button');
    document.body.append(opener);
    opener.focus();
});

afterEach(() => {
    document.body.replaceChildren();
});

describe('breakpoints', () => {
    test('the overlay sheet query is the AdwDialog condition and layout stays at 768px', () => {
        expect(OVERLAY_SHEET_QUERY).toBe('(max-width: 450px), (max-height: 360px)');
        expect(LAYOUT_MOBILE_QUERY).toBe('(max-width: 768px)');
    });
});

describe('openDialog structure', () => {
    test.each(['dialog', 'window'])('%s tier: native modal host, scrim, surface, header and scrolling body', tier => {
        const content = document.createElement('p');
        const dialog = openDialog({ tier, title: 'Title', subtitle: 'Sub', content, className: 'my-surface' });
        expect(dialog.root).toBeInstanceOf(HTMLDialogElement);
        expect(dialog.root.open).toBe(true);
        expect(dialog.root.dataset.tier).toBe(tier);
        expect(dialog.root.dataset.presentation).toBe('floating');
        expect(dialog.surface.classList.contains(`sb-dialog--${tier}`)).toBe(true);
        expect(dialog.surface.classList.contains('my-surface')).toBe(true);
        expect(dialog.root.querySelector(':scope > .sb-dialog-scrim')).not.toBeNull();
        expect(content.parentElement).toBe(dialog.body);
        const title = dialog.header.querySelector('.sb-dialog__title');
        expect(title.textContent).toBe('Title');
        expect(dialog.root.getAttribute('aria-labelledby')).toBe(title.id);
        expect(dialog.header.querySelector('.sb-dialog__subtitle').textContent).toBe('Sub');
        expect(getTopmostDialog()).toBe(dialog.root);
    });

    test('content can be a builder that receives the body', () => {
        const dialog = openDialog({ title: 'T', content: body => body.append(Object.assign(document.createElement('span'), { id: 'built' })) });
        expect(dialog.body.querySelector('#built')).not.toBeNull();
    });

    test('immediate apply: Close at the end, optional ⋯ before it, no responses', () => {
        const sections = [{ items: [] }];
        const menu = jest.fn(() => sections);
        const dialog = openDialog({ title: 'T', menu, menuLabel: 'Things' });
        const end = dialog.header.querySelector('.sb-dialog__header-end');
        expect([...end.children].map(node => node.className)).toEqual([
            'sb-dialog__icon-button sb-dialog__menu', 'sb-dialog__icon-button sb-dialog__close',
        ]);
        expect(dialog.header.querySelector('.sb-dialog__header-start').children).toHaveLength(0);
        end.querySelector('.sb-dialog__menu').click();
        expect(menu).toHaveBeenCalledWith(end.querySelector('.sb-dialog__menu'));
        expect(openActionMenu).toHaveBeenCalledWith(expect.objectContaining({ sections, title: 'Things', bounds: dialog.surface }));
    });

    test('explicit action: Cancel at the start, suggested affirmative at the end, no Close; extras in a bottom bar', () => {
        const dialog = openDialog({ title: 'T', responses: {
            affirmative: { id: 'save', label: 'Save', enabled: false },
            extra: [{ id: 'discard', label: 'Discard' }],
        } });
        const start = dialog.header.querySelector('.sb-dialog__header-start');
        const end = dialog.header.querySelector('.sb-dialog__header-end');
        expect(start.querySelector('[data-response="cancel"]').textContent).toBe('Cancel');
        const save = end.querySelector('[data-response="save"]');
        expect(save.classList.contains('is-suggested')).toBe(true);
        expect(save.disabled).toBe(true);
        dialog.setResponseEnabled('save', true);
        expect(save.disabled).toBe(false);
        expect(dialog.header.querySelector('.sb-dialog__close')).toBeNull();
        expect(dialog.surface.querySelector('.sb-dialog__bottom-bar [data-response="discard"]')).not.toBeNull();
    });

    test('destructive appearance, setTitle and setSubtitle', () => {
        const dialog = openDialog({ title: 'T', responses: { affirmative: { label: 'Delete', appearance: 'destructive' } } });
        expect(dialog.header.querySelector('[data-response="affirmative"]').classList.contains('is-destructive')).toBe(true);
        dialog.setTitle('New');
        dialog.setSubtitle('');
        expect(dialog.header.querySelector('.sb-dialog__title').textContent).toBe('New');
        expect(dialog.header.querySelector('.sb-dialog__subtitle').hidden).toBe(true);
    });
});

describe('openDialog closing', () => {
    test.each([
        ['close button', dialog => dialog.header.querySelector('.sb-dialog__close').click(), 'close', 'close'],
        ['Escape', dialog => escape(dialog.root), 'escape', 'close'],
        ['scrim', dialog => dialog.root.querySelector('.sb-dialog-scrim').click(), 'scrim', 'close'],
        ['programmatic', dialog => dialog.close(), 'programmatic', 'close'],
    ])('%s goes through canClose and resolves closed', async (_name, act, reason, response) => {
        const canClose = jest.fn(() => true);
        const dialog = openDialog({ title: 'T', canClose });
        act(dialog);
        expect(canClose).toHaveBeenCalledWith(reason);
        await expect(dialog.closed).resolves.toEqual({ response });
        expect(dialog.root.isConnected).toBe(false);
        expect(document.activeElement).toBe(opener);
    });

    test('explicit responses resolve their ids; Escape resolves cancel', async () => {
        const reasons = [];
        const save = openDialog({ title: 'T', canClose: reason => reasons.push(reason), responses: { affirmative: { id: 'save', label: 'Save' } } });
        save.header.querySelector('[data-response="save"]').click();
        await expect(save.closed).resolves.toEqual({ response: 'save' });
        const cancel = openDialog({ title: 'T', canClose: reason => reasons.push(reason), responses: { affirmative: { label: 'Save' } } });
        escape(cancel.root);
        await expect(cancel.closed).resolves.toEqual({ response: 'cancel' });
        const extra = openDialog({ title: 'T', canClose: reason => reasons.push(reason), responses: { affirmative: { label: 'Save' }, extra: [{ id: 'other', label: 'Other' }] } });
        extra.surface.querySelector('[data-response="other"]').click();
        await expect(extra.closed).resolves.toEqual({ response: 'other' });
        expect(reasons).toEqual(['affirmative', 'escape', 'other']);
    });

    test('a false canClose vetoes every route and keeps the dialog open', async () => {
        const dialog = openDialog({ title: 'T', canClose: () => false });
        expect(dialog.close()).toBe(false);
        escape(dialog.root);
        dialog.root.querySelector('.sb-dialog-scrim').click();
        dialog.header.querySelector('.sb-dialog__close').click();
        await settle();
        expect(dialog.root.open).toBe(true);
        expect(dialog.isOpen).toBe(true);
        dialog.forceClose();
        await expect(dialog.closed).resolves.toEqual({ response: 'close' });
    });

    test('an async canClose returns a promise and closes once approved', async () => {
        let approve;
        const dialog = openDialog({ title: 'T', canClose: () => new Promise(resolve => approve = resolve) });
        const result = dialog.close();
        expect(dialog.close()).toBe(false);
        approve(true);
        await expect(result).resolves.toBe(true);
        await expect(dialog.closed).resolves.toEqual({ response: 'close' });
    });

    test('Escape is prevented from closing the native dialog directly', () => {
        const dialog = openDialog({ title: 'T', canClose: () => false });
        expect(escape(dialog.root).defaultPrevented).toBe(true);
    });

    test('a native close without a cancel event reopens the modal and asks canClose', () => {
        const canClose = jest.fn(() => false);
        const dialog = openDialog({ title: 'T', canClose });
        dialog.root.removeAttribute('open');
        dialog.root.dispatchEvent(new Event('close'));
        expect(dialog.root.open).toBe(true);
        expect(canClose).toHaveBeenCalledWith('escape');
    });

    test('closing closes menus and pickers and releases hosted layers to the body', async () => {
        const dialog = openDialog({ title: 'T' });
        const layer = document.createElement('div');
        expect(hostOverlayLayer(layer)).toBe(dialog.root);
        expect(layer.parentElement).toBe(dialog.root);
        dialog.close();
        await dialog.closed;
        expect(closeActionMenu).toHaveBeenCalledWith({ animate: false });
        expect(closePicker).toHaveBeenCalled();
        expect(layer.parentElement).toBe(document.body);
    });

    test('hostOverlayLayer falls back to the body with no open dialog', () => {
        const layer = document.createElement('div');
        expect(hostOverlayLayer(layer)).toBe(document.body);
        expect(layer.hasAttribute('data-sb-overlay-layer')).toBe(true);
    });
});

describe('openDialog focus', () => {
    test('initial focus: initialFocus, else the search field, else the first body control', () => {
        const target = document.createElement('input');
        const first = openDialog({ title: 'T', content: target, initialFocus: () => target });
        expect(document.activeElement).toBe(target);
        first.forceClose();
        const searched = openDialog({ title: 'T', search: { onChange() {} }, content: document.createElement('input') });
        expect(document.activeElement).toBe(searched.surface.querySelector('.sb-dialog__search-input'));
        searched.forceClose();
        const field = document.createElement('input');
        openDialog({ title: 'T', content: field });
        expect(document.activeElement).toBe(field);
    });

    test('search reports changes, Escape clears it first and then closes', async () => {
        const onChange = jest.fn();
        const dialog = openDialog({ title: 'T', search: { onChange, placeholder: 'Find' } });
        const input = dialog.surface.querySelector('.sb-dialog__search-input');
        expect(input.placeholder).toBe('Find');
        expect(input.getAttribute('aria-label')).toBe('Search');
        input.value = 'abc';
        input.dispatchEvent(new Event('input'));
        expect(onChange).toHaveBeenCalledWith('abc');
        expect(dialog.search.query).toBe('abc');
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
        expect(input.value).toBe('');
        expect(dialog.isOpen).toBe(true);
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
        await expect(dialog.closed).resolves.toEqual({ response: 'close' });
    });
});

describe('bottom sheets', () => {
    test('the presentation follows the overlay query, including live changes', () => {
        sheet.matches = true;
        const dialog = openDialog({ title: 'T' });
        expect(dialog.root.dataset.presentation).toBe('sheet');
        sheet.matches = false;
        sheet.listeners.forEach(listener => listener());
        expect(dialog.root.dataset.presentation).toBe('floating');
    });

    test('the scrim does not close a sheet', () => {
        sheet.matches = true;
        const canClose = jest.fn(() => true);
        const dialog = openDialog({ title: 'T', canClose });
        dialog.root.querySelector('.sb-dialog-scrim').click();
        expect(canClose).not.toHaveBeenCalled();
        expect(dialog.isOpen).toBe(true);
    });

    test('a long swipe from the handle asks canClose("swipe") and springs back when vetoed', () => {
        sheet.matches = true;
        const canClose = jest.fn(() => false);
        const dialog = openDialog({ title: 'T', canClose });
        const handle = dialog.surface.querySelector('.sb-dialog__handle');
        pointer(handle, 'pointerdown', 10, 0);
        pointer(handle, 'pointermove', 80, 50);
        expect(dialog.surface.style.transform).toBe('translateY(70px)');
        pointer(handle, 'pointerup', 160, 100);
        expect(canClose).toHaveBeenCalledWith('swipe');
        expect(dialog.isOpen).toBe(true);
        expect(dialog.surface.style.transform).toBe('');
    });

    test('a swipe from the header closes; drags that start on header buttons do not', async () => {
        sheet.matches = true;
        const dialog = openDialog({ title: 'T' });
        const close = dialog.header.querySelector('.sb-dialog__close');
        pointer(close, 'pointerdown', 10, 0);
        pointer(close, 'pointerup', 400, 10);
        expect(dialog.isOpen).toBe(true);
        const title = dialog.header.querySelector('.sb-dialog__title');
        pointer(title, 'pointerdown', 10, 0);
        pointer(title, 'pointerup', 400, 10);
        await expect(dialog.closed).resolves.toEqual({ response: 'close' });
    });

    test('a short slow drag springs back without asking to close', () => {
        const surface = document.createElement('div');
        document.body.append(surface);
        Object.defineProperty(surface, 'getBoundingClientRect', { value: () => ({ height: 500 }) });
        const requestClose = jest.fn();
        bindSheetGestures({ surface, targets: [surface], isActive: () => true, requestClose });
        pointer(surface, 'pointerdown', 0, 0);
        pointer(surface, 'pointermove', 50, 500);
        pointer(surface, 'pointerup', 100, 1000);
        expect(requestClose).not.toHaveBeenCalled();
        pointer(surface, 'pointerdown', 0, 0);
        pointer(surface, 'pointerup', 200, 1000);
        expect(requestClose).toHaveBeenCalledWith(200);
    });

    test('starting a sheet drag cancels pointerdown so the focused field keeps focus', () => {
        sheet.matches = true;
        const dialog = openDialog({ title: 'T' });
        const down = new MouseEvent('pointerdown', { bubbles: true, cancelable: true, clientY: 0 });
        dialog.surface.querySelector('.sb-dialog__handle').dispatchEvent(down);
        expect(down.defaultPrevented).toBe(true);
        const onButton = new MouseEvent('pointerdown', { bubbles: true, cancelable: true, clientY: 0 });
        dialog.header.querySelector('.sb-dialog__close').dispatchEvent(onButton);
        expect(onButton.defaultPrevented).toBe(false);
    });

    test('inactive gestures (floating) are ignored', () => {
        const dialog = openDialog({ title: 'T' });
        const handle = dialog.surface.querySelector('.sb-dialog__handle');
        pointer(handle, 'pointerdown', 0, 0);
        pointer(handle, 'pointerup', 400, 10);
        expect(dialog.isOpen).toBe(true);
    });
});

describe('pages', () => {
    test('an immediate-apply page shows Back and no Close; Back pops it and returns focus', async () => {
        const dialog = openDialog({ title: 'Root', content: document.createElement('button') });
        const trigger = dialog.body.querySelector('button');
        trigger.focus();
        const page = dialog.push({ title: 'Child', content: document.createElement('input') });
        expect(dialog.root.getAttribute('aria-labelledby')).toBe(page.header.querySelector('.sb-dialog__title').id);
        expect(page.header.querySelector('.sb-dialog__back')).not.toBeNull();
        expect(page.header.querySelector('.sb-dialog__close')).toBeNull();
        expect(dialog.page.inert).toBe(true);
        expect(dialog.page.hidden).toBe(true);
        page.header.querySelector('.sb-dialog__back').click();
        await expect(page.closed).resolves.toEqual({ response: 'back' });
        expect(page.page.isConnected).toBe(false);
        expect(dialog.page.hidden).toBe(false);
        expect(dialog.page.inert).toBe(false);
        expect(document.activeElement).toBe(trigger);
        expect(dialog.isOpen).toBe(true);
    });

    test('a page with responses shows Cancel as Back and its affirmative; Escape pops before closing', async () => {
        const dialog = openDialog({ title: 'Root' });
        const page = dialog.push({ title: 'Child', responses: { affirmative: { id: 'apply', label: 'Apply' } } });
        expect(page.header.querySelector('.sb-dialog__back')).toBeNull();
        expect(page.header.querySelector('.sb-dialog__header-start [data-response="cancel"]')).not.toBeNull();
        escape(dialog.root);
        await expect(page.closed).resolves.toEqual({ response: 'cancel' });
        expect(dialog.isOpen).toBe(true);
        const second = dialog.push({ title: 'Child', responses: { affirmative: { id: 'apply', label: 'Apply' } } });
        second.header.querySelector('[data-response="apply"]').click();
        await expect(second.closed).resolves.toEqual({ response: 'apply' });
    });

    test('a page canClose can veto popping', async () => {
        const dialog = openDialog({ title: 'Root' });
        const page = dialog.push({ title: 'Child', canClose: () => false });
        page.header.querySelector('.sb-dialog__back').click();
        await settle();
        expect(page.page.isConnected).toBe(true);
        page.forceClose();
        await expect(page.closed).resolves.toEqual({ response: 'back' });
    });

    test('openDialog while a frame is on top pushes a page into it', async () => {
        const parent = openDialog({ title: 'Root' });
        const child = openDialog({ tier: 'window', title: 'Nested' });
        expect(document.querySelectorAll('.sb-dialog-host')).toHaveLength(1);
        expect(child.root).toBe(parent.root);
        expect(child.page.parentElement).toBe(parent.page.parentElement);
        child.close();
        await expect(child.closed).resolves.toEqual({ response: 'back' });
    });

    test('pushed page search Escape pops the page when empty', async () => {
        const dialog = openDialog({ title: 'Root' });
        const page = dialog.push({ title: 'Child', search: { onChange() {} } });
        const input = page.page.querySelector('.sb-dialog__search-input');
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
        await expect(page.closed).resolves.toEqual({ response: 'back' });
    });
});

describe('openAlert', () => {
    test('alertdialog with labelled heading, described body, extra child and Cancel-first responses', async () => {
        const extra = document.createElement('label');
        const result = openAlert({
            heading: 'Delete Folder?', body: 'Characters stay.', extra,
            responses: [{ id: 'cancel', label: 'Cancel' }, { id: 'delete', label: 'Delete', appearance: 'destructive' }],
        });
        const host = getTopmostDialog();
        expect(host.getAttribute('role')).toBe('alertdialog');
        expect(host.dataset.tier).toBe('alert');
        const heading = host.querySelector('.sb-dialog__heading');
        expect(heading.textContent).toBe('Delete Folder?');
        expect(host.getAttribute('aria-labelledby')).toBe(heading.id);
        expect(host.querySelector(`#${host.getAttribute('aria-describedby')}`).textContent).toBe('Characters stay.');
        expect(extra.closest('.sb-dialog__extra')).not.toBeNull();
        const buttons = [...host.querySelectorAll('.sb-dialog__responses > button')];
        expect(buttons.map(button => button.dataset.response)).toEqual(['cancel', 'delete']);
        expect(buttons[1].classList.contains('is-destructive')).toBe(true);
        expect(document.activeElement).toBe(buttons[0]);
        buttons[1].click();
        await expect(result).resolves.toBe('delete');
        expect(host.isConnected).toBe(false);
        expect(document.activeElement).toBe(opener);
    });

    test('Escape and the scrim resolve the close response', async () => {
        const first = openAlert({ heading: 'H', responses: [{ id: 'no', label: 'No' }, { id: 'yes', label: 'Yes' }], closeResponse: 'no' });
        expect(escape(getTopmostDialog()).defaultPrevented).toBe(true);
        await expect(first).resolves.toBe('no');
        const second = openAlert({ heading: 'H', responses: [{ id: 'cancel', label: 'Cancel' }] });
        getTopmostDialog().querySelector('.sb-dialog-scrim').click();
        await expect(second).resolves.toBe('cancel');
    });

    test('the default response is focused and activated by Return outside buttons', async () => {
        const field = document.createElement('input');
        const result = openAlert({ heading: 'H', extra: field, defaultResponse: 'ok', responses: [{ id: 'cancel', label: 'Cancel' }, { id: 'ok', label: 'OK', appearance: 'suggested' }] });
        const host = getTopmostDialog();
        expect(document.activeElement).toBe(host.querySelector('[data-response="ok"]'));
        field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
        await expect(result).resolves.toBe('ok');
    });

    test('an alert opens above an open dialog instead of becoming a page', async () => {
        const dialog = openDialog({ title: 'Window', tier: 'window' });
        const result = openAlert({ heading: 'Sure?', responses: [{ id: 'cancel', label: 'Cancel' }] });
        expect(document.querySelectorAll('dialog[open]')).toHaveLength(2);
        expect(getTopmostDialog()).not.toBe(dialog.root);
        escape(getTopmostDialog());
        await expect(result).resolves.toBe('cancel');
        expect(dialog.isOpen).toBe(true);
    });

    test('alerts stack their responses in sheets', () => {
        sheet.matches = true;
        void openAlert({ heading: 'H', responses: [{ id: 'cancel', label: 'Cancel' }, { id: 'ok', label: 'OK' }] });
        expect(getTopmostDialog().querySelector('.sb-dialog__responses').classList.contains('is-stacked')).toBe(true);
    });
});
