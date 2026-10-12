import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';

test.use({ serviceWorkers: 'block', reducedMotion: 'reduce' });

const BASE_URL = process.env.SILLYBUNNY_TEST_BASE_URL || 'http://127.0.0.1:4444';
const DEFAULT_OPENAI_SETTINGS = JSON.parse(readFileSync(new URL('../default/content/settings.json', import.meta.url), 'utf8')).oai_settings;

const READ_ONLY_POST_ENDPOINTS = new Set([
    '/api/characters/all', '/api/characters/chats', '/api/groups/all', '/api/backgrounds/all',
    '/api/avatars/get', '/api/stats/get', '/api/secrets/read', '/api/users/me',
]);

async function mockWrites(page, settingsStore = null) {
    let settingsVersion = 1_000_000_000_000_000;

    await page.route('**/api/**', async route => {
        const request = route.request();
        const url = new URL(request.url());
        const method = request.method();

        if (url.pathname === '/api/settings/get') {
            const response = await route.fetch();
            const data = await response.json();
            const settings = settingsStore?.saved ?? JSON.parse(data.settings);
            settings.oai_settings = { ...settings.oai_settings, ...structuredClone(DEFAULT_OPENAI_SETTINGS) };
            settings.firstRun = false;
            settings._version ??= settingsVersion;
            settings.extension_settings ??= {};
            settings.extension_settings['quick-image-gen'] = {
                ...settings.extension_settings['quick-image-gen'],
                setupWizardSeen: true,
            };
            settingsVersion = Math.max(settingsVersion, settings._version);
            data.request_compression = { ...data.request_compression, enabled: false };
            data.settings = JSON.stringify(settings);
            return route.fulfill({ response, json: data });
        }

        if (url.pathname === '/api/settings/save') {
            settingsVersion += 1;
            settingsStore && (settingsStore.saved = { ...request.postDataJSON(), _version: settingsVersion });
            return route.fulfill({ json: { result: 'ok', version: settingsVersion } });
        }

        if (url.pathname === '/api/presets/save') {
            return route.fulfill({ json: { name: request.postDataJSON()?.name ?? '' } });
        }

        if (READ_ONLY_POST_ENDPOINTS.has(url.pathname) || url.pathname.startsWith('/api/tokenizers/')) {
            return route.continue();
        }

        const isWriteMethod = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method);
        const isWriteEndpoint = /^\/api\/.*\/(save|delete|create|edit|rename|update|import|upload|restore|duplicate|write|set)(?:\/|$)/i.test(url.pathname);
        if (isWriteMethod || isWriteEndpoint) {
            return route.fulfill({ json: {} });
        }

        return route.continue();
    });

    await page.route('**/api/savesettings**', route => route.fulfill({ json: { result: 'ok' } }));
}

async function loadApp(page) {
    const hostname = new URL(BASE_URL).hostname;
    expect(['127.0.0.1', 'localhost', '[::1]']).toContain(hostname);
    await mockWrites(page);
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(
        () => window.SillyTavern?.getContext?.()?.eventSource?.autoFireLastArgs?.has('app_ready'),
        null,
        { timeout: 60000 },
    );
}

async function openEditorTab(page) {
    await page.evaluate(() => window.SillyBunnyShell.openTab('left', 'editor'));
    const button = page.locator('button[data-sb-settings-tab="editor"]');
    await button.evaluate(el => el.click());
    const panel = page.locator('[data-sb-panel="editor"]');
    await expect(panel).toHaveAttribute('aria-hidden', 'false');
    await panel.locator('.sb-shell-panel-scroller').evaluate(s => { s.scrollTop = 0; });
    return panel;
}

async function switchToOpenAI(page) {
    await page.evaluate(() => {
        $('#main_api').val('openai').trigger('change');
        $('#chat_completion_source').val('openrouter').trigger('change');
    });
}

async function expandPromptManager(page) {
    const drawer = page.locator('#completion_prompt_manager_drawer');
    await expect(drawer).toBeVisible();
    if (await drawer.evaluate(element => element.classList.contains('sb-settings-flat-section'))) return;
    const icon = drawer.locator(':scope > .inline-drawer-header .inline-drawer-icon');
    const isOpen = await icon.evaluate(el => el.classList.contains('up'));
    if (!isOpen) {
        await drawer.locator(':scope > .inline-drawer-header').click();
        await expect(drawer.locator('.inline-drawer-content')).toBeVisible();
    }
}

// ── helpers ────────────────────────────────────────────────────────────────

function promptRow(page, identifier) {
    return page.locator(`#completion_prompt_manager_list li.completion_prompt_manager_prompt[data-pm-identifier="${identifier}"]`);
}

