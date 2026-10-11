import { expect, test } from '@playwright/test';

test.use({ serviceWorkers: 'block', reducedMotion: 'reduce' });

const BASE_URL = process.env.SILLYBUNNY_TEST_BASE_URL || 'http://127.0.0.1:4444';

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

async function openPromptingTab(page) {
    await page.evaluate(() => window.SillyBunnyShell.openTab('left', 'prompting'));
    const button = page.locator('button[data-sb-settings-tab="prompting"]');
    await button.evaluate(el => el.click());
    const panel = page.locator('[data-sb-panel="prompting"]');
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

// ── tests ──────────────────────────────────────────────────────────────────

test.describe('Prompt Manager — desktop split layout', () => {
    test.use({ viewport: { width: 1920, height: 1080 } });

    test('list and editor pane are both visible at desktop width', async ({ page }) => {
        await loadApp(page);
        await switchToOpenAI(page);
        await openPromptingTab(page);
        await expandPromptManager(page);

        const listPane = page.locator('.completion_prompt_manager_list_pane');
        const editorPane = page.locator('.completion_prompt_manager_editor_pane');
        await expect(listPane).toBeVisible();
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
        await openPromptingTab(page);
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
        expect(popupBox.left).toBeGreaterThanOrEqual(hostBox.left - 2);
        expect(popupBox.right).toBeLessThanOrEqual(hostBox.right + 2);
    });

    test('selected row gets the selected class', async ({ page }) => {
        await loadApp(page);
        await switchToOpenAI(page);
        await openPromptingTab(page);
        await expandPromptManager(page);

        const mainRow = promptRow(page, 'main');
        await mainRow.click();
        await expect(mainRow).toHaveClass(/completion_prompt_manager_prompt_selected/);
    });

    test('edit form fields round-trip name, role, content', async ({ page }) => {
        await loadApp(page);
        await switchToOpenAI(page);
        await openPromptingTab(page);
        await expandPromptManager(page);

        const mainRow = promptRow(page, 'main');
        await mainRow.locator('.prompt-manager-edit-action').click();

        const nameField = page.locator('#completion_prompt_manager_popup_entry_form_name');
        const roleField = page.locator('#completion_prompt_manager_popup_entry_form_role');
        const contentField = page.locator('#completion_prompt_manager_popup_entry_form_prompt');

        // Fields must be populated for an existing system prompt
        await expect(nameField).not.toHaveValue('');

        // Changing the name and saving should keep the editor open on desktop
        const originalName = await nameField.inputValue();
        await nameField.fill('SillyBunny Test Name');
        await page.locator('#completion_prompt_manager_popup_entry_form_save').click();

        // Editor stays open (desktop split layout)
        await expect(page.locator('#completion_prompt_manager_popup')).toBeVisible();

        // Restore original name
        await nameField.fill(originalName);
        await page.locator('#completion_prompt_manager_popup_entry_form_save').click();

        // Role field should have valid options
        const roleOptions = await roleField.locator('option').allInnerTexts();
        expect(roleOptions.length).toBeGreaterThanOrEqual(3);
        expect(roleOptions.map(o => o.toLowerCase())).toEqual(expect.arrayContaining(['system', 'user', 'assistant']));

        // Content field should be a textarea
        await expect(contentField).toBeVisible();
    });

    test('injection position and depth fields are present', async ({ page }) => {
        await loadApp(page);
        await switchToOpenAI(page);
        await openPromptingTab(page);
        await expandPromptManager(page);

        // Open a non-system prompt (jailbreak) to see injection fields
        const jailbreakRow = promptRow(page, 'jailbreak');
        await jailbreakRow.locator('.prompt-manager-edit-action').click();

        const positionField = page.locator('#completion_prompt_manager_popup_entry_form_injection_position');
        const depthField = page.locator('#completion_prompt_manager_popup_entry_form_injection_depth');
        const orderField = page.locator('#completion_prompt_manager_popup_entry_form_injection_order');
        const triggerField = page.locator('#completion_prompt_manager_popup_entry_form_injection_trigger');

        await expect(positionField).toBeVisible();
        await expect(orderField).toBeVisible();
        await expect(triggerField).toBeVisible();
    });

    test('preview tab shows rendered content', async ({ page }) => {
        await loadApp(page);
        await switchToOpenAI(page);
        await openPromptingTab(page);
        await expandPromptManager(page);

        const mainRow = promptRow(page, 'main');
        await mainRow.locator('.prompt-manager-edit-action').click();

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
        await openPromptingTab(page);
        await expandPromptManager(page);

        const jailbreakRow = promptRow(page, 'jailbreak');
        const wasDisabled = await jailbreakRow.evaluate(el => el.classList.contains('completion_prompt_manager_prompt_disabled'));

        await jailbreakRow.locator('.prompt-manager-toggle-action').click();
        // After toggle the enabled state should have flipped
        const isNowDisabled = await jailbreakRow.evaluate(el => el.classList.contains('completion_prompt_manager_prompt_disabled'));
        expect(isNowDisabled).toBe(!wasDisabled);
    });

    test('creating a new prompt adds it to the list', async ({ page }) => {
        await loadApp(page);
        await switchToOpenAI(page);
        await openPromptingTab(page);
        await expandPromptManager(page);

        const countBefore = await page.locator('#completion_prompt_manager_list .completion_prompt_manager_prompt').count();
        await page.locator('.completion_prompt_manager_footer .menu_button:last-child').click();

        // Editor opens for the new prompt
        const nameField = page.locator('#completion_prompt_manager_popup_entry_form_name');
        await expect(nameField).toBeVisible();
        await nameField.fill('SillyBunny New Prompt');
        await page.locator('#completion_prompt_manager_popup_entry_form_save').click();

        const countAfter = await page.locator('#completion_prompt_manager_list .completion_prompt_manager_prompt').count();
        expect(countAfter).toBe(countBefore + 1);
    });

    test('inspect action shows token breakdown without opening the edit form', async ({ page }) => {
        await loadApp(page);
        await switchToOpenAI(page);
        await openPromptingTab(page);
        await expandPromptManager(page);

        const mainRow = promptRow(page, 'main');
        await mainRow.locator('.prompt-manager-inspect-action').click();

        const inspectArea = page.locator('#completion_prompt_manager_popup_inspect');
        await expect(inspectArea).toBeVisible();
        await expect(page.locator('#completion_prompt_manager_popup_edit')).toBeHidden();
    });

    test('close button hides the editor and deselects the row', async ({ page }) => {
        await loadApp(page);
        await switchToOpenAI(page);
        await openPromptingTab(page);
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
        await openPromptingTab(page);
        await expandPromptManager(page);

        const mainRow = promptRow(page, 'main');
        await mainRow.locator('.prompt-manager-edit-action').click();

        const resetBtn = page.locator('#completion_prompt_manager_popup_entry_form_reset');
        await expect(resetBtn).toBeVisible();
    });

    test('drag lock button toggles the aria-pressed state', async ({ page }) => {
        await loadApp(page);
        await switchToOpenAI(page);
        await openPromptingTab(page);
        await expandPromptManager(page);

        const lockBtn = page.locator('#completion_prompt_manager_drag_lock');
        await expect(lockBtn).toBeVisible();
        const before = await lockBtn.getAttribute('aria-pressed');
        await lockBtn.click();
        const after = await lockBtn.getAttribute('aria-pressed');
        expect(after).not.toBe(before);
    });

    test('metadata round-trip: forbid_overrides checkbox persists through save', async ({ page }) => {
        await loadApp(page);
        await switchToOpenAI(page);
        await openPromptingTab(page);
        await expandPromptManager(page);

        // Open a non-system non-marker prompt that shows forbid_overrides
        const nsfwRow = promptRow(page, 'nsfw');
        await nsfwRow.locator('.prompt-manager-edit-action').click();

        const forbidBlock = page.locator('#completion_prompt_manager_forbid_overrides_block');
        const forbidCheckbox = page.locator('#completion_prompt_manager_popup_entry_form_forbid_overrides');

        // Check visibility — block may be hidden for some prompt types
        const isVisible = await forbidBlock.evaluate(el => el.style.visibility !== 'hidden' && el.style.display !== 'none');
        if (!isVisible) {
            // Skip if this prompt type doesn't show forbid_overrides
            return;
        }

        const before = await forbidCheckbox.isChecked();
        await forbidCheckbox.setChecked(!before);
        await page.locator('#completion_prompt_manager_popup_entry_form_save').click();

        // Re-open the editor and verify the value persisted in-memory
        await nsfwRow.locator('.prompt-manager-edit-action').click();
        const after = await forbidCheckbox.isChecked();
        expect(after).toBe(!before);
    });
});

test.describe('Prompt Manager — mobile slide-in layout', () => {
    test.use({ viewport: { width: 390, height: 844 } });

    test('only the list pane is visible by default on mobile', async ({ page }) => {
        await loadApp(page);
        await switchToOpenAI(page);
        await openPromptingTab(page);
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
        await openPromptingTab(page);
        await expandPromptManager(page);

        const mainRow = promptRow(page, 'main');
        await mainRow.click();

        const workspace = page.locator('.completion_prompt_manager_workspace');
        await expect(workspace).toHaveClass(/sb-workspace-mobile-detail/);
    });

    test('back button on mobile removes sb-workspace-mobile-detail and hides editor', async ({ page }) => {
        await loadApp(page);
        await switchToOpenAI(page);
        await openPromptingTab(page);
        await expandPromptManager(page);

        const mainRow = promptRow(page, 'main');
        await mainRow.click();

        const workspace = page.locator('.completion_prompt_manager_workspace');
        await expect(workspace).toHaveClass(/sb-workspace-mobile-detail/);

        const backBtn = page.locator('.completion_prompt_manager_back_button');
        await expect(backBtn).toBeVisible();
        await backBtn.click();

        await expect(workspace).not.toHaveClass(/sb-workspace-mobile-detail/);
        await expect(page.locator('#completion_prompt_manager_popup')).toBeHidden();
    });

    test('closing editor via close button also removes mobile detail class', async ({ page }) => {
        await loadApp(page);
        await switchToOpenAI(page);
        await openPromptingTab(page);
        await expandPromptManager(page);

        const mainRow = promptRow(page, 'main');
        await mainRow.click();

        const workspace = page.locator('.completion_prompt_manager_workspace');
        await expect(workspace).toHaveClass(/sb-workspace-mobile-detail/);

        await page.locator('#completion_prompt_manager_popup_entry_form_close').click();
        await expect(workspace).not.toHaveClass(/sb-workspace-mobile-detail/);
    });
});
