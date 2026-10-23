import { expect, test } from '@playwright/test';

test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, serviceWorkers: 'block', contextOptions: { reducedMotion: 'reduce' } });
test.setTimeout(90000);

// Bowser reads an Android user agent without the Mobile token as a tablet, which makes the app's isMobile() true.
const GALAXY_TAB_USER_AGENT = 'Mozilla/5.0 (Linux; Android 14; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

const READ_ONLY_POSTS = new Set([
    '/api/characters/all', '/api/characters/chats', '/api/groups/all', '/api/backgrounds/all',
    '/api/avatars/get', '/api/stats/get', '/api/users/me',
]);

async function openQuantizations(page, baseURL, kind = 'chat') {
    const origin = new URL(baseURL).origin;
    expect(['127.0.0.1', 'localhost', '[::1]']).toContain(new URL(baseURL).hostname);
    let version = 1000000000000000;
    await page.route('**/*', async route => {
        const request = route.request();
        const url = new URL(request.url());
        if (url.origin !== origin) return route.abort();
        if (url.pathname === '/api/settings/get') {
            const response = await route.fetch();
            const data = await response.json();
            const settings = JSON.parse(data.settings);
            settings.firstRun = false;
            settings._version = version;
            settings.main_api = kind === 'chat' ? 'openai' : 'textgenerationwebui';
            settings.oai_settings = { ...settings.oai_settings, chat_completion_source: 'openrouter', openrouter_quantizations: ['fp16'] };
            settings.textgenerationwebui_settings = { ...settings.textgenerationwebui_settings, type: 'openrouter', openrouter_quantizations: ['fp16'] };
            settings.extension_settings ??= {};
            settings.extension_settings['quick-image-gen'] = { setupWizardSeen: true };
            data.request_compression = { ...data.request_compression, enabled: false };
            data.settings = JSON.stringify(settings);
            return route.fulfill({ response, json: data });
        }
        if (url.pathname === '/api/extensions/discover') {
            const response = await route.fetch();
            return route.fulfill({ json: (await response.json()).filter(extension => !extension.name.startsWith('third-party/')) });
        }
        if (url.pathname === '/api/settings/save') return route.fulfill({ json: { result: 'ok', version: ++version } });
        if (url.pathname === '/api/secrets/read') return route.fulfill({ json: {} });
        if (url.pathname.startsWith('/api/openrouter/') || url.pathname.startsWith('/api/nanogpt/')) return route.fulfill({ json: [] });
        if (url.pathname.startsWith('/api/backends/')) return route.fulfill({ json: { data: [] } });
        if (READ_ONLY_POSTS.has(url.pathname) || url.pathname.startsWith('/api/tokenizers/')) return route.continue();
        if (url.pathname.startsWith('/api/')) return route.fulfill({ json: {} });
        if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method())) return route.fulfill({ json: {} });
        return route.continue();
    });
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.SillyTavern?.getContext?.()?.eventSource?.autoFireLastArgs?.has('app_ready'), null, { timeout: 60000 });
    await page.evaluate(() => window.SillyBunnyShell.openTab('left', 'api'));
    const select = page.locator(`#openrouter_quantizations_${kind}`);
    const trigger = page.locator(`[data-sb-editor-field="openrouter_quantizations_${kind}"] .ds-select-row__trigger`);
    await expect(select).toHaveAttribute('aria-hidden', 'true');
    await expect(select).toHaveAttribute('tabindex', '-1');
    await expect(trigger).toBeVisible();
    await trigger.scrollIntoViewIfNeeded();
    return { select, trigger, menu: page.locator('.sb-picker-sheet, .sb-picker') };
}

async function settleScroll(select) {
    await select.evaluate(element => new Promise(resolve => {
        const scroller = element.closest('.sb-shell-panel-scroller');
        let last = scroller.scrollTop;
        let stableFrames = 0;
        const check = () => {
            stableFrames = scroller.scrollTop === last ? stableFrames + 1 : 0;
            last = scroller.scrollTop;
            if (stableFrames >= 6) resolve();
            else requestAnimationFrame(check);
        };
        requestAnimationFrame(check);
    }));
}

async function recordPointerTypes(select) {
    await select.evaluate(element => {
        window.__sbPointerTypes = [];
        element.addEventListener('pointerdown', event => window.__sbPointerTypes.push(event.pointerType));
    });
}

