/* global document, window */
import { expect, test } from '@playwright/test';
import { APP_URL, dismissOnboardingIfPresent, dismissOpenDialogIfPresent, waitForAnimationFrames } from './chat-scroll-regression-helpers.js';

test.describe.configure({ mode: 'default' });
test.use({ serviceWorkers: 'block' });

const BILLING_WARNING = 'Using allowed and/or ignored providers forces PAYG and adds a 5% markup.';
const HTML_PAYLOAD = '<img data-nanogpt-injected src=x onerror="window.__nanogptInjected=true">';
const NEW_PROVIDER = 'future-provider-2026';
const ROUTING_KEYS = ['nanogpt_provider', 'nanogpt_allowed_providers', 'nanogpt_ignored_providers', 'nanogpt_payg_override'];
const MODEL_CASES = [
    { id: 'gpt-4o-mini', name: 'Nano Tiny', subscription: { included: true, inputTokenMultiplier: 1 }, badge: ['Sub'] },
    { id: 'deepseek/deepseek-v3.1', name: 'DeepSeek Friendly', subscription: { included: true, inputTokenMultiplier: 2 }, badge: ['Sub (2x)'] },
    { id: 'openai/gpt-4.1', name: 'Premium Friendly', subscription: { included: false, note: 'Not included in subscription' }, badge: ['Not in Sub'] },
    { id: 'qwen/qwen3-32b', name: 'No Subscription Metadata', badge: [] },
    { id: 'test/unsafe-fields', name: `Unsafe ${HTML_PAYLOAD}`, context_length: HTML_PAYLOAD, subscription: { included: HTML_PAYLOAD, inputTokenMultiplier: HTML_PAYLOAD, note: HTML_PAYLOAD }, badge: [] },
    { id: 'test/unsafe-multiplier', name: 'Malformed Multiplier', subscription: { included: true, inputTokenMultiplier: HTML_PAYLOAD }, badge: ['Sub'] },
    { id: 'test/unsafe-note', name: 'Unsafe Note', subscription: { included: false, note: HTML_PAYLOAD }, badge: ['Not in Sub'] },
    { id: 'test/object-note', name: 'Malformed Note', subscription: { included: false, note: { html: HTML_PAYLOAD } }, badge: ['Not in Sub'] },
];
const MODELS = MODEL_CASES.map(({ badge, ...model }) => ({
    context_length: 128000,
    pricing: { prompt: 0.15, completion: 0.6 },
    capabilities: { vision: true, reasoning: true, tool_calling: true },
    ...model,
}));
const PROVIDERS = { supportsProviderSelection: true, providers: ['chutes', 'cerebras', NEW_PROVIDER] };

async function installRoutes(page, baseURL) {
    const origin = new URL(baseURL).origin;
    expect(['127.0.0.1', 'localhost', '[::1]']).toContain(new URL(baseURL).hostname);
    const discovery = new Map([
        [MODELS[1].id, { json: { supportsProviderSelection: true, providers: ['cerebras'] } }],
        [MODELS[2].id, { json: { supportsProviderSelection: false, providers: [] } }],
        [MODELS[3].id, { status: 503, json: { error: 'Discovery unavailable' } }],
    ]);
    const held = [];
    await page.context().route('**/*', async route => {
        const url = new URL(route.request().url());
        if (url.origin !== origin) return route.abort();
        if (url.pathname === '/api/backends/chat-completions/status') {
            return route.fulfill({ json: { data: MODELS } });
        }
        if (url.pathname === '/api/nanogpt/models/providers') {
            const response = discovery.get(route.request().postDataJSON().model);
            if (response === 'hold') {
                held.push(route);
                return;
            }
            if (response === 'abort') return route.abort();
            return route.fulfill(response ?? { json: PROVIDERS });
        }
        if (url.pathname === '/api/nanogpt/credits') {
            return route.fulfill({ json: { balance: 0, credits: 0 } });
        }
        // Only local data APIs reach the temporary server; all inference and unknown APIs are blocked.
        if (url.pathname.startsWith('/api/') && !/^\/api\/(settings|secrets|presets|characters|chats|groups|avatars|backgrounds|worldinfo|content|themes|quick-replies|users|stats|tokenizers)\//.test(url.pathname)
            && !['/api/ping', '/api/extensions/discover'].includes(url.pathname)) {
            return route.abort();
        }
        return route.continue();
    });
    return { discovery, held };
}

