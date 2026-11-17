import { expect, test } from '@playwright/test';
import { OPEN_ACTION_SHEET } from './helpers/action-sheet.js';
import { protectMaintainerServer } from './helpers/maintainer-server.js';
import { expectSharedDialogEntryStyles } from './helpers/dialog-entry-parity.js';
import { visiblePageClose } from './helpers/dialog-pages.js';
import { waitForAppReady } from './helpers/app-ready.js';
import { expectSortKeepsSearchDismissable } from './helpers/list-search-dismiss.js';
/* eslint-disable playwright/no-conditional-in-test, playwright/no-conditional-expect -- The viewport matrix adds mobile-only sheet gesture assertions. */

const manager = page => page.locator('#tag_view_list');
const row = (page, id) => manager(page).locator(`.tag_view_item[id="${id}"]`);
const fixtureTag = 'qa-tag-alpha';

test.beforeEach(async ({ page }) => {
    await protectMaintainerServer(page);
    const data = {
        name: 'QA tag character', description: '', personality: '', scenario: '', first_mes: 'QA', mes_example: '',
        creator_notes: '', system_prompt: '', post_history_instructions: '', alternate_greetings: [], tags: [],
        creator: '', character_version: '', extensions: { fav: false, talkativeness: 0.5 },
    };
    const character = { ...data, avatar: 'qa-tag-character.png', chat: 'qa-tag-chat', spec: 'chara_card_v2', spec_version: '2.0', data };
    await page.route('**/api/characters/all', route => route.fulfill({ json: [character] }));
    await page.route('**/api/characters/get', route => route.fulfill({ json: character }));
    await page.route('**/api/characters/chats', route => route.fulfill({ json: {} }));
    await page.route('**/api/chats/get', route => route.fulfill({ json: [] }));
    await page.route('**/api/groups/all', route => route.fulfill({ json: [] }));
    await page.route(/\/api\/(?:characters|groups|worldinfo)\/(?!all$|get$|chats$)/, route => route.fulfill({ json: {} }));
});

async function prepare(page, width) {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto('/');
    await waitForAppReady(page, { timeout: 60000 });
    await page.waitForFunction(() => !document.getElementById('preloader'));
    await page.locator('#sb-character-toggle').click();
    await page.evaluate(async () => {
        await window.SillyBunnyShell.openTab('characters', 'characters');
        const tags = await import('/scripts/tags.js');
        const app = await import('/script.js');
        const { power_user } = await import('/scripts/power-user.js');
        const state = await import('/scripts/sillybunny-character-list-state.js');
        tags.tags.splice(0, tags.tags.length,
            { id: 'qa-tag-alpha', name: 'QA Alpha', color: 'rgb(90, 160, 220)', color2: '', folder_type: 'NONE', sort_order: 0 },
            { id: 'qa-tag-beta', name: 'QA Beta', color: '', color2: '', folder_type: 'NONE', sort_order: 1 },
        );
        for (const key of Object.keys(tags.tag_map)) delete tags.tag_map[key];
        tags.tag_map['qa-tag-character.png'] = ['qa-tag-alpha'];
        power_user.bogus_folders = false;
        power_user.charListGrid = false;
        power_user.tag_sort_mode = 'manual';
        document.body.classList.remove('charListGrid');
        await state.switchCharacterListView('characters');
        for (const type of ['fav', 'folder', 'group']) app.entitiesFilter.setFilterData(type, 'UNDEFINED', true);
        app.entitiesFilter.setFilterData('tag', { selected: [], excluded: [] }, true);
        app.entitiesFilter.setFilterData('search', '', true);
        app.entitiesFilter.clearFuzzySearchCaches();
        document.getElementById('character_search_bar').value = '';
        await app.printCharacters(false);
    });
    await expect(page.locator('.sb-character-list .character_select')).toBeVisible();
}

test.describe('coarse-pointer Tag Manager close target', () => {
    test.use({ hasTouch: true });
    for (const width of [1440, 390]) {
        test(`keeps Close at 44×44 at ${width}px`, async ({ page }) => {
            await prepare(page, width);
            await openFromList(page);
            const close = await manager(page).locator('.sb-dialog__close').boundingBox();
            expect(close).toMatchObject({ width: 44, height: 44 });
        });
    }
});

test('row buttons press to their own fill and a tag with one entry keeps its number', async ({ page }) => {
    await prepare(page, 1440);
    await openFromList(page);
    const menu = row(page, fixtureTag).locator('.sb-tag-manager__row-menu');
    await expect(menu).toHaveClass(/ds-entity-row__button/);
    await expect(menu).not.toHaveClass(/menu_button/);
    const fill = () => menu.evaluate(node => getComputedStyle(node).backgroundColor);
    const rest = await fill();
    const box = await menu.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await expect.poll(fill).not.toBe(rest);
    const hovered = await fill();
    await page.mouse.down();
    await expect.poll(fill).not.toBe(hovered);
    await page.mouse.move(0, 0);
    await page.mouse.up();

    const counted = row(page, fixtureTag);
    await expect(counted.locator('.tag_view_counter_value')).toHaveText('1');
    await expect(counted.locator('.ds-entity-row__subtitle')).toHaveText(/^1\sentry$/);
    await expect(row(page, 'qa-tag-beta').locator('.tag_view_counter_value')).toHaveText('0');
    await expect(row(page, 'qa-tag-beta').locator('.ds-entity-row__subtitle')).toContainText('entries');
});

