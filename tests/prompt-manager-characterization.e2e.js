import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';

// Characterizes Prompt Manager behaviour through what it persists (the /api/settings/save payload).
// UI interactions live in `legacyDriver` so a replacement editor can reuse these assertions with its own driver.

test.use({ serviceWorkers: 'block', reducedMotion: 'reduce', viewport: { width: 1920, height: 1080 } });

const BASE_URL = process.env.SILLYBUNNY_TEST_BASE_URL || 'http://127.0.0.1:4444';
const GLOBAL_ORDER_ID = 100001;
const GENERIC_ORDER_ID = 100000;
const CHARACTER_ORDER_ID = 4242;
const FIXTURE_PRESET_NAME = 'SB Characterization Fixture';
const SETTER_VARIABLE = 'sb_pm_fixture_flag';

const bundledDefault = JSON.parse(readFileSync(new URL('../default/content/presets/openai/Default.json', import.meta.url), 'utf8'));

const FIXTURE_PROMPTS = [
    {
        identifier: 'sbFixtureInChat',
        name: 'Fixture In-Chat',
        role: 'user',
        content: 'In-chat fixture content',
        system_prompt: false,
        marker: false,
        injection_position: 1,
        injection_depth: 2,
        injection_order: 50,
        injection_trigger: ['swipe', 'quiet'],
        forbid_overrides: false,
    },
    {
        identifier: 'sbFixtureRelative',
        name: 'Fixture Relative',
        role: 'assistant',
        content: 'Relative fixture content',
        system_prompt: false,
        marker: false,
        injection_position: 0,
        injection_depth: 4,
        injection_order: 100,
        injection_trigger: [],
        forbid_overrides: false,
    },
    {
        identifier: 'sbFixtureSetter',
        name: 'Fixture Setter',
        role: 'system',
        content: `{{setglobalvar::${SETTER_VARIABLE}::on}}`,
        system_prompt: false,
        marker: false,
        injection_position: 0,
        injection_depth: 4,
        injection_order: 100,
        injection_trigger: [],
        forbid_overrides: false,
    },
    {
        identifier: 'sbFixtureDetached',
        name: 'Fixture Detached',
        role: 'system',
        content: 'Not in any order',
        system_prompt: false,
        marker: false,
        injection_position: 0,
        injection_depth: 4,
        injection_order: 100,
        injection_trigger: [],
        forbid_overrides: false,
    },
];

/** SillyTavern-shaped CC preset: bundled Default plus user prompts, a per-character order and a generic order. */
function buildFixturePreset() {
    const preset = structuredClone(bundledDefault);
    preset.prompts.push(...structuredClone(FIXTURE_PROMPTS));

    const globalOrder = preset.prompt_order.find(entry => entry.character_id === GLOBAL_ORDER_ID);
    globalOrder.order.splice(1, 0,
        { identifier: 'sbFixtureInChat', enabled: true },
        { identifier: 'sbFixtureRelative', enabled: true },
        { identifier: 'sbFixtureSetter', enabled: true },
    );

    preset.prompt_order.push({
        character_id: CHARACTER_ORDER_ID,
        order: [
            { identifier: 'main', enabled: true },
            { identifier: 'sbFixtureRelative', enabled: false },
            { identifier: 'chatHistory', enabled: true },
        ],
    });

    return preset;
}

// ── harness ────────────────────────────────────────────────────────────────

/**
 * Installs the fixture and write interception. Must run before navigation.
 * @param {import('@playwright/test').Page} page
 */
