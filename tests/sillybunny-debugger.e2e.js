/* global document, getComputedStyle, globalThis, XMLHttpRequest */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';

const extensionRoot = fileURLToPath(new URL(
    '../public/scripts/extensions/sillybunny-debugger/',
    import.meta.url,
));
const bundlePath = fileURLToPath(new URL(
    '../public/scripts/extensions/sillybunny-debugger/lib/eruda.js',
    import.meta.url,
));
const stylePath = fileURLToPath(new URL(
    '../public/scripts/extensions/sillybunny-debugger/style.css',
    import.meta.url,
));

async function initializeExtensionFixture(page) {
    await page.evaluate(async () => {
        document.body.insertAdjacentHTML('beforeend', '<div id="extensions_settings2"></div><div id="extensionsMenu"></div>');
        const listeners = new Map();
        globalThis.toastr = { info() {}, error() {}, warning() {}, success() {} };
        globalThis.SillyTavern = {
            getContext: () => ({
                eventSource: {
                    on(type, listener) { listeners.set(type, listener); },
                    removeListener(type) { listeners.delete(type); },
                },
                eventTypes: { APP_READY: 'app-ready' },
                registerDebugFunction() {},
            }),
        };
        globalThis.sbdbgLifecycle = await import('/scripts/extensions/sillybunny-debugger/index.js');
        globalThis.sbdbgLifecycle.init();
    });
}

test.beforeEach(async ({ page }) => {
    await page.route('http://sbdbg.test/**', route => {
        const url = new URL(route.request().url());
        const extensionPrefix = '/scripts/extensions/sillybunny-debugger/';
        if (url.pathname.startsWith(extensionPrefix)) {
            let relativePath;
            try {
                relativePath = decodeURIComponent(url.pathname.slice(extensionPrefix.length));
            } catch {
                return route.abort();
            }
            const filePath = path.resolve(extensionRoot, relativePath);
            const localPath = path.relative(extensionRoot, filePath);
            if (localPath === '..' || localPath.startsWith(`..${path.sep}`) || path.isAbsolute(localPath)) {
                return route.abort();
            }
            const contentType = relativePath.endsWith('.json') ? 'application/json' : 'text/javascript';
            return route.fulfill({ status: 200, contentType, path: filePath });
        }
        if (url.pathname.startsWith('/api/webhooks/')) {
            return route.fulfill({
                status: 200,
                headers: {
                    'Content-Type': 'application/x-response-content-type-secret',
                    'Content_Type': 'response-content-type-alias-secret',
                    'Content_Length': '741741741741',
                    'X-Response-Header-Name-Secret': 'response-header-secret',
                },
                body: JSON.stringify({ content: 'response-body-secret' }),
            });
        }
        if (url.pathname === '/capture-failure') {
            return route.fulfill({ status: 503, contentType: 'text/plain', body: 'capture-response-secret' });
        }
        if (url.pathname === '/oversized-length') {
            return route.fulfill({
                status: 200,
                headers: {
                    'Content-Length': '123456789012345678',
                    'Content-Type': 'application/json',
                },
                body: '',
            });
        }
        return route.fulfill({ status: 200, contentType: 'text/html', body: '<main>Debugger test</main>' });
    });
    await page.goto('http://sbdbg.test/');
});

test.afterEach(async ({ page }) => {
    await page.evaluate(() => {
        globalThis.__sillyBunnyDebuggerEruda?.destroy?.();
        globalThis.eruda?.destroy?.();
    });
});