test('the row subtitle and the search placeholder take the shared muted inks, not the body ink', async ({ page }) => {
    await prepare(page, 1440);
    await openFromList(page);
    const token = name => page.evaluate(name => {
        const probe = document.createElement('i');
        probe.style.color = `var(${name})`;
        document.body.append(probe);
        const { color } = getComputedStyle(probe);
        probe.remove();
        return color;
    }, name);
    await expect(row(page, 'qa-tag-beta').locator('.ds-entity-row__subtitle')).toHaveCSS('color', await token('--sb-muted-fg'));
    await manager(page).locator('.sb-dialog__search-toggle').click();
    const search = manager(page).locator('.sb-dialog__search-input');
    await expect(search).toBeVisible();
    expect(await search.evaluate(node => getComputedStyle(node, '::placeholder').color)).toBe(await token('--sb-input-placeholder'));
});

async function openFromList(page) {
    await page.locator('.sb-character-list [data-action-id="more"]').click();
    await page.getByRole('menuitem', { name: 'Manage tags', exact: true }).click();
    await expect(manager(page)).toBeVisible();
    await manager(page).evaluate(async node => {
        await Promise.all(node.getAnimations().map(animation => animation.finished.catch(() => {})));
    });
}

async function headerMenu(page) {
    await manager(page).locator('.sb-dialog__menu').click();
    return page.locator('#sb-action-menu:visible').last();
}

/** The sort button ends the search bar, so the bar opens first. */
async function sortMenu(page) {
    // A press outside the bar closes an empty search, so a bar that is closing is waited out before it is opened again.
    const field = manager(page).locator('.sb-dialog__search');
    await expect(field).not.toHaveAttribute('data-state', 'closing');
    if (await field.getAttribute('data-state') !== 'open') await manager(page).locator('.sb-dialog__search-toggle').click();
    await manager(page).locator('.sb-tag-manager__sort').click();
    return page.locator('#sb-action-menu:visible').last();
}

