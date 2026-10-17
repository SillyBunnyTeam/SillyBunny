import { jest, beforeEach, describe, expect, test } from '@jest/globals';

// ── Minimal DOM stubs (node environment — follows sillybunny-toast-motion.test.js pattern) ──

class FakeElement {
    constructor(tag = 'div') {
        this.tagName = tag.toUpperCase();
        this.className = '';
        this.id = '';
        this.textContent = '';
        this.tabIndex = -1;
        this.hidden = false;
        this.inert = false;
        this.clientWidth = 1000;
        this.isConnected = true;
        this.parentElement = null;
        this.children = [];
        this._listeners = new Map();
        this._attrs = new Map();
        this.dataset = new Proxy({}, { set(t, k, v) { t[k] = String(v); return true; } });
        this.classList = {
            _set: new Set(),
            add(...cs) { for (const c of cs) this._set.add(c); },
            remove(...cs) { for (const c of cs) this._set.delete(c); },
            contains(c) { return this._set.has(c); },
            toggle(c, force) {
                const next = force === undefined ? !this._set.has(c) : Boolean(force);
                next ? this._set.add(c) : this._set.delete(c);
                return next;
            },
        };
        this.style = {
            _map: new Map(),
            setProperty(k, v) { this._map.set(k, v); },
            getPropertyValue(k) { return this._map.get(k) ?? ''; },
            removeProperty(k) { this._map.delete(k); },
        };
    }
    setAttribute(k, v) { this._attrs.set(String(k), String(v)); }
    getAttribute(k) { return this._attrs.get(String(k)) ?? null; }
    addEventListener(type, handler) {
        if (!this._listeners.has(type)) this._listeners.set(type, []);
        this._listeners.get(type).push(handler);
    }
    removeEventListener(type, handler) {
        if (!this._listeners.has(type)) return;
        this._listeners.set(type, this._listeners.get(type).filter(h => h !== handler));
    }
    dispatchEvent(event) {
        const hs = this._listeners.get(event.type) ?? [];
        for (const h of hs) h(event);
        return true;
    }
    append(...nodes) {
        for (const node of nodes) {
            if (node instanceof FakeElement) { node.parentElement = this; this.children.push(node); }
        }
    }
    replaceChildren(...nodes) { this.children = []; if (nodes.length) this.append(...nodes); }
    remove() {
        if (this.parentElement) {
            this.parentElement.children = this.parentElement.children.filter(c => c !== this);
            this.parentElement = null;
        }
    }
    contains(node) {
        if (this === node) return true;
        return this.children.some(c => c.contains(node));
    }
    querySelector(sel) { return this._queryAll(sel)[0] ?? null; }
    querySelectorAll(sel) { return this._queryAll(sel); }
    _queryAll(sel) {
        const results = [];
        for (const child of this.children) {
            if (child._matches(sel)) results.push(child);
            results.push(...child._queryAll(sel));
        }
        return results;
    }
    _matches(sel) {
        if (!sel) return false;
        if (sel.startsWith('.')) return sel.slice(1).split('.').every(c => this.classList._set.has(c));
        const m = sel.match(/^\[([^\]=]+)(?:="([^"]*)")?\]$/);
        if (m) return m[2] !== undefined ? this.getAttribute(m[1]) === m[2] : this.getAttribute(m[1]) !== null;
        return false;
    }
    getBoundingClientRect() { return { width: this.clientWidth, height: 0, top: 0, left: 0, right: 0, bottom: 0 }; }
    focus() {}
    setPointerCapture() {}
    closest() { return null; }
}

// ── Global stubs set before module imports ────────────────────────────────────

const localStorageStore = {};
const localStorageMock = {
    getItem: jest.fn(k => localStorageStore[k] ?? null),
    setItem: jest.fn((k, v) => { localStorageStore[k] = String(v); }),
    clear: jest.fn(() => { Object.keys(localStorageStore).forEach(k => delete localStorageStore[k]); }),
};

let matchMediaMatches = false;
const windowListeners = new Map();

