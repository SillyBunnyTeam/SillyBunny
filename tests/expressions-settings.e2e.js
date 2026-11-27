import { expect, test } from '@playwright/test';
import { variantContextOptions } from './helpers/surface-matrix.js';
import { bootSurfaceApp, openSurface } from './helpers/surfaces/boot.js';
import { SURFACES } from './helpers/surfaces/index.js';
import { EXTENSION_DETAIL, openExtensionSubpage } from './helpers/settings-inventory-steps.js';

/**
 * The Character Expressions page: every action has one form, the controls take the keyboard, and the sprite list holds its
 * controls. The sprites are the ones of the bundled Assistant Reisen, which a fresh data root seeds.
 */
test.describe.configure({ timeout: 180_000 });

const VIEWPORTS = ['1440x900', '390x844'];
const SPRITE_ACTIONS = ['expressions_generate_missing_sprites', 'expressions_upload_sprite_sheet', 'expressions_redo_sprite_cleanup', 'expressions_stop_sprite_generation', 'expression_upload_pack_button', 'expressions_remove_all_sprites', 'expression_override_cleanup_button'];

async function openPage(browser, baseURL, viewport, { character } = {}) {
    const surface = SURFACES.find(candidate => candidate.id === 'settings.customize.extensions');
    const variant = { viewport, theme: 'libadwaita', density: 'normal' };
    const storageState = test.info().project.use.storageState;
    const context = await browser.newContext({ ...variantContextOptions(variant), baseURL, ...(storageState ? { storageState } : {}) });
    const page = await context.newPage();
    await bootSurfaceApp(page, baseURL, { variant, needs: surface.needs });
    if (character) {
        await page.evaluate(async name => {
            const sillyTavern = window.SillyTavern.getContext();
            const index = sillyTavern.characters.findIndex(candidate => candidate.name === name);
            if (index < 0) throw new Error(`The character ${name} is not in the list.`);
            await sillyTavern.selectCharacterById(index);
        }, character);
        // The extension draws its sprite list from the worker that runs every two seconds.
        await expect.poll(() => page.evaluate(() => window.$('#image_list').data('name') ?? ''), { timeout: 30_000 }).not.toBe('');
    }
    await openSurface(page, surface, { viewport });
    await openExtensionSubpage(page, 'expressions_container');
    return { context, page, detail: page.locator(EXTENSION_DETAIL) };
}

// A one-pixel PNG: the server only checks that the bytes are an image of the stored type.
const PIXEL = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const LONG_SPRITE = `joy-${'long'.repeat(14)}`;

/** Creates a character whose folder holds the given sprites (file name and label), through the server's own routes. */
async function createCharacterWithSprites(browser, baseURL, name, sprites) {
    const storageState = test.info().project.use.storageState;
    const probe = await browser.newContext({ baseURL, ...(storageState ? { storageState } : {}) });
    const token = (await (await probe.request.get('/csrf-token')).json()).token;
    const headers = { 'X-CSRF-Token': token };
    const made = await probe.request.post('/api/characters/create', { headers, multipart: { ch_name: name, description: 'Sprites.', first_mes: 'Hello.', fav: 'false' } });
    expect(made.ok()).toBe(true);
    for (const { spriteName, label } of sprites) {
        const sent = await probe.request.post('/api/sprites/upload', { headers, multipart: { name, label, spriteName, avatar: { name: `${spriteName}.png`, mimeType: 'image/png', buffer: PIXEL } } });
        expect(sent.ok()).toBe(true);
    }
    await probe.close();
}

const isCoarse = viewport => viewport === '390x844';
const floorOf = viewport => (isCoarse(viewport) ? 44 : 32);