test('provides a keyboard-operable 44px entry button', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.addScriptTag({ path: bundlePath });
    expect(await page.evaluate(() => typeof globalThis.eruda)).toBe('undefined');
    await page.evaluate(() => {
        const eruda = globalThis.__sillyBunnyDebuggerEruda;
        eruda.init({ tool: ['console'] });
        globalThis.sbdbgEntryActivations = 0;
        eruda._entryBtn.on('click', () => {
            globalThis.sbdbgEntryActivations += 1;
        });
    });
    const entry = page.locator('.eruda-entry-btn');

    await expect(entry).toHaveRole('button', { name: 'Open debugger' });
    await expect(entry).toHaveCSS('width', '44px');
    await expect(entry).toHaveCSS('height', '44px');
    await expect(entry).toHaveCSS('transition-property', 'none');
    await entry.focus();
    await expect(entry).toBeFocused();
    await expect(entry).toHaveCSS('box-shadow', /inset/);
    await page.keyboard.press('Enter');
    await expect.poll(() => page.evaluate(() => globalThis.sbdbgEntryActivations)).toBe(1);

    await page.evaluate(() => {
        globalThis.__sillyBunnyDebuggerEruda.hide();
        globalThis.sbdbgEntryActivations = 0;
    });
    await entry.click();
    await expect.poll(() => page.evaluate(() => globalThis.sbdbgEntryActivations)).toBe(1);

    await page.evaluate(() => {
        globalThis.__sillyBunnyDebuggerEruda.hide();
        globalThis.sbdbgEntryActivations = 0;
    });
    const bounds = await entry.boundingBox();
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
    await page.mouse.down();
    await page.mouse.move(bounds.x - 30, bounds.y - 30, { steps: 3 });
    await page.mouse.up();
    expect(await page.evaluate(() => globalThis.sbdbgEntryActivations)).toBe(0);
});

test('keeps the entry button inside the visual viewport', async ({ page }) => {
    await page.evaluate(() => {
        const viewport = new globalThis.EventTarget();
        const addEventListener = viewport.addEventListener;
        const removeEventListener = viewport.removeEventListener;
        const listenerCounts = { resize: 0, scroll: 0 };
        Object.assign(viewport, {
            width: 240,
            height: 300,
            offsetLeft: 20,
            offsetTop: 30,
            scale: 1,
        });
        viewport.addEventListener = function (type, ...args) {
            if (type in listenerCounts) listenerCounts[type] += 1;
            return Reflect.apply(addEventListener, this, [type, ...args]);
        };
        viewport.removeEventListener = function (type, ...args) {
            if (type in listenerCounts) listenerCounts[type] -= 1;
            return Reflect.apply(removeEventListener, this, [type, ...args]);
        };
        Object.defineProperty(globalThis, 'visualViewport', { configurable: true, value: viewport });
        globalThis.sbdbgVisualViewport = viewport;
        globalThis.sbdbgVisualViewportListeners = listenerCounts;
    });
    await page.addScriptTag({ path: bundlePath });
    await page.evaluate(() => globalThis.__sillyBunnyDebuggerEruda.init({ tool: ['console'] }));

    const entry = page.locator('.eruda-entry-btn');
    await expect.poll(async () => {
        const bounds = await entry.boundingBox();
        return bounds.x >= 20 && bounds.y >= 30 && bounds.x + bounds.width <= 260 && bounds.y + bounds.height <= 330;
    }).toBe(true);

    await page.evaluate(() => {
        Object.assign(globalThis.sbdbgVisualViewport, {
            width: 160,
            height: 180,
            offsetLeft: 50,
            offsetTop: 60,
        });
        globalThis.sbdbgVisualViewport.dispatchEvent(new globalThis.Event('resize'));
    });
    await expect.poll(async () => {
        const bounds = await entry.boundingBox();
        return bounds.x >= 50 && bounds.y >= 60 && bounds.x + bounds.width <= 210 && bounds.y + bounds.height <= 240;
    }).toBe(true);

    await page.evaluate(() => globalThis.__sillyBunnyDebuggerEruda.destroy());
    expect(await page.evaluate(() => globalThis.sbdbgVisualViewportListeners)).toEqual({ resize: 0, scroll: 0 });
});

test('shows only the page origin in Eruda Info', async ({ page }) => {
    await page.evaluate(() => globalThis.history.replaceState({}, '', '/private/chat?token=location-secret#private'));
    await page.addScriptTag({ path: bundlePath });
    const locationInfo = await page.evaluate(() => {
        const eruda = globalThis.__sillyBunnyDebuggerEruda;
        eruda.init({ tool: ['info'] });
        return eruda.get('info').get('Location')();
    });

    expect(locationInfo).toBe('http://sbdbg.test');
    expect(locationInfo).not.toContain('private');
    expect(locationInfo).not.toContain('location-secret');
});