async function editPrompt(page, identifier) {
    const row = promptRow(page, identifier);
    await row.hover();
    await row.locator('.prompt-manager-edit-action').click();
    await expect(page.locator('#completion_prompt_manager_popup_edit')).toBeVisible();
}

// ── tests ──────────────────────────────────────────────────────────────────

test.describe('Prompt Manager — desktop split layout', () => {
    test.use({ viewport: { width: 1920, height: 1080 } });

    test('list and editor pane are both visible after selecting a prompt at desktop width', async ({ page }) => {
        await loadApp(page);
        await switchToOpenAI(page);
        await openEditorTab(page);
        await expandPromptManager(page);

        const listPane = page.locator('.completion_prompt_manager_list_pane');
        const editorPane = page.locator('.completion_prompt_manager_editor_pane');
        await expect(listPane).toBeVisible();
        await expect(editorPane).toBeHidden();
        await editPrompt(page, 'main');
        await expect(editorPane).toBeVisible();

        // Desktop split: list pane should be narrower than editor pane
        const listBox = await listPane.boundingBox();
        const editorBox = await editorPane.boundingBox();
        expect(listBox).not.toBeNull();
        expect(editorBox).not.toBeNull();
        expect(editorBox.width).toBeGreaterThan(listBox.width);
    });

    test('clicking a prompt row opens editor in the right pane without a modal', async ({ page }) => {
        await loadApp(page);
        await switchToOpenAI(page);
        await openEditorTab(page);
        await expandPromptManager(page);

        const mainRow = promptRow(page, 'main');
        await expect(mainRow).toBeVisible();
        await mainRow.click();

        // Editor popup must be visible inside the editor host (not a modal)
        const editorHost = page.locator('.completion_prompt_manager_editor_host');
        const popup = page.locator('#completion_prompt_manager_popup');
        await expect(popup).toBeVisible();
        const hostBox = await editorHost.boundingBox();
        const popupBox = await popup.boundingBox();
        expect(popupBox.x).toBeGreaterThanOrEqual(hostBox.x - 2);
        expect(popupBox.x + popupBox.width).toBeLessThanOrEqual(hostBox.x + hostBox.width + 2);
    });

    test('selected row gets the selected class', async ({ page }) => {
        await loadApp(page);
        await switchToOpenAI(page);
        await openEditorTab(page);
        await expandPromptManager(page);

        const mainRow = promptRow(page, 'main');
        await mainRow.click();
        await expect(mainRow).toHaveClass(/completion_prompt_manager_prompt_selected/);
    });

    test('edit form fields round-trip name, role, content', async ({ page }) => {
        await loadApp(page);
        await switchToOpenAI(page);
        await openEditorTab(page);
        await expandPromptManager(page);

        await editPrompt(page, 'main');

        const nameField = page.locator('#completion_prompt_manager_popup_entry_form_name');
        const roleField = page.locator('#completion_prompt_manager_popup_entry_form_role');
        const contentField = page.locator('#completion_prompt_manager_popup_entry_form_prompt');

        // Fields must be populated for an existing system prompt
        await expect(nameField).not.toHaveValue('');

        // Changing the name and saving should keep the editor open on desktop
        const originalName = await nameField.inputValue();
        const originalRole = await roleField.inputValue();
        const originalContent = await contentField.inputValue();
        await nameField.fill('SillyBunny Test Name');
        await roleField.selectOption('user');
        await contentField.fill('SillyBunny test prompt content');
        await page.locator('#completion_prompt_manager_popup_entry_form_save').click();

        // Editor stays open (desktop split layout)
        await expect(page.locator('#completion_prompt_manager_popup')).toBeVisible();
        await page.locator('#completion_prompt_manager_popup_entry_form_close').click();
        await editPrompt(page, 'main');
        await expect(nameField).toHaveValue('SillyBunny Test Name');
        await expect(roleField).toHaveValue('user');
        await expect(contentField).toHaveValue('SillyBunny test prompt content');

        // Restore original name
        await nameField.fill(originalName);
        await roleField.selectOption(originalRole);
        await contentField.fill(originalContent);
        await page.locator('#completion_prompt_manager_popup_entry_form_save').click();

        // Role field should have valid options
        const roleOptions = await roleField.locator('option').evaluateAll(options => options.map(option => option.value));
        expect(roleOptions.length).toBeGreaterThanOrEqual(3);
        expect(roleOptions).toEqual(expect.arrayContaining(['system', 'user', 'assistant']));

        // Content field should be a textarea
        await expect(contentField).toBeVisible();
    });

    test('injection position and depth fields are present', async ({ page }) => {
        await loadApp(page);
        await switchToOpenAI(page);
        await openEditorTab(page);
        await expandPromptManager(page);

        // Open a non-system prompt (jailbreak) to see injection fields
        await editPrompt(page, 'jailbreak');

        const positionField = page.locator('#completion_prompt_manager_popup_entry_form_injection_position');
        const depthField = page.locator('#completion_prompt_manager_popup_entry_form_injection_depth');
        const orderField = page.locator('#completion_prompt_manager_popup_entry_form_injection_order');
        const triggerChips = page.locator('#completion_prompt_manager_popup_trigger_chips');

        await expect(positionField).toBeVisible();
        await positionField.selectOption('1');
        await expect(depthField).toBeVisible();
        await expect(orderField).toBeVisible();
        await expect(triggerChips).toBeVisible();
        await expect(triggerChips.getByRole('checkbox')).toHaveCount(6);
    });

    test('preview tab shows rendered content', async ({ page }) => {
        await loadApp(page);
        await switchToOpenAI(page);
        await openEditorTab(page);
        await expandPromptManager(page);

        await editPrompt(page, 'main');

        const previewTab = page.locator('.completion_prompt_manager_tab_button[data-tab="preview"]');
        await expect(previewTab).toBeVisible();
        await previewTab.click();

        const previewArea = page.locator('#completion_prompt_manager_popup_preview');
        await expect(previewArea).toBeVisible();
        await expect(page.locator('#completion_prompt_manager_popup_edit')).toBeHidden();
    });

    test('toggle action flips enabled state and re-renders the row', async ({ page }) => {
        await loadApp(page);
        await switchToOpenAI(page);
        await openEditorTab(page);
        await expandPromptManager(page);

        const jailbreakRow = promptRow(page, 'jailbreak');
        const wasDisabled = await jailbreakRow.evaluate(el => el.classList.contains('completion_prompt_manager_prompt_disabled'));

        await jailbreakRow.locator('.prompt-manager-toggle-action').click();
        // After toggle the enabled state should have flipped
        await expect.poll(() => jailbreakRow.evaluate(el => el.classList.contains('completion_prompt_manager_prompt_disabled'))).toBe(!wasDisabled);
    });

    test('creating a new prompt adds it to the list', async ({ page }) => {
        await loadApp(page);
        await switchToOpenAI(page);
        await openEditorTab(page);
        await expandPromptManager(page);

        const countBefore = await page.locator('#completion_prompt_manager_list .completion_prompt_manager_prompt').count();
        await page.locator('[data-pm-footer-action="new"]').click();

        // Editor opens for the new prompt
        const nameField = page.locator('#completion_prompt_manager_popup_entry_form_name');
        await expect(nameField).toBeVisible();
        await nameField.fill('SillyBunny New Prompt');
        await page.locator('#completion_prompt_manager_popup_entry_form_save').click();
        const picker = page.locator('#completion_prompt_manager_footer_append_prompt');
        await expect(picker.locator('option', { hasText: 'SillyBunny New Prompt' })).toHaveCount(1);
        await picker.selectOption({ label: 'SillyBunny New Prompt' });
        await page.locator('[data-pm-footer-action="insert"]').click();
        await expect(page.locator('#completion_prompt_manager_list .completion_prompt_manager_prompt')).toHaveCount(countBefore + 1);
    });

    test('inspect action shows token breakdown without opening the edit form', async ({ page }) => {
        await loadApp(page);
        await switchToOpenAI(page);
        await openEditorTab(page);
        await expandPromptManager(page);

        // Supply a compiled message through the generator boundary, without selecting a live chat.
        await page.evaluate(async () => {
            const { Message, MessageCollection, promptManager } = await import('/scripts/openai.js');
            const message = await Message.createAsync('system', 'SillyBunny inspection fixture', 'main');
            promptManager.setMessages(new MessageCollection('inspection-fixture', message));
        });
        await promptRow(page, 'main').locator('.prompt-manager-inspect-action').click();

        const inspectArea = page.locator('#completion_prompt_manager_popup_inspect');
        await expect(inspectArea).toBeVisible();
        await expect(inspectArea).toContainText('SillyBunny inspection fixture');
        await expect(page.locator('#completion_prompt_manager_popup_edit')).toBeHidden();
    });

    test('close button hides the editor and deselects the row', async ({ page }) => {
        await loadApp(page);
        await switchToOpenAI(page);
        await openEditorTab(page);
        await expandPromptManager(page);

        const mainRow = promptRow(page, 'main');
        await mainRow.click();
        await expect(page.locator('#completion_prompt_manager_popup')).toBeVisible();

        await page.locator('#completion_prompt_manager_popup_entry_form_close').click();
        await expect(page.locator('#completion_prompt_manager_popup')).toBeHidden();
        await expect(mainRow).not.toHaveClass(/completion_prompt_manager_prompt_selected/);
    });

    test('reset button is visible for system prompts', async ({ page }) => {
        await loadApp(page);
        await switchToOpenAI(page);
        await openEditorTab(page);
        await expandPromptManager(page);

        await editPrompt(page, 'main');

        const resetBtn = page.locator('#completion_prompt_manager_popup_entry_form_reset');
        await expect(resetBtn).toBeVisible();
    });

    test('drag lock button toggles the aria-pressed state', async ({ page }) => {
        await loadApp(page);
        await switchToOpenAI(page);
        await openEditorTab(page);
        await expandPromptManager(page);

        const lockBtn = page.locator('#completion_prompt_manager_drag_lock');
        await expect(lockBtn).toBeVisible();
        const before = await lockBtn.getAttribute('aria-pressed');
        await lockBtn.click();
        await expect(lockBtn).not.toHaveAttribute('aria-pressed', before);
    });

    test('metadata round-trip: forbid_overrides checkbox persists through save', async ({ page }) => {
        await loadApp(page);
        await switchToOpenAI(page);
        await openEditorTab(page);
        await expandPromptManager(page);

        await editPrompt(page, 'main');

        const forbidBlock = page.locator('#completion_prompt_manager_forbid_overrides_block');
        const forbidCheckbox = page.locator('#completion_prompt_manager_popup_entry_form_forbid_overrides');

        await expect(forbidBlock).toBeVisible();

        const before = await forbidCheckbox.isChecked();
        await forbidCheckbox.setChecked(!before);
        await page.locator('#completion_prompt_manager_popup_entry_form_save').click();

        // Re-open the editor and verify the value persisted in-memory
        await page.locator('#completion_prompt_manager_popup_entry_form_close').click();
        await editPrompt(page, 'main');
        await expect(forbidCheckbox).toBeChecked({ checked: !before });
    });
});

