import { expect, test } from '@playwright/test';
import { gunzipSync } from 'node:zlib';
import { protectMaintainerServer, showToasts } from './helpers/maintainer-server.js';

test.beforeEach(async ({ page }) => {
    await protectMaintainerServer(page);
    // Browser QA must not change the running instance's saved preferences.
    await page.route('**/api/settings/save', route => {
        const request = route.request();
        const body = request.headers()['content-encoding'] === 'gzip'
            ? gunzipSync(request.postDataBuffer()) : request.postDataBuffer();
        const payload = JSON.parse(body.toString());
        return route.fulfill({ json: { result: 'ok', version: payload._version + 1 } });
    });
});

async function openEditor(page) {
    await page.goto('/');
    await page.waitForFunction(() => !document.getElementById('preloader'));
    await page.locator('#sb-character-toggle').click();
    await page.evaluate(async () => {
        const app = await import('/script.js');
        app.setCharacterId(0);
        app.select_selected_character(0);
    });
    await expect(page.locator('#sb_character_editor_header')).toBeVisible();
}

async function stubCharacterMutations(page) {
    await page.route('**/api/characters/edit*', route => route.fulfill({ body: 'ok' }));
    await page.route('**/api/characters/save*', route => route.fulfill({ body: 'ok' }));
}

async function hasGreetingMotion(page) {
    return page.evaluate(() => {
        const list = document.querySelector('.alternate_greetings_list');
        if (!list) return false;
        return document.getAnimations().some(animation => {
            const target = animation.effect?.target;
            return target === list || (target instanceof Node && list.contains(target));
        });
    });
}

/** Animations inside the editor form; unrelated app motion (e.g. loading spinners) is ignored. */
function countEditorAnimations(page) {
    return page.evaluate(() => {
        const form = document.getElementById('form_create');
        return document.getAnimations().filter(animation => {
            const target = animation.effect?.target;
            return target instanceof Node && Boolean(form?.contains(target));
        }).length;
    });
}

async function openExportMenu(page) {
    const trigger = page.locator('#export_button');
    if (await trigger.isVisible()) {
        await trigger.click();
    } else {
        await page.locator('#sb_character_editor_more').click();
        await page.getByRole('menuitem', { name: /Export/ }).click();
    }
}

for (const viewport of [{ width: 1440, height: 900 }, { width: 375, height: 812 }]) {
    test(`preview replaces every enabled source field at ${viewport.width}px`, async ({ page }) => {
        await page.setViewportSize(viewport);
        await openEditor(page);
        const fields = await page.locator('[data-sb-segment-for]').evaluateAll(nodes => nodes.map(node => node.dataset.sbSegmentFor));
        expect(fields).toHaveLength(7);
        for (const id of fields) {
            const segment = page.locator(`[data-sb-segment-for="${id}"]`);
            const source = page.locator(`#${id}`);
            await source.scrollIntoViewIfNeeded();
            const value = await source.inputValue();
            const height = (await source.boundingBox()).height;
            const preview = page.locator(`[data-sb-preview-pane="${id}"]`);
            await expect(preview).toBeHidden();
            await segment.getByRole('radio', { name: 'Preview', exact: true }).check();
            await expect(source).toBeHidden();
            await expect(preview).toBeVisible();
            expect(Math.abs((await preview.boundingBox()).height - height)).toBeLessThan(2);
            await segment.getByRole('radio', { name: 'Edit', exact: true }).check();
            await expect(source).toBeVisible();
            await expect(preview).toBeHidden();
            await expect(source).toHaveValue(value);
        }
        await expect(page.locator('#sb_character_editor_save')).toBeDisabled();
    });

    test(`export downloads each format through the shell menu at ${viewport.width}px`, async ({ page }) => {
        await page.setViewportSize(viewport);
        // Exercise save-before-export without writing the user's character or chat.
        await page.route('**/api/characters/edit*', route => route.fulfill({ body: 'ok' }));
        await page.route('**/api/chats/save', route => route.fulfill({ json: {} }));
        await openEditor(page);
        for (const format of ['json', 'png']) {
            const trigger = page.locator('#export_button');
            await openExportMenu(page);
            await expect(page.locator(viewport.width < 769 ? '.sb-action-sheet' : '.sb-action-popover')).toBeVisible();
            const save = page.waitForRequest(request => request.url().includes('/api/characters/edit'));
            const response = page.waitForResponse(response => response.url().endsWith('/api/characters/export'));
            const download = page.waitForEvent('download');
            await page.getByRole('menuitem', { name: format.toUpperCase(), exact: true }).click();
            await save;
            expect((await response).ok()).toBe(true);
            expect((await download).suggestedFilename()).toMatch(new RegExp(`\\.${format}$`));
            await expect(trigger).toHaveAttribute('aria-expanded', 'false');
        }
    });
}

