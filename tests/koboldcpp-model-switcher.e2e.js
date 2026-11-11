import { expect, test } from '@playwright/test';

test.use({ serviceWorkers: 'block', contextOptions: { reducedMotion: 'reduce' } });
test.setTimeout(90000);

const OLD_URL = 'http://127.0.0.1:5001';
const NEW_URL = 'http://127.0.0.1:5002';
const STOPPED_WAITING = 'Stopped waiting for KoboldCpp';
const READ_ONLY_POSTS = new Set([
    '/api/characters/all', '/api/characters/chats', '/api/groups/all', '/api/backgrounds/all',
    '/api/avatars/get', '/api/stats/get', '/api/users/me',
]);

/**
 * @param {string[]} models Model files of one KoboldCpp server, the first one loaded
 * @returns {object} Answer of the switcher's /models route
 */
function modelList(models) {
    return {
        admin: 1,
        entries: [...models.map(name => ({ name, type: 'model' })), { name: 'initial_model', type: 'action' }, { name: 'unload_model', type: 'action' }],
        loadedModel: `koboldcpp/${models[0].replace(/\.gguf$/, '')}`,
        loadedFiles: [models[0]],
        loadedFile: models[0],
    };
}

const SERVERS = new Map([
    [OLD_URL, modelList(['alpha.gguf', 'beta.gguf'])],
    [NEW_URL, modelList(['gamma.gguf'])],
]);

/**
 * @param {import('@playwright/test').Request} request Request for one KoboldCpp server
 * @returns {string} URL of the mocked server the request names
 */
function getServerUrl(request) {
    const apiServer = String(request.postDataJSON()?.api_server ?? '');
    return [...SERVERS.keys()].find(url => apiServer.startsWith(url)) ?? '';
}

/**
 * Opens the API panel connected to a mocked KoboldCpp in admin mode. The mock accepts every load request, and its old
 * worker keeps answering afterwards, so a model switch waits until something stops it.
 * @returns {Promise<Record<string, number>>} Restart polls by server URL, updated as the page polls
 */
async function connectKoboldCpp(page, baseURL) {
    const origin = new URL(baseURL).origin;
    expect(['127.0.0.1', 'localhost', '[::1]']).toContain(new URL(baseURL).hostname);
    const polls = { [OLD_URL]: 0, [NEW_URL]: 0 };
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
            settings.main_api = 'textgenerationwebui';
            settings.power_user = { ...settings.power_user, auto_connect: false };
            settings.textgenerationwebui_settings = {
                ...settings.textgenerationwebui_settings,
                type: 'koboldcpp',
                server_urls: { ...settings.textgenerationwebui_settings?.server_urls, koboldcpp: OLD_URL, llamacpp: '' },
            };
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
        if (url.pathname === '/api/backends/text-completions/status') {
            return route.fulfill({ json: { result: SERVERS.get(getServerUrl(request))?.loadedModel ?? '' } });
        }
        if (url.pathname === '/api/backends/text-completions/koboldcpp/models') {
            return route.fulfill({ json: SERVERS.get(getServerUrl(request)) });
        }
        if (url.pathname === '/api/backends/text-completions/koboldcpp/load') return route.fulfill({ json: { success: true } });
        if (url.pathname === '/api/backends/text-completions/koboldcpp/uptime') {
            polls[getServerUrl(request)]++;
            return route.fulfill({ json: { online: true, uptime: 3600 } });
        }
        if (url.pathname.startsWith('/api/backends/')) return route.fulfill({ status: 404, json: {} });
        if (READ_ONLY_POSTS.has(url.pathname) || url.pathname.startsWith('/api/tokenizers/')) return route.continue();
        if (url.pathname.startsWith('/api/')) return route.fulfill({ json: {} });
        if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method())) return route.fulfill({ json: {} });
        return route.continue();
    });
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.SillyTavern?.getContext?.()?.eventSource?.autoFireLastArgs?.has('app_ready'), null, { timeout: 60000 });
    await page.evaluate(() => window.SillyBunnyShell.openTab('left', 'api'));
    await page.locator('#api_button_textgenerationwebui').click();
    await expect(page.locator('#koboldcpp_model')).toHaveValue('alpha.gguf');
    return polls;
}