test('cleans tools that fail during initialization', async ({ page }) => {
    await page.addScriptTag({ path: bundlePath });
    const result = await page.evaluate(() => {
        const eruda = globalThis.__sillyBunnyDebuggerEruda;
        const consoleLog = globalThis.console.log;
        const consoleInit = eruda.Console.prototype.init;
        const networkInit = eruda.Network.prototype.init;
        eruda.Console.prototype.init = function (...args) {
            consoleInit.apply(this, args);
            throw new Error('forced Console initialization failure');
        };
        eruda.Network.prototype.init = function (...args) {
            networkInit.apply(this, args);
            throw new Error('forced Network initialization failure');
        };

        try {
            eruda.init({ tool: ['console', 'network', 'info'] });
            const network = eruda.chobitsu.domain('Network');
            return {
                consoleRegistered: Boolean(eruda.get('console')),
                networkRegistered: Boolean(eruda.get('network')),
                infoRegistered: Boolean(eruda.get('info')),
                consoleRestored: globalThis.console.log === consoleLog,
                networkListeners: Object.values(network._events)
                    .reduce((total, listeners) => total + listeners.length, 0),
            };
        } finally {
            eruda.Console.prototype.init = consoleInit;
            eruda.Network.prototype.init = networkInit;
            eruda.destroy();
        }
    });

    expect(result).toEqual({
        consoleRegistered: false,
        networkRegistered: false,
        infoRegistered: true,
        consoleRestored: true,
        networkListeners: 0,
    });
});

test('mounts an accessible drawer and tears the extension down cleanly', async ({ page }) => {
    await page.addStyleTag({
        content: ':root{--sb-focus-ring:#7cacf8;--SmartThemeQuoteColor:#7cacf8}'
            + '#extensions_settings2 .inline-drawer-toggle.inline-drawer-header{min-height:42px}'
            + '.inline-drawer-content{display:none}',
    });
    await page.addStyleTag({ path: stylePath });
    await page.evaluate(() => {
        document.addEventListener('click', (event) => {
            const toggle = event.target.closest('.inline-drawer-toggle');
            const content = toggle?.parentElement?.querySelector(':scope > .inline-drawer-content');
            if (content) content.style.display = getComputedStyle(content).display === 'none' ? 'block' : 'none';
        });
    });
    await initializeExtensionFixture(page);

    const toggle = page.locator('#sbdbg-settings > .inline-drawer-toggle');
    await expect(toggle).toHaveRole('button', { name: 'Bunny Debugger' });
    await expect(toggle).toHaveAttribute('aria-controls', 'sbdbg-settings-content');
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(toggle).toHaveCSS('min-height', '44px');
    await expect(page.locator('#sbdbg-settings-content')).toBeHidden();
    await page.evaluate(() => document.activeElement?.blur());
    await page.keyboard.press('Tab');
    await expect(toggle).toBeFocused();
    await expect(toggle).toHaveCSS('box-shadow', /inset/);
    await toggle.press('Enter');
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator('#sbdbg-settings-content')).toBeVisible();
    await toggle.press('Enter');
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator('#sbdbg-settings-content')).toBeHidden();

    await page.locator('#sbdbg-menu-item').click();
    await expect.poll(() => page.evaluate(() => globalThis.eruda?._isInit)).toBe(true);
    await page.evaluate(() => globalThis.sbdbgLifecycle.deactivate());
    await expect(page.locator('#sbdbg-settings')).toHaveCount(0);
    await expect(page.locator('#sbdbg-menu-item')).toHaveCount(0);
    expect(await page.evaluate(() => Object.hasOwn(globalThis, 'eruda'))).toBe(false);

    await page.evaluate(() => globalThis.sbdbgLifecycle.init());
    await page.locator('#sbdbg-menu-item').click();
    await expect.poll(() => page.evaluate(() => globalThis.eruda?._isInit)).toBe(true);
    await page.evaluate(() => {
        const instance = globalThis.eruda;
        const destroy = instance.destroy.bind(instance);
        const overlay = instance.chobitsu.domain('Overlay');
        globalThis.sbdbgDestroyedEruda = instance;
        globalThis.sbdbgDestroyedDevTools = instance.get();
        globalThis.sbdbgOriginalSetInspectMode = overlay.setInspectMode;
        instance.destroy = () => {
            globalThis.sbdbgDestroyCalled = true;
            return destroy();
        };
        overlay.setInspectMode = () => {
            throw new Error('inspect cleanup failure');
        };
        globalThis.sbdbgLifecycle.deactivate();
    });
    expect(await page.evaluate(() => globalThis.sbdbgDestroyCalled)).toBe(true);
    expect(await page.evaluate(() => Object.hasOwn(globalThis, 'eruda'))).toBe(false);
    await expect(page.locator('.eruda-container')).toHaveCount(0);
    const cleanupState = await page.evaluate(() => {
        const network = globalThis.sbdbgDestroyedEruda.chobitsu.domain('Network');
        return {
            tools: Object.keys(globalThis.sbdbgDestroyedDevTools._tools),
            networkListeners: Object.values(network._events).reduce((total, listeners) => total + listeners.length, 0),
        };
    });
    expect(cleanupState).toEqual({ tools: [], networkListeners: 0 });

    await page.evaluate(() => {
        const instance = globalThis.sbdbgDestroyedEruda;
        instance.chobitsu.domain('Overlay').setInspectMode = globalThis.sbdbgOriginalSetInspectMode;
        globalThis.sbdbgLifecycle.init();
    });
    await page.locator('#sbdbg-menu-item').click();
    await expect.poll(() => page.evaluate(() => globalThis.eruda?._isInit)).toBe(true);
    expect(await page.evaluate(() => {
        const events = globalThis.eruda.chobitsu.domain('Network')._events;
        return ['requestWillBeSent', 'responseReceivedExtraInfo', 'responseReceived', 'loadingFinished', 'loadingFailed']
            .map(name => events[name]?.length ?? 0);
    })).toEqual([1, 1, 1, 1, 1]);
    await page.evaluate(() => globalThis.sbdbgLifecycle.deactivate());
});

