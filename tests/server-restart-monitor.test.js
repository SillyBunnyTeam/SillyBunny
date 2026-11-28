/* global globalThis */
import { afterEach, describe, expect, jest, test } from '@jest/globals';
import express from 'express';
import { JSDOM } from 'jsdom';
import { fileURLToPath } from 'node:url';

import { getServerBootId } from '../src/server-boot-marker.js';
import { hasServerReturnedAfterRestart } from '../public/scripts/server-restart-monitor.js';
import { bootServerMainHarness } from './util/server-main-harness.js';

const defaultConfigPath = fileURLToPath(new URL('../default/config.yaml', import.meta.url));
const pub = relative => fileURLToPath(new URL(`../public/${relative}`, import.meta.url));
const src = relative => fileURLToPath(new URL(`../src/${relative}`, import.meta.url));

function createDomEnvironment() {
    const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://127.0.0.1/' });
    const previous = {
        window: globalThis.window,
        document: globalThis.document,
        HTMLElement: globalThis.HTMLElement,
        HTMLInputElement: globalThis.HTMLInputElement,
        HTMLSelectElement: globalThis.HTMLSelectElement,
        HTMLTextAreaElement: globalThis.HTMLTextAreaElement,
        Node: globalThis.Node,
        Event: globalThis.Event,
        CustomEvent: globalThis.CustomEvent,
        location: globalThis.location,
        toastr: globalThis.toastr,
    };
    Object.assign(globalThis, {
        window: dom.window,
        document: dom.window.document,
        HTMLElement: dom.window.HTMLElement,
        HTMLInputElement: dom.window.HTMLInputElement,
        HTMLSelectElement: dom.window.HTMLSelectElement,
        HTMLTextAreaElement: dom.window.HTMLTextAreaElement,
        Node: dom.window.Node,
        Event: dom.window.Event,
        CustomEvent: dom.window.CustomEvent,
        toastr: { info: jest.fn(), success: jest.fn(), warning: jest.fn(), error: jest.fn() },
    });
    return {
        dom,
        restore() {
            dom.window.close();
            for (const [key, value] of Object.entries(previous)) {
                if (value === undefined) delete globalThis[key];
                else globalThis[key] = value;
            }
        },
    };
}

