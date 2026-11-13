import { expect, test } from '@playwright/test';
import { fetchJsonOrSkip } from './helpers/route-fetch.js';
import { applyWelcomeSettings } from './helpers/welcome-dialog.js';
import { selectBackend, openSettingsTab, settle } from './helpers/surfaces/steps.js';

test.use({ serviceWorkers: 'block', contextOptions: { reducedMotion: 'reduce' } });

/** Boots the app with every write intercepted, and keeps the last settings save for the spec to read. */
async function loadSettings(page, baseURL) {
    const origin = new URL(baseURL).origin;
    expect(['127.0.0.1', 'localhost', '[::1]']).toContain(new URL(baseURL).hostname);
    const store = { saved: null, saves: 0 };
    let version = 1_000_000_000_000_000;
    const readOnlyEndpoints = new Set([
        '/api/characters/all', '/api/characters/chats', '/api/groups/all', '/api/backgrounds/all',
        '/api/avatars/get', '/api/stats/get', '/api/secrets/read', '/api/users/me',
    ]);
    await page.route('**/*', async route => {
        const url = new URL(route.request().url());
        if (url.origin !== origin) return route.abort();
        if (url.pathname === '/api/extensions/discover') {
            const extensions = await fetchJsonOrSkip(route);
            if (!extensions) return;
            return route.fulfill({ json: extensions.filter(extension => !extension.name.startsWith('third-party/')) });
        }
        if (url.pathname === '/api/settings/get') {
            const data = await fetchJsonOrSkip(route);
            if (!data) return;
            data.request_compression = { ...data.request_compression, enabled: false };
            const settings = JSON.parse(data.settings);
            settings.firstRun = false;
            settings.power_user.sb_preset_autosave = false;
            applyWelcomeSettings(settings);
            data.settings = JSON.stringify(settings);
            return route.fulfill({ json: data });
        }
        if (url.pathname === '/api/settings/save') {
            store.saved = route.request().postDataJSON();
            store.saves++;
            return route.fulfill({ json: { version: ++version } });
        }
        if (readOnlyEndpoints.has(url.pathname) || url.pathname.startsWith('/api/tokenizers/')) return route.continue();
        if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(route.request().method()) && url.pathname.startsWith('/api/')) {
            return route.fulfill({ json: {} });
        }
        if (url.pathname.startsWith('/api/backends/')) return route.fulfill({ json: { data: [] } });
        return route.continue();
    });
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.SillyTavern?.getContext?.()?.eventSource?.autoFireLastArgs?.has('app_ready'), null, { timeout: 60000 });
    return store;
}

/** Opens the Sampling page and the drawer that holds `list`. */
async function showList(page, list) {
    await openSettingsTab(page, { shell: 'left', tab: 'sampling' });
    await page.locator(list).first().evaluate(node => {
        const drawer = node.closest('.inline-drawer');
        const content = drawer?.querySelector(':scope > .inline-drawer-content');
        if (content && getComputedStyle(content).display === 'none') {
            drawer.querySelector(':scope > .inline-drawer-toggle')?.click();
        }
    });
    await page.locator(list).first().scrollIntoViewIfNeeded();
    await expect(page.locator(list).first()).toBeVisible();
    await settle(page);
}

/**
 * Adds one logit bias entry per text, then shows the preset again. The list's sortable saves into the array that it was
 * built with, and adding an entry makes the app build the preset state again, so only a list that was shown after the last
 * edit saves into the live preset.
 */
async function fillLogitBiasList(page, texts) {
    const list = page.locator('.openai_logit_bias_list');
    for (const text of texts) {
        await page.locator('#openai_logit_bias_new_entry').click();
        await list.locator(':scope > *').first().locator('.openai_logit_bias_text').fill(text);
    }
    await page.evaluate(() => window.$('#openai_logit_bias_preset').trigger('change'));
    await expect(list.locator(':scope > *')).toHaveCount(texts.length);
    await expect(list).toHaveClass(/ui-sortable/);
    return list;
}

