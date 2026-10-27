import { expect, test } from '@playwright/test';
import { protectMaintainerServer } from './helpers/maintainer-server.js';
import {
    bootWindowContentDialogs, CUSTOM_BODY_YAML, EXPOSED_SECRET_SENTINEL, expectDialogFrame, expectWindowFrame,
    interceptExposedSecretViewer, openAccountProfile, openAdminPanel, SNAPSHOT_FIXTURE,
    SNAPSHOT_TEXT, WINDOW_CONTENT_VIEWPORTS,
} from './helpers/window-content-dialogs.js';

test.setTimeout(90000);
test.use({ serviceWorkers: 'block', screenshot: 'off', video: 'off', trace: 'off' });

async function openWindow(page, selector) {
    const popup = page.locator('dialog.popup[open]').last();
    await popup.locator(selector).waitFor();
    await expect(popup).not.toHaveAttribute('opening');
    return page.locator(`dialog.popup[data-id="${await popup.getAttribute('data-id')}"]`);
}

async function expectOneWindowScroller(popup, { textareaOwnsScroll = false } = {}) {
    await expect(popup.locator('.popup-content')).toHaveCSS('overflow-y', textareaOwnsScroll ? 'hidden' : 'auto');
    expect(await popup.evaluate((node, textareaOwnsScroll) => {
        const surfaces = [node, node.querySelector('.popup-body')];
        if (textareaOwnsScroll) surfaces.push(node.querySelector('.popup-content'));
        return surfaces.every(surface => !/^(auto|scroll)$/.test(getComputedStyle(surface).overflowY));
    }, textareaOwnsScroll)).toBe(true);
}

async function expectTrailingEntryRows(root) {
    expect(await root.locator('.ds-row-entry').evaluateAll(rows => rows.every(row => {
        const label = row.querySelector('.ds-row-label');
        const control = row.querySelector('input, textarea');
        if (!label || !control) return false;
        const labelRect = label.getBoundingClientRect();
        const controlRect = control.getBoundingClientRect();
        return controlRect.left >= labelRect.right - 1 || controlRect.top >= labelRect.bottom - 1;
    }))).toBe(true);
}

async function expectNoTrailingColonInRowTitles(root) {
    const titles = await root.locator('.ds-row-label').allTextContents();
    expect(titles.every(title => !/[:：]\s*$/u.test(title))).toBe(true);
}

async function expectLastContentNearBodyEnd(popup, selector) {
    const gap = await popup.evaluate((node, lastSelector) => {
        const body = node.querySelector('.popup-content');
        const lastContent = node.querySelector(lastSelector);
        return body.getBoundingClientRect().bottom - lastContent.getBoundingClientRect().bottom;
    }, selector);
    expect(gap).toBeGreaterThanOrEqual(-1);
    expect(gap).toBeLessThanOrEqual(24);
}

async function openCharacterEditor(page) {
    await page.locator('#sb-character-toggle').click();
    await page.evaluate(async () => {
        const app = await import('/script.js');
        app.setCharacterId(0);
        app.select_selected_character(0);
    });
    await expect(page.locator('#sb_character_editor_header')).toBeVisible();
}

async function openConnectionsPanel(page) {
    await page.evaluate(() => window.SillyBunnyShell.openTab('left', 'connections'));
    await page.locator('button[data-sb-settings-tab="connections"]').evaluate(button => button.click());
    const panel = page.locator('[data-sb-panel="connections"]');
    await expect(panel).toHaveAttribute('aria-hidden', 'false');
    return panel;
}

