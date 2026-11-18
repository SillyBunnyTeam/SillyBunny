import { expect, test } from '@playwright/test';
import { openQuietChatForSmoke } from './chat-scroll-regression-helpers.js';
import { protectMaintainerServer } from './helpers/maintainer-server.js';
import { fetchBodyOrSkip } from './helpers/route-fetch.js';
import { applyWelcomeSettings } from './helpers/welcome-dialog.js';
import { waitForAppReady } from './helpers/app-ready.js';

// Selection controls and per-device settings: the Slider Mode choice, the one Top Bar Label for every width, the Quick Access
// slots that exist only on the desktop bar, and the Chat Completion presets that became select rows over their upstream radios.

test.beforeEach(async ({ page }) => { await protectMaintainerServer(page); });
test.use({ serviceWorkers: 'block', contextOptions: { reducedMotion: 'reduce' } });
test.describe.configure({ timeout: 90_000 });

const VIEWPORTS = [{ width: 1440, height: 900 }, { width: 390, height: 844 }];

async function loadSettings(page, baseURL, { storage = {} } = {}) {
    expect(['127.0.0.1', 'localhost', '[::1]']).toContain(new URL(baseURL).hostname);
    await page.addInitScript(entries => {
        for (const [key, value] of Object.entries(entries)) localStorage.setItem(key, value);
    }, storage);
    let version = 1_000_000_000_000_000;
    await page.route('**/api/settings/save', route => route.fulfill({ json: { result: 'ok', version: ++version } }));
    await page.route('**/api/settings/get', async route => {
        const fetched = await fetchBodyOrSkip(route, response => response.json());
        if (!fetched) return;
        const { response, body: data } = fetched;
        const settings = JSON.parse(data.settings);
        settings.firstRun = false;
        applyWelcomeSettings(settings);
        data.request_compression = { ...data.request_compression, enabled: false };
        data.settings = JSON.stringify(settings);
        return route.fulfill({ response, json: data });
    });
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await waitForAppReady(page, { timeout: 60000 });
}

async function openSettingsTab(page, tab, shell) {
    await page.evaluate(({ shell, tab }) => window.SillyBunnyShell.openTab(shell, tab), { shell, tab });
    await page.locator(`button[data-sb-settings-tab="${tab}"]`).evaluate(element => element.click());
    const panel = page.locator(`[data-sb-panel="${tab}"]`);
    await expect(panel).toHaveAttribute('aria-hidden', 'false');
    return panel;
}

