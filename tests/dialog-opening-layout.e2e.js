import { expect, test } from '@playwright/test';
import { bootConnectionDialogs, openConnectionDialog } from './helpers/connection-manager-dialogs.js';
import { closePopups, expectOpensAtFinalSize, installOpeningSampler, MOTION } from './helpers/dialog-opening.js';
import { bootMiscDialogs, MISC_VIEWPORTS, openMiscDialog } from './helpers/misc-dialogs.js';
import { bootPresetLorebookDialogs, openPresetLorebookDialog } from './helpers/preset-lorebook-dialogs.js';
import { bootUtilityDialogs, openUtilityDialog, UTILITY_SURFACES } from './helpers/utility-dialogs.js';
import { bootWindowContentDialogs, openAccountProfile, openAdminPanel } from './helpers/window-content-dialogs.js';
import { bootWindowDialogs, openApiKeyManager, openDataBank, openRegex } from './helpers/window-dialogs.js';
import { bootWindowToolsDialogs, currentToolPopup } from './helpers/window-tools-dialogs.js';

/*
 * These checks keep motion on. With reduced motion, Popup runs `onOpen` in the same task as `show()`, so a dialog
 * that changes its layout in `onOpen` still looks correct.
 */
test.setTimeout(240000);
test.use({ serviceWorkers: 'block' });

for (const viewport of MISC_VIEWPORTS) {
    const size = `${viewport.width}x${viewport.height}`;

    test(`Utility dialogs open at their final size at ${size}`, async ({ page }) => {
        await bootUtilityDialogs(page, viewport, MOTION);
        await installOpeningSampler(page);
        for (const surface of UTILITY_SURFACES.filter(name => name !== 'regex')) {
            await expectOpensAtFinalSize(page, surface, () => openUtilityDialog(page, surface));
        }
    });

    test(`Form dialogs open at their final size at ${size}`, async ({ page }) => {
        await bootMiscDialogs(page, viewport, MOTION);
        await installOpeningSampler(page);
        for (const surface of ['styles', 'media', 'css', 'screenshot', 'install', 'branch']) {
            await expectOpensAtFinalSize(page, surface, () => openMiscDialog(page, surface));
        }
    });

    test(`Connection profile dialogs open at their final size at ${size}`, async ({ page }) => {
        await bootConnectionDialogs(page, viewport, MOTION);
        await installOpeningSampler(page);
        for (const surface of ['create', 'edit', 'view', 'delete', 'folders']) {
            await expectOpensAtFinalSize(page, surface, () => openConnectionDialog(page, surface));
        }
    });

    test(`Preset and Lorebook dialogs open at their final size at ${size}`, async ({ page }) => {
        await bootPresetLorebookDialogs(page, viewport, MOTION);
        await installOpeningSampler(page);
        for (const surface of ['export', 'import', 'delete', 'batch', 'sorting', 'chat', 'persona', 'character']) {
            await expectOpensAtFinalSize(page, surface, () => openPresetLorebookDialog(page, surface));
        }
    });

    test(`Windows open at their final size at ${size}`, async ({ page }) => {
        await bootWindowDialogs(page, viewport, MOTION);
        await installOpeningSampler(page);
        await expectOpensAtFinalSize(page, 'Data Bank', () => openDataBank(page));
        await expectOpensAtFinalSize(page, 'API keys', () => openApiKeyManager(page));
        await expectOpensAtFinalSize(page, 'Regex editor', () => openRegex(page, 'editor'));
    });

    test(`Account and admin Windows open at their final size at ${size}`, async ({ page }) => {
        await bootWindowContentDialogs(page, viewport, { ...MOTION, admin: true });
        await installOpeningSampler(page);
        await expectOpensAtFinalSize(page, 'Account', () => openAccountProfile(page));
        await expectOpensAtFinalSize(page, 'Admin', () => openAdminPanel(page));
        await expectOpensAtFinalSize(page, 'Snapshots', async () => {
            await page.locator('[data-sb-panel="data-security"] #settings_snapshots_button').click();
            await page.locator('dialog.popup[open] .snapshotList').waitFor();
        });
    });

    test(`Tool Windows open at their final size at ${size}`, async ({ page }) => {
        await bootWindowToolsDialogs(page, viewport, MOTION);
        await installOpeningSampler(page);
        await expectOpensAtFinalSize(page, 'Extensions', async () => {
            await page.evaluate(() => window.SillyBunnyShell.openTab('right', 'extensions'));
            await page.locator('#extensions_details').click();
            await currentToolPopup(page, '.extensions_info');
        });
        await expectOpensAtFinalSize(page, 'Data Maid', async () => {
            await page.evaluate(() => window.SillyBunnyShell.openTab('right', 'interface'));
            await page.locator('#data_maid_button').click();
            await currentToolPopup(page, '.dataMaidDialog');
        });
    });
}

test('A content-sized Window on a phone keeps no empty space after onOpening', async ({ page }) => {
    await bootMiscDialogs(page, MISC_VIEWPORTS[1], MOTION);
    await installOpeningSampler(page);
    await expectOpensAtFinalSize(page, 'Window', () => page.evaluate(async () => {
        const { Popup, POPUP_TYPE } = await import('/scripts/popup.js');
        void new Popup('<div class="tall" style="height: 400px"></div>', POPUP_TYPE.TEXT, '', {
            tier: 'window',
            size: 'content',
            onOpening: popup => { popup.content.querySelector('.tall').style.height = '100px'; },
        }).show();
    }), { keepOpen: true });
    expect(await page.locator('dialog.popup[open]').evaluate(dlg => dlg.offsetHeight)).toBeLessThan(400);
    await closePopups(page);
});