test('cancels an in-flight debugger load when disabled', async ({ page }) => {
    const bundleUrl = /^http:\/\/sbdbg\.test\/scripts\/extensions\/sillybunny-debugger\/lib\/eruda\.js\?load=\d+$/;
    let releaseFirstRoute;
    let releaseSecondRoute;
    let notifyFirstRouteHeld;
    let notifySecondRouteHeld;
    let notifyFirstRouteDone;
    let notifySecondRouteDone;
    let requestCount = 0;
    const firstRouteHeld = new Promise(resolve => notifyFirstRouteHeld = resolve);
    const secondRouteHeld = new Promise(resolve => notifySecondRouteHeld = resolve);
    const firstRouteDone = new Promise(resolve => notifyFirstRouteDone = resolve);
    const secondRouteDone = new Promise(resolve => notifySecondRouteDone = resolve);
    await page.route(bundleUrl, async (route) => {
        requestCount += 1;
        const first = requestCount === 1;
        if (first) notifyFirstRouteHeld();
        else notifySecondRouteHeld();
        await new Promise(resolve => {
            if (first) releaseFirstRoute = resolve;
            else releaseSecondRoute = resolve;
        });
        await route.fulfill({ status: 200, contentType: 'text/javascript', path: bundlePath }).catch(() => {});
        if (first) notifyFirstRouteDone();
        else notifySecondRouteDone();
    });
    await initializeExtensionFixture(page);
    await page.locator('#sbdbg-menu-item').click();
    await firstRouteHeld;

    try {
        await page.evaluate(() => globalThis.sbdbgLifecycle.deactivate());
        await expect(page.locator('script[src*="/lib/eruda.js?load="]')).toHaveCount(0);
        expect(await page.evaluate(() => Object.hasOwn(globalThis, 'eruda'))).toBe(false);

        await page.evaluate(() => globalThis.sbdbgLifecycle.init());
        await page.locator('#sbdbg-menu-item').click();
        await secondRouteHeld;
        releaseFirstRoute();
        await firstRouteDone;
        await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 50)));
        expect(await page.evaluate(() => Object.hasOwn(globalThis, 'eruda'))).toBe(false);
        await expect(page.locator('script[src*="/lib/eruda.js?load="]')).toHaveCount(1);

        releaseSecondRoute();
        await secondRouteDone;
        await expect.poll(() => page.evaluate(() => globalThis.eruda?._isInit)).toBe(true);
        await page.evaluate(() => globalThis.sbdbgLifecycle.deactivate());
    } finally {
        releaseFirstRoute?.();
        releaseSecondRoute?.();
        await page.unroute(bundleUrl);
    }
});

