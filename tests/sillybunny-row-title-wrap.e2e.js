import { expect, test } from '@playwright/test';
import { fetchJsonOrSkip } from './helpers/route-fetch.js';
import { applyWelcomeSettings } from './helpers/welcome-dialog.js';

// A phone has a coarse pointer, whose info button is the larger one: the title shares its row with a 44px button.
test.use({ serviceWorkers: 'block', contextOptions: { reducedMotion: 'reduce' }, hasTouch: true, isMobile: true });

async function loadApp(page, baseURL, { viewport }) {
    const origin = new URL(baseURL).origin;
    expect(['127.0.0.1', 'localhost', '[::1]']).toContain(new URL(baseURL).hostname);
    let version = Date.now();
    const readEndpoints = new Set([
        '/api/characters/all', '/api/characters/chats', '/api/groups/all', '/api/backgrounds/all',
        '/api/avatars/get', '/api/stats/get', '/api/secrets/read', '/api/users/me',
    ]);
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.route('**/*', async route => {
        const request = route.request();
        const url = new URL(request.url());
        if (url.origin !== origin) return route.abort();
        if (url.pathname === '/api/extensions/discover') {
            const extensions = await fetchJsonOrSkip(route);
            if (!extensions) return;
            return route.fulfill({ json: extensions.filter(extension => !extension.name.startsWith('third-party/')) });
        }
        if (url.pathname === '/api/settings/get') {
            const data = await fetchJsonOrSkip(route);
            if (!data) return;
            const settings = JSON.parse(data.settings);
            settings.firstRun = false;
            applyWelcomeSettings(settings);
            settings.power_user.auto_connect = false;
            data.request_compression = { ...data.request_compression, enabled: false };
            data.settings = JSON.stringify(settings);
            return route.fulfill({ json: data });
        }
        if (readEndpoints.has(url.pathname) || url.pathname.startsWith('/api/tokenizers/')) return route.continue();
        if (url.pathname.startsWith('/api/backends/')) return route.fulfill({ json: { data: [] } });
        if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method())) {
            return route.fulfill({ json: url.pathname === '/api/settings/save' ? { version: ++version } : {} });
        }
        return route.continue();
    });
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.SillyTavern?.getContext?.()?.eventSource?.autoFireLastArgs?.has('app_ready'), null, { timeout: 60000 });
    await page.evaluate(() => document.querySelectorAll('dialog[open]').forEach(dialog => dialog.close()));
}

/** The words of the visible row titles in `scope` that sit on more than one line, as "word (title)". */
const brokenWords = (page, scope) => page.evaluate((scope) => {
    const found = [];
    for (const label of document.querySelectorAll(`${scope} :is(.ds-row-label, .ds-action-row-title)`)) {
        if (!label.getClientRects().length) continue;
        const walker = document.createTreeWalker(label, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
            for (const match of node.textContent.matchAll(/\S+/g)) {
                const range = document.createRange();
                range.setStart(node, match.index);
                range.setEnd(node, match.index + match[0].length);
                if (new Set([...range.getClientRects()].map(rect => Math.round(rect.top))).size > 1) {
                    found.push(`${match[0]} (${label.textContent.trim().slice(0, 40)})`);
                }
            }
        }
    }
    return found;
}, scope);

for (const width of [390, 360, 320]) {
    test.describe(`${width}px`, () => {
        test.beforeEach(async ({ page, baseURL }) => {
            test.setTimeout(120000);
            await loadApp(page, baseURL, { viewport: { width, height: 844 } });
            await page.evaluate(() => window.SillyBunnyShell.openTab('left', 'sampling'));
            await expect(page.locator('#sb-settings-content')).toBeVisible();
            await expect(page.locator('[data-sb-panel="sampling"] [aria-busy="true"]')).toHaveCount(0);
        });

        for (const backend of [{ name: 'Chat Completion', api: 'openai', source: null }, { name: 'Aphrodite', api: 'textgenerationwebui', source: 'aphrodite' }]) {
            test(`Sampling (${backend.name}) with every explanation open wraps its titles at word boundaries`, async ({ page }) => {
                const panel = '[data-sb-panel="sampling"]';
                await page.evaluate(({ api, source }) => {
                    window.$('#main_api').val(api).trigger('change');
                    if (source) window.$('#textgen_type').val(source).trigger('change');
                }, backend);
                await expect(page.locator(`${panel} .ds-row-label:visible`).getByText('Temperature', { exact: true }).first()).toBeVisible();
                await page.evaluate((panel) => {
                    for (const button of document.querySelectorAll(`${panel} .sb-sampling-help-toggle`)) {
                        if (button.getAttribute('aria-expanded') !== 'true') button.click();
                    }
                }, panel);
                await expect(page.locator(`${panel} .sb-sampling-help:not([hidden]):visible`).first()).toBeVisible();
                expect(await brokenWords(page, panel)).toEqual([]);
            });
        }

        test('a word that fits on a line of its own is kept whole, and one that cannot is broken inside its row', async ({ page }) => {
            const result = await page.evaluate(async () => {
                const { createRow } = await import('/scripts/sillybunny-editor/rows.js');
                const group = document.createElement('div');
                group.className = 'ds-pref-group';
                group.id = 'zz-title-wrap';
                const control = width => Object.assign(document.createElement('div'), { style: `width: ${width}px; height: 30px` });
                const whole = createRow({ label: 'Hyperparameterization', field: 'zz-whole', suffix: control(220) }).row;
                const tooLong = createRow({ label: 'Thisisonereallylongwordwithnospacesinitatallthatcannotfitonalineofitsownevenwhentherowiswholeline', field: 'zz-long', suffix: control(60) }).row;
                group.append(whole, tooLong);
                document.querySelector('[data-sb-panel="sampling"] .sb-shell-panel-scroller').prepend(group);
                group.scrollIntoView();
                const boxOf = row => {
                    const label = row.querySelector('.ds-row-label');
                    const range = document.createRange();
                    range.selectNodeContents(label);
                    const rects = [...range.getClientRects()];
                    return {
                        lines: new Set(rects.map(rect => Math.round(rect.top))).size,
                        labelRight: Math.max(...rects.map(rect => rect.right)),
                        rowRight: row.getBoundingClientRect().right,
                        overflow: row.scrollWidth - row.clientWidth,
                    };
                };
                return { whole: boxOf(whole), tooLong: boxOf(tooLong) };
            });
            expect(result.whole.lines, 'a word that fits on its own line is not broken').toBe(1);
            expect(result.whole.overflow).toBeLessThanOrEqual(1);
            expect(result.tooLong.lines, 'a word wider than the row is broken').toBeGreaterThan(1);
            expect(result.tooLong.labelRight, 'and stays inside its row').toBeLessThanOrEqual(result.tooLong.rowRight);
            expect(result.tooLong.overflow).toBeLessThanOrEqual(1);
        });
    });
}
