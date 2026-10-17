/** @jest-environment jsdom */
/* global globalThis */
/* eslint-disable playwright/no-standalone-expect, playwright/prefer-web-first-assertions -- Jest/jsdom tests assert DOM synchronously. */
import { jest, describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { createContext, SourceTextModule } from 'node:vm';

let adapter;
let records;
let avatarIds;
let states;
let dirty;
let popupChoice;
let details;
let actionMenu;
const power_user = { persona_sort_order: 'asc' };
const saveSettingsDebounced = jest.fn();
const thumbnail = jest.fn((_type, id) => `/thumbnail?file=${encodeURIComponent(id)}`);
await jest.unstable_mockModule('../../public/script.js', () => ({ getThumbnailUrlForViewport: thumbnail, saveSettingsDebounced }));
await jest.unstable_mockModule('../../public/scripts/browser-fixes.js', () => ({ isFirefox: () => false }));
await jest.unstable_mockModule('../../public/scripts/power-user.js', () => ({ power_user }));
const setAdapter = jest.fn(next => { adapter = next; });
const listAvatars = jest.fn(async () => [...avatarIds]);
const displayIds = jest.fn((ids, query) => ids.filter(id => !query || records[id]?.name.toLowerCase().includes(query.toLowerCase()))
    .sort((a, b) => power_user.persona_sort_order === 'asc' ? records[a].name.localeCompare(records[b].name) : records[b].name.localeCompare(records[a].name)));
const defaultState = () => ({ inUse: false, default: false, locked: { chat: false, character: false } });
const usePersona = jest.fn(async id => {
    for (const state of Object.values(states)) state.inUse = false;
    (states[id] ??= defaultState()).inUse = true;
    await adapter.refresh('states');
});
const duplicate = jest.fn();
const remove = jest.fn();
await jest.unstable_mockModule('../../public/scripts/personas.js', () => ({
    deletePersonaRecord: remove, duplicatePersonaRecord: duplicate, getPersonaDisplayAvatars: displayIds,
    getPersonaEditorStates: id => states[id] ?? defaultState(), getPersonaRecord: id => records[id] ?? null,
    listPersonaAvatars: listAvatars, setPersonaEditorAdapter: setAdapter, usePersona,
}));
const accountStorage = { getItem: jest.fn(() => '5'), setItem: jest.fn() };
await jest.unstable_mockModule('../../public/scripts/util/AccountStorage.js', () => ({ accountStorage }));
await jest.unstable_mockModule('../../public/scripts/i18n.js', () => ({
    t: (strings, ...values) => strings.reduce((out, string, index) => out + string + (values[index] ?? ''), ''),
}));
const popupShow = jest.fn(async () => popupChoice);
const Popup = jest.fn(function () {
    this.okButton = document.createElement('button');
    this.cancelButton = document.createElement('button');
    this.show = popupShow;
});
await jest.unstable_mockModule('../../public/scripts/popup.js', () => ({
    Popup, POPUP_TYPE: { CONFIRM: 1 }, POPUP_RESULT: { AFFIRMATIVE: 1, NEGATIVE: 0 },
}));
await jest.unstable_mockModule('../../public/scripts/sillybunny-motion.js', () => ({
    play: jest.fn((_node, _frames, options) => { options?.onEnd?.(); return { cancel() {} }; }),
    stopMotion: jest.fn(), prefersReducedMotion: () => true,
    animateOut: jest.fn((_node, _frames, hide) => hide()),
    SPRING_NAVIGATION: {}, MOTION_FAST: 0, MOTION_SLOW: 0,
}));
const closeActionMenu = jest.fn(() => {
    const previous = actionMenu;
    actionMenu = null;
    previous?.trigger.setAttribute('aria-expanded', 'false');
    previous?.onClose?.();
});
const openActionMenu = jest.fn(options => {
    const toggling = actionMenu?.trigger === options.trigger;
    closeActionMenu();
    if (toggling) return;
    actionMenu = options;
    options.trigger.setAttribute('aria-expanded', 'true');
});
const isActionMenuOpen = jest.fn(trigger => Boolean(actionMenu) && (!trigger || actionMenu.trigger === trigger));
await jest.unstable_mockModule('../../public/scripts/sillybunny-action-menu.js', () => ({ openActionMenu, closeActionMenu, isActionMenuOpen }));
const isPickerOpen = jest.fn(() => false);
await jest.unstable_mockModule('../../public/scripts/sillybunny-editor/picker.js', () => ({ isPickerOpen }));
const unregister = jest.fn();
const registerNavigation = jest.fn(() => unregister);
await jest.unstable_mockModule('../../public/scripts/sillybunny-editor/navigation.js', () => ({
    registerEditorNavigation: registerNavigation, characterTabGuardSelector: tab => `guard-${tab}`,
}));
const mountDetail = jest.fn(({ host }) => {
    const input = document.createElement('input');
    host.append(input);
    const controller = {
        isDirty: jest.fn(() => dirty), save: jest.fn(async () => { dirty = false; return true; }),
        discard: jest.fn(() => { dirty = false; }), destroy: jest.fn(), refresh: jest.fn(),
        focusTarget: () => input, scrollToSection: jest.fn(),
    };
    details.push(controller);
    return controller;
});
const draftKey = id => `sb-persona-editor-draft-test-user-${encodeURIComponent(id || 'new-persona')}`;
await jest.unstable_mockModule('../../public/scripts/sillybunny-persona-detail.js', () => ({
    mountPersonaDetail: mountDetail, personaDraftKey: draftKey,
}), { virtual: true });

const { mountPersonaEditor, openPersonaEditor, preservePersonaOrder } = await import('../../public/scripts/sillybunny-persona-editor.js');
const { mountPersonaSettings } = await import('../../public/scripts/sillybunny-persona-settings.js');
const { eventSource, event_types } = await import('../../public/scripts/events.js');
const { loadStylesheetAsync } = await import('../../public/scripts/dynamic-styles.js');
const tabsSource = readFileSync(new URL('../../public/scripts/sillybunny-tabs.js', import.meta.url), 'utf8');
const personaMountSource = tabsSource.split('let personaEditorMountPromise = null;')[1].split('function setCharacterImportPanelVisible')[0];
const preloadSource = tabsSource.slice(tabsSource.indexOf('function preloadPanelStylesheets('), tabsSource.indexOf('function isLandingPageVisible('));
const personaStylesheets = [
    { href: 'css/sillybunny-editor-shell.css?v=20261018a', id: 'deferred-editor-shell-css' },
    { href: 'css/sillybunny-persona-editor.css?v=20261018a', id: 'deferred-persona-editor-css' },
    { href: 'css/sillybunny-persona-detail.css?v=20261018a', id: 'deferred-persona-detail-css' },
];
let container;
let mounted;

async function personaTabMount(stylesheets = personaStylesheets) {
    // Execute the real lazy-mount/preload seam without bootstrapping the unrelated application shell.
    const module = new SourceTextModule(`
        const SB_PANEL_STYLESHEETS = { 'characters:persona': ${JSON.stringify(stylesheets)} };
        const ensureCharacterPersonaPanel = () => document.getElementById('sb_character_persona_panel');
        let personaEditorMountPromise = null;
        ${personaMountSource}
        ${preloadSource}
        export { setCharacterPersonaPanelVisible, preloadPanelStylesheets };
        export const mountPromise = () => personaEditorMountPromise;
    `, {
        context: createContext({ document, window, HTMLElement, console }),
        importModuleDynamically: () => import('../../public/scripts/sillybunny-persona-editor.js'),
    });
    await module.link(() => { throw new Error('Unexpected static import in persona mount.'); });
    await module.evaluate();
    return module.namespace;
}

function personas(count = 3) {
    avatarIds = Array.from({ length: count }, (_, index) => `avatar-${index}.png`);
    records = Object.fromEntries(avatarIds.map((id, index) => [id, {
        avatarId: id, name: `Persona ${String(index).padStart(2, '0')}`,
        descriptor: { title: index === 0 ? 'A title' : '', description: 'First line\nSecond line' },
    }]));
}

async function settle() {
    for (let index = 0; index < 30; index++) await Promise.resolve();
}

async function mount(count = 3) {
    personas(count);
    mounted = mountPersonaEditor(container);
    await mounted.ready;
    await settle();
}

async function open(index = 0) {
    container.querySelector(`[data-avatar-id="avatar-${index}.png"]`).click();
    await settle();
    return details.at(-1);
}

async function menuAction(label, selector = '.sb-persona-list-menu') {
    const trigger = container.querySelector(selector);
    if (!isActionMenuOpen(trigger)) trigger.click();
    await settle();
    const action = actionMenu.sections.flatMap(section => section.items).find(item => item.label === label);
    closeActionMenu();
    action.onSelect();
    await settle();
}

const rowIds = () => [...container.querySelectorAll('.sb-persona-row')].map(row => row.dataset.avatarId);

beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    adapter = null;
    states = {};
    dirty = false;
    popupChoice = 0;
    details = [];
    actionMenu = null;
    mounted = null;
    power_user.persona_sort_order = 'asc';
    isPickerOpen.mockReturnValue(false);
    listAvatars.mockImplementation(async () => [...avatarIds]);
    duplicate.mockReset();
    remove.mockReset();
    accountStorage.getItem.mockReturnValue('5');
    setAdapter.mockImplementation(next => { adapter = next; });
    localStorage.clear();
    document.body.innerHTML = `<div id="sb-settings-page"><div id="sb_character_persona_panel"><div id="PersonaManagement">
        <div id="legacy"><button id="personas_backup"></button><button id="personas_restore"></button><button class="user_stats_button"></button>
        <label id="notifications-origin"><input id="persona_show_notifications" type="checkbox" class="original" aria-describedby="existing"><span>Original</span></label>
        <label><input id="persona_allow_multi_connections" type="checkbox"></label>
        <label><input id="persona_auto_lock" type="checkbox"></label></div>
        </div></div></div>`;
    container = document.getElementById('PersonaManagement');
    globalThis.matchMedia = jest.fn(() => ({ matches: false, addEventListener: jest.fn(), removeEventListener: jest.fn() }));
    globalThis.ResizeObserver = class { observe() {} disconnect() {} };
    jest.spyOn(window, 'requestAnimationFrame').mockImplementation(() => 1);
    jest.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
    globalThis.SillyBunnyAssets = { loadStylesheetAsync: jest.fn().mockResolvedValue() };
    globalThis.SillyBunnyShell = { openTab: jest.fn() };
});