test('preserves foreign public and private Eruda globals', async ({ page }) => {
    await initializeExtensionFixture(page);
    await page.evaluate(() => {
        globalThis.eruda = { owner: 'foreign' };
    });

    await page.locator('#sbdbg-menu-item').click();
    await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 50)));

    expect(await page.evaluate(() => globalThis.eruda?.owner)).toBe('foreign');
    await expect(page.locator('script[src*="/lib/eruda.js?load="]')).toHaveCount(0);
    await page.evaluate(() => globalThis.sbdbgLifecycle.deactivate());
    expect(await page.evaluate(() => globalThis.eruda?.owner)).toBe('foreign');

    await page.evaluate(() => {
        delete globalThis.eruda;
        Object.defineProperty(globalThis, '__sillyBunnyDebuggerEruda', {
            configurable: true,
            value: { owner: 'foreign-private' },
        });
        globalThis.sbdbgLifecycle.init();
    });
    await page.locator('#sbdbg-menu-item').click();
    await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 50)));
    expect(await page.evaluate(() => globalThis.__sillyBunnyDebuggerEruda?.owner)).toBe('foreign-private');
    await expect(page.locator('script[src*="/lib/eruda.js?load="]')).toHaveCount(0);
    await page.evaluate(() => globalThis.sbdbgLifecycle.deactivate());
});

test('preserves foreign Eruda globals introduced during load or before teardown', async ({ page }) => {
    const bundleUrl = /^http:\/\/sbdbg\.test\/scripts\/extensions\/sillybunny-debugger\/lib\/eruda\.js\?load=\d+$/;
    let releaseRoute;
    let notifyRouteHeld;
    let notifyRouteDone;
    const routeHeld = new Promise(resolve => notifyRouteHeld = resolve);
    const routeDone = new Promise(resolve => notifyRouteDone = resolve);
    await page.route(bundleUrl, async (route) => {
        notifyRouteHeld();
        await new Promise(resolve => releaseRoute = resolve);
        await route.fulfill({ status: 200, contentType: 'text/javascript', path: bundlePath }).catch(() => {});
        notifyRouteDone();
    });
    await initializeExtensionFixture(page);
    await page.locator('#sbdbg-menu-item').click();
    await routeHeld;

    try {
        await page.evaluate(() => {
            globalThis.eruda = { owner: 'during-load' };
        });
        releaseRoute();
        await routeDone;
        await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 50)));
        expect(await page.evaluate(() => globalThis.eruda?.owner)).toBe('during-load');
        await page.evaluate(() => globalThis.sbdbgLifecycle.deactivate());
        expect(await page.evaluate(() => globalThis.eruda?.owner)).toBe('during-load');
    } finally {
        releaseRoute?.();
        await page.unroute(bundleUrl);
    }

    await page.evaluate(() => {
        delete globalThis.eruda;
        globalThis.sbdbgLifecycle.init();
    });
    await page.locator('#sbdbg-menu-item').click();
    await expect.poll(() => page.evaluate(() => globalThis.eruda?._isInit)).toBe(true);
    await page.evaluate(() => {
        globalThis.sbdbgOwnedEruda = globalThis.eruda;
        globalThis.eruda = { owner: 'replacement' };
        globalThis.sbdbgLifecycle.deactivate();
    });
    expect(await page.evaluate(() => globalThis.eruda?.owner)).toBe('replacement');
    expect(await page.evaluate(() => globalThis.sbdbgOwnedEruda?._isInit)).toBe(false);
    await expect(page.locator('.eruda-container')).toHaveCount(0);
});