async function openApi(page) {
    await page.waitForFunction(() => !document.getElementById('preloader'), null, { timeout: 60000 });
    await page.waitForFunction(async () => (await import('/script.js')).settingsReady || document.querySelector('dialog[open] .onboarding'));
    await dismissOnboardingIfPresent(page);
    // The shared helper can match the input's data-result before the actual Save control.
    const welcomeSave = page.locator('dialog[open]:has(.onboarding) .popup-button-ok');
    if (await welcomeSave.isVisible()) await welcomeSave.click();
    await dismissOpenDialogIfPresent(page);
    await page.waitForFunction(async () => (await import('/script.js')).settingsReady);
    await page.waitForFunction(() => typeof window.SillyBunnyShell?.openTab === 'function');
    await page.evaluate(() => window.SillyBunnyShell.openTab('left', 'api'));
    await expect(page.locator('#main_api')).toBeVisible();
}

async function loadRoutingSettings(page, overrides = {}) {
    await page.evaluate(async ({ keys, overrides }) => {
        const { getRequestHeaders } = await import('/script.js');
        const { loadOpenAISettings, oai_settings } = await import('/scripts/openai.js');
        const response = await fetch('/api/settings/get', { method: 'POST', headers: getRequestHeaders(), body: '{}' });
        if (!response.ok) throw new Error(`Settings read failed: ${response.status}`);
        const settings = structuredClone(oai_settings);
        for (const key of keys) delete settings[key];
        loadOpenAISettings(await response.json(), Object.assign(settings, overrides));
    }, { keys: ROUTING_KEYS, overrides });
}

async function connectNanoGpt(page) {
    await page.locator('#main_api').selectOption('openai');
    await page.locator('#chat_completion_source').selectOption('nanogpt');
    await page.locator('#api_key_nanogpt').fill('nanogpt-browser-regression-not-a-real-key');
    const status = page.waitForResponse('**/api/backends/chat-completions/status');
    await page.locator('#api_button_openai').click();
    expect((await status).ok()).toBe(true);
    await expect(page.locator('#model_nanogpt_select option')).toHaveCount(MODELS.length);
}

async function setupNanoGpt(page, baseURL) {
    const routes = await installRoutes(page, baseURL);
    await page.goto(APP_URL, { waitUntil: 'domcontentloaded' });
    await openApi(page);
    await page.addLocatorHandler(page.locator('#qig-setup-wizard'), async wizard => {
        await wizard.getByRole('button', { name: 'Skip', exact: true }).click();
    });
    await loadRoutingSettings(page, { nanogpt_model: MODELS[0].id, bind_preset_to_connection: false });
    await connectNanoGpt(page);
    return routes;
}

async function openPicker(page, mobile, id, source) {
    const menu = mobile
        ? page.locator(`.sb-inline-select-picker-menu[data-sb-model-id-picker-menu-source="${source}"]`)
        : page.locator(`#select2-${id}-results`);
    if (!await menu.isVisible()) {
        await page.locator(mobile ? `#${id}_picker:visible, #${id}:visible` : `#${id} + .select2 .select2-selection`).click();
    }
    await expect(menu).toBeVisible();
    return menu;
}

function pickerRow(menu, mobile, label) {
    return menu.locator(mobile ? 'button[role="option"]' : '.select2-results__option').filter({ hasText: label });
}

async function chooseModel(page, mobile, model) {
    const menu = await openPicker(page, mobile, 'model_nanogpt_select', 'nanogpt-model');
    await pickerRow(menu, mobile, model.name).click();
    await expect(page.locator('#model_nanogpt_select')).toHaveValue(model.id);
}

async function toggleProvider(page, mobile, kind, label, remove = false) {
    const id = `nanogpt_${kind}_providers`;
    if (remove && !mobile) {
        await page.locator(`#${id} + .select2 .select2-selection__choice`).filter({ hasText: label }).locator('.select2-selection__choice__remove').click();
    } else {
        const menu = await openPicker(page, mobile, id, `nanogpt-${kind}-providers`);
        const option = pickerRow(menu, mobile, label);
        await expect(option, `${kind} provider '${label}' must be ${remove ? 'removable' : 'selectable'}`).toBeVisible();
        await expect(option).toBeEnabled();
        await option.click();
    }
    await page.getByRole('heading', { name: 'API', exact: true, level: 2 }).locator('..').click({ position: { x: 8, y: 8 } });
}

