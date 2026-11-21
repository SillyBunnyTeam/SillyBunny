import { expect, test } from '@playwright/test';
import { testSetup } from './frontend/frontent-test-utils.js';
import { APP_URL, dismissOpenDialogIfPresent, waitForAnimationFrames } from './chat-scroll-regression-helpers.js';
import { protectMaintainerServer } from './helpers/maintainer-server.js';
import { keepSavesInPage } from './helpers/saves-in-page.js';
import { keepWelcomeClosed } from './helpers/welcome-dialog.js';

test.use({ serviceWorkers: 'block' });

const BILLING_WARNING = 'Using allowed and/or ignored providers forces PAYG and adds a 5% markup.';
const HTML_PAYLOAD = '<img data-nanogpt-injected src=x onerror="window.__nanogptInjected=true">';
const NEW_PROVIDER = 'future-provider-2026';
const ROUTING_KEYS = ['nanogpt_provider', 'nanogpt_allowed_providers', 'nanogpt_ignored_providers', 'nanogpt_payg_override', 'nanogpt_service_tier'];
const MODEL_CASES = [
    { id: 'gpt-4o-mini', name: 'Nano Tiny', subscription: { included: true, inputTokenMultiplier: 1 }, supported_service_tiers: ['flex'], badge: ['Sub'] },
    { id: 'deepseek/deepseek-v3.1', name: 'DeepSeek Friendly', subscription: { included: true, inputTokenMultiplier: 2 }, badge: ['Sub (2x)'] },
    { id: 'openai/gpt-4.1', name: 'Premium Friendly', subscription: { included: false, note: 'Not included in subscription' }, supported_service_tiers: ['flex', 'fast', 'priority'], badge: ['Not in Sub'] },
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
    const catalogue = { json: [{ id: 'chutes', label: 'Chutes' }, { id: 'cerebras', label: 'Cerebras' }] };
    // The spec saves settings, presets and a key, then reloads and reads them back, so they stay in the page and never reach the server.
    await protectMaintainerServer(page);
    await keepSavesInPage(page);
    await page.context().route('**/*', async route => {
        const url = new URL(route.request().url());
        if (url.origin !== origin) return route.abort();
        if (url.pathname === '/api/backends/chat-completions/status') {
            return route.fulfill({ json: { data: MODELS } });
        }
        if (url.pathname === '/api/nanogpt/providers') return route.fulfill(catalogue);
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
        // A fallback, not a continue: the context route that keeps Welcome closed answers the settings request.
        return route.fallback();
    });
    return { discovery, held, catalogue };
}

async function openApi(page) {
    await page.waitForFunction(() => !document.getElementById('preloader'), null, { timeout: 60000 });
    await testSetup.waitForAppReady({ page });
    await dismissOpenDialogIfPresent(page);
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
    await keepWelcomeClosed(page.context());
    await page.goto(APP_URL, { waitUntil: 'domcontentloaded' });
    await openApi(page);
    await loadRoutingSettings(page, { nanogpt_model: MODELS[0].id, bind_preset_to_connection: false });
    await connectNanoGpt(page);
    return routes;
}

/** The select row Connections builds around a native select, and the trigger a user presses. */
function selectRow(page, id) {
    return page.locator(`.ds-select-row[data-sb-editor-field="${id}"]`);
}

function rowTrigger(page, id) {
    return selectRow(page, id).locator('.ds-select-row__trigger');
}

/** The shared picker: a popover on desktop, a bottom sheet on phones. */
function pickerSurface(page, mobile) {
    return page.locator(mobile ? '.sb-picker-sheet' : '.sb-picker');
}

async function openPicker(page, mobile, id) {
    const menu = pickerSurface(page, mobile);
    if (!await menu.isVisible()) {
        await rowTrigger(page, id).click();
    }
    await expect(menu).toBeVisible();
    await expect(rowTrigger(page, id)).toHaveAttribute('aria-expanded', 'true');
    return menu;
}

async function closePicker(page, mobile, id) {
    const menu = pickerSurface(page, mobile);
    await expect(menu.locator('.sb-picker__search')).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(menu).toBeHidden();
    await expect(rowTrigger(page, id)).toHaveAttribute('aria-expanded', 'false');
}

