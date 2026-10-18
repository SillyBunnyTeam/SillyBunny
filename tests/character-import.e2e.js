import { expect, test } from '@playwright/test';
import { BOOK, bootImport, currentAvatar, protectImportFixtures, upload } from './helpers/character-import-fixtures.js';

const fixtures = new WeakMap();
test.beforeEach(async ({ page }) => { fixtures.set(page, await protectImportFixtures(page)); });

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    test.describe(`Import at ${viewport.width}px`, () => {
        test.use({ viewport });

        test('multi-file partial failure stays, offers Chat and Edit, and Back restores results', async ({ page }) => {
            await bootImport(page);
            const previous = await currentAvatar(page);
            await page.setInputFiles('#sb_character_import_files', [upload(), upload('bad.json')]);
            const results = page.locator('#sb_character_import_results');
            await expect(results).toHaveAttribute('data-state', 'partial');
            await expect(results.locator('[data-import-status="success"]')).toHaveCount(1);
            await expect(results.locator('[data-import-status="error"]')).toContainText('QA server rejected this card');
            expect(await currentAvatar(page)).toBe(previous);
            await expect(page.locator('#right-nav-panel')).toHaveAttribute('data-menu-type', 'import');
            await results.scrollIntoViewIfNeeded();
            await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
            const scrollTop = await page.locator('#sb_character_import_panel').evaluate(host => (host.closest('.sb-shell-panel-scroller') ?? host.closest('.scrollableInner')).scrollTop);
            expect(scrollTop).toBeGreaterThan(0);
            await page.screenshot({ path: `/tmp/opencode/step7-import-${viewport.width}.png` });
            await results.getByRole('button', { name: 'Edit', exact: true }).click();
            await expect(page.locator('#avatar_url_pole')).toHaveValue('qa-imported.png');
            await expect(page.locator('#right-nav-panel')).toHaveAttribute('data-menu-type', 'character_edit');
            await expect.poll(() => page.evaluate(async () => (await import('/scripts/sillybunny-editor/object-navigation.js')).objectNavigation.depth)).toBe(1);
            await page.locator('#sb_character_editor_back').click();
            await expect(results).toBeVisible();
            await expect(results).toHaveAttribute('data-state', 'partial');
            await expect.poll(() => page.locator('#sb_character_import_panel').evaluate(host => (host.closest('.sb-shell-panel-scroller') ?? host.closest('.scrollableInner')).scrollTop)).toBe(scrollTop);
            await results.getByRole('button', { name: 'Chat', exact: true }).click();
            expect(await currentAvatar(page)).toBe('qa-imported.png');
            await expect(page.locator('#right-nav-panel')).toHaveAttribute('data-menu-type', 'import');
        });

        test('URL lorebooks stay on Import and open in World Info explicitly', async ({ page }) => {
            await bootImport(page);
            await page.locator('#sb_character_import_urls').fill('lorebooks/qa/book');
            await page.locator('#sb_character_import_url_action').click();
            const result = page.locator('[data-import-kind="lorebook"]');
            await expect(result).toContainText(BOOK);
            await expect(page.locator('#right-nav-panel')).toHaveAttribute('data-menu-type', 'import');
            await result.getByRole('button', { name: 'World Info', exact: true }).click();
            await expect(page.locator('#WorldInfo .sb-wi-book-name')).toHaveText(BOOK);
        });

        test('panel drops import exactly once, stay, and support keyboard file selection', async ({ page }) => {
            await bootImport(page);
            const previous = await currentAvatar(page);
            await page.evaluate(() => {
                const transfer = new DataTransfer();
                transfer.items.add(new File(['{}'], 'qa-drop.json', { type: 'application/json' }));
                document.getElementById('sb_character_import_drop').dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }));
            });
            await expect(page.locator('#sb_character_import_results')).toHaveAttribute('data-state', 'success');
            expect(fixtures.get(page).imports).toEqual(['qa-drop.json']);
            expect(await currentAvatar(page)).toBe(previous);
            await expect(page.locator('#right-nav-panel')).toHaveAttribute('data-menu-type', 'import');
            const chooser = page.waitForEvent('filechooser');
            await page.locator('#sb_character_import_drop').focus();
            await page.keyboard.press('Enter');
            await (await chooser).setFiles(upload('qa-keyboard.json'));
            await expect(page.locator('#sb_character_import_results')).toContainText('QA qa-keyboard');
        });

        test('body drops outside the panel retain select-last', async ({ page }) => {
            await bootImport(page);
            await page.evaluate(() => {
                const transfer = new DataTransfer();
                transfer.items.add(new File(['{}'], 'qa-outside.json', { type: 'application/json' }));
                document.body.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }));
            });
            await expect.poll(() => currentAvatar(page)).toBe('qa-outside.png');
            await expect(page.locator('#right-nav-panel')).toHaveAttribute('data-menu-type', 'character_edit');
            expect(fixtures.get(page).imports).toEqual(['qa-outside.json']);
        });

        test('library row is visible only with the Assets extension enabled', async ({ page }) => {
            await bootImport(page);
            const setPresence = async enabled => {
                await page.evaluate(async enabled => {
                    const extensions = await import('/scripts/extensions.js');
                    if (!extensions.extensionNames.includes('assets')) extensions.extensionNames.push('assets');
                    extensions.extension_settings.disabledExtensions = extensions.extension_settings.disabledExtensions.filter(id => id !== 'assets');
                    if (!enabled) extensions.extension_settings.disabledExtensions.push('assets');
                    const { mountCharacterImport } = await import('/scripts/sillybunny-character-import.js');
                    mountCharacterImport(document.getElementById('sb_character_import_panel')).refreshLibrary();
                }, enabled);
            };
            await setPresence(true);
            await expect(page.locator('#sb_character_import_library')).toBeVisible();
            await setPresence(false);
            await expect(page.locator('#sb_character_import_library')).toBeHidden();
        });

        test('result avatars use the real thumbnail URL and recover from a missing thumbnail', async ({ page }) => {
            await bootImport(page);
            await page.setInputFiles('#sb_character_import_files', [upload(), upload('qa-missing.json')]);
            const results = page.locator('#sb_character_import_results');
            await expect(results).toHaveAttribute('data-state', 'success');
            await results.scrollIntoViewIfNeeded();
            const images = results.locator('img');
            await expect(images.first()).toHaveAttribute('src', /\/thumbnail\?.*file=qa-imported\.png/);
            await expect.poll(() => images.first().evaluate(img => img.complete && img.naturalWidth > 0)).toBe(true);
            await expect(images.nth(1)).toHaveAttribute('src', 'img/ai4.png');
            await expect.poll(() => images.nth(1).evaluate(img => img.complete && img.naturalWidth > 0)).toBe(true);
        });
    });
}

