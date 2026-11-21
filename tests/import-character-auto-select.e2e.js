import { expect, test } from '@playwright/test';
import { bootImport, currentAvatar, protectImportFixtures, upload } from './helpers/character-import-fixtures.js';

test.beforeEach(async ({ page }) => { await protectImportFixtures(page); });

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    test(`legacy hidden picker retains auto-select at ${viewport.width}px without persisting a fixture`, async ({ page }) => {
        await page.setViewportSize(viewport);
        await bootImport(page);
        await page.setInputFiles('#character_import_file', upload());
        await expect.poll(() => currentAvatar(page)).toBe('qa-imported.png');
        await expect(page.locator('#avatar_url_pole')).toHaveValue('qa-imported.png');
        await expect(page.locator('#right-nav-panel')).toHaveAttribute('data-menu-type', 'character_edit');
    });
}