for (const theme of ['Libadwaita', 'Libadwaita Light']) test(`editor headings match Customize typography in ${theme}`, async ({ page }) => {
    await openEditor(page);
    await page.evaluate(theme => $('#themes').val(theme).trigger('change'), theme);
    const typography = node => {
        const style = getComputedStyle(node);
        return [style.fontSize, style.fontWeight, style.lineHeight, style.color];
    };
    const heading = await page.locator('#sb_character_section_character_fields').evaluate(typography);
    const subtitle = await page.locator('[data-sb-section="character-fields"] .ds-pref-group-subtitle').evaluate(typography);
    await page.locator('#sb-right-shell-toggle').click();
    await page.locator('button[data-sb-settings-tab="appearance"]').click();
    const reference = await page.getByText('Theme Colors', { exact: true }).evaluate(typography);
    const referenceSubtitle = await page.locator('.sb-settings-flat-header').filter({ hasText: 'Theme Colors' }).locator('small').evaluate(typography);
    expect(heading).toEqual(reference);
    expect(subtitle).toEqual(referenceSubtitle);
});

test('keyboard previews reset cleanly when another editor session opens', async ({ page }) => {
    await openEditor(page);
    const segment = page.locator('[data-sb-segment-for="description_textarea"]');
    const edit = segment.getByRole('radio', { name: 'Edit', exact: true });
    await edit.focus();
    await page.keyboard.press('ArrowRight');
    await expect(page.locator('#description_textarea')).toBeHidden();
    await page.evaluate(async () => {
        const app = await import('/script.js');
        app.select_selected_character(0);
    });
    await expect(edit).toBeChecked();
    await expect(page.locator('#description_textarea')).toBeVisible();
    await expect(page.locator('[data-sb-preview-pane="description_textarea"]')).toBeHidden();
    // An upstream programmatic input must not resurrect a stale preview mode.
    await page.locator('#description_textarea').evaluate(node => $(node).trigger('input'));
    await expect(page.locator('[data-sb-preview-pane="description_textarea"]')).toBeHidden();
    await expect(page.locator('#sb_character_editor_save')).toBeDisabled();
});

test('alternate greeting additions skip motion when reduced motion is enabled', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await stubCharacterMutations(page);
    await openEditor(page);
    await expect.poll(() => countEditorAnimations(page)).toBe(0);
    const list = page.locator('.alternate_greetings_list');
    const count = await list.locator('.sb-greeting-row').count();
    await page.locator('#character_greetings_editor .sb-greetings-editor__add').click();
    await expect(list.locator('.sb-greeting-row')).toHaveCount(count + 1);
    expect(await hasGreetingMotion(page)).toBe(false);
});

test('alternate greeting additions animate the greeting list', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await stubCharacterMutations(page);
    await openEditor(page);
    const list = page.locator('.alternate_greetings_list');
    const count = await list.locator('.sb-greeting-row').count();
    await page.locator('#character_greetings_editor .sb-greetings-editor__add').click();
    await expect(list.locator('.sb-greeting-row')).toHaveCount(count + 1);
    await expect.poll(() => hasGreetingMotion(page)).toBe(true);
});

test('edit and preview transitions honor reduced motion', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await stubCharacterMutations(page);
    await openEditor(page);
    const wrapper = page.locator('#descriptionWrapper');
    const preview = page.locator('[data-sb-segment-for="description_textarea"]').getByRole('radio', { name: 'Preview', exact: true });
    await preview.check();
    await expect.poll(() => wrapper.evaluate(node => document.getAnimations().some(animation => {
        const target = animation.effect?.target;
        return target === node || (target instanceof Node && node.contains(target));
    }))).toBe(true);
    await expect.poll(() => countEditorAnimations(page)).toBe(0);

    await page.emulateMedia({ reducedMotion: 'reduce' });
    await wrapper.locator('[data-sb-segment-for="description_textarea"]').getByRole('radio', { name: 'Edit', exact: true }).check();
    expect(await countEditorAnimations(page)).toBe(0);
});

test('opening an alternate greeting row reveals its content with motion', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await stubCharacterMutations(page);
    await openEditor(page);
    const list = page.locator('.alternate_greetings_list');
    const add = page.locator('#character_greetings_editor .sb-greetings-editor__add');
    await add.click();
    const row = list.locator('.sb-greeting-row').last();
    await expect(row).toHaveAttribute('open', '');
    await row.evaluate(node => { node.open = false; });
    await row.locator('summary').click();
    await expect.poll(() => row.evaluate(node => document.getAnimations().some(animation => {
        const target = animation.effect?.target;
        return target === node || (target instanceof Node && node.contains(target));
    }))).toBe(true);
});

test('opening an alternate greeting row skips motion with reduced motion', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await stubCharacterMutations(page);
    await openEditor(page);
    const list = page.locator('.alternate_greetings_list');
    await page.locator('#character_greetings_editor .sb-greetings-editor__add').click();
    const row = list.locator('.sb-greeting-row').last();
    await expect(row).toHaveAttribute('open', '');
    await row.evaluate(node => { node.open = false; });
    await row.locator('summary').click();
    expect(await countEditorAnimations(page)).toBe(0);
});

