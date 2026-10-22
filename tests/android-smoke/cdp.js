/**
 * Attaches Playwright to the app's WebView over the Chrome DevTools Protocol (plan §7.1 "Driving the app"):
 * `adb forward tcp:<free port> localabstract:webview_devtools_remote_<pid>`, then
 * `chromium.connectOverCDP`. Debug builds enable WebView debugging (WebShellPlatform), so the socket exists
 * while the app process has a WebView. The host port is a random free port in the fixture range.
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
        const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: timeoutMs });
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
