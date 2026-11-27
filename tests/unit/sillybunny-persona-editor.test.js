/** @jest-environment jsdom */
/* global globalThis */
/* eslint-disable playwright/no-standalone-expect, playwright/prefer-web-first-assertions -- Jest/jsdom tests assert DOM synchronously. */
import { jest, describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { createContext, SourceTextModule } from 'node:vm';

import { importPersonasModule } from '../util/personas-module-harness.js';

// Capture real personas.js and real performance-loader.js once before mocking personas.js for editor tests.
const { eventSource: sharedEventSource, event_types: sharedEventTypes } = await import('../../public/scripts/events.js');
let realPersonasFetchImpl = async () => ({ ok: true, json: async () => [] });
const realPersonasBundle = await importPersonasModule({
    eventSource: sharedEventSource,
    event_types: sharedEventTypes,
    fetch: (...args) => realPersonasFetchImpl(...args),
});
await realPersonasBundle.personas.initPersonas();

window.requestIdleCallback = jest.fn();
await import('../../public/scripts/performance-loader.js');
const realActivateDeferredStylesheet = window.SillyBunnyLoadStylesheet;
jest.resetModules();

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
const confirmDestructiveAction = jest.fn(async () => popupChoice === 1);
await jest.unstable_mockModule('../../public/scripts/sillybunny-delete-confirm.js', () => ({ confirmDestructiveAction }));
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
    stopMotion: jest.fn(), prefersReducedMotion: () => true, animateHeightFrom: jest.fn(),
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
const back = jest.fn(({ fallback }) => fallback());
await jest.unstable_mockModule('../../public/scripts/sillybunny-editor/object-navigation.js', () => ({ objectNavigation: { back } }));
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

const { mountPersonaEditor, openPersonaEditor, preservePersonaOrder, loadPersonaEditorStyles } = await import('../../public/scripts/sillybunny-persona-editor.js');
const { mountPersonaSettings } = await import('../../public/scripts/sillybunny-persona-settings.js');
const { eventSource, event_types } = await import('../../public/scripts/events.js');
const { createStatusPage } = await import('../../public/scripts/sillybunny-editor/status-page.js');
const folderStore = await import('../../public/scripts/sillybunny-folders.js');
const { loadStylesheetAsync } = await import('../../public/scripts/dynamic-styles.js');
// Deferred to Batch 6 until sillybunny-tabs.js behavioural harness is introduced.
const tabsSource = readFileSync(new URL('../../public/scripts/sillybunny-tabs.js', import.meta.url), 'utf8');
const personaMountSource = tabsSource.split('let personaEditorMountPromise = null;')[1].split('function setCharacterImportPanelVisible')[0];
const preloadSource = tabsSource.slice(tabsSource.indexOf('function preloadPanelStylesheets('), tabsSource.indexOf('function isLandingPageVisible('));
const personaStylesheets = [
    { href: 'css/sillybunny-editor-shell.css?v=20261126b', id: 'deferred-editor-shell-css' },
    { href: 'css/sillybunny-character-editor.css?v=20261123a', id: 'deferred-editor-chrome-css' },
    { href: 'css/sillybunny-entity-list.css?v=20261118zza', id: 'deferred-entity-list-css' },
    { href: 'css/sillybunny-persona-editor.css?v=20261122g', id: 'deferred-persona-editor-css' },
    { href: 'css/sillybunny-persona-detail.css?v=20261118zv', id: 'deferred-persona-detail-css' },
];
let container;
let mounted;

function subscribeLegacyPersonaChatStates() {
    // Route the real personas.js CHAT_CHANGED handler to the mounted editor adapter.
    realPersonasBundle.personas.setPersonaEditorAdapter(adapter);
    const forward = () => sharedEventSource.emit(sharedEventTypes.CHAT_CHANGED);
    eventSource.on(event_types.CHAT_CHANGED, forward);
    return () => {
        eventSource.removeListener(event_types.CHAT_CHANGED, forward);
        realPersonasBundle.personas.setPersonaEditorAdapter(null);
    };
}

async function personaTabMount(stylesheets = personaStylesheets) {
    // Execute the real lazy-mount/preload seam without bootstrapping the unrelated application shell.
    const module = new SourceTextModule(`
        const SB_PANEL_STYLESHEETS = { 'characters:persona': ${JSON.stringify(stylesheets)} };
        const ensureCharacterPersonaPanel = () => document.getElementById('sb_character_persona_panel');
        let personaEditorMountPromise = null;
        ${personaMountSource}
        ${preloadSource}
        export { setCharacterPersonaPanelVisible, preloadPanelStylesheets };
        export const mountPromise = () => personaEditorMountPromise && characterPanelRevealPromise;
    `, {
        context: createContext({ document, window, HTMLElement, console, createStatusPage, t: strings => strings.join('') }),
        importModuleDynamically: () => import('../../public/scripts/sillybunny-persona-editor.js'),
    });
    await module.link(() => { throw new Error('Unexpected static import in persona mount.'); });
    await module.evaluate();
    return module.namespace;
}

async function activateDeferredStylesheet({ href }) {
    const link = document.createElement('link');
    link.rel = 'preload';
    link.setAttribute('as', 'style');
    link.href = href;
    link.setAttribute('data-sb-deferred-style', '');
    link.dataset.sbMedia = 'all';
    document.head.append(link);
    realActivateDeferredStylesheet();
    return { link, activate: realActivateDeferredStylesheet };
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
    power_user.sb_folders = folderStore.normalizeFoldersData(null);
    let folderId = 0;
    folderStore.configureFolderStore({ powerUser: power_user, saveSettingsDebounced, idFactory: () => `folder-${++folderId}` });
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
    function realAvatarList(fetch) {
        return async () => {
            realPersonasFetchImpl = fetch;
            return await realPersonasBundle.personas.listPersonaAvatars();
        };
    }

    test('real HTTP list failure rejects first readiness and reopening fetches successfully', async () => {
        personas();
        const fetch = jest.fn().mockResolvedValueOnce({ ok: false })
            .mockResolvedValue({ ok: true, json: async () => [...avatarIds] });
        listAvatars.mockImplementation(realAvatarList(fetch));
        mounted = mountPersonaEditor(container);
        await expect(mounted.ready).rejects.toThrow();
        expect(container.querySelector('.sb-persona-editor')).toBeNull();
        mounted = mountPersonaEditor(container);
        await mounted.ready;
        expect(rowIds()).toEqual(avatarIds);
        expect(fetch).toHaveBeenCalledTimes(2);
    });

    test('real refresh failure preserves rows and the next reveal retries the list', async () => {
        personas();
        const fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => [...avatarIds] });
        listAvatars.mockImplementation(realAvatarList(fetch));
        mounted = mountPersonaEditor(container);
        await mounted.ready;
        const row = container.querySelector('.sb-persona-row');
        fetch.mockResolvedValueOnce({ ok: false });
        await expect(adapter.refresh('list')).rejects.toThrow();
        expect(rowIds()).toEqual(avatarIds);
        expect(container.querySelector('.sb-persona-row')).toBe(row);
        await settle();
        expect(fetch).toHaveBeenCalledTimes(2);
        await mounted.prepareReveal();
        expect(fetch).toHaveBeenCalledTimes(3);
        expect(rowIds()).toEqual(avatarIds);
    });

    test('malformed JSON lists reject the strict editor API while legacy avatar callers keep empty-success', async () => {
        const fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ invalid: true }) });
        await expect(realAvatarList(fetch)()).rejects.toThrow('Error');
        realPersonasFetchImpl = fetch;
        await expect(realPersonasBundle.personas.getUserAvatars(false)).resolves.toEqual([]);
    });

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

    test('the editor waits for shared shell, editor chrome, entity row, list and detail stylesheets before reveal', async () => {
        personas();
        const resolvers = [];
        globalThis.SillyBunnyAssets.loadStylesheetAsync.mockImplementation(() => new Promise(resolve => resolvers.push(resolve)));
        mounted = mountPersonaEditor(container);
        await settle();
        expect(resolvers).toHaveLength(5);
        expect(container.classList.contains('sb-persona-editor-mounted')).toBe(false);
        expect(adapter.isOpen()).toBe(false);
        resolvers[0]();
        resolvers[1]();
        resolvers[2]();
        resolvers[3]();
        await settle();
        expect(container.querySelector('.sb-persona-editor').hidden).toBe(true);
        resolvers[4]();
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

    test.each(['preload', 'stylesheet'])('adopts the existing entity-row %s and waits for it without making another link', async rel => {
        personas();
        const stylesheet = personaStylesheets.find(({ id }) => id === 'deferred-entity-list-css');
        const existing = document.createElement('link');
        existing.rel = rel;
        existing.setAttribute('as', 'style');
        existing.href = stylesheet.href;
        existing.setAttribute('data-sb-deferred-style', '');
        existing.dataset.sbMedia = 'all';
        document.head.append(existing);
        for (const { id, href } of personaStylesheets.filter(({ id }) => id !== stylesheet.id)) {
            const link = document.createElement('link');
            link.rel = 'stylesheet';
            link.id = id;
            link.href = href;
            document.head.append(link);
        }
        globalThis.SillyBunnyAssets.loadStylesheetAsync.mockImplementation(loadStylesheetAsync);
        mounted = mountPersonaEditor(container);
        await settle();

        expect(document.getElementById(stylesheet.id)).toBe(existing);
        expect(existing.rel).toBe('stylesheet');
        expect(existing.dataset.sbStyleActivated ?? 'false').toBe(rel === 'preload' ? 'true' : 'false');
        expect(document.querySelectorAll(`link[href="${stylesheet.href}"]`)).toHaveLength(1);
        for (const { id } of personaStylesheets.filter(({ id }) => id !== stylesheet.id)) {
            document.getElementById(id).dispatchEvent(new Event('load'));
        }
        await settle();
        expect(container.querySelector('.sb-persona-editor').hidden).toBe(true);
        existing.dispatchEvent(new Event('load'));
        await mounted.ready;
        expect(container.querySelector('.sb-persona-editor').hidden).toBe(false);
        expect(existing.media === '' || existing.media === 'all').toBe(true);
    });

    test('a failed adopted preload is removed and a fresh stylesheet can load on retry', async () => {
        const stylesheet = { href: 'css/sillybunny-entity-list.css?v=20261118zza&retry-test=adopted', id: 'deferred-entity-list-css' };
        const existing = document.createElement('link');
        existing.rel = 'preload';
        existing.setAttribute('as', 'style');
        existing.href = stylesheet.href;
        existing.setAttribute('data-sb-deferred-style', '');
        document.head.append(existing);
        globalThis.SillyBunnyAssets.loadStylesheetAsync.mockImplementation(loadStylesheetAsync);
        const loading = loadPersonaEditorStyles([stylesheet]);
        const failure = new Event('error');
        existing.dispatchEvent(failure);
        await expect(loading).rejects.toBe(failure);
        expect(existing.isConnected).toBe(false);

        const retrying = loadPersonaEditorStyles([stylesheet]);
        const retry = document.getElementById(stylesheet.id);
        expect(retry).not.toBe(existing);
        expect(retry.rel).toBe('stylesheet');
        retry.dispatchEvent(new Event('load'));
        await retrying;
        await loadPersonaEditorStyles([stylesheet]);
        expect(document.querySelectorAll(`link[href="${stylesheet.href}"]`)).toHaveLength(1);
    });

    test('a deferred stylesheet that failed before Persona subscribed is replaced and loaded', async () => {
        const stylesheet = { href: 'css/sillybunny-entity-list.css?v=20261118zza&retry-test=failed-before-subscribe', id: 'deferred-entity-list-css' };
        const { link, activate } = await activateDeferredStylesheet(stylesheet);
        expect(link.dataset.sbStyleState).toBe('loading');
        link.dispatchEvent(new Event('error'));
        expect(link.dataset.sbStyleState).toBe('error');
        activate();
        expect(link.dataset.sbStyleState).toBe('error');
        globalThis.SillyBunnyAssets.loadStylesheetAsync.mockImplementation(loadStylesheetAsync);
        const loading = loadPersonaEditorStyles([stylesheet]);
        const replacement = document.getElementById(stylesheet.id);
        expect(replacement).not.toBe(link);
        expect(link.isConnected).toBe(false);
        expect(replacement.dataset.sbStyleState).toBe('loading');
        expect(document.querySelectorAll(`link[href="${stylesheet.href}"]`)).toHaveLength(1);
        replacement.dispatchEvent(new Event('load'));
        await loading;
        expect(replacement.dataset.sbStyleState).toBe('loaded');
        expect(replacement.media).toBe('all');
    });

    test('a failed-before-subscribe stylesheet gets only one replacement and a second failure rejects', async () => {
        const stylesheet = { href: 'css/sillybunny-entity-list.css?v=20261118zza&retry-test=failed-twice', id: 'deferred-entity-list-css' };
        const { link } = await activateDeferredStylesheet(stylesheet);
        link.dispatchEvent(new Event('error'));
        globalThis.SillyBunnyAssets.loadStylesheetAsync.mockImplementation(loadStylesheetAsync);
        const loading = loadPersonaEditorStyles([stylesheet]);
        const replacement = document.getElementById(stylesheet.id);
        const failure = new Event('error');
        replacement.dispatchEvent(failure);
        await expect(loading).rejects.toBe(failure);
        expect(replacement.dataset.sbStyleState).toBe('error');
        expect(replacement.isConnected).toBe(false);
        expect(document.querySelectorAll(`link[href="${stylesheet.href}"]`)).toHaveLength(0);
        expect(globalThis.SillyBunnyAssets.loadStylesheetAsync).toHaveBeenCalledTimes(1);
    });

    test('a deferred stylesheet loaded before Persona subscribed resolves without another load event', async () => {
        const stylesheet = { href: 'css/sillybunny-entity-list.css?v=20261118zza&retry-test=loaded-before-subscribe', id: 'deferred-entity-list-css' };
        const { link, activate } = await activateDeferredStylesheet(stylesheet);
        link.dispatchEvent(new Event('load'));
        expect(link.dataset.sbStyleState).toBe('loaded');
        activate();
        expect(link.dataset.sbStyleState).toBe('loaded');
        globalThis.SillyBunnyAssets.loadStylesheetAsync.mockImplementation(loadStylesheetAsync);
        await loadPersonaEditorStyles([stylesheet]);
        expect(document.getElementById(stylesheet.id)).toBe(link);
        expect(link.dataset.loaded).toBe('true');
        expect(document.querySelectorAll(`link[href="${stylesheet.href}"]`)).toHaveLength(1);
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
        expect(warning).toHaveBeenCalledWith('[SillyBunny] Could not reveal the character panel.', failure);
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

    test.each(['hidden', 'aria-hidden'])('adapter visibility respects ancestor %s', async attribute => {
        await mount();
        const panel = document.getElementById('sb_character_persona_panel');
        panel.setAttribute(attribute, attribute === 'aria-hidden' ? 'true' : '');
        expect(adapter.isOpen()).toBe(false);
        panel.removeAttribute(attribute);
        expect(adapter.isOpen()).toBe(true);
    });

    test('an inert ancestor does not close the open editor, because a phone keeps the pane that is off screen inert', async () => {
        await mount();
        const panel = document.getElementById('sb_character_persona_panel');
        panel.setAttribute('inert', '');
        expect(adapter.isOpen()).toBe(true);
        panel.removeAttribute('inert');
    });

    test('rows match the boxed list pattern, with lazy avatars, subtitles and labelled badges', async () => {
        await mount();
        states[avatarIds[0]] = { inUse: true, default: true, locked: { chat: true, character: true } };
        await adapter.refresh('states');
        const row = container.querySelector('.sb-persona-row');
        expect(container.querySelector('.sb-persona-list-heading').textContent).toBe('Your Persona');
        expect(row.parentNode.matches('.ds-entity-list__rows[role="list"]')).toBe(true);
        expect(row.parentNode.parentNode.matches('.ds-pref-group.ds-entity-list')).toBe(true);
        expect(row.querySelector('.sb-persona-row-menu').classList.contains('sb-list-editor__row-menu')).toBe(true);
        expect(row.matches('.ds-entity-row.ds-entity-row--activatable')).toBe(true);
        expect(row.dataset.sbListKey).toBe(`persona:${avatarIds[0]}`);
        expect(row.getAttribute('role')).toBe('listitem');
        expect(row.tabIndex).toBe(0);
        const avatar = row.querySelector('img');
        expect(avatar.getAttribute('loading')).toBe('lazy');
        expect(avatar.getAttribute('decoding')).toBe('async');
        expect(avatar.alt).toBe('');
        expect(thumbnail).toHaveBeenCalledWith('persona', avatarIds[0], false);
        expect(row.querySelector('.ds-entity-row__title').textContent).toBe(records[avatarIds[0]].name);
        expect(row.querySelector('.ds-entity-row__subtitle').textContent).toBe('A title');
        expect(container.querySelectorAll('.ds-entity-row__subtitle')[1].textContent).toBe('First line');
        expect(row.querySelector('.ds-entity-row__chevron')).toBeNull();
        expect(row.querySelector('.sb-persona-row-badges').parentElement).toBe(row);
        expect(row.querySelector('.ds-entity-row__suffix').children).toHaveLength(1);
        expect([...row.querySelectorAll('.sb-persona-row-badges i')].map(badge => [badge.getAttribute('aria-label'), badge.title])).toEqual([
            ['Current Persona', 'Current Persona'], ['Default Persona', 'Default Persona'],
            ['Persona Is Locked to the Current Chat', 'Persona Is Locked to the Current Chat'],
            ['Persona Is Locked to the Current Character', 'Persona Is Locked to the Current Character'],
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

    test.each(['Enter', ' '])('shared rows retain arrow navigation and %s activation without using the persona', async key => {
        await mount();
        const rows = [...container.querySelectorAll('.sb-persona-row')];
        rows[0].focus();
        rows[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
        expect(document.activeElement).toBe(rows[1]);
        rows[1].dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true, cancelable: true }));
        expect(document.activeElement).toBe(rows[2]);
        rows[2].dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true, cancelable: true }));
        expect(document.activeElement).toBe(rows[0]);
        const more = rows[0].querySelector('.sb-persona-row-menu');
        more.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
        await settle();
        expect(mountDetail).not.toHaveBeenCalled();
        rows[0].dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
        await settle();
        expect(mountDetail).toHaveBeenLastCalledWith(expect.objectContaining({ avatarId: avatarIds[0] }));
        expect(usePersona).not.toHaveBeenCalled();
    });

    test('row menus expose Use, Duplicate and destructive Delete without opening the detail', async () => {
        await mount();
        container.querySelector('.sb-persona-row-menu').click();
        await settle();
        const actions = actionMenu.sections.flatMap(section => section.items);
        expect(actions.map(({ label }) => label)).toEqual(['Use This Persona', 'Duplicate', 'Delete']);
        expect(actions.at(-1).danger).toBe(true);
        expect(mountDetail).not.toHaveBeenCalled();
        await menuAction('Use This Persona', '.sb-persona-row-menu');
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
        expect(container.querySelector('.sb-persona-list-status').textContent).toBe('No Results FoundTry a different search');
        expect(container.querySelector('.sb-persona-list-heading').hidden).toBe(true);
        expect(container.querySelector('.sb-list-editor__status').textContent).toBe('No results');
    });

    test.each([
        ['1 persona', 1],
        ['3 personas', 3],
        ['0 personas', 0],
    ])('the header reads "%s" from one string per form', async (text, count) => {
        await mount(count);
        expect(container.querySelector('.sb-persona-list-subtitle').textContent).toBe(text);
    });

    test('an empty library offers a create draft', async () => {
        await mount(0);
        expect(container.querySelector('.sb-persona-list-status .sb-status-page__title').textContent).toBe('No Personas');
        container.querySelector('.sb-persona-list-status button').click();
        await settle();
        expect(mountDetail).toHaveBeenLastCalledWith(expect.objectContaining({ mode: 'create', avatarId: null }));
    });

    test('sort menu has a titled radio section and persists asc/desc', async () => {
        await mount();
        container.querySelector('.sb-persona-sort-button').click();
        await settle();
        expect(actionMenu.sections[0].title).toBe('Sort By');
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
        const row = container.querySelector('.sb-persona-row');
        const avatar = row.querySelector('img');
        const menu = row.querySelector('.sb-persona-row-menu');
        const detail = await open();
        dirty = true;
        records[avatarIds[0]].name = 'Updated name';
        records[avatarIds[0]].descriptor.title = 'Updated title';
        await adapter.refresh('persona', avatarIds[0]);
        expect(container.querySelector('.sb-persona-row')).toBe(row);
        expect(row.querySelector('img')).toBe(avatar);
        expect(row.querySelector('.sb-persona-row-menu')).toBe(menu);
        expect(menu.getAttribute('aria-label')).toBe('Actions for Updated name');
        expect(menu.title).toBe('Actions for Updated name');
        expect(row.querySelector('.ds-entity-row__title').textContent).toBe('Updated name');
        expect(row.querySelector('.ds-entity-row__subtitle').textContent).toBe('Updated title');
        expect(row.getAttribute('aria-label')).toBe('Updated name');
        expect(row.classList.contains('is-selected')).toBe(true);
        expect(detail.refresh).toHaveBeenLastCalledWith('persona', avatarIds[0]);
        expect(detail.destroy).not.toHaveBeenCalled();
        expect(mountDetail).toHaveBeenCalledTimes(1);
    });

    test('hidden updates do no row/detail work and coalesce into the next prepared reveal', async () => {
        await mount();
        const detail = await open();
        const panel = document.getElementById('sb_character_persona_panel');
        panel.hidden = true;
        const before = container.innerHTML;
        records[avatarIds[0]].name = 'Changed while hidden';
        detail.refresh.mockClear();
        listAvatars.mockClear();
        await Promise.all([adapter.refresh('persona', avatarIds[0]), adapter.refresh('states'), adapter.refresh('states')]);
        expect(container.innerHTML).toBe(before);
        expect(detail.refresh).not.toHaveBeenCalled();
        expect(listAvatars).not.toHaveBeenCalled();
        await mounted.prepareReveal();
        expect(container.querySelector('.ds-entity-row__title').textContent).toBe('Changed while hidden');
        expect(detail.refresh).toHaveBeenCalledTimes(1);
        await mounted.prepareReveal();
        expect(detail.refresh).toHaveBeenCalledTimes(1);
    });

    test('visible duplicate adapter notifications share one refresh', async () => {
        await mount();
        const detail = await open();
        detail.refresh.mockClear();
        await Promise.all([adapter.refresh('persona', avatarIds[0]), adapter.refresh('persona', avatarIds[0]), adapter.refresh('states')]);
        expect(detail.refresh).toHaveBeenCalledTimes(1);
    });

    test('an avatar notification cannot mask a simultaneous record deletion', async () => {
        await mount();
        const id = avatarIds[0];
        delete records[id];
        await Promise.all([adapter.refresh('avatar', id), adapter.refresh('persona', id)]);
        expect(rowIds()).not.toContain(id);
    });

    test('notifications arriving during hidden preparation are applied before reveal', async () => {
        await mount();
        const detail = await open();
        document.getElementById('sb_character_persona_panel').hidden = true;
        let finish;
        listAvatars.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
        await adapter.refresh('list');
        const preparing = mounted.prepareReveal();
        await adapter.refresh('persona', avatarIds[0]);
        finish([...avatarIds]);
        await preparing;
        const calls = detail.refresh.mock.calls.length;
        await mounted.prepareReveal();
        expect(detail.refresh).toHaveBeenCalledTimes(calls);
        expect(detail.refresh).toHaveBeenLastCalledWith('persona', avatarIds[0]);
    });

    test('a list refresh reloads overwritten avatar images without replacing their rows', async () => {
        await mount();
        const row = container.querySelector('.sb-persona-row');
        thumbnail.mockClear();
        await adapter.refresh('list');
        expect(container.querySelector('.sb-persona-row')).toBe(row);
        expect(thumbnail).toHaveBeenCalledWith('persona', avatarIds[0], true);
    });

    describe('Show More', () => {
        const showMore = () => container.querySelector('.sb-list-show-more');
        const press = async () => {
            container.querySelector('.sb-list-show-more__button').click();
            await settle();
        };

        test('loads the list in batches of the saved size without asking about an unsaved detail, and has no pager', async () => {
            await mount(15);
            await open();
            dirty = true;
            expect(container.querySelector('.sb-list-pagination')).toBeNull();
            expect(rowIds()).toHaveLength(5);
            expect(showMore().parentElement.matches('.ds-entity-list__footer')).toBe(true);
            expect(showMore().hidden).toBe(false);
            await press();
            expect(rowIds()).toHaveLength(10);
            expect(popupShow).not.toHaveBeenCalled();
            await press();
            expect(rowIds()).toHaveLength(15);
            expect(showMore().hidden).toBe(true);
            expect(container.querySelector('.ds-entity-list__footer').hidden).toBe(true);
        });

        test('keeps focus in the list when the press loads the last batch', async () => {
            await mount(8);
            const button = container.querySelector('.sb-list-show-more__button');
            button.focus();
            await press();
            expect(rowIds()).toHaveLength(8);
            expect(document.activeElement).toBe(container.querySelectorAll('.sb-persona-row')[5]);
        });

        test.each([['10', 10], ['not a number', 50], ['0', 50], [null, 50]])('a saved size of %p makes batches of %i', async (saved, size) => {
            accountStorage.getItem.mockReturnValue(saved);
            await mount(60);
            expect(rowIds()).toHaveLength(size);
        });

        test('a search starts again from the first batch, and a sort does too', async () => {
            await mount(15);
            await press();
            expect(rowIds()).toHaveLength(10);
            const input = container.querySelector('.sb-persona-search');
            input.value = 'persona';
            input.dispatchEvent(new Event('input', { bubbles: true }));
            jest.advanceTimersByTime(300);
            await settle();
            expect(rowIds()).toHaveLength(5);
            await press();
            expect(rowIds()).toHaveLength(10);
            await menuAction('Z-A', '.sb-persona-sort-button');
            expect(rowIds()).toHaveLength(5);
        });

        test('revealing a persona loads the batch that holds it and never shrinks what is shown', async () => {
            await mount(15);
            await press();
            expect(await mounted.selectPersona('avatar-2.png')).toBe(true);
            expect(rowIds()).toHaveLength(10);
            expect(await mounted.selectPersona('avatar-12.png')).toBe(true);
            expect(rowIds()).toHaveLength(15);
            expect(rowIds()).toContain('avatar-12.png');
            expect(container.querySelector('.sb-persona-row.is-selected').dataset.avatarId).toBe('avatar-12.png');
        });
    });

    describe('sort in the search bar', () => {
        test('the sort button ends the search bar and the header keeps its other buttons', async () => {
            await mount();
            const field = container.querySelector('.sb-persona-search-field');
            const sort = container.querySelector('.sb-persona-sort-button');
            expect(field.lastElementChild).toBe(sort);
            expect(container.querySelector('.sb-persona-list-header').contains(sort)).toBe(false);
            expect([...container.querySelectorAll('.sb-persona-list-header button')].map(node => node.getAttribute('aria-label')))
                .toEqual(['Search', 'New', 'Persona Management']);
        });

        test('the Search toggle and the sort button show a non-default order', async () => {
            await mount();
            const sort = container.querySelector('.sb-persona-sort-button');
            const search = container.querySelector('.sb-persona-list-header button[aria-label="Search"]');
            expect([sort.getAttribute('aria-pressed'), search.getAttribute('aria-pressed')]).toEqual(['false', 'false']);
            await menuAction('Z-A', '.sb-persona-sort-button');
            expect([sort.getAttribute('aria-pressed'), search.getAttribute('aria-pressed')]).toEqual(['true', 'true']);
            await menuAction('A-Z', '.sb-persona-sort-button');
            expect([sort.getAttribute('aria-pressed'), search.getAttribute('aria-pressed')]).toEqual(['false', 'false']);
        });

        test('pressing the sort button keeps an empty search open', async () => {
            await mount();
            const search = container.querySelector('.sb-persona-list-header button[aria-label="Search"]');
            search.click();
            await settle();
            const input = container.querySelector('.sb-persona-search');
            expect(container.querySelector('.sb-persona-search-field').hidden).toBe(false);
            input.focus();
            expect(document.activeElement).toBe(input);
            container.querySelector('.sb-persona-sort-button').dispatchEvent(new Event('pointerdown', { bubbles: true }));
            input.dispatchEvent(new FocusEvent('focusout', { relatedTarget: null, bubbles: true }));
            expect(container.querySelector('.sb-persona-search-field').hidden).toBe(false);
        });
    });

    describe('selection mode', () => {
        const check = index => container.querySelectorAll('.sb-persona-row .sb-selection-check')[index];
        const bar = id => container.querySelector(`.sb-persona-selection-bar [data-action-id="${id}"]`);

        async function select(...indexes) {
            await menuAction('Select');
            for (const index of indexes) check(index).click();
            await settle();
        }

        test('the list menu starts it, and it replaces the header and takes the row buttons out of use', async () => {
            await mount();
            await select(0, 1);
            const editor = container.querySelector('.sb-persona-editor');
            expect(editor.dataset.selectionMode).toBe('true');
            expect(container.querySelector('.sb-persona-selection-header .sb-selection-header')).not.toBeNull();
            expect([...container.querySelectorAll('.sb-persona-selection-bar [data-action-id]')].map(node => node.dataset.actionId))
                .toEqual(['folder', 'duplicate', 'delete']);
            expect([...container.querySelectorAll('.sb-persona-row .ds-entity-row__suffix')].every(node => node.inert)).toBe(true);
            container.querySelector('.sb-selection-cancel').click();
            await settle();
            expect(editor.dataset.selectionMode).toBe('false');
            expect([...container.querySelectorAll('.sb-persona-row .ds-entity-row__suffix')].some(node => node.inert)).toBe(false);
        });

        test('a click on a row selects it and opens no persona', async () => {
            await mount();
            await select(0);
            container.querySelector('[data-avatar-id="avatar-1.png"]').click();
            await settle();
            expect(mountDetail).not.toHaveBeenCalled();
        });

        test('Move to Folder files the selection and leaves selection mode', async () => {
            await mount();
            const folder = folderStore.createFolder('personas', 'Cast');
            await select(0, 2);
            bar('folder').click();
            await settle();
            const items = actionMenu.sections.flatMap(section => section.items);
            expect(items.map(item => item.label)).toEqual(['No Folder', 'Cast']);
            items[1].onSelect();
            await settle();
            expect(folderStore.getFolderId('personas', 'avatar-0.png')).toBe(folder.id);
            expect(folderStore.getFolderId('personas', 'avatar-2.png')).toBe(folder.id);
            expect(folderStore.getFolderId('personas', 'avatar-1.png')).toBeNull();
            expect(container.querySelector('.sb-persona-editor').dataset.selectionMode).toBe('false');
        });

        test('Duplicate copies each selected persona once', async () => {
            await mount();
            await select(0, 1);
            bar('duplicate').click();
            await settle();
            expect(duplicate.mock.calls.map(([id]) => id)).toEqual(['avatar-0.png', 'avatar-1.png']);
        });

        test('Delete asks once for the set, then deletes each persona silently', async () => {
            await mount();
            popupChoice = 1;
            states['avatar-1.png'] = { ...defaultState(), default: true };
            await select(0, 1);
            globalThis.toastr = { warning: jest.fn(), error: jest.fn() };
            try {
                remove.mockImplementation(async () => true);
                bar('delete').click();
                await settle();
                expect(confirmDestructiveAction).toHaveBeenCalledTimes(1);
                expect(confirmDestructiveAction).toHaveBeenCalledWith({ text: 'Delete 2 personas? This cannot be undone.', confirmLabel: 'Delete' });
                expect(remove.mock.calls).toEqual([['avatar-0.png', { silent: true }], ['avatar-1.png', { silent: true }]]);
                expect(globalThis.toastr.warning).toHaveBeenCalledTimes(1);
                expect(globalThis.toastr.warning).toHaveBeenCalledWith('The default persona was deleted. You will need to set a new default persona.', 'Default persona deleted');
            } finally {
                delete globalThis.toastr;
            }
        });

        test('declining the confirmation deletes nothing and keeps the selection', async () => {
            await mount();
            popupChoice = 0;
            await select(0);
            bar('delete').click();
            await settle();
            expect(remove).not.toHaveBeenCalled();
            expect(container.querySelector('.sb-persona-editor').dataset.selectionMode).toBe('true');
        });
    });

    describe('folders', () => {
        const headers = () => [...container.querySelectorAll('.sb-folder-row')];
        // A folder header has no aria-label: its name is its title, then its count, as the content reads.
        const headerNames = () => headers().map(header => {
            expect(header.hasAttribute('aria-label')).toBe(false);
            return [...header.querySelectorAll('.ds-entity-row__title, .ds-entity-row__subtitle')].map(node => node.textContent).join(' ');
        });
        const order = () => [...container.querySelectorAll('.sb-persona-list-rows > *')]
            .map(row => row.classList.contains('sb-folder-row') ? `folder:${row.dataset.folderId}` : row.dataset.avatarId);

        test('lists a folder header with its members, then the unfiled personas, and counts them with the persona strings', async () => {
            const folder = folderStore.createFolder('personas', 'Cast');
            folderStore.setFolder('personas', ['avatar-2.png', 'avatar-1.png'], folder.id);
            await mount(4);
            expect(order()).toEqual([`folder:${folder.id}`, 'avatar-1.png', 'avatar-2.png', 'avatar-0.png', 'avatar-3.png']);
            expect(headerNames()).toEqual(['Cast 2 personas']);
            expect(headers()[0].getAttribute('aria-expanded')).toBe('true');
            const classes = [...container.querySelectorAll('.sb-persona-list-rows > *')].map(row => [
                row.classList.contains('is-folder-section-start'), row.classList.contains('is-folder-member'), row.classList.contains('is-folder-section-end'),
            ]);
            expect(classes).toEqual([[true, false, false], [false, true, false], [false, true, true], [false, false, false], [false, false, false]]);
            expect(container.querySelector('.sb-persona-list-subtitle').textContent).toBe('4 personas');
        });

        test('counts one persona with the singular string and shows an empty folder', async () => {
            const one = folderStore.createFolder('personas', 'One');
            folderStore.createFolder('personas', 'Empty');
            folderStore.setFolder('personas', ['avatar-0.png'], one.id);
            await mount(2);
            expect(headerNames()).toEqual(['One 1 persona', 'Empty 0 personas']);
        });

        test('a header toggles its folder from a click and from Enter, and the choice is stored', async () => {
            const folder = folderStore.createFolder('personas', 'Cast');
            folderStore.setFolder('personas', ['avatar-1.png'], folder.id);
            await mount(3);
            headers()[0].click();
            await settle();
            expect(folderStore.getFolders('personas')[0].expanded).toBe(false);
            expect(order()).toEqual([`folder:${folder.id}`, 'avatar-0.png', 'avatar-2.png']);
            expect(headers()[0].getAttribute('aria-expanded')).toBe('false');
            headers()[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
            await settle();
            expect(folderStore.getFolders('personas')[0].expanded).toBe(true);
            expect(order()).toContain('avatar-1.png');
            expect(mountDetail).not.toHaveBeenCalled();
        });

        test('a search opens the folders that hold a match, hides the others and leaves the stored state alone', async () => {
            const cast = folderStore.createFolder('personas', 'Cast', { expanded: false });
            const other = folderStore.createFolder('personas', 'Other');
            folderStore.setFolder('personas', ['avatar-1.png'], cast.id);
            folderStore.setFolder('personas', ['avatar-2.png'], other.id);
            await mount(3);
            expect(order()).not.toContain('avatar-1.png');
            const input = container.querySelector('.sb-persona-search');
            input.value = 'persona 01';
            input.dispatchEvent(new Event('input', { bubbles: true }));
            jest.advanceTimersByTime(300);
            await settle();
            expect(order()).toEqual([`folder:${cast.id}`, 'avatar-1.png']);
            expect(headers()[0].classList.contains('is-folder-temporarily-expanded')).toBe(true);
            expect(folderStore.getFolders('personas').map(folder => folder.expanded)).toEqual([false, true]);
            headers()[0].click();
            await settle();
            expect(folderStore.getFolders('personas')[0].expanded).toBe(false);
            input.value = '';
            input.dispatchEvent(new Event('input', { bubbles: true }));
            jest.advanceTimersByTime(300);
            await settle();
            expect(order()).toEqual([`folder:${cast.id}`, `folder:${other.id}`, 'avatar-2.png', 'avatar-0.png']);
        });

        test('opening a persona inside a collapsed folder expands it first', async () => {
            const cast = folderStore.createFolder('personas', 'Cast', { expanded: false });
            folderStore.setFolder('personas', ['avatar-1.png'], cast.id);
            await mount(3);
            expect(await mounted.selectPersona('avatar-1.png')).toBe(true);
            expect(folderStore.getFolders('personas')[0].expanded).toBe(true);
            expect(container.querySelector('.sb-persona-row.is-selected').dataset.avatarId).toBe('avatar-1.png');
        });

        test('a folder change from the Folder Manager or the detail redraws the list and tells the open detail', async () => {
            await mount(3);
            const detail = await open(1);
            detail.refresh.mockClear();
            const folder = folderStore.createFolder('personas', 'Cast');
            await settle();
            expect(headers()).toHaveLength(1);
            expect(detail.refresh).toHaveBeenCalledWith('folders');
            folderStore.setFolder('personas', ['avatar-1.png'], folder.id);
            await settle();
            expect(order()).toEqual([`folder:${folder.id}`, 'avatar-1.png', 'avatar-0.png', 'avatar-2.png']);
            folderStore.deleteFolder('personas', folder.id);
            await settle();
            expect(headers()).toHaveLength(0);
            expect(rowIds()).toEqual(['avatar-0.png', 'avatar-1.png', 'avatar-2.png']);
            expect(container.querySelector('.sb-persona-row.is-selected').dataset.avatarId).toBe('avatar-1.png');
        });

        test('a change to another folder scope leaves the list and the detail alone', async () => {
            await mount(2);
            const detail = await open(0);
            detail.refresh.mockClear();
            const before = [...container.querySelectorAll('.sb-persona-row')];
            folderStore.createFolder('characters', 'Elsewhere');
            await settle();
            expect(detail.refresh).not.toHaveBeenCalled();
            expect([...container.querySelectorAll('.sb-persona-row')]).toEqual(before);
        });

        test('Manage Folders sits in the list menu and opens the Persona scope', async () => {
            const open = jest.fn();
            globalThis.SillyBunnyFolderManager = { open };
            try {
                await mount();
                container.querySelector('.sb-persona-list-menu').click();
                await settle();
                expect(actionMenu.sections.flatMap(section => section.items).map(item => item.label)).toEqual([
                    'Global Settings', 'Select', 'Manage Folders', 'Backup', 'Restore', 'Usage Stats',
                ]);
                await menuAction('Manage Folders');
                expect(open).toHaveBeenCalledWith('personas');
            } finally {
                delete globalThis.SillyBunnyFolderManager;
            }
        });
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
        const unsubscribe = subscribeLegacyPersonaChatStates();
        try { await eventSource.emit(event_types.CHAT_CHANGED, 'chat'); } finally { unsubscribe(); }
        expect(detail.refresh).toHaveBeenCalledTimes(2);
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

    test('real CHAT_CHANGED forwarding refreshes once when visible and defers/coalesces hidden events until reveal', async () => {
        await mount();
        const detail = await open();
        const unsubscribe = subscribeLegacyPersonaChatStates();
        try {
            detail.refresh.mockClear();
            await eventSource.emit(event_types.CHAT_CHANGED, 'visible-chat');
            await settle();
            expect(detail.refresh).toHaveBeenCalledTimes(1);
            expect(detail.refresh).toHaveBeenLastCalledWith('states', undefined);
            const panel = document.getElementById('sb_character_persona_panel');
            panel.hidden = true;
            const before = container.innerHTML;
            detail.refresh.mockClear();
            await eventSource.emit(event_types.CHAT_CHANGED, 'hidden-chat-1');
            await eventSource.emit(event_types.CHAT_CHANGED, 'hidden-chat-2');
            await settle();
            expect(detail.refresh).not.toHaveBeenCalled();
            expect(container.innerHTML).toBe(before);
            await mounted.prepareReveal();
            panel.hidden = false;
            mounted.onReveal();
            expect(detail.refresh).toHaveBeenCalledTimes(1);
            expect(detail.refresh).toHaveBeenLastCalledWith('states', undefined);
            await mounted.prepareReveal();
            expect(detail.refresh).toHaveBeenCalledTimes(1);
        } finally { unsubscribe(); }
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

    test('openPersonaEditor routes Characters → Persona, loads the batch of a later persona, and scrolls to notes', async () => {
        await mount(15);
        expect(await openPersonaEditor({ avatarId: 'avatar-12.png', section: 'notes' })).toBe(true);
        expect(globalThis.SillyBunnyShell.openTab).toHaveBeenCalledWith('characters', 'persona');
        expect(mountDetail).toHaveBeenLastCalledWith(expect.objectContaining({ avatarId: 'avatar-12.png' }));
        expect(rowIds()).toContain('avatar-12.png');
        expect(details.at(-1).scrollToSection).toHaveBeenCalledWith('notes');
        expect(await openPersonaEditor({ avatarId: 'missing.png' })).toBe(false);
    });

    test('openPersonaEditor respects a cancelled dirty guard and never loads more rows', async () => {
        await mount(15);
        await open();
        dirty = true;
        expect(await openPersonaEditor({ avatarId: 'avatar-12.png' })).toBe(false);
        expect(mountDetail).toHaveBeenCalledTimes(1);
        expect(details[0].discard).not.toHaveBeenCalled();
        expect(rowIds()).toHaveLength(5);
    });

    test('Persona Back uses origin navigation with a normal list-close fallback', async () => {
        await mount();
        await open();
        const { requestClose } = mountDetail.mock.calls.at(-1)[0];
        await requestClose();
        expect(back).toHaveBeenCalledWith({ current: { kind: 'persona-editor', id: avatarIds[0] }, fallback: expect.any(Function) });
        expect(container.querySelector('.sb-persona-editor').dataset.open).toBe('false');
    });

    test('superseded Persona routes never select an avatar after a delayed shell mount', async () => {
        await mount();
        let resolveRoute;
        let current = true;
        globalThis.SillyBunnyShell.openTab.mockImplementationOnce(() => new Promise(resolve => { resolveRoute = resolve; }));
        const opening = openPersonaEditor({ avatarId: avatarIds[1], isCurrent: () => current });
        current = false;
        resolveRoute(mounted);
        expect(await opening).toBe(false);
        expect(mountDetail).not.toHaveBeenCalled();
    });

    test.each(['route', 'ready'])('a stalled Persona %s times out and its late completion cannot select an avatar', async phase => {
        await mount();
        let finish;
        const pending = new Promise(resolve => { finish = resolve; });
        if (phase === 'route') globalThis.SillyBunnyShell.openTab.mockReturnValueOnce(pending);
        else mounted.ready = pending;
        const opening = openPersonaEditor({ avatarId: avatarIds[1] });
        await jest.advanceTimersByTimeAsync(5000);
        expect(await opening).toBe(false);
        finish(phase === 'route' ? mounted : undefined);
        await settle();
        expect(mountDetail).not.toHaveBeenCalled();
    });

    test('a selection superseded during its dirty guard never replaces detail or loads more rows', async () => {
        await mount(15);
        await open();
        dirty = true;
        let approve;
        let current = true;
        popupShow.mockImplementationOnce(() => new Promise(resolve => { approve = resolve; }));
        const selecting = mounted.selectPersona('avatar-12.png', 'notes', () => current);
        await settle();
        current = false;
        approve(2);
        expect(await selecting).toBe(false);
        expect(mountDetail).toHaveBeenCalledTimes(1);
        expect(rowIds()).toHaveLength(5);
        expect(details[0].scrollToSection).not.toHaveBeenCalled();
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
        expect(input.checked).toBe(true);
        expect(input.hasAttribute('aria-checked')).toBe(false);
        settings.destroy();
        settings.destroy();
        expect(input.parentNode).toBe(parent);
        expect(input.nextSibling).toBe(next);
        expect(input.outerHTML).toBe(originalAttributes);
        input.click();
        expect(onChange).toHaveBeenCalledTimes(2);
    });

    test('Escape in a field keeps focus there when Back is hidden, closes outside fields, and stops propagation in both cases', () => {
        const host = document.createElement('div');
        container.append(host);
        const onClose = jest.fn();
        const bubble = jest.fn();
        container.addEventListener('keydown', bubble);
        const settings = mountPersonaSettings({ host, onClose });
        const input = host.querySelector('input');
        input.focus();
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
        expect(document.activeElement).toBe(input);
        expect(onClose).not.toHaveBeenCalled();
        settings.focusTarget().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
        expect(onClose).toHaveBeenCalledTimes(1);
        expect(bubble).not.toHaveBeenCalled();
        settings.destroy();
    });

    test('Escape in a field does what Back does where Back is drawn', () => {
        const host = document.createElement('div');
        container.append(host);
        const onClose = jest.fn();
        const settings = mountPersonaSettings({ host, onClose });
        host.querySelector('.sb-persona-detail-back').getClientRects = () => [{ width: 36, height: 36 }];
        const input = host.querySelector('input');
        input.focus();
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
        expect(onClose).toHaveBeenCalledTimes(1);
        settings.destroy();
    });
});