for (const viewport of VIEWPORTS) {
    test.describe(`Character Expressions at ${viewport}`, () => {
        test('shows only the empty state and the settings when no chat is open', async ({ browser, baseURL }) => {
            const { context, page, detail } = await openPage(browser, baseURL, viewport);
            await expect(detail.locator('#no_chat_expressions')).toBeVisible();
            await expect(detail.locator('#open_chat_expressions')).toBeHidden();
            await expect(detail.locator('#no_chat_expressions')).toHaveCSS('font-weight', '400');
            // Both buttons of the custom expressions are real buttons with a name and the target floor.
            for (const id of ['expression_custom_add', 'expression_custom_remove']) {
                const button = detail.locator(`#${id}`);
                expect(await button.evaluate(node => node.localName)).toBe('button');
                await expect(button).toHaveAccessibleName(/\S/);
                const box = await button.boundingBox();
                expect(Math.min(box.width, box.height)).toBeGreaterThanOrEqual(floorOf(viewport));
            }
            const overflow = await detail.evaluate(node => node.scrollWidth - node.clientWidth);
            expect(overflow).toBeLessThanOrEqual(1);
            await context.close();
            void page;
        });

        test('row titles use header capitalisation', async ({ browser, baseURL }) => {
            const { context, detail } = await openPage(browser, baseURL, viewport);
            const titles = await detail.locator('.ds-row-label').evaluateAll(labels => labels.filter(label => label.getClientRects().length).map(label => label.textContent.trim()));
            expect(titles).toEqual(expect.arrayContaining([
                'Translate Text to English Before Classification',
                'Allow Multiple Sprites per Expression',
                'Re-Roll if Same Sprite Is Used Again',
                'Classifier API',
                'Default / Fallback Expression',
                'Custom Expressions',
            ]));
            await context.close();
        });

        test('the sprite actions are label-only button rows of one group, and the folder override is an entry row', async ({ browser, baseURL }) => {
            const { context, detail } = await openPage(browser, baseURL, viewport, { character: 'Assistant Reisen' });
            const group = detail.locator('#open_chat_expressions > .ds-pref-group');
            await expect(group).toBeVisible();
            for (const id of SPRITE_ACTIONS.filter(action => action !== 'expressions_stop_sprite_generation')) {
                const row = group.locator(`#${id}`);
                await expect(row).toBeVisible();
                await expect(row).toHaveClass(/ds-button-row/);
                await expect(row.locator('i')).toHaveCount(0);
                await expect(row).toHaveAccessibleName(/\S/);
                const box = await row.boundingBox();
                expect(box.height).toBeGreaterThanOrEqual(floorOf(viewport));
            }
            // The stop action shows only while a generation runs.
            await expect(group.locator('#expressions_stop_sprite_generation')).toBeHidden();
            const override = group.locator('.ds-row-entry--floating:has(#expression_override)');
            await expect(override).toBeVisible();
            await expect(override.locator('.ds-row-entry__caption')).toContainText('subfolder');
            const submit = override.locator('#expression_override_button');
            await expect(submit).toHaveAccessibleName('Submit');
            const submitBox = await submit.boundingBox();
            const rowBox = await override.boundingBox();
            // The button ends inside the row, as it did not at 390px, where it was cut off.
            expect(submitBox.x + submitBox.width).toBeLessThanOrEqual(rowBox.x + rowBox.width + 1);
            expect(Math.min(submitBox.width, submitBox.height)).toBeGreaterThanOrEqual(floorOf(viewport));
            // Every visible button of the page is one form: a label or an icon with the tooltip as its name. The chevron of a select
            // row's trigger shows its state and is not an icon in this sense.
            const mixed = await detail.evaluate(root => [...root.querySelectorAll('button, [role="button"]')]
                .filter(node => node.getClientRects().length && !node.closest('.sb-legacy-search-hidden') && !node.matches('.ds-select-row__trigger'))
                .filter(node => node.querySelector('i[class*="fa-"], svg') && node.textContent.trim() !== '')
                .map(node => node.id || node.className));
            expect(mixed).toEqual([]);
            await context.close();
        });

        test('each action answers Enter and Space, and the dialogs return the focus', async ({ browser, baseURL }) => {
            const { context, page, detail } = await openPage(browser, baseURL, viewport, { character: 'Assistant Reisen' });
            const add = detail.locator('#expression_custom_add');
            await add.focus();
            await page.keyboard.press('Enter');
            const dialog = page.locator('dialog[open]');
            await expect(dialog).toBeVisible();
            // A one-field prompt names its response with a verb.
            await expect(dialog.locator('.popup-button-ok')).toHaveText('Add');
            await page.keyboard.press('Escape');
            await expect(dialog).toHaveCount(0);
            await expect(add).toBeFocused();

            const removeAll = detail.locator('#expressions_remove_all_sprites');
            await removeAll.focus();
            await page.keyboard.press('Space');
            await expect(dialog).toBeVisible();
            await page.keyboard.press('Escape');
            await expect(dialog).toHaveCount(0);
            await removeAll.focus();
            await page.keyboard.press('Enter');
            await expect(dialog).toBeVisible();
            await page.keyboard.press('Escape');
            await expect(dialog).toHaveCount(0);
            await context.close();
        });

        test('the sprite list is a list of tiles whose buttons have names and are not nested in a control', async ({ browser, baseURL }) => {
            const { context, page, detail } = await openPage(browser, baseURL, viewport, { character: 'Assistant Reisen' });
            const list = detail.locator('#image_list');
            await expect(list).toHaveAttribute('role', 'list');
            await expect(list).toHaveAccessibleName(/Sprite Set/);
            const tiles = list.locator('.expression_list_item');
            await expect.poll(() => tiles.count()).toBeGreaterThanOrEqual(28);
            const faults = await list.evaluate((node, floor) => [...node.querySelectorAll('.expression_list_item')].flatMap(tile => {
                const out = [];
                if (tile.getAttribute('role') !== 'listitem') out.push('tile role');
                if (tile.hasAttribute('tabindex') || tile.closest('button, [role="button"]') || tile.matches('.interactable')) out.push('tile is a control');
                for (const control of tile.querySelectorAll('button')) {
                    if (control.closest('button') !== control || control.querySelector('button')) out.push('nested');
                    if (!(control.getAttribute('aria-label') || control.textContent.trim() || control.querySelector('img[alt]:not([alt=""])'))) out.push(`unnamed ${control.className}`);
                    if (control.matches('.menu_button') && control.getAttribute('aria-label') !== control.getAttribute('title')) out.push(`name differs ${control.className}`);
                    const visible = getComputedStyle(control).visibility !== 'hidden';
                    const rect = control.getBoundingClientRect();
                    if (visible && rect.width && Math.min(rect.width, rect.height) < floor) out.push(`small ${control.className} ${Math.round(rect.width)}x${Math.round(rect.height)}`);
                }
                return out;
            }), floorOf(viewport));
            expect(faults).toEqual([]);

            // The image sets the sprite, with the keyboard as with the pointer, and the tile's actions do not.
            const first = tiles.first();
            const image = first.locator('.expression_list_image_container');
            await image.focus();
            const before = await page.evaluate(() => document.querySelector('img.expression')?.getAttribute('data-sprite-filename') ?? '');
            await page.keyboard.press('Enter');
            await expect.poll(() => page.evaluate(() => document.querySelector('img.expression')?.getAttribute('data-sprite-filename') ?? ''), { timeout: 10_000 }).toBe(await first.getAttribute('data-filename'));
            void before;

            // Delete asks first, and Cancel keeps the sprite.
            await first.locator('.expression_list_delete').focus();
            await page.keyboard.press('Enter');
            const dialog = page.locator('dialog[open]');
            await expect(dialog).toBeVisible();
            await expect(dialog.locator('.popup-button-ok')).toHaveText('Delete');
            await page.keyboard.press('Escape');
            await expect(dialog).toHaveCount(0);
            await expect(tiles).not.toHaveCount(0);
            await context.close();
        });

        test('a character with no sprites shows a placeholder tile for each expression', async ({ browser, baseURL }) => {
            const storageState = test.info().project.use.storageState;
            const probe = await browser.newContext({ baseURL, ...(storageState ? { storageState } : {}) });
            const token = (await (await probe.request.get('/csrf-token')).json()).token;
            const name = `Bare ${viewport}`;
            const made = await probe.request.post('/api/characters/create', { headers: { 'X-CSRF-Token': token }, multipart: { ch_name: name, description: 'No sprites.', first_mes: 'Hello.', fav: 'false' } });
            expect(made.ok()).toBe(true);
            await probe.close();
            const { context, page, detail } = await openPage(browser, baseURL, viewport, { character: name });
            const tiles = detail.locator('#image_list .expression_list_item');
            await expect.poll(() => tiles.count()).toBeGreaterThanOrEqual(28);
            expect(await detail.locator('#image_list .expression_list_item:not([data-expression-type="failure"])').count()).toBe(0);
            // A placeholder has nothing to delete; its action is hidden from the pointer and the keyboard.
            const first = tiles.first();
            await expect(first.locator('.expression_list_delete')).toBeHidden();
            await expect(first.locator('.expression_list_upload')).toBeVisible();
            await context.close();
            void page;
        });

        test('a tile with no sprite draws a dimmed symbolic icon, and its picture button keeps a text name', async ({ browser, baseURL }) => {
            const name = `Icon ${viewport}`;
            await createCharacterWithSprites(browser, baseURL, name, []);
            const { context, detail } = await openPage(browser, baseURL, viewport, { character: name });
            const tile = detail.locator('#image_list .expression_list_item[data-expression-type="failure"]').first();
            await expect(tile).toBeVisible();
            await expect(tile.locator('img')).toHaveCount(0);
            const icon = tile.locator('.expression_list_image_container .expression_list_placeholder_icon');
            await expect(icon).toBeVisible();
            await expect(icon).toHaveAttribute('aria-hidden', 'true');
            expect(Number(await icon.evaluate(node => getComputedStyle(node).opacity))).toBeLessThan(1);
            await expect(tile.locator('.expression_list_image_container')).toHaveAccessibleName('No Image');
            await context.close();
        });

        test('the sprites of one expression show their file names, shortened with an ellipsis and whole in the tooltip', async ({ browser, baseURL }) => {
            const name = `Captions ${viewport}`;
            await createCharacterWithSprites(browser, baseURL, name, [
                { spriteName: 'joy', label: 'joy' },
                { spriteName: 'joy-1', label: 'joy' },
                { spriteName: LONG_SPRITE, label: 'joy' },
                { spriteName: 'anger', label: 'anger' },
            ]);
            const { context, detail } = await openPage(browser, baseURL, viewport, { character: name });
            await detail.locator('#expressions_allow_multiple').setChecked(true);
            const joy = detail.locator('#image_list .expression_list_item[data-expression="joy"]');
            await expect(joy).toHaveCount(3);
            const captions = joy.locator('.expression_list_filename');
            await expect(captions).toHaveCount(3);
            expect(await captions.allTextContents()).toEqual(['joy.png', 'joy-1.png', `${LONG_SPRITE}.png`]);
            const long = captions.nth(2);
            await expect(long).toHaveAttribute('title', `${LONG_SPRITE}.png`);
            expect(await long.evaluate(node => ({ overflow: getComputedStyle(node).textOverflow, clipped: node.scrollWidth > node.clientWidth, inside: node.getBoundingClientRect().right <= node.closest('.expression_list_item').getBoundingClientRect().right + 0.5 }))).toEqual({ overflow: 'ellipsis', clipped: true, inside: true });
            // A tile that is the only one of its expression has nothing to tell apart.
            await expect(detail.locator('#image_list .expression_list_item[data-expression="anger"] .expression_list_filename')).toHaveCount(0);
            await context.close();
        });

        test('a tile is entered at its picture, then its actions, as on screen', async ({ browser, baseURL }) => {
            const name = `Order ${viewport}`;
            await createCharacterWithSprites(browser, baseURL, name, [{ spriteName: 'joy', label: 'joy' }]);
            const { context, page, detail } = await openPage(browser, baseURL, viewport, { character: name });
            const tile = detail.locator('#image_list .expression_list_item[data-expression="joy"]');
            await expect(tile).toHaveCount(1);
            const order = await tile.evaluate(node => [...node.querySelectorAll('button')].map(button => button.className.match(/expression_list_(\w+)/)[1]));
            expect(order).toEqual(['image_container', 'upload', 'regenerate', 'delete']);
            await tile.locator('.expression_list_image_container').focus();
            await page.keyboard.press('Tab');
            await expect(tile.locator('.expression_list_upload')).toBeFocused();
            await context.close();
        });

        test('Replace Existing in the sprite naming dialog is a destructive response, and Save keeps its place', async ({ browser, baseURL }) => {
            const name = `Replace ${viewport}`;
            await createCharacterWithSprites(browser, baseURL, name, [{ spriteName: 'joy', label: 'joy' }, { spriteName: 'joy-1', label: 'joy' }]);
            const { context, page, detail } = await openPage(browser, baseURL, viewport, { character: name });
            await detail.locator('#expressions_allow_multiple').setChecked(true);
            const tile = detail.locator('#image_list .expression_list_item[data-filename="joy-1.png"]');
            await expect(tile).toHaveCount(1);
            const chooser = page.waitForEvent('filechooser');
            await tile.locator('.expression_list_upload').click();
            await (await chooser).setFiles({ name: 'unrelated.png', mimeType: 'image/png', buffer: PIXEL });
            const dialog = page.locator('dialog[open]');
            await expect(dialog).toBeVisible();
            const replace = dialog.locator('.popup-button-custom', { hasText: 'Replace Existing' });
            await expect(replace).toHaveClass(/is-destructive/);
            await expect(replace).toHaveCSS('background-color', await page.evaluate(() => {
                const probe = document.createElement('span');
                probe.style.backgroundColor = 'var(--sb-color-danger)';
                document.body.append(probe);
                const color = getComputedStyle(probe).backgroundColor;
                probe.remove();
                return color;
            }));
            await expect(dialog.locator('.popup-button-ok')).not.toHaveClass(/is-destructive/);
            await expect(dialog.locator('.popup-button-ok')).toHaveText('Save');
            // The response order is the Popup's own: OK stays before Cancel in the DOM.
            const order = await dialog.evaluate(node => [...node.querySelectorAll('.popup-button-ok, .popup-button-cancel')].map(button => button.classList.contains('popup-button-ok') ? 'ok' : 'cancel'));
            expect(order).toEqual(['ok', 'cancel']);
            await page.keyboard.press('Escape');
            await context.close();
        });
    });
}