afterEach(() => {
    mounted?.destroy();
    if (container.querySelector('.sb-persona-editor')) mountPersonaEditor(container).destroy();
    jest.useRealTimers();
    jest.restoreAllMocks();
    delete globalThis.SillyBunnyAssets;
    delete globalThis.SillyBunnyShell;
    document.body.replaceChildren();
    for (const { id } of personaStylesheets) document.getElementById(id)?.remove();
});

describe('Persona editor shell', () => {
    test('mount is idempotent and hides only the legacy layout after styles resolve', async () => {
        await mount();
        expect(mountPersonaEditor(container)).toBe(mounted);
        expect(container.querySelectorAll('.sb-persona-editor')).toHaveLength(1);
        expect(container.querySelector('#legacy')).not.toBeNull();
        expect(container.classList.contains('sb-persona-editor-mounted')).toBe(true);
        expect(setAdapter).toHaveBeenCalledTimes(1);
        expect(container.querySelector('.sb-persona-editor').getAttribute('aria-label')).toBe('Persona Management');
    });

    test('invalid hosts fail fast', () => {
        expect(() => mountPersonaEditor(null)).toThrow('HTMLElement');
        expect(() => mountPersonaEditor(document.createElement('div'))).toThrow('#PersonaManagement');
    });

    test('the editor waits for shared, list and detail stylesheets before reveal', async () => {
        personas();
        const resolvers = [];
        globalThis.SillyBunnyAssets.loadStylesheetAsync.mockImplementation(() => new Promise(resolve => resolvers.push(resolve)));
        mounted = mountPersonaEditor(container);
        await settle();
        expect(resolvers).toHaveLength(3);
        expect(container.classList.contains('sb-persona-editor-mounted')).toBe(false);
        expect(adapter.isOpen()).toBe(false);
        resolvers[0]();
        resolvers[1]();
        await settle();
        expect(container.querySelector('.sb-persona-editor').hidden).toBe(true);
        resolvers[2]();
        await mounted.ready;
        expect(adapter.isOpen()).toBe(true);
    });

    test('readiness failure releases the adapter, navigation, listeners and cached controller', async () => {
        personas();
        const failure = new Error('Avatar list unavailable');
        listAvatars.mockRejectedValueOnce(failure);
        const removeListener = jest.spyOn(eventSource, 'removeListener');
        const removeWindowListener = jest.spyOn(window, 'removeEventListener');
        mounted = mountPersonaEditor(container);
        const previous = mounted;
        const root = container.querySelector('.sb-persona-editor');
        const removeRootListener = jest.spyOn(root, 'removeEventListener');
        const search = root.querySelector('.sb-persona-search');
        search.value = 'pending search';
        search.dispatchEvent(new Event('input', { bubbles: true }));
        await expect(previous.ready).rejects.toBe(failure);
        expect(setAdapter).toHaveBeenLastCalledWith(null);
        expect(adapter).toBeNull();
        expect(unregister).toHaveBeenCalledTimes(1);
        expect(removeListener).toHaveBeenCalledWith(event_types.PERSONA_CREATED, expect.any(Function));
        expect(removeWindowListener).toHaveBeenCalledWith('beforeunload', expect.any(Function));
        expect(removeRootListener).toHaveBeenCalledWith('keydown', expect.any(Function));
        expect(root.isConnected).toBe(false);
        expect(container.classList.contains('sb-persona-editor-mounted')).toBe(false);
        displayIds.mockClear();
        jest.advanceTimersByTime(300);
        expect(displayIds).not.toHaveBeenCalled();
        await eventSource.emit(event_types.PERSONA_CREATED, { avatarId: 'later.png' });
        expect(listAvatars).toHaveBeenCalledTimes(1);
        expect(setAdapter.mock.calls[0][0].isOpen()).toBe(false);
        mounted = mountPersonaEditor(container);
        expect(mounted).not.toBe(previous);
        await mounted.ready;
        expect(adapter.isOpen()).toBe(true);
    });

    test.each(['throw', 'reject'])('adapter installation failure (%s) rejects readiness and permits remount', async kind => {
        personas();
        const failure = new Error('Adapter installation failed');
        setAdapter.mockImplementationOnce(next => {
            adapter = next;
            if (kind === 'throw') throw failure;
            return Promise.reject(failure);
        });
        mounted = mountPersonaEditor(container);
        const previous = mounted;
        await expect(previous.ready).rejects.toBe(failure);
        expect(adapter).toBeNull();
        expect(setAdapter).toHaveBeenLastCalledWith(null);
        expect(unregister).toHaveBeenCalledTimes(1);
        expect(container.querySelector('.sb-persona-editor')).toBeNull();
        mounted = mountPersonaEditor(container);
        expect(mounted).not.toBe(previous);
        await mounted.ready;
        expect(adapter.isOpen()).toBe(true);
    });

    test('a failed stylesheet is replaced with a fresh link when mounting again', async () => {
        personas();
        globalThis.SillyBunnyAssets.loadStylesheetAsync.mockImplementation(loadStylesheetAsync);
        mounted = mountPersonaEditor(container);
        await settle();
        const failedLinks = personaStylesheets.map(({ id }) => document.getElementById(id));
        const failure = new Event('error');
        const rejected = mounted.ready;
        for (const link of failedLinks) link.dispatchEvent(failure);
        await expect(rejected).rejects.toBe(failure);
        const previous = mounted;
        mounted = mountPersonaEditor(container);
        expect(mounted).not.toBe(previous);
        await settle();
        for (const [index, { id }] of personaStylesheets.entries()) {
            const link = document.getElementById(id);
            expect(link).not.toBe(failedLinks[index]);
            expect(failedLinks[index].isConnected).toBe(false);
            link.dispatchEvent(new Event('load'));
        }
        await mounted.ready;
        expect(container.querySelector('.sb-persona-editor').hidden).toBe(false);
    });

    test('the tab mount rejects readiness failures, warns and clears its cached promise for retry', async () => {
        personas();
        const failure = new Error('Persona readiness failed');
        listAvatars.mockRejectedValueOnce(failure);
        const warning = jest.spyOn(console, 'warn').mockImplementation(() => {});
        const tab = await personaTabMount();
        tab.setCharacterPersonaPanelVisible(true);
        const failedMount = tab.mountPromise();
        await expect(failedMount).rejects.toBe(failure);
        expect(tab.mountPromise()).toBeNull();
        expect(warning).toHaveBeenCalledWith('[SillyBunny] Could not mount the persona editor.', failure);
        expect(adapter).toBeNull();
        tab.setCharacterPersonaPanelVisible(false);
        tab.setCharacterPersonaPanelVisible(true);
        mounted = await tab.mountPromise();
        expect(container.querySelectorAll('.sb-persona-editor')).toHaveLength(1);
        expect(container.querySelector('.sb-persona-editor').hidden).toBe(false);
    });

    test.each(personaStylesheets.map(({ id }) => id))('a failed preload of %s is replaced before the tab retries', async failedId => {
        personas();
        globalThis.SillyBunnyAssets.loadStylesheetAsync.mockImplementation(loadStylesheetAsync);
        jest.spyOn(console, 'warn').mockImplementation(() => {});
        const stylesheets = personaStylesheets.map(stylesheet => ({ ...stylesheet, href: `${stylesheet.href}&retry-test=${failedId}` }));
        const tab = await personaTabMount(stylesheets);
        const preloading = tab.preloadPanelStylesheets('characters', 'persona');
        await settle();
        const originalLinks = new Map(stylesheets.map(({ id }) => [id, document.getElementById(id)]));
        for (const [id, link] of originalLinks) link.dispatchEvent(new Event(id === failedId ? 'error' : 'load'));
        await preloading;
        expect(originalLinks.get(failedId).isConnected).toBe(false);
        tab.setCharacterPersonaPanelVisible(true);
        await settle();
        const retryLink = document.getElementById(failedId);
        expect(retryLink).not.toBeNull();
        expect(retryLink).not.toBe(originalLinks.get(failedId));
        for (const [id, link] of [...originalLinks].filter(([id]) => id !== failedId)) {
            expect(document.getElementById(id)).toBe(link);
        }
        retryLink.dispatchEvent(new Event('load'));
        mounted = await tab.mountPromise();
        expect(container.querySelector('.sb-persona-editor').hidden).toBe(false);
    });

    test('a tab stylesheet failure rejects the bridge and retries with a fresh request', async () => {
        personas();
        globalThis.SillyBunnyAssets.loadStylesheetAsync.mockImplementation(loadStylesheetAsync);
        jest.spyOn(console, 'warn').mockImplementation(() => {});
        const tab = await personaTabMount(personaStylesheets.map(stylesheet => ({ ...stylesheet, href: `${stylesheet.href}&retry-test=tab-failure` })));
        globalThis.SillyBunnyShell.openTab.mockImplementation(() => {
            tab.setCharacterPersonaPanelVisible(true);
            return tab.mountPromise();
        });
        const opening = openPersonaEditor({ avatarId: avatarIds[0] });
        await settle();
        const failedId = 'deferred-persona-detail-css';
        const failedLink = document.getElementById(failedId);
        const failure = new Event('error');
        for (const { id } of personaStylesheets) document.getElementById(id).dispatchEvent(id === failedId ? failure : new Event('load'));
        await expect(opening).rejects.toBe(failure);
        expect(tab.mountPromise()).toBeNull();
        expect(container.querySelector('.sb-persona-editor')).toBeNull();
        const retrying = openPersonaEditor({ avatarId: avatarIds[0] });
        await settle();
        const retryLink = document.getElementById(failedId);
        expect(retryLink).not.toBe(failedLink);
        expect(retryLink).not.toBeNull();
        retryLink.dispatchEvent(new Event('load'));
        expect(await retrying).toBe(true);
        mounted = await tab.mountPromise();
        expect(mountDetail).toHaveBeenCalledTimes(1);
    });

    test.each(['hidden', 'aria-hidden', 'inert'])('adapter visibility respects ancestor %s', async attribute => {
        await mount();
        const panel = document.getElementById('sb_character_persona_panel');
        panel.setAttribute(attribute, attribute === 'aria-hidden' ? 'true' : '');
        expect(adapter.isOpen()).toBe(false);
        panel.removeAttribute(attribute);
        expect(adapter.isOpen()).toBe(true);
    });

    test('rows match the boxed list pattern, with lazy avatars, subtitles and labelled badges', async () => {
        await mount();
        states[avatarIds[0]] = { inUse: true, default: true, locked: { chat: true, character: true } };
        await adapter.refresh('states');
        const row = container.querySelector('.sb-persona-row');
        expect(container.querySelector('.sb-persona-list-heading').textContent).toBe('Your Persona');
        expect(row.parentNode.matches('.ds-pref-group[role="list"]')).toBe(true);
        expect(row.getAttribute('role')).toBe('listitem');
        expect(row.tabIndex).toBe(0);
        const avatar = row.querySelector('img');
        expect(avatar.loading).toBe('lazy');
        expect(avatar.decoding).toBe('async');
        expect(avatar.alt).toBe('');
        expect(thumbnail).toHaveBeenCalledWith('persona', avatarIds[0], false);
        expect(row.querySelector('.ds-row-subtitle').textContent).toBe('A title');
        expect(container.querySelectorAll('.ds-row-subtitle')[1].textContent).toBe('First line');
        expect([...row.querySelectorAll('.sb-persona-row-badges i')].map(badge => [badge.getAttribute('aria-label'), badge.title])).toEqual([
            ['Current Persona', 'Current Persona'], ['Default Persona', 'Default Persona'],
            ['Persona is locked to the current chat', 'Persona is locked to the current chat'],
            ['Persona is locked to the current character', 'Persona is locked to the current character'],
        ]);
        expect(row.querySelector('.fa-pencil')).toBeNull();
    });

    test('opening a row never activates the persona and delegates detail focus/selection', async () => {
        await mount();
        const detail = await open(1);
        expect(usePersona).not.toHaveBeenCalled();
        expect(mountDetail).toHaveBeenLastCalledWith(expect.objectContaining({ avatarId: avatarIds[1], mode: 'edit' }));
        expect(container.querySelector('.sb-persona-row.is-selected').dataset.sbListKey).toBe('persona:avatar-1.png');
        expect(document.activeElement).toBe(detail.focusTarget());
    });

    test('row menus expose Use, Duplicate and destructive Delete without opening the detail', async () => {
        await mount();
        container.querySelector('.sb-persona-row-menu').click();
        await settle();
        const actions = actionMenu.sections.flatMap(section => section.items);
        expect(actions.map(({ label }) => label)).toEqual(['lorum ipsum', 'Duplicate', 'Delete']);
        expect(actions.at(-1).danger).toBe(true);
        expect(mountDetail).not.toHaveBeenCalled();
        await menuAction('lorum ipsum', '.sb-persona-row-menu');
        expect(usePersona).toHaveBeenCalledWith(avatarIds[0]);
        container.querySelector('.sb-persona-row-menu').click();
        await settle();
        expect(actionMenu.sections[0].items[0].disabled).toBe(true);
    });

    test.each(['.sb-persona-sort-button', '.sb-persona-list-menu', '.sb-persona-row-menu'])('second click toggles %s closed', async selector => {
        await mount();
        const trigger = container.querySelector(selector);
        trigger.click();
        await settle();
        expect(isActionMenuOpen(trigger)).toBe(true);
        trigger.click();
        await settle();
        expect(isActionMenuOpen()).toBe(false);
        expect(trigger.getAttribute('aria-expanded')).toBe('false');
    });

    test('search debounces 300ms and distinguishes no results from an empty library', async () => {
        await mount();
        displayIds.mockClear();
        const input = container.querySelector('.sb-persona-search');
        input.value = 'missing';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        jest.advanceTimersByTime(299);
        expect(displayIds).not.toHaveBeenCalled();
        jest.advanceTimersByTime(1);
        await settle();
        expect(displayIds).toHaveBeenCalledWith(avatarIds, 'missing');
        expect(rowIds()).toEqual([]);
        expect(container.querySelector('.sb-persona-list-status').textContent).toBe('No results');
        expect(container.querySelector('.sb-persona-list-heading').hidden).toBe(true);
        expect(container.querySelector('.sb-list-editor__status').textContent).toBe('No results');
    });

    test('an empty library offers a create draft', async () => {
        await mount(0);
        container.querySelector('.sb-persona-list-status button').click();
        await settle();
        expect(mountDetail).toHaveBeenLastCalledWith(expect.objectContaining({ mode: 'create', avatarId: null }));
    });

    test('sort menu has a titled radio section and persists asc/desc', async () => {
        await mount();
        container.querySelector('.sb-persona-sort-button').click();
        await settle();
        expect(actionMenu.sections[0].title).toBe('lorum ipsum');
        expect(actionMenu.sections[0].items.map(({ checked }) => checked)).toEqual([true, false]);
        await menuAction('Z-A', '.sb-persona-sort-button');
        expect(power_user.persona_sort_order).toBe('desc');
        expect(saveSettingsDebounced).toHaveBeenCalled();
        expect(rowIds()).toEqual([...avatarIds].reverse());
    });

    test('states refreshes are cheap and preserve order until a deliberate sort', async () => {
        await mount();
        const previousRows = [...container.querySelectorAll('.sb-persona-row')];
        displayIds.mockClear();
        power_user.persona_sort_order = 'desc';
        await adapter.refresh('states');
        expect(displayIds).not.toHaveBeenCalled();
        expect([...container.querySelectorAll('.sb-persona-row')]).toEqual(previousRows);
        await adapter.refresh('list');
        expect(rowIds()).toEqual(avatarIds);
        await menuAction('Z-A', '.sb-persona-sort-button');
        expect(rowIds()).toEqual([...avatarIds].reverse());
    });

    test('persona refresh updates a row and forwards changes without remounting the dirty detail', async () => {
        await mount();
        const detail = await open();
        dirty = true;
        records[avatarIds[0]].name = 'Updated name';
        await adapter.refresh('persona', avatarIds[0]);
        expect(container.querySelector('.sb-persona-row .ds-row-label').textContent).toBe('Updated name');
        expect(detail.refresh).toHaveBeenLastCalledWith('persona', avatarIds[0]);
        expect(detail.destroy).not.toHaveBeenCalled();
        expect(mountDetail).toHaveBeenCalledTimes(1);
    });

    test('a list refresh reloads overwritten avatar images without replacing their rows', async () => {
        await mount();
        const row = container.querySelector('.sb-persona-row');
        thumbnail.mockClear();
        await adapter.refresh('list');
        expect(container.querySelector('.sb-persona-row')).toBe(row);
        expect(thumbnail).toHaveBeenCalledWith('persona', avatarIds[0], true);
    });

    test('pagination is guarded, persists page size, and deliberate pages clear held order', async () => {
        await mount(15);
        await open();
        dirty = true;
        container.querySelector('.sb-list-pagination__next').click();
        await settle();
        expect(container.querySelector('.sb-list-pagination__status').textContent).toBe('Page 1 of 3');
        dirty = false;
        const size = container.querySelector('.sb-list-pagination__size');
        expect([...size.options].map(option => Number(option.value))).toEqual([5, 10, 25, 50, 100, 250, 500, 1000]);
        size.value = '10';
        size.dispatchEvent(new Event('change', { bubbles: true }));
        await settle();
        expect(accountStorage.setItem).toHaveBeenCalledWith('Personas_PerPage', '10');
        expect(rowIds()).toHaveLength(10);
    });

    test('settings is first in the list menu and toggles back to its trigger', async () => {
        await mount();
        const trigger = container.querySelector('.sb-persona-list-menu');
        trigger.click();
        await settle();
        expect(actionMenu.sections[0].items[0].label).toBe('Global Settings');
        await menuAction('Global Settings');
        expect(container.querySelector('.sb-persona-settings')).not.toBeNull();
        expect(registerNavigation.mock.calls[0][0].session.isDirty()).toBe(false);
        await menuAction('Global Settings');
        expect(container.querySelector('.sb-persona-editor').dataset.open).toBe('false');
        expect(document.activeElement).toBe(trigger);
    });

    test('create, settings and persona have separate keys; creation reselects the new record', async () => {
        await mount();
        container.querySelector('.sb-persona-new').click();
        await settle();
        expect(mountDetail).toHaveBeenLastCalledWith(expect.objectContaining({ avatarId: null, mode: 'create' }));
        const onSaved = mountDetail.mock.calls.at(-1)[0].onSaved;
        records['created.png'] = { avatarId: 'created.png', name: 'Created', descriptor: {} };
        avatarIds.push('created.png');
        onSaved({ avatarId: 'created.png', created: true });
        await settle();
        expect(mountDetail).toHaveBeenLastCalledWith(expect.objectContaining({ avatarId: 'created.png', mode: 'edit' }));
        await menuAction('Global Settings');
        expect(container.querySelector('.sb-persona-settings')).not.toBeNull();
    });

    test.each([[0, null], [1, 'save'], [2, 'discard']])('dirty selection delegates guard choice %i', async (choice, method) => {
        await mount();
        const detail = await open();
        dirty = true;
        popupChoice = choice;
        await menuAction('Global Settings');
        expect(popupShow).toHaveBeenCalledTimes(1);
        expect(detail.save).toHaveBeenCalledTimes(Number(method === 'save'));
        expect(detail.discard).toHaveBeenCalledTimes(Number(method === 'discard'));
        expect(Boolean(container.querySelector('.sb-persona-settings'))).toBe(Boolean(method));
    });

    test('search Escape clears search before closing a dirty detail and never reaches settings', async () => {
        await mount();
        const detail = await open();
        dirty = true;
        container.querySelector('[aria-label="Search"]').click();
        await settle();
        const input = container.querySelector('.sb-persona-search');
        input.value = 'Persona';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        const bubble = jest.fn();
        container.addEventListener('keydown', bubble);
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
        await settle();
        expect(bubble).not.toHaveBeenCalled();
        expect(input.value).toBe('');
        expect(container.querySelector('.sb-persona-search-field').hidden).toBe(true);
        expect(popupShow).not.toHaveBeenCalled();
        expect(detail.destroy).not.toHaveBeenCalled();
    });

    test('sidebar Escape is guarded and stops at the persona editor', async () => {
        await mount();
        await open();
        dirty = true;
        const bubble = jest.fn();
        container.addEventListener('keydown', bubble);
        container.querySelector('.sb-persona-new').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
        await settle();
        expect(bubble).not.toHaveBeenCalled();
        expect(popupShow).toHaveBeenCalled();
        expect(container.querySelector('.sb-persona-editor').dataset.open).toBe('true');
    });

    test('navigation adapter delegates dirty/save/discard with the persona guard', async () => {
        await mount();
        const detail = await open();
        const registration = registerNavigation.mock.calls[0][0];
        dirty = true;
        expect(registration.session.isOpen()).toBe(true);
        expect(registration.session.isDirty()).toBe(true);
        expect(await registration.session.save()).toBe(true);
        registration.session.discard();
        expect(detail.save).toHaveBeenCalled();
        expect(detail.discard).toHaveBeenCalled();
        expect(registration.guardSelector).toBe('guard-persona');
        expect(registration.escape).toBe(false);
    });

    test('legacy Backup, Restore and Usage Stats remain hidden transports', async () => {
        await mount();
        for (const [label, selector] of [['Backup', '#personas_backup'], ['Restore', '#personas_restore'], ['Usage Stats', '.user_stats_button']]) {
            const handler = jest.fn();
            document.querySelector(selector).addEventListener('click', handler);
            await menuAction(label);
            expect(handler).toHaveBeenCalledTimes(1);
        }
    });

    test('lifecycle events forward updates, reload avatars, and clear deleted drafts', async () => {
        await mount();
        const detail = await open();
        await eventSource.emit(event_types.PERSONA_RENAMED, { avatarId: avatarIds[0] });
        expect(detail.refresh).toHaveBeenLastCalledWith('persona', avatarIds[0]);
        await eventSource.emit(event_types.CHAT_CHANGED, 'chat');
        expect(detail.refresh).toHaveBeenLastCalledWith('states', undefined);
        await eventSource.emit(event_types.PERSONA_CREATED, { avatarId: 'created.png' });
        expect(listAvatars).toHaveBeenCalledTimes(2);
        localStorage.setItem(draftKey(avatarIds[0]), 'draft');
        delete records[avatarIds[0]];
        await eventSource.emit(event_types.PERSONA_DELETED, { avatarId: avatarIds[0] });
        expect(localStorage.getItem(draftKey(avatarIds[0]))).toBeNull();
        expect(rowIds()).not.toContain(avatarIds[0]);
        expect(detail.refresh).toHaveBeenLastCalledWith('persona', avatarIds[0]);
        expect(detail.destroy).not.toHaveBeenCalled();
    });

    test('duplicate opens its returned ID; delete closes the removed selection without a second guard', async () => {
        await mount();
        duplicate.mockImplementationOnce(async () => {
            records['copy.png'] = { avatarId: 'copy.png', name: 'Copy', descriptor: {} };
            avatarIds.push('copy.png');
            return 'copy.png';
        });
        await menuAction('Duplicate', '.sb-persona-row-menu');
        expect(mountDetail).toHaveBeenLastCalledWith(expect.objectContaining({ avatarId: 'copy.png' }));
        remove.mockImplementationOnce(async id => { delete records[id]; avatarIds = avatarIds.filter(avatar => avatar !== id); return true; });
        await menuAction('Delete', '.sb-persona-row[data-avatar-id="copy.png"] .sb-persona-row-menu');
        expect(remove).toHaveBeenCalledWith('copy.png');
        expect(container.querySelector('.sb-persona-editor').dataset.open).toBe('false');
        expect(popupShow).not.toHaveBeenCalled();
    });

    test('openPersonaEditor routes Characters → Persona, selects a later page, and scrolls to notes', async () => {
        await mount(15);
        expect(await openPersonaEditor({ avatarId: 'avatar-12.png', section: 'notes' })).toBe(true);
        expect(globalThis.SillyBunnyShell.openTab).toHaveBeenCalledWith('characters', 'persona');
        expect(mountDetail).toHaveBeenLastCalledWith(expect.objectContaining({ avatarId: 'avatar-12.png' }));
        expect(container.querySelector('.sb-list-pagination__status').textContent).toBe('Page 3 of 3');
        expect(details.at(-1).scrollToSection).toHaveBeenCalledWith('notes');
        expect(await openPersonaEditor({ avatarId: 'missing.png' })).toBe(false);
    });

    test('openPersonaEditor respects a cancelled dirty guard and never moves the page', async () => {
        await mount(15);
        await open();
        dirty = true;
        expect(await openPersonaEditor({ avatarId: 'avatar-12.png' })).toBe(false);
        expect(mountDetail).toHaveBeenCalledTimes(1);
        expect(container.querySelector('.sb-list-pagination__status').textContent).toBe('Page 1 of 3');
    });

    test('openPersonaEditor awaits the route mount and its deferred stylesheet gate', async () => {
        await mount();
        let resolveRoute;
        globalThis.SillyBunnyShell.openTab.mockImplementationOnce(() => new Promise(resolve => { resolveRoute = resolve; }));
        const opening = openPersonaEditor({ avatarId: avatarIds[1] });
        await settle();
        expect(mountDetail).not.toHaveBeenCalled();
        resolveRoute(mounted);
        expect(await opening).toBe(true);
        expect(mountDetail).toHaveBeenLastCalledWith(expect.objectContaining({ avatarId: avatarIds[1] }));
    });

    test('openPersonaEditor rejects a failed tab mount rather than returning a hidden controller', async () => {
        personas();
        const failure = new Error('Persona readiness failed');
        listAvatars.mockRejectedValueOnce(failure);
        jest.spyOn(console, 'warn').mockImplementation(() => {});
        const tab = await personaTabMount();
        globalThis.SillyBunnyShell.openTab.mockImplementation(() => {
            tab.setCharacterPersonaPanelVisible(true);
            return tab.mountPromise();
        });
        await expect(openPersonaEditor({ avatarId: avatarIds[0] })).rejects.toBe(failure);
        expect(mountDetail).not.toHaveBeenCalled();
        expect(container.querySelector('.sb-persona-editor')).toBeNull();
    });

    test('destroy unregisters everything, preserves dirty drafts and allows remount', async () => {
        await mount();
        const detail = await open();
        dirty = true;
        const refresh = detail.refresh;
        refresh.mockClear();
        mounted.destroy();
        mounted.destroy();
        expect(detail.destroy).toHaveBeenCalledWith({ keepDraft: true });
        expect(setAdapter).toHaveBeenLastCalledWith(null);
        expect(unregister).toHaveBeenCalledTimes(1);
        expect(container.querySelector('.sb-persona-editor')).toBeNull();
        expect(container.classList.contains('sb-persona-editor-mounted')).toBe(false);
        await eventSource.emit(event_types.SETTINGS_UPDATED);
        expect(refresh).not.toHaveBeenCalled();
        const next = mountPersonaEditor(container);
        expect(next).not.toBe(mounted);
        mounted = next;
        await next.ready;
    });

    test('held order retains surviving rows and appends new IDs in fresh order', () => {
        expect(preservePersonaOrder(['a', 'b', 'c'], ['d', 'c', 'a'], ['a', 'c', 'd'])).toEqual(['a', 'c', 'd']);
    });
});

