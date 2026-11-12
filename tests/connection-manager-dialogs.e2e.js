import { expect, test } from '@playwright/test';
import { bootConnectionDialogs, CM_VIEWPORTS, connectionState, openConnectionDialog } from './helpers/connection-manager-dialogs.js';

async function expectFrame(popup, viewport, { immediate = false } = {}) {
    await expect(popup).toHaveClass(/sb-dialog--dialog/);
    await expect(popup).toHaveAttribute('data-presentation', viewport.presentation);
    const content = popup.locator('.popup-content');
    await content.evaluate(node => { node.scrollTop = node.scrollHeight; });
    const last = content.locator('.ds-row').last();
    await expect(last).toBeInViewport();
    const fit = await last.evaluate(node => {
        const row = node.getBoundingClientRect();
        const body = node.closest('.popup-content').getBoundingClientRect();
        return row.bottom <= body.bottom + 1 && row.top >= body.top - 1;
    });
    expect(fit).toBe(true);
    if (immediate) {
        await expect(popup.locator('.popup-button-ok')).toBeHidden();
        await expect(popup.locator('.sb-dialog__close')).toBeInViewport();
    } else {
        await expect(popup.locator('.popup-button-ok:not(.popup-button-custom)')).toBeInViewport();
        await expect(popup.locator('.popup-button-cancel')).toBeInViewport();
    }
    const checks = await content.locator('.ds-row-check').evaluateAll(rows => rows.every(row => {
        const label = row.querySelector('.ds-row-label').getBoundingClientRect();
        const control = row.querySelector('input').getBoundingClientRect();
        return control.left > label.right && row.lastElementChild.matches('input:not([role="switch"])');
    }));
    expect(checks).toBe(true);
}

