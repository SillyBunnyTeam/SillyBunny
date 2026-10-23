import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';

// Characterizes Prompt Manager behaviour through what it persists (the /api/settings/save payload).
// UI interactions stay in the driver; persisted-data assertions are unchanged by the replacement UI.

test.use({ serviceWorkers: 'block', contextOptions: { reducedMotion: 'reduce' }, viewport: { width: 1920, height: 1080 } });

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
async function installFixture(page, { dragLocked = false } = {}) {
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
            settings.power_user = { ...settings.power_user, sb_preset_autosave: false, prompt_manager_drag_locked: dragLocked };
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
            const payload = request.postDataJSON();
            settingsVersion = payload._version + 1;
            store.settingsSaves.push(payload);
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

// ── owned editor UI driver ────────────────────────────────────────────────

const FORM = '#sb-prompt-form';
const ROW_SELECTOR = '.sb-prompt-order .sb-prompt-row';

/** @param {import('@playwright/test').Page} page */
function promptEditorDriver(page) {
    const row = identifier => page.locator(`${ROW_SELECTOR}[data-prompt-id="${identifier}"]`);
    const editor = page.locator('.sb-prompt-detail');
    const listAction = async label => {
        await page.getByRole('button', { name: 'Prompt list actions', exact: true }).click();
        await page.getByRole('menuitem', { name: label, exact: true }).click();
    };
    const editorAction = async label => {
        const direct = editor.getByRole('button', { name: label, exact: true });
        if (await direct.isVisible()) return direct.click();
        await editor.getByRole('button', { name: 'More prompt actions', exact: true }).click();
        await page.getByRole('menuitem', { name: label, exact: true }).click();
    };

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

            await expect(page.locator('.sb-prompt-editor')).toBeVisible();
            await expect(row('main')).toBeVisible();
        },

        /** Prompt rows in list order, excluding the inspection-only runtime Agents row. */
        async visibleOrder() {
            return page.locator(ROW_SELECTOR).evaluateAll(rows => rows
                .filter(element => element.dataset.promptId !== 'sillybunnyRuntimeAgents')
                .map(element => element.dataset.promptId));
        },

        async runtimeRowIsLast() {
            return page.locator(ROW_SELECTOR).last().evaluate(element => element.querySelector('i.fa-robot') !== null && !element.querySelector('.sb-prompt-grip'));
        },

        async capabilities(identifier) {
            const target = row(identifier);
            await target.locator('.sb-prompt-row-menu').click();
            const menu = page.getByRole('menu', { name: await target.getAttribute('aria-label'), exact: true });
            await expect(menu).toBeVisible();
            const result = {
                edit: await menu.getByRole('menuitem', { name: 'Edit', exact: true }).count() > 0,
                remove: await menu.getByRole('menuitem', { name: 'Remove from list', exact: true }).count() > 0,
                toggle: await target.getByRole('switch').isEnabled(),
            };
            await menu.getByRole('menuitem').first().focus();
            await page.keyboard.press('Escape');
            await expect(menu).toHaveCount(0);
            return result;
        },

        async isPromptEnabled(identifier) {
            return row(identifier).getByRole('switch').isChecked();
        },

        async openEditor(identifier) {
            const target = row(identifier);
            await target.locator('.sb-prompt-row-name').click();
            await expect(page.locator(`${FORM}_name`)).toBeVisible();
            await expect(page.locator('.sb-list-editor__detail--travelling')).toHaveCount(0);
        },

        async isContentEditable() {
            return page.locator(`${FORM}_prompt`).isEditable();
        },

        /** @param {{ name?: string, role?: string, content?: string, position?: number, depth?: number, order?: number, triggers?: string[], forbidOverrides?: boolean }} fields */
        async fill(fields) {
            if (fields.name !== undefined) await page.locator(`${FORM}_name`).fill(fields.name);
            if (fields.role !== undefined) {
                await editor.getByRole('button', { name: 'Role', exact: true }).click();
                await page.getByRole('option', { name: fields.role[0].toUpperCase() + fields.role.slice(1), exact: true }).click();
            }
            if (fields.position !== undefined) await editor.getByRole('group', { name: 'Position', exact: true }).locator('label').filter({ hasText: fields.position === 1 ? 'In-chat' : 'Relative' }).click();
            if (fields.depth !== undefined) await editor.getByRole('spinbutton', { name: 'Depth', exact: true }).fill(String(fields.depth));
            if (fields.order !== undefined) await editor.getByRole('spinbutton', { name: 'Order', exact: true }).fill(String(fields.order));
            if (fields.content !== undefined) await page.locator(`${FORM}_prompt`).fill(fields.content);
            if (fields.forbidOverrides !== undefined) await editor.getByRole('switch', { name: 'Forbid overrides', exact: true }).setChecked(fields.forbidOverrides);
            if (fields.triggers !== undefined) {
                await editor.getByRole('button', { name: 'Triggers', exact: true }).click();
                const popover = page.getByRole('dialog', { name: 'Generation triggers', exact: true });
                for (const value of ['normal', 'continue', 'impersonate', 'swipe', 'regenerate', 'quiet']) {
                    await popover.getByRole('checkbox', { name: value[0].toUpperCase() + value.slice(1), exact: true }).setChecked(fields.triggers.includes(value));
                }
                await popover.getByRole('button', { name: 'Done', exact: true }).click();
            }
        },

        async save() {
            await editor.getByRole('button', { name: 'Save', exact: true }).click();
        },

        async close() {
            await editor.getByRole('button', { name: 'Back to prompt list', exact: true }).click();
            await expect(editor).toBeHidden();
        },

        async selectMode(mode) {
            const content = editor.locator(mode === 'preview' ? '.sb-prompt-preview' : '.sb-prompt-textarea');
            if (await content.count()) return;
            const segment = editor.locator('.sb-prompt-modes label').filter({ hasText: mode === 'preview' ? 'Preview' : 'Edit' });
            if (await segment.isVisible()) await segment.click();
            else await editor.getByRole('button', { name: mode === 'preview' ? 'Preview prompt' : 'Edit prompt', exact: true }).click();
        },

        async resetToDefault() {
            await editorAction('Reset to default');
        },

        async rename(identifier, name) {
            await driver.openEditor(identifier);
            await driver.fill({ name });
            await driver.save();
        },

        async toggle(identifier) {
            await row(identifier).getByRole('switch').click();
        },

        async createPrompt(fields) {
            await page.getByRole('button', { name: 'Add prompt', exact: true }).click();
            await page.getByRole('menuitem', { name: 'New prompt', exact: true }).click();
            await expect(page.locator(`${FORM}_name`)).toBeVisible();
            await driver.fill(fields);
            await driver.save();
        },

        async insertExisting(name) {
            if (await editor.isVisible()) await driver.close();
            await page.getByRole('button', { name: `Add ${name}`, exact: true }).click();
        },

        async remove(identifier) {
            const target = row(identifier);
            await target.locator('.sb-prompt-row-menu').click();
            await page.getByRole('menuitem', { name: 'Remove from list', exact: true }).click();
        },

        async deletePrompt(name) {
            const available = page.locator('.sb-prompt-available .sb-prompt-row').filter({ has: page.locator('.sb-prompt-row-name', { hasText: name }) });
            await available.locator('.sb-prompt-row-menu').click();
            await page.getByRole('menuitem', { name: 'Delete', exact: true }).click();
            await confirmPopup();
        },

        /** Drags `identifier` so it lands directly before `targetIdentifier`. */
        async moveBefore(identifier, targetIdentifier) {
            const placeholder = page.locator('.sb-prompt-order .ui-sortable-placeholder');
            let startX;
            let startY;
            // The list can still shift (header card, token counts) after a single measurement, so a press may
            // miss the handle; re-measure and press again until jQuery UI sortable creates its placeholder.
            await expect.poll(async () => {
                if (await placeholder.count()) return true;
                await page.mouse.up();
                const sourceBox = await row(identifier).locator('.sb-prompt-grip').boundingBox();
                if (!sourceBox) return false;
                startX = sourceBox.x + sourceBox.width / 2;
                startY = sourceBox.y + sourceBox.height / 2;
                await page.mouse.move(startX, startY);
                await page.mouse.down();
                await page.mouse.move(startX, startY + 6, { steps: 2 });
                await page.mouse.move(startX, startY, { steps: 2 });
                return (await placeholder.count()) > 0;
            }, { timeout: 5000 }).toBe(true);
            const targetBox = await row(targetIdentifier).boundingBox();
            await page.mouse.move(startX, targetBox.y + targetBox.height * 0.25, { steps: 12 });
            await page.mouse.up();
        },

        async exportList() {
            const downloadPromise = page.waitForEvent('download');
            await listAction('Export prompt list');
            const download = await downloadPromise;
            const stream = await download.createReadStream();
            const chunks = [];
            for await (const chunk of stream) chunks.push(chunk);
            return { filename: download.suggestedFilename(), data: JSON.parse(Buffer.concat(chunks).toString('utf8')) };
        },

        async importList(json) {
            const chooserPromise = page.waitForEvent('filechooser');
            await listAction('Import prompt list');
            await confirmPopup();
            const chooser = await chooserPromise;
            await chooser.setFiles({ name: 'prompts.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(json)) });
        },

        async resetOrder() {
            await listAction('Reset order');
            await confirmPopup();
        },
    };

    return driver;
}

/** @param {import('@playwright/test').Page} page */
async function setup(page, options) {
    const store = await installFixture(page, options);
    const ui = promptEditorDriver(page);
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
        await expect(page.locator('.sb-prompt-detail')).toBeVisible();
        await ui.close();
        await ui.openEditor('sbFixtureRelative');
        await expect(page.locator(`${FORM}_prompt`)).toHaveValue('Edited relative content');
        await expect(page.getByRole('button', { name: 'Role', exact: true })).toHaveText('User');
    });

    test('saving the main prompt syncs its quick-edit alias and forbid_overrides', async ({ page }) => {
        const { store, ui } = await setup(page);

        await ui.openEditor('main');
        await ui.fill({ content: 'Edited main content', forbidOverrides: true });
        await ui.save();

        const saved = await waitForSavedOai(store, oai => promptFor(oai, 'main')?.content === 'Edited main content');
        expect(promptFor(saved, 'main')).toMatchObject({ content: 'Edited main content', forbid_overrides: true, system_prompt: true });
        await expect(page.locator('#main_prompt_quick_edit_textarea')).toHaveValue('Edited main content');
        await ui.close();
        await ui.openEditor('main');
        await expect(page.getByRole('switch', { name: 'Forbid overrides', exact: true })).toBeChecked();
    });

    test('expanded editor writes back to the draft and survives save and reopen', async ({ page }) => {
        const { store, ui, baseline } = await setup(page);
        await ui.openEditor('sbFixtureRelative');
        const textarea = page.locator(`${FORM}_prompt`);
        const expand = page.locator('.sb-prompt-footer .editor_maximize');
        await expect(expand).toHaveAttribute('data-for', 'sb-prompt-form_prompt');
        await expect(expand.locator('.fa-solid.fa-maximize')).toHaveCount(1);
        await expand.click();
        const popup = page.locator('dialog.popup[open]');
        await expect(popup.locator('.maximized_textarea')).toHaveValue('Relative fixture content');
        await popup.locator('.maximized_textarea').fill('Expanded prompt content');
        await popup.locator('.popup-button-ok').click();
        await expect(textarea).toHaveValue('Expanded prompt content');
        await expect(expand).toBeFocused();
        await expect(page.locator('.sb-prompt-dirty')).toBeVisible();
        expect(promptFor(await readLiveOai(page), 'sbFixtureRelative').content).toBe('Relative fixture content');
        await ui.selectMode('preview');
        await expect(expand).toHaveCount(0);
        await ui.selectMode('edit');
        await ui.save();
        await waitForSavedOai(store, oai => promptFor(oai, 'sbFixtureRelative')?.content === 'Expanded prompt content');
        await ui.close();
        await ui.openEditor('sbFixtureRelative');
        await expect(textarea).toHaveValue('Expanded prompt content');
        await ui.fill({ content: promptFor(baseline, 'sbFixtureRelative').content });
        await ui.save();
        await waitForSavedOai(store, oai => promptFor(oai, 'sbFixtureRelative')?.content === 'Relative fixture content');
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

    test('character order toggles, reorders, exports, imports and resets without touching other slots', async ({ page }) => {
        const { store, ui, baseline } = await setup(page);
        await page.evaluate(async () => {
            const { promptManager } = await import('/scripts/openai.js');
            promptManager.configuration.promptOrder.strategy = 'character';
            promptManager.activeCharacter = { id: 4242, name: 'Fixture Character' };
            promptManager.render(false);
        });
        await expect.poll(() => ui.visibleOrder()).toEqual(['main', 'sbFixtureRelative', 'chatHistory']);
        await ui.toggle('sbFixtureRelative');
        await waitForSavedOai(store, oai => orderFor(oai, CHARACTER_ORDER_ID).find(entry => entry.identifier === 'sbFixtureRelative')?.enabled === true);
        await ui.row('sbFixtureRelative').focus();
        await page.keyboard.press('Alt+ArrowUp');
        const reordered = await waitForSavedOai(store, oai => orderFor(oai, CHARACTER_ORDER_ID)[0]?.identifier === 'sbFixtureRelative');
        expect(orderFor(reordered, CHARACTER_ORDER_ID)).toEqual([
            { identifier: 'sbFixtureRelative', enabled: true },
            { identifier: 'main', enabled: true },
            { identifier: 'chatHistory', enabled: true },
        ]);
        expect(orderFor(reordered, GLOBAL_ORDER_ID)).toEqual(orderFor(baseline, GLOBAL_ORDER_ID));
        expect(orderFor(reordered, GENERIC_ORDER_ID)).toEqual(orderFor(baseline, GENERIC_ORDER_ID));
        const downloadPromise = page.waitForEvent('download');
        await page.getByRole('button', { name: 'Prompt list actions', exact: true }).click();
        await page.getByRole('menuitem', { name: 'Export character prompts', exact: true }).click();
        const download = await downloadPromise;
        const stream = await download.createReadStream();
        const chunks = [];
        for await (const chunk of stream) chunks.push(chunk);
        const exported = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        expect(exported).toEqual({ version: 1, type: 'character', data: { prompts: [promptFor(baseline, 'sbFixtureRelative')], prompt_order: orderFor(reordered, CHARACTER_ORDER_ID) } });
        await ui.resetOrder();
        const reset = await waitForSavedOai(store, oai => orderFor(oai, CHARACTER_ORDER_ID)[0]?.identifier === 'main');
        expect(orderFor(reset, CHARACTER_ORDER_ID)).toEqual(orderFor(baseline, CHARACTER_ORDER_ID));
        await ui.importList(exported);
        const imported = await waitForSavedOai(store, oai => orderFor(oai, CHARACTER_ORDER_ID)[0]?.identifier === 'sbFixtureRelative');
        expect(imported.prompt_order).toEqual(reordered.prompt_order);
        expect(imported.prompts).toEqual(baseline.prompts);
    });

    test('dirty leave Cancel retains the draft and Discard does not mutate the prompt', async ({ page }) => {
        const { store, ui, baseline } = await setup(page);
        await ui.openEditor('sbFixtureRelative');
        await ui.fill({ content: 'Unsaved local draft' });
        const saves = store.settingsSaves.length;
        await page.getByRole('button', { name: 'Back to prompt list', exact: true }).click();
        await page.locator('dialog.popup[open] .popup-button-cancel').click();
        await expect(page.locator(`${FORM}_prompt`)).toHaveValue('Unsaved local draft');
        expect((await readLiveOai(page)).prompts).toEqual(baseline.prompts);
        await page.getByRole('button', { name: 'Back to prompt list', exact: true }).click();
        await page.locator('dialog.popup[open]').getByRole('button', { name: 'Discard', exact: true }).click();
        await expect(page.locator('.sb-prompt-detail')).toBeHidden();
        for (const saved of store.settingsSaves.slice(saves)) {
            expect(saved.oai_settings.prompts).toEqual(baseline.prompts);
            expect(saved.oai_settings.prompt_order).toEqual(baseline.prompt_order);
        }
        expect((await readLiveOai(page)).prompts).toEqual(baseline.prompts);
    });

    test('header Cancel is disabled until dirty and reverts the draft without saving', async ({ page }) => {
        const { store, ui, baseline } = await setup(page);
        await ui.openEditor('sbFixtureRelative');
        const editor = page.locator('.sb-prompt-detail');
        const cancel = editor.getByRole('button', { name: 'Cancel', exact: true });
        const save = editor.getByRole('button', { name: 'Save', exact: true });
        const original = await page.locator(`${FORM}_prompt`).inputValue();
        await expect(cancel).toBeDisabled();
        await expect(save).toBeDisabled();

        await ui.fill({ content: 'Unsaved local draft' });
        const saves = store.settingsSaves.length;
        await expect(cancel).toBeEnabled();
        await cancel.click();

        await expect(page.locator(`${FORM}_prompt`)).toHaveValue(original);
        await expect(editor).toBeVisible();
        await expect(cancel).toBeDisabled();
        await expect(save).toBeDisabled();
        await expect(editor.locator('.sb-prompt-dirty')).toBeHidden();
        expect(store.settingsSaves.length).toBe(saves);
        expect((await readLiveOai(page)).prompts).toEqual(baseline.prompts);
    });

    test('Add from available clears search and scrolls only the list scroller', async ({ page }) => {
        await setup(page);
        await page.getByRole('button', { name: 'Search prompts', exact: true }).click();
        await page.getByRole('searchbox', { name: 'Search prompts', exact: true }).fill('Fixture Detached');
        const scroller = page.locator('[data-sb-panel="editor"] .sb-shell-panel-scroller');
        const before = await scroller.evaluate(node => node.scrollTop);
        await page.getByRole('button', { name: 'Add prompt', exact: true }).click();
        await page.getByRole('menuitem', { name: /^Add from available \(\d+\)$/ }).click();
        await expect(page.getByRole('searchbox', { name: 'Search prompts', exact: true })).toHaveValue('');
        await expect.poll(() => scroller.evaluate(node => node.scrollTop)).toBe(before);
        const body = page.locator('.sb-prompt-list-body');
        await expect.poll(() => body.evaluate(node => node.scrollTop)).toBeGreaterThan(0);
        await body.evaluate(node => node.scrollTo({ top: node.scrollHeight, behavior: 'instant' }));
        expect(await body.evaluate(node => node.scrollTop)).toBeGreaterThan(0);
        await body.evaluate(node => node.scrollTo({ top: 0, behavior: 'instant' }));
        await expect.poll(() => body.evaluate(node => node.scrollTop)).toBe(0);
    });

    test('utility prompt edits and restores use the existing setting handlers', async ({ page }) => {
        const { store, baseline } = await setup(page);
        const row = page.locator('[data-prompt-id="scenario_format_textarea"]');
        await row.locator('.sb-prompt-row-name').click();
        await page.locator(`${FORM}_prompt`).fill('Changed utility content');
        await page.getByRole('button', { name: 'Save', exact: true }).click();
        await waitForSavedOai(store, oai => oai.scenario_format === 'Changed utility content');
        await page.getByRole('button', { name: 'Restore default', exact: true }).click();
        await waitForSavedOai(store, oai => oai.scenario_format === '{{scenario}}');
        expect((await readLiveOai(page)).prompts).toEqual(baseline.prompts);
        expect((await readLiveOai(page)).prompt_order).toEqual(baseline.prompt_order);
    });

    test('desktop list-only default opens an inline split editor and Back deselects the row', async ({ page }) => {
        const { ui } = await setup(page);
        const root = page.locator('.sb-prompt-editor');
        const list = page.locator('.sb-prompt-list');
        const editor = page.locator('.sb-prompt-detail');
        await expect(list).toBeVisible();
        await expect(editor).toBeHidden();
        await ui.openEditor('main');
        await expect(root).toHaveAttribute('data-collapsed', 'false');
        await expect(ui.row('main')).toHaveClass(/is-selected/);
        const listBox = await list.boundingBox();
        const editorBox = await editor.boundingBox();
        expect(editorBox.width).toBeGreaterThan(listBox.width);
        expect(editorBox.x).toBeGreaterThanOrEqual(listBox.x + listBox.width);
        expect(await editor.evaluate(node => node.parentElement.classList.contains('sb-prompt-editor'))).toBe(true);
        await expect(page.locator('dialog.popup[open]')).toHaveCount(0);
        await ui.close();
        await expect(ui.row('main')).not.toHaveClass(/is-selected/);
        await expect(ui.row('main')).toBeFocused();
        await expect(list).toBeVisible();
    });

    test('shared list-editor shell owns the split, divider resize and focus handoff', async ({ page }) => {
        const { ui } = await setup(page);
        const root = page.locator('.sb-prompt-editor');
        await expect(root).toHaveClass(/\bsb-list-editor\b/);
        await expect(page.locator('#deferred-editor-shell-css')).toHaveAttribute('data-loaded', 'true');
        await ui.openEditor('main');
        await expect(page.locator('.sb-prompt-title')).toBeFocused();
        const divider = page.getByRole('separator', { name: 'Resize prompt sidebar', exact: true });
        await expect(divider).toBeVisible();
        const list = page.locator('.sb-prompt-list');
        const before = Number(await divider.getAttribute('aria-valuenow'));
        await divider.focus();
        await page.keyboard.press('ArrowRight');
        await expect(divider).toHaveAttribute('aria-valuenow', String(Math.min(420, before + 10)));
        expect(await page.evaluate(() => Number(localStorage.getItem('sb-pm-list-width')))).toBe(Math.min(420, before + 10));
        await expect.poll(async () => Math.round((await list.boundingBox()).width)).toBe(Math.min(420, before + 10));
        await page.locator(`${FORM}_prompt`).focus();
        await page.keyboard.press('Escape');
        await expect(root).toHaveAttribute('data-open', 'false');
        await expect(ui.row('main')).toBeFocused();
    });

    test('shared list rows and search: arrow navigation, Ctrl+F, type-to-search and result announcements', async ({ page }) => {
        const { ui } = await setup(page);
        const order = await ui.visibleOrder();
        await ui.row(order[0]).focus();
        await page.keyboard.press('ArrowDown');
        await expect(ui.row(order[1])).toBeFocused();
        await page.keyboard.press('ArrowUp');
        await expect(ui.row(order[0])).toBeFocused();
        await page.keyboard.press('Enter');
        await expect(page.locator('.sb-prompt-editor')).toHaveAttribute('data-open', 'true');
        await page.keyboard.press('Escape');
        await expect(page.locator('.sb-prompt-editor')).toHaveAttribute('data-open', 'false');

        const searchButton = page.getByRole('button', { name: 'Search prompts', exact: true });
        const search = page.getByRole('searchbox', { name: 'Search prompts', exact: true });
        await ui.row('main').focus();
        await page.keyboard.press('ControlOrMeta+f');
        await expect(search).toBeFocused();
        await expect(searchButton).toHaveAttribute('aria-expanded', 'true');
        await expect(page.locator('#sb-universal-search')).not.toHaveClass(/\bis-open\b/);
        await search.fill('Fixture Relative');
        await expect(ui.row('sbFixtureRelative')).toBeVisible();
        await expect(ui.row('main')).toHaveCount(0);
        await expect(page.locator('.sb-prompt-editor > .sb-list-editor__status')).toHaveText(/^1 of \d+ results$/);
        await search.fill('zz-no-such-prompt');
        await expect(page.locator('.sb-prompt-editor > .sb-list-editor__status')).toHaveText('No results');
        await page.keyboard.press('Escape');
        await expect(search).toBeHidden();
        await expect(searchButton).toBeFocused();
        await expect(searchButton).toHaveAttribute('aria-expanded', 'false');
        await expect(ui.row('main')).toBeVisible();

        await ui.row('main').focus();
        await page.keyboard.type('Fix');
        await expect(search).toBeFocused();
        await expect(search).toHaveValue('Fix');
        await expect(ui.row('main')).toHaveCount(0);
    });

    test('clearing a search restores the list scroll position after the unfiltered render', async ({ page }) => {
        await setup(page);
        const body = page.locator('.sb-prompt-list-body');
        const saved = await body.evaluate(node => {
            node.scrollTo({ top: node.scrollHeight, behavior: 'instant' });
            return node.scrollTop;
        });
        expect(saved).toBeGreaterThan(0);
        await page.getByRole('button', { name: 'Search prompts', exact: true }).click();
        const search = page.getByRole('searchbox', { name: 'Search prompts', exact: true });
        await search.fill('Fixture Relative');
        await expect.poll(() => body.evaluate(node => node.scrollHeight <= node.clientHeight + 1)).toBe(true);
        await search.fill('');
        await expect.poll(() => body.evaluate(node => Math.round(node.scrollTop))).toBe(Math.round(saved));
    });

    test('dirty leave Save persists the draft and closes the editor', async ({ page }) => {
        const { store, ui } = await setup(page);
        await ui.openEditor('sbFixtureRelative');
        await ui.fill({ content: 'Saved through the leave guard' });
        await page.getByRole('button', { name: 'Back to prompt list', exact: true }).click();
        await page.locator('dialog.popup[open] .popup-button-ok').click();
        await waitForSavedOai(store, oai => promptFor(oai, 'sbFixtureRelative')?.content === 'Saved through the leave guard');
        await expect(page.locator('.sb-prompt-editor')).toHaveAttribute('data-open', 'false');
        await expect(ui.row('sbFixtureRelative')).toBeFocused();
    });

    test('position controls reveal depth, order and six generation triggers', async ({ page }) => {
        const { ui } = await setup(page);
        await ui.openEditor('sbFixtureRelative');
        await expect(page.getByRole('spinbutton', { name: 'Depth', exact: true })).toHaveCount(0);
        await ui.fill({ position: 1 });
        await expect(page.getByRole('spinbutton', { name: 'Depth', exact: true })).toBeVisible();
        await expect(page.getByRole('spinbutton', { name: 'Order', exact: true })).toBeVisible();
        await page.getByRole('button', { name: 'Triggers', exact: true }).click();
        await expect(page.getByRole('dialog', { name: 'Generation triggers', exact: true }).getByRole('checkbox')).toHaveCount(6);
    });

    test('Preview renders macros from the draft instead of the edit form', async ({ page }) => {
        const { ui, baseline } = await setup(page);
        await ui.openEditor('sbFixtureRelative');
        await ui.fill({ content: 'Before{{newline}}After' });
        await page.getByRole('group', { name: 'Editor mode', exact: true }).getByRole('radio', { name: 'Preview', exact: true }).check();
        await expect(page.locator('.sb-prompt-preview')).toHaveText('Before\nAfter');
        await expect(page.locator('.sb-prompt-textarea')).toHaveCount(0);
        expect((await readLiveOai(page)).prompts).toEqual(baseline.prompts);
        await page.getByRole('group', { name: 'Editor mode', exact: true }).getByRole('radio', { name: 'Edit', exact: true }).check();
        await expect(page.locator(`${FORM}_prompt`)).toHaveValue('Before{{newline}}After');
    });

    test('Inspect shows assembled messages and token breakdown without the edit form', async ({ page }) => {
        const { ui } = await setup(page);
        const count = await page.evaluate(async () => {
            const { Message, MessageCollection, promptManager } = await import('/scripts/openai.js');
            const message = await Message.createAsync('system', 'SillyBunny inspection fixture', 'main');
            promptManager.setMessages(new MessageCollection('inspection-fixture', message));
            return message.getTokens();
        });
        await ui.openEditor('main');
        await page.getByRole('button', { name: 'Inspect', exact: true }).click();
        const message = page.locator('.sb-prompt-inspect-message');
        await expect(message.locator('summary')).toContainText(`system · ${count} tokens`);
        await message.locator('summary').click();
        await expect(message.locator('pre')).toHaveText('SillyBunny inspection fixture');
        await expect(page.locator('.sb-prompt-textarea, .sb-prompt-detail > .sb-prompt-properties')).toHaveCount(0);
    });

    test('the owned editor ignores the legacy drag lock and disables reorder only for search', async ({ page }) => {
        const { store, ui } = await setup(page, { dragLocked: true });
        await page.getByRole('button', { name: 'Prompt list actions', exact: true }).click();
        await expect(page.getByRole('menuitem', { name: /^(Lock|Unlock) prompt order$/ })).toHaveCount(0);
        await page.keyboard.press('Escape');
        await expect(ui.row('sbFixtureRelative').locator('.sb-prompt-grip')).toHaveAttribute('aria-disabled', 'false');
        await ui.moveBefore('sbFixtureRelative', 'main');
        await waitForSavedOai(store, oai => orderFor(oai, GLOBAL_ORDER_ID)[0]?.identifier === 'sbFixtureRelative');
        expect(store.settingsSaves.at(-1).power_user.prompt_manager_drag_locked).toBe(true);
        await page.getByRole('button', { name: 'Search prompts', exact: true }).click();
        const search = page.getByRole('searchbox', { name: 'Search prompts', exact: true });
        await search.fill('Fixture');
        await expect(ui.row('sbFixtureRelative').locator('.sb-prompt-grip')).toHaveAttribute('aria-disabled', 'true');
        const before = await ui.visibleOrder();
        await ui.row('sbFixtureRelative').focus();
        await page.keyboard.press('Alt+ArrowDown');
        expect(await ui.visibleOrder()).toEqual(before);
        await search.fill('');
        await expect(ui.row('sbFixtureRelative').locator('.sb-prompt-grip')).toHaveAttribute('aria-disabled', 'false');
    });

    test('runtime Agents align with prompt columns without interactive placeholders', async ({ page }) => {
        const { ui } = await setup(page);
        for (const prepare of [async () => {}, () => ui.openEditor('main')]) {
            await prepare();
            const geometry = await page.locator('.sb-prompt-order').evaluate(node => {
                const measure = id => {
                    const row = node.querySelector(`[data-prompt-id="${id}"]`);
                    const icon = row.querySelector(':scope > i').getBoundingClientRect();
                    const name = row.querySelector('.sb-prompt-row-name').getBoundingClientRect();
                    const token = row.querySelector('.sb-prompt-token').getBoundingClientRect();
                    const rect = row.getBoundingClientRect();
                    return { iconLeft: icon.left, nameLeft: name.left, tokenRight: token.right, iconCenter: icon.top + icon.height / 2, rowCenter: rect.top + rect.height / 2 };
                };
                return { main: measure('main'), agents: measure('sillybunnyRuntimeAgents') };
            });
            expect(Math.abs(geometry.agents.iconLeft - geometry.main.iconLeft)).toBeLessThanOrEqual(1);
            expect(Math.abs(geometry.agents.nameLeft - geometry.main.nameLeft)).toBeLessThanOrEqual(1);
            expect(Math.abs(geometry.agents.tokenRight - geometry.main.tokenRight)).toBeLessThanOrEqual(1);
            expect(Math.abs(geometry.agents.iconCenter - geometry.agents.rowCenter)).toBeLessThanOrEqual(1);
            await expect(ui.row('sillybunnyRuntimeAgents').locator('button, input, [role="button"]')).toHaveCount(0);
        }
    });

    test('saving introduces no oai_settings, settings or preset keys', async ({ page }) => {
        const { store, ui } = await setup(page);
        const beforeKeys = await page.evaluate(async () => {
            const { oai_settings } = await import('/scripts/openai.js');
            await (await import('/script.js')).saveSettings();
            return Object.keys(oai_settings).sort();
        });
        const beforeSettings = structuredClone(store.settingsSaves.at(-1));
        await ui.openEditor('sbFixtureRelative');
        await ui.fill({ content: 'Schema-preserving save' });
        await ui.save();
        const saved = await waitForSavedOai(store, oai => promptFor(oai, 'sbFixtureRelative')?.content === 'Schema-preserving save');
        expect(Object.keys(saved).sort()).toEqual(beforeKeys);
        const after = store.settingsSaves.at(-1);
        expect(Object.keys(after).sort()).toEqual(Object.keys(beforeSettings).sort());
        expect(Object.keys(after.power_user).sort()).toEqual(Object.keys(beforeSettings.power_user).sort());
        expect(Object.keys(promptFor(saved, 'sbFixtureRelative')).sort()).toEqual(Object.keys(promptFor(beforeSettings.oai_settings, 'sbFixtureRelative')).sort());
        const exported = await ui.exportList();
        expect(Object.keys(exported.data).sort()).toEqual(['data', 'type', 'version']);
        expect(Object.keys(exported.data.data).sort()).toEqual(['prompt_order', 'prompts']);
        expect(store.presetSaves).toHaveLength(0);
    });
});