describe('Persona settings transport adoption', () => {
    test('reparents original switches without replacing handlers, then restores attributes and position', () => {
        const input = document.getElementById('persona_show_notifications');
        const parent = input.parentNode;
        const next = input.nextSibling;
        const originalAttributes = input.outerHTML;
        const onChange = jest.fn();
        input.addEventListener('change', onChange);
        const host = document.createElement('div');
        container.append(host);
        const settings = mountPersonaSettings({ host, onClose: jest.fn() });
        expect(host.querySelector('#persona_show_notifications')).toBe(input);
        expect(host.querySelectorAll('input[role="switch"]')).toHaveLength(3);
        expect(host.querySelector('h3')).not.toBeNull();
        expect(host.querySelector('[aria-label="Save"]')).toBeNull();
        input.click();
        expect(onChange).toHaveBeenCalledTimes(1);
        expect(input.getAttribute('aria-checked')).toBe('true');
        settings.destroy();
        settings.destroy();
        expect(input.parentNode).toBe(parent);
        expect(input.nextSibling).toBe(next);
        expect(input.outerHTML).toBe(originalAttributes);
        input.click();
        expect(onChange).toHaveBeenCalledTimes(2);
    });

    test('Escape blurs a field before closing and stops propagation in both cases', () => {
        const host = document.createElement('div');
        container.append(host);
        const onClose = jest.fn();
        const bubble = jest.fn();
        container.addEventListener('keydown', bubble);
        const settings = mountPersonaSettings({ host, onClose });
        const input = host.querySelector('input');
        input.focus();
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
        expect(document.activeElement).not.toBe(input);
        expect(onClose).not.toHaveBeenCalled();
        settings.focusTarget().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
        expect(onClose).toHaveBeenCalledTimes(1);
        expect(bubble).not.toHaveBeenCalled();
        settings.destroy();
    });
});
