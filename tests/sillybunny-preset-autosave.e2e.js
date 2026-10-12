import { expect, test } from '@playwright/test';

test.use({ serviceWorkers: 'block', reducedMotion: 'reduce' });

const USER_PRESET = 'SB Autosave Test';
const SECOND_PRESET = 'SB Autosave Second';
const BUNDLED = Object.freeze({ openai: ['Default'], textgenerationwebui: ['Default'] });
const AUTOSAVE_DELAY_MS = 1000;

/**
 * Loads the app with every write intercepted before navigation.
 * @param {import('@playwright/test').Page} page
 * @param {{ firstRun?: boolean, autosave?: boolean|null }} [options] `autosave: null` leaves the key absent.
 */
async function loadApp(page, { firstRun = false, autosave = true } = {}) {
    const saves = [];
    const origin = new URL(test.info().project.use.baseURL ?? 'http://127.0.0.1:4444').origin;
    const readOnlyEndpoints = new Set([
        '/api/characters/all', '/api/characters/chats', '/api/groups/all', '/api/backgrounds/all',
        '/api/avatars/get', '/api/stats/get', '/api/secrets/read', '/api/users/me',
    ]);
    await page.route('**/*', async route => {
        const request = route.request();
        const url = new URL(request.url());
        if (url.origin !== origin) return route.abort();
        if (url.pathname === '/api/extensions/discover') {
            const response = await route.fetch();
            const extensions = await response.json();
            return route.fulfill({ json: extensions.filter(extension => !extension.name.startsWith('third-party/')) });
        }
        if (url.pathname === '/api/settings/get') {
            const response = await route.fetch();
            const data = await response.json();
            data.request_compression = { ...data.request_compression, enabled: false };
            const settings = JSON.parse(data.settings);
            settings.firstRun = firstRun;
            settings.main_api = 'openai';
            settings.extension_settings['quick-image-gen'] = { ...settings.extension_settings['quick-image-gen'], setupWizardSeen: true };
            if (autosave === null) delete settings.power_user.sb_preset_autosave;
            else settings.power_user.sb_preset_autosave = autosave;
            data.settings = JSON.stringify(settings);
            // User presets cloned from the bundled defaults, so tests never depend on local preset files.
            const openaiDefault = data.openai_settings[data.openai_setting_names.indexOf('Default')];
            const textgenDefault = data.textgenerationwebui_presets[data.textgenerationwebui_preset_names.indexOf('Default')];
            for (const name of [USER_PRESET, SECOND_PRESET]) {
                data.openai_settings.push(openaiDefault);
                data.openai_setting_names.push(name);
                data.textgenerationwebui_presets.push(textgenDefault);
                data.textgenerationwebui_preset_names.push(name);
            }
            return route.fulfill({ json: data });
        }
        if (url.pathname === '/api/presets/defaults') {
            return route.fulfill({ json: { names: BUNDLED[request.postDataJSON()?.apiId] ?? [] } });
        }
        if (url.pathname === '/api/presets/save') {
            const body = request.postDataJSON();
            saves.push(body);
            return route.fulfill({ json: { name: body?.name ?? '' } });
        }
        if (url.pathname === '/api/settings/save') return route.fulfill({ json: { version: Date.now() } });
        if (readOnlyEndpoints.has(url.pathname) || url.pathname.startsWith('/api/tokenizers/')) return route.continue();
        if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method()) && url.pathname.startsWith('/api/')) {
            return route.fulfill({ json: {} });
        }
        return route.continue();
    });
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    if (firstRun) {
        const onboarding = page.locator('.popup:has(.onboarding)');
        await expect(onboarding).toBeVisible({ timeout: 60000 });
        await onboarding.locator('.popup-button-ok').click();
    }
    await page.waitForFunction(() => window.SillyTavern?.getContext?.()?.eventSource?.autoFireLastArgs?.has('app_ready'), null, { timeout: 60000 });
    return saves;
}

async function selectPreset(page, apiId, name) {
    await page.evaluate(async ({ apiId, name }) => {
        const { getPresetManager } = await import('/scripts/preset-manager.js');
        const manager = getPresetManager(apiId);
        await manager.selectPreset(manager.findPreset(name));
    }, { apiId, name });
}

