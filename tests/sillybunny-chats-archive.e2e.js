/* global getComputedStyle */
import { expect, test } from '@playwright/test';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const extensionRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    'public',
    'scripts',
    'extensions',
    'sillybunny-chats-archive',
);
const publicRoot = path.resolve(extensionRoot, '..', '..', '..');

let baseUrl;
let server;

const ARCHIVE_CURSOR = 'a'.repeat(64);
const ORPHAN_CURSOR = 'b'.repeat(64);
const FIRST_READ_TOKEN = 'c'.repeat(64);
const SECOND_READ_TOKEN = 'd'.repeat(64);
const FIRST_ORPHAN_HASH = 'e'.repeat(64);
const SECOND_ORPHAN_HASH = 'f'.repeat(64);

test.describe.configure({ mode: 'serial' });
test.use({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
});

test.beforeAll(async () => {
    server = http.createServer(async (request, response) => {
        try {
            const url = new URL(request.url, 'http://127.0.0.1');
            if (url.pathname === '/') {
                response.setHeader('Content-Type', 'text/html; charset=utf-8');
                response.end(fixtureHtml(url.searchParams.has('long')));
                return;
            }
            const asset = url.pathname.startsWith('/extension/')
                ? { root: extensionRoot, relativePath: url.pathname.slice('/extension/'.length) }
                : url.pathname.startsWith('/public/')
                    ? { root: publicRoot, relativePath: url.pathname.slice('/public/'.length) }
                    : null;
            if (!asset) {
                response.statusCode = 404;
                response.end();
                return;
            }

            const filePath = path.resolve(asset.root, asset.relativePath);
            if (path.relative(asset.root, filePath).startsWith('..')) {
                response.statusCode = 403;
                response.end();
                return;
            }
            response.setHeader('Content-Type', path.extname(filePath) === '.css'
                ? 'text/css; charset=utf-8'
                : 'text/javascript; charset=utf-8');
            response.end(await fs.readFile(filePath));
        } catch {
            response.statusCode = 500;
            response.end();
        }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.afterAll(async () => {
    if (server) {
        await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
});

test('shows a resilient label with at least a 44px mobile touch target', async ({ page }) => {
    await page.goto(`${baseUrl}/?long`);
    await expect(page.locator('html')).toHaveAttribute('data-archive-ready', 'true');

    const control = await page.locator('#sbca_drawer_button').evaluate(button => {
        const label = button.querySelector('.sbca-drawer-button-label');
        const buttonStyle = getComputedStyle(button);
        const labelStyle = getComputedStyle(label);
        const buttonRect = button.getBoundingClientRect();
        const labelRect = label.getBoundingClientRect();
        return {
            ariaLabel: button.getAttribute('aria-label'),
            buttonHeight: buttonRect.height,
            buttonWidth: buttonRect.width,
            buttonFits: button.scrollWidth <= button.clientWidth && button.scrollHeight <= button.clientHeight,
            buttonVisibility: buttonStyle.visibility,
            labelDisplay: labelStyle.display,
            labelHeight: labelRect.height,
            labelText: label.textContent,
            labelWidth: labelRect.width,
            labelFits: label.scrollWidth <= label.clientWidth,
        };
    });

    expect(control.labelText).toBe('Chat Archive Chat Archive Chat Archive Chat Archive');
    expect(control.ariaLabel).toBe(control.labelText);
    expect(control.buttonVisibility).toBe('visible');
    expect(control.labelDisplay).not.toBe('none');
    expect(control.buttonHeight).toBeGreaterThanOrEqual(44);
    expect(control.buttonWidth).toBeGreaterThan(control.buttonHeight);
    expect(control.labelWidth).toBeGreaterThan(0);
    expect(control.labelHeight).toBeGreaterThan(0);
    expect(control.buttonFits).toBe(true);
    expect(control.labelFits).toBe(true);
});

test('renders the first archive page and progress before the next page resolves', async ({ page }) => {
    let inventoryRequests = 0;
    let releaseSecondPage;
    let markSecondPageStarted;
    const secondPageStarted = new Promise(resolve => { markSecondPageStarted = resolve; });
    const secondPageGate = new Promise(resolve => { releaseSecondPage = resolve; });
    await routeOrganization(page);
    await page.route('**/api/chats/archive/inventory', async route => {
        inventoryRequests++;
        if (inventoryRequests === 1) {
            await fulfillJson(route, archivePage([linkedRow('first')], ARCHIVE_CURSOR, null, 2));
            return;
        }
        markSecondPageStarted();
        await secondPageGate;
        await fulfillJson(route, archivePage([linkedRow('second')], null, null, 2));
    });

    await openArchive(page);
    await secondPageStarted;

    await expect(page.locator('.sbca-filename')).toHaveText(['first']);
    await expect(page.locator('.sbca-status')).toContainText('1 of 2 indexed chat files');
    await expect(page.getByRole('button', { name: 'Cancel' })).toBeEnabled();
    await expect(page.getByText('second', { exact: true })).toHaveCount(0);

    releaseSecondPage();
    await expect(page.locator('.sbca-filename')).toHaveText(['first', 'second']);
    await expect(page.locator('.sbca-status')).toContainText('2 indexed chat files');
    await expect(page.getByRole('button', { name: 'Refresh' })).toBeEnabled();
    await page.getByRole('searchbox', { name: 'Filter indexed chats' }).fill('second');
    await expect(page.locator('.sbca-filename')).toHaveText(['second']);
});

test('cancels an incremental archive load, releases its cursor, and ignores the late page', async ({ page }) => {
    const releases = [];
    let inventoryRequests = 0;
    let releaseLatePage;
    let markLatePageStarted;
    const latePageStarted = new Promise(resolve => { markLatePageStarted = resolve; });
    const latePageGate = new Promise(resolve => { releaseLatePage = resolve; });
    await routeOrganization(page);
    await page.route('**/api/chats/archive/release', async route => {
        releases.push(route.request().postDataJSON());
        await route.fulfill({ status: 204 });
    });
    await page.route('**/api/chats/archive/inventory', async route => {
        inventoryRequests++;
        if (inventoryRequests === 1) {
            await fulfillJson(route, archivePage([linkedRow('kept')], ARCHIVE_CURSOR, null, 2));
            return;
        }
        markLatePageStarted();
        await latePageGate;
        await fulfillJson(route, archivePage([linkedRow('late')], null, null, 2));
    });

    await openArchive(page);
    await latePageStarted;
    await expect(page.locator('.sbca-filename')).toHaveText(['kept']);
    await page.getByRole('button', { name: 'Cancel' }).click();
    await expect.poll(() => releases).toContainEqual({ cursor: ARCHIVE_CURSOR });
    releaseLatePage();

    await expect(page.locator('.sbca-filename')).toHaveText(['kept']);
    await expect(page.getByText('late', { exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Refresh' })).toBeEnabled();
});

test('stops an orphan scan, releases its token and cursor, and rolls back partial rows', async ({ page }) => {
    const releases = [];
    let orphanRequests = 0;
    let releaseLatePage;
    let markLatePageStarted;
    const latePageStarted = new Promise(resolve => { markLatePageStarted = resolve; });
    const latePageGate = new Promise(resolve => { releaseLatePage = resolve; });
    await routeOrganization(page);
    await page.route('**/api/chats/archive/release', async route => {
        releases.push(route.request().postDataJSON());
        await route.fulfill({ status: 204 });
    });
    await page.route('**/api/chats/archive/inventory', async route => {
        const body = route.request().postDataJSON();
        if (body.scope === 'archive') {
            await fulfillJson(route, archivePage([linkedRow('linked')], null, null, 1));
            return;
        }
        orphanRequests++;
        if (orphanRequests === 1) {
            await fulfillJson(route, archivePage(
                [orphanRow('partial-orphan', FIRST_ORPHAN_HASH)],
                ORPHAN_CURSOR,
                FIRST_READ_TOKEN,
                2,
            ));
            return;
        }
        markLatePageStarted();
        await latePageGate;
        await fulfillJson(route, archivePage(
            [orphanRow('late-orphan', SECOND_ORPHAN_HASH)],
            null,
            FIRST_READ_TOKEN,
            2,
        ));
    });

    await openArchive(page);
    await expect(page.getByRole('button', { name: 'Find orphaned files' })).toBeEnabled();
    await page.getByRole('button', { name: 'Find orphaned files' }).click();
    await latePageStarted;
    await expect(page.getByText('partial-orphan', { exact: true })).toBeVisible();
    await expect(page.locator('.sbca-status')).toContainText('1 of 2 indexed chat files');
    await page.getByRole('button', { name: 'Stop scan' }).click();
    await expect.poll(() => releases).toContainEqual({ token: FIRST_READ_TOKEN, cursor: ORPHAN_CURSOR });
    releaseLatePage();

    await expect(page.getByText('partial-orphan', { exact: true })).toHaveCount(0);
    await expect(page.getByText('late-orphan', { exact: true })).toHaveCount(0);
    await expect(page.getByText('linked', { exact: true })).toBeVisible();
    await expect(page.locator('.sbca-status')).toContainText('Scan stopped.');
});

test('replaces orphan scan tokens and views the active orphan through the archive namespace', async ({ page }) => {
    const releases = [];
    const viewedUrls = [];
    const dataMaidRequests = [];
    let orphanScans = 0;
    page.on('request', request => {
        if (new URL(request.url()).pathname.startsWith('/api/data-maid')) {
            dataMaidRequests.push(request.url());
        }
    });
    await routeOrganization(page);
    await page.route('**/api/chats/archive/release', async route => {
        releases.push(route.request().postDataJSON());
        await route.fulfill({ status: 204 });
    });
    await page.route('**/api/chats/archive/view?**', async route => {
        viewedUrls.push(route.request().url());
        await route.fulfill({
            status: 200,
            contentType: 'application/x-ndjson',
            body: [
                JSON.stringify({ chat_metadata: { source: 'archive' } }),
                JSON.stringify({ name: 'Archive', mes: 'orphan body' }),
            ].join('\n'),
        });
    });
    await page.route('**/api/chats/archive/inventory', async route => {
        const body = route.request().postDataJSON();
        if (body.scope === 'archive') {
            await fulfillJson(route, archivePage([linkedRow('linked')], null, null, 1));
            return;
        }
        orphanScans++;
        const replacement = orphanScans === 2;
        await fulfillJson(route, archivePage([
            orphanRow(replacement ? 'current-orphan' : 'old-orphan', replacement ? SECOND_ORPHAN_HASH : FIRST_ORPHAN_HASH),
        ], null, replacement ? SECOND_READ_TOKEN : FIRST_READ_TOKEN, 1));
    });

    await openArchive(page);
    await page.getByRole('button', { name: 'Find orphaned files' }).click();
    await expect(page.getByText('old-orphan', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Rescan orphaned files' }).click();
    await expect(page.getByText('current-orphan', { exact: true })).toBeVisible();
    await expect(page.getByText('old-orphan', { exact: true })).toHaveCount(0);
    await expect.poll(() => releases).toContainEqual({ token: FIRST_READ_TOKEN });

    await page.getByText('current-orphan', { exact: true }).click();
    await expect(page.locator('.sbca-viewer-content')).toContainText('orphan body');
    expect(viewedUrls).toHaveLength(1);
    const viewed = new URL(viewedUrls[0]);
    expect(viewed.pathname).toBe('/api/chats/archive/view');
    expect(viewed.searchParams.get('token')).toBe(SECOND_READ_TOKEN);
    expect(viewed.searchParams.get('hash')).toBe(SECOND_ORPHAN_HASH);
    expect(dataMaidRequests).toEqual([]);
});

async function routeOrganization(page) {
    await page.route('**/user/files/_sbca_organization.json', route => route.fulfill({ status: 404 }));
}

async function openArchive(page) {
    await page.goto(baseUrl);
    await expect(page.locator('html')).toHaveAttribute('data-archive-ready', 'true');
    await page.locator('#sbca_drawer_button').click();
    await expect(page.locator('.sbca-root')).toBeVisible();
}

function archivePage(rows, cursor, readToken, total) {
    return { rows, cursor, read_token: readToken, errors: 0, total };
}

function linkedRow(name) {
    return {
        _source: 'archive-inventory',
        avatar: 'Alice.png',
        file_name: `${name}.jsonl`,
        file_size: '1 KB',
        chat_items: 1,
        last_mes: 1_000,
        mes: `${name} preview`,
    };
}

function orphanRow(name, hash) {
    return {
        _source: 'archive-orphan',
        archive_hash: hash,
        chatFolder: 'Deleted',
        file_name: `${name}.jsonl`,
        file_size: '1 KB',
        chat_items: 1,
        last_mes: 1_000,
        mes: `${name} preview`,
        orphan_type: 'missing-character',
    };
}

function fulfillJson(route, value) {
    return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(value),
    });
}

function fixtureHtml(useLongLabel) {
    const translatedLabel = useLongLabel
        ? 'Chat Archive Chat Archive Chat Archive Chat Archive'
        : 'Chat Archive';
    return `<!doctype html>
<html>
<head>
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <link rel="stylesheet" href="/public/style.css">
    <link rel="stylesheet" href="/public/css/mobile-styles.css" media="(max-width: 768px)">
    <link rel="stylesheet" href="/public/css/sillybunny-tabs.css">
    <link rel="stylesheet" href="/public/css/sillybunny-mobile-shell.css" media="(max-width: 768px)">
    <link rel="stylesheet" href="/extension/style.css">
    <style>
        :root { --mainFontFamily: sans-serif; --sb-mobile-touch-target: 44px; }
        body { margin: 0; }
        .menu_button { border: 1px solid currentColor; background: transparent; color: inherit; font: inherit; }
        .sb-character-create-bar { display: flex; width: 100%; overflow-x: auto; }
    </style>
</head>
<body>
    <div id="right-nav-panel" class="openDrawer">
        <div id="charListFixedTop">
            <div class="sb-character-create-bar">
                <div id="rm_button_bar">
                    <div id="rm_buttons_container"></div>
                </div>
            </div>
        </div>
    </div>
    <script type="module">
        const label = ${JSON.stringify(translatedLabel)};
        globalThis.SillyTavern = {
            getContext() {
                return {
                    characters: [{ avatar: 'Alice.png', name: 'Alice' }],
                    groups: [],
                    eventSource: { on() {}, removeListener() {} },
                    eventTypes: { APP_READY: 'app-ready' },
                    getRequestHeaders() { return { 'Content-Type': 'application/json' }; },
                    getThumbnailUrl(_type, avatar) { return '/avatar/' + encodeURIComponent(avatar); },
                    timestampToMoment(value) {
                        const date = new Date(value);
                        return {
                            isValid() { return !Number.isNaN(date.valueOf()); },
                            valueOf() { return date.valueOf(); },
                            format() { return date.toISOString(); },
                        };
                    },
                    translate(text) { return text === 'Chat Archive' ? label : text; },
                    Popup: class {
                        constructor(content) {
                            this.dlg = document.createElement('dialog');
                            this.dlg.setAttribute('open', '');
                            this.dlg.tabIndex = -1;
                            this.okButton = document.createElement('button');
                            this.okButton.type = 'button';
                            this.okButton.className = 'popup-close';
                            this.okButton.textContent = 'Close';
                            this.dlg.append(content, this.okButton);
                            this.shown = new Promise(resolve => { this.resolve = resolve; });
                            this.okButton.addEventListener('click', () => this.completeCancelled());
                        }
                        show() {
                            document.body.append(this.dlg);
                            return this.shown;
                        }
                        async completeCancelled() {
                            if (this.dlg.isConnected) {
                                this.dlg.remove();
                                this.resolve();
                            }
                        }
                    },
                    POPUP_TYPE: { TEXT: 'text' },
                };
            },
        };
        const { activate } = await import('/extension/index.js');
        await activate();
        document.documentElement.dataset.archiveReady = 'true';
    </script>
</body>
</html>`;
}
