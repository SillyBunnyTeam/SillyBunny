/**
 * Attaches Playwright to the app's WebView over the Chrome DevTools Protocol (plan §7.1 "Driving the app"):
 * `adb forward tcp:<free port> localabstract:webview_devtools_remote_<pid>`, then
 * `chromium.connectOverCDP`. Debug builds enable WebView debugging (WebShellPlatform), so the socket exists
 * while the app process has a WebView. The host port is a random free port in the fixture range. A WebView
 * whose pages Playwright does not list gets {@link attachWebViewPage} instead.
 */
import net from 'node:net';

import { chromium } from '@playwright/test';

import { listenOnFixturePort } from './ports.js';

/**
 * Reserves a random free host port in the fixture range (20000-60999, never 4444) and releases it, so adb
 * can bind it. A port taken in between makes `adb forward` fail, and the caller retries.
 * @returns {Promise<number>} Port.
 */
export async function freeFixturePort() {
    const server = net.createServer();
    const port = await listenOnFixturePort(server);
    await new Promise(resolve => server.close(resolve));
    return port;
}

/**
 * Forwards a fresh host port to a device socket, retrying when the port was taken meanwhile.
 * @param {import('./adb.js').Adb} adb Device.
 * @param {string} deviceSpec `tcp:<port>` or `localabstract:<name>`.
 * @returns {Promise<number>} Host port.
 */
export async function forwardToDevice(adb, deviceSpec) {
    let lastError = null;
    for (let attempt = 0; attempt < 5; attempt++) {
        const port = await freeFixturePort();
        try {
            return await adb.forward(port, deviceSpec);
        } catch (error) {
            lastError = error;
        }
    }
    throw lastError;
}

/**
 * Hides the per-install origin label (`http://<label>.localhost:<port>`) in text that reaches logs.
 * @param {string} text URL or message.
 * @returns {string} Redacted text.
 */
export function redactLabel(text) {
    return String(text).replace(/\/\/[A-Za-z0-9-]+\.localhost(?=[:/]|$)/g, '//<label>.localhost');
}

/**
 * Whether a page URL is the app's own origin on the given server port: the WebView loads either
 * `http://127.0.0.1:<port>` or the per-install `http://<label>.localhost:<port>`.
 * @param {string} url Page URL.
 * @param {number} port Server port.
 * @returns {boolean} True for the app origin.
 */
export function isAppPageUrl(url, port) {
    let parsed;
    try {
        parsed = new URL(url);
    } catch {
        return false;
    }
    const loopback = parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost' || parsed.hostname.endsWith('.localhost');
    return parsed.protocol === 'http:' && loopback && Number(parsed.port) === port;
}

async function waitForDevtools(port, { timeoutMs = 30_000, signal } = {}) {
    const deadline = Date.now() + timeoutMs;
    let lastError = null;
    while (Date.now() < deadline) {
        signal?.throwIfAborted();
        try {
            const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(5_000) });
            if (response.ok) {
                return await response.json();
            }
            lastError = new Error(`HTTP ${response.status}`);
        } catch (error) {
            lastError = error;
        }
        await new Promise(resolve => setTimeout(resolve, 500));
    }
    throw new Error(`The WebView DevTools socket did not answer: ${lastError?.message ?? 'no reply'}`);
}

/**
 * Connects Playwright to the WebView of the app process `pid`.
 * @param {object} options Options.
 * @param {import('./adb.js').Adb} options.adb Device.
 * @param {number} options.pid App process id.
 * @param {AbortSignal} [options.signal] Abort signal.
 * @param {number} [options.timeoutMs] How long the DevTools socket may take to answer.
 * @returns {Promise<{browser: import('@playwright/test').Browser, port: number, version: object, close: () => Promise<void>}>}
 */
export async function attachWebView({ adb, pid, signal, timeoutMs = 30_000 }) {
    const port = await forwardToDevice(adb, `localabstract:webview_devtools_remote_${pid}`);
    try {
        const version = await waitForDevtools(port, { timeoutMs, signal });
        // Without noDefaults, Playwright first sends Browser.setDownloadBehavior, and the WebView of API 36 (133)
        // rejects that call, so the connection fails. The steps need none of the defaults that this turns off
        // (downloads, focus emulation and media emulation).
        const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: timeoutMs, noDefaults: true });
        let closed = false;
        return {
            browser,
            port,
            version,
            close: async () => {
                if (closed) {
                    return;
                }
                closed = true;
                // For a CDP connection this only disconnects; the app's WebView keeps running.
                await browser.close().catch(() => {});
                await adb.removeForward(port);
            },
        };
    } catch (error) {
        await adb.removeForward(port);
        throw error;
    }
}