async function installFixture(page) {
    const store = { settingsSaves: [], presetSaves: [] };
    const preset = buildFixturePreset();
    let settingsVersion = 1_000_000_000_000_000;

    await page.route('**/api/**', async route => {
        const request = route.request();
        const url = new URL(request.url());

        if (url.pathname === '/api/settings/get') {
            const response = await route.fetch();
            const data = await response.json();
            const settings = JSON.parse(data.settings);

            settings.main_api = 'openai';
            settings.firstRun = false;
            settings._version = settingsVersion;
            settings.power_user = { ...settings.power_user, sb_preset_autosave: false, prompt_manager_drag_locked: false };
            settings.extension_settings ??= {};
            settings.extension_settings.variables = { global: { [SETTER_VARIABLE]: 'on' } };
            settings.extension_settings['quick-image-gen'] = { ...settings.extension_settings['quick-image-gen'], setupWizardSeen: true };
            settings.oai_settings = {
                ...settings.oai_settings,
                ...structuredClone(preset),
                chat_completion_source: 'openrouter',
                preset_settings_openai: FIXTURE_PRESET_NAME,
            };

            data.settings = JSON.stringify(settings);
            data.openai_setting_names = [...data.openai_setting_names, FIXTURE_PRESET_NAME];
            data.openai_settings = [...data.openai_settings, JSON.stringify(preset)];
            data.request_compression = { ...data.request_compression, enabled: false };
            return route.fulfill({ response, json: data });
        }

        if (url.pathname === '/api/settings/save') {
            settingsVersion += 1;
            store.settingsSaves.push(request.postDataJSON());
            return route.fulfill({ json: { result: 'ok', version: settingsVersion } });
        }

        if (url.pathname === '/api/presets/save') {
            store.presetSaves.push(request.postDataJSON());
            return route.fulfill({ json: { name: request.postDataJSON()?.name ?? '' } });
        }

        const isWriteEndpoint = /^\/api\/.*\/(save|delete|create|edit|rename|update|import|upload|restore|duplicate|write|set)(?:\/|$)/i.test(url.pathname);
        if (isWriteEndpoint || ['PUT', 'PATCH', 'DELETE'].includes(request.method())) {
            return route.fulfill({ json: {} });
        }

        // Remaining POSTs are reads (characters, chats, tokenizers, status); model status is never contacted.
        if (url.pathname.startsWith('/api/backends/chat-completions/status')) {
            return route.fulfill({ json: { error: true } });
        }

        return route.continue();
    });

    await page.route('**/api/savesettings**', route => route.fulfill({ json: { result: 'ok' } }));
    return store;
}

/** @param {{ settingsSaves: any[] }} store */
function lastSavedOai(store) {
    return store.settingsSaves.at(-1)?.oai_settings ?? null;
}

/** @param {any} oai @param {number} characterId */
function orderFor(oai, characterId) {
    return oai?.prompt_order?.find(entry => String(entry.character_id) === String(characterId))?.order ?? null;
}

/** @param {any} oai @param {string} identifier */
function promptFor(oai, identifier) {
    return oai?.prompts?.find(prompt => prompt.identifier === identifier) ?? null;
}

/**
 * Waits for a settings save that satisfies `predicate`, then returns its oai_settings.
 * @param {{ settingsSaves: any[] }} store
 * @param {(oai: any) => boolean} predicate
 */
async function waitForSavedOai(store, predicate) {
    await expect.poll(() => {
        const oai = lastSavedOai(store);
        return Boolean(oai) && predicate(oai);
    }, { timeout: 10000 }).toBe(true);
    return structuredClone(lastSavedOai(store));
}

/** @param {import('@playwright/test').Page} page */
async function readLiveOai(page) {
    return page.evaluate(async () => {
        const { oai_settings } = await import('/scripts/openai.js');
        return structuredClone({ prompts: oai_settings.prompts, prompt_order: oai_settings.prompt_order });
    });
}

// ── legacy UI driver ───────────────────────────────────────────────────────

const FORM = '#completion_prompt_manager_popup_entry_form';
const ROW_SELECTOR = '#completion_prompt_manager_list li.completion_prompt_manager_prompt';