for (const width of [1440, 390]) {
    test.describe(`${width}px tag manager`, () => {
        test('opens from both entry points; searches, creates, validates and reverts without keystroke saves', async ({ page }) => {
            await prepare(page, width);
            await openFromList(page);
            const endControlRights = await manager(page).locator('.sb-dialog__header-end > *').evaluateAll(nodes => nodes
                .filter(node => node.getClientRects().length > 0)
                .map(node => ({ className: node.className, right: node.getBoundingClientRect().right })));
            const closeRight = endControlRights.find(control => control.className.includes('sb-dialog__close'))?.right;
            expect(closeRight).toBe(Math.max(...endControlRights.map(control => control.right)));
            await page.screenshot({ path: test.info().outputPath(`tag-manager-${width}.png`) });
            await expect(page.locator('.sb-dialog-host:has(> #tag_view_list)')).toHaveAttribute('data-presentation', width <= 450 ? 'sheet' : 'floating');
            if (width === 1440) {
                await page.emulateMedia({ reducedMotion: 'no-preference' });
                await page.evaluate(() => document.body.classList.remove('reduced-motion'));
                expect(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches)).toBe(false);
                const hoverRow = row(page, 'qa-tag-beta');
                const backgroundBefore = await hoverRow.evaluate(node => getComputedStyle(node).backgroundColor);
                await hoverRow.hover();
                expect(await hoverRow.evaluate(node => getComputedStyle(node).backgroundColor)).not.toBe(backgroundBefore);
                expect(await hoverRow.evaluate(node => getComputedStyle(node).transitionProperty)).toContain('background-color');
                await page.emulateMedia({ reducedMotion: 'reduce' });
                expect(await hoverRow.evaluate(node => getComputedStyle(node).transitionProperty)).toBe('none');
                await page.emulateMedia({ reducedMotion: 'no-preference' });
            }
            const title = manager(page).locator('.sb-dialog__title');
            if (width === 390) {
                await expect(title).toHaveText('Tag Management');
                expect(await title.evaluate(node => node.scrollWidth)).toBeLessThanOrEqual(await title.evaluate(node => node.clientWidth));
            } else {
                const titleCenter = await title.evaluate(node => node.getBoundingClientRect().left + node.getBoundingClientRect().width / 2);
                const headerCenter = await title.evaluate(node => {
                    const { left, width: headerWidth } = node.closest('.sb-dialog__header').getBoundingClientRect();
                    return left + headerWidth / 2;
                });
                expect(Math.abs(titleCenter - headerCenter)).toBeLessThanOrEqual(1);
            }
            await manager(page).getByRole('button', { name: 'Search', exact: true }).click();
            const search = manager(page).getByRole('searchbox', { name: 'Search', exact: true });
            await expectSharedDialogEntryStyles(search);
            await page.evaluate(() => Promise.all(Array.from(document.querySelectorAll('.sb-dialog__search'), field => field.getAnimations()).flat().map(animation => animation.finished.catch(() => {}))));
            await search.fill('no-tag-matches-this');
            await expect(row(page, 'qa-tag-alpha')).toBeHidden();
            await expect(row(page, 'qa-tag-beta')).toBeHidden();
            await expect(manager(page).getByRole('heading', { name: 'No results', exact: true })).toBeVisible();
            await search.fill('Beta');
            await expect(row(page, 'qa-tag-alpha')).toBeHidden();
            await expect(row(page, 'qa-tag-beta')).toBeVisible();
            await expect(manager(page).locator('.tag_view_item:not([hidden])')).toHaveCount(1);
            await page.keyboard.press('Escape');
            await expect(search).toHaveValue('');
            await expect(search).toBeVisible();
            await page.keyboard.press('Escape');
            await expect(search).toBeHidden();
            await page.waitForFunction(() => {
                const field = document.querySelector('#tag_view_list .sb-dialog__search');
                return field?.hidden && field.getBoundingClientRect().height === 0;
            });
            const searchToggle = manager(page).getByRole('button', { name: 'Search', exact: true });
            await expect(searchToggle).toHaveAttribute('aria-expanded', 'false');
            await expect(searchToggle).not.toHaveAttribute('aria-pressed', 'true');
            await searchToggle.click();
            await expect(search).toBeVisible();
            await expect(searchToggle).toHaveAttribute('aria-expanded', 'true');
            await searchToggle.click();
            await expect(search).toBeHidden();
            await page.waitForFunction(() => {
                const field = document.querySelector('#tag_view_list .sb-dialog__search');
                return field?.hidden && field.getBoundingClientRect().height === 0;
            });
            await expect(searchToggle).toHaveAttribute('aria-expanded', 'false');
            const addTag = manager(page).getByRole('button', { name: 'Create a new tag', exact: true });
            if (width > 450) {
                await addTag.focus();
                await page.keyboard.press('Enter');
            } else {
                await addTag.click();
            }
            const create = page.locator(`.sb-custom-popover:visible, ${OPEN_ACTION_SHEET}`).getByRole('textbox', { name: 'Create a new tag', exact: true });
            await create.fill('QA New');
            const createButton = page.locator(`.sb-custom-popover:visible, ${OPEN_ACTION_SHEET}`).getByRole('button', { name: 'Create', exact: true });
            await expect(createButton).toBeEnabled();
            await create.fill('');
            await expect(createButton).toBeDisabled();
            await create.fill('QA Alpha');
            await expect(createButton).toBeDisabled();
            await create.fill('QA New');
            await expect(createButton).toBeEnabled();
            await page.mouse.move(20, 20);
            const suggestedBackground = await manager(page).evaluate(node => {
                const reference = document.createElement('button');
                reference.className = 'menu_button menu_button_primary sb-dialog__response is-suggested';
                node.append(reference);
                const background = getComputedStyle(reference).backgroundColor;
                reference.remove();
                const canvas = document.createElement('canvas');
                const context = canvas.getContext('2d');
                context.fillStyle = background;
                context.fillRect(0, 0, 1, 1);
                return [...context.getImageData(0, 0, 1, 1).data];
            });
            await expect.poll(() => createButton.evaluate(node => {
                const canvas = document.createElement('canvas');
                const context = canvas.getContext('2d');
                context.fillStyle = getComputedStyle(node).backgroundColor;
                context.fillRect(0, 0, 1, 1);
                return [...context.getImageData(0, 0, 1, 1).data];
            })).toEqual(suggestedBackground);
            await page.evaluate(() => Promise.all(Array.from(document.querySelectorAll('.sb-dialog__search'), field => field.getAnimations()).flat().map(animation => animation.finished.catch(() => {}))));
            if (width > 450) {
                const searchMetrics = await manager(page).locator('.sb-dialog__search-input').evaluate(node => {
                    const style = getComputedStyle(node);
                    return [style.height, style.paddingInline, style.borderRadius, style.backgroundColor];
                });
                const createMetrics = await create.evaluate(node => {
                    const style = getComputedStyle(node);
                    return [style.height, style.paddingInline, style.borderRadius, style.backgroundColor];
                });
                expect(createMetrics).toEqual(searchMetrics);
                expect(await create.evaluate(node => [getComputedStyle(node).outlineStyle, getComputedStyle(node).outlineWidth, getComputedStyle(node).outlineOffset])).toEqual(['solid', '2px', '-2px']);
                await page.keyboard.press('Tab');
                await expect(createButton).toBeFocused();
                await page.keyboard.press('Shift+Tab');
                await expect(create).toBeFocused();
                await page.keyboard.press('Tab');
                await page.keyboard.press('Enter');
            } else {
                await create.press('Enter');
            }
            await expect(manager(page).getByRole('textbox', { name: 'Rename', exact: true })).toHaveCount(3);
            await expect.poll(() => page.evaluate(async () => (await import('/scripts/tags.js')).tags.some(tag => tag.name === 'QA New'))).toBe(true);
            const field = row(page, fixtureTag).getByRole('textbox', { name: 'Rename', exact: true });
            await field.fill('qa beta');
            await field.press('Enter');
            await expect(field).toHaveAttribute('aria-invalid', 'true');
            await expect(row(page, fixtureTag).locator('.sb-tag-manager__error')).toHaveText('That name is already in use.');
            await manager(page).locator('.sb-dialog__close').click();
            await expect(manager(page)).toBeVisible();
            await expect(field).toBeFocused();
            if (width <= 450) {
                await manager(page).locator('.sb-dialog__menu').focus();
                await page.keyboard.press('Escape');
                await expect(manager(page)).toBeVisible();
                await expect(field).toBeFocused();
                const handle = await manager(page).locator('.sb-dialog__handle').boundingBox();
                await page.mouse.move(handle.x + handle.width / 2, handle.y + 8);
                await page.mouse.down();
                await page.mouse.move(handle.x + handle.width / 2, handle.y + 110, { steps: 4 });
                await page.mouse.up();
                await expect(manager(page)).toBeVisible();
                await expect(field).toBeFocused();
            }
            await field.press('Escape');
            await expect(field).toHaveValue('QA Alpha');
            await field.fill('QA Renamed');
            await expect.poll(() => page.evaluate(async () => (await import('/scripts/tags.js')).tags.find(tag => tag.id === 'qa-tag-alpha').name)).toBe('QA Alpha');
            await field.press('Enter');
            await expect.poll(() => page.evaluate(async () => (await import('/scripts/tags.js')).tags.find(tag => tag.id === 'qa-tag-alpha').name)).toBe('QA Renamed');
            await manager(page).locator('.sb-dialog__close').click();
            await expect(manager(page)).toHaveCount(0);
            await page.locator('.sb-character-list .sb-tag-filter-menu-button').click();
            await page.getByRole('button', { name: 'Manage tags', exact: true }).last().click();
            await expect(manager(page)).toBeVisible();
        });

        test('keeps its opened height while a search removes every row', async ({ page }) => {
            await prepare(page, width);
            await openFromList(page);
            const openedHeight = await manager(page).evaluate(node => node.getBoundingClientRect().height);
            const search = manager(page).getByRole('button', { name: 'Search', exact: true });
            await search.click();
            await manager(page).getByRole('searchbox', { name: 'Search', exact: true }).fill('no-tag-matches-this');
            await expect(manager(page).getByRole('heading', { name: 'No results', exact: true })).toBeVisible();
            const filteredHeight = await manager(page).evaluate(node => node.getBoundingClientRect().height);
            expect(filteredHeight).toBe(openedHeight);
        });

        test('tag rows open a member page with remove and add controls', async ({ page }) => {
            await prepare(page, width);
            await openFromList(page);
            const tagRow = row(page, fixtureTag);
            await tagRow.locator('.ds-entity-row__avatar').click();
            const managerWindow = page.locator('.sb-dialog-host:has(> #tag_view_list)');
            await expect(managerWindow.locator('.sb-dialog__back').last()).toBeVisible();
            await expect(await visiblePageClose(managerWindow)).toBeVisible();
            await expect(managerWindow.locator('.sb-tag-manager__members .ds-entity-row')).toHaveCount(1);
            await managerWindow.locator('.sb-tag-manager__members .sb-tag-manager__member-remove').click();
            await expect(managerWindow.locator('.sb-tag-manager__members .ds-entity-row')).toHaveCount(0);
            await managerWindow.locator('.sb-dialog__header-end').getByRole('button', { name: 'Add', exact: true }).click();
            const picker = page.locator('.sb-picker:visible, .sb-picker-sheet:visible').last();
            await picker.getByRole('option', { name: 'QA tag character', exact: true }).click();
            await expect(managerWindow.locator('.sb-tag-manager__members .ds-entity-row')).toHaveCount(1);
            await managerWindow.locator('.sb-dialog__back').last().click();
            await tagRow.focus();
            await page.keyboard.press('Space');
            await expect(managerWindow.locator('.sb-dialog__back').last()).toBeVisible();
            await (await visiblePageClose(managerWindow)).click();
            await expect(managerWindow).toHaveCount(0);
        });

        test('colour picker updates a list chip immediately, and slash-command writers refresh the open dialog', async ({ page }) => {
            await prepare(page, width);
            await openFromList(page);
            await row(page, fixtureTag).locator('.sb-tag-manager__row-menu').click();
            await expect(page.locator('#sb-action-menu:visible').getByRole('menuitem', { name: 'Text Color', exact: true })).toBeVisible();
            await page.locator('#sb-action-menu:visible [role="menuitem"]').filter({ hasText: 'Background Color' }).first().click();
            const pickerPage = page.locator('.sb-dialog-host .sb-dialog__page.sb-color-picker-dialog');
            if (width <= 450) await expect(pickerPage).toBeVisible();
            const picker = page.locator('.sb-color-picker-menu:visible');
            await expect(picker).toBeVisible();
            await expect(page.locator('toolcool-color-picker[aria-label="Background Color"]')).toBeAttached();
            const hex = picker.getByRole('textbox', { name: 'Hex', exact: true });
            await hex.fill('#22cc88');
            await hex.press('Enter');
            const token = () => page.locator('.sb-character-list .ds-tag-chips .tag[id="qa-tag-alpha"]').evaluate(node => node.style.getPropertyValue('--sb-tag-color'));
            await expect.poll(token).toMatch(/34.*204.*136/);
            const closePicker = width <= 450
                ? page.locator('.sb-dialog-host .sb-color-picker-close')
                : picker.getByRole('button', { name: 'Close', exact: true });
            await closePicker.click();
            await page.evaluate(async () => {
                const { executeSlashCommandsWithOptions } = await import('/scripts/slash-commands.js');
                await executeSlashCommandsWithOptions('/tag-add name="QA tag character" QA External');
            });
            await expect(manager(page).getByRole('textbox', { name: 'Rename', exact: true }).last()).toHaveValue('QA External');
            await expect.poll(() => page.evaluate(async () => (await import('/scripts/tags.js')).tags.some(tag => tag.name === 'QA External'))).toBe(true);
        });

        test('Most Used reorder after tag-add preserves the focused rename draft and selection without committing it', async ({ page }) => {
            await prepare(page, width);
            await page.evaluate(async () => {
                const app = await import('/script.js');
                const tags = await import('/scripts/tags.js');
                const { power_user } = await import('/scripts/power-user.js');
                app.characters.push({ ...app.characters[0], avatar: 'qa-tag-second.png', name: 'QA second character' });
                tags.tag_map['qa-tag-second.png'] = ['qa-tag-beta'];
                power_user.tag_sort_mode = 'by_entries';
            });
            await openFromList(page);
            const field = row(page, 'qa-tag-beta').getByRole('textbox', { name: 'Rename', exact: true });
            await field.fill('Unfinished rename draft');
            await field.evaluate(node => node.setSelectionRange(2, 9, 'backward'));
            await page.evaluate(async () => {
                const { executeSlashCommandsWithOptions } = await import('/scripts/slash-commands.js');
                await executeSlashCommandsWithOptions('/tag-add name="QA tag character" QA Beta');
            });
            await expect(manager(page).locator('.tag_view_item').first()).toHaveAttribute('id', 'qa-tag-beta');
            await expect(field).toHaveValue('Unfinished rename draft');
            await expect(field).toBeFocused();
            expect(await field.evaluate(node => [node.selectionStart, node.selectionEnd, node.selectionDirection])).toEqual([2, 9, 'backward']);
            expect(await page.evaluate(async () => (await import('/scripts/tags.js')).tags.find(tag => tag.id === 'qa-tag-beta').name)).toBe('QA Beta');
            await field.press('Escape');
            await expect(field).toHaveValue('QA Beta');
        });

        test('dragging an automatically sorted tag switches to manual order', async ({ page }) => {
            await prepare(page, width);
            await openFromList(page);
            const menu = await sortMenu(page);
            await menu.getByRole('menuitemradio', { name: 'Alphabetical (A-Z)', exact: true }).click();
            const grip = row(page, fixtureTag).locator('.drag-handle');
            await expect(grip).toBeVisible();
            const origin = await grip.boundingBox();
            const target = await row(page, 'qa-tag-beta').boundingBox();
            await page.mouse.move(origin.x + origin.width / 2, origin.y + origin.height / 2);
            await page.mouse.down();
            await expect(row(page, fixtureTag)).toBeVisible();
            // The sheet layout holds a drag back by 30 ms, as a touch press does. WebKit plays the whole mouse path
            // faster than that, and a release before the hold ends starts no drag.
            await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 60)));
            await page.mouse.move(origin.x + origin.width / 2, target.y + target.height - 4, { steps: 12 });
            await page.mouse.up();
            await expect.poll(() => page.evaluate(async () => (await import('/scripts/power-user.js')).power_user.tag_sort_mode)).toBe('manual');
            await expect(manager(page).locator('.tag_view_item').first()).toHaveAttribute('id', 'qa-tag-beta');
        });

        test('Delete Tag offers its merge target as a select row and merges into the tag picked there', async ({ page }) => {
            await prepare(page, width);
            await openFromList(page);
            await row(page, fixtureTag).locator('.sb-tag-manager__row-menu').click();
            await page.getByRole('menuitem', { name: 'Delete', exact: true }).click();
            const deleteDialog = page.locator('.sb-dialog-host[role="alertdialog"][open]');
            const mergeRow = deleteDialog.locator('.ds-select-row[data-sb-editor-field="merge_tag_select"]');
            const trigger = mergeRow.locator('.ds-select-row__trigger');
            const picker = page.locator(width <= 450 ? '.sb-picker-sheet' : '.sb-picker');
            await expect(mergeRow.locator('.ds-row-label')).toHaveText('Select tag to merge into');
            await expect(trigger.locator('.ds-select-row__value')).toHaveText('--- None ---');
            await expect(mergeRow.locator('#merge_tag_select')).toHaveAttribute('aria-hidden', 'true');
            await expect(deleteDialog.locator('.select2-container')).toBeHidden();
            await page.screenshot({ path: test.info().outputPath(`delete-tag-${width}.png`) });
            await trigger.click();
            await expect(picker).toBeVisible();
            await picker.getByRole('option', { name: 'QA Beta', exact: true }).click();
            await expect(picker).toBeHidden();
            await expect(deleteDialog.locator('#merge_tag_select')).toHaveValue('qa-tag-beta');
            await expect(trigger.locator('.ds-select-row__value')).toHaveText('QA Beta');
            await trigger.click();
            await picker.getByRole('option', { name: '--- None ---', exact: true }).click();
            await expect(picker).toBeHidden();
            await expect(deleteDialog.locator('#merge_tag_select')).toHaveValue('');
            await expect(trigger.locator('.ds-select-row__value')).toHaveText('--- None ---');
            await trigger.click();
            await picker.getByRole('option', { name: 'QA Beta', exact: true }).click();
            await expect(picker).toBeHidden();
            await deleteDialog.getByRole('button', { name: 'Delete', exact: true }).click();
            await expect(row(page, fixtureTag)).toHaveCount(0);
            expect(await page.evaluate(async () => (await import('/scripts/tags.js')).tag_map['qa-tag-character.png'])).toEqual(['qa-tag-beta']);
        });

        test('the search bar closes on a press outside it, also after the sort menu was used', async ({ page }) => {
            await prepare(page, width);
            await openFromList(page);
            const field = manager(page).locator('.sb-dialog__search');
            await expectSortKeepsSearchDismissable({
                page,
                reveal: () => manager(page).locator('.sb-dialog__search-toggle').click(),
                field,
                input: field.locator('.sb-dialog__search-input'),
                sort: field.locator('.sb-tag-manager__sort'),
                chooseSort: () => page.getByRole('menuitemradio', { name: 'Alphabetical (A-Z)', exact: true }).click(),
                outside: manager(page).locator('.sb-dialog__titles'),
                focusable: manager(page).locator('.sb-dialog__menu'),
            });
            await expect(field).toBeHidden();
        });

        test('header and row menus retain sort, Backup, Restore, Prune and delete/merge flows', async ({ page }) => {
            await prepare(page, width);
            await openFromList(page);
            let menu = await sortMenu(page);
            const indicator = menu.locator('[role="menuitemradio"] .sb-action-menu-indicator').first();
            const label = menu.locator('[role="menuitemradio"] .sb-action-menu-label').first();
            expect((await indicator.boundingBox()).x).toBeLessThan((await label.boundingBox()).x);
            const headingStyles = await menu.locator('.sb-action-menu-section-title').first().evaluate(node => {
                const style = getComputedStyle(node);
                return {
                    background: style.backgroundColor, radius: style.borderRadius, border: style.borderTopWidth, weight: style.fontWeight,
                    // The Label role is smaller than the rows' labels, and the start inset lines the title up with them.
                    smallerThanRows: parseFloat(style.fontSize) < parseFloat(getComputedStyle(node.closest('.sb-action-menu').querySelector('.sb-action-menu-label')).fontSize),
                    startInset: parseFloat(style.paddingInlineStart),
                };
            });
            // The theme's boxed h3 (border, fill, 10px 14px padding, title size) does not apply to a menu's section title.
            expect(headingStyles).toEqual({ background: 'rgba(0, 0, 0, 0)', radius: '0px', border: '0px', weight: '700', smallerThanRows: true, startInset: 32 });
            await expect(menu.getByRole('menuitemcheckbox', { name: 'Tags as Folders', exact: true })).toHaveCount(0);
            await expect(row(page, fixtureTag).locator('.sb-tag-manager__folder')).toHaveCount(0);
            await page.keyboard.press('Escape');
            menu = await headerMenu(page);
            await expect(menu.getByRole('menuitemradio')).toHaveCount(0);
            await expect(menu.getByRole('menuitem', { name: 'Select', exact: true })).toBeVisible();
            await page.keyboard.press('Escape');
            menu = await sortMenu(page);
            await menu.getByRole('menuitemradio', { name: 'Alphabetical (A-Z)', exact: true }).click();
            await expect(manager(page).locator('.sb-tag-manager__sort')).toHaveAttribute('aria-pressed', 'true');
            await row(page, fixtureTag).locator('.sb-tag-manager__row-menu').click();
            await expect(page.getByRole('menuitem', { name: /^Move / })).toHaveCount(0);
            await page.keyboard.press('Escape');
            menu = await headerMenu(page);
            const download = page.waitForEvent('download');
            await menu.getByRole('menuitem', { name: 'Backup', exact: true }).click();
            await (await download).cancel();
            menu = await headerMenu(page);
            const choose = page.waitForEvent('filechooser');
            await menu.getByRole('menuitem', { name: 'Restore', exact: true }).click();
            await (await choose).setFiles({ name: 'qa-tags.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ tags: [], tag_map: {} })) });
            const restore = page.locator('dialog.popup:visible').last();
            await expect(restore).toContainText('You have existing tags');
            await page.keyboard.press('Escape');
            menu = await headerMenu(page);
            await menu.getByRole('menuitem', { name: 'Prune', exact: true }).click();
            const prune = page.locator('dialog.popup:visible').last();
            await expect(prune).toContainText('Are you sure you want to remove all unused tags');
            await page.keyboard.press('Escape');
            await row(page, fixtureTag).locator('.sb-tag-manager__row-menu').click();
            await page.getByRole('menuitem', { name: 'Delete', exact: true }).click();
            const deleteDialog = page.locator('.sb-dialog-host[role="alertdialog"][open]');
            await expect(deleteDialog.locator('#merge_tag_select')).toBeAttached();
            await expect(deleteDialog.locator(':is(h1, h2, h3, h4, h5, h6)')).toHaveCount(1);
            await expect(deleteDialog.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
            await page.keyboard.press('Enter');
            await expect(deleteDialog).toHaveCount(0);
            await expect(row(page, fixtureTag)).toBeVisible();
        });
    });
}