async function attachScreenshot(page, testInfo, name) {
    const screenshotPath = testInfo.outputPath(`${name}.png`);
    await page.screenshot({ path: screenshotPath });
    await testInfo.attach(name, { path: screenshotPath, contentType: 'image/png' });
}

for (const kind of ['chat', 'text']) {
    test(`${kind} quantizations ignore a touch scroll and still accept an intentional tap`, async ({ page, baseURL, browserName }, testInfo) => {
        // eslint-disable-next-line playwright/no-skipped-test -- CDP has no equivalent on the other browser engines.
        test.skip(browserName !== 'chromium', 'CDP touch gesture requires Chromium');
        const { select, trigger, menu } = await openQuantizations(page, baseURL, kind);
        await expect(select).toHaveValues(['fp16']);
        await trigger.tap();
        await expect(menu).toBeVisible();
        await expect(select).toHaveValues(['fp16']);
        await menu.getByRole('button', { name: 'Close', exact: true }).tap();
        await expect(menu).toBeHidden();
        await settleScroll(trigger);
        const geometry = await trigger.evaluate(element => {
            const scroller = element.closest('.sb-shell-panel-scroller');
            const box = element.getBoundingClientRect();
            const panel = scroller.getBoundingClientRect();
            return { box: box.toJSON(), panel: panel.toJSON(), panelScrollTop: scroller.scrollTop, panelScrollHeight: scroller.scrollHeight, panelClientHeight: scroller.clientHeight, selectScrollTop: element.scrollTop };
        });
        const x = geometry.box.x + geometry.box.width / 2;
        const y = geometry.box.y + geometry.box.height / 2;
        const distance = Math.min(100, geometry.panel.bottom - y - 20, geometry.panelScrollTop - 20);
        expect(distance).toBeGreaterThan(40);
        await testInfo.attach('swipe-geometry', { body: JSON.stringify(geometry), contentType: 'application/json' });
        const cdp = await page.context().newCDPSession(page);
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 1 }] });
        const openedOnTouchStart = await menu.isVisible();
        for (let step = 1; step <= 10; step++) {
            await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y + step * distance / 10, id: 1 }] });
            // eslint-disable-next-line playwright/no-wait-for-timeout -- Pace the actual touch gesture, not an application state wait.
            await page.waitForTimeout(20);
        }
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        await cdp.detach();
        // eslint-disable-next-line playwright/prefer-web-first-assertions -- Assert the captured contact-time state, including transient opening.
        expect(openedOnTouchStart, 'A scroll must not open the picker at finger contact').toBe(false);
        await expect(menu).toBeHidden();
        await expect.poll(() => select.evaluate(element => element.closest('.sb-shell-panel-scroller').scrollTop)).toBeLessThan(geometry.panelScrollTop - 20);
        await expect(select).toHaveValues(['fp16']);
        await attachScreenshot(page, testInfo, `quant-swipe-${kind}`);

        await settleScroll(trigger);
        await trigger.tap();
        await expect(menu).toBeVisible();
        await expect(select).toHaveValues(['fp16']);
        await menu.getByRole('option', { name: 'Integer (8 bit)', exact: true }).tap();
        await expect(select).toHaveValues(['int8', 'fp16']);
        const saved = await page.evaluate(async kind => kind === 'chat'
            ? (await import('/scripts/openai.js')).oai_settings.openrouter_quantizations
            : (await import('/scripts/textgen-settings.js')).textgenerationwebui_settings.openrouter_quantizations, kind);
        expect(saved).toEqual(['int8', 'fp16']);
    });
}