/** @param {import('@playwright/test').Page} page */
function legacyDriver(page) {
    const row = identifier => page.locator(`${ROW_SELECTOR}[data-pm-identifier="${identifier}"]`);

    const confirmPopup = async () => {
        const ok = page.locator('dialog.popup[open] .popup-button-ok');
        await expect(ok).toBeVisible();
        await ok.click();
        await expect(page.locator('dialog.popup[open]')).toHaveCount(0);
    };

    const driver = {
        row,

        async open() {
            const hostname = new URL(BASE_URL).hostname;
            expect(['127.0.0.1', 'localhost', '[::1]']).toContain(hostname);
            await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
            await page.waitForFunction(
                () => window.SillyTavern?.getContext?.()?.eventSource?.autoFireLastArgs?.has('app_ready'),
                null,
                { timeout: 60000 },
            );
            await page.evaluate(() => window.SillyBunnyShell.openTab('left', 'editor'));
            const panel = page.locator('[data-sb-panel="editor"]');
            await expect(panel).toHaveAttribute('aria-hidden', 'false');

            const drawer = page.locator('#completion_prompt_manager_drawer');
            await expect(drawer).toBeVisible();
            const isFlat = await drawer.evaluate(element => element.classList.contains('sb-settings-flat-section'));
            const content = drawer.locator(':scope > .inline-drawer-content');
            if (!isFlat && !(await content.isVisible())) {
                await drawer.locator(':scope > .inline-drawer-header').click();
            }
            await expect(row('main')).toBeVisible();
        },

        /** Prompt rows in list order, excluding the inspection-only runtime Agents row. */
        async visibleOrder() {
            return page.locator(ROW_SELECTOR).evaluateAll(rows => rows
                .filter(element => element.dataset.pmRuntime !== 'true')
                .map(element => element.dataset.pmIdentifier));
        },

        async runtimeRowIsLast() {
            return page.locator(ROW_SELECTOR).last().evaluate(element => element.dataset.pmRuntime === 'true');
        },

        async capabilities(identifier) {
            const target = row(identifier);
            return {
                edit: await target.locator('.prompt-manager-edit-action').count() > 0,
                remove: await target.locator('.prompt-manager-detach-action').count() > 0,
                toggle: await target.locator('.prompt-manager-toggle-action').count() > 0,
            };
        },

        async isPromptEnabled(identifier) {
            return row(identifier).evaluate(element => !element.classList.contains('completion_prompt_manager_prompt_disabled'));
        },

        async openEditor(identifier) {
            const target = row(identifier);
            await target.hover();
            await target.locator('.prompt-manager-edit-action').click();
            await expect(page.locator(`${FORM}_name`)).toBeVisible();
        },

        async isContentEditable() {
            return page.locator(`${FORM}_prompt`).isEditable();
        },

        /** @param {{ name?: string, role?: string, content?: string, position?: number, depth?: number, order?: number, triggers?: string[], forbidOverrides?: boolean }} fields */
        async fill(fields) {
            if (fields.name !== undefined) await page.locator(`${FORM}_name`).fill(fields.name);
            if (fields.role !== undefined) await page.locator(`${FORM}_role`).selectOption(fields.role);
            if (fields.position !== undefined) await page.locator(`${FORM}_injection_position`).selectOption(String(fields.position));
            if (fields.depth !== undefined) await page.locator(`${FORM}_injection_depth`).fill(String(fields.depth));
            if (fields.order !== undefined) await page.locator(`${FORM}_injection_order`).fill(String(fields.order));
            if (fields.content !== undefined) await page.locator(`${FORM}_prompt`).fill(fields.content);
            if (fields.forbidOverrides !== undefined) await page.locator(`${FORM}_forbid_overrides`).setChecked(fields.forbidOverrides);
            if (fields.triggers !== undefined) {
                const chips = page.locator('#completion_prompt_manager_popup_trigger_chips .pm-trigger-chip');
                for (const chip of await chips.all()) {
                    const value = await chip.getAttribute('data-trigger-value');
                    const checked = await chip.getAttribute('aria-checked') === 'true';
                    if (checked !== fields.triggers.includes(value)) await chip.click();
                }
            }
        },

        async save() {
            await page.locator(`${FORM}_save`).click();
        },

        async close() {
            await page.locator(`${FORM}_close`).click();
            await expect(page.locator('#completion_prompt_manager_popup')).toBeHidden();
        },

        async resetToDefault() {
            await page.locator(`${FORM}_reset`).click();
        },

        async rename(identifier, name) {
            await driver.openEditor(identifier);
            await driver.fill({ name });
            await driver.save();
        },

        async toggle(identifier) {
            await row(identifier).locator('.prompt-manager-toggle-action').click();
        },

        async createPrompt(fields) {
            await page.locator('[data-pm-footer-action="new"]').click();
            await expect(page.locator(`${FORM}_name`)).toBeVisible();
            await driver.fill(fields);
            await driver.save();
        },

        async insertExisting(name) {
            const picker = page.locator('#completion_prompt_manager_footer_append_prompt');
            await expect(picker.locator('option', { hasText: name })).toHaveCount(1);
            await picker.selectOption({ label: name });
            await page.locator('[data-pm-footer-action="insert"]').click();
        },

        async remove(identifier) {
            const target = row(identifier);
            await target.hover();
            await target.locator('.prompt-manager-detach-action').click();
        },

        async deletePrompt(name) {
            await page.locator('#completion_prompt_manager_footer_append_prompt').selectOption({ label: name });
            await page.locator('[data-pm-footer-action="delete"]').click();
            await confirmPopup();
        },

        /** Drags `identifier` so it lands directly before `targetIdentifier`. */
        async moveBefore(identifier, targetIdentifier) {
            const sourceBox = await row(identifier).boundingBox();
            const targetBox = await row(targetIdentifier).boundingBox();
            const startX = sourceBox.x + 24;
            const startY = sourceBox.y + sourceBox.height / 2;

            await page.mouse.move(startX, startY);
            await page.mouse.down();
            // jQuery UI sortable starts after its mouse delay and a small distance; nudge until the placeholder exists.
            await expect.poll(async () => {
                await page.mouse.move(startX, startY + 3, { steps: 2 });
                await page.mouse.move(startX, startY, { steps: 2 });
                return page.locator('#completion_prompt_manager_list .ui-sortable-placeholder').count();
            }, { timeout: 5000 }).toBeGreaterThan(0);
            await page.mouse.move(startX, targetBox.y + targetBox.height * 0.25, { steps: 12 });
            await page.mouse.up();
        },

        async exportList() {
            const downloadPromise = page.waitForEvent('download');
            await page.locator('#prompt-manager-export').click();
            const download = await downloadPromise;
            const stream = await download.createReadStream();
            const chunks = [];
            for await (const chunk of stream) chunks.push(chunk);
            return { filename: download.suggestedFilename(), data: JSON.parse(Buffer.concat(chunks).toString('utf8')) };
        },

        async importList(json) {
            const chooserPromise = page.waitForEvent('filechooser');
            await page.locator('#prompt-manager-import').click();
            await confirmPopup();
            const chooser = await chooserPromise;
            await chooser.setFiles({ name: 'prompts.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(json)) });
        },

        async resetOrder() {
            await page.locator('#prompt-manager-reset-character').click();
            await confirmPopup();
        },
    };

    return driver;
}

/** @param {import('@playwright/test').Page} page */
async function setup(page) {
    const store = await installFixture(page);
    const ui = legacyDriver(page);
    await ui.open();
    const baseline = await readLiveOai(page);
    return { store, ui, baseline };
}

// ── behaviour ──────────────────────────────────────────────────────────────

test.describe('Prompt Manager characterization', () => {
    test('loads the ST-shaped fixture preset in the global order', async ({ page }) => {
        const { ui, baseline } = await setup(page);

        const expectedVisible = orderFor(baseline, GLOBAL_ORDER_ID).map(entry => entry.identifier);
        expect(await ui.visibleOrder()).toEqual(expectedVisible);
        expect(await ui.runtimeRowIsLast()).toBe(true);
        expect(expectedVisible).toContain('sbFixtureInChat');
        expect(expectedVisible).not.toContain('sbFixtureDetached');
        expect(await ui.isPromptEnabled('enhanceDefinitions')).toBe(false);
        expect(orderFor(baseline, CHARACTER_ORDER_ID)).toHaveLength(3);
    });

    test('row permissions follow prompt type', async ({ page }) => {
        const { ui } = await setup(page);

        expect(await ui.capabilities('sbFixtureRelative')).toEqual({ edit: true, remove: true, toggle: true });
        expect(await ui.capabilities('main')).toEqual({ edit: true, remove: false, toggle: true });
        expect(await ui.capabilities('charDescription')).toEqual({ edit: true, remove: false, toggle: true });
        expect(await ui.capabilities('chatHistory')).toEqual({ edit: false, remove: false, toggle: true });

        await ui.openEditor('charDescription');
        expect(await ui.isContentEditable()).toBe(false);
        await ui.close();
        await ui.openEditor('sbFixtureRelative');
        expect(await ui.isContentEditable()).toBe(true);
    });

    test('saving an edit writes every field of that prompt and nothing else', async ({ page }) => {
        const { store, ui, baseline } = await setup(page);

        await ui.openEditor('sbFixtureRelative');
        await ui.fill({ role: 'user', position: 1, depth: 7, order: 250, triggers: ['continue', 'impersonate'], content: 'Edited relative content' });
        await ui.save();

        const saved = await waitForSavedOai(store, oai => promptFor(oai, 'sbFixtureRelative')?.content === 'Edited relative content');
        expect(promptFor(saved, 'sbFixtureRelative')).toEqual({
            ...promptFor(baseline, 'sbFixtureRelative'),
            role: 'user',
            content: 'Edited relative content',
            injection_position: 1,
            injection_depth: 7,
            injection_order: 250,
            injection_trigger: ['continue', 'impersonate'],
            forbid_overrides: false,
        });

        const others = prompts => prompts.filter(prompt => prompt.identifier !== 'sbFixtureRelative');
        expect(others(saved.prompts)).toEqual(others(baseline.prompts));
        expect(saved.prompt_order).toEqual(baseline.prompt_order);
    });

    test('saving the main prompt syncs its quick-edit alias and forbid_overrides', async ({ page }) => {
        const { store, ui } = await setup(page);

        await ui.openEditor('main');
        await ui.fill({ content: 'Edited main content', forbidOverrides: true });
        await ui.save();

        const saved = await waitForSavedOai(store, oai => promptFor(oai, 'main')?.content === 'Edited main content');
        expect(promptFor(saved, 'main')).toMatchObject({ content: 'Edited main content', forbid_overrides: true, system_prompt: true });
        await expect(page.locator('#main_prompt_quick_edit_textarea')).toHaveValue('Edited main content');
    });

    test('reset to default fills the form and only persists on save', async ({ page }) => {
        const { store, ui } = await setup(page);
        // Reset restores the built-in default, which differs from the bundled preset's text.
        const builtInMain = await page.evaluate(async () => (await import('/scripts/openai.js')).promptManager.configuration.defaultPrompts.main);

        await ui.openEditor('main');
        await ui.fill({ name: 'Custom Main', content: 'Custom main content' });
        await ui.save();
        await waitForSavedOai(store, oai => promptFor(oai, 'main')?.name === 'Custom Main');

        const savesBeforeReset = store.settingsSaves.length;
        await ui.resetToDefault();
        await expect(page.locator(`${FORM}_name`)).toHaveValue('Main Prompt');
        await expect(page.locator(`${FORM}_prompt`)).toHaveValue(builtInMain);
        expect(store.settingsSaves.length).toBe(savesBeforeReset);

        await ui.save();
        const saved = await waitForSavedOai(store, oai => promptFor(oai, 'main')?.name === 'Main Prompt');
        expect(promptFor(saved, 'main')).toMatchObject({ name: 'Main Prompt', content: builtInMain, forbid_overrides: false });
    });

    test('rename keeps identifier, position and enabled state', async ({ page }) => {
        const { store, ui, baseline } = await setup(page);

        await ui.rename('sbFixtureInChat', 'Renamed In-Chat');

        const saved = await waitForSavedOai(store, oai => promptFor(oai, 'sbFixtureInChat')?.name === 'Renamed In-Chat');
        expect(promptFor(saved, 'sbFixtureInChat')).toEqual({ ...promptFor(baseline, 'sbFixtureInChat'), name: 'Renamed In-Chat' });
        expect(saved.prompt_order).toEqual(baseline.prompt_order);
        await expect(ui.row('sbFixtureInChat')).toContainText('Renamed In-Chat');
    });

    test('a new prompt persists on save, and Insert adds it disabled at the top of the order', async ({ page }) => {
        const { store, ui, baseline } = await setup(page);

        await ui.createPrompt({ name: 'Fixture New', role: 'assistant', content: 'New prompt content' });
        const created = await waitForSavedOai(store, oai => oai.prompts.some(prompt => prompt.name === 'Fixture New'));
        const newPrompt = created.prompts.find(prompt => prompt.name === 'Fixture New');
        expect(newPrompt).toMatchObject({ role: 'assistant', content: 'New prompt content', system_prompt: false, marker: false });
        expect(newPrompt.identifier).toMatch(/^[0-9a-f-]{36}$/);
        expect(created.prompt_order).toEqual(baseline.prompt_order);

        await ui.insertExisting('Fixture New');
        const inserted = await waitForSavedOai(store, oai => orderFor(oai, GLOBAL_ORDER_ID)[0]?.identifier === newPrompt.identifier);
        expect(orderFor(inserted, GLOBAL_ORDER_ID)).toEqual([
            { identifier: newPrompt.identifier, enabled: false },
            ...orderFor(baseline, GLOBAL_ORDER_ID),
        ]);
    });

    test('toggle flips only that order entry and clears variables the prompt sets', async ({ page }) => {
        const { store, ui, baseline } = await setup(page);
        const expectFlipped = (oai, identifier) => orderFor(oai, GLOBAL_ORDER_ID).map(entry =>
            entry.identifier === identifier ? { ...entry, enabled: !entry.enabled } : entry);

        await ui.toggle('sbFixtureInChat');
        const toggledOff = await waitForSavedOai(store, oai => orderFor(oai, GLOBAL_ORDER_ID).find(entry => entry.identifier === 'sbFixtureInChat')?.enabled === false);
        expect(orderFor(toggledOff, GLOBAL_ORDER_ID)).toEqual(expectFlipped(baseline, 'sbFixtureInChat'));
        expect(toggledOff.prompts).toEqual(baseline.prompts);
        await expect.poll(() => ui.isPromptEnabled('sbFixtureInChat')).toBe(false);

        await ui.toggle('sbFixtureSetter');
        await expect.poll(() => store.settingsSaves.at(-1)?.extension_settings?.variables?.global?.[SETTER_VARIABLE]).toBeUndefined();

        await ui.toggle('sbFixtureInChat');
        await waitForSavedOai(store, oai => orderFor(oai, GLOBAL_ORDER_ID).find(entry => entry.identifier === 'sbFixtureInChat')?.enabled === true);
    });

    test('reordering rewrites only the active order and keeps enabled flags', async ({ page }) => {
        const { store, ui, baseline } = await setup(page);
        const before = orderFor(baseline, GLOBAL_ORDER_ID);

        await ui.moveBefore('sbFixtureRelative', 'main');

        const moved = before.find(entry => entry.identifier === 'sbFixtureRelative');
        const expected = [moved, ...before.filter(entry => entry !== moved)];
        const saved = await waitForSavedOai(store, oai => orderFor(oai, GLOBAL_ORDER_ID)[0]?.identifier === 'sbFixtureRelative');
        expect(orderFor(saved, GLOBAL_ORDER_ID)).toEqual(expected);
        expect(orderFor(saved, CHARACTER_ORDER_ID)).toEqual(orderFor(baseline, CHARACTER_ORDER_ID));
        expect(orderFor(saved, GENERIC_ORDER_ID)).toEqual(orderFor(baseline, GENERIC_ORDER_ID));
        expect(saved.prompts).toEqual(baseline.prompts);
        expect(await ui.visibleOrder()).toEqual(expected.map(entry => entry.identifier));
    });

    test('remove detaches from the order but keeps the definition', async ({ page }) => {
        const { store, ui, baseline } = await setup(page);

        await ui.remove('sbFixtureRelative');

        const saved = await waitForSavedOai(store, oai => !orderFor(oai, GLOBAL_ORDER_ID).some(entry => entry.identifier === 'sbFixtureRelative'));
        expect(orderFor(saved, GLOBAL_ORDER_ID)).toEqual(orderFor(baseline, GLOBAL_ORDER_ID).filter(entry => entry.identifier !== 'sbFixtureRelative'));
        expect(saved.prompts).toEqual(baseline.prompts);
        expect(orderFor(saved, CHARACTER_ORDER_ID)).toEqual(orderFor(baseline, CHARACTER_ORDER_ID));
        await expect(ui.row('sbFixtureRelative')).toHaveCount(0);
    });

    test('delete removes the definition after confirmation', async ({ page }) => {
        const { store, ui, baseline } = await setup(page);

        await ui.deletePrompt('Fixture Detached');

        const saved = await waitForSavedOai(store, oai => !promptFor(oai, 'sbFixtureDetached'));
        expect(saved.prompts).toEqual(baseline.prompts.filter(prompt => prompt.identifier !== 'sbFixtureDetached'));
        expect(saved.prompt_order).toEqual(baseline.prompt_order);
    });

    test('list export and import round-trip prompts and the global order', async ({ page }) => {
        const { store, ui, baseline } = await setup(page);
        const userPrompts = baseline.prompts.filter(prompt => prompt.system_prompt === false && prompt.marker === false);

        const { filename, data: exported } = await ui.exportList();
        expect(filename).toMatch(/^st-prompts-\d{2}_\d{2}_\d{4}\.json$/);
        expect(exported).toEqual({
            version: 1,
            type: 'full',
            data: { prompts: userPrompts, prompt_order: orderFor(baseline, GLOBAL_ORDER_ID) },
        });

        await ui.rename('sbFixtureInChat', 'Changed Before Import');
        await waitForSavedOai(store, oai => promptFor(oai, 'sbFixtureInChat')?.name === 'Changed Before Import');
        await ui.close();
        await ui.toggle('sbFixtureRelative');
        await waitForSavedOai(store, oai => orderFor(oai, GLOBAL_ORDER_ID).find(entry => entry.identifier === 'sbFixtureRelative')?.enabled === false);

        await ui.importList(exported);

        const saved = await waitForSavedOai(store, oai =>
            promptFor(oai, 'sbFixtureInChat')?.name === 'Fixture In-Chat'
            && orderFor(oai, GLOBAL_ORDER_ID).find(entry => entry.identifier === 'sbFixtureRelative')?.enabled === true);
        const byId = prompts => Object.fromEntries(prompts.map(prompt => [prompt.identifier, prompt]));
        expect(byId(saved.prompts)).toEqual(byId(baseline.prompts));
        expect(saved.prompt_order).toEqual(baseline.prompt_order);
    });

    test('order edits touch only the global slot and reset restores the selected preset order', async ({ page }) => {
        const { store, ui, baseline } = await setup(page);
        const presetOrder = orderFor(buildFixturePreset(), GLOBAL_ORDER_ID);
        expect(orderFor(baseline, GLOBAL_ORDER_ID)).toEqual(presetOrder);

        await ui.remove('sbFixtureInChat');
        await ui.toggle('jailbreak');
        await waitForSavedOai(store, oai =>
            !orderFor(oai, GLOBAL_ORDER_ID).some(entry => entry.identifier === 'sbFixtureInChat')
            && orderFor(oai, GLOBAL_ORDER_ID).find(entry => entry.identifier === 'jailbreak')?.enabled === false);

        await ui.resetOrder();

        const saved = await waitForSavedOai(store, oai => orderFor(oai, GLOBAL_ORDER_ID).some(entry => entry.identifier === 'sbFixtureInChat'));
        expect(orderFor(saved, GLOBAL_ORDER_ID)).toEqual(presetOrder);
        expect(orderFor(saved, CHARACTER_ORDER_ID)).toEqual(orderFor(baseline, CHARACTER_ORDER_ID));
        expect(orderFor(saved, GENERIC_ORDER_ID)).toEqual(orderFor(baseline, GENERIC_ORDER_ID));
        expect(saved.prompts).toEqual(baseline.prompts);

        const orderEntryKeys = saved.prompt_order.flatMap(entry => entry.order.flatMap(item => Object.keys(item)));
        expect(new Set(orderEntryKeys)).toEqual(new Set(['identifier', 'enabled']));
        expect(new Set(saved.prompt_order.flatMap(Object.keys))).toEqual(new Set(['character_id', 'order']));
    });
});
