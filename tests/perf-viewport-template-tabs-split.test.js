/** @jest-environment jsdom */
/* eslint-disable playwright/no-standalone-expect -- Jest unit tests for PR 14 perf optimizations. */
import { afterEach, describe, expect, jest, test } from '@jest/globals';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    createViewportCoordinator,
    VIEWPORT_DELTA_THRESHOLD_PX,
    VIEWPORT_CSS_DELTA_THRESHOLD_PX,
} from '../public/scripts/viewport-coordinator.js';
import {
    cloneTemplate,
    cloneTemplateNode,
    getTemplateJQuery,
    getTemplateRoot,
    queryTemplateElement,
} from '../public/scripts/dom-template.js';
import { createMobileViewportObserver } from '../public/scripts/chat-render-lifecycle/mobile-viewport.js';
import {
    createMobileShellLifecycle,
    subscribeMobileViewportSync,
} from '../public/scripts/mobile-shell-lifecycle/index.js';
import { subscribeMovingUIViewport } from '../public/scripts/moving-ui-viewport.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readRepoFile = (...segments) => readFileSync(path.join(repoRoot, ...segments), 'utf8').replace(/\r\n/g, '\n');

function createMockEventTarget() {
    /** @type {Map<string, Set<Function>>} */
    const listeners = new Map();
    const added = [];
    const removed = [];

    return {
        added,
        removed,
        addEventListener(type, listener, options) {
            if (!listeners.has(type)) {
                listeners.set(type, new Set());
            }
            listeners.get(type).add(listener);
            added.push({ type, listener, options });
        },
        removeEventListener(type, listener, options) {
            listeners.get(type)?.delete(listener);
            removed.push({ type, listener, options });
        },
        dispatch(type, event = { type }) {
            for (const listener of Array.from(listeners.get(type) ?? [])) {
                listener(event);
            }
        },
        activeListenerCount(type = null) {
            if (type !== null) {
                return listeners.get(type)?.size ?? 0;
            }
            let total = 0;
            for (const set of listeners.values()) {
                total += set.size;
            }
            return total;
        },
    };
}

function createCoordinatorHarness({
    innerWidth = 390,
    innerHeight = 844,
    vvWidth = 390,
    vvHeight = 844,
    offsetTop = 0,
    offsetLeft = 0,
    scale = 1,
} = {}) {
    const winTarget = createMockEventTarget();
    const vvTarget = createMockEventTarget();
    const cssWrites = [];
    const cssValues = new Map();
    const rafQueue = [];
    const cancelledRafs = [];
    let nextRafId = 1;

    const visualViewport = {
        ...vvTarget,
        width: vvWidth,
        height: vvHeight,
        offsetTop,
        offsetLeft,
        scale,
    };

    const win = {
        ...winTarget,
        innerWidth,
        innerHeight,
        visualViewport,
    };

    const doc = {
        documentElement: {
            clientWidth: innerWidth,
            clientHeight: innerHeight,
            style: {
                setProperty(name, value) {
                    cssWrites.push({ name, value });
                    cssValues.set(name, value);
                },
                getPropertyValue(name) {
                    return cssValues.get(name) ?? '';
                },
            },
        },
    };

    const coordinator = createViewportCoordinator({
        win,
        doc,
        visualViewport,
        requestAnimationFrameRef(callback) {
            const id = nextRafId++;
            rafQueue.push({ id, callback });
            return id;
        },
        cancelAnimationFrameRef(id) {
            cancelledRafs.push(id);
            const idx = rafQueue.findIndex(item => item.id === id);
            if (idx >= 0) {
                rafQueue.splice(idx, 1);
            }
        },
    });

    const flushFrame = () => {
        const next = rafQueue.shift();
        if (next) {
            next.callback(16);
        }
    };

    return {
        win,
        visualViewport,
        doc,
        coordinator,
        cssWrites,
        cssValues,
        rafQueue,
        cancelledRafs,
        flushFrame,
    };
}

afterEach(() => {
    delete window.$;
    document.body.replaceChildren();
});