function installGlobals() {
    global.HTMLElement = FakeElement;
    global.document = {
        createElement: jest.fn(tag => new FakeElement(tag)),
        body: new FakeElement('body'),
    };
    global.window = global;
    global.localStorage = localStorageMock;
    global.matchMedia = jest.fn(() => ({
        matches: matchMediaMatches,
        media: '',
        addEventListener: jest.fn(),
        removeEventListener: jest.fn(),
    }));
    global.ResizeObserver = class {
        observe = jest.fn();
        unobserve = jest.fn();
        disconnect = jest.fn();
    };
    global.requestAnimationFrame = jest.fn(cb => { cb(0); return 1; });
    global.cancelAnimationFrame = jest.fn();
    global.addEventListener = jest.fn((type, fn) => {
        if (!windowListeners.has(type)) windowListeners.set(type, []);
        windowListeners.get(type).push(fn);
    });
    global.removeEventListener = jest.fn((type, fn) => {
        if (!windowListeners.has(type)) return;
        windowListeners.set(type, windowListeners.get(type).filter(h => h !== fn));
    });
}

installGlobals();

// ── Module mocks (must be called before await import of module under test) ────

const mockPlay = jest.fn((_n, _f, opts) => { opts?.onEnd?.(); return { cancel: jest.fn() }; });
const mockStopMotion = jest.fn();
const mockPrefersReducedMotion = jest.fn(() => true);

await jest.unstable_mockModule('../../public/scripts/sillybunny-motion.js', () => ({
    play: mockPlay,
    stopMotion: mockStopMotion,
    prefersReducedMotion: mockPrefersReducedMotion,
    SPRING_NAVIGATION: {},
    MOTION_FAST: 200,
}));

const POPUP_RESULT = { AFFIRMATIVE: 1, NEGATIVE: 0 };
const POPUP_TYPE = { CONFIRM: 'confirm' };
let popupShowResult = POPUP_RESULT.NEGATIVE;
const mockPopupShow = jest.fn(() => Promise.resolve(popupShowResult));

await jest.unstable_mockModule('../../public/scripts/popup.js', () => ({
    POPUP_RESULT,
    POPUP_TYPE,
    Popup: jest.fn().mockImplementation(function () {
        this.okButton = Object.assign(new FakeElement('button'), { style: {} });
        this.cancelButton = Object.assign(new FakeElement('button'), { style: {} });
        this.show = mockPopupShow;
    }),
}));

await jest.unstable_mockModule('../../public/scripts/i18n.js', () => ({
    t: jest.fn(strings => (Array.isArray(strings) ? strings.join('') : strings)),
}));

// ── Import under test (after all unstable_mockModule calls) ───────────────────

const { createListEditor } = await import('../../public/scripts/sillybunny-list-editor.js');

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeConfig(overrides = {}) {
    return {
        container: new FakeElement('div'),
        storageKey: 'test-le-width',
        renderList: jest.fn(),
        renderDetail: jest.fn(),
        onSave: jest.fn().mockResolvedValue(true),
        isDirty: jest.fn().mockReturnValue(false),
        onDiscard: jest.fn(),
        onSelect: jest.fn(),
        onDeselect: jest.fn(),
        ...overrides,
    };
}