/**
 * Waits for the WebView page that shows the app's own origin.
 * @param {import('@playwright/test').Browser} browser CDP browser.
 * @param {number} serverPort Server port.
 * @param {object} [options] Options.
 * @param {number} [options.timeoutMs] Deadline.
 * @param {AbortSignal} [options.signal] Abort signal.
 * @returns {Promise<import('@playwright/test').Page>} Page.
 */
export async function findAppPage(browser, serverPort, { timeoutMs = 60_000, signal } = {}) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        signal?.throwIfAborted();
        for (const context of browser.contexts()) {
            const page = context.pages().find(candidate => isAppPageUrl(candidate.url(), serverPort));
            if (page) {
                return page;
            }
        }
        await new Promise(resolve => setTimeout(resolve, 500));
    }
    const urls = browser.contexts().flatMap(context => context.pages().map(page => redactLabel(page.url())));
    throw new Error(`No WebView page on the app origin (port ${serverPort}); pages: ${urls.join(', ') || 'none'}`);
}

/**
 * The page target on the app's origin in a DevTools `/json/list` reply, or null.
 * @param {Array<object>} targets Targets.
 * @param {number} serverPort Server port.
 * @returns {object|null} Target.
 */
export function appPageTarget(targets, serverPort) {
    const list = Array.isArray(targets) ? targets : [];
    return list.find(target => target?.type === 'page' && target.webSocketDebuggerUrl && isAppPageUrl(target.url, serverPort)) ?? null;
}

async function waitForAppTarget(port, serverPort, { timeoutMs, signal }) {
    const deadline = Date.now() + timeoutMs;
    let targets = [];
    while (Date.now() < deadline) {
        signal?.throwIfAborted();
        try {
            const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(5_000) });
            targets = response.ok ? await response.json() : [];
        } catch {
            targets = [];
        }
        const target = appPageTarget(targets, serverPort);
        if (target) {
            return target;
        }
        await new Promise(resolve => setTimeout(resolve, 500));
    }
    const urls = (Array.isArray(targets) ? targets : []).map(target => redactLabel(target?.url));
    throw new Error(`No WebView page on the app origin (port ${serverPort}); pages: ${urls.join(', ') || 'none'}`);
}

/**
 * Opens the WebView page on the app's origin through the page's own DevTools socket (`/json/list`, then a
 * WebSocket), for a WebView whose pages Playwright does not list: over CDP, Playwright shows no pages of
 * WebView 74 (API 29).
 * @param {object} options Options.
 * @param {import('./adb.js').Adb} options.adb Device.
 * @param {number} options.pid App process id.
 * @param {number} options.serverPort Server port.
 * @param {AbortSignal} [options.signal] Abort signal.
 * @param {number} [options.timeoutMs] How long the socket and the page may take to show up.
 * @returns {Promise<{page: DevToolsPage, port: number, version: object, close: () => Promise<void>}>}
 */
export async function attachWebViewPage({ adb, pid, serverPort, signal, timeoutMs = 60_000 }) {
    const port = await forwardToDevice(adb, `localabstract:webview_devtools_remote_${pid}`);
    try {
        const version = await waitForDevtools(port, { timeoutMs, signal });
        const target = await waitForAppTarget(port, serverPort, { timeoutMs, signal });
        const page = await DevToolsPage.open(target);
        let closed = false;
        return {
            page,
            port,
            version,
            close: async () => {
                if (closed) {
                    return;
                }
                closed = true;
                page.close();
                await adb.removeForward(port);
            },
        };
    } catch (error) {
        await adb.removeForward(port);
        throw error;
    }
}

/**
 * One WebView page, driven through its DevTools socket with `Runtime.evaluate`. The steps only read from a
 * WebView that needs it, so it has only the Page methods they use there: url, evaluate and waitForFunction.
 */