test.describe('Prompt Manager — mobile slide-in layout', () => {
    test.use({ viewport: { width: 390, height: 844 } });

    test('only the list pane is visible by default on mobile', async ({ page }) => {
        await loadApp(page);
        await switchToOpenAI(page);
        await openEditorTab(page);
        await expandPromptManager(page);

        const workspace = page.locator('.completion_prompt_manager_workspace');
        const hasDetail = await workspace.evaluate(el => el.classList.contains('sb-workspace-mobile-detail'));
        expect(hasDetail).toBe(false);

        const listPane = page.locator('.completion_prompt_manager_list_pane');
        await expect(listPane).toBeVisible();
    });

    test('selecting a prompt on mobile adds sb-workspace-mobile-detail to the workspace', async ({ page }) => {
        await loadApp(page);
        await switchToOpenAI(page);
        await openEditorTab(page);
        await expandPromptManager(page);

        const mainRow = promptRow(page, 'main');
        await mainRow.click();

        const workspace = page.locator('.completion_prompt_manager_workspace');
        await expect(workspace).toHaveClass(/sb-workspace-mobile-detail/);
    });

    test('closing preview on mobile restores the list and hides editor', async ({ page }) => {
        await loadApp(page);
        await switchToOpenAI(page);
        await openEditorTab(page);
        await expandPromptManager(page);

        const mainRow = promptRow(page, 'main');
        await mainRow.click();

        const workspace = page.locator('.completion_prompt_manager_workspace');
        await expect(workspace).toHaveClass(/sb-workspace-mobile-detail/);

        await page.locator('.completion_prompt_manager_tab_button[data-tab="preview"]').click();
        const closePreview = page.locator('#completion_prompt_manager_popup_preview_close_button');
        await expect(closePreview).toBeVisible();
        await closePreview.click();

        await expect(workspace).not.toHaveClass(/sb-workspace-mobile-detail/);
        await expect(page.locator('#completion_prompt_manager_popup')).toBeHidden();
    });

    test('closing editor via close button also removes mobile detail class', async ({ page }) => {
        await loadApp(page);
        await switchToOpenAI(page);
        await openEditorTab(page);
        await expandPromptManager(page);

        const mainRow = promptRow(page, 'main');
        await mainRow.click();

        const workspace = page.locator('.completion_prompt_manager_workspace');
        await expect(workspace).toHaveClass(/sb-workspace-mobile-detail/);

        await page.locator('#completion_prompt_manager_popup_entry_form_close').click();
        await expect(workspace).not.toHaveClass(/sb-workspace-mobile-detail/);
    });
});