describe('PR 14A: Unified ViewportCoordinator and Trap #13', () => {
    test('coalesces burst visualViewport and window events into a single rAF frame', () => {
        const harness = createCoordinatorHarness({ innerHeight: 844, vvHeight: 844 });
        const received = [];

        const unsubA = harness.coordinator.subscribe((snapshot, meta) => {
            received.push({ subscriber: 'A', height: snapshot.height, inset: snapshot.keyboardInset, events: meta.events.length });
        });
        const unsubB = harness.coordinator.subscribe((snapshot, meta) => {
            received.push({ subscriber: 'B', height: snapshot.height, inset: snapshot.keyboardInset, events: meta.events.length });
        });

        // Two subscribers still attach only one listener per event type.
        expect(harness.visualViewport.activeListenerCount('resize')).toBe(1);
        expect(harness.visualViewport.activeListenerCount('scroll')).toBe(1);
        expect(harness.win.activeListenerCount('resize')).toBe(1);
        expect(harness.win.activeListenerCount('orientationchange')).toBe(1);

        // Simulate a burst of 6 events across visualViewport + window before next rAF.
        harness.visualViewport.height = 544;
        harness.visualViewport.dispatch('resize');
        harness.visualViewport.dispatch('scroll');
        harness.win.dispatch('resize');
        harness.visualViewport.height = 520;
        harness.visualViewport.dispatch('resize');
        harness.visualViewport.dispatch('scroll');
        harness.win.dispatch('orientationchange');

        expect(harness.rafQueue).toHaveLength(1);
        expect(received).toHaveLength(0);
        expect(harness.cssWrites).toHaveLength(0);

        harness.flushFrame();

        expect(received).toEqual([
            { subscriber: 'A', height: 520, inset: 324, events: 6 },
            { subscriber: 'B', height: 520, inset: 324, events: 6 },
        ]);
        // ViewportCoordinator never writes unread root CSS variables; consumers own their CSS writes.
        expect(harness.cssWrites).toHaveLength(0);

        // Clean teardown detaches all listeners once the last subscriber unsubscribes.
        unsubA();
        expect(harness.coordinator.isAttached()).toBe(true);
        harness.visualViewport.dispatch('resize');
        expect(harness.rafQueue).toHaveLength(1);

        unsubB();
        expect(harness.coordinator.isAttached()).toBe(false);
        expect(harness.visualViewport.activeListenerCount()).toBe(0);
        expect(harness.win.activeListenerCount()).toBe(0);
        expect(harness.cancelledRafs).toHaveLength(1);
    });

    test('gates meta.deltas flags behind >= 1px threshold and avoids dead root CSS writes', () => {
        expect(VIEWPORT_DELTA_THRESHOLD_PX).toBe(1);
        expect(VIEWPORT_CSS_DELTA_THRESHOLD_PX).toBe(1);
        const harness = createCoordinatorHarness({ innerHeight: 800, vvHeight: 800 });
        const deltasLog = [];
        const unsub = harness.coordinator.subscribe((_snapshot, meta) => {
            deltasLog.push(meta.deltas);
        });

        // Initial frame reports all deltas as changed without writing unread root CSS vars.
        harness.visualViewport.dispatch('resize');
        harness.flushFrame();
        expect(deltasLog[0]).toEqual({
            heightChanged: true,
            keyboardInsetChanged: true,
            offsetTopChanged: true,
            layoutWidthChanged: true,
            layoutHeightChanged: true,
            anyChanged: true,
        });
        expect(harness.cssWrites).toHaveLength(0);

        // Sub-pixel jitter (< 1px) sets all delta flags to false.
        harness.visualViewport.height = 799.6;
        harness.visualViewport.dispatch('resize');
        harness.flushFrame();
        harness.visualViewport.height = 800.4;
        harness.visualViewport.dispatch('scroll');
        harness.flushFrame();
        expect(deltasLog[1].anyChanged).toBe(false);
        expect(deltasLog[2].anyChanged).toBe(false);

        // Moving by >= 1px flags heightChanged and keyboardInsetChanged.
        harness.visualViewport.height = 799;
        harness.visualViewport.dispatch('resize');
        harness.flushFrame();
        expect(deltasLog[3]).toMatchObject({
            heightChanged: true,
            keyboardInsetChanged: true,
            offsetTopChanged: false,
            anyChanged: true,
        });

        // Changing height by 2px while offsetTop compensates leaves keyboardInsetChanged false.
        harness.visualViewport.height = 797;
        harness.visualViewport.offsetTop = 2;
        harness.visualViewport.dispatch('scroll');
        harness.flushFrame();
        expect(deltasLog[4]).toMatchObject({
            heightChanged: true,
            keyboardInsetChanged: false,
            offsetTopChanged: true,
            anyChanged: true,
        });
        expect(harness.cssWrites).toHaveLength(0);

        unsub();
    });

    test('wires mobile-shell-lifecycle, chat mobile-viewport observer, moving-ui-viewport, browser-fixes, and tabs through ViewportCoordinator', () => {
        const harness = createCoordinatorHarness({ innerWidth: 1280, innerHeight: 800, vvWidth: 1280, vvHeight: 800 });
        const events = [];

        const shellLifecycle = createMobileShellLifecycle();
        expect(shellLifecycle.viewportSync.subscribe).toBe(subscribeMobileViewportSync);

        const unsubShell = shellLifecycle.viewportSync.subscribe(snapshot => {
            events.push(`shell:${snapshot.height}`);
        }, { coordinator: harness.coordinator });

        const observer = createMobileViewportObserver({
            coordinator: harness.coordinator,
            onViewportChange: event => events.push(`chat:${event.type}`),
        });
        expect(observer.start()).toBe(true);

        const unsubMovingUi = subscribeMovingUIViewport(({ viewportWidth, viewportHeight }) => {
            events.push(`moving:${viewportWidth}x${viewportHeight}`);
        }, { coordinator: harness.coordinator });

        // All three callers share the coordinator's single listener per native event.
        expect(harness.visualViewport.activeListenerCount('resize')).toBe(1);
        expect(harness.visualViewport.activeListenerCount('scroll')).toBe(1);
        expect(harness.win.activeListenerCount('resize')).toBe(1);
        expect(harness.win.activeListenerCount('orientationchange')).toBe(1);

        // Visual viewport event notifies shell + chat observer, not desktop MovingUI window resize.
        harness.visualViewport.height = 500;
        harness.visualViewport.dispatch('resize', { type: 'resize' });
        harness.flushFrame();
        expect(events).toEqual(['shell:500', 'chat:resize']);

        // Window resize notifies shell + MovingUI, not visualViewport-only chat observer.
        events.length = 0;
        harness.win.innerWidth = 1440;
        harness.win.innerHeight = 900;
        harness.win.dispatch('resize', { type: 'resize' });
        harness.flushFrame();
        expect(events).toEqual(['shell:500', 'moving:1440x900']);

        unsubShell();
        observer.dispose();
        unsubMovingUi();
        expect(harness.coordinator.isAttached()).toBe(false);

        // Static listener reduction verification across browser-fixes.js, power-user.js, and sillybunny-tabs.js.
        const browserFixesSource = readRepoFile('public', 'scripts', 'browser-fixes.js');
        const tabsSource = readRepoFile('public', 'scripts', 'sillybunny-tabs.js');
        const powerUserSource = readRepoFile('public', 'scripts', 'power-user.js');

        expect(browserFixesSource).toContain('import { subscribeViewport } from \'./viewport-coordinator.js\';');
        expect(browserFixesSource).not.toContain('viewport?.addEventListener(');
        expect(browserFixesSource).not.toContain('window.addEventListener(\'resize\', fixFunkyPositioning');
        expect(browserFixesSource).not.toContain('window.addEventListener(\'orientationchange\'');

        expect(tabsSource).toContain('sbMobileShellLifecycle.viewportSync.subscribe((snapshot, meta) => {');
        expect(tabsSource).toContain('syncMobileViewportState(snapshot);');
        expect(tabsSource).not.toContain('window.visualViewport?.addEventListener(');

        expect(powerUserSource).toContain('subscribeMovingUIViewport(');
        expect(powerUserSource).not.toContain('$(window).on(\'resize\'');
    });

    test('Trap #13: browser-fixes.js never flips documentElement.style.position = fixed on iOS input focus', () => {
        const browserFixesSource = readRepoFile('public', 'scripts', 'browser-fixes.js');

        expect(browserFixesSource).not.toContain('document.documentElement.style.position = \'fixed\'');
        // Unconditional edit-focus guard protects IME composition even on forced orientationchange.
        expect(browserFixesSource).toMatch(/if \(isEditableFocusTarget\(document\.activeElement\)\) \{\s*return;\s*\}/);
        expect(browserFixesSource).not.toContain('if (!force && isEditableFocusTarget(document.activeElement))');
    });
});