/**
 * Chooses beta.gguf in the switcher, as Select2 does, and waits until the switch polls for the restart.
 */
async function startSwitch(page, polls) {
    await page.evaluate(() => window.$('#koboldcpp_model').val('beta.gguf').trigger('change'));
    await expect.poll(() => polls[OLD_URL]).toBeGreaterThan(0);
    await expect(page.locator('#api_button_textgenerationwebui')).toHaveClass(/\bdisabled\b/);
}

async function expectConnectEnabled(page) {
    await expect(page.locator('.api_button.disabled')).toHaveCount(0);
    await expect(page.locator('.api_loading:visible')).toHaveCount(0);
}

async function expectNoMorePolls(page, polls) {
    const count = polls[OLD_URL];
    // eslint-disable-next-line playwright/no-wait-for-timeout -- Outlast the switcher's poll interval to show that no poll follows.
    await page.waitForTimeout(3000);
    expect(polls[OLD_URL]).toBe(count);
}

test.describe('KoboldCpp model switch', () => {
    test('a change of the main API stops the wait and enables Connect again', async ({ page, baseURL }) => {
        const polls = await connectKoboldCpp(page, baseURL);
        await startSwitch(page, polls);

        await page.locator('#main_api').selectOption('novel');

        await expectConnectEnabled(page);
        await expect(page.locator('.toast', { hasText: STOPPED_WAITING })).toBeVisible();
        await expectNoMorePolls(page, polls);
    });

    test('the Chat Completion reconnect after a change of the main API keeps Cancel until it answers', async ({ page, baseURL }) => {
        const polls = await connectKoboldCpp(page, baseURL);
        let answerStatus;
        const statusAnswer = new Promise(resolve => {
            answerStatus = resolve;
        });
        await page.route('**/api/backends/chat-completions/status', async route => {
            await statusAnswer;
            await route.fulfill({ json: { data: [] } });
        });
        await page.evaluate(() => Object.assign(window.SillyTavern.getContext().chatCompletionSettings, {
            chat_completion_source: 'custom',
            custom_url: 'http://127.0.0.1:5003/v1',
        }));
        await startSwitch(page, polls);

        await page.locator('#main_api').selectOption('openai');

        await expect(page.locator('.toast', { hasText: STOPPED_WAITING })).toBeVisible();
        await expect(page.locator('#api_button_openai')).toHaveClass(/\bdisabled\b/);
        await expect(page.locator('#api_button_openai ~ .api_loading')).toBeVisible();
        answerStatus();
        await expectConnectEnabled(page);
        await expectNoMorePolls(page, polls);
    });

    test('a Text Completion type without a URL stops the wait and enables Connect again', async ({ page, baseURL }) => {
        const polls = await connectKoboldCpp(page, baseURL);
        await startSwitch(page, polls);

        await page.locator('#textgen_type').selectOption('llamacpp');

        await expectConnectEnabled(page);
        await expect(page.locator('.toast', { hasText: STOPPED_WAITING })).toBeVisible();
        await expectNoMorePolls(page, polls);
    });

    test('a KoboldCpp URL typed during the wait enables Connect, which lists the new server', async ({ page, baseURL }) => {
        const polls = await connectKoboldCpp(page, baseURL);
        await startSwitch(page, polls);

        await page.locator('#koboldcpp_api_url_text').fill(NEW_URL);
        await expectConnectEnabled(page);
        await page.locator('#api_button_textgenerationwebui').click();

        await expect(page.locator('#koboldcpp_model')).toHaveValue('gamma.gguf');
        await expectNoMorePolls(page, polls);
    });

    test('/api-url during the wait lists the new server', async ({ page, baseURL }) => {
        const polls = await connectKoboldCpp(page, baseURL);
        await startSwitch(page, polls);

        await page.evaluate(url => window.SillyTavern.getContext().executeSlashCommandsWithOptions(`/api-url ${url}`), NEW_URL);

        await expect(page.locator('#koboldcpp_model')).toHaveValue('gamma.gguf');
        await expectConnectEnabled(page);
        await expectNoMorePolls(page, polls);
    });

    test('the Cancel button stops the wait and resets the connection status', async ({ page, baseURL }) => {
        const polls = await connectKoboldCpp(page, baseURL);
        await startSwitch(page, polls);

        await page.locator('#api_button_textgenerationwebui ~ .api_loading').click();

        await expectConnectEnabled(page);
        await expect(page.locator('.toast', { hasText: STOPPED_WAITING })).toBeVisible();
        await expectNoMorePolls(page, polls);
    });

    test('a deleted API key stops the wait and enables Connect again while KoboldCpp stays selected', async ({ page, baseURL }) => {
        const polls = await connectKoboldCpp(page, baseURL);
        await startSwitch(page, polls);

        await page.evaluate(async () => {
            const { deleteSecret } = await import('/scripts/secrets.js');
            await deleteSecret('api_key_koboldcpp');
        });

        await expect(page.locator('.toast', { hasText: STOPPED_WAITING })).toBeVisible();
        await expectConnectEnabled(page);
        await expectNoMorePolls(page, polls);
    });

    test('stopping the script that runs /kcpp-model stops the wait and enables Connect again', async ({ page, baseURL }) => {
        const polls = await connectKoboldCpp(page, baseURL);
        const abortController = await page.evaluateHandle(async () => {
            const { SlashCommandAbortController } = await import('/scripts/slash-commands/SlashCommandAbortController.js');
            return new SlashCommandAbortController();
        });
        const isAborted = page.evaluate(async controller => {
            const result = await window.SillyTavern.getContext().executeSlashCommandsWithOptions('/kcpp-model beta.gguf', { abortController: controller });
            return result.isAborted;
        }, abortController);
        await expect.poll(() => polls[OLD_URL]).toBeGreaterThan(0);
        await expect(page.locator('#api_button_textgenerationwebui')).toHaveClass(/\bdisabled\b/);

        await abortController.evaluate(controller => controller.abort('Stopped by the test', true));

        expect(await isAborted).toBe(true);
        await expectConnectEnabled(page);
        await expect(page.locator('.toast', { hasText: STOPPED_WAITING })).toBeVisible();
        await expectNoMorePolls(page, polls);
    });
});

