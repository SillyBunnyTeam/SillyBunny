import { gunzipSync } from 'node:zlib';
import { appendFileSync } from 'node:fs';
import { test } from '@playwright/test';

function auditSettings(titlePath, event) {
    if (!process.env.SILLYBUNNY_SETTINGS_AUDIT) return;
    appendFileSync(process.env.SILLYBUNNY_SETTINGS_AUDIT, `${JSON.stringify({ test: titlePath, ...event })}\n`);
}

function readPayload(request) {
    const buffer = request.headers()['content-encoding'] === 'gzip'
        ? gunzipSync(request.postDataBuffer()) : request.postDataBuffer();
    return JSON.parse(buffer.toString());
}

/** Shows toasts again for a test that asserts on them (the safety defaults hide them). */
export async function showToasts(page) {
    await page.evaluate(() => document.documentElement.setAttribute('data-qa-show-toasts', ''));
}

/** Installs browser-QA safety defaults; a test may override a route with its in-memory fixture. */
export async function protectMaintainerServer(page) {
    const titlePath = test.info().titlePath;
    // Context fallback also protects popups and requests made while a page's routes are being removed.
    await page.context().route('**/api/settings/save', route => {
        auditSettings(titlePath, { kind: 'context-stub', method: route.request().method() });
        const payload = readPayload(route.request());
        return route.fulfill({ json: { result: 'ok', version: payload._version + 1 } });
    });
    page.on('response', async response => {
        if (new URL(response.url()).pathname !== '/api/settings/save') return;
        const server = await response.serverAddr().catch(() => null);
        auditSettings(titlePath, { kind: 'settings-response', server, status: response.status() });
    });
    await page.route('**/api/settings/save', route => {
        const payload = readPayload(route.request());
        return route.fulfill({ json: { result: 'ok', version: payload._version + 1 } });
    });
    await page.route(/\/api\/chats\/(?:group\/)?get$/, async route => {
        const request = route.request();
        const payload = readPayload(request);
        if (!payload.allow_create) return route.continue();
        const headers = { ...request.headers() };
        delete headers['content-encoding'];
        delete headers['content-length'];
        // A chat read with allow_create can write a new file; only probe without creation.
        const response = await route.fetch({ headers, postData: { ...payload, allow_create: false } });
        return response.status() === 404 ? route.fulfill({ json: [] }) : route.fulfill({ response });
    });
    await page.route(/\/api\/chats\/(?:group\/)?(?:save|delete|rename)$/, route => route.fulfill({ json: {} }));
    await page.route(/\/api\/stats\/(?:update|recreate)$/, route => route.fulfill({ json: {} }));
    await page.route(/\/api\/(?:characters|groups)\/(?:edit[^/]*|save[^/]*|merge-attributes)$/, route => route.fulfill({ body: 'ok' }));
    await page.route(/\/api\/(?:characters|groups)\/(?:create|delete|rename|duplicate)$/, route => route.abort());
    await page.addInitScript(() => {
        document.addEventListener('DOMContentLoaded', () => {
            const style = document.createElement('style');
            style.textContent = 'html:not([data-qa-show-toasts]) #toast-container { display: none !important; }';
            document.head.append(style);
        }, { once: true });
    });
}