function itemizedFixture() {
    return {
        mesId: 0,
        rawPrompt: [{ role: 'system', content: 'Window prompt fixture line one.\nWindow prompt fixture line two.' }],
        main_api: 'openai',
        charDescription: 'Character description fixture',
        charPersonality: 'Character personality fixture',
        scenarioText: 'Character scenario fixture',
        userPersona: 'Persona fixture',
        worldInfoString: 'World information fixture',
        allAnchors: 'Extension fixture',
        summarizeString: 'Summary fixture',
        authorsNoteString: 'Author note fixture',
        smartContextString: 'Context fixture',
        beforeScenarioAnchor: '',
        afterScenarioAnchor: '',
        zeroDepthAnchor: '',
        padding: 0,
        chatInjects: '',
        chatVectorsString: '',
        dataBankVectorsString: '',
        presetName: 'Window fixture preset',
        messagesCount: '1',
        examplesCount: '1',
        oaiStartTokens: 10,
        oaiPromptTokens: 25,
        oaiMainTokens: 20,
        oaiConversationTokens: 15,
        oaiExamplesTokens: 4,
        oaiBiasTokens: 2,
        oaiJailbreakTokens: 1,
        oaiNudgeTokens: 1,
        oaiImpersonateTokens: 0,
        oaiNsfwTokens: 0,
        finalPrompt: 'OpenAI itemization fixture',
    };
}

async function openItemization(page, viewport) {
    const fixture = itemizedFixture();
    await page.evaluate(fixture => {
        void import('/scripts/itemized-prompts.js').then(module => module.promptItemize([fixture], 0));
    }, fixture);
    const popup = await openWindow(page, '#showRawPrompt');
    await expectWindowFrame(popup, viewport);
    await expectOneWindowScroller(popup);
    await popup.locator('.popup-content').evaluate(node => { node.scrollTop = node.scrollHeight; });
    await expect(popup.locator('.popup-content').locator(':scope > hr').last()).toBeInViewport();
    return popup;
}