test.describe('KoboldCpp model switcher on a narrow screen', () => {
    // Narrow screens keep the native select, because Select2 replaces it only on wider screens.
    test.use({ viewport: { width: 390, height: 844 } });

    test('the model select and the picker have accessible names', async ({ page, baseURL }) => {
        await connectKoboldCpp(page, baseURL);

        const select = page.locator('#koboldcpp_model');
        await expect(select).toHaveAccessibleName('KoboldCpp Model');
        await expect(select).toHaveAccessibleDescription('Models load with KoboldCpp\'s default settings, or its --baseconfig file when set. Configs (.kcpps, .kcppt) load their own settings.');

        const result = page.evaluate(() => window.SillyTavern.getContext().executeSlashCommandsWithOptions('/kcpp-model'));
        const picker = page.getByRole('dialog').filter({ hasText: 'Load a KoboldCpp model' });
        await expect(picker.getByRole('searchbox')).toHaveAttribute('aria-label', 'Search...');
        await expect(picker.getByRole('button', { name: 'Loaded alpha.gguf', exact: true })).toBeVisible();
        await expect(picker.getByRole('img', { name: 'Loaded', exact: true })).toBeVisible();
        await expect(picker.getByRole('button', { name: 'beta.gguf', exact: true })).toBeVisible();

        await page.keyboard.press('Escape');
        await expect(picker).toBeHidden();
        expect((await result).pipe).toBe('');
    });
});