test.describe('Prompt editor mobile interaction', () => {
    test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

    test('property sheet saves role and injection settings and returns to a scrollable list', async ({ page }) => {
        const store = await installFixture(page);
        const ui = promptEditorDriver(page);
        await ui.open();
        await page.getByRole('tab', { name: 'Editor', exact: true }).click();
        await ui.openEditor('sbFixtureInChat');
        const editor = page.locator('.sb-prompt-detail');
        await expect(page.locator('.sb-prompt-owned > .sb-backend-section-header')).toBeHidden();
        await editor.getByRole('button', { name: 'Prompt properties', exact: true }).click();
        const sheet = page.getByRole('dialog', { name: 'Prompt properties', exact: true });
        await sheet.getByRole('button', { name: 'Role', exact: true }).click();
        await page.getByRole('option', { name: 'Assistant', exact: true }).click();
        await sheet.getByRole('spinbutton', { name: 'Depth', exact: true }).fill('6');
        await sheet.getByRole('button', { name: 'Close prompt properties', exact: true }).click();
        await expect(sheet).toBeHidden();
        await ui.save();
        const saved = await waitForSavedOai(store, oai => promptFor(oai, 'sbFixtureInChat')?.injection_depth === 6);
        expect(promptFor(saved, 'sbFixtureInChat')).toMatchObject({ role: 'assistant', injection_position: 1 });
        await ui.close();
        await expect(page.locator('.sb-prompt-owned > .sb-backend-section-header')).toBeVisible();
        const row = ui.row('sbFixtureInChat');
        await row.focus();
        await page.keyboard.press('Alt+ArrowUp');
        await waitForSavedOai(store, oai => orderFor(oai, GLOBAL_ORDER_ID)[0]?.identifier === 'sbFixtureInChat');
        const body = page.locator('.sb-prompt-list-body');
        await body.evaluate(node => node.scrollTo({ top: node.scrollHeight, behavior: 'instant' }));
        expect(await body.evaluate(node => node.scrollTop)).toBeGreaterThan(0);
    });

    for (const mode of ['edit', 'preview']) {
        test(`mobile list-only default pushes ${mode} and Back restores the list`, async ({ page }) => {
            const store = await installFixture(page);
            const ui = promptEditorDriver(page);
            await ui.open();
            await page.getByRole('tab', { name: 'Editor', exact: true }).click();
            const root = page.locator('.sb-prompt-editor');
            const list = page.locator('.sb-prompt-list');
            const editor = page.locator('.sb-prompt-detail');
            await expect(root).toHaveAttribute('data-collapsed', 'true');
            await expect(editor).toBeHidden();
            await expect(list).toBeVisible();
            await ui.openEditor('main');
            await expect(root).toHaveAttribute('data-open', 'true');
            expect(await list.evaluate(node => node.inert)).toBe(true);
            const geometry = await editor.boundingBox();
            expect(geometry.width).toBeGreaterThan(300);
            await ui.selectMode(mode);
            await expect(editor.locator(mode === 'preview' ? '.sb-prompt-preview' : '.sb-prompt-textarea')).toBeVisible();
            await ui.close();
            await expect(root).toHaveAttribute('data-open', 'false');
            expect(await list.evaluate(node => node.inert)).toBe(false);
            await expect(ui.row('main')).toBeFocused();
            await expect(ui.row('main')).not.toHaveClass(/is-selected/);
            for (const saved of store.settingsSaves) expect(saved.oai_settings.prompts).toEqual(buildFixturePreset().prompts);
        });
    }
});
