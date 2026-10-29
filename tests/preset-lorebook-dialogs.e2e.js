import { expect, test } from '@playwright/test';
import { bootPresetLorebookDialogs, openPresetLorebookDialog, PL_VIEWPORTS } from './helpers/preset-lorebook-dialogs.js';
import { showToasts } from './helpers/maintainer-server.js';

test.setTimeout(90000);

async function expectFrame(popup, viewport, immediate = false) {
    await expect(popup).toHaveClass(/sb-dialog--dialog/);
    await expect(popup).toHaveAttribute('data-presentation', viewport.presentation);
    const content = popup.locator('.popup-content');
    await content.evaluate(node => { node.scrollTop = node.scrollHeight; });
    const last = content.locator('.ds-row').last();
    await expect(last).toBeInViewport();
    expect(await last.evaluate(node => {
        const row = node.getBoundingClientRect();
        const body = node.closest('.popup-content').getBoundingClientRect();
        return row.bottom <= body.bottom + 1 && row.top >= body.top - 1 && node.closest('dialog').scrollWidth <= node.closest('dialog').clientWidth + 1;
    })).toBe(true);
    if (immediate) {
        await expect(popup.locator('.popup-button-ok')).toBeHidden();
        await expect(popup.locator('.sb-dialog__close')).toBeInViewport();
    } else {
        await expect(popup.locator('.popup-button-ok')).toBeInViewport();
        await expect(popup.locator('.popup-button-cancel')).toBeInViewport();
    }
    expect(await content.locator('.ds-row-check, .ds-row-switch').evaluateAll(rows => rows.every(row => {
        const label = row.querySelector('.ds-row-label').getBoundingClientRect();
        const input = row.querySelector('input').getBoundingClientRect();
        return input.left > label.right && row.lastElementChild.matches('input');
    }))).toBe(true);
    expect(await content.locator('.ds-row:has(> .ds-row-suffix)').evaluateAll(rows => rows.every(row => {
        const label = row.querySelector('.ds-row-text').getBoundingClientRect();
        const suffix = row.querySelector('.ds-row-suffix').getBoundingClientRect();
        return suffix.left >= label.right && row.lastElementChild.classList.contains('ds-row-suffix');
    }))).toBe(true);
}

async function pickBook(page, popup, rowIndex, name) {
    await popup.locator('.ds-select-row__trigger').nth(rowIndex).click();
    const picker = page.locator('.sb-picker, .sb-picker-sheet').last();
    await picker.getByRole('option', { name, exact: true }).click();
}

