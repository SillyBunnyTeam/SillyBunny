import { expect, test } from '@playwright/test';
import { waitForAppReady } from './helpers/app-ready.js';
import { protectMaintainerServer, showToasts } from './helpers/maintainer-server.js';

test.use({ serviceWorkers: 'block', contextOptions: { reducedMotion: 'reduce' } });

const GET_ROUTE = '**/api/server-admin/config/chat-completions/get';
const SAVE_ROUTE = '**/api/server-admin/config/chat-completions/save';

const READ_ONLY_POSTS = new Set([
    '/api/settings/get', '/api/presets/defaults', '/api/avatars/get', '/api/backgrounds/folders', '/api/image-metadata/all',
    '/api/tokenizers/openai/count', '/api/server-admin/install-type', '/api/server-admin/config/get', '/api/server-admin/config/thumbnail-settings/get',
]);

const OFF = {
    claude: { enableSystemPromptCache: false, cachingAtDepth: -1, extendedTTL: false, enableAdaptiveThinking: true },
    gemini: { apiVersion: 'v1beta', thoughtSignatures: true, enableSystemPromptCache: false },
};
const ON = {
    claude: { enableSystemPromptCache: true, cachingAtDepth: 2, extendedTTL: false, enableAdaptiveThinking: true },
    gemini: { apiVersion: 'v1beta', thoughtSignatures: true, enableSystemPromptCache: true },
};

const IDS = {
    master: '#sb-config-prompt-caching-enabled',
    depth: '#sb-config-claude-caching-depth',
    ttl: '#sb-config-claude-extended-ttl',
    adaptive: '#sb-config-claude-adaptive-thinking',
    apiVersion: '#sb-config-gemini-api-version',
    signatures: '#sb-config-gemini-thought-signatures',
};

/**
 * The server side of the two routes, in memory, so that the spec never reads or writes the repository's config.yaml.
 * @param {import('@playwright/test').Page} page
 * @param {{settings?: any, envManaged?: string[], readStatus?: number, saveStatus?: number, holdSaves?: boolean}} [options]
 */
async function mockServerConfig(page, { settings = OFF, envManaged = [], readStatus = 200, saveStatus = 200, holdSaves = false } = {}) {
    const server = {
        settings: structuredClone(settings),
        envManaged,
        readStatus,
        saveStatus,
        reads: 0,
        saves: [],
        held: [],
    };
    await page.route(GET_ROUTE, route => {
        server.reads++;
        if (server.readStatus !== 200) return route.fulfill({ status: server.readStatus, json: { error: 'Forbidden' } });
        return route.fulfill({ json: { settings: server.settings, lastModifiedMs: 1, envManaged: server.envManaged } });
    });
    await page.route(SAVE_ROUTE, async route => {
        const body = route.request().postDataJSON();
        server.saves.push(body);
        if (holdSaves && server.saves.length === 1) await new Promise(resolve => server.held.push(resolve));
        if (server.saveStatus !== 200) return route.fulfill({ status: server.saveStatus, json: { error: 'config.yaml is read-only' } });
        for (const [group, values] of Object.entries(body.settings)) Object.assign(server.settings[group], values);
        return route.fulfill({ json: { settings: server.settings, lastModifiedMs: 2, envManaged: server.envManaged } });
    });
    return server;
}

async function boot(page, baseURL) {
    const origin = new URL(baseURL).origin;
    await page.context().route('**/*', route => {
        const request = route.request();
        const url = new URL(request.url());
        if (url.origin !== origin) return route.abort();
        if (['GET', 'HEAD', 'OPTIONS'].includes(request.method())) return route.continue();
        if (request.method() === 'POST' && READ_ONLY_POSTS.has(url.pathname)) return route.continue();
        return route.abort();
    });
    await protectMaintainerServer(page);
    await page.route('**/api/server-admin/status', route => route.fulfill({ json: {} }));
    await page.route(/\/api\/(?:characters\/all|groups\/all|chats\/(?:group\/)?get|in-chat-agents\/groups\/list)$/, route => route.fulfill({ json: [] }));
    await page.route('**/api/backgrounds/all', route => route.fulfill({ json: { images: [], config: {} } }));
    await page.route('**/api/secrets/read', route => route.fulfill({ json: {} }));
}