async function openPanel(page, tab) {
    await page.evaluate(tab => window.SillyBunnyShell.openTab('left', tab), tab);
    await page.locator(`button[data-sb-settings-tab="${tab}"]`).evaluate(button => button.click());
    const panel = page.locator(`[data-sb-panel="${tab}"]`);
    await expect(panel).toHaveAttribute('aria-hidden', 'false');
    return panel;
}

/** Nudges the CC temperature slider with the keyboard, which produces trusted input events. */
async function nudgeTemperature(page, steps = 1) {
    const panel = await openPanel(page, 'sampling');
    const slider = panel.locator('#temp_openai');
    await slider.scrollIntoViewIfNeeded();
    await slider.focus();
    for (let step = 0; step < steps; step++) await page.keyboard.press('ArrowRight');
    return Number(await slider.inputValue());
}

const waitPastDebounce = page => page.waitForTimeout(AUTOSAVE_DELAY_MS + 700);

const readAutosave = page => page.evaluate(async () => (await import('/scripts/power-user.js')).power_user.sb_preset_autosave);

test('autosave defaults on for new installs', async ({ page }) => {
    await loadApp(page, { firstRun: true, autosave: null });
    expect(await readAutosave(page)).toBe(true);
});

test('autosave defaults off on upgrade', async ({ page }) => {
    await loadApp(page, { firstRun: false, autosave: null });
    expect(await readAutosave(page)).toBe(false);
});

test('an explicit saved setting wins over the first-run default', async ({ page }) => {
    await loadApp(page, { firstRun: true, autosave: false });
    expect(await page.evaluate(async () => (await import('/scripts/power-user.js')).power_user.sb_preset_autosave)).toBe(false);
});

test('edits in Sampling, Presets and Editor each save the owning preset once after the debounce', async ({ page }) => {
    const saves = await loadApp(page);
    await selectPreset(page, 'openai', USER_PRESET);
    await waitPastDebounce(page);
    expect(saves).toHaveLength(0);

    const temperature = await nudgeTemperature(page, 3);
    await page.waitForTimeout(AUTOSAVE_DELAY_MS - 400);
    expect(saves, 'saves wait for the debounce').toHaveLength(0);
    await expect.poll(() => saves.length).toBe(1);
    expect(saves[0]).toMatchObject({ apiId: 'openai', name: USER_PRESET });
    expect(saves[0].preset.temperature).toBeCloseTo(temperature);

    const presets = await openPanel(page, 'prompting');
    const maxTokens = presets.locator('#openai_max_tokens');
    await maxTokens.scrollIntoViewIfNeeded();
    await maxTokens.fill('777');
    await expect.poll(() => saves.length).toBe(2);
    expect(saves[1]).toMatchObject({ apiId: 'openai', name: USER_PRESET, preset: { openai_max_tokens: 777 } });

    const editor = await openPanel(page, 'editor');
    const impersonation = editor.locator('#impersonation_prompt_textarea');
    await impersonation.scrollIntoViewIfNeeded();
    await impersonation.click();
    await page.keyboard.press('End');
    await page.keyboard.type(' autosaved');
    await expect.poll(() => saves.length).toBe(3);
    expect(saves[2]).toMatchObject({ apiId: 'openai', name: USER_PRESET });
    expect(saves[2].preset.impersonation_prompt).toMatch(/ autosaved$/);

    await waitPastDebounce(page);
    expect(saves).toHaveLength(3);
});

test('Text Completions edits save the Text Completions preset', async ({ page }) => {
    const saves = await loadApp(page);
    await page.evaluate(() => $('#main_api').val('textgenerationwebui').trigger('change'));
    await selectPreset(page, 'textgenerationwebui', USER_PRESET);
    await waitPastDebounce(page);
    expect(saves).toHaveLength(0);

    const panel = await openPanel(page, 'sampling');
    const slider = panel.locator('#temp_textgenerationwebui');
    await slider.scrollIntoViewIfNeeded();
    await slider.focus();
    await page.keyboard.press('ArrowRight');
    await expect.poll(() => saves.length).toBe(1);
    expect(saves[0]).toMatchObject({ apiId: 'textgenerationwebui', name: USER_PRESET });
    await waitPastDebounce(page);
    expect(saves.map(save => save.apiId)).toEqual(['textgenerationwebui']);
});

test('interactions that change nothing save nothing', async ({ page }) => {
    const saves = await loadApp(page);
    await selectPreset(page, 'openai', USER_PRESET);
    const panel = await openPanel(page, 'sampling');
    await panel.locator('.sb-shell-panel-scroller').click({ position: { x: 4, y: 4 } });
    await panel.locator('#temp_openai').focus();
    await page.keyboard.press('Tab');
    await waitPastDebounce(page);
    expect(saves).toHaveLength(0);
});

