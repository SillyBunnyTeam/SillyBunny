import { expect, test } from '@playwright/test';

test.use({ serviceWorkers: 'block' });
test.setTimeout(90000);

const READ_ONLY_POSTS = new Set([
    '/api/characters/all', '/api/characters/chats', '/api/groups/all', '/api/backgrounds/all',
    '/api/avatars/get', '/api/stats/get', '/api/users/me',
]);

async function openChatCompletionSource(page, baseURL) {
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
            settings.main_api = 'openai';
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
        // Saves stay in the browser, so this test leaves the stored settings as they were.
        if (url.pathname === '/api/settings/save') return route.fulfill({ json: { result: 'ok', version: ++version } });
        if (url.pathname === '/api/secrets/read') return route.fulfill({ json: {} });
        if (url.pathname.startsWith('/api/backends/')) return route.fulfill({ json: { data: [] } });
        if (READ_ONLY_POSTS.has(url.pathname) || url.pathname.startsWith('/api/tokenizers/')) return route.continue();
        if (url.pathname.startsWith('/api/')) return route.fulfill({ json: {} });
        if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method())) return route.fulfill({ json: {} });
        return route.continue();
    });
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.SillyTavern?.getContext?.()?.eventSource?.autoFireLastArgs?.has('app_ready'), null, { timeout: 60000 });
    await page.evaluate(() => window.SillyBunnyShell.openTab('left', 'api'));
    const source = page.locator('#chat_completion_source');
    await expect(source).toBeVisible();
    return source;
}

test('selecting KoboldCpp restores the penalty limits that Cohere narrowed', async ({ page, baseURL }) => {
    const source = await openChatCompletionSource(page, baseURL);
    const sliders = [page.locator('#pres_pen_openai'), page.locator('#freq_pen_openai')];

    await source.selectOption('cohere');
    for (const slider of sliders) {
        await expect(slider).toHaveAttribute('min', '0');
        await expect(slider).toHaveAttribute('max', '1');
    }

    await source.selectOption('koboldcpp');
    for (const slider of sliders) {
        await expect(slider).toHaveAttribute('min', '-2');
        await expect(slider).toHaveAttribute('max', '2');
    }
});