async function open(page, source) {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await waitForAppReady(page, { timeout: 60000 });
    await page.evaluate(() => window.SillyBunnyShell.openTab('left', 'prompting'));
    await selectSource(page, source);
}

async function selectSource(page, source) {
    await page.evaluate(value => {
        $('#main_api').val('openai').trigger('change');
        $('#chat_completion_source').val(value).trigger('change');
    }, source);
}

const row = (page, id) => page.locator(`.ds-row:has(${id})`);

/** A change to a switch, which the row's own label receives like a press. */
const toggle = (page, id) => page.locator(id).evaluate(input => input.click());

async function setNumber(page, id, value) {
    const input = page.locator(id);
    await input.fill(String(value));
    await input.press('Enter');
    await input.blur();
}

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    test.describe(`Prompt Caching and the server rows of Presets at ${viewport.width}×${viewport.height}`, () => {
        test.use({ viewport });

        test('the Prompt Caching group follows the request groups for every source', async ({ page, baseURL }) => {
            test.setTimeout(120000);
            await boot(page, baseURL);
            await mockServerConfig(page);
            await open(page, 'openrouter');
            const group = page.locator('#sb-openai-prompt-caching');
            await expect(group).toBeVisible();
            await expect(group.locator('.sb-settings-category-title')).toHaveText('Prompt Caching');
            await expect(group.locator('.ds-row')).toHaveCount(3);
            await expect(group.getByRole('switch', { name: 'Enable Prompt Caching' })).toBeVisible();
            for (const source of ['openai', 'claude', 'makersuite', 'vertexai', 'custom', 'linkapi']) {
                await selectSource(page, source);
                await expect(group, source).toBeVisible();
            }
            const order = await page.evaluate(() => {
                const position = id => document.getElementById(id);
                const before = (first, second) => Boolean(position(first).compareDocumentPosition(position(second)) & Node.DOCUMENT_POSITION_FOLLOWING);
                return [
                    before('sb-openai-request', 'sb-openai-prompt-caching'),
                    before('sb-openai-reasoning-tags', 'sb-openai-prompt-caching'),
                    before('sb-openai-prompt-caching', 'sb-reasoning-template'),
                ];
            });
            expect(order).toEqual([true, true, true]);
            await expect(page.locator('#sb-openai-provider-server-config, #sb-config-system-prompt-cache')).toHaveCount(0);
        });

        test('the switch is the first row and the other two rows depend on it', async ({ page, baseURL }) => {
            await boot(page, baseURL);
            const server = await mockServerConfig(page);
            await open(page, 'claude');
            const group = page.locator('#sb-openai-prompt-caching');
            await expect(group.locator('.sb-prompting-group-body')).toHaveAttribute('data-sb-enabled-by', '#sb-config-prompt-caching-enabled');
            await expect(group.locator('.ds-row').first().locator('input')).toHaveAttribute('id', 'sb-config-prompt-caching-enabled');
            await expect(page.locator(IDS.master)).not.toBeChecked();
            await expect(page.locator(IDS.depth)).toBeDisabled();
            await expect(page.locator(IDS.ttl)).toBeDisabled();
            await expect(page.locator(IDS.depth)).toHaveValue('-1');
            await toggle(page, IDS.master);
            await expect(page.locator(IDS.depth)).toBeEnabled();
            await expect(page.locator(IDS.ttl)).toBeEnabled();
            await expect.poll(() => server.saves.length).toBe(1);
            expect(server.saves[0]).toEqual({ settings: { claude: { enableSystemPromptCache: true, cachingAtDepth: 0 } } });
            await expect(page.locator(IDS.depth)).toHaveValue('0');
            await expect(page.getByRole('alertdialog')).toHaveCount(0);
        });

        test('turning the switch off keeps the depth in view, and turning it on writes it back', async ({ page, baseURL }) => {
            await boot(page, baseURL);
            const server = await mockServerConfig(page, { settings: ON });
            await open(page, 'claude');
            await expect(page.locator(IDS.master)).toBeChecked();
            await expect(page.locator(IDS.depth)).toHaveValue('2');
            await toggle(page, IDS.master);
            await expect.poll(() => server.saves.length).toBe(1);
            expect(server.saves[0]).toEqual({ settings: { claude: { enableSystemPromptCache: false, cachingAtDepth: -1 }, gemini: { enableSystemPromptCache: false } } });
            await expect(page.locator(IDS.master)).not.toBeChecked();
            await expect(page.locator(IDS.depth)).toHaveValue('2');
            await expect(page.locator(IDS.depth)).toBeDisabled();
            await toggle(page, IDS.master);
            await expect.poll(() => server.saves.length).toBe(2);
            expect(server.saves[1]).toEqual({ settings: { claude: { enableSystemPromptCache: true, cachingAtDepth: 2 } } });
            await expect(page.locator(IDS.depth)).toHaveValue('2');
        });

        test('the switch reads on while only the depth still places a marker', async ({ page, baseURL }) => {
            await boot(page, baseURL);
            await mockServerConfig(page, { settings: { ...OFF, claude: { ...OFF.claude, cachingAtDepth: 3 } } });
            await open(page, 'claude');
            await expect(page.locator(IDS.master)).toBeChecked();
            await expect(page.locator(IDS.depth)).toBeEnabled();
        });

        test('each control saves its own key and nothing else, with no restart', async ({ page, baseURL }) => {
            await boot(page, baseURL);
            const server = await mockServerConfig(page, { settings: ON });
            await open(page, 'linkapi');
            const saved = async patch => {
                await expect.poll(() => server.saves.length).toBeGreaterThan(0);
                const body = server.saves.shift();
                expect(body).toEqual({ settings: patch });
                expect(Object.keys(body)).toEqual(['settings']);
            };
            await setNumber(page, IDS.depth, 4);
            await saved({ claude: { cachingAtDepth: 4 } });
            await page.locator(`${IDS.depth}`).locator('xpath=ancestor::*[contains(@class,"ds-row--spin")][1]').getByRole('button', { name: /decrease/i }).click();
            await saved({ claude: { cachingAtDepth: 3 } });
            await toggle(page, IDS.ttl);
            await saved({ claude: { extendedTTL: true } });
            await toggle(page, IDS.adaptive);
            await saved({ claude: { enableAdaptiveThinking: false } });
            await toggle(page, IDS.signatures);
            await saved({ gemini: { thoughtSignatures: false } });
            await page.locator(IDS.apiVersion).fill('v1');
            await page.locator(IDS.apiVersion).press('Enter');
            await page.locator(IDS.apiVersion).blur();
            await saved({ gemini: { apiVersion: 'v1' } });
            await expect(page.getByRole('alertdialog')).toHaveCount(0);
        });

        test('the three rows show for the sources that read their keys', async ({ page, baseURL }) => {
            test.setTimeout(120000);
            await boot(page, baseURL);
            await mockServerConfig(page);
            await open(page, 'openai');
            const expected = {
                openai: [false, false, false],
                claude: [true, false, false],
                openrouter: [false, false, true],
                makersuite: [false, true, true],
                vertexai: [false, false, true],
                linkapi: [true, true, true],
                custom: [false, false, false],
            };
            for (const [source, [adaptive, apiVersion, signatures]] of Object.entries(expected)) {
                await selectSource(page, source);
                await expect(row(page, IDS.adaptive), source).toBeVisible({ visible: adaptive });
                await expect(row(page, IDS.apiVersion), source).toBeVisible({ visible: apiVersion });
                await expect(row(page, IDS.signatures), source).toBeVisible({ visible: signatures });
            }
        });

        test('Adaptive Thinking follows Reasoning Effort, and the two Gemini rows follow Verbosity', async ({ page, baseURL }) => {
            await boot(page, baseURL);
            await mockServerConfig(page);
            await open(page, 'linkapi');
            await expect(page.locator('#sb-openai-prompt-caching')).toBeVisible();
            const order = await page.evaluate(() => {
                const body = document.querySelector('#sb-openai-request .sb-prompting-group-body');
                return [...body.children].map(node => node.dataset.sbEditorField ?? node.querySelector('input')?.id ?? '').filter(Boolean);
            });
            const names = order.filter(name => ['openai_reasoning_effort', 'sb-config-claude-adaptive-thinking', 'openai_verbosity', 'sb-config-gemini-api-version', 'sb-config-gemini-thought-signatures'].includes(name));
            expect(names).toEqual(['openai_reasoning_effort', 'sb-config-claude-adaptive-thinking', 'openai_verbosity', 'sb-config-gemini-api-version', 'sb-config-gemini-thought-signatures']);
            const index = name => order.indexOf(name);
            expect(index('sb-config-claude-adaptive-thinking')).toBe(index('openai_reasoning_effort') + 1);
        });

        test('shows none of the rows and no error when the read is refused', async ({ page, baseURL }) => {
            await boot(page, baseURL);
            const server = await mockServerConfig(page, { readStatus: 403 });
            await open(page, 'linkapi');
            await showToasts(page);
            await expect.poll(() => server.reads).toBeGreaterThan(0);
            await expect(page.locator('#sb-openai-request')).toBeVisible();
            await expect(page.locator(`#sb-openai-prompt-caching, ${Object.values(IDS).join(', ')}`)).toHaveCount(0);
            await expect(page.locator('#toast-container .toast-error, #sb-toast-overlay .toast-error')).toHaveCount(0);
        });

        test('locks the rows that an environment variable sets', async ({ page, baseURL }) => {
            await boot(page, baseURL);
            await mockServerConfig(page, { settings: ON, envManaged: ['claude.extendedTTL', 'gemini.thoughtSignatures'] });
            await open(page, 'linkapi');
            await expect(page.locator(IDS.ttl)).toBeDisabled();
            await expect(row(page, IDS.ttl)).toHaveClass(/is-insensitive/);
            await expect(page.locator(IDS.signatures)).toBeDisabled();
            await expect(page.locator(IDS.depth)).toBeEnabled();
            await expect(page.locator(IDS.master)).toBeEnabled();
            await expect(page.locator(IDS.adaptive)).toBeEnabled();
        });

        test('locks the switch when one of its keys is set by an environment variable', async ({ page, baseURL }) => {
            await boot(page, baseURL);
            await mockServerConfig(page, { settings: ON, envManaged: ['claude.enableSystemPromptCache'] });
            await open(page, 'claude');
            await expect(page.locator(IDS.master)).toBeDisabled();
            await expect(page.locator(IDS.depth)).toBeEnabled();
        });

        test('restores the controls and shows one toast when a save fails', async ({ page, baseURL }) => {
            await boot(page, baseURL);
            const server = await mockServerConfig(page, { settings: ON, saveStatus: 500 });
            await open(page, 'linkapi');
            await showToasts(page);
            await toggle(page, IDS.ttl);
            await expect(page.locator(IDS.ttl)).not.toBeChecked();
            await expect.poll(() => server.saves.length).toBe(1);
            const toasts = page.locator('.toast-error');
            await expect(toasts).toHaveCount(1);
            await expect(toasts).toContainText('config.yaml is read-only');
            await expect(toasts).toContainText('Server config');
            await expect(page.getByRole('alertdialog')).toHaveCount(0);
        });

        test('queues changes made while a save runs, and never runs two saves at once', async ({ page, baseURL }) => {
            await boot(page, baseURL);
            const server = await mockServerConfig(page, { settings: ON, holdSaves: true });
            await open(page, 'linkapi');
            await toggle(page, IDS.ttl);
            await expect.poll(() => server.saves.length).toBe(1);
            await toggle(page, IDS.adaptive);
            await toggle(page, IDS.signatures);
            await expect(page.locator(IDS.signatures)).not.toBeChecked();
            await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
            expect(server.saves).toHaveLength(1);
            server.held.shift()();
            await expect.poll(() => server.saves.length).toBe(2);
            expect(server.saves[0]).toEqual({ settings: { claude: { extendedTTL: true } } });
            expect(server.saves[1]).toEqual({ settings: { claude: { enableAdaptiveThinking: false }, gemini: { thoughtSignatures: false } } });
            await expect(page.locator(IDS.ttl)).toBeChecked();
            await expect(page.locator(IDS.adaptive)).not.toBeChecked();
            await expect(page.locator(IDS.signatures)).not.toBeChecked();
        });

        test('reads again when the page is shown after another one, and takes the new values', async ({ page, baseURL }) => {
            await boot(page, baseURL);
            const server = await mockServerConfig(page);
            await open(page, 'claude');
            await expect(page.locator(IDS.master)).not.toBeChecked();
            const reads = server.reads;
            server.settings = structuredClone(ON);
            await page.evaluate(() => window.SillyBunnyShell.openTab('left', 'sampling'));
            await page.evaluate(() => window.SillyBunnyShell.openTab('left', 'prompting'));
            await expect.poll(() => server.reads).toBeGreaterThan(reads);
            await expect(page.locator(IDS.master)).toBeChecked();
            await expect(page.locator(IDS.depth)).toHaveValue('2');
        });

        test('switching the source builds no second group, reads nothing again, and keeps the settings out of presets', async ({ page, baseURL }) => {
            test.setTimeout(120000);
            await boot(page, baseURL);
            const server = await mockServerConfig(page, { settings: ON });
            await open(page, 'claude');
            await expect(page.locator(IDS.master)).toBeChecked();
            const reads = server.reads;
            const presetKeys = () => page.evaluate(async () => Object.keys((await import('/scripts/openai.js')).getChatCompletionPreset()).sort());
            const serverKeys = keys => keys.filter(key => /enableSystemPromptCache|cachingAtDepth|extendedTTL|enableAdaptiveThinking|apiVersion|thoughtSignatures|prompt_?caching|cache_?depth/i.test(key));
            expect(serverKeys(await presetKeys())).toEqual([]);
            for (const source of ['openrouter', 'makersuite', 'claude']) await selectSource(page, source);
            await expect(page.locator('#sb-openai-prompt-caching')).toHaveCount(1);
            await expect(page.locator('[id^="sb-config-"]')).toHaveCount(6);
            expect(server.reads).toBe(reads);
            expect(server.saves).toHaveLength(0);
            expect(serverKeys(await presetKeys())).toEqual([]);
        });

        test('importing a SillyTavern preset changes none of the rows', async ({ page, baseURL }) => {
            await boot(page, baseURL);
            const server = await mockServerConfig(page, { settings: ON });
            await open(page, 'openrouter');
            await expect(page.locator(IDS.master)).toBeChecked();
            const prompting = page.locator('[data-sb-panel="prompting"]');
            await prompting.locator('#openai_preset_import_file').setInputFiles({
                name: 'imported-caching-fixture.json',
                mimeType: 'application/json',
                buffer: Buffer.from(JSON.stringify({ chat_completion_source: 'openrouter', temperature: 0.62, enableSystemPromptCache: false, cachingAtDepth: 9 })),
            });
            await expect(prompting.locator('#settings_preset_openai option:checked')).toHaveText('imported-caching-fixture');
            await expect(page.locator(IDS.master)).toBeChecked();
            await expect(page.locator(IDS.depth)).toHaveValue('2');
            expect(server.saves).toHaveLength(0);
            const preset = await page.evaluate(async () => (await import('/scripts/openai.js')).getChatCompletionPreset());
            expect(Object.keys(preset)).not.toContain('enableSystemPromptCache');
            expect(Object.keys(preset)).not.toContain('cachingAtDepth');
        });
    });
}