test.describe('selection mode', () => {
    for (const width of [1440, 390]) {
        test(`selects tags, keeps the rows' own controls out of use and deletes the selection at ${width}px`, async ({ page }) => {
            await prepare(page, width);
            await openFromList(page);
            const menu = await headerMenu(page);
            await menu.getByRole('menuitem', { name: 'Select', exact: true }).click();
            await expect(manager(page).locator('.sb-dialog__selection-cancel')).toBeVisible();
            await expect(row(page, fixtureTag).locator('.drag-handle')).toBeHidden();
            await expect(row(page, fixtureTag).locator('.sb-tag-manager__row-menu')).toBeHidden();
            await expect(row(page, fixtureTag).locator('input.sb-tag-manager__name')).toHaveJSProperty('inert', true);
            const bar = manager(page).locator('.sb-tag-manager__selection-bar');
            await row(page, fixtureTag).locator('.sb-selection-check').click();
            await expect(bar.locator('[data-action-id="delete"]')).toBeVisible();
            await expect(bar.locator('[data-action-id]')).toHaveCount(1);
            await bar.locator('[data-action-id="delete"]').click();
            const confirm = page.locator('dialog.popup.sb-popup-destructive-confirm:visible');
            await expect(confirm).toBeVisible();
            await confirm.getByRole('button', { name: 'Cancel', exact: true }).click();
            await expect(confirm).toHaveCount(0);
            await expect(row(page, fixtureTag)).toBeVisible();
            await bar.locator('[data-action-id="delete"]').click();
            await page.locator('dialog.popup.sb-popup-destructive-confirm:visible').getByRole('button', { name: 'Delete', exact: true }).click();
            await expect(row(page, fixtureTag)).toHaveCount(0);
            await expect(row(page, 'qa-tag-beta')).toBeVisible();
            await expect(manager(page).locator('.sb-dialog__selection-cancel')).toHaveCount(0);
            expect(await page.evaluate(async () => {
                const tags = await import('/scripts/tags.js');
                return { ids: tags.tags.map(tag => tag.id), mapped: tags.tag_map['qa-tag-character.png'] };
            })).toEqual({ ids: ['qa-tag-beta'], mapped: [] });
        });
    }
});

