/** @jest-environment jsdom */
/* global globalThis */
/* eslint-disable playwright/prefer-web-first-assertions -- This suite uses Jest/jsdom, not Playwright locators. */
import { jest, describe, test, expect, afterEach } from '@jest/globals';
import { createSpinner, createStatusPage, setIconBusy, spinnerMarkup, STATUS_PAGE_LOADING_DELAY, STATUS_PAGE_STATES } from '../../public/scripts/sillybunny-editor/status-page.js';

describe('createStatusPage', () => {
    test('builds the status page with decorative icon, title and description', () => {
        const { element } = createStatusPage({ icon: 'book', title: 'Empty library', description: 'Choose a book.' });
        expect(element.tagName).toBe('DIV');
        expect(element.className).toBe('sb-status-page');
        expect(element.getAttribute('role')).toBe('status');
        expect(element.querySelector('i').classList.contains('fa-solid')).toBe(true);
        expect(element.querySelector('i').classList.contains('fa-book')).toBe(true);
        expect(element.querySelector('i').classList.contains('sb-status-page__icon')).toBe(true);
        expect(element.querySelector('i').getAttribute('aria-hidden')).toBe('true');
        expect(element.querySelector('h3').className).toBe('sb-status-page__title title-1');
        expect(element.querySelector('h3').textContent).toBe('Empty library');
        expect(element.querySelector('p').className).toBe('sb-status-page__description');
        expect(element.querySelector('p').textContent).toBe('Choose a book.');
        expect(element.querySelector('.sb-status-page__actions')).toBeNull();
    });

    test('supports compact mode and omits an absent description', () => {
        const { element } = createStatusPage({ icon: 'book', title: 'Library', compact: true });
        expect(element.classList.contains('sb-status-page--compact')).toBe(true);
        expect(element.querySelector('h3').classList.contains('title-2')).toBe(true);
        expect(element.querySelector('p')).toBeNull();
    });

    test('creates native action buttons, with primary state and callbacks', () => {
        const onPrimary = jest.fn();
        const onSecondary = jest.fn();
        const { element } = createStatusPage({
            icon: 'book', title: 'Library', actions: [
                { label: 'Create', primary: true, onActivate: onPrimary },
                { label: 'Import', onActivate: onSecondary },
            ],
        });
        const actions = element.querySelector('.sb-status-page__actions');
        const [primary, secondary] = actions.children;
        expect(primary.tagName).toBe('BUTTON');
        expect(primary.type).toBe('button');
        expect(primary.className).toBe('menu_button sb-status-page__action menu_button_primary is-suggested');
        expect(primary.textContent).toBe('Create');
        expect(secondary.className).toBe('menu_button sb-status-page__action');
        expect(secondary.textContent).toBe('Import');
        primary.click();
        secondary.click();
        expect(onPrimary).toHaveBeenCalledTimes(1);
        expect(onSecondary).toHaveBeenCalledTimes(1);
    });

    test('updates icon, title and description in place without rebuilding action buttons', () => {
        const onActivate = jest.fn();
        const page = createStatusPage({ icon: 'book', title: 'Library', actions: [{ label: 'Create', onActivate }] });
        const button = page.element.querySelector('button');
        const heading = page.element.querySelector('h3');
        page.update({ icon: 'circle-info', title: 'Updated', description: 'New description' });
        expect(page.element.querySelector('.sb-status-page__icon').classList.contains('fa-book')).toBe(false);
        expect(page.element.querySelector('.sb-status-page__icon').classList.contains('fa-circle-info')).toBe(true);
        expect(page.element.querySelector('h3')).toBe(heading);
        expect(heading.textContent).toBe('Updated');
        expect(heading.nextSibling.textContent).toBe('New description');
        expect(heading.nextSibling.nextSibling.className).toBe('sb-status-page__actions');
        expect(page.element.querySelector('button')).toBe(button);
        button.click();
        expect(onActivate).toHaveBeenCalledTimes(1);
    });

    test('partial updates preserve omitted properties and can remove or restore descriptions', () => {
        const page = createStatusPage({ icon: 'book', title: 'Library', description: 'Original' });
        page.update({ title: 'Updated' });
        expect(page.element.querySelector('p').textContent).toBe('Original');
        expect(page.element.querySelector('i').classList.contains('fa-book')).toBe(true);
        page.update({ description: '' });
        expect(page.element.querySelector('p')).toBeNull();
        expect(page.element.querySelector('h3').textContent).toBe('Updated');
        page.update({ description: 'Restored' });
        expect(page.element.querySelectorAll('p')).toHaveLength(1);
        expect(page.element.querySelector('p').textContent).toBe('Restored');
        page.update({ description: 'Changed' });
        expect(page.element.querySelectorAll('p')).toHaveLength(1);
        expect(page.element.querySelector('p').textContent).toBe('Changed');
    });

    test('renders dynamic text and icon names without HTML injection', () => {
        const payload = '<img src=x onerror=alert(1)>';
        const page = createStatusPage({ icon: payload, title: payload, description: payload, actions: [{ label: payload }] });
        expect(page.element.querySelector('img')).toBeNull();
        expect(page.element.querySelector('h3').textContent).toBe(payload);
        expect(page.element.querySelector('p').textContent).toBe(payload);
        expect(page.element.querySelector('button').textContent).toBe(payload);
        page.update({ title: '<b>Updated</b>', description: '<i>Updated</i>' });
        expect(page.element.querySelector('h3').textContent).toBe('<b>Updated</b>');
        expect(page.element.querySelector('p').textContent).toBe('<i>Updated</i>');
        expect(page.element.querySelector('h3').children).toHaveLength(0);
    });
});