/** Enters Quick Edit, leaves it again and returns how many hidden sections faded back in. */
async function countQuickEditRevealFades(page) {
    await stubCharacterMutations(page);
    await openEditor(page);
    const toggle = page.locator('#sb_character_editor_quick_edit');
    await page.evaluate(async () => {
        const powerUser = await import('/scripts/power-user.js');
        powerUser.setCharacterEditorQuickEdit(true);
    });
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(() => countEditorAnimations(page)).toBe(0);
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    return page.evaluate(() => document.getAnimations().filter(animation => {
        const target = animation.effect?.target;
        return target instanceof HTMLElement && target.matches('#form_create .sb-editor-section:not([data-sb-section="essentials"])');
    }).length);
}

test('leaving Quick Edit fades the revealed sections in', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    expect(await countQuickEditRevealFades(page)).toBeGreaterThan(0);
});

test('leaving Quick Edit is instant with reduced motion', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    expect(await countQuickEditRevealFades(page)).toBe(0);
});

test('mobile scroll-hide reclaims header and toolbar space and restores it on scroll-up', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await openEditor(page);
    // Both editors share .sb-editor-sheet__content, so scope to the character form.
    const content = page.locator('#form_create .sb-editor-sheet__content');
    const header = page.locator('#sb_character_editor_header');
    const toolbar = page.locator('#sb_character_editor_toolbar');
    const height = (await content.boundingBox()).height;
    const chromeHeight = (await header.boundingBox()).height + (await toolbar.boundingBox()).height;
    await content.hover();
    await page.mouse.wheel(0, 400);
    await expect.poll(async () => (await content.boundingBox()).height).toBeGreaterThan(height + chromeHeight - 2);
    await page.mouse.wheel(0, -100);
    await expect.poll(async () => (await content.boundingBox()).height).toBeLessThan(height + 2);
    await expect(header).toBeVisible();
    await expect(toolbar).toBeVisible();
    // The chrome suppresses layout-induced scroll for 250ms after revealing;
    // a single synthetic jump inside that window is intentionally ignored.
    await page.waitForTimeout(250);
    await content.evaluate(node => { node.scrollTop = node.scrollHeight; });
    await expect(header).toBeHidden();
    await page.evaluate(async () => {
        for (let frame = 0; frame < 20; frame++) await new Promise(requestAnimationFrame);
    });
    await expect(header).toBeHidden();
    await page.mouse.wheel(0, -100);
    await expect(header).toBeVisible();
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(header).toBeVisible();
    await expect(toolbar).toBeVisible();
});

test('desktop fields share one height and Created by aligns with its section', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openEditor(page);
    const layout = await page.evaluate(() => {
        const form = document.getElementById('form_create');
        const heights = [...form.querySelectorAll('[data-sb-section]:not([data-sb-section="metadata"]) textarea[data-sb-editor-field]')]
            .filter(node => node.offsetParent)
            .map(node => Math.round(node.getBoundingClientRect().height));
        const x = selector => Math.round(form.querySelector(selector).getBoundingClientRect().x);
        const flat = [...form.querySelectorAll('.sb-greetings-editor__add, #tags_div .tags_view, #sb_creator_notes_maximize')]
            .map(node => getComputedStyle(node).borderTopWidth);
        return {
            heights,
            createdBy: x('#creator_textarea'),
            notes: x('#creator_notes_textarea'),
            flat,
        };
    });
    expect(layout.heights.length).toBeGreaterThan(1);
    expect(new Set(layout.heights).size).toBe(1);
    expect(layout.createdBy).toBe(layout.notes);
    expect(layout.flat.every(width => width === '0px')).toBe(true);
});

test('dirty draft recovers after page reload', async ({ page }) => {
    await openEditor(page);
    const name = page.locator('#character_name_pole');
    const initialName = await name.inputValue();
    await name.fill('Draft Recovery Test');
    await expect(page.locator('#sb_character_editor_dirty')).toBeVisible();
    // beforeunload writes the draft and arms the browser's leave prompt; accept it.
    page.on('dialog', dialog => dialog.accept());
    await page.reload();
    await page.waitForFunction(() => !document.getElementById('preloader'));
    // Reopen editor
    await page.locator('#sb-character-toggle').click();
    await page.evaluate(async () => {
        const app = await import('/script.js');
        app.setCharacterId(0);
        app.select_selected_character(0);
    });
    await expect(page.locator('#sb_character_editor_header')).toBeVisible();
    await showToasts(page);
    await page.locator('#sb_draft_restore_btn').click();
    await expect(name).toHaveValue('Draft Recovery Test');
    await expect(page.locator('#sb_character_editor_dirty')).toBeVisible();
    // Escape runs the dirty guard; Discard reverts to the saved card and drops the draft.
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Discard', exact: true }).click();
    await expect(name).toHaveValue(initialName);
    expect(await page.evaluate(() => Object.keys(localStorage).some(key => key.startsWith('sb-editor-draft-')))).toBe(false);
    await expect(page.locator('#sb_character_editor_dirty')).toBeHidden();
});