beforeEach(() => {
    jest.clearAllMocks();
    localStorageMock.clear();
    Object.keys(localStorageStore).forEach(k => delete localStorageStore[k]);
    windowListeners.clear();
    matchMediaMatches = false;
    popupShowResult = POPUP_RESULT.NEGATIVE;
    installGlobals();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('createListEditor', () => {
    describe('instantiation', () => {
        test('mounts root into container', () => {
            const config = makeConfig();
            const editor = createListEditor(config);
            expect(config.container.contains(editor.root)).toBe(true);
        });

        test('root starts with data-open=false and data-collapsed=false', () => {
            const config = makeConfig();
            const editor = createListEditor(config);
            expect(editor.root.dataset.open).toBe('false');
            expect(editor.root.dataset.collapsed).toBe('false');
        });

        test('detail pane starts hidden and inert', () => {
            const config = makeConfig();
            const editor = createListEditor(config);
            expect(editor.detail.hidden).toBe(true);
            expect(editor.detail.inert).toBe(true);
        });

        test('calls renderList on mount', () => {
            const config = makeConfig();
            createListEditor(config);
            expect(config.renderList).toHaveBeenCalledWith(expect.any(FakeElement));
        });

        test('exposes expected public API', () => {
            const config = makeConfig();
            const editor = createListEditor(config);
            for (const key of ['selectItem', 'deselectItem', 'deselectNow', 'refresh', 'scheduleRefresh', 'destroy']) {
                expect(typeof editor[key]).toBe('function');
            }
        });
    });

    describe('sidebar resize — keyboard', () => {
        test('reads stored width from localStorage on init', () => {
            localStorageStore['test-le-width'] = '320';
            const config = makeConfig();
            createListEditor(config);
            expect(localStorageMock.getItem).toHaveBeenCalledWith('test-le-width');
        });

        test('ArrowRight on divider increases width and persists', () => {
            localStorageStore['test-le-width'] = '300';
            const config = makeConfig();
            const editor = createListEditor(config);
            const divider = editor.root.children.find(n => n.className === 'sb-list-editor__divider');
            divider?.dispatchEvent({ type: 'keydown', key: 'ArrowRight', preventDefault: jest.fn() });
            expect(localStorageMock.setItem).toHaveBeenCalledWith('test-le-width', '310');
        });

        test('ArrowLeft on divider decreases width', () => {
            localStorageStore['test-le-width'] = '300';
            const config = makeConfig();
            const editor = createListEditor(config);
            const divider = editor.root.children.find(n => n.className === 'sb-list-editor__divider');
            divider?.dispatchEvent({ type: 'keydown', key: 'ArrowLeft', preventDefault: jest.fn() });
            expect(localStorageMock.setItem).toHaveBeenCalledWith('test-le-width', '290');
        });

        test('width is clamped to minWidth', () => {
            localStorageStore['test-le-width'] = '240';
            const config = makeConfig({ minWidth: 240 });
            const editor = createListEditor(config);
            const divider = editor.root.children.find(n => n.className === 'sb-list-editor__divider');
            for (let i = 0; i < 5; i++) {
                divider?.dispatchEvent({ type: 'keydown', key: 'ArrowLeft', preventDefault: jest.fn() });
            }
            const values = localStorageMock.setItem.mock.calls.map(c => Number(c[1]));
            expect(Math.min(...values)).toBeGreaterThanOrEqual(240);
        });

        test('width is clamped to maxWidth', () => {
            localStorageStore['test-le-width'] = '420';
            const config = makeConfig({ maxWidth: 420 });
            const editor = createListEditor(config);
            const divider = editor.root.children.find(n => n.className === 'sb-list-editor__divider');
            for (let i = 0; i < 5; i++) {
                divider?.dispatchEvent({ type: 'keydown', key: 'ArrowRight', preventDefault: jest.fn() });
            }
            const values = localStorageMock.setItem.mock.calls.map(c => Number(c[1]));
            expect(Math.max(...values)).toBeLessThanOrEqual(420);
        });
    });

    describe('collapse toggle', () => {
        test('sets data-collapsed=true when matchMedia reports mobile', () => {
            matchMediaMatches = true;
            global.matchMedia = jest.fn(() => ({ matches: true, media: '', addEventListener: jest.fn(), removeEventListener: jest.fn() }));
            const config = makeConfig();
            const editor = createListEditor(config);
            editor.layout();
            expect(editor.root.dataset.collapsed).toBe('true');
        });
    });

    describe('selectItem', () => {
        test('opens detail pane and calls renderDetail', async () => {
            const config = makeConfig();
            const editor = createListEditor(config);
            const item = { id: 1, name: 'Test' };
            await editor.selectItem(item);
            expect(editor.detail.hidden).toBe(false);
            expect(config.renderDetail).toHaveBeenCalledWith(editor.detail, item, expect.objectContaining({ isCurrent: expect.any(Function) }));
        });

        test('sets data-open=true after selection', async () => {
            const config = makeConfig();
            const editor = createListEditor(config);
            await editor.selectItem({ id: 1 });
            expect(editor.root.dataset.open).toBe('true');
        });

        test('calls onSelect callback with item', async () => {
            const config = makeConfig();
            const editor = createListEditor(config);
            const item = { id: 42 };
            await editor.selectItem(item);
            expect(config.onSelect).toHaveBeenCalledWith(item);
        });

        test('exposes selectedItem via getter', async () => {
            const config = makeConfig();
            const editor = createListEditor(config);
            const item = { id: 99 };
            await editor.selectItem(item);
            expect(editor.selectedItem).toBe(item);
        });

        test('no-ops when selecting the same item twice', async () => {
            const config = makeConfig();
            const editor = createListEditor(config);
            const item = { id: 1 };
            await editor.selectItem(item);
            config.renderDetail.mockClear();
            await editor.selectItem(item);
            expect(config.renderDetail).not.toHaveBeenCalled();
        });
    });

    describe('dirty guard on selectItem', () => {
        test('blocks navigation when dirty and user cancels', async () => {
            popupShowResult = POPUP_RESULT.NEGATIVE;
            const config = makeConfig({ isDirty: jest.fn().mockReturnValue(true) });
            const editor = createListEditor(config);
            await editor.selectItem({ id: 1 });
            config.renderDetail.mockClear();
            await editor.selectItem({ id: 2 });
            expect(config.renderDetail).not.toHaveBeenCalledWith(editor.detail, { id: 2 }, expect.anything());
        });

        test('calls onSave and proceeds when user confirms save', async () => {
            popupShowResult = POPUP_RESULT.AFFIRMATIVE;
            const config = makeConfig({ isDirty: jest.fn().mockReturnValue(true) });
            const editor = createListEditor(config);
            await editor.selectItem({ id: 1 });
            await editor.selectItem({ id: 2 });
            expect(config.onSave).toHaveBeenCalled();
        });

        test('calls onDiscard when user picks Discard (result 2)', async () => {
            popupShowResult = 2;
            const config = makeConfig({ isDirty: jest.fn().mockReturnValue(true) });
            const editor = createListEditor(config);
            await editor.selectItem({ id: 1 });
            await editor.selectItem({ id: 2 });
            expect(config.onDiscard).toHaveBeenCalled();
        });
    });

    describe('deselectItem', () => {
        test('resets selectedItem to null', async () => {
            const config = makeConfig();
            const editor = createListEditor(config);
            await editor.selectItem({ id: 1 });
            await editor.deselectItem();
            expect(editor.selectedItem).toBeNull();
        });

        test('calls onDeselect callback', async () => {
            const config = makeConfig();
            const editor = createListEditor(config);
            await editor.selectItem({ id: 1 });
            await editor.deselectItem();
            expect(config.onDeselect).toHaveBeenCalled();
        });
    });

    describe('deselectNow (synchronous)', () => {
        test('immediately clears selectedItem without animation', async () => {
            const config = makeConfig();
            const editor = createListEditor(config);
            await editor.selectItem({ id: 1 });
            editor.deselectNow();
            expect(editor.selectedItem).toBeNull();
            expect(editor.detail.hidden).toBe(true);
        });
    });

    describe('refresh', () => {
        test('calls renderList again', () => {
            const config = makeConfig();
            const editor = createListEditor(config);
            config.renderList.mockClear();
            editor.refresh();
            expect(config.renderList).toHaveBeenCalledWith(editor.sidebar);
        });
    });

    describe('key-based selection', () => {
        test('a falsy key such as UID 0 opens and stays open', async () => {
            const config = makeConfig({ getKey: item => item.uid });
            const editor = createListEditor(config);
            expect(await editor.selectItem({ uid: 0 })).toBe(true);
            expect(editor.isOpen).toBe(true);
            expect(editor.selectedKey).toBe(0);
            expect(editor.root.dataset.open).toBe('true');
            expect(editor.detail.hidden).toBe(false);
        });

        test('same key with a different object is a no-op', async () => {
            const config = makeConfig({ getKey: item => item.uid });
            const editor = createListEditor(config);
            await editor.selectItem({ uid: 7 });
            config.renderDetail.mockClear();
            expect(await editor.selectItem({ uid: 7 })).toBe(true);
            expect(config.renderDetail).not.toHaveBeenCalled();
        });

        test('force re-renders the open key', async () => {
            const config = makeConfig();
            const editor = createListEditor(config);
            await editor.selectItem('main');
            config.renderDetail.mockClear();
            await editor.selectItem('main', { force: true });
            expect(config.renderDetail).toHaveBeenCalledTimes(1);
        });

        test('guard: false skips the leave dialog even when dirty', async () => {
            const config = makeConfig({ isDirty: jest.fn().mockReturnValue(true) });
            const editor = createListEditor(config);
            await editor.selectItem('a', { guard: false });
            await editor.selectItem('b', { guard: false });
            expect(mockPopupShow).not.toHaveBeenCalled();
            expect(editor.selectedKey).toBe('b');
        });
    });

    describe('async renderDetail', () => {
        test('passes an isCurrent context to the renderer', async () => {
            const config = makeConfig();
            const editor = createListEditor(config);
            await editor.selectItem('a');
            const context = config.renderDetail.mock.calls[0][2];
            expect(context.isCurrent()).toBe(true);
        });

        test('a newer selection supersedes a pending render', async () => {
            const resolvers = [];
            const config = makeConfig({
                renderDetail: jest.fn(() => new Promise(resolve => resolvers.push(resolve))),
            });
            const editor = createListEditor(config);
            const first = editor.selectItem('a');
            await new Promise(resolve => setTimeout(resolve, 0));
            const second = editor.selectItem('b', { guard: false });
            expect(resolvers).toHaveLength(2);
            resolvers[1]();
            resolvers[0]();
            expect(await second).toBe(true);
            expect(await first).toBe(false);
            expect(editor.selectedKey).toBe('b');
            expect(config.onSelect).toHaveBeenCalledTimes(1);
            expect(config.onSelect).toHaveBeenCalledWith('b');
        });

        test('awaits the renderer before onSelect', async () => {
            const order = [];
            const config = makeConfig({
                renderDetail: jest.fn(async () => { await Promise.resolve(); order.push('render'); }),
                onSelect: jest.fn(() => order.push('select')),
            });
            const editor = createListEditor(config);
            await editor.selectItem('a');
            expect(order).toEqual(['render', 'select']);
        });

        test('a throwing renderer closes the detail and rethrows', async () => {
            const config = makeConfig({ renderDetail: jest.fn(() => { throw new Error('boom'); }) });
            const editor = createListEditor(config);
            await expect(editor.selectItem('a')).rejects.toThrow('boom');
            expect(editor.isOpen).toBe(false);
            expect(editor.detail.hidden).toBe(true);
        });
    });

    describe('guardLeave', () => {
        test('resolves true when clean without a dialog', async () => {
            const editor = createListEditor(makeConfig());
            expect(await editor.guardLeave()).toBe(true);
            expect(mockPopupShow).not.toHaveBeenCalled();
        });

        test('resolves false when dirty and the user cancels', async () => {
            const editor = createListEditor(makeConfig({ isDirty: jest.fn().mockReturnValue(true) }));
            expect(await editor.guardLeave()).toBe(false);
        });

        test('resolves with the save result', async () => {
            popupShowResult = POPUP_RESULT.AFFIRMATIVE;
            const onSave = jest.fn().mockResolvedValue(false);
            const editor = createListEditor(makeConfig({ isDirty: jest.fn().mockReturnValue(true), onSave }));
            expect(await editor.guardLeave()).toBe(false);
            expect(onSave).toHaveBeenCalled();
        });
    });

    describe('deselect focus and ordering', () => {
        test('returns focus to the row found for the closed key', async () => {
            const row = new FakeElement('div');
            row.focus = jest.fn();
            const findRow = jest.fn(() => row);
            const editor = createListEditor(makeConfig({ getKey: item => item.uid, findRow }));
            await editor.selectItem({ uid: 0 });
            await editor.deselectItem();
            expect(findRow).toHaveBeenCalledWith(0);
            expect(row.focus).toHaveBeenCalled();
        });

        test('onDeselect runs before the closing list render', async () => {
            const order = [];
            const config = makeConfig({
                renderList: jest.fn(() => order.push('list')),
                onDeselect: jest.fn(() => order.push('deselect')),
            });
            const editor = createListEditor(config);
            await editor.selectItem('a');
            order.length = 0;
            await editor.deselectItem();
            expect(order[0]).toBe('deselect');
            expect(order).toContain('list');
        });

        test('deselectItem resolves false when the guard blocks', async () => {
            const editor = createListEditor(makeConfig({ isDirty: jest.fn().mockReturnValue(true) }));
            await editor.selectItem('a', { guard: false });
            expect(await editor.deselectItem()).toBe(false);
            expect(editor.isOpen).toBe(true);
        });
    });

    describe('consumer hooks', () => {
        test('classNames extend the shell classes', () => {
            const editor = createListEditor(makeConfig({ classNames: { root: 'sb-prompt-editor', detail: 'sb-prompt-detail' } }));
            expect(editor.root.className).toBe('sb-list-editor sb-prompt-editor');
            expect(editor.detail.className).toBe('sb-list-editor__detail sb-prompt-detail');
            expect(editor.sidebar.className).toBe('sb-list-editor__sidebar');
        });

        test('measureLayout runs before applyLayout with the same info', () => {
            const order = [];
            const measureLayout = jest.fn(info => { order.push('measure'); return { seen: info.width }; });
            const applyLayout = jest.fn(() => order.push('apply'));
            const editor = createListEditor(makeConfig({ measureLayout, applyLayout }));
            editor.layout();
            expect(order.slice(-2)).toEqual(['measure', 'apply']);
            expect(applyLayout).toHaveBeenLastCalledWith({ seen: 1000 }, expect.objectContaining({ width: 1000, collapsed: false, open: false }));
        });

        test('onCollapseChange fires when the layout collapses', () => {
            const onCollapseChange = jest.fn();
            global.matchMedia = jest.fn(() => ({ matches: true, media: '', addEventListener: jest.fn(), removeEventListener: jest.fn() }));
            const editor = createListEditor(makeConfig({ onCollapseChange }));
            editor.layout();
            expect(onCollapseChange).toHaveBeenCalledWith(true);
        });

        test('escapeCloses: false leaves Escape to the consumer', async () => {
            const editor = createListEditor(makeConfig({ escapeCloses: false }));
            await editor.selectItem('a');
            editor.detail.dispatchEvent({ type: 'keydown', key: 'Escape', target: new FakeElement('div'), preventDefault: jest.fn(), stopPropagation: jest.fn() });
            await Promise.resolve();
            expect(editor.isOpen).toBe(true);
        });

        test('Escape outside a field closes by default', async () => {
            const editor = createListEditor(makeConfig());
            await editor.selectItem('a');
            editor.detail.dispatchEvent({ type: 'keydown', key: 'Escape', target: new FakeElement('div'), preventDefault: jest.fn(), stopPropagation: jest.fn() });
            await new Promise(resolve => setTimeout(resolve, 0));
            expect(editor.isOpen).toBe(false);
        });

        test('deferRefresh holds a render until flushRefresh', () => {
            const config = makeConfig();
            const editor = createListEditor(config);
            config.renderList.mockClear();
            editor.flushRefresh();
            expect(config.renderList).not.toHaveBeenCalled();
            editor.deferRefresh();
            editor.flushRefresh();
            expect(config.renderList).toHaveBeenCalledTimes(1);
        });
    });

    describe('compatibility entry point', () => {
        test('sillybunny-list-editor.js re-exports the shared shell', async () => {
            const shared = await import('../../public/scripts/sillybunny-editor/list-shell.js');
            expect(createListEditor).toBe(shared.createListEditor);
        });
    });

    describe('destroy', () => {
        test('removes the media-query listener', () => {
            const editor = createListEditor(makeConfig());
            const media = global.matchMedia.mock.results.at(-1).value;
            const handler = media.addEventListener.mock.calls[0][1];
            editor.destroy();
            expect(media.removeEventListener).toHaveBeenCalledWith('change', handler);
        });

        test('removes root from container', () => {
            const config = makeConfig();
            const editor = createListEditor(config);
            expect(config.container.contains(editor.root)).toBe(true);
            editor.destroy();
            expect(config.container.contains(editor.root)).toBe(false);
        });

        test('does not throw', () => {
            const config = makeConfig();
            const editor = createListEditor(config);
            expect(() => editor.destroy()).not.toThrow();
        });
    });
});