test('captures only shareable console metadata and clears it on disable', async ({ page }) => {
    await initializeExtensionFixture(page);
    const result = await page.evaluate(async () => {
        const capture = await import('/scripts/extensions/sillybunny-debugger/src/capture.js');
        const error = new Error('private error message');
        error.stack = 'Error: private error message\n'
            + '    at https://outside.test/private/source.js?token=stack-secret:10:2';
        console.error('prompt:', 'private console content', error);
        await fetch('/capture-failure?token=capture-query-secret', { method: 'CAPTURE_METHOD_SECRET_741' });
        const entry = capture.getEntries().at(-1);
        const request = capture.getRequests().at(-1);
        globalThis.sbdbgLifecycle.deactivate();
        return { entry, request, remaining: capture.getEntries().length };
    });

    expect(result.entry.text).toBe('[text redacted] [text redacted] Error: [message redacted]');
    expect(result.entry.stack).toContain('https://outside.test/[redacted]?[redacted]');
    expect(JSON.stringify(result.entry)).not.toContain('private');
    expect(JSON.stringify(result.entry)).not.toContain('stack-secret');
    expect(result.request).toMatchObject({ method: 'OTHER', url: '/[redacted]?[redacted]', status: 503 });
    expect(JSON.stringify(result.request)).not.toContain('CAPTURE_METHOD_SECRET_741');
    expect(JSON.stringify(result.request)).not.toContain('capture-query-secret');
    expect(result.remaining).toBe(0);
});

test('stores only redacted Network metadata and can reinitialize cleanly', async ({ page }) => {
    await page.addScriptTag({ path: bundlePath });
    const result = await page.evaluate(async () => {
        const eruda = globalThis.__sillyBunnyDebuggerEruda;
        eruda.init({ tool: ['network'] });
        document.cookie = 'cookie-name-secret-741=cookie-value-secret-741';
        const method = {
            private: 'fetch-method-object-secret',
            toString: () => 'PATCH',
        };
        await fetch('/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz0123456789?token=query-secret', {
            method,
            headers: {
                Authorization: 'Bearer authorization-secret',
                'Content-Type': 'application/x-request-content-type-secret',
                'Content_Type': 'request-content-type-alias-secret',
                'X-Api-Token': 'api-token-header-secret',
                'X-Request-Header-Name-Secret': 'request-header-secret',
            },
            body: JSON.stringify({ prompt: 'request-body-secret' }),
        });
        await new Promise((resolve, reject) => {
            const request = new XMLHttpRequest();
            request.open('XHR_METHOD_SECRET_741', '/api/token=xhr-path-secret?token=xhr-query-secret');
            request.setRequestHeader('Content-Type', 'text/x-xhr-content-type-secret');
            request.setRequestHeader('Content_Type', 'xhr-content-type-alias-secret');
            request.setRequestHeader('X-Api-Token', 'xhr-header-secret');
            request.addEventListener('loadend', resolve, { once: true });
            request.addEventListener('error', reject, { once: true });
            request.send('xhr-body-secret');
        });
        await fetch('credential-marker-741://private-host/private-path?token=url-scheme-secret').catch(() => {});
        await fetch('/oversized-length', { method: 'HEAD' });
        await new Promise(resolve => setTimeout(resolve, 0));

        const requests = eruda.get('network')._requests;
        const oversizedSize = Object.values(requests).find(request => request.method === 'HEAD')?.size;
        const stored = JSON.stringify(requests);
        const cookies = JSON.stringify(eruda.chobitsu.domain('Network').getCookies());
        eruda.destroy();
        const removedAfterDestroy = !document.querySelector('.eruda-container');
        eruda.init({ tool: ['network'] });
        const reinitialized = eruda._isInit;

        return { stored, cookies, oversizedSize, removedAfterDestroy, reinitialized };
    });

    expect(result.stored).toContain('[redacted]');
    expect(result.stored).toContain('PATCH');
    expect(result.stored).toContain('OTHER');
    expect(result.stored).toContain('[unsupported URL]');
    expect(result.stored).not.toContain('query-secret');
    expect(result.stored).not.toContain('authorization-secret');
    expect(result.stored).not.toContain('api-token-header-secret');
    expect(result.stored).not.toContain('123456789012345678');
    expect(result.stored).not.toContain('abcdefghijklmnopqrstuvwxyz0123456789');
    expect(result.stored).not.toContain('request-body-secret');
    expect(result.stored).not.toContain('response-header-secret');
    expect(result.stored).not.toContain('response-content-type-secret');
    expect(result.stored).not.toContain('response-content-type-alias-secret');
    expect(result.stored).not.toContain('X-Response-Header-Name-Secret');
    expect(result.stored).not.toContain('response-body-secret');
    expect(result.stored).not.toContain('fetch-method-object-secret');
    expect(result.stored).not.toContain('request-content-type-secret');
    expect(result.stored).not.toContain('request-content-type-alias-secret');
    expect(result.stored).not.toContain('X-Request-Header-Name-Secret');
    expect(result.stored).not.toContain('request-header-secret');
    expect(result.stored).not.toContain('xhr-path-secret');
    expect(result.stored).not.toContain('xhr-query-secret');
    expect(result.stored).not.toContain('xhr-header-secret');
    expect(result.stored).not.toContain('XHR_METHOD_SECRET_741');
    expect(result.stored).not.toContain('xhr-content-type-secret');
    expect(result.stored).not.toContain('xhr-content-type-alias-secret');
    expect(result.stored).not.toContain('xhr-body-secret');
    expect(result.stored).not.toContain('credential-marker-741');
    expect(result.stored).not.toContain('url-scheme-secret');
    expect(result.stored).not.toContain('123456789012345678');
    expect(result.cookies).toBe('{"cookies":[]}');
    expect(result.oversizedSize).toBe(0);
    expect(result.removedAfterDestroy).toBe(true);
    expect(result.reinitialized).toBe(true);
});