describe('server restart monitor', () => {
    afterEach(() => {
        jest.restoreAllMocks();
        jest.resetModules();
    });

    test('recognizes restart completion from a changed server boot marker', () => {
        expect(hasServerReturnedAfterRestart({ serverBootId: 'next' }, { previousServerBootId: 'previous' })).toBe(true);
        expect(hasServerReturnedAfterRestart({ serverBootId: 'same' }, { previousServerBootId: 'same' })).toBe(false);
    });

    test('keeps existing revision and offline fallback checks', () => {
        expect(hasServerReturnedAfterRestart({ gitRevision: 'abc' }, { expectedRevision: 'abc' })).toBe(true);
        expect(hasServerReturnedAfterRestart({}, { sawOffline: true })).toBe(true);
        expect(hasServerReturnedAfterRestart({ gitRevision: 'old' }, { expectedRevision: 'new' })).toBe(false);
    });

    test('no longer treats a matching package version as a completed restart', () => {
        expect(hasServerReturnedAfterRestart({ pkgVersion: '1.2.3' }, { expectedVersion: '1.2.3' })).toBe(false);
    });

    test('exposes a stable non-empty boot marker for the current process', () => {
        const bootId = getServerBootId();

        expect(bootId).toEqual(expect.any(String));
        expect(bootId.length).toBeGreaterThan(8);
        expect(getServerBootId()).toBe(bootId);
    });

    test('GET /version from server-main reports the process boot marker', async () => {
        const harness = await bootServerMainHarness();
        let server;
        try {
            const { getServerBootId: activeBootId } = await import('../src/server-boot-marker.js');
            server = await new Promise(resolve => {
                const listening = harness.app.listen(0, '127.0.0.1', () => resolve(listening));
            });
            const response = await fetch(`http://127.0.0.1:${server.address().port}/version`);
            expect(response.status).toBe(200);
            const payload = await response.json();
            expect(payload.serverBootId).toBe(activeBootId());
        } finally {
            if (server) {
                await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
            }
            harness.cleanup();
        }
    });

    test('POST /restart from server-admin reports the process boot marker', async () => {
        const { setConfigFilePath: setFreshConfigPath } = await import('../src/util.js');
        setFreshConfigPath(defaultConfigPath);
        const requestGracefulExit = jest.fn();
        await jest.unstable_mockModule(src('shutdown.js'), () => ({ requestGracefulExit }));
        const { getServerBootId: activeBootId } = await import('../src/server-boot-marker.js');
        const { router: serverAdminRouter } = await import('../src/endpoints/server-admin.js');

        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
        const infoSpy = jest.spyOn(console, 'info').mockImplementation(() => {});
        const app = express();
        app.use(express.json());
        app.use((req, _res, next) => {
            req.user = { profile: { admin: true }, directories: {} };
            next();
        });
        app.use('/api/server-admin', serverAdminRouter);

        let server;
        try {
            server = await new Promise(resolve => {
                const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
            });
            const response = await fetch(`http://127.0.0.1:${server.address().port}/api/server-admin/restart`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({}),
            });
            expect(response.status).toBe(202);
            const payload = await response.json();
            expect(payload).toMatchObject({
                ok: true,
                restarting: true,
                serverBootId: activeBootId(),
            });
            // Let the scheduled restart timer fire into the mocked shutdown handler before teardown.
            await new Promise(resolve => setTimeout(resolve, 250));
            expect(requestGracefulExit).toHaveBeenCalledTimes(1);
        } finally {
            warnSpy.mockRestore();
            infoSpy.mockRestore();
            if (server) {
                await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
            }
        }
    });

    test('Server Tools passes the restart response boot marker into restart polling', async () => {
        const env = createDomEnvironment();
        const reloadSpy = jest.fn();
        Object.defineProperty(globalThis, 'location', {
            configurable: true,
            value: { reload: reloadSpy },
        });
        const fetchSpy = jest.spyOn(globalThis, 'fetch');
        try {
            await jest.unstable_mockModule(pub('lib.js'), () => ({ yaml: { parse: jest.fn() } }));
            await jest.unstable_mockModule(pub('scripts/sillybunny-editor/dialog.js'), () => ({ openAlert: jest.fn() }));
            await jest.unstable_mockModule(pub('scripts/sillybunny-editor/list-shell.js'), () => ({ loadListEditorStyles: jest.fn() }));
            await jest.unstable_mockModule(pub('scripts/sillybunny-editor/select-row.js'), () => ({
                createSelectRow: ({ select }) => ({ row: select, setDisabled: jest.fn(), sync: jest.fn() }),
            }));
            await jest.unstable_mockModule(pub('scripts/i18n.js'), () => ({
                t: (strings, ...values) => strings.reduce((out, part, idx) => out + part + (values[idx] ?? ''), ''),
            }));

            const { createServerTools } = await import('../public/scripts/sillybunny-server-tools.js');
            const pollSpy = jest.fn((data, options) => hasServerReturnedAfterRestart(data, options));
            const createElement = (tag, { className = '', text = '', attrs = {} } = {}) => {
                const el = document.createElement(tag);
                if (className) el.className = className;
                if (text) el.textContent = text;
                for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
                return el;
            };
            const tools = createServerTools({
                createElement,
                createShellPanel: () => {
                    const panel = document.createElement('div');
                    const scroller = document.createElement('div');
                    panel.appendChild(scroller);
                    return { panel, scroller };
                },
                hasServerReturnedAfterRestart: pollSpy,
                isShellOpen: () => true,
                isShellTabOpen: () => true,
                setButtonDisabled: (button, disabled) => { button.disabled = Boolean(disabled); },
                setServerAdminMessage: jest.fn(),
                setServerAdminPill: jest.fn(),
                wait: async () => {},
                waitForAuthorizedRequestHeaders: async () => ({ 'Content-Type': 'application/json' }),
            });

            const { panel } = tools.buildServerAdminPanel();
            document.body.appendChild(panel);

            fetchSpy.mockImplementation(async (url) => {
                if (url === '/api/server-admin/restart') {
                    return new Response(JSON.stringify({ ok: true, serverBootId: 'boot-old', message: 'Restarting' }), {
                        status: 202,
                        headers: { 'Content-Type': 'application/json' },
                    });
                }
                if (url === '/version') {
                    const bootId = pollSpy.mock.calls.length === 0 ? 'boot-old' : 'boot-new';
                    return new Response(JSON.stringify({ serverBootId: bootId }), {
                        status: 200,
                        headers: { 'Content-Type': 'application/json' },
                    });
                }
                return new Response(JSON.stringify({}), { status: 200 });
            });

            const restartButton = [...panel.querySelectorAll('button')].find(btn => btn.textContent.trim() === 'Restart Server');
            expect(restartButton).toBeDefined();
            restartButton.click();

            for (let i = 0; i < 20 && reloadSpy.mock.calls.length === 0; i++) {
                await new Promise(resolve => setTimeout(resolve, 10));
            }

            expect(pollSpy).toHaveBeenCalledWith(
                { serverBootId: 'boot-old' },
                expect.objectContaining({ previousServerBootId: 'boot-old', sawOffline: false }),
            );
            expect(pollSpy).toHaveBeenCalledWith(
                { serverBootId: 'boot-new' },
                expect.objectContaining({ previousServerBootId: 'boot-old' }),
            );
            expect(reloadSpy).toHaveBeenCalledTimes(1);
        } finally {
            fetchSpy.mockRestore();
            env.restore();
        }
    });
});
