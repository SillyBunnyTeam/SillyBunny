import { expect, test } from '@playwright/test';
import { bootMiscDialogs, MISC_VIEWPORTS, openMiscDialog } from './helpers/misc-dialogs.js';

test.setTimeout(90000);

async function expectFrame(popup, viewport, immediate = false) {
    await expect(popup).toHaveClass(/sb-dialog--dialog/);
    const pushed = await popup.evaluate(node => node.classList.contains('sb-dialog--page'));
    await expect(popup).toHaveAttribute('data-presentation', pushed ? 'floating' : viewport.presentation);
    expect(await popup.evaluate(node => {
        if (!node.classList.contains('sb-dialog--page')) return true;
        const parent = document.querySelector('dialog[data-sb-covered]');
        const rect = node.getBoundingClientRect();
        const inherited = parent.getBoundingClientRect();
        return Math.abs(rect.x - inherited.x) <= 1 && Math.abs(rect.y - inherited.y) <= 1 && Math.abs(rect.width - inherited.width) <= 1 && Math.abs(rect.height - inherited.height) <= 1;
    })).toBe(true);
    const content = popup.locator('.popup-content');
    await content.evaluate(node => { node.scrollTop = node.scrollHeight; });
    const last = content.locator('.ds-row:visible').last();
    await expect(last).toBeInViewport();
    await expect(content.locator('.sb-dialog-rows > :last-child, :scope > .sb-editor-section').last()).toBeInViewport();
    expect(await last.evaluate(node => {
        const row = node.getBoundingClientRect();
        const body = node.closest('.popup-content').getBoundingClientRect();
        return row.bottom <= body.bottom + 1 && row.top >= body.top - 1;
    })).toBe(true);
    expect(await popup.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
    if (immediate) {
        await expect(popup.locator('.popup-button-ok')).toBeHidden();
        await expect(popup.locator('.sb-dialog__close')).toBeInViewport();
    } else {
        await expect(popup.locator('.popup-button-ok')).toBeInViewport();
        await expect(popup.locator('.popup-button-cancel')).toBeInViewport();
    }
    expect(await content.locator('.ds-row-switch').evaluateAll(rows => rows.every(row => {
        const label = row.querySelector('.ds-row-text').getBoundingClientRect();
        const input = row.querySelector('input').getBoundingClientRect();
        return input.left >= label.right && row.lastElementChild.matches('input');
    }))).toBe(true);
    expect(await content.locator('.ds-row:has(> .ds-row-suffix):not(.ds-row--stacked)').evaluateAll(rows => rows.every(row => {
        const label = row.querySelector('.ds-row-text').getBoundingClientRect();
        const suffix = row.querySelector('.ds-row-suffix').getBoundingClientRect();
        return suffix.left >= label.right && row.lastElementChild.classList.contains('ds-row-suffix');
    }))).toBe(true);
    expect(await content.locator('.ds-toggle-row__group').evaluateAll(groups => groups.every(group => group.parentElement.classList.contains('ds-row-suffix')))).toBe(true);
}

async function pick(page, popup, name) {
    await popup.locator('.ds-select-row__trigger').click();
    await page.locator('.sb-picker, .sb-picker-sheet').last().getByRole('option', { name, exact: true }).click();
}

async function expectAccountDefault(page, popup, state, surface) {
    if (surface === 'password') return popup;
    await expect(popup.locator('.popup-button-cancel')).toBeFocused();
    await expect(popup.locator('.popup-button-ok')).toHaveClass(/is-destructive/);
    await page.keyboard.press('Enter');
    await expect(popup).toHaveCount(0);
    expect(state.users).toHaveLength(0);
    await page.locator('dialog[open] .sb-dialog__close').click();
    return openMiscDialog(page, surface);
}

async function fillAccountForm(popup, surface) {
    if (surface === 'password') {
        await expect(popup.locator('input[name="current"]')).toHaveAttribute('type', 'password');
        await expect(popup.locator('input[name="current"]')).toHaveAttribute('autocomplete', 'current-password');
        await expect(popup.locator('input[name="password"]')).toHaveAttribute('autocomplete', 'new-password');
        await popup.locator('input[name="current"]').fill('fixture-old');
        await popup.locator('input[name="password"]').fill('fixture-new');
        await popup.locator('input[name="confirm"]').fill('fixture-new');
        return;
    }
    if (surface === 'delete') {
        await expect(popup.locator('input[type="checkbox"]')).toHaveCount(1);
        await popup.locator('#deleteUserData').check();
        await popup.locator('#deleteUserHandle').fill('other-user');
        return;
    }
    await popup.locator('input[name="password"]').fill('fixture-password');
    if (surface === 'reset') await popup.locator('input[name="code"]').fill('123456');
}

for (const viewport of MISC_VIEWPORTS) {
    const size = `${viewport.width}×${viewport.height}`;
    test(`Creator Notes scope keeps immediate native events and account storage at ${size}`, async ({ page }) => {
        await bootMiscDialogs(page, viewport);
        const popup = await openMiscDialog(page, 'styles');
        await expectFrame(popup, viewport, true);
        await expect(popup.locator('input[type="radio"]')).toHaveCount(2);
        await popup.locator('#global_styles_allowed').check();
        expect(await page.evaluate(async () => (await import('/scripts/util/AccountStorage.js')).accountStorage.getItem('AllowGlobalStyles-misc-dialog-character.png'))).toBe('true');
        await popup.locator('#global_styles_forbidden').check();
        expect(await page.evaluate(async () => (await import('/scripts/util/AccountStorage.js')).accountStorage.getItem('AllowGlobalStyles-misc-dialog-character.png'))).toBe('false');
        await popup.locator('.sb-dialog__close').click();
        await expect(popup).toHaveCount(0);
    });

    test(`External media keeps delegated input persistence for all three modes at ${size}`, async ({ page }) => {
        const state = await bootMiscDialogs(page, viewport);
        const popup = await openMiscDialog(page, 'media');
        await expectFrame(popup, viewport, true);
        await expect(popup.locator('input[type="radio"]')).toHaveCount(3);
        for (const mode of ['allowed', 'forbidden', 'global']) {
            await popup.locator(`#forbid_media_override_${mode}`).check();
            await expect.poll(() => page.evaluate(async () => {
                const { power_user } = await import('/scripts/power-user.js');
                return { allowed: power_user.external_media_allowed_overrides, forbidden: power_user.external_media_forbidden_overrides };
            })).toEqual({ allowed: mode === 'allowed' ? ['misc-dialog-character.png'] : [], forbidden: mode === 'forbidden' ? ['misc-dialog-character.png'] : [] });
        }
        await expect.poll(() => state.settings.some(settings => settings.power_user.external_media_allowed_overrides.length === 0 && settings.power_user.external_media_forbidden_overrides.length === 0)).toBe(true);
        await popup.locator('.sb-dialog__close').click();
    });

    test(`AI Custom CSS keeps profile, textarea, apply mode, validation and generated values at ${size}`, async ({ page }) => {
        const state = await bootMiscDialogs(page, viewport);
        await page.evaluate(async () => {
            const { getConnectionManagerRequestService } = await import('/scripts/extensions/in-chat-agents/profile-utils.js');
            const service = getConnectionManagerRequestService();
            service.sendRequest = async (profile, messages) => {
                window.__miscCssRequest = { profile, messages };
                return '.dialog-generated { color: red; }';
            };
            $('#customCSS').val('.dialog-existing { color: blue; }').trigger('input');
        });
        const popup = await openMiscDialog(page, 'css');
        await expectFrame(popup, viewport);
        await popup.locator('.popup-button-ok').click();
        await expect(popup).toBeVisible();
        await popup.locator('#custom_css_ai_instruction').fill('Keep the existing rules and add red accents');
        await pick(page, popup, 'Profile 2');
        await popup.locator('input[value="append"]').check();
        await popup.locator('.popup-button-ok').click();
        await expect.poll(() => page.evaluate(() => window.__miscCssRequest?.profile)).toBe('misc-profile-2');
        await expect.poll(() => page.evaluate(async () => (await import('/scripts/power-user.js')).power_user.custom_css)).toBe('.dialog-existing { color: blue; }\n\n.dialog-generated { color: red; }');
        await expect.poll(() => state.settings.some(settings => settings.power_user.custom_css.includes('.dialog-generated'))).toBe(true);
    });

    test(`Screenshot range retains raw parseInt input and rejects invalid values at ${size}`, async ({ page }) => {
        await bootMiscDialogs(page, viewport);
        const popup = await openMiscDialog(page, 'screenshot');
        await expectFrame(popup, viewport);
        for (const value of ['', '-1', '999']) {
            await popup.locator('#message_screenshot_start_id').fill(value);
            await popup.locator('#message_screenshot_end_id').fill('1');
            await popup.locator('.popup-button-ok').click();
            await expect(popup).toBeVisible();
            await expect(popup.locator('#message_screenshot_start_id')).toHaveValue(value);
        }
        await popup.locator('#message_screenshot_start_id').fill('0suffix');
        await popup.locator('#message_screenshot_end_id').fill('1.8');
        const downloaded = page.waitForEvent('download', { timeout: 45000 });
        await popup.locator('.popup-button-ok').click();
        expect((await downloaded).suggestedFilename()).toContain('messages-0-1');
    });

    test(`Install Extension retains main URL and custom branch inputResults at ${size}`, async ({ page }) => {
        const state = await bootMiscDialogs(page, viewport);
        const popup = await openMiscDialog(page, 'install');
        await expectFrame(popup, viewport);
        await expect(popup).toContainText('security risks');
        await popup.locator('.popup-input').fill(' https://example.test/dialog-extension ');
        await popup.locator('#extension_branch_name').fill(' feature/dialogs ');
        await popup.locator('.popup-button-ok').click();
        await expect.poll(() => state.installs.length).toBe(1);
        expect(state.installs[0]).toMatchObject({ url: 'https://example.test/dialog-extension', branch: 'feature/dialogs', global: false });
    });

    test(`Admin extension install keeps its neutral footer action and global result at ${size}`, async ({ page }) => {
        const state = await bootMiscDialogs(page, viewport, { admin: true });
        const popup = await openMiscDialog(page, 'install');
        await expectFrame(popup, viewport);
        const allUsers = popup.locator('.sb-dialog__bottom-bar .popup-button-custom');
        await expect(allUsers).toHaveText('Install for all users');
        await expect(allUsers).toBeInViewport();
        await expect(allUsers).not.toHaveClass(/menu_button_primary|menu_button_default/);
        await popup.locator('#extension_branch_name').fill('global-branch');
        await allUsers.click();
        await expect.poll(() => state.installs.length).toBe(1);
        expect(state.installs[0]).toMatchObject({ branch: 'global-branch', global: true });
    });

    test(`Switch Branch keeps the unchanged selection inert and writes only picked branches at ${size}`, async ({ page }) => {
        const state = await bootMiscDialogs(page, viewport);
        let popup = await openMiscDialog(page, 'branch');
        await expectFrame(popup, viewport);
        await expect(popup.locator('.ds-select-row__value')).toHaveText('main (abc123) [Main]');
        await popup.locator('.popup-button-ok').click();
        await expect(popup).toHaveCount(0);
        expect(state.branches).toHaveLength(0);
        popup = await openMiscDialog(page, 'branch');
        await pick(page, popup, 'dev (def456) [Development]');
        await popup.locator('.popup-button-ok').click();
        await expect.poll(() => state.branches.length).toBe(1);
        expect(state.branches[0]).toMatchObject({ extensionName: 'dialog-extension', branch: 'dev', global: false });
    });

    for (const surface of ['password', 'delete', 'settings', 'reset']) {
        test(`Account ${surface} preserves entries and safe intercepted requests at ${size}`, async ({ page }) => {
            const state = await bootMiscDialogs(page, viewport);
            let popup = await openMiscDialog(page, surface);
            await expectFrame(popup, viewport);
            popup = await expectAccountDefault(page, popup, state, surface);
            await fillAccountForm(popup, surface);
            await popup.locator('.popup-button-ok').click();
            await expect.poll(() => state.users.length).toBe(1);
            const expected = {
                password: { endpoint: 'change-password', handle: 'dialog-user', newPassword: 'fixture-new', oldPassword: 'fixture-old' },
                delete: { endpoint: 'delete', handle: 'other-user', purge: true },
                settings: { endpoint: 'reset-settings', handle: 'dialog-user', password: 'fixture-password' },
                reset: { endpoint: 'reset-step2', password: 'fixture-password', code: '123456' },
            }[surface];
            expect(state.users[0]).toEqual(expected);
        });
    }
}