test('stores only redacted WebSocket metadata and payload markers', async ({ page }) => {
    await page.evaluate(() => {
        class MockWebSocket extends globalThis.EventTarget {
            static CONNECTING = 0;
            static OPEN = 1;
            static CLOSING = 2;
            static CLOSED = 3;
            constructor(url) {
                super();
                this.url = String(url);
                this.protocol = '';
                this.readyState = MockWebSocket.OPEN;
            }
            send(data) {
                this.lastSent = data;
            }
            close() {
                this.readyState = MockWebSocket.CLOSED;
            }
        }
        globalThis.WebSocket = MockWebSocket;
    });
    await page.addScriptTag({ path: bundlePath });

    const observed = await page.evaluate(async () => {
        const eruda = globalThis.__sillyBunnyDebuggerEruda;
        eruda.init({ tool: ['network'] });
        const network = eruda.chobitsu.domain('Network');
        const events = {};
        network.on('webSocketCreated', (params) => { events.created = params; });
        network.on('webSocketFrameSent', (params) => { events.sent = params; });
        network.on('webSocketFrameReceived', (params) => { events.received = params; });
        const socket = new globalThis.WebSocket(
            'wss://api.telegram.org/bot123456789:AAExampleTelegramTokenLengthThirtyFive?token=ws-query-secret',
        );
        socket.dispatchEvent(new globalThis.Event('open'));
        socket.send('ws-request-secret');
        socket.dispatchEvent(new globalThis.MessageEvent('message', { data: 'ws-response-secret' }));
        await new Promise(resolve => setTimeout(resolve, 0));
        socket.close();
        return events;
    });

    expect(observed.created.url).toBe('wss://api.telegram.org/[redacted]?[redacted]');
    expect(observed.sent.response.payloadData).toBe('[redacted]');
    expect(observed.received.response.payloadData).toBe('[redacted]');
    expect(observed.sent.requestId).toBe(observed.created.requestId);
    expect(observed.received.requestId).toBe(observed.created.requestId);
});