describe('createStatusPage states', () => {
    afterEach(() => {
        jest.useRealTimers();
        document.body.replaceChildren();
        document.head.replaceChildren();
        delete globalThis.SillyBunnyAssets;
    });

    test.each([
        ['empty', 'inbox'],
        ['no-results', 'magnifying-glass'],
        ['error', 'triangle-exclamation'],
        ['unavailable', 'ban'],
    ])('%s sets data-state and its default icon, and an icon you pass wins', (state, icon) => {
        const page = createStatusPage({ state, title: 'Title' });
        expect(page.element.dataset.state).toBe(state);
        expect(page.element.querySelector('i').classList.contains(`fa-${icon}`)).toBe(true);
        expect(page.element.querySelector('i').getAttribute('aria-hidden')).toBe('true');
        expect(page.element.querySelector('.sb-spinner')).toBeNull();
        expect(page.element.hidden).toBe(false);
        const named = createStatusPage({ state, icon: 'book', title: 'Title' });
        expect(named.element.querySelector('i').classList.contains('fa-book')).toBe(true);
        expect(named.element.querySelector('i').classList.contains(`fa-${icon}`)).toBe(false);
    });

    test('names every state and refuses an unknown one', () => {
        expect(STATUS_PAGE_STATES).toEqual(['empty', 'no-results', 'loading', 'error', 'unavailable']);
        expect(() => createStatusPage({ state: 'pending', title: 'Title' })).toThrow(RangeError);
        const page = createStatusPage({ state: 'empty', title: 'Title' });
        expect(() => page.update({ state: 'pending' })).toThrow(RangeError);
    });

    test('a page without a state keeps its markup and shows no data-state', () => {
        const { element } = createStatusPage({ icon: 'book', title: 'Library' });
        expect(element.hasAttribute('data-state')).toBe(false);
        expect(element.className).toBe('sb-status-page');
    });

    test('the page is labelled by its title and described by its description, and its icon is hidden', () => {
        const { element } = createStatusPage({ state: 'empty', title: 'Library', description: 'Choose a book.' });
        const heading = element.querySelector('h3');
        const description = element.querySelector('p');
        expect(element.getAttribute('aria-labelledby')).toBe(heading.id);
        expect(element.getAttribute('aria-describedby')).toBe(description.id);
        expect(new Set([heading.id, description.id]).size).toBe(2);
        const bare = createStatusPage({ state: 'empty', title: 'Library' });
        expect(bare.element.hasAttribute('aria-describedby')).toBe(false);
        bare.update({ description: 'Later' });
        expect(bare.element.getAttribute('aria-describedby')).toBe(bare.element.querySelector('p').id);
        bare.update({ description: '' });
        expect(bare.element.hasAttribute('aria-describedby')).toBe(false);
    });

    test('an action can carry an id for code that looks the button up', () => {
        const { element } = createStatusPage({ state: 'empty', title: 'Library', actions: [{ id: 'create-library', label: 'Create' }] });
        expect(element.querySelector('button').id).toBe('create-library');
    });

    test('loading is the compact set with the shared spinner in place of the icon', () => {
        const { element } = createStatusPage({ state: 'loading', title: 'Loading Documents', delay: 0 });
        expect(element.dataset.state).toBe('loading');
        expect(element.classList.contains('sb-status-page--spinner')).toBe(true);
        expect(element.classList.contains('sb-status-page--compact')).toBe(true);
        expect(element.querySelector('i')).toBeNull();
        const spinner = element.querySelector('.sb-spinner');
        expect(spinner.tagName).toBe('SPAN');
        expect(spinner.getAttribute('role')).toBe('progressbar');
        expect(spinner.getAttribute('aria-busy')).toBe('true');
        expect(spinner.getAttribute('aria-labelledby')).toBe(element.querySelector('h3').id);
        expect(element.querySelector('h3').className).toBe('sb-status-page__title title-2');
        expect(element.firstElementChild).toBe(spinner);
    });

    test('a loading page keeps one action, such as Cancel, and no more', () => {
        const onCancel = jest.fn();
        const { element } = createStatusPage({ state: 'loading', title: 'Loading', delay: 0, actions: [{ label: 'Cancel', onActivate: onCancel }, { label: 'Other' }] });
        const buttons = element.querySelectorAll('button');
        expect(buttons).toHaveLength(1);
        buttons[0].click();
        expect(onCancel).toHaveBeenCalledTimes(1);
    });

    test('a loading page shows only after the delay, so a quick load shows nothing', () => {
        jest.useFakeTimers();
        const { element } = createStatusPage({ state: 'loading', title: 'Loading' });
        expect(element.hidden).toBe(true);
        jest.advanceTimersByTime(STATUS_PAGE_LOADING_DELAY - 1);
        expect(element.hidden).toBe(true);
        jest.advanceTimersByTime(1);
        expect(element.hidden).toBe(false);
        expect(createStatusPage({ state: 'loading', title: 'Loading', delay: 0 }).element.hidden).toBe(false);
        expect(createStatusPage({ state: 'empty', title: 'Empty' }).element.hidden).toBe(false);
    });

    test('releasing a loading page before the delay keeps it hidden', () => {
        jest.useFakeTimers();
        const page = createStatusPage({ state: 'loading', title: 'Loading' });
        page.release();
        jest.advanceTimersByTime(STATUS_PAGE_LOADING_DELAY * 2);
        expect(page.element.hidden).toBe(true);
    });

    test('a loading page marks its region busy and labels it, until it is released', () => {
        const region = document.createElement('section');
        const page = createStatusPage({ state: 'loading', title: 'Loading', delay: 0, busy: region });
        expect(region.getAttribute('aria-busy')).toBe('true');
        expect(region.getAttribute('aria-labelledby')).toBe(page.element.querySelector('h3').id);
        page.release();
        expect(region.hasAttribute('aria-busy')).toBe(false);
        expect(region.hasAttribute('aria-labelledby')).toBe(false);
        page.update({ state: 'loading' });
        expect(region.getAttribute('aria-busy')).toBe('true');
        page.update({ state: 'loading' });
        page.release();
        expect(region.hasAttribute('aria-labelledby')).toBe(false);
    });

    test('a region that already has a name keeps it', () => {
        const region = document.createElement('section');
        region.setAttribute('aria-label', 'Characters');
        const page = createStatusPage({ state: 'loading', title: 'Loading', delay: 0, busy: region });
        expect(region.getAttribute('aria-label')).toBe('Characters');
        expect(region.hasAttribute('aria-labelledby')).toBe(false);
        page.release();
        expect(region.getAttribute('aria-label')).toBe('Characters');
    });

    test('a loading page becomes an error in place: the spinner goes, the region is released and the page shows at once', () => {
        jest.useFakeTimers();
        const region = document.createElement('section');
        const page = createStatusPage({ state: 'loading', title: 'Loading', busy: region });
        expect(page.element.hidden).toBe(true);
        page.update({ state: 'error', title: 'Error', description: 'It failed.' });
        expect(page.element.hidden).toBe(false);
        expect(page.element.dataset.state).toBe('error');
        expect(page.element.querySelector('.sb-spinner')).toBeNull();
        expect(page.element.querySelector('i').classList.contains('fa-triangle-exclamation')).toBe(true);
        expect(page.element.classList.contains('sb-status-page--spinner')).toBe(false);
        expect(region.hasAttribute('aria-busy')).toBe(false);
        expect(page.element.querySelector('h3').textContent).toBe('Error');
        expect(page.element.querySelector('p').textContent).toBe('It failed.');
        jest.advanceTimersByTime(STATUS_PAGE_LOADING_DELAY * 2);
        expect(page.element.hidden).toBe(false);
        page.update({ state: 'loading', title: 'Loading' });
        expect(page.element.querySelector('i')).toBeNull();
        expect(page.element.querySelectorAll('.sb-spinner')).toHaveLength(1);
        expect(page.element.firstElementChild.classList.contains('sb-spinner')).toBe(true);
    });

    test('a page that was hidden by its owner stays hidden through an update', () => {
        const page = createStatusPage({ state: 'empty', title: 'Library' });
        page.element.hidden = true;
        page.update({ state: 'no-results', title: 'No results' });
        expect(page.element.hidden).toBe(true);
    });

    test('the page stays invisible until the deferred sheet that draws it has loaded', async () => {
        let finish;
        const loading = new Promise(resolve => { finish = resolve; });
        globalThis.SillyBunnyAssets = { loadStylesheetAsync: jest.fn(() => loading) };
        const { element } = createStatusPage({ state: 'empty', title: 'Library' });
        expect(globalThis.SillyBunnyAssets.loadStylesheetAsync).toHaveBeenCalledTimes(1);
        const [href, options] = globalThis.SillyBunnyAssets.loadStylesheetAsync.mock.calls[0];
        expect(href).toMatch(/^css\/sillybunny-editor-shell\.css\?v=/);
        expect(options).toEqual({ id: 'deferred-editor-shell-css' });
        expect(element.style.visibility).toBe('hidden');
        finish();
        await loading;
        await Promise.resolve();
        await Promise.resolve();
        expect(element.style.visibility).toBe('');
    });

    test('the page shows when the sheet link has loaded, even if the loader waits for more', async () => {
        const link = document.createElement('link');
        link.id = 'deferred-editor-shell-css';
        document.head.append(link);
        globalThis.SillyBunnyAssets = { loadStylesheetAsync: jest.fn(() => new Promise(() => {})) };
        const { element } = createStatusPage({ state: 'empty', title: 'Library' });
        expect(element.style.visibility).toBe('hidden');
        link.dispatchEvent(new Event('load'));
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(element.style.visibility).toBe('');
    });

    test('a loaded sheet is not requested again, and a failed request still shows the page', async () => {
        const link = document.createElement('link');
        link.id = 'deferred-editor-shell-css';
        link.dataset.sbStyleState = 'loaded';
        document.head.append(link);
        globalThis.SillyBunnyAssets = { loadStylesheetAsync: jest.fn() };
        const ready = createStatusPage({ state: 'empty', title: 'Library' });
        expect(globalThis.SillyBunnyAssets.loadStylesheetAsync).not.toHaveBeenCalled();
        expect(ready.element.style.visibility).toBe('');
        link.remove();
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        globalThis.SillyBunnyAssets.loadStylesheetAsync.mockRejectedValue(new Error('offline'));
        const failed = createStatusPage({ state: 'empty', title: 'Library' });
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
        expect(failed.element.style.visibility).toBe('');
        expect(warn).toHaveBeenCalled();
        warn.mockRestore();
    });
});