test('a sampler order list moves by keyboard once unlocked, and saves through its own handler', async ({ page, baseURL }) => {
    test.setTimeout(120000);
    const store = await loadSettings(page, baseURL);
    await selectBackend(page, 'koboldcpp');
    await showList(page, '#koboldcpp_order');

    const list = page.locator('#koboldcpp_order');
    const rows = list.locator(':scope > div');
    const ids = () => rows.evaluateAll(nodes => nodes.map(node => Number(node.dataset.id)));

    // Locked at start: the sortable is disabled, so no row is a tab stop and the key does nothing.
    await expect(list).toHaveClass(/ui-sortable-disabled/);
    await expect(rows.first()).not.toHaveAttribute('tabindex', /.*/);
    const before = await ids();
    await rows.first().evaluate(node => node.focus());
    await page.keyboard.press('Alt+ArrowDown');
    expect(await ids()).toEqual(before);

    await page.locator('[data-sampler-order-lock="koboldcpp_order"]').click();
    await expect(list).not.toHaveClass(/ui-sortable-disabled/);
    await expect(rows.first()).toHaveAttribute('tabindex', '0');
    const named = list.getByRole('group', { name: /^Drag to reorder / });
    await expect(named).toHaveCount(before.length);

    await rows.first().focus();
    await page.keyboard.press('Alt+ArrowDown');
    const moved = [before[1], before[0], ...before.slice(2)];
    expect(await ids()).toEqual(moved);
    await expect(rows.nth(1)).toBeFocused();
    await expect(page.locator('.sb-reorder-status')).toHaveText(/^Moved .+ to position 2 of \d+$/);
    await expect.poll(() => store.saved?.textgenerationwebui_settings?.sampler_order, { timeout: 15000 }).toEqual(moved);

    await page.keyboard.press('Alt+End');
    const toEnd = [moved[0], ...moved.slice(2), moved[1]];
    expect(await ids()).toEqual(toEnd);
    await expect(rows.last()).toBeFocused();
    await expect.poll(() => store.saved?.textgenerationwebui_settings?.sampler_order, { timeout: 15000 }).toEqual(toEnd);

    // Locking again ends it.
    await page.locator('[data-sampler-order-lock="koboldcpp_order"]').click();
    await expect(rows.first()).not.toHaveAttribute('tabindex', /.*/);
});

test('the logit bias list moves by its handle, and a keyboard move is saved in the list\'s own inverted order', async ({ page, baseURL }) => {
    test.setTimeout(120000);
    const store = await loadSettings(page, baseURL);
    await selectBackend(page, 'chat-completion');
    await showList(page, '.openai_logit_bias_list');

    const list = await fillLogitBiasList(page, ['one', 'two', 'three']);
    const texts = () => list.locator('.openai_logit_bias_text').evaluateAll(nodes => nodes.map(node => node.value));
    // The list prepends each entry, so the last one added is on top.
    expect(await texts()).toEqual(['three', 'two', 'one']);

    const bottom = list.locator(':scope > *').last().locator('.drag-handle');
    await expect(bottom).toHaveAttribute('role', 'button');
    await expect(bottom).toHaveAttribute('tabindex', '0');
    await expect(bottom).toHaveAttribute('aria-label', 'Drag to reorder one');
    await expect(list.locator(':scope > *').last()).not.toHaveAttribute('tabindex', /.*/);

    await bottom.focus();
    const handle = await bottom.elementHandle();
    await page.keyboard.press('Alt+ArrowUp');
    expect(await texts()).toEqual(['three', 'one', 'two']);
    await expect.poll(() => page.evaluate(node => document.activeElement === node, handle)).toBe(true);
    await expect(page.locator('.sb-reorder-status')).toHaveText('Moved one to position 2 of 3');
    await expect.poll(async () => {
        const saved = store.saved?.oai_settings;
        return saved?.bias_presets?.[saved.bias_preset_selected]?.map(entry => entry.text);
    }, { timeout: 15000 }).toEqual(['two', 'one', 'three']);
});

test('a drag still moves a logit bias row', async ({ page, baseURL }) => {
    test.setTimeout(120000);
    const store = await loadSettings(page, baseURL);
    await selectBackend(page, 'chat-completion');
    await showList(page, '.openai_logit_bias_list');

    const list = await fillLogitBiasList(page, ['one', 'two']);
    const texts = () => list.locator('.openai_logit_bias_text').evaluateAll(nodes => nodes.map(node => node.value));
    expect(await texts()).toEqual(['two', 'one']);

    const from = await list.locator(':scope > *').last().locator('.drag-handle').boundingBox();
    const to = await list.locator(':scope > *').first().boundingBox();
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    for (let step = 1; step <= 12; step++) {
        await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2 + ((to.y - from.y - 6) * step) / 12);
    }
    await page.mouse.up();
    await expect.poll(texts).toEqual(['one', 'two']);
    await expect.poll(async () => {
        const saved = store.saved?.oai_settings;
        return saved?.bias_presets?.[saved.bias_preset_selected]?.map(entry => entry.text);
    }, { timeout: 15000 }).toEqual(['two', 'one']);
});