export class DevToolsPage {
    #socket;
    #url;
    #nextId = 1;
    #pending = new Map();
    #closed = false;
    #timeoutMs = 30_000;

    /**
     * @param {WebSocket} socket Open socket of the page target (`send`, `close`, `addEventListener`).
     * @param {string} url Page URL.
     */
    constructor(socket, url) {
        this.#socket = socket;
        this.#url = url;
        socket.addEventListener('message', event => this.#receive(event.data));
        socket.addEventListener('close', () => this.#end(new Error('The WebView page closed its DevTools socket')));
    }

    /**
     * Connects to a target of a `/json/list` reply.
     * @param {{url: string, webSocketDebuggerUrl: string}} target Target.
     * @returns {Promise<DevToolsPage>} Page.
     */
    static async open(target) {
        const socket = new WebSocket(target.webSocketDebuggerUrl);
        await new Promise((resolve, reject) => {
            socket.addEventListener('open', resolve, { once: true });
            socket.addEventListener('error', () => reject(new Error(`No DevTools socket for ${redactLabel(target.url)}`)), { once: true });
        });
        return new DevToolsPage(socket, target.url);
    }

    url() {
        return this.#url;
    }

    isClosed() {
        return this.#closed;
    }

    setDefaultTimeout(timeoutMs) {
        this.#timeoutMs = timeoutMs;
    }

    /**
     * The awaited value of an expression, or of a function called with a JSON argument, in the page.
     * @param {string|Function} pageFunction Expression or function.
     * @param {*} [arg] Argument.
     * @returns {Promise<*>} Value.
     */
    async evaluate(pageFunction, arg) {
        const expression = typeof pageFunction === 'function' ? `(${pageFunction})(${JSON.stringify(arg) ?? ''})` : String(pageFunction);
        const reply = await this.#send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
        if (reply.exceptionDetails) {
            const details = reply.exceptionDetails;
            throw new Error(`Evaluation failed: ${details.exception?.description ?? details.text}`);
        }
        return reply.result?.value;
    }

    /**
     * Evaluates until the value is truthy, and returns it.
     * @param {string|Function} pageFunction Expression or function.
     * @param {*} [arg] Argument.
     * @param {{timeout?: number, polling?: number}} [options] Deadline and interval in milliseconds.
     * @returns {Promise<*>} Value.
     */
    async waitForFunction(pageFunction, arg, { timeout = this.#timeoutMs, polling = 500 } = {}) {
        const deadline = Date.now() + timeout;
        let lastError = null;
        while (true) {
            try {
                const value = await this.evaluate(pageFunction, arg);
                if (value) {
                    return value;
                }
            } catch (error) {
                // A navigation ends the evaluation; the next poll runs in the new document.
                lastError = error;
            }
            if (this.#closed || Date.now() >= deadline) {
                const why = this.#closed ? 'the page closed' : `timeout ${timeout} ms exceeded`;
                throw new Error(`waitForFunction: ${why}${lastError ? ` (${lastError.message})` : ''}`);
            }
            await new Promise(resolve => setTimeout(resolve, polling));
        }
    }

    close() {
        this.#end(new Error('The DevTools page session is closed'));
        this.#socket.close();
    }

    #send(method, params) {
        if (this.#closed) {
            return Promise.reject(new Error(`${method}: the DevTools page session is closed`));
        }
        const id = this.#nextId++;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.#pending.delete(id);
                reject(new Error(`${method} got no reply within ${this.#timeoutMs} ms`));
            }, this.#timeoutMs);
            this.#pending.set(id, { resolve, reject, timer });
            this.#socket.send(JSON.stringify({ id, method, params }));
        });
    }

    #receive(data) {
        let message;
        try {
            message = JSON.parse(String(data));
        } catch {
            return;
        }
        const pending = this.#pending.get(message?.id);
        if (!pending) {
            return;
        }
        this.#pending.delete(message.id);
        clearTimeout(pending.timer);
        if (message.error) {
            pending.reject(new Error(`${message.error.message} (${message.error.code})`));
        } else {
            pending.resolve(message.result ?? {});
        }
    }

    #end(error) {
        if (this.#closed) {
            return;
        }
        this.#closed = true;
        for (const { reject, timer } of this.#pending.values()) {
            clearTimeout(timer);
            reject(error);
        }
        this.#pending.clear();
    }
}