async function expectRouting(page, allowed, ignored, payg) {
    await expect.poll(() => page.evaluate(async () => {
        const { oai_settings } = await import('/scripts/openai.js');
        const selected = id => Array.from(document.getElementById(id).selectedOptions, option => option.value).sort();
        return {
            allowed: oai_settings.nanogpt_allowed_providers,
            ignored: oai_settings.nanogpt_ignored_providers,
            payg: oai_settings.nanogpt_payg_override,
            selectedAllowed: selected('nanogpt_allowed_providers'),
            selectedIgnored: selected('nanogpt_ignored_providers'),
        };
    })).toEqual({ allowed, ignored, payg, selectedAllowed: [...allowed].sort(), selectedIgnored: [...ignored].sort() });
    await expect(page.locator('#nanogpt_payg_override')).toBeChecked({ checked: payg });
}

async function screenshot(page, testInfo, name) {
    const path = testInfo.outputPath(`${name}.png`);
    await page.screenshot({ path });
    await testInfo.attach(name, { path, contentType: 'image/png' });
}

for (const mobile of [false, true]) {
    const layout = mobile ? 'mobile' : 'desktop';
    test.describe(`NanoGPT ${layout}`, () => {
        test.use({
            viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 },
            isMobile: mobile,
            hasTouch: mobile,
        });

        if (mobile) {
            test('provider picker supports keyboard opening and closing without closing the API panel', async ({ page, baseURL }) => {
                await setupNanoGpt(page, baseURL);
                const picker = page.locator('#nanogpt_allowed_providers_picker');
                const menu = page.locator('#nanogpt_allowed_providers_menu');
                await expect(picker).toHaveText('Select providers');
                await picker.focus();
                await page.keyboard.press('Enter');
                await expect(picker).toHaveAttribute('aria-expanded', 'true');
                await expect(menu).toBeVisible();
                await page.keyboard.press('Escape');
                await expect(menu).toBeHidden();
                await expect(picker).toHaveAttribute('aria-expanded', 'false');
                await expect(picker).toBeVisible();
            });
        }

        test('model picker renders subscription metadata safely and keeps original IDs', async ({ page, baseURL }, testInfo) => {
            await setupNanoGpt(page, baseURL);
            const menu = await openPicker(page, mobile, 'model_nanogpt_select', 'nanogpt-model');
            await screenshot(page, testInfo, `${layout}-model-picker`);
            for (const model of MODEL_CASES) {
                const row = pickerRow(menu, mobile, model.name);
                await expect(row.locator('strong')).toHaveText(model.name);
                await expect(row.locator('small[title]')).toHaveText(model.badge);
            }
            const first = pickerRow(menu, mobile, MODELS[0].name);
            await expect(first).toContainText('128000 ctx');
            await expect(first).toContainText('$0.15/$0.6 in/out Mtoken');
            for (const capability of ['vision', 'reasoning', 'tool calling']) {
                await expect(first.locator(`[aria-label="This model supports ${capability}"]`)).toHaveCount(1);
            }
            await expect(pickerRow(menu, mobile, MODELS[2].name).locator('small[title]')).toHaveAttribute('title', 'Not included in subscription');
            await expect(pickerRow(menu, mobile, MODELS[4].name)).toContainText(`${HTML_PAYLOAD} ctx`);
            await expect(pickerRow(menu, mobile, MODELS[6].name).locator('small[title]')).toHaveAttribute('title', HTML_PAYLOAD);
            await expect(page.locator('[data-nanogpt-injected]')).toHaveCount(0);
            expect(await page.evaluate(() => window.__nanogptInjected)).toBeUndefined();
            await chooseModel(page, mobile, MODELS[1]);
            expect(await page.evaluate(async () => (await import('/scripts/openai.js')).oai_settings.nanogpt_model)).toBe(MODELS[1].id);
        });

        test('provider controls preserve restrictions through discovery, reload and removal', async ({ page, baseURL }, testInfo) => {
            test.setTimeout(90000);
            const routes = await setupNanoGpt(page, baseURL);
            const billing = page.locator('#nanogpt_billing_warning');
            const warning = page.locator('#nanogpt_provider_warning');
            await expectRouting(page, [], [], false);
            await expect(billing).toBeHidden();
            const allowedPicker = page.locator('#nanogpt_allowed_providers_picker');
            await expect(allowedPicker).toBeVisible({ visible: mobile });
            await expect(allowedPicker).toHaveText('Select providers');
            const modelField = page.locator(mobile ? '#model_nanogpt_select' : '#model_nanogpt_select + .select2 .select2-selection');
            const modelBox = await modelField.boundingBox();
            const modelRadius = await modelField.evaluate(element => window.getComputedStyle(element).borderRadius);
            for (const kind of ['allowed', 'ignored']) {
                const field = page.locator(mobile ? `#nanogpt_${kind}_providers_picker` : `#nanogpt_${kind}_providers + .select2 .select2-selection`);
                const box = await field.boundingBox();
                expect(box.x).toBeCloseTo(modelBox.x, 0);
                expect(box.width).toBeCloseTo(modelBox.width, 0);
                expect(box.height).toBeCloseTo(modelBox.height, 0);
                await expect(field).toHaveCSS('border-radius', modelRadius);
            }
            await screenshot(page, testInfo, `${layout}-provider-alignment`);
            await toggleProvider(page, mobile, 'allowed', 'Chutes');
            await expect(billing).toHaveText(BILLING_WARNING);
            await expect(billing).toBeVisible();
            await expectRouting(page, ['chutes'], [], false);
            await toggleProvider(page, mobile, 'ignored', 'Cerebras');
            await toggleProvider(page, mobile, 'allowed', 'Chutes', true);
            await expectRouting(page, [], ['cerebras'], false);
            await expect(billing).toBeVisible();
            await toggleProvider(page, mobile, 'ignored', 'Cerebras', true);
            await expect(billing).toBeHidden();
            await expect(warning).toBeHidden();
            await page.locator('#nanogpt_payg_override').check();
            await expectRouting(page, [], [], true);
            await expect(billing).toBeHidden();
            await page.locator('#nanogpt_payg_override').uncheck();

            await toggleProvider(page, mobile, 'allowed', 'Chutes');
            await toggleProvider(page, mobile, 'allowed', NEW_PROVIDER);
            await toggleProvider(page, mobile, 'ignored', 'Cerebras');
            await expectRouting(page, ['chutes', NEW_PROVIDER], ['cerebras'], false);
            await expect(allowedPicker).toHaveText(`Chutes, ${NEW_PROVIDER}`);
            await expect(page.locator('#nanogpt_ignored_providers_picker')).toHaveText('Cerebras');
            expect((await allowedPicker.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(mobile ? 44 : 0);
            await page.locator('#nanogpt_payg_override').scrollIntoViewIfNeeded();
            await screenshot(page, testInfo, `${layout}-provider-controls`);
            await page.locator('#nanogpt_payg_override').check();
            const savedResponse = page.waitForResponse('**/api/settings/save');
            await page.evaluate(async () => (await import('/script.js')).saveSettings());
            expect((await savedResponse).ok()).toBe(true);
            const stored = await page.evaluate(async () => {
                const { getRequestHeaders } = await import('/script.js');
                const response = await fetch('/api/settings/get', { method: 'POST', headers: getRequestHeaders(), body: '{}' });
                return JSON.parse((await response.json()).settings).oai_settings;
            });
            expect(stored).toMatchObject({ nanogpt_allowed_providers: ['chutes', NEW_PROVIDER], nanogpt_ignored_providers: ['cerebras'], nanogpt_payg_override: true });
            await page.reload({ waitUntil: 'domcontentloaded' });
            await openApi(page);
            await connectNanoGpt(page);
            await expectRouting(page, ['chutes', NEW_PROVIDER], ['cerebras'], true);
            await page.locator('#nanogpt_payg_override').uncheck();
            await expect(billing).toBeVisible();

            await chooseModel(page, mobile, MODELS[1]);
            await expect(page.locator('#nanogpt_allowed_providers option[value="chutes"]')).toBeDisabled();
            await expect(warning).toBeVisible();
            await expectRouting(page, ['chutes', NEW_PROVIDER], ['cerebras'], false);
            await chooseModel(page, mobile, MODELS[2]);
            await expect(page.locator('#nanogpt_allowed_providers option[value="cerebras"]')).toBeDisabled();
            await expect(warning).toBeVisible();
            await expectRouting(page, ['chutes', NEW_PROVIDER], ['cerebras'], false);

            const failedDiscovery = page.waitForResponse(response => response.url().endsWith('/api/nanogpt/models/providers') && response.status() === 503);
            await chooseModel(page, mobile, MODELS[3]);
            await failedDiscovery;
            await expectRouting(page, ['chutes', NEW_PROVIDER], ['cerebras'], false);
            routes.discovery.set(MODELS[0].id, 'abort');
            const disconnectedDiscovery = page.waitForEvent('requestfailed', request => request.url().endsWith('/api/nanogpt/models/providers'));
            await chooseModel(page, mobile, MODELS[0]);
            await disconnectedDiscovery;
            await expectRouting(page, ['chutes', NEW_PROVIDER], ['cerebras'], false);

            await chooseModel(page, mobile, MODELS[1]);
            routes.discovery.set(MODELS[0].id, 'hold');
            await chooseModel(page, mobile, MODELS[0]);
            await expect.poll(() => routes.held.length).toBeGreaterThan(0);
            await chooseModel(page, mobile, MODELS[1]);
            await expect(page.locator('#nanogpt_allowed_providers option[value="chutes"]')).toBeDisabled();
            const staleResponses = routes.held.map(route => page.waitForResponse(response => response.request() === route.request()));
            await Promise.all(routes.held.map(route => route.fulfill({ json: { ...PROVIDERS, providers: [...PROVIDERS.providers, 'stale-only-provider'] } })));
            await Promise.all(staleResponses.map(async response => (await response).finished()));
            await waitForAnimationFrames(page, 3);
            await expect(page.locator('#nanogpt_allowed_providers option[value="stale-only-provider"]')).toHaveCount(0);
            await expect(page.locator('#nanogpt_allowed_providers option[value="chutes"]')).toBeDisabled();
            await expect(warning).toBeVisible();
            await expectRouting(page, ['chutes', NEW_PROVIDER], ['cerebras'], false);
            await page.locator('#nanogpt_payg_override').scrollIntoViewIfNeeded();
            await screenshot(page, testInfo, `${layout}-inapplicable-providers`);

            await toggleProvider(page, mobile, 'allowed', 'Chutes', true);
            await expectRouting(page, [NEW_PROVIDER], ['cerebras'], false);
            await toggleProvider(page, mobile, 'allowed', NEW_PROVIDER, true);
            await expectRouting(page, [], ['cerebras'], false);
            await expect(billing).toBeVisible();
            await toggleProvider(page, mobile, 'ignored', 'Cerebras', true);
            await expectRouting(page, [], [], false);
            await expect(billing).toBeHidden();
            await expect(warning).toBeHidden();
        });
    });
}

test('NanoGPT runtime settings and presets retain defaults, legacy migration and independent connections', async ({ page, baseURL }) => {
    test.setTimeout(90000);
    await setupNanoGpt(page, baseURL);
    const cases = [
        { input: {}, allowed: [], ignored: [], payg: false },
        { input: { nanogpt_provider: 'chutes' }, allowed: ['chutes'], ignored: [], payg: false },
        { input: { nanogpt_provider: 'chutes', nanogpt_allowed_providers: [] }, allowed: [], ignored: [], payg: false },
        { input: { nanogpt_provider: 'chutes', nanogpt_ignored_providers: [] }, allowed: [], ignored: [], payg: false },
        { input: { nanogpt_allowed_providers: ['ImportedProvider-V2'], nanogpt_ignored_providers: ['imported-ignored-v2'], nanogpt_payg_override: true }, allowed: ['ImportedProvider-V2'], ignored: ['imported-ignored-v2'], payg: true },
    ];
    for (const { input, allowed, ignored, payg } of cases) {
        await loadRoutingSettings(page, input);
        await expectRouting(page, allowed, ignored, payg);
        await loadRoutingSettings(page);
        const payloads = await page.evaluate(async ({ input, model }) => {
            const { ChatCompletionService } = await import('/scripts/custom-request.js');
            const preset = { chat_completion_source: 'nanogpt', nanogpt_model: model };
            return [
                await ChatCompletionService.presetToGeneratePayload({ ...preset, ...input }, {}, { messages: [] }),
                await ChatCompletionService.presetToGeneratePayload(preset, {}, { ...input, messages: [] }),
            ];
        }, { input, model: MODELS[0].id });
        for (const payload of payloads) {
            expect(payload).toMatchObject({ nanogpt_allowed_providers: allowed, nanogpt_ignored_providers: ignored, nanogpt_payg_override: payg });
        }
        await expectRouting(page, [], [], false);
    }

    for (const { preset, override, allowed, ignored } of [
        { preset: { nanogpt_allowed_providers: ['chutes'], nanogpt_ignored_providers: ['cerebras'] }, override: { nanogpt_ignored_providers: [] }, allowed: ['chutes'], ignored: [] },
        { preset: { nanogpt_allowed_providers: ['chutes'], nanogpt_ignored_providers: ['cerebras'] }, override: { nanogpt_allowed_providers: [] }, allowed: [], ignored: ['cerebras'] },
        { preset: { nanogpt_allowed_providers: null, nanogpt_ignored_providers: ['cerebras'] }, override: { nanogpt_ignored_providers: [] }, allowed: null, ignored: [] },
        { preset: { nanogpt_provider: 'chutes' }, override: { nanogpt_ignored_providers: ['cerebras'] }, allowed: ['chutes'], ignored: ['cerebras'] },
        { preset: { nanogpt_allowed_providers: ['chutes'], nanogpt_ignored_providers: ['cerebras'] }, override: { nanogpt_provider: NEW_PROVIDER }, allowed: [NEW_PROVIDER], ignored: [] },
    ]) {
        const payloads = await page.evaluate(async ({ preset, override, model }) => {
            const { ChatCompletionService } = await import('/scripts/custom-request.js');
            preset = { chat_completion_source: 'nanogpt', nanogpt_model: model, ...preset };
            return [
                await ChatCompletionService.presetToGeneratePayload(preset, override, { messages: [] }),
                await ChatCompletionService.presetToGeneratePayload(preset, {}, { ...override, messages: [] }),
            ];
        }, { preset, override, model: MODELS[0].id });
        for (const payload of payloads) {
            expect(payload).toMatchObject({ nanogpt_allowed_providers: allowed, nanogpt_ignored_providers: ignored });
        }
    }

    const presetName = 'NanoGPT browser routing regression';
    await page.evaluate(async ({ name, model }) => {
        const { getChatCompletionPreset, oai_settings } = await import('/scripts/openai.js');
        const { getPresetManager } = await import('/scripts/preset-manager.js');
        const preset = getChatCompletionPreset({
            ...oai_settings,
            bind_preset_to_connection: true,
            nanogpt_model: model,
            nanogpt_allowed_providers: ['ImportedProvider-V2'],
            nanogpt_ignored_providers: ['imported-ignored-v2'],
            nanogpt_payg_override: true,
        });
        await getPresetManager('openai').savePreset(name, preset, { skipUpdate: true });
    }, { name: presetName, model: MODELS[1].id });

    for (const linked of [false, true]) {
        await loadRoutingSettings(page, { nanogpt_model: MODELS[0].id, nanogpt_allowed_providers: ['chutes'], bind_preset_to_connection: linked });
        const savedKeys = await page.evaluate(async () => Object.keys((await import('/scripts/openai.js')).getChatCompletionPreset()));
        expect(ROUTING_KEYS.every(key => savedKeys.includes(key))).toBe(linked);
        expect(ROUTING_KEYS.every(key => !savedKeys.includes(key))).toBe(!linked);
        await page.evaluate(async name => {
            const { openai_setting_names } = await import('/scripts/openai.js');
            const { getPresetManager } = await import('/scripts/preset-manager.js');
            await getPresetManager('openai').selectPreset(String(openai_setting_names[name]));
        }, presetName);
        await expectRouting(page, linked ? ['ImportedProvider-V2'] : ['chutes'], linked ? ['imported-ignored-v2'] : [], linked);
        expect(await page.evaluate(async () => (await import('/scripts/openai.js')).oai_settings.nanogpt_model)).toBe(MODELS[linked ? 1 : 0].id);
    }
    await page.reload({ waitUntil: 'domcontentloaded' });
    await openApi(page);
    await connectNanoGpt(page);
    await expectRouting(page, ['ImportedProvider-V2'], ['imported-ignored-v2'], true);
    await expect(page.locator('#model_nanogpt_select')).toHaveValue(MODELS[1].id);

    await page.evaluate(async name => {
        const { getPresetManager } = await import('/scripts/preset-manager.js');
        await getPresetManager('openai').savePreset(name, {
            nanogpt_allowed_providers: [], nanogpt_ignored_providers: [], nanogpt_payg_override: false,
        }, { skipUpdate: true });
    }, presetName);
    await page.setInputFiles('#openai_preset_import_file', {
        name: `${presetName}.json`,
        mimeType: 'application/json',
        buffer: Buffer.from(JSON.stringify({ chat_completion_source: 'nanogpt', nanogpt_model: MODELS[0].id, nanogpt_provider: 'chutes', nanogpt_payg_override: false })),
    });
    await page.locator('dialog[open]').filter({ hasText: 'Preset name already exists. Overwrite?' }).locator('.popup-button-ok').click();
    await expectRouting(page, ['chutes'], [], false);
});