test('programmatic changes never write a preset', async ({ page }) => {
    const saves = await loadApp(page);
    await selectPreset(page, 'openai', USER_PRESET);
    await selectPreset(page, 'openai', SECOND_PRESET);
    await page.evaluate(async () => {
        const { eventSource, event_types } = await import('/script.js');
        $('#temp_openai').val(1.37).trigger('input');
        $('#openai_max_tokens').val(321).trigger('input');
        $('#impersonation_prompt_textarea').val('programmatic').trigger('input');
        document.getElementById('temp_openai').dispatchEvent(new Event('input', { bubbles: true }));
        await eventSource.emit(event_types.CONNECTION_PROFILE_LOADED, 'SB Test Profile');
        $('#main_api').val('textgenerationwebui').trigger('change');
        $('#main_api').val('openai').trigger('change');
    });
    await selectPreset(page, 'openai', USER_PRESET);
    await waitPastDebounce(page);
    expect(saves).toHaveLength(0);
});

test('editing a bundled preset forks it once and keeps saving the copy', async ({ page }) => {
    const saves = await loadApp(page);
    await selectPreset(page, 'openai', 'Default');
    await nudgeTemperature(page);
    await expect.poll(() => saves.length).toBe(1);
    expect(saves[0]).toMatchObject({ apiId: 'openai', name: 'Default (copy)' });
    await expect(page.locator('#toast-container')).toContainText('Bundled presets are read-only. Your changes were saved to "Default (copy)".');
    await expect(page.locator('#settings_preset_openai option:checked')).toHaveText('Default (copy)');
    expect(await page.evaluate(async () => (await import('/scripts/openai.js')).oai_settings.preset_settings_openai)).toBe('Default (copy)');

    const temperature = await nudgeTemperature(page);
    await expect.poll(() => saves.length).toBe(2);
    expect(saves[1]).toMatchObject({ apiId: 'openai', name: 'Default (copy)' });
    expect(saves[1].preset.temperature).toBeCloseTo(temperature);
    expect(saves.filter(save => save.name === 'Default')).toHaveLength(0);
});

test('Update is disabled for bundled presets only and saves the same shape as autosave', async ({ page }) => {
    const saves = await loadApp(page, { autosave: false });
    await openPanel(page, 'prompting');
    const update = page.locator('#update_oai_preset');

    await selectPreset(page, 'openai', 'Default');
    await expect(update).toHaveAttribute('aria-disabled', 'true');
    await expect(update).toHaveAttribute('title', 'Bundled presets are read-only. Use Save as to keep your changes.');
    await update.click({ force: true });
    await page.waitForTimeout(500);
    expect(saves).toHaveLength(0);
    await expect(page.locator('#new_oai_preset')).not.toHaveAttribute('aria-disabled', 'true');

    await selectPreset(page, 'openai', USER_PRESET);
    await expect(update).not.toHaveAttribute('aria-disabled', 'true');
    await expect(update).toHaveAttribute('title', 'Update current preset');

    await nudgeTemperature(page);
    await waitPastDebounce(page);
    expect(saves, 'autosave off never writes').toHaveLength(0);

    await openPanel(page, 'prompting');
    await update.click();
    await expect.poll(() => saves.length).toBe(1);
    const updateBody = saves[0];

    await page.evaluate(async () => { (await import('/scripts/power-user.js')).power_user.sb_preset_autosave = true; });
    await nudgeTemperature(page);
    await expect.poll(() => saves.length).toBe(2);
    expect(Object.keys(saves[1].preset).sort()).toEqual(Object.keys(updateBody.preset).sort());
    expect(saves[1].name).toBe(updateBody.name);
});

