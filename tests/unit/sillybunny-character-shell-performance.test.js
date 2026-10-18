/** @jest-environment jsdom */
/* eslint-disable playwright/no-standalone-expect, playwright/prefer-web-first-assertions -- Jest checks synchronous DOM state. */
import { beforeEach, describe, expect, jest, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { createStatusPage } from '../../public/scripts/sillybunny-editor/status-page.js';

const read = path => readFileSync(new URL(`../../public/${path}`, import.meta.url), 'utf8');
const tabs = read('scripts/sillybunny-tabs.js');
const script = read('script.js');
const css = read('css/sillybunny-tabs.css');
const section = (source, from, to) => source.slice(source.indexOf(from), source.indexOf(to));
const deferred = () => {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
};
const settle = async () => { for (let count = 0; count < 10; count++) await Promise.resolve(); };

beforeEach(() => { document.body.replaceChildren(); });

describe('Characters tab shell', () => {
    test.each([true, false])('animation cleanup only mutates a real opening class (%s)', opening => {
        document.body.innerHTML = `<div id="sb-settings-page" class="${opening ? 'sb-settings-page--opening' : ''}"></div>`;
        const page = document.getElementById('sb-settings-page');
        const observer = new MutationObserver(() => {});
        observer.observe(page, { attributes: true, attributeFilter: ['class'] });
        const animation = { onfinish: jest.fn(), cancel: jest.fn() };
        const state = { pageAnimation: animation, closeTimer: 42 };
        const clearTimeout = jest.fn();
        const clear = runInNewContext(`${section(tabs, 'function getSettingsPage(', 'function animateSettingsPage(')} clearSettingsAnimationState;`, {
            document, sbSettingsState: state, clearTimeout,
        });
        clear();
        expect(observer.takeRecords()).toHaveLength(opening ? 1 : 0);
        expect(page.classList.contains('sb-settings-page--opening')).toBe(false);
        expect(animation.onfinish).toBeNull();
        expect(animation.cancel).toHaveBeenCalledTimes(1);
        expect(state.pageAnimation).toBeNull();
        expect(clearTimeout).toHaveBeenCalledWith(42);
        expect(state.closeTimer).toBe(0);
        clear();
        expect(observer.takeRecords()).toHaveLength(0);
        observer.disconnect();
    });

    test.each([
        ['edit', true], ['edit', false], ['create', true], ['create', false],
    ])('%s mode schedules one focus and writes version once (switchMenu=%s)', (mode, switchMenu) => {
        document.body.innerHTML = '<form id="send_form"><input></form><div id="right-nav-panel" tabindex="-1"></div>';
        const writes = [];
        const chain = new Proxy({}, { get: (_target, method) => (...args) => {
            writes.push([method, ...args]);
            return chain;
        } });
        const dollar = selector => new Proxy(chain, { get: (target, method) => (...args) => {
            writes.push([selector, method, ...args]);
            return target;
        } });
        const frames = [];
        const context = {
            document, $: dollar, characters: [{ name: 'Name', avatar: 'avatar.png', data: { character_version: 'v2' } }],
            selected_group: null, selected_button: '', create_save: { character_version: 'v2' }, default_avatar: '/default.png',
            setMenuType: jest.fn(), selectRightMenuWithAnimation: jest.fn(), HTMLElement,
            window: { requestAnimationFrame: callback => frames.push(callback) },
            beginCharacterEditorLoad: jest.fn(), formatCreatorNotes: () => '',
            depth_prompt_depth_default: 4, depth_prompt_role_default: 'system', talkativeness_default: 0.5,
            timestampToMoment: () => ({ toISOString: () => '' }), updateFavButtonState: jest.fn(), getThumbnailUrl: () => '/avatar.png',
            setWorldInfoButtonClass: jest.fn(), checkEmbeddedWorld: jest.fn(), loadCharacterEditorGreetings: jest.fn(),
            openCharacterEditorSession: jest.fn(), openCharacterEditorCreateSession: jest.fn(), isExternalMediaAllowed: () => true, getCharacterSource: () => '',
            eventSource: { emit: jest.fn() }, event_types: {}, saveSettingsDebounced: jest.fn(),
        };
        const api = runInNewContext(`
            ${section(script, 'function focusUiSurface(', 'function scheduleUiSurfaceFocus(')}
            ${section(script, 'export function select_selected_character(', 'function select_rm_characters(').replace('export ', '')}
            ({ select_selected_character, select_rm_create });
        `, context);
        const chatInput = document.querySelector('#send_form input');
        chatInput.focus();
        if (mode === 'edit') api.select_selected_character(0, { switchMenu });
        else api.select_rm_create({ switchMenu });
        expect(document.activeElement).not.toBe(chatInput);
        expect(frames).toHaveLength(1);
        frames[0]();
        expect(document.activeElement).toBe(document.getElementById('right-nav-panel'));
        expect(writes.filter(([selector, method]) => selector === '#character_version_textarea' && method === 'val')).toEqual([
            ['#character_version_textarea', 'val', 'v2'],
        ]);
        expect(context.setMenuType.mock.calls).toEqual(switchMenu ? [[mode === 'edit' ? 'character_edit' : 'create']] : []);
    });

    test.each([true, false])('right-menu opacity is immediate only when shell hosted (%s)', hosted => {
        document.body.innerHTML = `<div id="right-nav-panel" class="${hosted ? 'sb-settings-mounted-shell' : ''}"><div id="rm_characters_block" class="right_menu"></div><div id="rm_ch_create_block" class="right_menu"></div></div>`;
        const raf = jest.fn();
        const transition = jest.fn();
        const dollar = target => ({
            toggle: jest.fn(), transition,
            css: (name, value) => {
                if (typeof target === 'string') return '';
                if (value === undefined) return target.style[name];
                target.style[name] = value;
            },
        });
        const select = runInNewContext(`${section(script, 'export function selectRightMenuWithAnimation(', 'function focusUiSurface(').replace('export ', '')}; selectRightMenuWithAnimation;`, {
            document, $: dollar, isMobile: () => false, animation_duration: 125,
            window: { requestAnimationFrame: raf, setTimeout: jest.fn() },
        });
        select('rm_characters_block');
        expect(document.getElementById('rm_characters_block').style.opacity).toBe(hosted ? '1' : '0');
        expect(raf).toHaveBeenCalledTimes(hosted ? 0 : 1);
        expect(transition).not.toHaveBeenCalled();
    });

    test('Characters active colour/aria is synchronous and drawer observers cannot overwrite it', () => {
        document.body.innerHTML = '<div id="right-nav-panel" class="sb-settings-mounted-shell"></div><button id="sb-character-toggle"><i></i><span></span></button><i id="legacy" class="openIcon"></i>';
        const state = { open: true, activeShell: 'characters' };
        const api = runInNewContext(`
            ${section(tabs, 'function syncProxyButtonState(', 'function syncCharacterTopbarButtonState(')}
            ${section(tabs, 'function syncSettingsPageActiveButton(', 'function setSettingsSidebarSearchOpen(')}
            ({ syncProxyButtonState, syncSettingsPageActiveButton });
        `, {
            document, HTMLElement, sbSettingsState: state,
            SB_TOPBAR_CLUSTERS: [{ key: 'characters', leadId: 'sb-character-toggle' }],
            getCharacterPanel: () => document.getElementById('right-nav-panel'),
        });
        const button = document.getElementById('sb-character-toggle');
        api.syncSettingsPageActiveButton();
        expect(button.classList.contains('sb-settings-active')).toBe(true);
        expect(button.getAttribute('aria-expanded')).toBe('true');
        api.syncProxyButtonState(button, document.getElementById('legacy'));
        expect(button.classList.contains('is-open')).toBe(false);
        state.open = false;
        api.syncSettingsPageActiveButton();
        api.syncProxyButtonState(button, document.getElementById('legacy'));
        expect(button.classList.contains('sb-settings-active')).toBe(false);
        expect(button.getAttribute('aria-expanded')).toBe('false');
        expect(css).toMatch(/\.sb-proxy-button i\s*\{[^}]*color: inherit;\s*transition: transform/);
        expect(css).toMatch(/\.sb-settings-tab\s*\{[^}]*transition: none;/);
    });

    test.each(['persona', 'world-info', 'import'])('%s stays on one loading surface through styles, ready and prepare; stale navigation never reveals it', async tab => {
        const host = document.createElement('section');
        host.id = tab;
        document.body.append(host);
        const styles = deferred();
        const ready = deferred();
        const prepared = deferred();
        const controller = { ready: ready.promise, prepareReveal: jest.fn(() => prepared.promise), onReveal: jest.fn() };
        const mount = jest.fn(async () => { await styles.promise; return controller; });
        const api = runInNewContext(`const deferredCharacterPanels = new WeakMap();
            ${section(tabs, 'function hideDeferredCharacterPanel(', 'async function mountCharacterListController(')}
            ({ revealDeferredCharacterPanel, hideDeferredCharacterPanel });
        `, { document, HTMLElement, createStatusPage, t: strings => strings.join(''), console });
        const first = api.revealDeferredCharacterPanel(host, host, mount);
        const status = host.nextElementSibling;
        expect(host.hidden).toBe(true);
        expect(status.hidden).toBe(false);
        styles.resolve();
        await settle();
        expect(host.hidden).toBe(true);
        ready.resolve();
        await settle();
        expect(controller.prepareReveal).toHaveBeenCalledTimes(1);
        expect(host.hidden).toBe(true);
        api.hideDeferredCharacterPanel(host);
        prepared.resolve();
        expect(await first).toBe(false);
        expect(host.hidden).toBe(true);
        expect(status.hidden).toBe(true);
        expect(controller.onReveal).not.toHaveBeenCalled();
        expect(await api.revealDeferredCharacterPanel(host, host, mount)).toBe(controller);
        expect(host.hidden).toBe(false);
        expect(status.hidden).toBe(true);
        expect(host.getAttribute('aria-hidden')).toBe('false');
        expect(controller.onReveal).toHaveBeenCalledTimes(1);
    });

    test('hiding World Info does not ensure a host or preload its styles', () => {
        document.body.innerHTML = '<section id="sb_character_world_info_panel"></section><div id="WorldInfo"></div>';
        const ensure = jest.fn();
        const hide = jest.fn();
        const setVisible = runInNewContext(`let characterPanelRevealPromise; let worldInfoEditorMountPromise;
            ${section(tabs, 'function setCharacterWorldInfoPanelVisible(', 'function setCharacterPanelMenuType(')}
            setCharacterWorldInfoPanelVisible;
        `, { document, ensureCharacterWorldInfoPanel: ensure, hideDeferredCharacterPanel: hide });
        setVisible(false);
        expect(ensure).not.toHaveBeenCalled();
        expect(hide).toHaveBeenCalledTimes(1);
    });

    test('an obsolete ready promise cannot dismiss the newer navigation loading surface', async () => {
        const host = document.createElement('section');
        document.body.append(host);
        const firstReady = deferred();
        const nextReady = deferred();
        const api = runInNewContext(`const deferredCharacterPanels = new WeakMap();
            ${section(tabs, 'function hideDeferredCharacterPanel(', 'async function mountCharacterListController(')}
            ({ revealDeferredCharacterPanel, hideDeferredCharacterPanel });
        `, { document, HTMLElement, createStatusPage, t: strings => strings.join(''), console });
        const first = api.revealDeferredCharacterPanel(host, host, () => ({ ready: firstReady.promise }));
        api.hideDeferredCharacterPanel(host);
        const nextController = { ready: nextReady.promise };
        const next = api.revealDeferredCharacterPanel(host, host, () => nextController);
        firstReady.resolve();
        expect(await first).toBe(false);
        expect(host.hidden).toBe(true);
        expect(host.nextElementSibling.hidden).toBe(false);
        nextReady.resolve();
        expect(await next).toBe(nextController);
        expect(host.hidden).toBe(false);
        expect(host.nextElementSibling.hidden).toBe(true);
    });

    test('closing the page retains ready WI layout but cancels stale reveals and keeps the adapter inactive', async () => {
        document.body.innerHTML = '<div id="right-nav-panel" class="sb-settings-mounted-shell sb-settings-active-root openDrawer" data-menu-type="world-info"><section id="sb_character_world_info_panel"><div id="WorldInfo"></div></section></div>';
        const root = document.getElementById('right-nav-panel');
        const host = document.getElementById('sb_character_world_info_panel');
        const content = document.getElementById('WorldInfo');
        const api = runInNewContext(`const deferredCharacterPanels = new WeakMap();
            ${section(tabs, 'function hideDeferredCharacterPanel(', 'async function mountCharacterListController(')}
            ${section(tabs, 'function deactivateSettingsPageRoot(', 'function setSettingsMobileContentView(')}
            const setCharacterWorldInfoPanelVisible = (visible, options) => hideDeferredCharacterPanel(host, content, options);
            ({ revealDeferredCharacterPanel, deactivateSettingsPageRoot });
        `, {
            document, HTMLElement, host, content, createStatusPage, t: strings => strings.join(''), console,
            getSettingsPageRoot: () => root,
            setCharacterPersonaPanelVisible: jest.fn(), setCharacterImportPanelVisible: jest.fn(),
            setRootClassState: (node, states) => { for (const [key, value] of Object.entries(states)) node.classList.toggle(key, value); },
            setRootAttribute: (node, name, value) => node.setAttribute(name, value),
        });
        const controller = { ready: Promise.resolve() };
        await api.revealDeferredCharacterPanel(host, content, () => controller);
        api.deactivateSettingsPageRoot('characters');
        expect(host.hidden).toBe(false);
        expect(host.getAttribute('aria-hidden')).toBe('true');
        expect(content.getAttribute('aria-hidden')).toBe('true');
        expect(root.getAttribute('aria-hidden')).toBe('true');
        expect(root.classList.contains('sb-settings-active-root')).toBe(false);
        const pending = deferred();
        const reopening = api.revealDeferredCharacterPanel(host, content, () => ({ ready: pending.promise }));
        api.deactivateSettingsPageRoot('characters');
        pending.resolve();
        expect(await reopening).toBe(false);
        expect(host.hidden).toBe(true);
        expect(host.nextElementSibling.hidden).toBe(true);
    });

    test('hidden Related rows mark dirty without reconciling; the next reveal consumes the dirty state', () => {
        document.body.innerHTML = '<section id="sb_character_related"><div id="sb_character_related_rows"></div></section>';
        let visible = false;
        const reconcileRows = jest.fn();
        const api = runInNewContext(`let relatedLinksDirty = false;
            ${section(read('scripts/sillybunny-character-editor.js'), 'function _renderRelatedLinks(', 'function _bindExportMenu(')}
            ({ render: _renderRelatedLinks, dirty: () => relatedLinksDirty });
        `, { document, _isEditorVisible: () => visible, session: { isOpen: () => false }, relatedRows: new Map(), reconcileRows });
        api.render();
        expect(api.dirty()).toBe(true);
        expect(reconcileRows).not.toHaveBeenCalled();
        visible = true;
        api.render();
        expect(api.dirty()).toBe(false);
        expect(reconcileRows).toHaveBeenCalledTimes(1);
    });

    test.each(['hidden', 'class="sb-subpage-store"'])('hidden agent lists (%s) never measure scroll ancestors or touch mode-card state', attribute => {
        document.body.innerHTML = `<div ${attribute}><div id="agent-list"></div></div>`;
        const element = document.getElementById('agent-list');
        const computed = jest.fn();
        const source = read('scripts/extensions/in-chat-agents/index.js');
        const getScroll = runInNewContext(`
            ${section(source, 'function isAgentPanelVisible(', 'function renderAgentList(')}
            ${section(source, 'function getScrollContainer(', 'function captureAgentListScrollState(')}
            getScrollContainer;
        `, { document, HTMLElement, window: { getComputedStyle: computed } });
        expect(getScroll(element)).toBeNull();
        expect(computed).not.toHaveBeenCalled();
        const find = jest.fn();
        const pathfinder = read('scripts/extensions/in-chat-agents/pathfinder-settings-ui.js');
        const update = runInNewContext(`
            ${section(pathfinder, 'function isSettingsUiVisible(', 'function safeGetAccountStorageItem(')}
            ${section(pathfinder, 'function updateModeCardStates(', '/**\n * Show/hide warning when both modes are enabled')}
            updateModeCardStates;
        `, { settingsEl: { 0: element, find }, currentAgent: { settings: {} } });
        update();
        expect(find).not.toHaveBeenCalled();
    });
});
