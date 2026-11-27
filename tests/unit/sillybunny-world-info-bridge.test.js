/** @jest-environment jsdom */
/* global globalThis */
/* eslint-disable playwright/no-standalone-expect, playwright/prefer-web-first-assertions -- Jest assertions exercise the real world-info bridge module. */
import { jest, describe, test, expect, beforeEach, afterEach } from '@jest/globals';

import { importWorldInfoModule } from '../util/world-info-module-harness.js';

let worldInfo;
let mocks;
let route;
let mount;
let controller;
let changeListener;

async function settle() {
    for (let index = 0; index < 40; index++) await Promise.resolve();
}

function deferred() {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
}

beforeEach(async () => {
    jest.useFakeTimers();
    document.body.innerHTML = '<div id="WorldInfo"><select id="world_editor_select"></select></div>';
    route = jest.fn().mockResolvedValue(undefined);
    globalThis.SillyBunnyShell = { openTab: route };
    controller = { ready: Promise.resolve(), renderRevision: 3, whenBookShown: jest.fn().mockResolvedValue(true) };
    mount = jest.fn(() => controller);

    const loaded = await importWorldInfoModule({
        worldInfoEditorMock: { mountWorldInfoEditor: mount },
    });
    worldInfo = loaded.worldInfo;
    mocks = loaded.mocks;
    worldInfo.setWorldInfoSettings({}, { world_names: ['Book A'] });

    changeListener = jest.fn();
    loaded.$('#world_editor_select').on('change', changeListener);
    mocks.toastr.warning.mockClear();
    jest.clearAllTimers();
});

afterEach(() => {
    jest.useRealTimers();
    delete globalThis.SillyBunnyShell;
    document.body.replaceChildren();
});

describe('openWorldInfoEditor bridge', () => {
    test('awaits route, controller readiness and the shown loaded book', async () => {
        const ready = deferred();
        const shown = deferred();
        controller.ready = ready.promise;
        controller.whenBookShown.mockReturnValue(shown.promise);

        const result = worldInfo.openWorldInfoEditor('Book A');
        await settle();
        expect(changeListener).not.toHaveBeenCalled();

        ready.resolve();
        await settle();
        expect(changeListener).toHaveBeenCalledTimes(1);
        expect(changeListener.mock.calls[0][1]).toEqual({ isCurrent: expect.any(Function) });
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
        expect(await worldInfo.openWorldInfoEditor(name)).toBe(false);
        expect(mocks.toastr.warning).toHaveBeenCalledWith('-- World Info not found --');
        expect(route).not.toHaveBeenCalled();
        expect(changeListener).not.toHaveBeenCalled();
    });

    test('legacy callers may ignore the promise and still open the requested book', async () => {
        worldInfo.openWorldInfoEditor('Book A');
        await settle();
        expect(route).toHaveBeenCalledTimes(1);
        expect(changeListener).toHaveBeenCalledTimes(1);
        expect(controller.whenBookShown).toHaveBeenCalledTimes(1);
        expect(jest.getTimerCount()).toBe(0);
    });

    test('a mount timeout resolves false and late readiness never changes the book', async () => {
        const ready = deferred();
        controller.ready = ready.promise;
        const result = worldInfo.openWorldInfoEditor('Book A');
        await jest.advanceTimersByTimeAsync(5000);
        expect(await result).toBe(false);
        ready.resolve();
        await settle();
        expect(changeListener).not.toHaveBeenCalled();
        expect(controller.whenBookShown).not.toHaveBeenCalled();
    });

    test('failed loading is a false result even for callers that ignore it', async () => {
        controller.whenBookShown.mockRejectedValueOnce(new Error('load failed'));
        expect(await worldInfo.openWorldInfoEditor('Book A')).toBe(false);
        route.mockRejectedValueOnce(new Error('route failed'));
        expect(await worldInfo.openWorldInfoEditor('Book A')).toBe(false);
    });

    test('superseded shell routes never select a stale book', async () => {
        const routing = deferred();
        let current = true;
        route.mockReturnValueOnce(routing.promise);
        const result = worldInfo.openWorldInfoEditor('Book A', { isCurrent: () => current });
        current = false;
        routing.resolve();
        expect(await result).toBe(false);
        expect(mount).not.toHaveBeenCalled();
        expect(changeListener).not.toHaveBeenCalled();
    });

    test('timeout expires the predicate handed to the legacy change/load transport', async () => {
        controller.whenBookShown.mockReturnValueOnce(new Promise(() => {}));
        const result = worldInfo.openWorldInfoEditor('Book A');
        await settle();
        const { isCurrent } = changeListener.mock.calls[0][1];
        expect(isCurrent()).toBe(true);
        await jest.advanceTimersByTimeAsync(5000);
        expect(await result).toBe(false);
        expect(isCurrent()).toBe(false);
    });
});

describe('World Info load commit', () => {
    test.each(['timeout', 'superseded'])('a %s predicate prevents delayed data from committing or rendering', async () => {
        const pendingLoad = deferred();
        const render = jest.fn();
        globalThis.fetch = jest.fn(async (_url, init) => {
            const { name } = JSON.parse(init.body);
            if (name === 'Original') {
                return { ok: true, json: async () => ({ entries: {} }) };
            }
            const bookData = await pendingLoad.promise;
            return { ok: true, json: async () => bookData };
        });

        worldInfo.setWorldInfoEditorAdapter({ render });
        await worldInfo.showWorldEditor('Original');
        render.mockClear();

        let current = true;
        const opening = worldInfo.showWorldEditor('Delayed', { isCurrent: () => current });
        current = false;
        pendingLoad.resolve({ entries: {} });
        await opening;

        expect(worldInfo.getWorldInfoEditorState().name).toBe('Original');
        expect(render).not.toHaveBeenCalled();
    });
});