for (const viewport of PL_VIEWPORTS) {
    const size = `${viewport.width}×${viewport.height}`;
    test(`Master export keeps default sections and returns only checked data at ${size}`, async ({ page }) => {
        await bootPresetLorebookDialogs(page, viewport);
        const popup = await openPresetLorebookDialog(page, 'export');
        await expectFrame(popup, viewport);
        await expect(popup.locator('input[value="preset"]')).not.toBeChecked();
        await expect(popup.locator('input[value="srw"]')).not.toBeChecked();
        await popup.locator('[data-sb-select-all]').check();
        await popup.locator('.popup-button-ok').click();
        await expect(popup).toHaveCount(0);
        const exported = await page.evaluate(() => JSON.parse(window.__plResult));
        expect(Object.keys(exported)).toEqual(['instruct', 'context', 'sysprompt', 'preset', 'reasoning', 'srw']);
        expect(exported).not.toHaveProperty('on');
    });

    test(`Master import preserves selected section writes and subtitles at ${size}`, async ({ page }) => {
        const state = await bootPresetLorebookDialogs(page, viewport);
        const popup = await openPresetLorebookDialog(page, 'import');
        await expectFrame(popup, viewport);
        await expect(popup.locator('.ds-row-subtitle', { hasText: 'Dialog import context' })).toBeVisible();
        await popup.locator('[data-sb-select-all]').uncheck();
        await popup.locator('input[value="context"]').check();
        await popup.locator('input[value="srw"]').check();
        await popup.locator('.popup-button-ok').click();
        await expect.poll(() => state.presets.length).toBe(1);
        expect(state.presets[0]).toMatchObject({ apiId: 'context', name: 'Dialog import context', preset: { story_string: '{{description}}' } });
        await expect.poll(() => state.settings.some(settings => settings.power_user.user_prompt_bias === 'Dialog prefix')).toBe(true);
    });

    test(`Preset deletion focuses Cancel, ignores Return and deletes only selected values at ${size}`, async ({ page }) => {
        const state = await bootPresetLorebookDialogs(page, viewport);
        let popup = await openPresetLorebookDialog(page, 'delete');
        await expectFrame(popup, viewport);
        await expect(popup.locator('.popup-button-cancel')).toBeFocused();
        await expect(popup.locator('.popup-button-ok')).toHaveClass(/is-destructive/);
        await page.keyboard.press('Enter');
        await expect(popup).toHaveCount(0);
        expect(state.deleted).toHaveLength(0);
        popup = await openPresetLorebookDialog(page, 'delete');
        await popup.locator('[data-sb-select-all]').check();
        await expect(popup.locator('input:checked:not([data-sb-select-all])')).toHaveCount(18);
        await popup.locator('[data-sb-select-all]').uncheck();
        await popup.locator('input[value="Preset 2"]').check();
        await popup.locator('input[value="Preset 6"]').check();
        await popup.locator('.popup-button-ok').click();
        let confirm = page.locator('dialog.popup[open]').last();
        await expect(confirm).toContainText('2 selected presets');
        await expect(confirm.locator('.popup-button-cancel')).toBeFocused();
        await expect(confirm.locator('.popup-button-ok')).toHaveClass(/is-destructive/);
        await page.keyboard.press('Enter');
        await expect(confirm).toHaveCount(0);
        expect(state.deleted).toHaveLength(0);
        popup = await openPresetLorebookDialog(page, 'delete');
        await popup.locator('input[value="Preset 2"]').check();
        await popup.locator('input[value="Preset 6"]').check();
        await popup.locator('.popup-button-ok').click();
        confirm = page.locator('dialog.popup[open]').last();
        await expect(confirm).toContainText('2 selected presets');
        await confirm.locator('.popup-button-ok').click();
        await expect.poll(() => state.deleted.length).toBe(2);
        expect(state.deleted.map(item => item.name)).toEqual(['Preset 2', 'Preset 6']);
    });

    test(`Batch embedded import retains collision warnings, selection and auxiliary links at ${size}`, async ({ page }) => {
        const state = await bootPresetLorebookDialogs(page, viewport);
        const popup = await openPresetLorebookDialog(page, 'batch');
        await expectFrame(popup, viewport);
        await expect(popup).toContainText('(overwrites existing)');
        await popup.locator('[data-sb-select-all]').uncheck();
        await popup.locator('.batch_wi_import_candidate').nth(0).check();
        await popup.locator('.batch_wi_import_candidate').nth(6).check();
        await expect(popup.locator('[data-sb-select-all]')).toHaveJSProperty('indeterminate', true);
        const selected = await popup.locator('.batch_wi_import_candidate:checked').evaluateAll(inputs => inputs.map(input => input.dataset.chid));
        await popup.locator('.popup-button-ok').click();
        const summary = page.locator('dialog.popup[open]').last();
        await expect(summary).toContainText('Batch import complete');
        await expect(summary).toContainText('2 imported');
        expect(state.worlds).toHaveLength(2);
        const links = await page.evaluate(async ids => {
            const core = await import('/script.js');
            const wi = await import('/scripts/world-info.js');
            return ids.map(id => ({ avatar: core.characters[id].avatar, name: core.characters[id].data.character_book.name, linked: wi.world_info.charLore }));
        }, selected);
        for (const link of links) expect(link.linked).toEqual(expect.arrayContaining([expect.objectContaining({ name: link.avatar.replace('.png', ''), extraBooks: [link.name] })]));
    });

    test(`World Info import uses Cancel and Import response labels at ${size}`, async ({ page }) => {
        const state = await bootPresetLorebookDialogs(page, viewport);
        const openImport = async (avatar, bookName) => {
            await page.evaluate(async ({ avatar, bookName }) => {
                const core = await import('/script.js');
                const { characters } = core;
                const id = Object.keys(characters).find(key => characters[key].avatar === avatar);
                if (bookName) characters[id].data.character_book.name = bookName;
                $('#import_character_info').data('chid', Number(id));
                window.__worldInfoImport = (await import('/scripts/world-info.js')).importEmbeddedWorldInfo(false);
            }, { avatar, bookName });
            const popup = page.locator('dialog.popup[open]').last();
            await popup.waitFor();
            return popup;
        };

        let popup = await openImport('pl-character-0.png', 'Book 0');
        await expect(popup.getByRole('button', { name: 'Cancel', exact: true })).toBeVisible();
        await expect(popup.getByRole('button', { name: 'Import', exact: true })).toBeVisible();
        expect(await popup.locator('.popup-button-cancel').evaluate(node => {
            const ok = node.parentElement.querySelector('.popup-button-ok');
            return Boolean(ok && Number.parseInt(getComputedStyle(node).order, 10) < Number.parseInt(getComputedStyle(ok).order, 10));
        })).toBe(true);
        await expect(popup.locator('.popup-button-ok')).toHaveClass(/is-destructive/);
        if (viewport.presentation === 'floating') {
            expect(await popup.locator('.popup-button-cancel').evaluate(node => node.getBoundingClientRect().left))
                .toBeLessThan(await popup.locator('.popup-button-ok').evaluate(node => node.getBoundingClientRect().left));
        }
        await expect(popup.locator('.popup-button-cancel')).toBeFocused();
        await page.keyboard.press('Enter');
        await expect(popup).toHaveCount(0);
        expect(state.worlds).toHaveLength(0);

        popup = await openImport('pl-character-1.png', 'Embedded 1');
        await expect(popup.locator('.popup-button-cancel')).toBeVisible();
        await expect(popup.locator('.popup-button-ok')).toHaveText('Import');
        await expect(popup.locator('.popup-button-ok')).toBeFocused();
        await page.keyboard.press('Enter');
        await expect(popup).toHaveCount(0);
        await expect.poll(() => state.worlds.length).toBe(1);
    });

    test(`First-run lorebook import protects collisions without marking new imports destructive at ${size}`, async ({ page }) => {
        const state = await bootPresetLorebookDialogs(page, viewport);
        const openFirstRunImport = async (avatar, bookName) => {
            await page.evaluate(async ({ avatar, bookName }) => {
                const core = await import('/script.js');
                const { accountStorage } = await import('/scripts/util/AccountStorage.js');
                const { checkEmbeddedWorld } = await import('/scripts/world-info.js');
                const id = Object.keys(core.characters).find(key => core.characters[key].avatar === avatar);
                core.characters[id].data.character_book.name = bookName;
                accountStorage.removeItem(`AlertWI_${avatar}`);
                checkEmbeddedWorld(Number(id));
            }, { avatar, bookName });
            const popup = page.locator('dialog.popup[open]').last();
            await popup.waitFor();
            return popup;
        };

        let popup = await openFirstRunImport('pl-character-0.png', 'Book 0');
        await expect(popup.locator('.popup-button-cancel')).toBeFocused();
        await expect(popup.locator('.popup-button-ok')).toHaveClass(/is-destructive/);
        await page.keyboard.press('Enter');
        await expect(popup).toHaveCount(0);
        expect(state.worlds).toHaveLength(0);

        popup = await openFirstRunImport('pl-character-1.png', 'First-run new book');
        await expect(popup.locator('.popup-button-ok')).not.toHaveClass(/is-destructive/);
        await expect(popup.locator('.popup-button-ok')).toBeFocused();
        await page.keyboard.press('Enter');
        await expect(popup).toHaveCount(0);
        await expect.poll(() => state.worlds.length).toBe(1);
    });

    test(`Lorebook sorting keeps autofocus, warnings and native/embedded order results at ${size}`, async ({ page }) => {
        const state = await bootPresetLorebookDialogs(page, viewport);
        let popup = await openPresetLorebookDialog(page, 'sorting');
        await expect(popup.locator('#wi_sort_start')).toBeFocused();
        await expectFrame(popup, viewport);
        await popup.locator('#wi_sort_start').fill('0');
        await popup.locator('#wi_sort_step').fill('5');
        await popup.locator('#wi_sort_ascending').check();
        await expect(popup.locator('.info-block')).toBeHidden();
        await popup.locator('.popup-button-ok').click();
        await expect.poll(() => state.worlds.length).toBe(1);
        const byComment = (a, b) => a.comment.localeCompare(b.comment);
        expect(Object.values(state.worlds[0].data.entries).sort(byComment).map(entry => entry.order)).toEqual([0, 5, 10]);
        expect([...state.worlds[0].data.originalData.entries].sort(byComment).map(entry => entry.insertion_order)).toEqual([0, 5, 10]);
        popup = await openPresetLorebookDialog(page, 'sorting');
        await popup.locator('#wi_sort_start').fill('8');
        await popup.locator('#wi_sort_step').fill('5');
        await expect(popup.locator('.info-block')).toContainText('clamped');
        await popup.locator('.popup-button-ok').click();
        await expect.poll(() => state.worlds.length).toBe(2);
        expect(Object.values(state.worlds[1].data.entries).sort(byComment).map(entry => entry.order)).toEqual([8, 3, 0]);
    });

    test(`Clearing Starting value survives blur and applies zero-based order at ${size}`, async ({ page }) => {
        const state = await bootPresetLorebookDialogs(page, viewport);
        const popup = await openPresetLorebookDialog(page, 'sorting');
        const start = popup.locator('#wi_sort_start');
        await start.fill('');
        await start.blur();
        await expect(start).toHaveValue('');
        await popup.locator('#wi_sort_step').fill('5');
        await popup.locator('#wi_sort_ascending').check();
        await popup.locator('.popup-button-ok').click();
        await expect.poll(() => state.worlds.length).toBe(1);
        const byComment = (a, b) => a.comment.localeCompare(b.comment);
        expect(Object.values(state.worlds[0].data.entries).sort(byComment).map(entry => entry.order)).toEqual([0, 5, 10]);
        expect([...state.worlds[0].data.originalData.entries].sort(byComment).map(entry => entry.insertion_order)).toEqual([0, 5, 10]);
    });

    test(`Clearing Step survives blur and is rejected upstream at ${size}`, async ({ page }) => {
        const state = await bootPresetLorebookDialogs(page, viewport);
        await showToasts(page);
        const popup = await openPresetLorebookDialog(page, 'sorting');
        const step = popup.locator('#wi_sort_step');
        await step.fill('');
        await step.blur();
        await expect(step).toHaveValue('');
        await popup.locator('.popup-button-ok').click();
        await expect(popup).toHaveCount(0);
        await expect(page.locator('#toast-container .toast-error').filter({ hasText: 'Invalid step value: 0' })).toHaveCount(1);
        expect(state.worlds).toHaveLength(0);
        expect(Object.values(state.books.get('Book 0').entries).map(entry => entry.order)).toEqual([100, 100, 100]);
    });

    test(`Step 0 clamps to 1 on blur and sorting applies with step 1 at ${size}`, async ({ page }) => {
        const state = await bootPresetLorebookDialogs(page, viewport);
        const popup = await openPresetLorebookDialog(page, 'sorting');
        const step = popup.locator('#wi_sort_step');
        await step.fill('0');
        await step.blur();
        await expect(step).toHaveValue('1');
        await popup.locator('.popup-button-ok').click();
        await expect.poll(() => state.worlds.length).toBe(1);
        const byComment = (a, b) => a.comment.localeCompare(b.comment);
        expect(Object.values(state.worlds[0].data.entries).sort(byComment).map(entry => entry.order)).toEqual([100, 99, 98]);
        expect([...state.worlds[0].data.originalData.entries].sort(byComment).map(entry => entry.insertion_order)).toEqual([100, 99, 98]);
    });

    test(`Starting value -5 clamps to 0 on blur before sorting applies at ${size}`, async ({ page }) => {
        const state = await bootPresetLorebookDialogs(page, viewport);
        const popup = await openPresetLorebookDialog(page, 'sorting');
        const start = popup.locator('#wi_sort_start');
        await start.fill('-5');
        await start.blur();
        await expect(start).toHaveValue('0');
        await popup.locator('#wi_sort_ascending').check();
        await popup.locator('.popup-button-ok').click();
        await expect.poll(() => state.worlds.length).toBe(1);
        const byComment = (a, b) => a.comment.localeCompare(b.comment);
        expect(Object.values(state.worlds[0].data.entries).sort(byComment).map(entry => entry.order)).toEqual([0, 1, 2]);
        expect([...state.worlds[0].data.originalData.entries].sort(byComment).map(entry => entry.insertion_order)).toEqual([0, 1, 2]);
    });

    for (const surface of ['character', 'persona', 'chat']) {
        test(`${surface} lorebooks mirror selects and persist immediate changes at ${size}`, async ({ page }) => {
            const state = await bootPresetLorebookDialogs(page, viewport);
            const popup = await openPresetLorebookDialog(page, surface);
            await expectFrame(popup, viewport, true);
            await pickBook(page, popup, 0, 'Book 3');
            await expect(popup.locator('.ds-select-row__value').first()).toHaveText('Book 3');
            if (surface === 'character') {
                const auxiliary = popup.locator('.ds-select-row').nth(1);
                await expect(auxiliary.locator('.ds-select-row__value')).toHaveText('No auxiliary Lorebooks set. Click here to select.');
                await expect(auxiliary.locator('select option[value=""]')).toHaveCount(1);
                await page.screenshot({ path: test.info().outputPath('character-lorebooks.png') });
                if (viewport.width > 450) {
                    const select2 = popup.locator('.ds-select-row .select2-container');
                    await expect(select2).toHaveCount(1);
                    await expect(select2).toHaveCSS('display', 'none');
                }
                await auxiliary.locator('.ds-select-row__trigger').click();
                const picker = page.locator('.sb-picker, .sb-picker-sheet').last();
                await expect(picker.getByRole('option', { name: /World Info not found/ })).toHaveCount(0);
                await picker.getByRole('option', { name: 'Book 6', exact: true }).click();
                await picker.getByRole('option', { name: 'Book 7', exact: true }).click();
                await page.keyboard.press('Escape');
                expect(await popup.locator('.character_extra_world_info_selector').evaluate(select => [...select.selectedOptions].map(option => option.textContent))).toEqual(['Book 6', 'Book 7']);
                await expect.poll(() => state.settings.some(settings => settings.world_info_settings?.world_info?.charLore?.some(item => item.extraBooks.includes('Book 6') && item.extraBooks.includes('Book 7')))).toBe(true);
                await expect.poll(() => state.characterWrites.some(body => /name="world"\r\n\r\nBook 3\r\n/.test(body))).toBe(true);
            }
            if (surface === 'persona') await expect.poll(() => state.settings.some(settings => settings.power_user.persona_description_lorebook === 'Book 3')).toBe(true);
            if (surface === 'chat') {
                expect(await page.evaluate(async () => (await import('/script.js')).chat_metadata.world_info)).toBe('Book 3');
                await expect.poll(() => state.chatWrites.some(write => write.chat?.[0]?.chat_metadata?.world_info === 'Book 3')).toBe(true);
            }
            await popup.locator('.sb-dialog__close').click();
            await expect(popup).toHaveCount(0);
        });
    }
}