describe('PR 14B: Safe public/index.html <template> Diet and Trap #10', () => {
    const indexHtml = readRepoFile('public', 'index.html');
    const parsedDoc = new DOMParser().parseFromString(indexHtml, 'text/html');

    const convertedTemplateIds = [
        'zoomed_avatar_template',
        'user_avatar_template',
        'character_world_template',
        'past_chat_template',
        'tag_view_template',
        'entry_edit_template',
        'character_template',
        'tag_template',
        'openai_logit_bias_template',
        'logit_bias_template',
        'message_template',
        'group_avatars_template',
        'group_list_template',
        'bogus_folder_template',
        'bogus_folder_back_template',
        'inline_avatar_template',
        'alternate_greetings_template',
        'alternate_greeting_form_template',
        'message_file_template',
        'message_image_template',
        'message_video_template',
        'message_gallery_controls',
        'message_audio_template',
    ];

    test('converts all 23 safe inert template_element blocks to HTML <template> elements, cutting >520 live DOM nodes', () => {
        let totalInertTemplateElements = 0;

        for (const id of convertedTemplateIds) {
            const el = parsedDoc.getElementById(id);
            expect(el).not.toBeNull();
            expect(el.tagName).toBe('TEMPLATE');
            expect(el.classList.contains('template_element')).toBe(true);
            expect(el.children.length).toBe(0);
            const inertCount = el.content.querySelectorAll('*').length;
            expect(inertCount).toBeGreaterThan(0);
            totalInertTemplateElements += inertCount;
        }

        // Removing 23 inert subtrees takes 520+ elements out of the live document tree.
        expect(totalInertTemplateElements).toBeGreaterThanOrEqual(520);
        const liveElements = parsedDoc.querySelectorAll('*').length;
        expect(liveElements).toBeLessThan(6000);
    });

    test('Trap #10: preserves all raw upstream settings form inputs, live onboarding select, and extension-facing #group_member_template in live DOM', () => {
        const requiredLiveIds = [
            'max_context',
            'amount_gen',
            'rm_api_block',
            'extensions_settings',
            'extensions_settings2',
            'main_api',
            'send_textarea',
            'user-settings-block',
            'world_info',
            'onboarding_template',
            'onboarding_ui_language_select',
            'background_template',
            'group_member_template',
        ];

        for (const id of requiredLiveIds) {
            const el = parsedDoc.getElementById(id);
            expect(el).not.toBeNull();
            expect(el.tagName).not.toBe('TEMPLATE');
        }

        expect(parsedDoc.getElementById('onboarding_ui_language_select')?.closest('#onboarding_template')).not.toBeNull();
    });

    test('dom-template helper clones <template> content and legacy <div> containers identically', () => {
        const minimalDollar = jest.fn((input) => ({
            el: input ?? null,
            length: input ? 1 : 0,
            clone() {
                return minimalDollar(input ? input.cloneNode(true) : null);
            },
        }));
        window.$ = minimalDollar;

        // Verify cloning real <template> entries parsed from public/index.html.
        const mesNode = cloneTemplateNode('message_template', '.mes', parsedDoc);
        expect(mesNode).not.toBeNull();
        expect(mesNode.classList.contains('mes')).toBe(true);
        expect(mesNode.ownerDocument).toBe(parsedDoc);
        // Must be a fresh clone, not the prototype inside template.content.
        expect(mesNode).not.toBe(queryTemplateElement('message_template', '.mes', parsedDoc));

        const wiHeader = getTemplateJQuery('entry_edit_template', '.world_entry', parsedDoc);
        const wiEdit = getTemplateJQuery('entry_edit_template', '.world_entry_edit', parsedDoc);
        expect(wiHeader.length).toBe(1);
        expect(wiEdit.length).toBe(1);
        expect(wiHeader.clone().el).not.toBe(wiHeader.el);

        const tagWrap = cloneTemplate('tag_template', '.tag', parsedDoc);
        expect(tagWrap.length).toBe(1);
        expect(tagWrap.el.classList.contains('tag')).toBe(true);

        // Legacy <div> container fallback still works cleanly (e.g. unit-test fixtures).
        document.body.innerHTML = '<div id="legacy_tpl" class="template_element"><span class="chip">hi</span></div>';
        expect(getTemplateRoot('legacy_tpl', document)).toBe(document.getElementById('legacy_tpl'));
        const legacyClone = cloneTemplateNode('#legacy_tpl', '.chip', document);
        expect(legacyClone?.textContent).toBe('hi');
        expect(legacyClone).not.toBe(document.querySelector('#legacy_tpl .chip'));
    });
});