for (const viewport of CM_VIEWPORTS) {
    const size = `${viewport.width}×${viewport.height}`;
    test(`Create profile adopts the name, saves exclusions and scrolls at ${size}`, async ({ page }) => {
        const saves = await bootConnectionDialogs(page, viewport);
        const popup = await openConnectionDialog(page, 'create');
        await expectFrame(popup, viewport);
        await expect(popup.locator('.popup-button-ok')).toHaveText('Save');
        const model = popup.locator('input[name="exclude"][value="model"]');
        await model.uncheck();
        await expect(popup.locator('[data-sb-editor-field="select-all"] input')).toHaveJSProperty('indeterminate', true);
        await popup.locator('.ds-row-entry .popup-input').fill('Created by dialog test');
        await popup.locator('.popup-button-ok').click();
        await expect(popup).toHaveCount(0);
        await expect.poll(async () => (await connectionState(page)).profiles.length).toBe(9);
        const created = (await connectionState(page)).profiles.find(profile => profile.name === 'Created by dialog test');
        expect(created.exclude).toContain('model');
        expect(created).not.toHaveProperty('model');
        expect(created).toHaveProperty('api');
        await expect.poll(() => saves.some(save => save.extension_settings?.connectionManager?.profiles.some(profile => profile.id === created.id && !Object.hasOwn(profile, 'model')))).toBe(true);
    });

    test(`Edit profile keeps folder assignment, carried exclusions and responses at ${size}`, async ({ page }) => {
        await bootConnectionDialogs(page, viewport);
        const popup = await openConnectionDialog(page, 'edit');
        await expectFrame(popup, viewport);
        await expect(popup.locator('.popup-button-custom')).toHaveText('Save and Update');
        await expect(popup.locator('.popup-button-custom')).toBeInViewport();
        const response = await popup.evaluate(node => {
            const custom = node.querySelector('.popup-button-custom');
            const primary = node.querySelector('.popup-button-ok:not(.popup-button-custom)');
            const bar = custom.closest('.sb-dialog__bottom-bar');
            return {
                grows: getComputedStyle(custom).flexGrow !== '0',
                suggested: getComputedStyle(custom).backgroundColor === getComputedStyle(primary).backgroundColor,
                endGap: bar.getBoundingClientRect().right - custom.getBoundingClientRect().right - Number.parseFloat(getComputedStyle(bar).paddingRight),
                spareWidth: bar.clientWidth - custom.offsetWidth,
            };
        });
        expect(response.grows).toBe(false);
        expect(response.suggested).toBe(false);
        expect(response.endGap).toBeCloseTo(0, 0);
        expect(response.spareWidth).toBeGreaterThan(24);
        await popup.locator('input[value="model"]').uncheck();
        await popup.locator('#profile_folder_select').selectOption('cm-folder-2');
        await popup.locator('.popup-input').fill('Renamed profile');
        await popup.locator('.popup-button-ok:not(.popup-button-custom)').click();
        await expect(popup).toHaveCount(0);
        const edited = (await connectionState(page)).profiles[0];
        expect(edited.name).toBe('Renamed profile');
        expect(edited.folderId).toBe('cm-folder-2');
        expect(edited.exclude).toEqual(expect.arrayContaining(['model', 'legacy-command']));
        expect(edited).not.toHaveProperty('model');
    });

    test(`Choose profiles to delete focuses Cancel and preserves selected results at ${size}`, async ({ page }) => {
        await bootConnectionDialogs(page, viewport);
        let popup = await openConnectionDialog(page, 'delete');
        await expect(popup.locator('.popup-button-cancel')).toBeFocused();
        await expectFrame(popup, viewport);
        await expect(popup.locator('.popup-button-ok')).toHaveClass(/is-destructive/);
        await page.keyboard.press('Enter');
        await expect(popup).toHaveCount(0);
        expect((await connectionState(page)).profiles).toHaveLength(8);
        popup = await openConnectionDialog(page, 'delete');
        await popup.locator('[data-sb-editor-field="select-all"] input').check();
        await expect(popup.locator('input:checked')).toHaveCount(9);
        await popup.locator('[data-sb-editor-field="select-all"] input').uncheck();
        await popup.locator('input[value="cm-profile-1"]').check();
        await popup.locator('input[value="cm-profile-6"]').check();
        await popup.locator('.popup-button-ok').click();
        let confirm = page.locator('dialog.popup[open]').last();
        await expect(confirm).toContainText('2 saved connection profile(s)');
        await expect(confirm.locator('.popup-button-cancel')).toBeFocused();
        await expect(confirm.locator('.popup-button-ok')).toHaveClass(/is-destructive/);
        const before = await connectionState(page);
        await page.keyboard.press('Enter');
        await expect(confirm).toHaveCount(0);
        expect(await connectionState(page)).toEqual(before);
        popup = await openConnectionDialog(page, 'delete');
        await popup.locator('input[value="cm-profile-1"]').check();
        await popup.locator('input[value="cm-profile-6"]').check();
        await popup.locator('.popup-button-ok').click();
        confirm = page.locator('dialog.popup[open]').last();
        await expect(confirm).toContainText('2 saved connection profile(s)');
        await confirm.locator('.popup-button-ok').click();
        await expect(confirm).toHaveCount(0);
        await expect.poll(async () => (await connectionState(page)).profiles.length).toBe(6);
        const ids = (await connectionState(page)).profiles.map(profile => profile.id);
        expect(ids).not.toContain('cm-profile-1');
        expect(ids).not.toContain('cm-profile-6');
    });

    test(`Save and Update retains its affirmative result and Cancel discards edits at ${size}`, async ({ page }) => {
        const saves = await bootConnectionDialogs(page, viewport);
        await page.evaluate(() => { window.SillyTavern.getContext().extensionSettings.connectionManager.profiles[0].model = 'gpt-4o-mini'; });
        const liveModel = 'gpt-4o';
        await expect(page.locator('#model_openai_select')).toHaveValue(liveModel);
        expect((await connectionState(page)).profiles[0].model).toBe('gpt-4o-mini');
        let popup = await openConnectionDialog(page, 'edit');
        await expect(popup.locator('input[value="model"]')).toBeChecked();
        await popup.locator('input[value="verbosity"]').uncheck();
        await popup.locator('.popup-input').fill('Updated profile');
        await popup.locator('.popup-button-custom').click();
        await expect(popup).toHaveCount(0);
        const before = await connectionState(page);
        expect(before.profiles[0].name).toBe('Updated profile');
        expect(before.profiles[0].exclude).toEqual(expect.arrayContaining(['verbosity', 'legacy-command']));
        expect(before.profiles[0]).not.toHaveProperty('verbosity');
        expect(before.profiles[0].model).toBe(liveModel);
        await expect.poll(() => saves.some(save => save.extension_settings?.connectionManager?.profiles[0]?.model === liveModel)).toBe(true);
        popup = await openConnectionDialog(page, 'edit');
        await popup.locator('.popup-input').fill('Discarded name');
        await popup.locator('#profile_folder_select').selectOption('cm-folder-3');
        await popup.locator('input[value="model"]').uncheck();
        await popup.locator('.popup-button-cancel').click();
        await expect(popup).toHaveCount(0);
        expect(await connectionState(page)).toEqual(before);
    });

    test(`Manage folders applies add, rename and delete immediately at ${size}`, async ({ page }) => {
        await bootConnectionDialogs(page, viewport);
        const popup = await openConnectionDialog(page, 'folders');
        await expectFrame(popup, viewport, { immediate: true });
        await popup.locator('#new_profile_folder_name').fill('Created folder');
        await popup.locator('#add_new_folder').click();
        await expect(popup.locator('.folder-item')).toHaveCount(9);
        await expect(popup.locator('.sb-dialog__title')).toHaveText('Manage Profile Folders');
        const folder = popup.locator('.folder-item[data-folder-id="cm-folder-7"]');
        await folder.locator('input').fill('Renamed folder');
        await folder.locator('input').press('Tab');
        await expect.poll(async () => (await connectionState(page)).folders.find(folder => folder.id === 'cm-folder-7').name).toBe('Renamed folder');
        await folder.locator('.folder-delete-btn').press('Enter');
        const confirm = page.locator('dialog.popup[open].sb-dialog--alert');
        await expect(confirm).toHaveClass(/sb-dialog--alert/);
        await expect(confirm.locator('.popup-button-cancel')).toBeFocused();
        await expect(confirm.locator('.popup-button-ok')).toHaveClass(/is-destructive/);
        const before = await connectionState(page);
        await page.keyboard.press('Enter');
        await expect(confirm).toHaveCount(0);
        expect(await connectionState(page)).toEqual(before);
        await expect(popup.locator('.folder-item')).toHaveCount(9);
        await folder.locator('.folder-delete-btn').press('Enter');
        await expect(confirm.locator('.popup-button-cancel')).toBeFocused();
        await confirm.locator('.popup-button-ok').click();
        await expect(popup.locator('.folder-item')).toHaveCount(8);
        await expectFrame(popup, viewport, { immediate: true });
        await popup.locator('.sb-dialog__close').click();
        await expect(popup).toHaveCount(0);
        expect((await connectionState(page)).folders.some(folder => folder.id === 'cm-folder-7')).toBe(false);
    });

    test(`Profile details use safe selectable property rows and Close at ${size}`, async ({ page }) => {
        await bootConnectionDialogs(page, viewport);
        const before = await connectionState(page);
        const popup = await openConnectionDialog(page, 'view');
        await expectFrame(popup, viewport, { immediate: true });
        await expect(popup.locator('.sb-dialog__title')).toHaveText('Profile 0');
        await expect(popup.locator('.ds-row-property')).not.toHaveCount(0);
        await expect(popup.locator('.profile-summary-value', { hasText: '<b>Saved text</b>' })).toHaveCount(1);
        await expect(popup.locator('.profile-summary-value b')).toHaveCount(0);
        await popup.locator('.sb-dialog__close').click();
        await expect(popup).toHaveCount(0);
        expect(await connectionState(page)).toEqual(before);
    });
}
