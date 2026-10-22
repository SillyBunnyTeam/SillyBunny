import { expect, test } from '@playwright/test';

test.describe('character import selection', () => {
    for (const { name, viewport } of [
        { name: 'desktop', viewport: { width: 1280, height: 720 } },
        { name: 'mobile', viewport: { width: 390, height: 844 } },
    ]) {
        test(`opens the imported character after a successful import on ${name}`, async ({ page }) => {
            await page.setViewportSize(viewport);
            await page.goto('/', { waitUntil: 'domcontentloaded' });
            await page.waitForFunction(() => document.readyState === 'complete', { timeout: 0 });
            await page.waitForFunction('document.getElementById("preloader") === null', { timeout: 0 });
            await page.locator('#character_import_file').waitFor({ state: 'attached' });
            await page.evaluate(async () => {
                window.__sbScript = await import('/script.js');
            });

            const characterName = `Issue 177 Imported ${Date.now()}`;
            const card = {
                name: characterName,
                description: 'Minimal card for import auto-select regression.',
                personality: '',
                scenario: '',
                first_mes: 'Hello.',
                mes_example: '',
            };

            const importResponsePromise = page.waitForResponse(response => response.url().endsWith('/api/characters/import') && response.request().method() === 'POST');
            await page.setInputFiles('#character_import_file', {
                name: 'issue-177-imported-character.json',
                mimeType: 'application/json',
                buffer: Buffer.from(JSON.stringify(card)),
            });

            const importResponse = await importResponsePromise;
            expect(importResponse.ok()).toBe(true);
            const importResult = await importResponse.json();
            const importedAvatar = `${importResult.file_name}.png`;

            await page.waitForFunction((avatar) => {
                const script = window.__sbScript;
                return script?.characters?.some(character => character.avatar === avatar);
            }, importedAvatar);

            await expect.poll(async () => page.evaluate((avatar) => {
                const script = window.__sbScript;
                return script?.characters?.[script.this_chid]?.avatar === avatar;
            }, importedAvatar)).toBe(true);
            await expect(page.locator('#avatar_url_pole')).toHaveValue(importedAvatar);
            await expect(page.locator('#right-nav-panel')).toHaveAttribute('data-menu-type', 'character_edit');
        });
    }
});