test('desktop Create a new tag trigger closes its open popover on repeat activation', async ({ page }) => {
    await prepare(page, 1440);
    await openFromList(page);
    const addTag = manager(page).getByRole('button', { name: 'Create a new tag', exact: true });
    await addTag.click();
    const popover = page.locator('.sb-custom-popover:visible');
    await expect(popover).toBeVisible();
    await expect(addTag).toHaveAttribute('aria-expanded', 'true');
    await addTag.click();
    await expect(popover).toHaveCount(0);
    await expect(addTag).toHaveAttribute('aria-expanded', 'false');
});

test('tag import custom responses stay visible and return their mapped command results', async ({ page }) => {
    await prepare(page, 390);
    await page.evaluate(async () => {
        const app = await import('/script.js');
        app.characters[0].tags = ['QA Beta', 'QA New'];
    });

    const runImport = page.evaluate(async () => {
        const { executeSlashCommandsWithOptions } = await import('/scripts/slash-commands.js');
        return (await executeSlashCommandsWithOptions('/tag-import name="QA tag character" mode=ask')).pipe;
    });
    const popup = page.locator('dialog[open]').last();
    await expect(popup.locator('.popup-button-custom')).toHaveText(['Import None', 'Import All', 'Import Existing']);
    await popup.locator('.popup-button-custom').filter({ hasText: 'Import None' }).click();
    expect(await runImport).toBe('false');

    await page.evaluate(async () => {
        const app = await import('/script.js');
        app.characters[0].tags = ['QA Beta', 'QA New'];
    });
    const existingImport = page.evaluate(async () => {
        const { executeSlashCommandsWithOptions } = await import('/scripts/slash-commands.js');
        return (await executeSlashCommandsWithOptions('/tag-import name="QA tag character" mode=ask')).pipe;
    });
    const existingPopup = page.locator('dialog[open]').last();
    await expect(existingPopup.locator('.popup-button-custom')).toHaveText(['Import None', 'Import All', 'Import Existing']);
    await existingPopup.locator('.popup-button-custom').filter({ hasText: 'Import Existing' }).click();
    expect(await existingImport).toBe('true');
    await expect.poll(() => page.evaluate(async () => (await import('/scripts/tags.js')).tag_map['qa-tag-character.png'])).toContain('qa-tag-beta');
});

