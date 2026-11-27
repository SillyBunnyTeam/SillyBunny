/* eslint-disable playwright/no-standalone-expect -- Jest source contract test. */
import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';

// An activated deferred sheet delays the window `load` event while it loads, and `public/script.js` waits for `load` at its top
// level before the app starts. So the idle activation of `performance-loader.js` must not run before `load`: a slow sheet
// would then hold the start of the app. The functions that a caller can use to get a sheet early stay available.
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
function loadPage({ readyState = 'interactive', idleCallbacks = true } = {}) {
    const links = [fakeLink('css/a.css'), fakeLink('webfonts/b.css'), fakeLink('css/c.css')];
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
    runInContext(source, createContext({ document, window }));
    return {
        links, idle, timers, window,
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