for (const viewport of WINDOW_CONTENT_VIEWPORTS) {
    const size = `${viewport.width}×${viewport.height}`;

    test(`Account Profile and Settings Snapshots keep their source content and safe restore defaults at ${size}`, async ({ page }) => {
        await protectMaintainerServer(page);
        const state = await bootWindowContentDialogs(page, viewport);
        const profile = await openAccountProfile(page);
        await expectDialogFrame(profile, viewport);
        await expect(profile.locator('.sb-account-properties .ds-row')).toHaveCount(4);
        await expectNoTrailingColonInRowTitles(profile);
        await expect(profile.locator('.sb-account-hero .userChangeNameButton')).toBeVisible();
        await expect(profile.locator('.sb-account-hero .userAvatarChange')).toBeVisible();
        await expect(profile.locator('.sb-account-hero .userAvatarRemove')).toBeVisible();
        await expect(profile.locator('.userChangePasswordButton')).toHaveClass(/ds-row--activatable/);
        await expect(profile.locator('.userResetSettingsButton')).toHaveClass(/ds-row--activatable/);
        await expect(profile.locator('.userResetAllButton')).toHaveClass(/ds-row--activatable/);
        await expectOneWindowScroller(profile);
        await expect(profile.locator('.sb-dialog__title')).toHaveText('Account Info');
        await profile.locator('.popup-content').evaluate(node => { node.scrollTop = node.scrollHeight; });
        await expect(profile.locator('.userResetAllButton')).toBeInViewport();
        await expect(profile.locator('.sb-dialog__close')).toBeInViewport();
        await expectLastContentNearBodyEnd(profile, '.userResetAllButton');

        await profile.locator('.userResetSettingsButton').click();
        await page.locator('dialog.popup[open] #resetSettingsPassword').waitFor();
        const openedReset = page.locator('dialog.popup[open]').last();
        const destructiveConfirm = page.locator(`dialog.popup[data-id="${await openedReset.getAttribute('data-id')}"]`);
        await expect(destructiveConfirm).toHaveClass(/sb-dialog--dialog/);
        await expect(destructiveConfirm.locator('.popup-button-ok')).toHaveClass(/is-destructive/);
        await expect(destructiveConfirm.locator('.popup-button-cancel')).toBeFocused();
        await page.keyboard.press('Enter');
        await expect.poll(() => state.users.filter(user => user.endpoint === 'reset-settings')).toHaveLength(0);
        await expect(destructiveConfirm).toHaveCount(0);
        await expect(profile).toBeVisible();

        await profile.locator('.sb-dialog__close').click();
        const dataSecurity = page.locator('[data-sb-panel="data-security"]');
        await dataSecurity.locator('#settings_snapshots_button').click();
        const snapshots = await openWindow(page, '.snapshotList');
        await expectWindowFrame(snapshots, viewport);
        await expect(snapshots.getByRole('button', { name: 'Back', exact: true })).toHaveCount(0);
        await expect(snapshots.locator('.sb-dialog__title')).toHaveText('Settings Snapshots');
        await expect(snapshots.locator('.snapshotList > .snapshot')).toHaveCount(1);
        await expectNoTrailingColonInRowTitles(snapshots);
        await expect(snapshots.locator('.snapshotList > .snapshot .snapshotName')).toHaveText(SNAPSHOT_FIXTURE.name);
        await snapshots.locator('.snapshotList > .snapshot .snapshotExpandButton').click();
        await expect(snapshots.locator('.snapshotList > .snapshot .snapshotExpandButton')).toHaveAttribute('aria-expanded', 'true');
        await snapshots.locator('.popup-content').evaluate(node => { node.scrollTop = node.scrollHeight; });
        await expect(snapshots.locator('.snapshotList > .snapshot .snapshotContent')).toBeInViewport();
        await expect(snapshots.locator('.snapshotList > .snapshot .snapshotContent')).toHaveValue(SNAPSHOT_TEXT);
        await expectLastContentNearBodyEnd(snapshots, '.snapshotList > .snapshot');
        await snapshots.locator('.snapshotList > .snapshot .snapshotExpandButton').click();
        await expect(snapshots.locator('.snapshotList > .snapshot .snapshotExpandButton')).toHaveAttribute('aria-expanded', 'false');

        await snapshots.locator('.sb-dialog__header .makeSnapshotButton').dispatchEvent('click');
        await expect.poll(() => state.snapshotRequests.filter(request => request === 'make-snapshot')).toHaveLength(1);

        await snapshots.locator('.snapshotList > .snapshot .snapshotRestoreButton').click();
        const openedConfirm = page.locator('dialog.popup[open]').last();
        const confirm = page.locator(`dialog.popup[data-id="${await openedConfirm.getAttribute('data-id')}"]`);
        await expect(confirm).toHaveClass(/sb-dialog--alert/);
        await expect(confirm.locator('.popup-button-ok')).toHaveClass(/is-destructive/);
        await expect(confirm.locator('.popup-button-cancel')).toBeFocused();
        await page.keyboard.press('Enter');
        await expect(confirm).toHaveCount(0);
        expect(state.snapshotRequests).toEqual(['get-snapshots', 'load-snapshot', 'make-snapshot', 'get-snapshots']);
        await expect(snapshots).toBeVisible();
        await snapshots.locator('.sb-dialog__close').click();
        expect(state.users).toEqual([]);
        expect(state.snapshotRequests).not.toContain('restore-snapshot');
    });

    test(`Admin Window keeps the four original new-user fields and blocks account writes at ${size}`, async ({ page }) => {
        await protectMaintainerServer(page);
        const adminUsers = [
            { handle: 'other-user', name: 'Other User', admin: true, enabled: true, password: true, created: 0, avatar: '/img/ai4.png' },
            { handle: 'disabled-user', name: 'Disabled User', admin: false, enabled: false, password: false, created: 1, avatar: '/img/ai4.png' },
        ];
        const state = await bootWindowContentDialogs(page, viewport, { admin: true, adminUsers });
        const admin = await openAdminPanel(page);
        await expectWindowFrame(admin, viewport);
        await expectOneWindowScroller(admin);
        await expect(admin.locator('.usersList .userAccount')).toHaveCount(2);
        const userRow = admin.locator('.usersList .userAccount').first();
        const disabledRow = admin.locator('.usersList .userAccount').nth(1);
        await expect(userRow).toHaveClass(/ds-pref-group/);
        await expect(userRow.locator('.ds-entity-row__avatar')).toBeVisible();
        await expect(userRow.locator('.ds-entity-row__title')).toContainText('Other User');
        await expect(userRow.locator('.ds-entity-row__subtitle')).toContainText('other-user');
        await expect(userRow.locator('.userChangeNameButton')).toBeVisible();
        await expect(userRow.locator('.userOverflowButton')).toHaveAttribute('aria-label', 'Menu');
        await userRow.locator('.userOverflowButton').click();
        await expect(page.getByRole('menuitem', { name: 'Disable user account.' })).toBeVisible();
        await expect(page.getByRole('menuitem', { name: 'Demote user to regular user.' })).toBeVisible();
        await page.getByRole('menuitem', { name: 'Disable user account.' }).click();
        await expect.poll(() => state.users.findLast(user => user.endpoint === 'disable')).toMatchObject({ handle: 'other-user' });
        await disabledRow.locator('.userOverflowButton').click();
        await page.getByRole('menuitem', { name: 'Enable user account.' }).click();
        await expect.poll(() => state.users.findLast(user => user.endpoint === 'enable')).toMatchObject({ handle: 'disabled-user' });
        await disabledRow.locator('.userOverflowButton').click();
        await page.getByRole('menuitem', { name: 'Promote user to admin.' }).click();
        await expect.poll(() => state.users.findLast(user => user.endpoint === 'promote')).toMatchObject({ handle: 'disabled-user' });
        await userRow.locator('.userOverflowButton').click();
        await page.getByRole('menuitem', { name: 'Demote user to regular user.' }).click();
        await expect.poll(() => state.users.findLast(user => user.endpoint === 'demote')).toMatchObject({ handle: 'other-user' });
        await userRow.locator('.userOverflowButton').click();
        await page.getByRole('menuitem', { name: 'Download a backup of user data.' }).click();
        await expect.poll(() => state.users.findLast(user => user.endpoint === 'backup')).toMatchObject({ handle: 'other-user' });
        await userRow.locator('.userOverflowButton').click();
        await page.getByRole('menuitem', { name: 'Remove a custom avatar.' }).click();
        await expect.poll(() => state.users.findLast(user => user.endpoint === 'change-avatar')).toMatchObject({ handle: 'other-user', avatar: '' });
        const chooserPromise = page.waitForEvent('filechooser');
        await userRow.locator('.userOverflowButton').click();
        await page.getByRole('menuitem', { name: 'Set a custom avatar.' }).click();
        const chooser = await chooserPromise;
        expect(chooser.isMultiple()).toBe(false);
        await userRow.locator('.userChangeNameButton').click();
        const nameDialog = page.locator('dialog.popup[open]').last();
        await nameDialog.locator('.popup-input').waitFor();
        await nameDialog.locator('.popup-input').fill('Renamed QA User');
        await nameDialog.locator('.popup-button-ok').dispatchEvent('click');
        await expect.poll(() => state.users.findLast(user => user.endpoint === 'change-name')).toMatchObject({ handle: 'other-user', name: 'Renamed QA User' });
        await userRow.locator('.userOverflowButton').click();
        await page.getByRole('menuitem', { name: 'Change user password.' }).click();
        let actionPage = page.locator('dialog.popup[open]').last();
        await actionPage.locator('input[name="confirm"]').waitFor();
        await actionPage.getByRole('button', { name: 'Cancel', exact: true }).click();
        await userRow.locator('.userOverflowButton').click();
        await page.getByRole('menuitem', { name: 'Delete user account.' }).click();
        actionPage = page.locator('dialog.popup[open]').last();
        await expect(actionPage.locator('.popup-button-cancel')).toBeFocused();
        await actionPage.locator('.popup-button-cancel').click();
        await admin.locator('.popup-content').evaluate(node => { node.scrollTop = node.scrollHeight; });
        await expect(admin.locator('.usersList .userAccount').last()).toBeInViewport();
        await expectLastContentNearBodyEnd(admin, '.usersList .userAccount:last-child');

        await expect(admin.locator('.sb-dialog__header .newUserButton')).toHaveAttribute('aria-label', 'New User');
        await admin.locator('.sb-dialog__header .newUserButton').click();
        const formPage = page.locator('dialog.popup[open]').last();
        await expect(formPage).toHaveClass(/sb-dialog--page/);
        await expect(formPage.getByRole('button', { name: 'Back', exact: true })).toBeVisible();
        const form = formPage.locator('.userCreateForm');
        const fields = form.locator('input[name]');
        await expect(fields).toHaveCount(4);
        await expect(form.locator('.ds-row-entry')).toHaveCount(4);
        await expectNoTrailingColonInRowTitles(formPage);
        await expect(form.locator('input[name="password"]')).toHaveAttribute('type', 'password');
        await expect(form.locator('input[name="password"]')).toHaveAttribute('autocomplete', 'new-password');
        await expect(form.locator('input[name="confirm"]')).toHaveAttribute('type', 'password');
        await expect(form.locator('input[name="confirm"]')).toHaveAttribute('autocomplete', 'new-password');
        await expect(form.locator('input[name="_name"]')).toHaveAttribute('autocomplete', 'username');
        await expect(form.locator('input[name="handle"]')).toHaveAttribute('pattern', '[a-z0-9-]+');
        await expectTrailingEntryRows(form);
        await formPage.locator('.popup-content').evaluate(node => { node.scrollTop = node.scrollHeight; });
        await expect(form.locator('.newUserRegisterFinalizeButton')).toBeInViewport();
        await form.locator('input[name="_name"]').fill('Window QA User');
        await expect(form.locator('input[name="handle"]')).toHaveValue('Window QA User');
        await form.locator('input[name="handle"]').fill('window-qa-user');
        await form.locator('input[name="password"]').fill('qa-password');
        await form.locator('input[name="confirm"]').fill('qa-password');
        await form.locator('.newUserRegisterFinalizeButton').click();
        await expect.poll(() => state.users.findLast(user => user.endpoint === 'create')).toMatchObject({
            name: 'Window QA User',
            handle: 'window-qa-user',
            password: 'qa-password',
        });
        // The form page can still be open here. Then its Back button also has the close class, so pick Close only.
        await admin.locator('.sb-dialog__close:not(.sb-dialog__back)').click();
        await expect(page.locator('dialog.popup')).toHaveCount(0);
        expect(state.users.filter(user => user.endpoint === 'delete')).toEqual([]);
    });

    test(`Scenario overrides preserve metadata and render stacked textarea rows at ${size}`, async ({ page }) => {
        await protectMaintainerServer(page);
        await bootWindowContentDialogs(page, viewport);
        await page.evaluate(async () => {
            const app = await import('/script.js');
            app.updateChatMetadata({ scenario: 'Initial scenario', mes_example: 'Initial examples', system_prompt: 'Initial prompt' });
            void app.setCharacterSettingsOverrides();
        });
        const popup = await openWindow(page, '#chat_scenario_override');
        await expectWindowFrame(popup, viewport);
        await expectOneWindowScroller(popup);
        await expect(popup.locator('.ds-row--stacked')).toHaveCount(3);
        await expect(popup.locator('#chat_scenario_override')).toHaveValue('Initial scenario');
        await expect(popup.locator('#chat_examples_override')).toHaveValue('Initial examples');
        await expect(popup.locator('#chat_system_prompt_override')).toHaveValue('Initial prompt');
        await popup.locator('#chat_scenario_override').fill('Updated scenario fixture');
        await popup.locator('#chat_examples_override').fill('Updated examples fixture');
        await popup.locator('#chat_system_prompt_override').fill('Updated prompt fixture');
        await popup.locator('.popup-content').evaluate(node => { node.scrollTop = node.scrollHeight; });
        await expect(popup.locator('#chat_system_prompt_override')).toBeInViewport();
        await expect(popup.locator('.sb-dialog__close')).toBeInViewport();
        await popup.locator('.sb-dialog__close').click();
        await expect.poll(() => page.evaluate(async () => {
            const { chat_metadata } = await import('/script.js');
            return [chat_metadata.scenario, chat_metadata.mes_example, chat_metadata.system_prompt];
        })).toEqual(['Updated scenario fixture', 'Updated examples fixture', 'Updated prompt fixture']);
    });

    test(`Maximized text editor and Creator's Notes use the shared Window frame at ${size}`, async ({ page }) => {
        await protectMaintainerServer(page);
        await bootWindowContentDialogs(page, viewport);
        await openCharacterEditor(page);
        const description = page.locator('#description_textarea');
        const contents = Array.from({ length: 120 }, (_, index) => `Window content line ${index + 1}`).join('\n');
        await description.fill(contents);
        await page.locator('.editor_maximize[data-for="description_textarea"]').click();
        let popup = await openWindow(page, '.maximized_textarea');
        await expectWindowFrame(popup, viewport);
        await expectOneWindowScroller(popup, { textareaOwnsScroll: true });
        const textarea = popup.locator('.maximized_textarea');
        await expect(textarea).toHaveValue(contents);
        expect(await textarea.evaluate(node => node.getBoundingClientRect().height)).toBeGreaterThan(200);
        expect(await textarea.evaluate(node => getComputedStyle(node).overflowY)).toMatch(/auto|scroll/);
        await textarea.evaluate(node => { node.scrollTop = node.scrollHeight; });
        expect(await textarea.evaluate(node => node.scrollTop)).toBeGreaterThan(0);
        await expect(textarea).toBeInViewport();
        await popup.locator('.sb-dialog__close').click();
        await expect(description).toHaveValue(contents);

        const notes = page.locator('#creator_notes_textarea');
        const creatorNotes = Array.from({ length: 32 }, (_, index) => `Creator notes paragraph ${index + 1}.`).join('\n\n');
        await notes.fill(creatorNotes);
        await page.locator('#sb_creator_notes_maximize').click();
        popup = await openWindow(page, '.sb-creator-notes-fullscreen');
        await expectWindowFrame(popup, viewport);
        await expect(popup.locator('.sb-creator-notes-fullscreen')).toContainText('Creator notes paragraph 1.');
        await expectOneWindowScroller(popup);
        await popup.locator('.popup-content').evaluate(node => { node.scrollTop = node.scrollHeight; });
        await expect(popup.locator('.sb-creator-notes-fullscreen p').last()).toContainText('Creator notes paragraph 32.');
        await expect(popup.locator('.sb-creator-notes-fullscreen p').last()).toBeInViewport();
        await popup.locator('.sb-dialog__close').click();
        await expect(notes).toHaveValue(creatorNotes);
    });

    test(`Prompt Itemization is a reachable Window at ${size}`, async ({ page }) => {
        await protectMaintainerServer(page);
        await bootWindowContentDialogs(page, viewport);
        const itemization = await openItemization(page, viewport);
        await expect(itemization).toBeVisible();
        await itemization.locator('.sb-dialog__close').click();
    });

    test(`Custom endpoint parameters retain YAML, select values and settings persistence at ${size}`, async ({ page }) => {
        await protectMaintainerServer(page);
        const state = await bootWindowContentDialogs(page, viewport);
        const panel = await openConnectionsPanel(page);
        await page.evaluate(() => {
            $('#main_api').val('openai').trigger('change');
            $('#chat_completion_source').val('custom').trigger('change');
        });
        const openButton = panel.locator('#customize_additional_parameters');
        await openButton.waitFor({ state: 'attached' });
        await openButton.dispatchEvent('click');
        const popup = await openWindow(page, '#custom_include_body');
        await expectWindowFrame(popup, viewport);
        await expectOneWindowScroller(popup);
        const yaml = popup.locator('#custom_include_body');
        await yaml.fill(CUSTOM_BODY_YAML);
        await popup.locator('#custom_reasoning_preset').selectOption('custom');
        await popup.locator('#custom_reasoning_param_name').fill('reasoning_effort');
        await popup.locator('#custom_reasoning_param_format').selectOption('string');
        await popup.locator('#custom_reasoning_enabled_value').fill('enabled');
        await popup.locator('#custom_reasoning_disabled_value').fill('disabled');
        await expect(popup.locator('#custom_include_body')).toHaveValue(CUSTOM_BODY_YAML);
        await expect(popup.locator('.ds-row--stacked')).toHaveCount(3);
        await expectTrailingEntryRows(popup);
        await expect(popup.locator('.popup-content')).toHaveCSS('overflow-y', 'auto');
        await popup.locator('.popup-content').evaluate(node => { node.scrollTop = node.scrollHeight; });
        await expect(popup.locator('#custom_reasoning_disabled_value')).toBeInViewport();
        await expect(popup.locator('.sb-dialog__close')).toBeInViewport();
        await expect.poll(() => page.evaluate(() => window.SillyTavern.getContext().chatCompletionSettings.custom_include_body)).toBe(CUSTOM_BODY_YAML);
        await page.evaluate(async () => (await import('/script.js')).saveSettings());
        await expect.poll(() => state.settings.some(saved => saved.oai_settings?.custom_include_body === CUSTOM_BODY_YAML)).toBe(true);
        await popup.locator('.sb-dialog__close').click();
    });

    test(`Exposed secrets viewer stays in the Window without logging or saving response values at ${size}`, async ({ page }) => {
        await protectMaintainerServer(page);
        const state = await bootWindowContentDialogs(page, viewport);
        await interceptExposedSecretViewer(page, state);
        let secretWasLogged = false;
        page.on('console', message => { secretWasLogged ||= message.text().includes(EXPOSED_SECRET_SENTINEL); });
        const panel = await openConnectionsPanel(page);
        const button = page.locator('#viewSecrets');
        await button.waitFor({ state: 'attached' });
        await button.dispatchEvent('click');
        const popup = await openWindow(page, '.responsiveTable');
        await expectWindowFrame(popup, viewport);
        await expectOneWindowScroller(popup);
        expect(await popup.locator('.responsiveTable').evaluate((table, sentinel) => table.textContent.includes(sentinel), EXPOSED_SECRET_SENTINEL)).toBe(true);
        await popup.locator('.popup-content').evaluate(node => { node.scrollTop = node.scrollHeight; });
        await expect(popup.locator('.responsiveTable tr').last()).toBeInViewport();
        await expect(popup.locator('.sb-dialog__close')).toBeInViewport();
        await popup.locator('.sb-dialog__close').click();
        expect(state.secretViewCalls).toBe(1);
        expect(secretWasLogged).toBe(false);
        expect(state.settings.some(saved => JSON.stringify(saved).includes(EXPOSED_SECRET_SENTINEL))).toBe(false);
        expect(await page.evaluate(sentinel => Array.from({ length: localStorage.length }, (_, index) => localStorage.getItem(localStorage.key(index)))
            .some(value => value?.includes(sentinel)), EXPOSED_SECRET_SENTINEL)).toBe(false);
        await expect(panel).toHaveAttribute('aria-hidden', 'false');
    });

}

