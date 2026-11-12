/** @jest-environment jsdom */
/* eslint-disable playwright/no-standalone-expect, playwright/prefer-web-first-assertions -- Jest assertions use an isolated bridge seam. */
import { jest, describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { createContext, SourceTextModule } from 'node:vm';

const source = readFileSync(new URL('../../public/scripts/world-info.js', import.meta.url), 'utf8');
const bridgeSource = source.slice(source.indexOf('export async function openWorldInfoEditor('), source.indexOf('\n/**\n * Assigns a lorebook', source.indexOf('export async function openWorldInfoEditor(')));
let open;
let route;
let mount;
let controller;
let change;
let warning;

async function settle() {
    for (let index = 0; index < 20; index++) await Promise.resolve();
}

function deferred() {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
}

beforeEach(async () => {
    jest.useFakeTimers();
    document.body.innerHTML = '<div id="WorldInfo"></div>';
    route = jest.fn().mockResolvedValue(undefined);
    controller = { ready: Promise.resolve(), renderRevision: 3, whenBookShown: jest.fn().mockResolvedValue(true) };
    mount = jest.fn(() => controller);
    change = jest.fn();
    warning = jest.fn();
    const transport = { val: jest.fn(() => transport), trigger: change };
    const context = createContext({
        document, world_names: ['Book A'], openWorldInfoCharacterPanelTab: route,
        $: () => transport, toastr: { warning }, t: strings => strings.join(''),
        setTimeout, clearTimeout,
    });
    const editorModule = new SourceTextModule('export const mountWorldInfoEditor = globalThis.mount;', {
        context: createContext({ mount }),
    });
    await editorModule.link(() => { throw new Error('Unexpected import'); });
    await editorModule.evaluate();
    const bridge = new SourceTextModule(bridgeSource, { context, importModuleDynamically: () => editorModule });
    await bridge.link(() => { throw new Error('Unexpected static import'); });
    await bridge.evaluate();
    open = bridge.namespace.openWorldInfoEditor;
});

afterEach(() => {
    jest.useRealTimers();
    document.body.replaceChildren();
});

describe('openWorldInfoEditor bridge', () => {
    test('awaits route, controller readiness and the shown loaded book', async () => {
        const ready = deferred();
        const shown = deferred();
        controller.ready = ready.promise;
        controller.whenBookShown.mockReturnValue(shown.promise);
        const result = open('Book A');
        await settle();
        expect(change).not.toHaveBeenCalled();
        ready.resolve();
        await settle();
        expect(change).toHaveBeenCalledWith('change', [{ isCurrent: expect.any(Function) }]);
        expect(controller.whenBookShown).toHaveBeenCalledWith('Book A', { isCurrent: expect.any(Function), afterRender: 3 });
        const resolved = jest.fn();
        result.then(resolved);
        await settle();
        expect(resolved).not.toHaveBeenCalled();
        shown.resolve(true);
        expect(await result).toBe(true);
        expect(jest.getTimerCount()).toBe(0);
    });

    test.each(['Missing book', ''])('rejects missing name %s before routing or changing selection', async name => {
        expect(await open(name)).toBe(false);
        expect(warning).toHaveBeenCalledWith('-- World Info not found --');
        expect(route).not.toHaveBeenCalled();
        expect(change).not.toHaveBeenCalled();
    });

    test('legacy callers may ignore the promise and still open the requested book', async () => {
        open('Book A');
        await settle();
        expect(route).toHaveBeenCalledTimes(1);
        expect(change).toHaveBeenCalledTimes(1);
        expect(controller.whenBookShown).toHaveBeenCalledTimes(1);
        expect(jest.getTimerCount()).toBe(0);
    });

    test('a mount timeout resolves false and late readiness never changes the book', async () => {
        const ready = deferred();
        controller.ready = ready.promise;
        const result = open('Book A');
        await jest.advanceTimersByTimeAsync(5000);
        expect(await result).toBe(false);
        ready.resolve();
        await settle();
        expect(change).not.toHaveBeenCalled();
        expect(controller.whenBookShown).not.toHaveBeenCalled();
    });

    test('failed loading is a false result even for callers that ignore it', async () => {
        controller.whenBookShown.mockRejectedValueOnce(new Error('load failed'));
        expect(await open('Book A')).toBe(false);
        route.mockRejectedValueOnce(new Error('route failed'));
        expect(await open('Book A')).toBe(false);
    });

    test('superseded shell routes never select a stale book', async () => {
        const routing = deferred();
        let current = true;
        route.mockReturnValueOnce(routing.promise);
        const result = open('Book A', { isCurrent: () => current });
        current = false;
        routing.resolve();
        expect(await result).toBe(false);
        expect(mount).not.toHaveBeenCalled();
        expect(change).not.toHaveBeenCalled();
    });

    test('timeout expires the predicate handed to the legacy change/load transport', async () => {
        controller.whenBookShown.mockReturnValueOnce(new Promise(() => {}));
        const result = open('Book A');
        await settle();
        const [{ isCurrent }] = change.mock.calls[0][1];
        expect(isCurrent()).toBe(true);
        await jest.advanceTimersByTimeAsync(5000);
        expect(await result).toBe(false);
        expect(isCurrent()).toBe(false);
    });
});

describe('World Info load commit', () => {
    async function loadSeam() {
        const load = deferred();
        const display = jest.fn();
        const showSource = source.slice(source.indexOf('export async function showWorldEditor('), source.indexOf('\n/**\n * SillyBunny: registers', source.indexOf('export async function showWorldEditor(')));
        const module = new SourceTextModule(`
            let worldInfoEditorLoadId = 0;
            let worldInfoEditor = { name: 'Original', data: {} };
            const loadWorldInfo = () => load;
            const displayWorldEntries = display;
            const worldInfoDataSnapshots = new WeakMap();
            const hideWorldEditor = () => {};
            ${showSource}
            export const current = () => worldInfoEditor;
        `, { context: createContext({ load: load.promise, display }) });
        await module.link(() => { throw new Error('Unexpected import'); });
        await module.evaluate();
        return { ...module.namespace, load, display };
    }

    test.each(['timeout', 'superseded'])('a %s predicate prevents delayed data from committing or rendering', async () => {
        const seam = await loadSeam();
        let current = true;
        const opening = seam.showWorldEditor('Delayed', { isCurrent: () => current });
        current = false;
        seam.load.resolve({ entries: {} });
        await opening;
        expect(seam.current().name).toBe('Original');
        expect(seam.display).not.toHaveBeenCalled();
    });
});
