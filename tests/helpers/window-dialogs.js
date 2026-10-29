import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { expect } from '@playwright/test';
import { bootMiscDialogs, MISC_VIEWPORTS } from './misc-dialogs.js';

export const WINDOW_VIEWPORTS = MISC_VIEWPORTS;
export const SECRET_SENTINEL = 'window-dialog-secret-sentinel-741';
export const ATTACHMENT_COUNT = 28;
export const SECRET_COUNT = 24;
export const ATTACHMENT_TEXT = 'Original attachment body\n'.repeat(40);

function readJsonRequest(request) {
    const body = request.postDataBuffer();
    if (!body) return {};
    return JSON.parse((request.headers()['content-encoding'] === 'gzip' ? gunzipSync(body) : body).toString());
}

function fixtureRegexScripts() {
    return Array.from({ length: 12 }, (_, index) => ({
        id: `window-regex-${index}`,
        scriptName: `Window rule ${String(index + 1).padStart(2, '0')}`,
        findRegex: index === 0 ? '/alpha/g' : index === 1 ? '/beta/g' : '/never-matched/g',
        replaceString: index === 0 ? 'beta' : 'gamma',
        trimStrings: [],
        placement: [1, 2],
        disabled: false,
        markdownOnly: false,
        promptOnly: false,
        runOnEdit: false,
        substituteRegex: 0,
        minDepth: null,
        maxDepth: null,
    }));
}