test('Long account lists keep the shared Window at its large-list height', async ({ page }) => {
    const viewport = { width: 1440, height: 900, presentation: 'floating' };
    const adminUsers = Array.from({ length: 14 }, (_, index) => ({
        handle: `long-user-${index}`,
        name: `Long List User ${index}`,
        admin: false,
        enabled: true,
        password: false,
        created: 1_700_000_000_000 + index,
        avatar: '/img/ai4.png',
    }));
    await protectMaintainerServer(page);
    await bootWindowContentDialogs(page, viewport, { admin: true, adminUsers });
    const admin = await openAdminPanel(page);
    await expectWindowFrame(admin, viewport);
    const bodyHeight = await admin.locator('.popup-content').evaluate(node => node.getBoundingClientRect().height);
    expect(bodyHeight).toBeGreaterThan(650);
    await admin.locator('.popup-content').evaluate(node => { node.scrollTop = node.scrollHeight; });
    await expect(admin.locator('.usersList .userAccount').last()).toBeInViewport();
    await expect(admin.locator('.usersList .userAccount')).toHaveCount(14);
});

test('Raw desktop prompt stays inside its itemization Window at 1440×900', async ({ page }) => {
    const viewport = { width: 1440, height: 900, presentation: 'floating' };
    await protectMaintainerServer(page);
    await bootWindowContentDialogs(page, viewport);
    const itemization = await openItemization(page, viewport);
    await itemization.locator('#showRawPrompt').click();
    await expect(itemization.locator('#rawPromptWrapper')).toContainText('Window prompt fixture line two.');
    await itemization.locator('.sb-dialog__close').click();
});

