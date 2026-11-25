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

describe('PR 5 compositor scroll, deferred CSS priority, and lazy conversation boot', () => {
    describe('addLongPressEvent shared passive delegation (utils.js)', () => {
        test('registers one shared passive listener set and preserves long-press + click suppression (incl. iOS Text nodes)', () => {
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
                const textNodeChild = { nodeType: 3, parentElement: buttonEl };
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

                // iOS WebKit Text-node touchstart target resolves through parentElement.
                touchStartHandler({ target: textNodeChild, preventDefault: jest.fn() });
                jest.advanceTimersByTime(500);
                expect(loreCallback).toHaveBeenCalledTimes(2);
                expect(loreCallback.mock.instances[1]).toBe(buttonEl);
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
            // Even if step was removed while focused, focusout detaches unconditionally.
            numberInput.step = '';
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

        test('replaces color-picker body MutationObserver with delegated capture hook, enhances pre-connected pickers, and re-runs placement after stylesheet load', async () => {
            const colorPickerSource = readPublic('scripts', 'sillybunny-color-picker.js');

            expect(colorPickerSource).not.toContain('MutationObserver');
            expect(colorPickerSource).not.toContain('enhanceWithin(document.body)');
            expect(colorPickerSource).toContain('target.closest(PICKER_SELECTOR)');
            expect(colorPickerSource).toContain('document.addEventListener(\'click\', handleDelegatedPickerActivation, true)');
            expect(colorPickerSource).toContain('document.addEventListener(\'keydown\', handleDelegatedPickerActivation, true)');
            expect(colorPickerSource).toContain('css/sillybunny-color-picker.css?v=');

            class FakeElement {
                constructor(tagName, { id = '', className = '', insideChat = false } = {}) {
                    this.tagName = tagName.toUpperCase();
                    this.id = id;
                    this.className = className;
                    this.insideChat = insideChat;
                    this.isConnected = true;
                    this.attributes = new Map();
                    this.dataset = {};
                    this.style = {
                        setProperty: (k, v) => { this.style[k] = v; },
                    };
                    this.children = [];
                    this.listeners = new Map();
                    this.focused = false;
                }

                getAttribute(name) { return this.attributes.get(name) ?? null; }
                setAttribute(name, value) { this.attributes.set(name, String(value)); }
                removeAttribute(name) { this.attributes.delete(name); }
                matches(selector) {
                    if (selector === 'toolcool-color-picker') return this.tagName === 'TOOLCOOL-COLOR-PICKER';
                    if (selector === '.button') return this.className.split(/\s+/).includes('button');
                    return false;
                }
                closest(selector) {
                    if (selector === '#chat') return this.insideChat ? { id: 'chat' } : null;
                    if (selector === 'toolcool-color-picker') return this.tagName === 'TOOLCOOL-COLOR-PICKER' ? this : null;
                    return null;
                }
                append(...nodes) { this.children.push(...nodes); }
                prepend(...nodes) { this.children.unshift(...nodes); }
                remove() { this.isConnected = false; }
                contains(node) { return node === this || this.children.some(child => child.contains?.(node)); }
                querySelector(selector) {
                    if (selector === '[data-sb-color-picker-style]') {
                        return this.children.find(child => child.dataset?.sbColorPickerStyle !== undefined) ?? null;
                    }
                    if (selector === '.button') {
                        return this.children.find(child => child.matches?.('.button')) ?? null;
                    }
                    return null;
                }
                addEventListener(type, handler) { this.listeners.set(type, handler); }
                removeEventListener(type, handler) {
                    if (this.listeners.get(type) === handler) this.listeners.delete(type);
                }
                focus() { this.focused = true; }
                getClientRects() { return [{ width: 52, height: 40 }]; }
                getBoundingClientRect() {
                    if (this.className === 'sb-color-picker-menu') {
                        return stylesheetSettled
                            ? { left: 0, top: 0, width: 344, height: 320, right: 344, bottom: 320 }
                            : { left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600 };
                    }
                    return { left: 500, top: 100, width: 52, height: 40, right: 552, bottom: 140 };
                }
            }

            class FakePicker extends FakeElement {
                constructor({ id = '', insideChat = false } = {}) {
                    super('toolcool-color-picker', { id, insideChat });
                    this.button = new FakeElement('button', { className: 'button' });
                    this.shadowRoot = new FakeElement('shadow');
                    this.shadowRoot.append(this.button);
                    this.hex = '#3584E4';
                    this.rgba = 'rgba(53, 132, 228, 1)';
                    this.color = {
                        toHsv: () => ({ h: 212, s: 0.77, v: 0.89, a: 1 }),
                        toRgb: () => ({ r: 53, g: 132, b: 228, a: 1 }),
                    };
                    this.opened = false;
                }
                connectedCallback() {}
                disconnectedCallback() {}
            }

            let stylesheetSettled = false;
            let resolveStylesheet = null;
            const loadStylesheetAsync = jest.fn(() => new Promise((resolve) => {
                resolveStylesheet = () => {
                    stylesheetSettled = true;
                    resolve();
                };
            }));

            const preconnectedPicker = new FakePicker({ id: 'preconnected' });
            const chatPicker = new FakePicker({ id: 'chat-picker', insideChat: true });
            const docListeners = new Map();
            let hostedMenu = null;
            const docStub = {
                activeElement: null,
                querySelectorAll: selector => (selector === 'toolcool-color-picker' ? [preconnectedPicker, chatPicker] : []),
                getElementById: () => null,
                createElement: tag => new FakeElement(tag),
                addEventListener: (type, handler) => docListeners.set(type, handler),
            };
            const winStub = {
                innerWidth: 1280,
                innerHeight: 800,
                visualViewport: null,
                matchMedia: () => ({ matches: false }),
                addEventListener: jest.fn(),
            };
            const context = vm.createContext({
                Element: FakeElement,
                document: docStub,
                window: winStub,
                customElements: {
                    whenDefined: () => Promise.resolve(),
                    get: () => FakePicker,
                },
                SillyBunnyAssets: { loadStylesheetAsync },
                requestAnimationFrame: cb => { cb(); return 1; },
                queueMicrotask,
            });
            context.globalThis = context;

            const module = new vm.SourceTextModule(colorPickerSource, { context });
            const motionStub = new vm.SyntheticModule(['animateIn', 'MOTION_FAST'], function () {
                this.setExport('animateIn', jest.fn());
                this.setExport('MOTION_FAST', 120);
            }, { context });
            const sheetStub = new vm.SyntheticModule(['blockUpstreamDrawerClose'], function () {
                this.setExport('blockUpstreamDrawerClose', jest.fn());
            }, { context });
            const bpStub = new vm.SyntheticModule(['MENU_SHEET_QUERY'], function () {
                this.setExport('MENU_SHEET_QUERY', '(max-width: 768px), (max-height: 360px)');
            }, { context });
            const overlayStub = new vm.SyntheticModule(['hostOverlayLayer'], function () {
                this.setExport('hostOverlayLayer', (el) => { hostedMenu = el; });
            }, { context });
            const dialogStub = new vm.SyntheticModule(['openDialog'], function () {
                this.setExport('openDialog', jest.fn());
            }, { context });

            await module.link((specifier) => {
                if (specifier === './sillybunny-motion.js') return motionStub;
                if (specifier === './sillybunny-sheet.js') return sheetStub;
                if (specifier === './sillybunny-editor/breakpoints.js') return bpStub;
                if (specifier === './sillybunny-editor/overlay-host.js') return overlayStub;
                if (specifier === './sillybunny-editor/dialog.js') return dialogStub;
                throw new Error(`Unexpected import: ${specifier}`);
            });
            await module.evaluate();
            await module.namespace.initializeColorPickers();

            // Pre-connected picker outside #chat is enhanced immediately; picker inside #chat is left untouched.
            expect(preconnectedPicker.button.getAttribute('aria-haspopup')).toBe('dialog');
            expect(preconnectedPicker.shadowRoot.querySelector('[data-sb-color-picker-style]')).not.toBeNull();
            expect(chatPicker.button.getAttribute('aria-haspopup')).toBeNull();

            // Clicking before stylesheet finishes holds popover hidden and places it after CSS settles.
            docListeners.get('click')({
                type: 'click',
                target: preconnectedPicker,
                composedPath: () => [preconnectedPicker.button, preconnectedPicker],
                preventDefault: jest.fn(),
                stopImmediatePropagation: jest.fn(),
            });
            expect(loadStylesheetAsync).toHaveBeenCalledTimes(1);
            expect(hostedMenu).not.toBeNull();
            expect(hostedMenu.style.visibility).toBe('hidden');
            expect(hostedMenu.style.left).toBeUndefined();

            resolveStylesheet();
            await new Promise(resolve => setTimeout(resolve, 0));

            // Post-CSS placement uses 344px width -> anchor.right (552) - 344 = 208px.
            expect(hostedMenu.style.visibility).toBe('');
            expect(hostedMenu.style.left).toBe('208px');
            expect(hostedMenu.style.top).toBe('148px');
        });
    });

    describe('index.html deferred CSS priority, font-display:swap, in-place adoption, and --doc-height coalescing', () => {
        const indexHtml = readPublic('index.html');

        test('gates sillybunny-mobile-navigation.css to BOTTOM_BAR_COMPACT_QUERY, eliminates preload-as-style socket starvation, and leaves boot prefetch to PR 10', () => {
            expect(indexHtml).toMatch(/<link\b[^>]*href="css\/sillybunny-mobile-navigation\.css\?v=[^"]+"[^>]*media="\(max-width: 768px\), \(pointer: coarse\) and \(max-height: 450px\)"/);
            expect(indexHtml).not.toMatch(/<link\b[^>]*rel="preload"[^>]*data-sb-deferred-style/);
            expect(indexHtml).not.toContain('window.__sbBootPrefetch');

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

        test('dynamic-styles.js adopts data-sb-panel-style data-sb-href and data-sb-source-href placeholders in place before css/user.css', async () => {
            const dynamicStylesSource = readPublic('scripts', 'dynamic-styles.js');

            class FakeLinkElement {
                constructor(attrs = {}) {
                    this.tagName = 'LINK';
                    this.attributes = new Map(Object.entries(attrs));
                    this.dataset = {};
                    this.sheet = null;
                    this.listeners = new Map();
                    this.isConnected = true;
                }
                get id() { return this.attributes.get('id') ?? ''; }
                set id(val) { this.attributes.set('id', String(val)); }
                get rel() { return this.attributes.get('rel') ?? ''; }
                set rel(val) { this.attributes.set('rel', String(val)); }
                get relList() {
                    const tokens = new Set(this.rel.split(/\s+/).filter(Boolean));
                    return { contains: token => tokens.has(token) };
                }
                get href() {
                    const raw = this.attributes.get('href');
                    return raw ? new URL(raw, 'http://localhost/').href : '';
                }
                set href(val) { this.attributes.set('href', String(val)); }
                get media() { return this.attributes.get('media') ?? ''; }
                set media(val) { this.attributes.set('media', String(val)); }
                getAttribute(name) { return this.attributes.get(name) ?? null; }
                setAttribute(name, value) { this.attributes.set(name, String(value)); }
                hasAttribute(name) { return this.attributes.has(name); }
                addEventListener(type, fn) { this.listeners.set(type, fn); }
                removeEventListener(type, fn) { if (this.listeners.get(type) === fn) this.listeners.delete(type); }
                dispatch(type) { this.listeners.get(type)?.({ type }); }
                remove() { this.isConnected = false; }
            }

            const entityPlaceholder = new FakeLinkElement({
                'data-sb-deferred-style': '',
                'data-sb-panel-style': '',
                'data-sb-href': 'css/sillybunny-entity-list.css?v=20261118zza',
                'data-sb-media': 'all',
            });
            const hashedPlaceholder = new FakeLinkElement({
                'data-sb-deferred-style': '',
                'data-sb-panel-style': '',
                'data-sb-href': '/frontend-assets/css/sillybunny-character-list-abcdef123456.css',
                'data-sb-source-href': 'css/sillybunny-character-list.css?v=20261122g',
                'data-sb-media': 'all',
            });
            const userCss = new FakeLinkElement({ rel: 'stylesheet', href: 'css/user.css' });
            const headChildren = [entityPlaceholder, hashedPlaceholder, userCss];

            const docStub = {
                baseURI: 'http://localhost/',
                styleSheets: [],
                head: {
                    children: headChildren,
                    appendChild: node => { headChildren.push(node); return node; },
                },
                getElementById: id => headChildren.find(link => link.id === id) ?? null,
                querySelectorAll: () => headChildren,
                createElement: () => new FakeLinkElement(),
            };
            const context = vm.createContext({
                document: docStub,
                window: {},
                HTMLLinkElement: FakeLinkElement,
                MutationObserver: class { observe() {} },
                URL,
                Event: class { constructor(type) { this.type = type; } },
            });
            context.globalThis = context;

            const module = new vm.SourceTextModule(dynamicStylesSource, { context });
            await module.link(() => { throw new Error('dynamic-styles.js has no static imports'); });
            await module.evaluate();

            const { loadStylesheetAsync } = module.namespace;

            const entityPromise = loadStylesheetAsync('css/sillybunny-entity-list.css?v=20261118zza', { id: 'deferred-entity-list-css' });
            expect(headChildren).toEqual([entityPlaceholder, hashedPlaceholder, userCss]);
            expect(entityPlaceholder.id).toBe('deferred-entity-list-css');
            expect(entityPlaceholder.getAttribute('href')).toBe('css/sillybunny-entity-list.css?v=20261118zza');
            expect(entityPlaceholder.rel).toBe('stylesheet');
            expect(entityPlaceholder.media).toBe('print');
            entityPlaceholder.dispatch('load');
            await entityPromise;
            expect(entityPlaceholder.media).toBe('all');
            expect(entityPlaceholder.dataset.sbStyleState).toBe('loaded');

            // Compatible with data-sb-source-href (rewritten frontend-assets URLs) too.
            const listPromise = loadStylesheetAsync('css/sillybunny-character-list.css?v=20261122g', { id: 'deferred-character-list-css' });
            expect(headChildren).toEqual([entityPlaceholder, hashedPlaceholder, userCss]);
            expect(hashedPlaceholder.getAttribute('href')).toBe('/frontend-assets/css/sillybunny-character-list-abcdef123456.css');
            expect(hashedPlaceholder.rel).toBe('stylesheet');
            hashedPlaceholder.dispatch('load');
            await listPromise;
            expect(headChildren.indexOf(entityPlaceholder)).toBeLessThan(headChildren.indexOf(userCss));
            expect(headChildren.indexOf(hashedPlaceholder)).toBeLessThan(headChildren.indexOf(userCss));
        });

        test('switches solid.min.css from font-display:block to font-display:swap', () => {
            const solidCss = readPublic('css', 'solid.min.css');
            expect(solidCss).toContain('font-display:swap');
            expect(solidCss).not.toContain('font-display:block');
        });

        test('coalesces --doc-height resize writes into one rAF', () => {
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

        test('retries transient import failures, coalesces rapid lazy open events, and guards welcome-screen cold boot', async () => {
            const welcomeSource = readPublic('scripts', 'welcome-screen.js');
            expect(welcomeSource).toContain('import { hasStoredConversationBootUsage } from \'./sillybunny-conversation-boot.js\'');
            expect(welcomeSource).toMatch(/const getConversationChats = async \(\) => \{\s*\/\/[^\n]*\n\s*if \(!hasStoredConversationBootUsage\(\)\) \{\s*return \[\];\s*\}/);

            const bootSource = readPublic('scripts', 'sillybunny-conversation-boot.js');
            const windowListeners = new Map();
            const dispatched = [];
            const consoleError = jest.fn();
            class FakeCustomEvent {
                constructor(type, init) {
                    this.type = type;
                    this.detail = init?.detail ?? null;
                }
            }
            const context = vm.createContext({
                window: {
                    addEventListener: (type, handler) => windowListeners.set(type, handler),
                    dispatchEvent: event => dispatched.push(event),
                },
                CustomEvent: FakeCustomEvent,
                console: { error: consoleError },
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

            let attempt = 0;
            let resolveSecondAttempt = null;
            const module = new vm.SourceTextModule(bootSource, {
                context,
                importModuleDynamically: async (specifier) => {
                    expect(specifier).toBe('./sillybunny-conversation.js');
                    attempt += 1;
                    if (attempt === 1) {
                        throw new Error('transient network error');
                    }
                    await new Promise((resolve) => { resolveSecondAttempt = resolve; });
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

            const openHandler = windowListeners.get('sb:open-conversation-workspace');

            // First attempt fails -> logs cleanly, clears cached promise, does not dispatch.
            openHandler(new FakeCustomEvent('sb:open-conversation-workspace', { detail: { avatar: 'first.png' } }));
            await new Promise(resolve => setTimeout(resolve, 0));
            expect(attempt).toBe(1);
            expect(consoleError).toHaveBeenCalledTimes(1);
            expect(dispatched).toHaveLength(0);

            // Second & third rapid opens while loading coalesce into ONE re-dispatched event with latest detail.
            openHandler(new FakeCustomEvent('sb:open-conversation-workspace', { detail: { avatar: 'stale.png' } }));
            openHandler(new FakeCustomEvent('sb:open-conversation-workspace', { detail: { avatar: 'latest.png' } }));
            await Promise.resolve();
            expect(attempt).toBe(2);
            resolveSecondAttempt();
            await new Promise(resolve => setTimeout(resolve, 0));
            expect(dispatched).toHaveLength(1);
            expect(dispatched[0].detail).toEqual({ avatar: 'latest.png' });
        });
    });
});