test('pen pan leaves the picker closed and a pen tap opens it', async ({ page, baseURL, browserName }, testInfo) => {
    // eslint-disable-next-line playwright/no-skipped-test -- Only the Chromium protocol can dispatch a pen pointer.
    test.skip(browserName !== 'chromium', 'CDP pen pointer requires Chromium');
    const { select, trigger, menu } = await openQuantizations(page, baseURL);
    await expect(select).toHaveValues(['fp16']);
    await recordPointerTypes(trigger);
    const box = await trigger.boundingBox();
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    const cdp = await page.context().newCDPSession(page);
    const pen = (type, position, buttons) => cdp.send('Input.dispatchMouseEvent', {
        type, x: position.x, y: position.y, pointerType: 'pen', button: 'left', buttons, clickCount: type === 'mouseMoved' ? 0 : 1,
    });

    await pen('mousePressed', { x, y }, 1);
    const openedOnContact = await menu.isVisible();
    for (let step = 1; step <= 10; step++) {
        await pen('mouseMoved', { x, y: y + step * 6 }, 1);
        // eslint-disable-next-line playwright/no-wait-for-timeout -- Pace the actual pen gesture, not an application state wait.
        await page.waitForTimeout(20);
    }
    await pen('mouseReleased', { x, y: y + 60 }, 0);
    // eslint-disable-next-line playwright/prefer-web-first-assertions -- Assert the captured contact-time state, including transient opening.
    expect(openedOnContact, 'A pen pan must not open the picker at contact').toBe(false);
    await expect(menu).toBeHidden();
    await expect(select).toHaveValues(['fp16']);

    await pen('mousePressed', { x, y }, 1);
    await pen('mouseReleased', { x, y }, 0);
    await cdp.detach();
    await expect(menu).toBeVisible();
    await expect(select).toHaveValues(['fp16']);
    expect(await page.evaluate(() => window.__sbPointerTypes)).toEqual(['pen', 'pen']);
    await attachScreenshot(page, testInfo, 'pen-tap');
});

test('mobile touch tap opens once without changing native selection', async ({ page, baseURL }) => {
    const { select, trigger, menu } = await openQuantizations(page, baseURL);
    await trigger.tap();
    await expect(menu).toBeVisible();
    await expect(select).toHaveValues(['fp16']);
    // The shared picker is a modal sheet on phones; close it before returning to the row.
    await menu.getByRole('button', { name: 'Close', exact: true }).tap();
    await expect(menu).toBeHidden();
    await trigger.tap();
    await expect(menu).toBeVisible();
    await menu.getByRole('option', { name: 'Integer (8 bit)', exact: true }).tap();
    await expect(select).toHaveValues(['int8', 'fp16']);
});

test('mobile picker row keeps mouse and keyboard activation', async ({ page, baseURL }) => {
    const { select, trigger, menu } = await openQuantizations(page, baseURL);
    for (const key of ['Enter', 'Space', 'ArrowDown', 'ArrowUp']) {
        await trigger.press(key);
        await expect(menu).toBeVisible();
        await expect(menu.getByRole('combobox')).toBeFocused();
        await menu.getByRole('combobox').press('Escape');
        await expect(menu).toBeHidden();
        await expect(trigger).toBeFocused();
        await expect(select).toHaveValues(['fp16']);
    }
    await trigger.click();
    await expect(menu).toBeVisible();
    await menu.getByRole('option', { name: 'Integer (8 bit)', exact: true }).click();
    await expect(select).toHaveValues(['int8', 'fp16']);
});

test.describe('wide tablet', () => {
    test.use({ viewport: { width: 1024, height: 768 }, userAgent: GALAXY_TAB_USER_AGENT });

    test('a 1024px tablet exposes a picker row instead of a scrollable native multiple select', async ({ page, baseURL }, testInfo) => {
        const { select, trigger, menu } = await openQuantizations(page, baseURL);
        const state = await page.evaluate(async () => {
            const { isMobile } = await import('/scripts/RossAscends-mods.js');
            const element = document.getElementById('openrouter_quantizations_chat');
            const style = getComputedStyle(element);
            return {
                appIsMobile: isMobile(),
                mobileMedia: window.matchMedia('(max-width: 768px)').matches,
                hiddenFromAccessibility: element.getAttribute('aria-hidden'),
                tabIndex: element.tabIndex,
                pointerEvents: style.pointerEvents,
                pickerRow: Boolean(element.closest('.ds-select-row')),
                overflow: style.overflow,
                touchAction: style.touchAction,
                insideLeftNav: Boolean(element.closest('#left-nav-panel')),
            };
        });
        await testInfo.attach('tablet-state', { body: JSON.stringify(state), contentType: 'application/json' });
        expect(state).toMatchObject({
            appIsMobile: true,
            mobileMedia: false,
            hiddenFromAccessibility: 'true',
            tabIndex: -1,
            pointerEvents: 'none',
            pickerRow: true,
            overflow: 'hidden',
        });
        await trigger.tap();
        await expect(menu).toBeVisible();
        await expect(select).toHaveValues(['fp16']);
        await trigger.tap();
        await expect(menu).toBeHidden();
        await expect(select).toHaveValues(['fp16']);
        await attachScreenshot(page, testInfo, 'tablet-1024');
    });
});