for (const width of [1440, 768, 390]) {
    test(`${width}px tag surface stays framed and contained in both bundled themes`, async ({ page }) => {
        await prepare(page, width);
        await openFromList(page);
        for (const theme of ['Libadwaita', 'Libadwaita Light']) {
            await page.evaluate(theme => window.$('#themes').val(theme).trigger('change'), theme);
            await expect(row(page, fixtureTag)).toBeVisible();
            const bounds = await manager(page).boundingBox();
            expect(bounds.x).toBeGreaterThanOrEqual(0);
            expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
            const styles = await manager(page).evaluate(node => {
                const computed = getComputedStyle(node);
                const header = getComputedStyle(node.querySelector('header'));
                const row = node.querySelector('.tag_view_item');
                const name = row.querySelector('.sb-tag-manager__name');
                const subtitle = row.querySelector('.ds-entity-row__subtitle');
                const input = getComputedStyle(name);
                const box = getComputedStyle(node.querySelector('.sb-tag-manager__list'));
                return {
                    border: computed.borderTopWidth, background: computed.backgroundColor, header: header.backgroundColor,
                    nameX: name.getBoundingClientRect().x + parseFloat(input.paddingLeft) + parseFloat(input.borderLeftWidth),
                    subtitleX: subtitle.getBoundingClientRect().x,
                    weight: input.fontWeight, size: input.fontSize, subtitleSize: getComputedStyle(subtitle).fontSize,
                    rowPadding: getComputedStyle(row).padding, gap: getComputedStyle(row).gap, boxBorder: box.borderTopColor, boxBackground: box.backgroundColor,
                };
            });
            expect(styles.border).toBe('1px');
            expect(styles.background).not.toBe('rgba(0, 0, 0, 0)');
            expect(styles.header).not.toBe('rgba(0, 0, 0, 0)');
            expect(styles.nameX).toBe(styles.subtitleX);
            expect(styles.weight).toBe('400');
            await page.screenshot({ path: test.info().outputPath(`tag-manager-${width}-${theme.replaceAll(' ', '-')}.png`) });
            await manager(page).locator('.sb-dialog__close').click();
            await expect(manager(page)).toHaveCount(0);
            await page.evaluate(() => window.SillyBunnyShell.openTab('characters', 'persona'));
            const persona = page.locator('.sb-persona-list-box .ds-entity-row').first();
            await expect(persona).toBeVisible();
            const personaMetrics = await persona.evaluate(node => ({
                padding: getComputedStyle(node).padding, gap: getComputedStyle(node).gap,
                weight: getComputedStyle(node.querySelector('.ds-entity-row__title')).fontWeight,
                size: getComputedStyle(node.querySelector('.ds-entity-row__title')).fontSize,
                subtitleSize: getComputedStyle(node.querySelector('.ds-entity-row__subtitle')).fontSize,
            }));
            expect(styles.rowPadding).toBe('6px 12px');
            expect([styles.gap, styles.weight, styles.size, styles.subtitleSize]).toEqual([
                personaMetrics.gap, personaMetrics.weight, personaMetrics.size, personaMetrics.subtitleSize,
            ]);
            await page.evaluate(() => window.SillyBunnyShell.openTab('characters', 'world-info'));
            const wiBox = page.locator('.sb-wi-list-box');
            // The book list is hidden until a book is selected; its resolved frame tokens still apply.
            await expect(wiBox).toBeAttached();
            // The book list is the shared entity box now (no border of its own, the card shadow instead), so only its fill is shared.
            const wiFrame = await wiBox.evaluate(node => ({ border: getComputedStyle(node).borderTopWidth, background: getComputedStyle(node).backgroundColor }));
            expect(wiFrame.border).toBe('0px');
            expect(styles.boxBackground).toBe(wiFrame.background);
            await page.evaluate(() => window.SillyBunnyShell.openTab('characters', 'characters'));
            await openFromList(page);
        }
    });
}