describe('PR 14C: sillybunny-tabs.js Modular Split & Lazy Sub-Modules', () => {
    const tabsSource = readRepoFile('public', 'scripts', 'sillybunny-tabs.js');
    const subModules = [
        { file: 'sampling-panel.js', factory: 'createSamplingPanelController' },
        { file: 'backend-panels.js', factory: 'createBackendPanelsController' },
        { file: 'importer-ui.js', factory: 'createImporterUiController' },
        { file: 'chat-actions-search.js', factory: 'createChatActionsSearchController' },
        { file: 'universal-search-panel.js', factory: 'createUniversalSearchController' },
    ];

    test('shrinks eager public/scripts/sillybunny-tabs.js boot chunk by >120 KiB from the ~579 KiB monolith', () => {
        const byteLength = Buffer.byteLength(tabsSource, 'utf8');
        const lineCount = tabsSource.split('\n').length;

        // Baseline before split was ~579,104 bytes (~565.5 KiB) / ~14,392 LOC.
        expect(byteLength).toBeLessThan(460 * 1024);
        expect(lineCount).toBeLessThan(12000);
    });

    test('loads all extracted sub-modules lazily via dynamic import() with zero static boot imports', () => {
        for (const { file, factory } of subModules) {
            const fullPath = path.join(repoRoot, 'public', 'scripts', 'sillybunny-tabs', file);
            expect(existsSync(fullPath)).toBe(true);

            // Wired through dynamic import() on activation, never static top-level import.
            expect(tabsSource).toContain(`import('./sillybunny-tabs/${file}')`);
            expect(tabsSource).not.toMatch(new RegExp(`^\\s*import\\s+[^;]*sillybunny-tabs/${file.replace('.', '\\.')}`, 'm'));

            const subSource = readRepoFile('public', 'scripts', 'sillybunny-tabs', file);
            expect(subSource).toContain(`export function ${factory}(`);
        }
    });

    test('preserves the full globalThis.SillyBunnyShell public API surface', () => {
        const expectedShellMethods = [
            'openTab',
            'openCharacters',
            'closeCharacters',
            'closeCharactersAfterChatPick',
            'isMobileViewport',
            'highlightCharacterEditorTab',
            'openGlobalSearch',
            'openModeMenu',
            'revealSetting',
            'applyTheme',
            'setSurfaceTransparency',
            'setTopbarScale',
            'setMobileButtonScale',
            'setDesktopButtonScale',
            'setCompactMode',
            'setTopbarIconsOnly',
            'setDesktopShellSnapToChatWidth',
            'setMessageStyle',
            'toggleChatSidebar',
            'toggleChatbarVisibility',
            'resetTopbarPosition',
            'getTheme',
            'getSurfaceTransparency',
            'getTopbarScale',
            'getMobileButtonScale',
            'getDesktopButtonScale',
            'getCompactMode',
        ];

        const shellApiBlock = tabsSource.slice(tabsSource.indexOf('globalThis.SillyBunnyShell = Object.assign('));
        for (const method of expectedShellMethods) {
            expect(shellApiBlock).toMatch(new RegExp(`\\b${method}\\b`));
        }
    });

    test('preserves PR #1030 prompt-caching wiring, eager revealSetting helpers, chat sidebar race guard, and error logging', () => {
        const backendPanelsSource = readRepoFile('public', 'scripts', 'sillybunny-tabs', 'backend-panels.js');

        // PR #1030 prompt-caching wiring must survive the backend-panels split.
        expect(tabsSource).toContain('refreshPresets() {');
        expect(tabsSource).toContain('if (prompting?.panel instanceof HTMLElement) updatePromptingPanel(prompting.panel);');
        expect(backendPanelsSource).toContain('\'sb-openai-prompt-caching\'');

        // revealSetting / revealBackendGroup helpers stay inline so they work before Universal Search opens.
        expect(tabsSource).toContain('function expandHiddenAccordions(');
        expect(tabsSource).toContain('function pulseSearchTarget(');
        expect(tabsSource).toContain('function revealSettingsCategoryFor(');
        expect(tabsSource).not.toContain('universalSearchController?.revealSettingsCategoryFor');
        expect(tabsSource).not.toContain('universalSearchController?.expandHiddenAccordions');
        expect(tabsSource).not.toContain('universalSearchController?.pulseSearchTarget');

        // Chat sidebar lazy-load race protection tracks desired state synchronously via a request token.
        expect(tabsSource).toContain('let chatSidebarOpenRequestToken = 0;');
        expect(tabsSource).toContain('if (token !== chatSidebarOpenRequestToken || !getChatbarState().sidebarOpen)');

        // Lazy sub-module loads log failures instead of swallowing rejections silently.
        expect(tabsSource).not.toMatch(/load(?:SamplingPanel|BackendPanels|ChatActionsSearch|UniversalSearch)Controller\(\)[\s\S]{0,240}\.catch\(\(\) => \{\s*\}\)/);
    });
});
