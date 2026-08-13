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
                    eventSource: { on() {}, removeListener() {} },
                    eventTypes: { APP_READY: 'app-ready' },
                    translate(text) { return text === 'Chat Archive' ? label : text; },
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