export async function bootWindowDialogs(page, viewport) {
    const state = { uploads: [], deletes: [], secrets: [], console: [], consoleArguments: [], pageErrors: [] };
    const files = new Map(Array.from({ length: ATTACHMENT_COUNT }, (_, index) => [`/fixtures/window-${index}.txt`, ATTACHMENT_TEXT]));
    let secretItems = Array.from({ length: SECRET_COUNT }, (_, index) => ({
        id: `window-secret-${index}`,
        value: 'sk-...masked',
        label: `Window key ${String(index + 1).padStart(2, '0')}`,
        active: index === 0,
    }));

    page.on('console', message => {
        state.console.push(message.text());
        state.consoleArguments.push(Promise.all(message.args().map(argument => argument.jsonValue().catch(() => null))));
    });
    page.on('pageerror', error => state.pageErrors.push(error.message));
    // Observe all text/attribute mutations, not just the final DOM, so transient mirroring fails too.
    await page.addInitScript(sentinel => {
        window.__windowSecretLeaks = [];
        const inspect = node => {
            const serialized = node instanceof Element ? node.outerHTML : node.textContent;
            if (serialized?.includes(sentinel)) window.__windowSecretLeaks.push(node.nodeName);
        };
        new MutationObserver(records => {
            for (const record of records) {
                inspect(record.target);
                record.addedNodes.forEach(inspect);
            }
        }).observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
    }, SECRET_SENTINEL);

    // Block every file/secret route at context scope, including teardown and unexpected endpoints.
    await page.context().route(/\/api\/(?:files|secrets)\//, route => route.fulfill({ status: 400, body: 'Blocked by Window dialog test' }));
    const interceptSecret = route => {
        const endpoint = new URL(route.request().url()).pathname.split('/').at(-1);
        if (endpoint === 'read') return route.fulfill({ json: { api_key_openai: secretItems } });
        if (endpoint === 'settings') return route.fulfill({ json: { allowKeysExposure: true } });
        if (endpoint === 'find') {
            state.secrets.push({ endpoint, ...readJsonRequest(route.request()) });
            return route.fulfill({ json: { value: SECRET_SENTINEL } });
        }
        if (!['write', 'rename', 'rotate', 'delete'].includes(endpoint)) {
            return route.fulfill({ status: 400, body: 'Unexpected secret endpoint' });
        }
        const request = readJsonRequest(route.request());
        state.secrets.push({ endpoint, ...request });
        if (endpoint === 'write') {
            secretItems.push({ id: 'window-secret-added', value: 'sk-...masked', label: request.label, active: false });
            return route.fulfill({ json: { id: 'window-secret-added' } });
        }
        if (endpoint === 'rename') secretItems.find(item => item.id === request.id).label = request.label;
        if (endpoint === 'rotate') secretItems.forEach(item => { item.active = item.id === request.id; });
        if (endpoint === 'delete') secretItems = secretItems.filter(item => item.id !== request.id);
        return route.fulfill({ status: 204 });
    };
    await page.route('**/api/secrets/**', interceptSecret);
    await page.route('**/api/files/verify', route => {
        const { urls } = readJsonRequest(route.request());
        return route.fulfill({ json: Object.fromEntries(urls.map(url => [url, files.has(url)])) });
    });
    await page.route('**/api/files/upload', route => {
        const upload = readJsonRequest(route.request());
        const path = `/fixtures/window-upload-${state.uploads.length}.txt`;
        state.uploads.push({ ...upload, path });
        files.set(path, Buffer.from(upload.data, 'base64').toString());
        return route.fulfill({ json: { path } });
    });
    await page.route('**/api/files/delete', route => {
        const request = readJsonRequest(route.request());
        state.deletes.push(request);
        files.delete(request.path);
        return route.fulfill({ json: {} });
    });
    await page.route('**/fixtures/window-*.txt', route => {
        const path = new URL(route.request().url()).pathname;
        if (!files.has(path)) return route.fulfill({ status: 404, body: 'Unknown fixture file' });
        return route.fulfill({ contentType: 'text/plain', body: files.get(path) });
    });

    const misc = await bootMiscDialogs(page, viewport, {
        configureSettings(settings) {
            settings.extension_settings.attachments = [...files.keys()].map((url, index) => ({
                url,
                name: `Window attachment ${String(index + 1).padStart(2, '0')}.txt`,
                size: ATTACHMENT_TEXT.length,
                created: 1700000000000 + index,
            }));
            settings.extension_settings.disabled_attachments = [];
            settings.extension_settings.character_attachments = {};
            settings.extension_settings.regex = fixtureRegexScripts();
            settings.extension_settings.regex_presets = [];
            settings.extension_settings.disabledExtensions = settings.extension_settings.disabledExtensions.filter(name => !['regex', 'attachments'].includes(name));
            settings.oai_settings.chat_completion_source = 'openai';
        },
    });
    // The common safety helper registers exact write routes; override them with this fixture.
    for (const endpoint of ['write', 'rename', 'rotate', 'delete']) {
        await page.route(`**/api/secrets/${endpoint}`, interceptSecret);
    }
    await page.evaluate(async () => {
        const { accountStorage } = await import('/scripts/util/AccountStorage.js');
        accountStorage.setItem('DataBank_sortField', 'name');
        accountStorage.setItem('DataBank_sortOrder', 'asc');
    });
    return { ...state, settings: misc.settings };
}

export async function currentPopup(page, marker) {
    const candidate = page.locator('dialog.popup[open]').last();
    await candidate.locator(marker).waitFor();
    const popup = page.locator(`dialog.popup[data-id="${await candidate.getAttribute('data-id')}"]`);
    await expect(popup).not.toHaveAttribute('opening');
    return popup;
}

export async function openDataBank(page) {
    await page.locator('#manageAttachments').dispatchEvent('click');
    return currentPopup(page, '.dataBankAttachments');
}

export async function openRegex(page, mode) {
    await page.evaluate(async () => window.SillyBunnyShell.openTab('right', 'extensions'));
    const row = page.locator('[data-sb-subpage-row="regex_container"]');
    await row.waitFor();
    const section = page.locator('#regex_container');
    if (!(await section.isVisible())) {
        await row.click();
        await section.waitFor({ state: 'visible' });
    }
    // Activate the production opener, including its production template, listeners and save path.
    await page.locator(mode === 'editor' ? '#open_regex_editor' : '#open_regex_debugger').dispatchEvent('click');
    return currentPopup(page, mode === 'editor' ? '.regex_editor' : '.regex-debugger-container');
}

export async function openApiKeyManager(page) {
    await page.locator('.manage-api-keys[data-key="api_key_openai"]').first().dispatchEvent('click');
    return currentPopup(page, '.secretKeyManager');
}

export async function expectWindow(popup, viewport) {
    await expect(popup).toHaveClass(/sb-dialog--window/);
    await expect(popup).not.toHaveClass(/sb-dialog--page/);
    await expect(popup).toHaveAttribute('data-presentation', viewport.presentation);
    expect(await popup.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
}

export async function expectPushedPage(child, parent) {
    await expect(child).toHaveClass(/sb-dialog--page/);
    await expect(child).toHaveAttribute('data-presentation', 'floating');
    await expect(parent).toHaveAttribute('data-sb-covered', '');
    await expect(parent).toHaveJSProperty('inert', true);
}

export async function expectParentRestored(page, child, parent) {
    await expect(child).toHaveCount(0);
    await expect(parent).toBeVisible();
    await expect(parent).not.toHaveAttribute('data-sb-covered');
    await expect(parent).toHaveJSProperty('inert', false);
    await expect(page.locator('dialog.popup[open]')).toHaveCount(1);
}

export async function expectInsideBody(control, popup) {
    await expect(control).toBeInViewport();
    const body = await popup.locator('.popup-content').boundingBox();
    const bounds = await control.boundingBox();
    expect(bounds.x).toBeGreaterThanOrEqual(body.x - 1);
    expect(bounds.y).toBeGreaterThanOrEqual(body.y - 1);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(body.x + body.width + 1);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(body.y + body.height + 1);
}

export async function expectDebuggerScrollers(popup, { expanded = false } = {}) {
    await expect(popup.locator('.popup-content')).toHaveCSS('overflow-y', /auto|scroll/);
    expect(await popup.evaluate(node => [node, node.querySelector('.popup-body')]
        .every(element => !/^(auto|scroll)$/.test(getComputedStyle(element).overflowY)))).toBe(true);
    const nested = await popup.locator('.popup-content *').evaluateAll(elements => elements
        .filter(element => element.getClientRects().length && !element.matches('textarea, input, select'))
        .filter(element => /^(auto|scroll)$/.test(getComputedStyle(element).overflowY))
        .map(element => element.id || element.className));
    expect(nested.sort()).toEqual(expanded ? [] : ['regex_debugger_final_output', 'regex_debugger_steps_output']);
}

export async function expectNoSecretLeaks(page, state) {
    expect(await page.evaluate(() => window.__windowSecretLeaks)).toEqual([]);
    expect(await page.locator('html').evaluate((node, sentinel) => node.outerHTML.includes(sentinel), SECRET_SENTINEL)).toBe(false);
    expect(state.console.join('\n')).not.toContain(SECRET_SENTINEL);
    expect(state.pageErrors.join('\n')).not.toContain(SECRET_SENTINEL);
    expect(JSON.stringify(await Promise.all(state.consoleArguments))).not.toContain(SECRET_SENTINEL);
}

export async function captureWindowSurface(page, viewport, surface) {
    const directory = process.env.PHASE4_SCREENSHOTS;
    if (!directory) return;
    await mkdir(directory, { recursive: true });
    await page.screenshot({ path: join(directory, `${surface}-${viewport.width}x${viewport.height}.png`), animations: 'disabled' });
}