test('switching presets flushes the pending save to the previous preset first', async ({ page }) => {
    const saves = await loadApp(page);
    await selectPreset(page, 'openai', USER_PRESET);
    const editor = await openPanel(page, 'editor');
    const impersonation = editor.locator('#impersonation_prompt_textarea');
    await impersonation.scrollIntoViewIfNeeded();
    await impersonation.click();
    await page.keyboard.press('End');
    await page.keyboard.type(' before switch');

    await openPanel(page, 'prompting');
    await page.locator('#settings_preset_openai').selectOption({ label: SECOND_PRESET });
    await expect.poll(() => saves.length).toBe(1);
    expect(saves[0]).toMatchObject({ apiId: 'openai', name: USER_PRESET });
    expect(saves[0].preset.impersonation_prompt).toMatch(/ before switch$/);
    await expect(page.locator('.popup:has-text("Unsaved changes")')).toHaveCount(0);
    await expect(page.locator('#settings_preset_openai option:checked')).toHaveText(SECOND_PRESET);
    await expect(impersonation).not.toHaveValue(/ before switch$/);

    await waitPastDebounce(page);
    expect(saves).toHaveLength(1);
});

test('turning autosave off stops saves and restores the unsaved-changes guard', async ({ page }) => {
    const saves = await loadApp(page);
    await selectPreset(page, 'openai', USER_PRESET);
    const presets = await openPanel(page, 'prompting');
    const toggle = presets.locator('#sb_preset_autosave');
    await expect(toggle).toBeChecked();
    await toggle.scrollIntoViewIfNeeded();
    await presets.locator('label[for="sb_preset_autosave"]').click();
    await expect(toggle).not.toBeChecked();
    expect(await page.evaluate(async () => (await import('/scripts/power-user.js')).power_user.sb_preset_autosave)).toBe(false);

    await nudgeTemperature(page);
    await waitPastDebounce(page);
    expect(saves).toHaveLength(0);

    const editor = await openPanel(page, 'editor');
    await expect(editor.locator('[data-sb-editor-autosave]')).toHaveText('Autosave off');
    const impersonation = editor.locator('#impersonation_prompt_textarea');
    await impersonation.scrollIntoViewIfNeeded();
    await impersonation.click();
    await page.keyboard.type('x');
    await openPanel(page, 'prompting');
    await page.locator('#settings_preset_openai').selectOption({ label: SECOND_PRESET });
    await expect(page.locator('.popup:has-text("Unsaved changes")')).toBeVisible();
    expect(saves).toHaveLength(0);
});

test('Editor header shows autosave and read-only state', async ({ page }) => {
    await loadApp(page);
    await selectPreset(page, 'openai', 'Default');
    const editor = await openPanel(page, 'editor');
    await expect(editor.locator('[data-sb-editor-autosave]')).toHaveText('Autosave on');
    await expect(editor.locator('[data-sb-editor-read-only]')).toBeVisible();
    await selectPreset(page, 'openai', USER_PRESET);
    await expect(editor.locator('[data-sb-editor-read-only]')).toBeHidden();
});

test('autosave sits below the preset toolbar and Master Import/Export joins Text Completion actions', async ({ page }) => {
    await loadApp(page);
    const prompting = await openPanel(page, 'prompting');
    const placement = () => prompting.evaluate(panel => {
        const autosave = panel.querySelector('[data-sb-preset-autosave]');
        const toolbar = [...panel.querySelectorAll('.sb-preset-toolbar-row, .sb-non-chat-preset-row')].find(row => row.checkVisibility());
        const block = toolbar?.closest('[id$="_api-presets"]');
        const below = toolbar?.classList.contains('sb-preset-toolbar-row') ? toolbar.nextElementSibling : block?.nextElementSibling;
        const master = document.getElementById('af_master_import');
        return {
            autosaveBelowToolbar: below === autosave,
            masterVisible: master.checkVisibility(),
            masterInToolbar: toolbar?.contains(master) ?? false,
            masterAfterFileGroup: master.closest('.sb-action-btn-group')?.previousElementSibling?.matches('.sb-action-btn-group--file') ?? false,
        };
    });

    expect(await placement()).toEqual({ autosaveBelowToolbar: true, masterVisible: false, masterInToolbar: false, masterAfterFileGroup: false });
    for (const api of ['textgenerationwebui', 'kobold', 'novel']) {
        await page.evaluate(api => window.$('#main_api').val(api).trigger('change'), api);
        await expect.poll(placement).toEqual({ autosaveBelowToolbar: true, masterVisible: true, masterInToolbar: true, masterAfterFileGroup: true });
    }
    await expect(prompting.locator('#af_master_import')).toHaveAccessibleName('Master Import');
    await page.evaluate(() => window.$('#main_api').val('openai').trigger('change'));
    await expect.poll(placement).toEqual({ autosaveBelowToolbar: true, masterVisible: false, masterInToolbar: false, masterAfterFileGroup: true });
});
