/* eslint-disable playwright/no-standalone-expect -- Jest source contract test. */
import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';

// An activated deferred sheet delays the window `load` event while it loads, and `public/script.js` waits for `load` at its top
// level before the app starts. So the idle activation of `performance-loader.js` must not run before `load`: a slow sheet
// would then hold the start of the app. The functions that a caller can use to get a sheet early stay available.
//
// A browser has `PerformanceObserver`, and then the loader waits for a mark of the start instead of `load` alone. The first
// describe runs the page without one, which is the path of a browser that cannot observe marks; the second describe runs
// the page the way a browser does.
const source = readFileSync(new URL('../../public/scripts/performance-loader.js', import.meta.url), 'utf8');

function fakeLink(href) {
    const attributes = { 'data-sb-deferred-style': '', 'data-sb-media': 'all', href };
    const listeners = {};
    return {
        rel: 'preload',
        media: '',
        dataset: {},
        listeners,
        getAttribute: name => attributes[name] ?? null,
        addEventListener: (type, listener) => { listeners[type] = listener; },
    };
}

/**
 * Runs the loader against a page in the given state. `fire('load')` and `fire('DOMContentLoaded')` dispatch to what the loader registered.
 * @param {{ readyState?: string, idleCallbacks?: boolean }} [options]
 */
function loadPage({ readyState = 'interactive', idleCallbacks = true, links = [fakeLink('css/a.css'), fakeLink('webfonts/b.css'), fakeLink('css/c.css')], observeMarks = null } = {}) {
    const idle = [];
    const timers = [];
    const documentListeners = {};
    const windowListeners = {};
    const document = {
        readyState,
        querySelectorAll: selector => (selector === 'link[data-sb-deferred-style]' ? links : []),
        addEventListener: (type, listener) => { (documentListeners[type] ??= []).push(listener); },
    };
    const window = {
        addEventListener: (type, listener) => { (windowListeners[type] ??= []).push(listener); },
        setTimeout: (callback, delay) => { timers.push({ callback, delay }); },
    };
    if (idleCallbacks) {
        window.requestIdleCallback = (callback, options) => { idle.push({ callback, options }); };
    }
    const context = { document, window };
    const observers = [];
    const marks = [...(observeMarks?.existing ?? [])];
    if (observeMarks) {
        context.PerformanceObserver = class {
            static supportedEntryTypes = ['mark'];
            constructor(callback) {
                this.callback = callback;
                this.disconnected = false;
                observers.push(this);
            }
            observe() {}
            disconnect() { this.disconnected = true; }
        };
        context.performance = { getEntriesByName: name => marks.filter(mark => mark === name).map(mark => ({ name: mark })) };
    }
    runInContext(source, createContext(context));
    return {
        links, idle, timers, window,
        /** Makes the mark as the browser does: the entry list reaches every observer that is still connected. */
        mark(name) {
            marks.push(name);
            for (const observer of observers.filter(candidate => !candidate.disconnected)) {
                observer.callback({ getEntries: () => [{ name }] });
            }
        },
        activated: () => links.filter(link => link.dataset.sbStyleActivated === 'true').length,
        runIdle() {
            for (const { callback } of idle.splice(0)) callback();
        },
        runTimers() {
            for (const { callback } of timers.splice(0)) callback();
        },
        fire(type) {
            document.readyState = type === 'load' ? 'complete' : document.readyState;
            for (const listener of [...(type === 'load' ? windowListeners : documentListeners)[type] ?? []]) listener();
        },
    };
}

describe('performance loader: the idle activation of the deferred sheets', () => {
    test('requests nothing and activates nothing while the page is still loading', () => {
        const page = loadPage({ readyState: 'loading' });
        expect(page.idle).toHaveLength(0);
        expect(page.timers).toHaveLength(0);
        expect(page.activated()).toBe(0);
    });

    test('does not run before the window load event, however idle the page is', () => {
        const page = loadPage({ readyState: 'interactive' });
        expect(page.idle).toHaveLength(0);
        page.fire('DOMContentLoaded');
        page.runIdle();
        page.runTimers();
        expect(page.idle).toHaveLength(0);
        expect(page.activated()).toBe(0);
        expect(page.links.every(link => link.rel === 'preload')).toBe(true);
    });

    test('activates every sheet from an idle callback after the load event', () => {
        const page = loadPage({ readyState: 'interactive' });
        page.fire('load');
        expect(page.activated()).toBe(0);
        expect(page.idle.length).toBeGreaterThan(0);
        expect(page.idle.every(({ options }) => options.timeout === 2500)).toBe(true);
        page.runIdle();
        expect(page.activated()).toBe(3);
        for (const link of page.links) {
            expect(link.rel).toBe('stylesheet');
            expect(link.media).toBe('all');
            expect(link.dataset.sbStyleState).toBe('loading');
        }
        page.links[0].listeners.load();
        expect(page.links[0].dataset.sbStyleState).toBe('loaded');
        expect(page.links[0].dataset.loaded).toBe('true');
        page.links[1].listeners.error();
        expect(page.links[1].dataset.sbStyleState).toBe('error');
    });

    test('schedules at once when the page has already loaded', () => {
        const page = loadPage({ readyState: 'complete' });
        expect(page.idle.length).toBeGreaterThan(0);
        page.runIdle();
        expect(page.activated()).toBe(3);
    });

    test('falls back to a timer after the load event where requestIdleCallback is missing', () => {
        const page = loadPage({ readyState: 'interactive', idleCallbacks: false });
        expect(page.timers).toHaveLength(0);
        page.fire('load');
        expect(page.timers.length).toBeGreaterThan(0);
        expect(page.timers.every(({ delay }) => delay === 1200)).toBe(true);
        page.runTimers();
        expect(page.activated()).toBe(3);
    });

    test('the idle work schedules nothing more once it has run', () => {
        const page = loadPage({ readyState: 'interactive' });
        page.fire('load');
        const scheduled = page.idle.length;
        page.runIdle();
        expect(page.idle).toHaveLength(0);
        expect(scheduled).toBeGreaterThan(0);
    });

    test('a caller that needs a sheet early gets it before the load event', () => {
        const page = loadPage({ readyState: 'interactive' });
        page.window.SillyBunnyLoadStylesheet();
        expect(page.activated()).toBe(3);
        expect(page.links.every(link => link.rel === 'stylesheet')).toBe(true);

        const fonts = loadPage({ readyState: 'interactive' });
        fonts.window.SillyBunnyLoadWideFontFallbacks();
        expect(fonts.activated()).toBe(3);
    });

    test('activating on demand twice changes nothing the second time', () => {
        const page = loadPage({ readyState: 'interactive' });
        page.window.SillyBunnyLoadStylesheet();
        const state = page.links.map(link => ({ ...link.dataset }));
        page.window.SillyBunnyLoadStylesheet();
        page.fire('load');
        page.runIdle();
        expect(page.links.map(link => ({ ...link.dataset }))).toEqual(state);
    });
});