test('Raw mobile prompt opens as a pushed Window page and Back restores itemization', async ({ page }) => {
    const viewport = { width: 390, height: 844, presentation: 'sheet' };
    await page.addInitScript(() => Object.defineProperty(navigator, 'userAgent', {
        configurable: true,
        get: () => 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    }));
    await protectMaintainerServer(page);
    await bootWindowContentDialogs(page, viewport);
    const itemization = await openItemization(page, viewport);
    await itemization.locator('#showRawPrompt').click();
    const rawPrompt = await openWindow(page, '.tokenItemizingMaintext');
    await expectWindowFrame(rawPrompt, viewport);
    await expect(rawPrompt).toHaveClass(/sb-dialog--page/);
    await expect(rawPrompt.locator('.tokenItemizingMaintext')).toContainText('Window prompt fixture line two.');
    await expect(rawPrompt.locator('.sb-dialog__title')).toHaveText('Show Raw Prompt');
    await rawPrompt.getByRole('button', { name: 'Back', exact: true }).click();
    await expect(itemization).toBeVisible();
    await itemization.locator('.sb-dialog__close').click();
});

test('mobile keyboard inset keeps the maximized editor surface above the visual viewport', async ({ page }) => {
    const viewport = { width: 390, height: 844, presentation: 'sheet' };
    await protectMaintainerServer(page);
    await bootWindowContentDialogs(page, viewport);
    await openCharacterEditor(page);
    await page.locator('#description_textarea').fill(Array.from({ length: 160 }, (_, index) => `Caret visibility line ${index + 1}`).join('\n'));
    await page.evaluate(() => {
        const viewport = new EventTarget();
        Object.defineProperties(viewport, {
            offsetTop: { value: 0 },
            height: { value: window.innerHeight, configurable: true, writable: true },
        });
        window.__qaVisualViewport = viewport;
        Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport });
    });
    await page.locator('.editor_maximize[data-for="description_textarea"]').click();
    const popup = await openWindow(page, '.maximized_textarea');
    const textarea = popup.locator('.maximized_textarea');
    await textarea.focus();
    await page.evaluate(() => {
        window.__qaVisualViewport.height = window.innerHeight - 280;
        window.__qaVisualViewport.dispatchEvent(new Event('resize'));
    });
    await expect.poll(() => popup.evaluate(node => node.style.getPropertyValue('--sb-dialog-keyboard-inset'))).toBe('280px');
    const keyboardEdge = 844 - 280;
    expect(await textarea.evaluate(node => node.getBoundingClientRect().bottom)).toBeLessThanOrEqual(keyboardEdge + 1);
    await textarea.evaluate(node => {
        node.setSelectionRange(node.value.length, node.value.length);
        node.scrollTop = node.scrollHeight;
    });
    expect(await textarea.evaluate(node => node.scrollTop)).toBeGreaterThan(0);
});