for (const viewport of VIEWPORTS) {
    test.describe(`at ${viewport.width}x${viewport.height}`, () => {
        test.use({ viewport });

        test('Slider Mode is one choice of three over the two upstream inputs', async ({ page, baseURL }) => {
            await loadSettings(page, baseURL);
            const appearance = await openSettingsTab(page, 'appearance', 'right');
            const row = appearance.locator('#sb-slider-mode');
            await row.scrollIntoViewIfNeeded();
            await expect(row).toBeVisible();
            await expect(row.locator('.sb-boolean-radio-option span')).toHaveText(['None', 'Zen Sliders', 'Mad Lab Mode']);
            // Upstream's inputs stay in the document, out of sight, because their handlers store the two booleans.
            await expect(page.locator('#enableZenSliders')).toBeHidden();
            await expect(page.locator('#enableLabMode')).toBeHidden();
            await expect(appearance.locator('#enableZenSliders')).toHaveCount(1);

            // The switch functions of power-user.js change the page after a 100 ms delay and then build or remove every slider.
            const slow = { timeout: 20_000 };
            const pick = name => row.locator('.sb-boolean-radio-option', { hasText: name }).click();
            await pick('Mad Lab Mode');
            await expect(page.locator('#enableLabMode')).toBeChecked(slow);
            await expect(page.locator('body')).toHaveClass(/enableLabMode/, slow);
            await expect(page.locator('#enableZenSliders')).not.toBeChecked();

            await pick('Zen Sliders');
            await expect(page.locator('#enableZenSliders')).toBeChecked(slow);
            await expect(page.locator('#enableLabMode')).not.toBeChecked();
            await expect(page.locator('body')).toHaveClass(/enableZenSliders/, slow);
            await expect(page.locator('body')).not.toHaveClass(/enableLabMode/, slow);
            await expect(page.locator('.toast-warning')).toHaveCount(0);

            await pick('None');
            await expect(page.locator('#enableZenSliders')).not.toBeChecked();
            await expect(page.locator('#enableLabMode')).not.toBeChecked();
            await expect(page.locator('body')).not.toHaveClass(/enableZenSliders/, slow);
            const stored = await page.evaluate(() => {
                const { powerUserSettings } = window.SillyTavern.getContext();
                return [powerUserSettings.enableZenSliders, powerUserSettings.enableLabMode];
            });
            expect(stored).toEqual([false, false]);
        });

        test('the Top Bar Label is one group of three switches and one custom text field', async ({ page, baseURL }) => {
            await loadSettings(page, baseURL);
            const appearance = await openSettingsTab(page, 'appearance', 'right');
            const group = appearance.locator('#sb-topbar-label-drawer');
            await expect(group).toBeVisible();
            await expect(group.locator('.ds-row-switch')).toHaveCount(3);
            await expect(group.locator('.ds-row-check')).toHaveCount(0);
            await expect(group.locator('.ds-pref-group-subtitle')).toHaveText('Choose what the center label shows');
            await expect(appearance.locator('[data-sb-category="topbar-custom-text"] .ds-pref-group-subtitle'))
                .toHaveText('This only appears in the top bar when the Custom Text switch is enabled above');
            await expect(appearance.locator('.sb-topbar-custom-text-input')).toHaveCount(1);
            await expect(page.locator('#sb-topbar-label-mobile-group, #sb-topbar-custom-text-input-mobile')).toHaveCount(0);
            await expect(group.locator('input[type="checkbox"]:checked')).toHaveCount(1);
            await expect(page.locator('#sb-topbar-label-desktop-char')).toBeChecked();
        });

        test('a mix of label parts shows in the bar, from one stored list', async ({ page }) => {
            await openQuietChatForSmoke(page);
            const character = await page.evaluate(() => window.SillyTavern.getContext().name2);
            expect(character).toBeTruthy();
            const appearance = await openSettingsTab(page, 'appearance', 'right');
            await appearance.locator('[data-sb-editor-field="topbar-label-custom"]').scrollIntoViewIfNeeded();
            await appearance.locator('[data-sb-editor-field="topbar-label-custom"]').click();
            const input = appearance.locator('#sb-topbar-custom-text-input');
            await input.fill('My Label');
            await input.blur();
            await expect(page.locator('#sb-topbar-title')).toHaveText(`${character} · My Label`);
            const stored = await page.evaluate(() => ({
                parts: localStorage.getItem('sb-topbar-label-desktop-parts'),
                phone: localStorage.getItem('sb-topbar-label-mobile-part'),
            }));
            expect(stored).toEqual({ parts: '["char","custom"]', phone: null });
        });

        test('a browser that stored only a phone value starts from it, and the phone key is left alone', async ({ page, baseURL }) => {
            await loadSettings(page, baseURL, { storage: { 'sb-topbar-label-mobile-part': 'custom', 'sb-topbar-label-custom-text': 'From Phone' } });
            await expect(page.locator('#sb-topbar-title')).toHaveText('From Phone');
            const stored = await page.evaluate(() => ({
                parts: localStorage.getItem('sb-topbar-label-desktop-parts'),
                phone: localStorage.getItem('sb-topbar-label-mobile-part'),
            }));
            expect(stored).toEqual({ parts: '["custom"]', phone: 'custom' });
            const appearance = await openSettingsTab(page, 'appearance', 'right');
            await expect(appearance.locator('#sb-topbar-label-desktop-custom')).toBeChecked();
            await expect(appearance.locator('#sb-topbar-label-desktop-char')).not.toBeChecked();
        });

        test('Quick Access is offered on the desktop page alone', async ({ page, baseURL }) => {
            await loadSettings(page, baseURL);
            const appearance = await openSettingsTab(page, 'appearance', 'right');
            const group = appearance.locator('#sb-quick-access-shortcuts-drawer');
            await expect(group).toHaveCount(1);
            await expect(group.locator('[data-sb-editor-field^="shortcut-"]')).toHaveCount(6);
            await expect(group.locator('visible=true')).toHaveCount(viewport.width > 768 ? 1 : 0);
            await expect(group.locator('.ds-row:visible')).toHaveCount(viewport.width > 768 ? 6 : 0);
        });

        test('Character Names Behavior and Continue Postfix are select rows over their radios', async ({ page, baseURL }) => {
            await loadSettings(page, baseURL);
            await page.evaluate(() => {
                $('#main_api').val('openai').trigger('change');
                $('#chat_completion_source').val('openrouter').trigger('change');
            });
            const prompting = await openSettingsTab(page, 'prompting', 'left');
            const cases = [
                { title: 'Character Names Behavior', group: '#sb-openai-names-behavior', radio: '#character_names_content', label: 'Message Content', value: 2, key: 'names_behavior', total: 4 },
                { title: 'Continue Postfix', group: '#sb-openai-continue-postfix', radio: '#continue_postfix_newline', label: 'Newline', value: '\n', key: 'continue_postfix', total: 4 },
            ];
            for (const { title, group, radio, label, value, key, total } of cases) {
                const section = prompting.locator(group);
                await section.scrollIntoViewIfNeeded();
                await expect(section.locator('.ds-select-row')).toHaveCount(1);
                // The row keeps the title, so the group has no heading and its box is named by a label.
                await expect(section.locator('.ds-pref-group-heading, .sb-settings-category-title')).toHaveCount(0);
                await expect(section.locator('[role="group"]')).toHaveAttribute('aria-label', title);
                await expect(section.locator('.ds-row-check')).toHaveCount(0);
                await expect(page.locator(radio)).toBeHidden();
                await section.locator('.ds-select-row__trigger').click();
                const picker = page.locator('.sb-picker:visible, .sb-picker-sheet:visible').last();
                await expect(picker.getByRole('option')).toHaveCount(total);
                await picker.getByRole('option', { name: new RegExp(`^${label}`) }).click(); // The option's name continues with its note.
                await expect(page.locator(radio)).toBeChecked();
                await expect(section.locator('.ds-select-row__value')).toHaveText(label);
                const stored = await page.evaluate(settingKey => String(window.SillyTavern.getContext().chatCompletionSettings[settingKey]), key);
                expect(stored).toBe(String(value));
            }
        });

        test('a preset load that checks a radio with no event moves the select row', async ({ page, baseURL }) => {
            await loadSettings(page, baseURL);
            await page.evaluate(() => {
                $('#main_api').val('openai').trigger('change');
                $('#chat_completion_source').val('openrouter').trigger('change');
            });
            const prompting = await openSettingsTab(page, 'prompting', 'left');
            const section = prompting.locator('#sb-openai-names-behavior');
            await section.scrollIntoViewIfNeeded();
            await page.evaluate(() => {
                $('#character_names_completion').prop('checked', true);
                $('#character_names_display').text($('input[name="character_names"]:checked ~ span').text().trim());
            });
            await expect(section.locator('.ds-select-row__value')).toHaveText('Completion Object');
        });
    });
}