describe('the shared spinner helpers', () => {
    test('the spinner is a delayed busy progress indicator with a name', () => {
        const spinner = createSpinner({ label: 'Scanning', large: true });
        expect(spinner.className).toBe('sb-spinner sb-spinner--delayed sb-spinner--large');
        expect(spinner.getAttribute('role')).toBe('progressbar');
        expect(spinner.getAttribute('aria-busy')).toBe('true');
        expect(spinner.getAttribute('aria-label')).toBe('Scanning');
        const host = document.createElement('div');
        host.innerHTML = spinnerMarkup('Say "hi" <b>');
        expect(host.firstElementChild.className).toBe('sb-spinner sb-spinner--delayed');
        expect(host.firstElementChild.getAttribute('aria-label')).toBe('Say "hi" <b>');
        expect(host.querySelector('b')).toBeNull();
    });

    test('an icon gives way to the spinner while its control waits and comes back after', () => {
        const button = document.createElement('div');
        button.setAttribute('aria-label', 'Update');
        const icon = document.createElement('i');
        icon.className = 'fa-solid fa-download';
        icon.style.display = 'inline-block';
        button.append(icon);
        setIconBusy(icon, false);
        expect(icon.style.display).toBe('inline-block');
        setIconBusy(icon, true);
        setIconBusy(icon, true);
        expect(button.querySelectorAll('.sb-spinner')).toHaveLength(1);
        expect(button.querySelector('.sb-spinner').getAttribute('aria-label')).toBe('Update');
        expect(icon.style.display).toBe('none');
        expect(icon.classList.contains('fa-download')).toBe(true);
        setIconBusy(icon, false);
        expect(button.querySelector('.sb-spinner')).toBeNull();
        expect(icon.style.display).toBe('inline-block');
    });
});