function pickerRow(menu, label) {
    return menu.getByRole('option').filter({ hasText: label });
}

async function chooseModel(page, mobile, model) {
    const menu = await openPicker(page, mobile, 'model_nanogpt_select');
    await pickerRow(menu, model.name).click();
    await expect(pickerSurface(page, mobile)).toBeHidden();
    await expect(page.locator('#model_nanogpt_select')).toHaveValue(model.id);
    await expect(rowTrigger(page, 'model_nanogpt_select').locator('.ds-select-row__value')).toHaveText(model.name);
}

async function toggleProvider(page, mobile, kind, label, remove = false) {
    const id = `nanogpt_${kind}_providers`;
    const menu = await openPicker(page, mobile, id);
    const option = pickerRow(menu, label);
    await expect(option, `${kind} provider '${label}' must be ${remove ? 'removable' : 'selectable'}`).toBeVisible();
    await expect(option).toBeEnabled();
    await expect(option).toHaveAttribute('aria-selected', String(remove));
    await option.click();
    await expect(option).toHaveAttribute('aria-selected', String(!remove));
    await closePicker(page, mobile, id);
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
                const picker = rowTrigger(page, 'nanogpt_allowed_providers');
                const menu = pickerSurface(page, mobile);
                await expect(picker.locator('.ds-select-row__value')).toHaveText('Select providers');
                await picker.focus();
                await page.keyboard.press('Enter');
                await expect(picker).toHaveAttribute('aria-expanded', 'true');
                await expect(menu).toBeVisible();
                await page.keyboard.press('Escape');
                await expect(menu).toBeHidden();
                await expect(picker).toHaveAttribute('aria-expanded', 'false');
                await expect(picker).toBeVisible();
                await expect(page.locator('#main_api')).toBeVisible();
            });
        }

        test('model picker renders subscription metadata safely and keeps original IDs', async ({ page, baseURL }, testInfo) => {
            await setupNanoGpt(page, baseURL);
            const menu = await openPicker(page, mobile, 'model_nanogpt_select');
            await screenshot(page, testInfo, `${layout}-model-picker`);
            // The shared picker shows the model name as the row label and its details as the subtitle.
            for (const model of MODEL_CASES) {
                const row = pickerRow(menu, model.name);
                await expect(row.locator('.sb-picker__label')).toHaveText(model.name);
                await expect(row.locator('.sb-picker__subtitle small[title]')).toHaveText(model.badge);
            }
            const first = pickerRow(menu, MODELS[0].name);
            await expect(first.locator('.sb-picker__subtitle')).toContainText('128000 ctx');
            await expect(first.locator('.sb-picker__subtitle')).toContainText('$0.15/$0.6 in/out Mtoken');
            for (const capability of ['vision', 'reasoning', 'tool calling']) {
                await expect(first.getByRole('img', { name: `This model supports ${capability}` })).toHaveCount(1);
                await expect(first.getByRole('img', { name: `This model supports ${capability}` })).toHaveAttribute('title', `This model supports ${capability}`);
            }
            await expect(first.locator('small[title]')).toHaveAttribute('title', 'Included in subscription');
            await expect(pickerRow(menu, MODELS[1].name).locator('small[title]')).toHaveAttribute('title', 'Included in subscription - Input Multiplier: 2x');
            await expect(pickerRow(menu, MODELS[2].name).locator('small[title]')).toHaveAttribute('title', 'Not included in subscription');
            await expect(pickerRow(menu, MODELS[3].name).locator('.sb-picker__subtitle')).not.toContainText('Sub');
            await expect(pickerRow(menu, MODELS[4].name).locator('.sb-picker__subtitle')).toContainText(`${HTML_PAYLOAD} ctx`);
            await expect(pickerRow(menu, MODELS[6].name).locator('small[title]')).toHaveAttribute('title', HTML_PAYLOAD);
            await expect(pickerRow(menu, MODELS[7].name).locator('small[title]')).toHaveAttribute('title', 'Not in Sub');
            // Details are part of what search matches.
            await menu.locator('.sb-picker__search').fill('Not in Sub');
            await expect(menu.getByRole('option')).toHaveCount(MODEL_CASES.filter(model => model.badge.includes('Not in Sub')).length);
            await menu.locator('.sb-picker__search').fill('');
            await expect(menu.getByRole('option')).toHaveCount(MODELS.length);
            await expect(page.locator('[data-nanogpt-injected]')).toHaveCount(0);
            expect(await page.evaluate(() => window.__nanogptInjected)).toBeUndefined();
            await chooseModel(page, mobile, MODELS[1]);
            expect(await page.evaluate(async () => (await import('/scripts/openai.js')).oai_settings.nanogpt_model)).toBe(MODELS[1].id);
        });

        test('the model row describes the chosen model and follows a value written through select2', async ({ page, baseURL }, testInfo) => {
            await setupNanoGpt(page, baseURL);
            const detail = selectRow(page, 'model_nanogpt_select').locator('.ds-select-row__detail');
            const value = rowTrigger(page, 'model_nanogpt_select').locator('.ds-select-row__value');
            await expect(value).toHaveText(MODELS[0].name);
            await expect(detail).toContainText('128000 ctx');
            await expect(detail).toContainText('$0.15/$0.6 in/out Mtoken');
            await expect(detail.getByRole('img', { name: 'This model supports vision' })).toHaveCount(1);
            await expect(detail.locator('small[title]')).toHaveAttribute('title', 'Included in subscription');
            await expect(rowTrigger(page, 'model_nanogpt_select')).toHaveAttribute('aria-describedby', await detail.getAttribute('id'));
            await selectRow(page, 'model_nanogpt_select').scrollIntoViewIfNeeded();
            await screenshot(page, testInfo, `${layout}-model-details`);

            await chooseModel(page, mobile, MODELS[1]);
            await expect(detail.locator('small[title]')).toHaveAttribute('title', 'Included in subscription - Input Multiplier: 2x');

            // Upstream writes loaded values with trigger('change.select2'), which reaches no plain change listener.
            const writeThroughSelect2 = id => page.evaluate(model => {
                window.$('#model_nanogpt_select').val(model).trigger('change.select2');
            }, id);
            await writeThroughSelect2(MODELS[2].id);
            await expect(value).toHaveText(MODELS[2].name);
            await expect(detail.locator('small[title]')).toHaveAttribute('title', 'Not included in subscription');
            await writeThroughSelect2(MODELS[3].id);
            await expect(value).toHaveText(MODELS[3].name);
            await expect(detail).toContainText('128000 ctx');
            await expect(detail.locator('small[title]')).toHaveCount(0);

            // A model without catalogue metadata shows its name only.
            await page.evaluate(() => {
                const select = document.getElementById('model_nanogpt_select');
                select.append(new Option('Unlisted model', 'unlisted/model'));
                window.$(select).val('unlisted/model').trigger('change.select2');
            });
            await expect(value).toHaveText('Unlisted model');
            await expect(detail).toHaveCount(0);
            await expect(rowTrigger(page, 'model_nanogpt_select')).not.toHaveAttribute('aria-describedby', /.+/);
        });

        test('live catalogues and service tiers respect saved choices and PAYG eligibility', async ({ page, baseURL }, testInfo) => {
            const routes = await setupNanoGpt(page, baseURL);
            const tier = page.locator('#nanogpt_service_tier');
            const tierTrigger = rowTrigger(page, 'nanogpt_service_tier');
            const chooseTier = async (label, value) => {
                const menu = await openPicker(page, mobile, 'nanogpt_service_tier');
                await pickerRow(menu, label).click();
                await expect(pickerSurface(page, mobile)).toBeHidden();
                await expect(tier).toHaveValue(value);
                await expect(tierTrigger.locator('.ds-select-row__value')).toHaveText(label);
            };
            await expect(tier).toBeDisabled();
            await expect(tierTrigger).toBeDisabled();
            await page.locator('#nanogpt_payg_override').check();
            await expect(tierTrigger).toBeEnabled();
            await expect(tier.locator('option[value="flex"]')).toBeEnabled();
            await expect(tier.locator('option[value="priority"]')).toBeDisabled();
            const tierMenu = await openPicker(page, mobile, 'nanogpt_service_tier');
            await expect(pickerRow(tierMenu, 'Flex')).toBeEnabled();
            await expect(pickerRow(tierMenu, 'Priority')).toHaveAttribute('aria-disabled', 'true');
            await closePicker(page, mobile, 'nanogpt_service_tier');
            await chooseTier('Flex', 'flex');
            const getTier = () => page.evaluate(async () => {
                const { getNanoGptServiceTier, oai_settings } = await import('/scripts/openai.js');
                return (await getNanoGptServiceTier(oai_settings, oai_settings.nanogpt_model)) ?? null;
            });
            expect(await getTier()).toBe('flex');
            await page.locator('#nanogpt_payg_override').uncheck();
            expect(await getTier()).toBeNull();
            await expect(tier.locator('option[value="flex"]')).toBeDisabled();
            await toggleProvider(page, mobile, 'ignored', 'Cerebras');
            expect(await getTier()).toBe('flex');
            await expect(page.locator('#nanogpt_payg_override')).not.toBeChecked();

            routes.catalogue.json = [{ id: 'brand-new', label: 'Live Provider' }];
            const refresh = () => page.evaluate(async () => {
                const { syncNanoGptProvidersForModel } = await import('/scripts/textgen-models.js');
                await syncNanoGptProvidersForModel('', '#nanogpt_allowed_providers');
            });
            await refresh();
            await expect(page.locator('#nanogpt_allowed_providers option[value="brand-new"]')).toHaveText('Live Provider');
            await expect(page.locator('#nanogpt_ignored_providers option[value="brand-new"]')).toHaveText('Live Provider');
            await expectRouting(page, [], ['cerebras'], false);
            routes.catalogue.status = 502;
            await refresh();
            await expect(page.locator('#nanogpt_allowed_providers option[value="brand-new"]')).toHaveCount(1);
            await expectRouting(page, [], ['cerebras'], false);
            routes.catalogue.status = 200;
            await toggleProvider(page, mobile, 'ignored', 'Cerebras', true);
            await chooseModel(page, mobile, MODELS[2]);
            await expect(tier.locator('option[value="priority"]')).toBeEnabled();
            await chooseTier('Priority', 'priority');
            expect(await getTier()).toBe('priority');
            await expect(page.locator('#nanogpt_payg_override')).not.toBeChecked();
            await tierTrigger.scrollIntoViewIfNeeded();
            // Touch layouts size row triggers to 44px; fine pointers keep the 32px floor and share the model row's trigger height.
            const modelTriggerHeight = (await rowTrigger(page, 'model_nanogpt_select').boundingBox()).height;
            const tierHeight = (await tierTrigger.boundingBox()).height;
            expect(tierHeight).toBeGreaterThanOrEqual(mobile ? 44 : 32);
            expect(tierHeight).toBeGreaterThanOrEqual(modelTriggerHeight);
            await screenshot(page, testInfo, `${layout}-service-tiers`);
        });

        test('provider controls preserve restrictions through discovery, reload and removal', async ({ page, baseURL }, testInfo) => {
            test.setTimeout(90000);
            const routes = await setupNanoGpt(page, baseURL);
            const billing = page.locator('#nanogpt_billing_warning');
            const warning = page.locator('#nanogpt_provider_warning');
            await expectRouting(page, [], [], false);
            await expect(billing).toBeHidden();
            const allowedPicker = rowTrigger(page, 'nanogpt_allowed_providers');
            await expect(allowedPicker).toBeVisible();
            await expect(allowedPicker.locator('.ds-select-row__value')).toHaveText('Select providers');
            const modelField = rowTrigger(page, 'model_nanogpt_select');
            const modelRow = await selectRow(page, 'model_nanogpt_select').boundingBox();
            const modelBox = await modelField.boundingBox();
            const modelRadius = await modelField.evaluate(element => window.getComputedStyle(element).borderRadius);
            for (const kind of ['allowed', 'ignored']) {
                const id = `nanogpt_${kind}_providers`;
                const field = rowTrigger(page, id);
                const row = await selectRow(page, id).boundingBox();
                const box = await field.boundingBox();
                // Row triggers size to their value and sit at the row's end, so rows share an edge and triggers share an end edge.
                expect(row.x).toBeCloseTo(modelRow.x, 0);
                expect(row.width).toBeCloseTo(modelRow.width, 0);
                expect(box.x + box.width).toBeCloseTo(modelBox.x + modelBox.width, 0);
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
            await expect(allowedPicker.locator('.ds-select-row__value')).toHaveText(`Chutes, ${NEW_PROVIDER}`);
            await expect(rowTrigger(page, 'nanogpt_ignored_providers').locator('.ds-select-row__value')).toHaveText('Cerebras');
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

test('tier payloads preserve preset precedence and isolate background connections', async ({ page, baseURL }) => {
    await setupNanoGpt(page, baseURL);
    const requests = [];
    await page.route('**/api/backends/*/generate', route => {
        requests.push(route.request().postDataJSON());
        return route.fulfill({ json: { choices: [{ message: { content: 'ok' }, text: 'ok' }] } });
    });
    const tiers = await page.evaluate(async ({ paidModel, subscriptionModel }) => {
        const { oai_settings } = await import('/scripts/openai.js');
        const { textgenerationwebui_settings } = await import('/scripts/textgen-settings.js');
        const { ChatCompletionService, TextCompletionService } = await import('/scripts/custom-request.js');
        const { ConnectionManagerRequestService } = await import('/scripts/extensions/shared.js');
        const context = window.SillyTavern.getContext();
        oai_settings.nanogpt_service_tier = oai_settings.openrouter_service_tier = 'priority';
        textgenerationwebui_settings.openrouter_service_tier = 'priority';
        const preset = { chat_completion_source: 'nanogpt', nanogpt_model: paidModel, nanogpt_service_tier: 'flex' };
        const convert = (preset, overrides = {}) => ChatCompletionService.presetToGeneratePayload(preset, {}, { model: preset.nanogpt_model ?? paidModel, messages: [], ...overrides });
        const payloads = [
            await convert({ ...preset, nanogpt_service_tier: undefined }),
            await convert(preset),
            await convert(preset, { service_tier: '', __connectionProfileRequestFields: ['service_tier'] }),
            await convert({ ...preset, nanogpt_model: subscriptionModel }),
            await convert({ ...preset, nanogpt_model: subscriptionModel }, { nanogpt_ignored_providers: ['cerebras'] }),
            await convert({ chat_completion_source: 'openrouter', openrouter_model: paidModel, openrouter_service_tier: 'flex' }),
            await TextCompletionService.presetToGeneratePayload({}, {}, { api_type: 'openrouter', model: paidModel, prompt: 'test' }),
            await TextCompletionService.presetToGeneratePayload({}, {}, { api_type: 'openrouter', model: paidModel, prompt: 'test', service_tier: 'flex' }),
        ];
        for (const source of ['nanogpt', 'openrouter', 'openrouter-text']) {
            const text = source === 'openrouter-text';
            const api = Object.entries(context.CONNECT_API_MAP).find(([, entry]) => text
                ? entry.selected === 'textgenerationwebui' && entry.type === 'openrouter'
                : entry.selected === 'openai' && entry.source === source)?.[0];
            const profile = { id: 'tier-test', api, model: paidModel, 'api-url': 'https://openrouter.ai/api' };
            context.extensionSettings.connectionManager.profiles.push(profile);
            for (const tier of [undefined, 'flex', 'default']) {
                profile['service-tier'] = tier;
                await ConnectionManagerRequestService.sendRequest(profile.id, 'test', 1, { includePreset: false, includeInstruct: false });
            }
            context.extensionSettings.connectionManager.profiles.pop();
        }
        const legacyRequest = { chat_completion_source: 'nanogpt', model: subscriptionModel, messages: [], service_tier: 'flex', nanogpt_provider: 'cerebras' };
        await ChatCompletionService.sendRequest(legacyRequest);
        await ChatCompletionService.sendRequest({ ...legacyRequest, nanogpt_allowed_providers: [], nanogpt_ignored_providers: [] });
        return payloads.map(payload => payload.service_tier ?? null);
    }, { paidModel: MODELS[2].id, subscriptionModel: MODELS[0].id });
    expect(tiers).toEqual([null, 'flex', null, null, 'flex', 'flex', null, 'flex']);
    expect(requests.map(request => request.service_tier ?? null)).toEqual([null, 'flex', null, null, 'flex', null, null, 'flex', null, 'flex', null]);
    expect(requests.every(request => !Object.hasOwn(request, '__connectionProfileRequestFields'))).toBe(true);
});
