/** @jest-environment jsdom */
/* eslint-disable playwright/no-standalone-expect, playwright/prefer-web-first-assertions -- Jest/jsdom checks synchronous DOM state. */
import { afterEach, describe, expect, jest, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { importTabsModule } from '../util/tabs-harness.js';
import { importScriptModule } from '../util/script-harness.js';

const pub = rel => fileURLToPath(new URL(`../../public/${rel}`, import.meta.url));
const css = readFileSync(pub('css/sillybunny-tabs.css'), 'utf8');

const deferred = () => {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
};

let loaded = null;
const extraCleanups = [];

afterEach(() => {
    while (extraCleanups.length) extraCleanups.pop()();
    loaded?.cleanup();
    loaded = null;
    jest.restoreAllMocks();
});

describe('Characters tab shell', () => {
    // Run real script.js and character-editor.js tests before importTabsModule registers sticky mocks for them.
    test.each([
        ['edit', true], ['edit', false], ['create', true],
    ])('%s mode schedules one focus to #right-nav-panel and writes version once (switchMenu=%s)', async (mode, switchMenu) => {
        const frames = [];
        const dom = `
            <form id="send_form"><input id="chat_input"></form>
            <div id="right-nav-panel" class="sb-settings-mounted-shell" tabindex="-1">
                <button id="rm_button_create" type="button"></button>
                <div id="rm_characters_block" class="right_menu"></div>
                <div id="rm_ch_create_block" class="right_menu"></div>
                <input id="character_name_pole">
                <textarea id="description_textarea"></textarea>
                <textarea id="firstmessage_textarea"></textarea>
                <textarea id="character_version_textarea"></textarea>
                <input id="avatar_url_pole">
                <img id="avatar_load_preview">
            </div>
            <div id="chat"></div>
            <textarea id="send_textarea"></textarea>
        `;
        loaded = await importScriptModule({ dom });
        if (mode === 'create') {
            await loaded.runReady();
        }
        const origRaf = window.requestAnimationFrame;
        window.requestAnimationFrame = cb => { frames.push(cb); return frames.length; };
        extraCleanups.push(() => { window.requestAnimationFrame = origRaf; });

        loaded.script.characters.push({ name: 'Name', avatar: 'avatar.png', data: { character_version: 'v2' } });
        const versionEl = /** @type {HTMLTextAreaElement} */ (document.getElementById('character_version_textarea'));
        const valWrites = [];
        const origValDesc = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value');
        Object.defineProperty(versionEl, 'value', {
            configurable: true,
            get() { return origValDesc.get.call(this); },
            set(v) {
                valWrites.push(v);
                origValDesc.set.call(this, v);
            },
        });

        const chatInput = document.getElementById('chat_input');
        chatInput.focus();
        frames.length = 0;

        if (mode === 'edit') {
            loaded.script.select_selected_character(0, { switchMenu });
        } else {
            loaded.$('#rm_button_create').trigger('click');
        }

        expect(document.activeElement).not.toBe(chatInput);
        expect(frames).toHaveLength(1);
        frames[0]();
        expect(document.activeElement).toBe(document.getElementById('right-nav-panel'));
        expect(valWrites).toEqual(mode === 'edit' ? ['v2'] : ['']);
        const expectedMenuType = switchMenu ? (mode === 'edit' ? 'character_edit' : 'create') : '';
        expect(document.getElementById('right-nav-panel').dataset.menuType ?? '').toBe(expectedMenuType);
    });

    test.each([true, false])('right-menu opacity is immediate only when shell hosted (%s)', async hosted => {
        const dom = `<div id="right-nav-panel" class="${hosted ? 'sb-settings-mounted-shell' : ''}"><div id="rm_characters_block" class="right_menu"></div><div id="rm_ch_create_block" class="right_menu"></div></div>`;
        loaded = await importScriptModule({ dom });
        const raf = jest.fn();
        const origRaf = window.requestAnimationFrame;
        window.requestAnimationFrame = raf;
        extraCleanups.push(() => { window.requestAnimationFrame = origRaf; });

        loaded.script.selectRightMenuWithAnimation('rm_characters_block');

        expect(document.getElementById('rm_characters_block').style.opacity).toBe(hosted ? '1' : '0');
        expect(raf).toHaveBeenCalledTimes(hosted ? 0 : 1);
    });

    test('animation cleanup only mutates .sb-settings-page--opening when present and cancels active animations cleanly', async () => {
        loaded = await importTabsModule({
            mocks: {
                'scripts/sillybunny-motion.js': {
                    animateIn: jest.fn(),
                    animateOut: jest.fn((_el, _frames, onFinish) => onFinish?.()),
                    animateHeightFrom: jest.fn(),
                    endTransitionMark: jest.fn(),
                    play: jest.fn(),
                    prefersReducedMotion: jest.fn(() => false),
                    stopMotion: jest.fn(),
                    transitionChange: jest.fn((_el, fn) => fn?.()),
                    MOTION_FAST: 200,
                    MOTION_SLOW: 250,
                    MOTION_POPOVER_CLOSE: 150,
                    MOTION_EASE_OUT_CUBIC: 'linear',
                    SPRING_SHEET: {},
                },
            },
        });

        const page = document.getElementById('sb-settings-page');
        const createdAnimations = [];
        page.animate = jest.fn(() => {
            const anim = { onfinish: null, cancel: jest.fn() };
            createdAnimations.push(anim);
            return anim;
        });

        // Opening adds sb-settings-page--opening and starts an animation.
        loaded.shell.openTab('characters', 'characters');
        expect(page.classList.contains('sb-settings-page--opening')).toBe(true);
        expect(createdAnimations).toHaveLength(1);

        const observer = new MutationObserver(() => {});
        observer.observe(page, { attributes: true, attributeFilter: ['class'] });

        // Closing while opening clears the opening class once and cancels the opening animation.
        loaded.shell.closeCharacters();
        const records = observer.takeRecords();
        expect(records).toHaveLength(1);
        expect(page.classList.contains('sb-settings-page--opening')).toBe(false);
        expect(createdAnimations[0].cancel).toHaveBeenCalledTimes(1);
        expect(createdAnimations[0].onfinish).toBeNull();

        // A second close when already closed makes zero class mutations.
        loaded.shell.closeCharacters();
        expect(observer.takeRecords()).toHaveLength(0);
        observer.disconnect();
    });

    test('Characters active colour/aria is synchronous and drawer observers cannot overwrite it', async () => {
        loaded = await importTabsModule();
        const button = document.getElementById('sb-character-toggle');
        const legacyIcon = document.getElementById('rightNavDrawerIcon');

        loaded.shell.openTab('characters', 'characters');
        expect(button.classList.contains('sb-settings-active')).toBe(true);
        expect(button.getAttribute('aria-expanded')).toBe('true');

        // Upstream drawer icon switching to openIcon must not stamp .is-open onto the settings-hosted toggle.
        legacyIcon.classList.remove('closedIcon');
        legacyIcon.classList.add('openIcon');
        await loaded.flush();
        expect(button.classList.contains('is-open')).toBe(false);

        loaded.shell.closeCharacters();
        await loaded.flush();
        expect(button.classList.contains('sb-settings-active')).toBe(false);
        expect(button.getAttribute('aria-expanded')).toBe('false');
        expect(css).toMatch(/\.sb-proxy-button i\s*\{[^}]*color: inherit;\s*transition: transform/);
        expect(css).toMatch(/\.sb-settings-tab\s*\{[^}]*transition: none;/);
    });

    test.each([
        ['persona', 'scripts/sillybunny-persona-editor.js', 'mountPersonaEditor', 'sb_character_persona_panel'],
        ['world-info', 'scripts/sillybunny-world-info-editor.js', 'mountWorldInfoEditor', 'sb_character_world_info_panel'],
        ['import', 'scripts/sillybunny-character-import.js', 'mountCharacterImport', 'sb_character_import_panel'],
    ])('%s stays on one loading surface through ready and prepare; stale navigation never reveals it', async (tab, modulePath, mountName, panelId) => {
        const ready = deferred();
        const prepared = deferred();
        const controller = { ready: ready.promise, prepareReveal: jest.fn(() => prepared.promise), onReveal: jest.fn() };
        const mountFn = jest.fn(() => controller);

        loaded = await importTabsModule({
            mocks: {
                [modulePath]: {
                    [mountName]: mountFn,
                    loadPersonaEditorStyles: jest.fn(async () => {}),
                    loadCharacterImportStyles: jest.fn(async () => {}),
                    openPersonaEditor: jest.fn(async () => {}),
                },
            },
        });

        const first = loaded.shell.openTab('characters', tab);
        await loaded.flush();
        const host = document.getElementById(panelId);
        expect(host).not.toBeNull();
        const status = host.nextElementSibling;
        expect(host.hidden).toBe(true);
        expect(status).not.toBeNull();
        expect(status.classList.contains('sb-character-panel-loading')).toBe(true);
        expect(status.hidden).toBe(false);

        ready.resolve();
        await loaded.flush();
        expect(controller.prepareReveal).toHaveBeenCalledTimes(1);
        expect(host.hidden).toBe(true);

        // Navigate away before prepareReveal finishes -> cancels stale reveal without calling onReveal.
        loaded.shell.openTab('characters', 'characters');
        prepared.resolve();
        expect(await first).toBe(false);
        expect(host.hidden).toBe(true);
        expect(status.isConnected).toBe(false);
        expect(controller.onReveal).not.toHaveBeenCalled();

        // Next visit reveals cleanly with no lingering status page.
        const second = loaded.shell.openTab('characters', tab);
        expect(await second).toBe(controller);
        expect(host.hidden).toBe(false);
        expect(document.querySelector('.sb-character-panel-loading')).toBeNull();
        expect(host.getAttribute('aria-hidden')).toBe('false');
        expect(controller.onReveal).toHaveBeenCalledTimes(1);
    });

    test('closing Characters retains ready World Info layout while cancelling stale reveals', async () => {
        let nextReady = Promise.resolve();
        const mountWorldInfoEditor = jest.fn(() => ({ ready: nextReady }));
        loaded = await importTabsModule({
            mocks: {
                'scripts/sillybunny-world-info-editor.js': { mountWorldInfoEditor },
            },
        });

        await loaded.shell.openTab('characters', 'world-info');
        const host = document.getElementById('sb_character_world_info_panel');
        const root = document.getElementById('right-nav-panel');
        expect(host.hidden).toBe(false);

        // Closing the settings page keeps the ready WI host unhidden while deactivating the root.
        loaded.shell.closeCharacters();
        expect(host.hidden).toBe(false);
        expect(host.getAttribute('aria-hidden')).toBe('true');
        expect(root.getAttribute('aria-hidden')).toBe('true');
        expect(root.classList.contains('sb-settings-active-root')).toBe(false);

        // Switching to a different tab hides WI cleanly without preloading or creating another host.
        loaded.assets.loadStylesheetAsync.mockClear();
        loaded.shell.openTab('characters', 'characters');
        expect(host.hidden).toBe(true);
        expect(loaded.assets.loadStylesheetAsync).not.toHaveBeenCalled();
    });
});