const typography = node => {
    const style = getComputedStyle(node);
    return { fontSize: style.fontSize, fontWeight: style.fontWeight, lineHeight: style.lineHeight, color: style.color };
};
const frame = node => {
    const style = getComputedStyle(node);
    return { border: style.borderTopWidth, borderColor: style.borderTopColor, radius: style.borderTopLeftRadius, background: style.backgroundColor };
};

for (const width of [1440, 768, 390]) {
    test(`${width}px Import matches editor framing and compares with Persona/WI in both themes`, async ({ page }) => {
        await page.setViewportSize({ width, height: 1000 });
        await bootImport(page);
        await page.evaluate(async () => {
            const { power_user, setCharacterEditorQuickEdit } = await import('/scripts/power-user.js');
            setCharacterEditorQuickEdit(false);
            power_user.personas['qa-import-persona.png'] = 'QA Import Persona';
            power_user.persona_descriptions['qa-import-persona.png'] = {
                title: '', description: 'QA persona', position: 0, depth: 2, role: 0, lorebook: '',
                connections: [], appendices: [], activeAppendices: {},
            };
            const { mountCharacterImport } = await import('/scripts/sillybunny-character-import.js');
            await mountCharacterImport(document.getElementById('sb_character_import_panel')).run({
                files: [new File(['{}'], 'qa-imported.json', { type: 'application/json' }), new File(['{}'], 'bad.json', { type: 'application/json' })],
                urls: ['lorebooks/qa/book'],
            });
        });
        for (const theme of ['Libadwaita', 'Libadwaita Light']) {
            await page.evaluate(async theme => {
                window.$('#themes').val(theme).trigger('change');
                await window.SillyBunnyShell.openTab('characters', 'import');
            }, theme);
            const suffix = `${width}-${theme.replaceAll(' ', '-')}`;
            const importHeading = await page.locator('#sb_import_heading_file').evaluate(typography);
            const importFrame = await page.locator('.sb-import-fields').first().evaluate(frame);
            await expect(page.locator('#sb_character_import_panel .ds-pref-group h3')).toHaveCount(0);
            await expect(page.locator('#sb_character_import_library')).toHaveText('Browse Characters');
            await page.locator('#sb_import_heading_file').scrollIntoViewIfNeeded();
            await page.mouse.move(0, 0);
            await page.screenshot({ path: `/tmp/opencode/step7-import-${suffix}-top.png` });
            const results = page.locator('#sb_character_import_results');
            await results.scrollIntoViewIfNeeded();
            await expect.poll(() => results.locator('img').first().evaluate(img => img.complete && img.naturalWidth > 0)).toBe(true);
            const actions = results.locator('[data-import-kind="character"] .sb-import-result-action');
            const geometry = await actions.first().evaluate(node => {
                const button = node.getBoundingClientRect();
                const row = node.closest('.ds-entity-row').getBoundingClientRect();
                const avatar = node.closest('.ds-entity-row').querySelector('img').getBoundingClientRect();
                return { width: button.width, height: button.height, y: button.y + button.height / 2, rowY: row.y + row.height / 2, avatarY: avatar.y + avatar.height / 2 };
            });
            expect(Math.abs(geometry.y - geometry.rowY)).toBeLessThanOrEqual(1);
            expect(Math.abs(geometry.y - geometry.avatarY)).toBeLessThanOrEqual(1);
            expect(geometry.height).toBeGreaterThanOrEqual(40);
            await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
            await page.mouse.move(0, 0);
            await page.screenshot({ path: `/tmp/opencode/step7-import-${suffix}.png` });
            await results.getByRole('button', { name: 'Edit', exact: true }).click();
            await expect(page.locator('#avatar_url_pole')).toHaveValue('qa-imported.png');
            expect(importHeading).toEqual(await page.locator('#sb_character_section_character_fields').evaluate(typography));
            expect(importFrame).toEqual(await page.locator('[data-sb-section="character-fields"] > .ds-pref-group').evaluate(frame));
            await page.mouse.move(0, 0);
            await page.screenshot({ path: `/tmp/opencode/step7-import-reference-character-${suffix}.png` });
            await page.evaluate(async () => {
                const { openPersonaEditor } = await import('/scripts/sillybunny-persona-editor.js');
                await openPersonaEditor({ avatarId: 'qa-import-persona.png' });
            });
            await expect(page.locator('#PersonaManagement .sb-persona-entry')).toBeVisible();
            await page.screenshot({ path: `/tmp/opencode/step7-import-reference-persona-${suffix}.png` });
            await page.evaluate(async book => { await (await import('/scripts/world-info.js')).openWorldInfoEditor(book); }, BOOK);
            // The book may already be selected and cover its sidebar on narrow layouts.
            await page.locator('#WorldInfo .sb-wi-row').first().dispatchEvent('click');
            await expect(page.locator('#WorldInfo .sb-wi-entry')).toBeVisible();
            await page.screenshot({ path: `/tmp/opencode/step7-import-reference-wi-${suffix}.png` });
        }
    });
}
