/* global globalThis */
import { describe, expect, jest, test } from '@jest/globals';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

import {
    createMobileDocumentPanTouchStart,
    MOBILE_FIXED_CHROME_PAN_SURFACES_SELECTOR,
    shouldBlockMobileDocumentPan,
} from '../../public/scripts/mobile-shell-lifecycle/index.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const publicRoot = path.join(repoRoot, 'public');

function readPublic(...segments) {
    return readFileSync(path.join(publicRoot, ...segments), 'utf8');
}

function collectStaticModules(entrypoints) {
    const visited = new Set();
    const visit = (file) => {
        if (visited.has(file) || !existsSync(file)) {
            return;
        }
        visited.add(file);
        const source = readFileSync(file, 'utf8');
        const imports = source.matchAll(/(?:^|\n)\s*(?:import|export)\s+(?:[^;'"()]*?\s+from\s*)?['"]([^'"]+)['"]/g);
        for (const [, specifier] of imports) {
            if (specifier.startsWith('.')) {
                visit(path.resolve(path.dirname(file), specifier));
            }
        }
    };

    for (const entrypoint of entrypoints) {
        visit(path.join(publicRoot, entrypoint));
    }
    return visited;
}

function extractTailFromMarker(source, marker) {
    const start = source.indexOf(marker);
    expect(start).toBeGreaterThanOrEqual(0);
    return source.slice(start);
}

describe('PR 7 compositor scroll, deferred CSS priority, and lazy conversation boot', () => {
    describe('addLongPressEvent shared passive delegation (utils.js)', () => {
        test('registers one shared passive listener set and preserves long-press + click suppression', () => {
            jest.useFakeTimers();
            try {
                const utilsSource = readPublic('scripts', 'utils.js');
                const snippet = extractTailFromMarker(utilsSource, 'const longPressRegistrations = [];')
                    .replace('export function addLongPressEvent', 'function addLongPressEvent');

                const listeners = [];
                const docStub = {
                    addEventListener(type, handler, options) {
                        listeners.push({ type, handler, options });
                    },
                };

                const context = vm.createContext({
                    document: docStub,
                    setTimeout,
                    clearTimeout,
                });
                const addLongPressEvent = vm.runInContext(`${snippet}\naddLongPressEvent;`, context);

                const loreCallback = jest.fn();
                const worldCallback = jest.fn();
                addLongPressEvent('#persona_lore_button', loreCallback, 500);
                addLongPressEvent('#world_button', worldCallback, 400);
                addLongPressEvent('.swipes-counter', jest.fn(), 500);

                // Single shared listener set despite 3 registrations.
                expect(listeners).toHaveLength(5);
                for (const touchType of ['touchstart', 'touchend', 'touchmove', 'touchcancel']) {
                    const entry = listeners.find(item => item.type === touchType);
                    expect(entry).toBeDefined();
                    expect(entry.options).toEqual({ passive: true });
                }

                const touchStartHandler = listeners.find(item => item.type === 'touchstart').handler;
                const touchMoveHandler = listeners.find(item => item.type === 'touchmove').handler;
                const clickHandler = listeners.find(item => item.type === 'click').handler;

                const buttonEl = {
                    id: 'persona_lore_button',
                    closest: selector => (selector === '#persona_lore_button' ? buttonEl : null),
                    contains: node => node === buttonEl,
                };
                const preventDefaultTouch = jest.fn();
                const startEvent = { target: buttonEl, preventDefault: preventDefaultTouch };

                // Cancelled by touchmove before delay -> callback never fires.
                touchStartHandler(startEvent);
                jest.advanceTimersByTime(250);
                touchMoveHandler();
                jest.advanceTimersByTime(500);
                expect(loreCallback).not.toHaveBeenCalled();

                // Held for full 500ms -> callback fires with `this === buttonEl` and zero touchstart preventDefault.
                touchStartHandler(startEvent);
                jest.advanceTimersByTime(500);
                expect(loreCallback).toHaveBeenCalledTimes(1);
                expect(loreCallback.mock.instances[0]).toBe(buttonEl);
                expect(preventDefaultTouch).not.toHaveBeenCalled();
                expect(worldCallback).not.toHaveBeenCalled();

                // Immediate follow-up click on the held target is suppressed once.
                const clickEvent = {
                    target: buttonEl,
                    preventDefault: jest.fn(),
                    stopImmediatePropagation: jest.fn(),
                };
                clickHandler(clickEvent);
                expect(clickEvent.preventDefault).toHaveBeenCalledTimes(1);
                expect(clickEvent.stopImmediatePropagation).toHaveBeenCalledTimes(1);

                const secondClickEvent = {
                    target: buttonEl,
                    preventDefault: jest.fn(),
                    stopImmediatePropagation: jest.fn(),
                };
                clickHandler(secondClickEvent);
                expect(secondClickEvent.preventDefault).not.toHaveBeenCalled();
            } finally {
                jest.useRealTimers();
            }
        });
    });

    describe('mobile pan guard and modern iOS WebKit position:fixed guard', () => {
        test('precomputes scroll ancestry on touchstart with zero getComputedStyle calls during 120Hz touchmove', () => {
            const previousElement = globalThis.Element;
            const previousWindow = globalThis.window;
            const previousDocument = globalThis.document;

            class FakeElement {
                constructor({ matches = () => false, parentElement = null, scrollWidth = 0, clientWidth = 0, scrollLeft = 0 } = {}) {
                    this.matches = matches;
                    this.parentElement = parentElement;
                    this.scrollWidth = scrollWidth;
                    this.clientWidth = clientWidth;
                    this.scrollHeight = 44;
                    this.clientHeight = 44;
                    this.scrollLeft = scrollLeft;
                    this.scrollTop = 0;
                }

                closest(selector) {
                    let current = this;
                    while (current) {
                        if (current.matches(selector)) {
                            return current;
                        }
                        current = current.parentElement;
                    }
                    return null;
                }
            }

            const getComputedStyleSpy = jest.fn(() => ({ overflowX: 'auto', overflowY: 'hidden' }));

            try {
                globalThis.Element = FakeElement;
                globalThis.window = { getComputedStyle: getComputedStyleSpy };
                globalThis.document = { scrollingElement: null };

                const topBar = new FakeElement({
                    matches: selector => selector.includes('#top-bar'),
                });
                const rail = new FakeElement({
                    parentElement: topBar,
                    matches: selector => selector.includes('.sb-topbar-group-left'),
                    scrollWidth: 600,
                    clientWidth: 240,
                    scrollLeft: 120,
                });
                const button = new FakeElement({
                    parentElement: rail,
                    matches: selector => selector.includes('button'),
                });

                const touchStart = createMobileDocumentPanTouchStart({
                    target: button,
                    touches: [{ identifier: 7, clientX: 200, clientY: 20 }],
                });
                const touchStartStyleCalls = getComputedStyleSpy.mock.calls.length;
                expect(touchStartStyleCalls).toBeGreaterThan(0);

                getComputedStyleSpy.mockClear();
                for (let step = 1; step <= 24; step++) {
                    const blocked = shouldBlockMobileDocumentPan({
                        target: button,
                        cancelable: true,
                        touches: [{ identifier: 7, clientX: 200 - step * 4, clientY: 21 }],
                    }, { touchStart });
                    expect(blocked).toBe(false);
                }
                expect(getComputedStyleSpy).not.toHaveBeenCalled();
            } finally {
                globalThis.Element = previousElement;
                globalThis.window = previousWindow;
                globalThis.document = previousDocument;
            }
        });

        test('scopes touchmove { passive: false } to fixed chrome surfaces, gates zoom block to Firefox, and skips modern iOS position:fixed while editing', () => {
            const browserFixesSource = readPublic('scripts', 'browser-fixes.js');

            expect(MOBILE_FIXED_CHROME_PAN_SURFACES_SELECTOR).toContain('#top-bar');
            expect(MOBILE_FIXED_CHROME_PAN_SURFACES_SELECTOR).toContain('#form_sheld');
            expect(MOBILE_FIXED_CHROME_PAN_SURFACES_SELECTOR).not.toContain('#chat');

            expect(browserFixesSource).toMatch(/if\s*\(isFirefox\(\)\)\s*\{\s*document\.addEventListener\('touchstart',\s*blockMultiTouchZoom,\s*\{\s*passive:\s*false\s*\}\);\s*document\.addEventListener\('touchmove',\s*blockMultiTouchZoom,\s*\{\s*passive:\s*false\s*\}\);\s*\}/);
            expect(browserFixesSource).not.toContain('document.addEventListener(\'touchmove\', blockDocumentPanFromShellGaps');
            expect(browserFixesSource).toContain('if (isModernIOSWebKit && isEditableFocusTarget(document.activeElement)) {');
        });
    });

    describe('focus-scoped number input wheel handler (dom-handlers.js)', () => {
        test('does not attach wheel to document and dynamically binds/unbinds on focusin/focusout', async () => {
            const domHandlersSource = readPublic('scripts', 'dom-handlers.js');
            expect(domHandlersSource).not.toContain('document.addEventListener(\'wheel\'');

            class FakeInput {
                constructor({ type = 'number', step = '1', value = '5', min = '0', max = '10' } = {}) {
                    this.type = type;
                    this.step = step;
                    this.value = value;
                    this.min = min;
                    this.max = max;
                    this.parentElement = null;
                    this.listeners = new Map();
                    this.dispatched = [];
                }

                matches(selector) {
                    return selector === 'input[type="number"][step]' && this.type === 'number' && Boolean(this.step);
                }

                closest() {
                    return this.parentElement;
                }

                addEventListener(type, handler, options) {
                    this.listeners.set(type, { handler, options });
                }

                removeEventListener(type, handler) {
                    if (this.listeners.get(type)?.handler === handler) {
                        this.listeners.delete(type);
                    }
                }

                dispatchEvent(event) {
                    this.dispatched.push(event);
                }
            }

            const docListeners = new Map();
            const activeRef = { current: null };
            const docStub = {
                get activeElement() {
                    return activeRef.current;
                },
                addEventListener(type, handler) {
                    docListeners.set(type, handler);
                },
            };

            const module = new vm.SourceTextModule(domHandlersSource, {
                context: vm.createContext({
                    document: docStub,
                    HTMLInputElement: FakeInput,
                    Event: class FakeEvent {
                        constructor(type, init) {
                            this.type = type;
                            this.bubbles = Boolean(init?.bubbles);
                        }
                    },
                }),
            });
            const utilsStub = new vm.SyntheticModule(['throttle'], function () {
                this.setExport('throttle', fn => fn);
            }, { context: module.context });

            await module.link(specifier => {
                if (specifier === './utils.js') return utilsStub;
                throw new Error(`Unexpected import: ${specifier}`);
            });
            await module.evaluate();
            module.namespace.initDomHandlers();

            expect([...docListeners.keys()]).toEqual(['focusin', 'focusout']);

            const slider = new FakeInput({ type: 'range', step: '1', value: '5' });
            const numberInput = new FakeInput({ type: 'number', step: '1', value: '5', min: '0', max: '10' });
            numberInput.parentElement = {
                querySelector: selector => (selector === 'input[type="range"]' ? slider : null),
            };

            activeRef.current = numberInput;
            docListeners.get('focusin')({ target: numberInput });
            expect(numberInput.listeners.get('wheel')?.options).toEqual({ passive: false });
            expect(slider.listeners.get('wheel')?.options).toEqual({ passive: false });

            const wheelEvent = {
                target: numberInput,
                deltaY: -100,
                preventDefault: jest.fn(),
                stopPropagation: jest.fn(),
            };
            numberInput.listeners.get('wheel').handler(wheelEvent);
            expect(wheelEvent.preventDefault).toHaveBeenCalledTimes(1);
            expect(numberInput.value).toBe('6');
            expect(slider.value).toBe('6');
            expect(numberInput.dispatched).toHaveLength(1);

            activeRef.current = null;
            docListeners.get('focusout')({ target: numberInput });
            expect(numberInput.listeners.has('wheel')).toBe(false);
            expect(slider.listeners.has('wheel')).toBe(false);
        });
    });

    describe('passive touch/scroll listeners and delegated color picker', () => {
        test('marks touch, scroll, and visualViewport listeners passive in owned UI modules', () => {
            const bulkEditSource = readPublic('scripts', 'BulkEditOverlay.js');
            const actionMenuSource = readPublic('scripts', 'sillybunny-action-menu.js');
            const dialogSource = readPublic('scripts', 'sillybunny-editor', 'dialog.js');
            const greetingArtSource = readPublic('scripts', 'sillybunny-home', 'greeting-art-opening.js');

            expect(bulkEditSource).toContain('element.addEventListener(\'touchstart\', this.handleHold, { passive: true })');
            expect(bulkEditSource).toContain('element.addEventListener(\'touchend\', this.handleLongPressEnd, { passive: true })');
            expect(bulkEditSource).toContain('element.addEventListener(\'touchmove\', this.handleLongPressEnd, { passive: true })');
            expect(bulkEditSource).toContain('this.container.addEventListener(\'touchend\', cancelHold, { passive: true })');
            expect(actionMenuSource).toContain('visual.addEventListener(\'scroll\', schedule, { passive: true })');
            expect(dialogSource).toContain('viewport?.addEventListener(\'scroll\', schedule, { passive: true })');
            expect(greetingArtSource).toContain('chatElement.addEventListener(\'scroll\', onScroll, { passive: true })');
        });

        test('replaces color-picker body MutationObserver with delegated capture hook and passive listeners', () => {
            const colorPickerSource = readPublic('scripts', 'sillybunny-color-picker.js');

            expect(colorPickerSource).not.toContain('MutationObserver');
            expect(colorPickerSource).not.toContain('enhanceWithin(document.body)');
            expect(colorPickerSource).toContain('target.closest(PICKER_SELECTOR)');
            expect(colorPickerSource).toContain('document.addEventListener(\'click\', handleDelegatedPickerActivation, true)');
            expect(colorPickerSource).toContain('document.addEventListener(\'keydown\', handleDelegatedPickerActivation, true)');
            expect(colorPickerSource).toContain('css/sillybunny-color-picker.css?v=');
        });
    });

    describe('index.html deferred CSS priority, font-display:swap, prefetch, and --doc-height coalescing', () => {
        const indexHtml = readPublic('index.html');

        test('gates sillybunny-mobile-navigation.css to mobile width and eliminates preload-as-style socket starvation', () => {
            expect(indexHtml).toMatch(/<link\b[^>]*href="css\/sillybunny-mobile-navigation\.css\?v=[^"]+"[^>]*media="\(max-width: 768px\)"/);
            expect(indexHtml).not.toMatch(/<link\b[^>]*rel="preload"[^>]*data-sb-deferred-style/);

            for (const panelSheet of [
                'css/sillybunny-entity-list.css',
                'css/sillybunny-character-list.css',
                'css/sillybunny-character-editor.css',
                'css/sillybunny-color-picker.css',
            ]) {
                expect(indexHtml).toEqual(expect.stringContaining(`data-sb-panel-style data-sb-href="${panelSheet}`));
            }
            expect(indexHtml).toContain('data-sb-deferred-style data-sb-href="css/brands.min.css"');
        });

        test('switches solid.min.css from font-display:block to font-display:swap', () => {
            const solidCss = readPublic('css', 'solid.min.css');
            expect(solidCss).toContain('font-display:swap');
            expect(solidCss).not.toContain('font-display:block');
        });

        test('starts guarded early boot prefetches in <head> and coalesces --doc-height resize writes into one rAF', () => {
            expect(indexHtml).toContain('window.__sbBootPrefetch = {');
            expect(indexHtml).toContain('csrf: fetch(\'/csrf-token\').catch(() => null)');
            expect(indexHtml).toContain('version: fetch(\'/version\').catch(() => null)');
            expect(indexHtml).toContain('lang: fetch(\'/locales/lang.json\').catch(() => null)');
            expect(indexHtml).toContain('extensionsDiscover: fetch(\'/api/extensions/discover?manifests=1\').catch(() => null)');

            const docHeightScript = indexHtml.match(/<script>\s*\(\(\) => \{\s*let frameId = 0;[\s\S]*?<\/script>/)?.[0] ?? '';
            expect(docHeightScript).not.toBe('');
            const body = docHeightScript.replace(/^<script>/, '').replace(/<\/script>$/, '');

            const queuedFrames = [];
            const setProperty = jest.fn();
            const resizeListeners = [];
            const winStub = {
                innerHeight: 812,
                requestAnimationFrame: cb => {
                    queuedFrames.push(cb);
                    return queuedFrames.length;
                },
                addEventListener: (type, cb) => {
                    if (type === 'resize') resizeListeners.push(cb);
                },
            };
            vm.runInNewContext(body, {
                window: winStub,
                document: {
                    readyState: 'complete',
                    documentElement: { style: { setProperty } },
                },
            });

            expect(setProperty).toHaveBeenCalledTimes(1);
            expect(setProperty).toHaveBeenLastCalledWith('--doc-height', '812px');

            // Multiple resize events in one frame coalesce into a single rAF callback.
            winStub.innerHeight = 900;
            resizeListeners[0]();
            resizeListeners[0]();
            resizeListeners[0]();
            expect(queuedFrames).toHaveLength(1);
            queuedFrames.shift()();
            expect(setProperty).toHaveBeenCalledTimes(2);
            expect(setProperty).toHaveBeenLastCalledWith('--doc-height', '900px');

            // Unchanged height skips DOM style mutation.
            resizeListeners[0]();
            expect(queuedFrames).toHaveLength(1);
            queuedFrames.shift()();
            expect(setProperty).toHaveBeenCalledTimes(2);
        });

        test('performance-loader defers font/brands activation strictly until after sb-app-ready and skips panel sheets', async () => {
            const loaderSource = readPublic('scripts', 'performance-loader.js');
            let markObserverCallback = null;
            const idleCallbacks = [];
            const fontLink = {
                dataset: {},
                rel: '',
                media: '',
                attributes: new Map([['data-sb-href', 'webfonts/NotoSans/stylesheet.css'], ['data-sb-media', 'all']]),
                getAttribute(name) {
                    return this.attributes.get(name) ?? null;
                },
                setAttribute(name, value) {
                    this.attributes.set(name, value);
                },
                addEventListener: jest.fn(),
            };

            const docStub = {
                querySelectorAll: selector => {
                    expect(selector).toBe('link[data-sb-deferred-style]:not([data-sb-panel-style])');
                    return [fontLink];
                },
            };
            const winStub = {
                requestIdleCallback: jest.fn(cb => idleCallbacks.push(cb)),
            };
            class FakePerformanceObserver {
                static supportedEntryTypes = ['mark'];
                constructor(cb) {
                    markObserverCallback = cb;
                }
                observe() {}
                disconnect() {}
            }

            const context = vm.createContext({
                document: docStub,
                window: winStub,
                performance: { getEntriesByName: () => [] },
                PerformanceObserver: FakePerformanceObserver,
            });
            context.globalThis = context;

            const module = new vm.SourceTextModule(loaderSource, { context });
            await module.link(() => {
                throw new Error('performance-loader.js must remain free of static imports');
            });
            await module.evaluate();

            // Zero idle activations scheduled mid-boot before sb-app-ready.
            expect(winStub.requestIdleCallback).not.toHaveBeenCalled();
            expect(fontLink.rel).toBe('');

            // Deliver sb-app-ready mark twice -> schedules idle work only once.
            markObserverCallback({ getEntries: () => [{ name: 'sb-boot-dismiss' }] });
            expect(winStub.requestIdleCallback).not.toHaveBeenCalled();

            markObserverCallback({ getEntries: () => [{ name: 'sb-app-ready' }] });
            markObserverCallback({ getEntries: () => [{ name: 'sb-app-ready' }] });
            expect(winStub.requestIdleCallback).toHaveBeenCalledTimes(1);

            idleCallbacks[0]();
            expect(fontLink.getAttribute('href')).toBe('webfonts/NotoSans/stylesheet.css');
            expect(fontLink.rel).toBe('stylesheet');
            expect(fontLink.media).toBe('all');
        });
    });

    describe('lazy sillybunny-conversation-boot.js shim', () => {
        test('keeps sillybunny-conversation.js and its module tree out of eager startup imports', () => {
            const html = readPublic('index.html');
            expect(html).toContain('<script type="module" src="scripts/sillybunny-conversation-boot.js"></script>');
            expect(html).not.toContain('href="scripts/sillybunny-conversation.js"');
            expect(html).not.toContain('src="scripts/sillybunny-conversation.js"');

            const entrypoints = [
                ...Array.from(html.matchAll(/<script\b[^>]*\bsrc="([^"?]+)(?:\?[^" ]*)?"[^>]*>/g), match => match[1]),
                ...Array.from(html.matchAll(/<link\b[^>]*\brel="modulepreload"[^>]*\bhref="([^"?]+)(?:\?[^" ]*)?"[^>]*>/g), match => match[1]),
            ];
            const eager = collectStaticModules(entrypoints);

            expect(eager.has(path.join(publicRoot, 'scripts', 'sillybunny-conversation-boot.js'))).toBe(true);
            expect(eager.has(path.join(publicRoot, 'scripts', 'sillybunny-conversation.js'))).toBe(false);
            expect(eager.has(path.join(publicRoot, 'scripts', 'sillybunny-conversation', 'init.js'))).toBe(false);
            expect(eager.has(path.join(publicRoot, 'scripts', 'sillybunny-conversation', 'chrome.js'))).toBe(false);
        });

        test('detects stored or active Conversation Mode state without loading the full module graph', async () => {
            const bootSource = readPublic('scripts', 'sillybunny-conversation-boot.js');
            const dynamicImports = [];
            const context = vm.createContext({
                window: { addEventListener: jest.fn(), dispatchEvent: jest.fn() },
                CustomEvent: class FakeCustomEvent {
                    constructor(type, init) {
                        this.type = type;
                        this.detail = init?.detail ?? null;
                    }
                },
            });
            context.globalThis = context;

            const eventsStub = new vm.SyntheticModule(['event_types', 'eventSource'], function () {
                this.setExport('event_types', { APP_READY: 'app_ready', PERSONA_CHANGED: 'persona_changed' });
                this.setExport('eventSource', { on: jest.fn() });
            }, { context });
            const extensionsStub = new vm.SyntheticModule(['extension_settings'], function () {
                this.setExport('extension_settings', {});
            }, { context });
            const constantsStub = new vm.SyntheticModule(['CONVERSATION_STORE_KEY'], function () {
                this.setExport('CONVERSATION_STORE_KEY', 'sillybunny_conversation');
            }, { context });
            const stateObj = { initialized: false, conversationWorkspaceOpen: false };
            const stateStub = new vm.SyntheticModule(['conversationState'], function () {
                this.setExport('conversationState', stateObj);
            }, { context });

            const conversationStub = new vm.SyntheticModule([], () => {}, { context });
            await conversationStub.link(() => {});
            await conversationStub.evaluate();

            const module = new vm.SourceTextModule(bootSource, {
                context,
                importModuleDynamically: async (specifier) => {
                    dynamicImports.push(specifier);
                    stateObj.initialized = true;
                    return conversationStub;
                },
            });

            await module.link((specifier) => {
                if (specifier === './events.js') return eventsStub;
                if (specifier === './extensions.js') return extensionsStub;
                if (specifier === './sillybunny-conversation/constants.js') return constantsStub;
                if (specifier === './sillybunny-conversation/state.js') return stateStub;
                throw new Error(`Unexpected static import: ${specifier}`);
            });
            await module.evaluate();

            const { hasStoredConversationBootUsage, ensureConversationModuleLoaded } = module.namespace;
            const emptyStorage = { length: 0, key: () => null };

            expect(hasStoredConversationBootUsage({
                extensionSettings: {},
                storage: emptyStorage,
                documentRef: { getElementById: () => null },
            })).toBe(false);

            expect(hasStoredConversationBootUsage({
                extensionSettings: {
                    sillybunny_conversation: {
                        localStorageMigrated: true,
                        groups: [],
                        reminders: [],
                        characters: {
                            'alice.png': { settings: { enabled: false }, branches: { main: { messages: [], unread: 0 } } },
                        },
                    },
                },
                storage: { length: 1, key: () => 'sb_conv_settings_old' },
                documentRef: { getElementById: () => null },
            })).toBe(false);

            expect(hasStoredConversationBootUsage({
                extensionSettings: {
                    sillybunny_conversation: {
                        localStorageMigrated: true,
                        characters: {
                            'alice.png': { settings: { enabled: true }, branches: {} },
                        },
                    },
                },
                storage: emptyStorage,
                documentRef: { getElementById: () => null },
            })).toBe(true);

            expect(hasStoredConversationBootUsage({
                extensionSettings: {},
                storage: { length: 1, key: () => 'sb_conv_unread_alice.png' },
                documentRef: { getElementById: () => null },
            })).toBe(true);

            expect(dynamicImports).toEqual([]);
            await ensureConversationModuleLoaded();
            await ensureConversationModuleLoaded();
            expect(dynamicImports).toEqual(['./sillybunny-conversation.js']);
        });
    });
});