/** A link as `index.html` writes it: no `href` until the loader activates it. */
function fakePlaceholder(deferredHref, { panel = false } = {}) {
    const attributes = { 'data-sb-deferred-style': '', 'data-sb-href': deferredHref, 'data-sb-media': 'all' };
    if (panel) attributes['data-sb-panel-style'] = '';
    const listeners = {};
    return {
        rel: '',
        media: '',
        dataset: panel ? { sbPanelStyle: '' } : {},
        listeners,
        getAttribute: name => attributes[name] ?? null,
        setAttribute: (name, value) => { attributes[name] = value; },
        hasAttribute: name => name in attributes,
        addEventListener: (type, listener) => { listeners[type] = listener; },
    };
}

describe('performance loader: the activation in a browser that observes marks', () => {
    const fonts = () => [fakePlaceholder('webfonts/NotoSans/stylesheet.css'), fakePlaceholder('css/brands.min.css')];
    const start = (options = {}) => {
        const panel = fakePlaceholder('css/sillybunny-entity-list.css', { panel: true });
        const page = loadPage({ links: [...fonts(), panel], observeMarks: {}, ...options });
        return { page, panel, fontLinks: page.links.slice(0, 2) };
    };

    test('waits while the start is under way, and arms its timer only from the load event', () => {
        const { page } = start();
        expect(page.idle).toHaveLength(0);
        expect(page.timers).toHaveLength(0);

        page.fire('load');
        expect(page.idle).toHaveLength(0);
        expect(page.timers).toEqual([expect.objectContaining({ delay: 3000 })]);
        expect(page.activated()).toBe(0);
    });

    test('activates the fonts from an idle callback once the app is ready, from the href that the page keeps for them', () => {
        const { page, fontLinks, panel } = start();
        page.fire('load');

        page.mark('sb-app-ready');
        expect(page.idle).toHaveLength(1);
        expect(page.activated()).toBe(0);
        page.runIdle();

        expect(fontLinks.map(link => link.getAttribute('href'))).toEqual(['webfonts/NotoSans/stylesheet.css', 'css/brands.min.css']);
        expect(fontLinks.every(link => link.rel === 'stylesheet' && link.media === 'all')).toBe(true);
        expect(panel.rel).toBe('');
        expect(panel.getAttribute('href')).toBeNull();
    });

    test('activates the fonts while the first-run Welcome dialog holds startup, before sb-app-ready', () => {
        const { page, fontLinks } = start();
        page.fire('load');

        page.mark('sb-welcome-shown');
        page.runIdle();

        expect(fontLinks.every(link => link.rel === 'stylesheet')).toBe(true);
    });

    test('activates the fonts a few seconds after load when the app never becomes ready', () => {
        const { page, fontLinks } = start();
        page.fire('load');
        expect(page.timers).toHaveLength(1);

        page.runTimers();
        expect(page.idle).toHaveLength(1);
        page.runIdle();

        expect(fontLinks.every(link => link.rel === 'stylesheet')).toBe(true);
    });

    test('arms its timer at once when the page has loaded before the loader runs', () => {
        const { page } = start({ readyState: 'complete' });

        expect(page.timers).toEqual([expect.objectContaining({ delay: 3000 })]);
    });

    test.each(['sb-app-ready', 'sb-welcome-shown'])('activates at once when %s was made before the loader ran', (name) => {
        const { page } = start({ observeMarks: { existing: [name] } });

        expect(page.idle).toHaveLength(1);
        page.runIdle();
        expect(page.activated()).toBe(2);
    });

    test('schedules the idle work once however many of the three triggers arrive', () => {
        const { page } = start();
        page.fire('load');

        page.mark('sb-welcome-shown');
        page.mark('sb-app-ready');
        page.runTimers();

        expect(page.idle).toHaveLength(1);
    });

    test('ignores marks of the start that do not mean the app is ready', () => {
        const { page } = start();
        page.fire('load');

        page.mark('sb-boot-dismiss');
        page.mark('sb-boot-init-start');

        expect(page.idle).toHaveLength(0);
        expect(page.activated()).toBe(0);
    });
});
