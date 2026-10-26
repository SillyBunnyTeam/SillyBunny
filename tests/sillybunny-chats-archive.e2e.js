import { expect, test } from '@playwright/test';
import {
    FIRST_ORPHAN_HASH,
    FIRST_READ_TOKEN,
    ORPHAN_CURSOR,
    SECOND_ORPHAN_HASH,
    SECOND_READ_TOKEN,
    ARCHIVE_CURSOR,
    SEARCH_CONTENT_DEBOUNCE_MS,
    archivePage,
    bootArchive,
    bigFixture,
    chatBody,
    chatKey,
    dialog,
    drawerButton,
    emptyOrganization,
    expectCleanLayout,
    isCollapsed,
    filenames,
    filterCheck,
    fulfillJson,
    goBack,
    HOST_AVATAR,
    linkedRow,
    longChat,
    openArchive,
    openFilters,
    openMenu,
    openMenuItem,
    openRow,
    openSearch,
    orphanRow,
    rows,
    search,
    searchedScopes,
    selectionTitle,
    shot,
    showCharacterList,
    showList,
    waitForDetail,
} from './helpers/chats-archive.js';
import { showToasts } from './helpers/maintainer-server.js';

const WIDE = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };

const ALICE = [{ name: 'Alice', avatar: 'Alice.png' }];

function small(names, { organization = null, orphans = [], characters = ALICE, groups = [] } = {}) {
    return {
        rows: names.map(name => (typeof name === 'string' ? linkedRow(name) : name)),
        orphans,
        organization,
        characters,
        groups,
    };
}

const sectionNamed = (page, heading) => page.locator('.sbca-organization-content section').filter({ has: page.getByRole('heading', { name: heading }) });
const alert = (page, text) => page.getByRole('alert').filter({ hasText: text });

test.describe('on a touch phone', () => {
    test.use({ hasTouch: true, isMobile: true });

    // The Characters list shell shows extension buttons as icons, so the accessible name and tooltip carry the label.
    test('the drawer button is an icon-only 44px touch target whose name and tooltip are its full label', async ({ page }) => {
        await bootArchive(page, PHONE, { fixture: small([]) });
        await showCharacterList(page);
        await expect(drawerButton(page)).toHaveAttribute('aria-haspopup', 'dialog');
        await expect(drawerButton(page)).toHaveAttribute('aria-label', 'Chat Archive');
        await expect(drawerButton(page)).toHaveAttribute('title', 'Chat Archive');
        await expect(page.getByRole('button', { name: 'Chat Archive', exact: true })).toBeVisible();

        const control = await drawerButton(page).evaluate(button => {
            const rect = button.getBoundingClientRect();
            const icon = button.querySelector('i').getBoundingClientRect();
            const label = button.querySelector('.sbca-drawer-button-label');
            return {
                height: rect.height,
                width: rect.width,
                visibility: getComputedStyle(button).visibility,
                iconWidth: icon.width,
                iconHeight: icon.height,
                labelDisplay: getComputedStyle(label).display,
                labelBoxes: label.getClientRects().length,
            };
        });
        expect(control.labelDisplay).toBe('none');
        expect(control.labelBoxes).toBe(0);
        expect(control.visibility).toBe('visible');
        expect(control.height).toBeGreaterThanOrEqual(44);
        expect(control.width).toBeGreaterThanOrEqual(44);
        expect(control.iconWidth).toBeGreaterThan(0);
        expect(control.iconHeight).toBeGreaterThan(0);
    });

    test('on a phone the archive is a sheet inside the viewport with a 44 by 44 Close', async ({ page }) => {
        await bootArchive(page, PHONE, { fixture: small(['a-long-chat-name-that-must-wrap-without-widening-the-frame']) });
        await openArchive(page);
        await showList(page);
        const close = await page.locator('.sbca-dialog .sb-dialog__close:visible').last().boundingBox();
        expect(close.width).toBeGreaterThanOrEqual(44);
        expect(close.height).toBeGreaterThanOrEqual(44);
        for (const control of ['.sbca-filters-button', '.sbca-view-button']) {
            const box = await page.locator(`.sbca-dialog ${control}:visible`).first().boundingBox();
            expect(box.width).toBeGreaterThanOrEqual(44);
            expect(box.height).toBeGreaterThanOrEqual(44);
        }
        await expectCleanLayout(page, 'phone list');
        const overflow = await dialog(page).evaluate(surface => surface.scrollWidth - surface.clientWidth);
        expect(overflow).toBeLessThanOrEqual(0);
        await page.locator('.sbca-dialog .sb-dialog__close:visible').last().click();
        await expect(dialog(page)).toHaveCount(0);
        await expect(drawerButton(page)).toBeFocused();
    });
});

test('the tablet frame stays bounded and the page does not scroll sideways', async ({ page }) => {
    await bootArchive(page, { width: 820, height: 740 }, { fixture: small(['tablet-chat']) });
    await page.locator('body').evaluate(body => body.classList.add('safari'));
    await openArchive(page);
    await showList(page);
    await expectCleanLayout(page, 'tablet');
    const layout = await dialog(page).evaluate(surface => ({
        height: surface.getBoundingClientRect().height,
        overflow: surface.scrollWidth - surface.clientWidth,
        pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    }));
    expect(layout.height).toBeLessThanOrEqual(740);
    expect(layout.overflow).toBeLessThanOrEqual(0);
    expect(layout.pageOverflow).toBeLessThanOrEqual(0);
});

test('closing returns the focus to the drawer button and releases the read session', async ({ page }) => {
    const archive = await bootArchive(page, WIDE, { fixture: small(['closing-chat']) });
    await openArchive(page);
    await page.keyboard.press('Escape');
    await expect(dialog(page)).toHaveCount(0);
    await expect(drawerButton(page)).toBeFocused();
    expect(archive.dataMaid).toEqual([]);
});

test('Filters keep favourites listed when their chat type is off, and the sidebar Favorites location agrees', async ({ page }) => {
    await bootArchive(page, WIDE, {
        fixture: small(['favorite-chat', 'ordinary-chat'], {
            organization: emptyOrganization({ chats: { [chatKey('Alice', 'favorite-chat')]: { favorite: true } } }),
        }),
    });
    await openArchive(page);
    await showList(page);
    await expect(filenames(page)).toHaveText(['favorite-chat', 'ordinary-chat']);
    await expect(rows(page).filter({ hasText: 'favorite-chat' })).toHaveAttribute('aria-label', /^favorite-chat, .+, Favorite$/);
    await expect(rows(page).filter({ hasText: 'ordinary-chat' })).not.toHaveAttribute('aria-label', /Favorite/);
    const filtersButton = page.locator('.sbca-dialog .sbca-filters-button:visible').first();
    const expectFiltersDescribed = async () => {
        await expect(filtersButton).toHaveAttribute('aria-haspopup', 'dialog');
        await expect(filtersButton).not.toHaveAttribute('aria-pressed');
        await expect(filtersButton).toHaveAttribute('aria-describedby', /^sbca_filters_description_/);
        await expect(filtersButton).toHaveAccessibleDescription('Filters are active');
    };
    const expectFiltersNotDescribed = async () => {
        await expect(filtersButton).toHaveAttribute('aria-haspopup', 'dialog');
        await expect(filtersButton).not.toHaveAttribute('aria-pressed');
        await expect(filtersButton).not.toHaveAttribute('aria-describedby');
    };
    await expectFiltersNotDescribed();

    await openFilters(page);
    await expect(filterCheck(page, 'Favorites')).toBeChecked();
    await filterCheck(page, 'Favorites').uncheck();
    await expect(filenames(page)).toHaveText(['ordinary-chat']);
    await expectFiltersDescribed();
    await filterCheck(page, 'Favorites').check();
    await expect(filenames(page)).toHaveText(['favorite-chat', 'ordinary-chat']);
    await expectFiltersNotDescribed();

    await filterCheck(page, 'Characters').uncheck();
    await expect(filenames(page)).toHaveText(['favorite-chat']);
    await filterCheck(page, 'Favorites').uncheck();
    await expect(filenames(page)).toHaveCount(0);
    await expect(page.getByText('No chats match these filters.')).toBeVisible();
    await filterCheck(page, 'Favorites').check();
    await expect(filenames(page)).toHaveText(['favorite-chat']);
    await filterCheck(page, 'Characters').check();
    await expect(filenames(page)).toHaveText(['favorite-chat', 'ordinary-chat']);

    await filterCheck(page, 'Favorites').uncheck();
    await page.locator('.sbca-filters').getByRole('button', { name: 'Reset' }).click();
    await expect(filterCheck(page, 'Favorites')).toBeChecked();
    await expect(filenames(page)).toHaveText(['favorite-chat', 'ordinary-chat']);
    await expectFiltersNotDescribed();
    await page.keyboard.press('Escape');

    await page.locator('.sbca-location', { hasText: 'Favorites' }).click();
    await expect(filenames(page)).toHaveText(['favorite-chat']);
    await openFilters(page);
    await filterCheck(page, 'Characters').uncheck();
    await expect(filenames(page)).toHaveText(['favorite-chat']);
    await expect(page.locator('.sbca-location', { hasText: 'Favorites' })).toHaveAttribute('aria-pressed', 'true');
});

test('closing the archive with a Filters edit still waiting on its debounce saves it, and nothing is saved afterwards', async ({ page }) => {
    const archive = await bootArchive(page, WIDE, { fixture: small(['tagged-chat'], { organization: emptyOrganization() }) });
    await openArchive(page);
    await showList(page);
    await openFilters(page);
    await page.evaluate(async () => {
        const tag = document.querySelector('.sbca-filters input[placeholder="Tag"]');
        tag.value = 'late';
        tag.dispatchEvent(new Event('input', { bubbles: true }));
        const { closeArchive } = await import('/scripts/extensions/sillybunny-chats-archive/src/ui.js');
        await closeArchive();
    });
    await expect(dialog(page)).toHaveCount(0);
    expect(archive.uploads.at(-1)?.lastView?.tag).toBe('late');
    const saved = archive.uploads.length;
    await page.evaluate(ms => new Promise(resolve => setTimeout(resolve, ms)), SEARCH_CONTENT_DEBOUNCE_MS * 2);
    expect(archive.uploads).toHaveLength(saved);
});

test('a chat type that is switched off removes its sidebar section, and a hidden location falls back to All Chats', async ({ page }) => {
    await bootArchive(page, WIDE, { fixture: bigFixture() });
    await openArchive(page);
    await showList(page);
    await expect(page.getByRole('group', { name: 'Characters' })).toBeVisible();
    await expect(page.getByRole('group', { name: 'Orphaned' })).toHaveCount(0);
    await page.locator('.sbca-location', { hasText: 'Alice' }).first().click();
    await expect(page.locator('.sbca-location', { hasText: 'Alice' }).first()).toHaveAttribute('aria-pressed', 'true');
    await openFilters(page);
    await filterCheck(page, 'Characters').uncheck();
    await expect(page.getByRole('group', { name: 'Characters' })).toHaveCount(0);
    await expect(page.getByRole('group', { name: 'Groups' })).toBeVisible();
    await expect(page.locator('.sbca-location[aria-pressed="true"]')).toHaveCount(1);
    await expect(page.locator('.sbca-location[aria-pressed="true"]').first()).not.toContainText('Alice');
});

test('date, size and message bounds narrow the list', async ({ page }) => {
    await bootArchive(page, WIDE, {
        fixture: small([
            linkedRow('january-chat', { mtime: Date.UTC(2026, 0, 10, 12), count: 2, size: '1 KB' }),
            linkedRow('june-chat', { mtime: Date.UTC(2026, 5, 10, 12), count: 40, size: '3 MB' }),
        ]),
    });
    await openArchive(page);
    await showList(page);
    await openFilters(page);
    const from = page.getByLabel('From Date');
    const to = page.getByLabel('To Date');
    await from.fill('2026-03-01');
    await expect(filenames(page)).toHaveText(['june-chat']);
    await from.fill('');
    await to.fill('2026-02-01');
    await expect(filenames(page)).toHaveText(['january-chat']);
    await to.fill('');
    await expect(filenames(page)).toHaveCount(2);

    const numbers = page.locator('.sbca-filters .sbca-filter-input[type="number"]');
    await expect(numbers).toHaveCount(4);
    const numberLabels = ['Minimum Size (MiB)', 'Maximum Size (MiB)', 'Minimum Messages', 'Maximum Messages'];
    for (const [index, label] of numberLabels.entries()) {
        await expect(numbers.nth(index)).toHaveAccessibleName(label);
        await expect(page.locator('.sbca-filters .ds-row-label').filter({ hasText: label })).toHaveCount(1);
    }
    await numbers.nth(2).fill('10');
    await expect(filenames(page)).toHaveText(['june-chat']);
    await numbers.nth(2).fill('');
    await numbers.nth(1).fill('1');
    await expect(filenames(page)).toHaveText(['january-chat']);
    await numbers.nth(1).fill('');
    await numbers.nth(0).fill('2');
    await expect(filenames(page)).toHaveText(['june-chat']);
    await page.locator('.sbca-filters').getByRole('button', { name: 'Reset' }).click();
    await expect(filenames(page)).toHaveCount(2);
    await expect(from).toHaveValue('');
    await expect(numbers.nth(0)).toHaveValue('');
});

test('the View menu offers nine sorts and each one reorders the list', async ({ page }) => {
    const names = [
        ['b-middle', { mtime: 2_000, size: '20 KB', count: 20 }],
        ['a-first', { mtime: 3_000, size: '10 KB', count: 30 }],
        ['c-last', { mtime: 1_000, size: '30 KB', count: 10 }],
    ];
    await bootArchive(page, WIDE, { fixture: small(names.map(([name, options]) => linkedRow(name, options))) });
    await openArchive(page);
    await showList(page);
    const expected = {
        recent: ['a-first', 'b-middle', 'c-last'],
        oldest: ['c-last', 'b-middle', 'a-first'],
        size: ['c-last', 'b-middle', 'a-first'],
        smallest: ['a-first', 'b-middle', 'c-last'],
        count: ['a-first', 'b-middle', 'c-last'],
        fewest: ['c-last', 'b-middle', 'a-first'],
        name: ['a-first', 'b-middle', 'c-last'],
        'name-reverse': ['c-last', 'b-middle', 'a-first'],
        owner: ['a-first', 'b-middle', 'c-last'],
    };
    const view = page.locator('.sbca-dialog .sbca-view-button:visible').first();
    await view.click();
    const radios = page.getByRole('menuitemradio');
    await expect(radios).toHaveCount(9);
    await expect(radios).toHaveText(['Recent', 'Oldest', 'Largest', 'Smallest', 'Most Messages', 'Fewest Messages', 'A-Z', 'Z-A', 'Owner']);
    await expect(radios.nth(0)).toHaveAttribute('aria-checked', 'true');
    await page.keyboard.press('Escape');
    let index = 0;
    for (const [key, order] of Object.entries(expected)) {
        await view.click();
        await page.getByRole('menuitemradio').nth(index).click();
        await expect(filenames(page), `sort ${key}`).toHaveText(order);
        index += 1;
    }
    await view.click();
    await expect(page.getByRole('menuitemradio').nth(8)).toHaveAttribute('aria-checked', 'true');
});

test('a failed organization load is explained in Manage Organization only, and Retry recovers', async ({ page }) => {
    let healthy = false;
    await bootArchive(page, WIDE, { fixture: small(['organization-error-chat']) });
    await page.route('**/user/files/_sbca_organization.json', route => (healthy ? route.fallback() : route.fulfill({ status: 503 })));
    await openArchive(page);
    const message = page.getByText('Organization could not be loaded. Retry or import a backup.');
    await expect(message).toHaveCount(0);
    await openMenuItem(page, 'Manage Organization');
    await expect(message).toBeVisible();
    await expect(message).toHaveCount(1);
    const retry = sectionNamed(page, 'Organization Backup').getByRole('button', { name: 'Retry' });
    await expect(retry).toBeVisible();
    await expect(sectionNamed(page, 'Folders').getByRole('button', { name: 'Create' })).toBeDisabled();
    await expect(sectionNamed(page, 'Organization Backup').getByRole('button', { name: 'Export Organization' })).toBeDisabled();

    healthy = true;
    await retry.click();
    await expect(message).toHaveCount(0);
    await expect(retry).toBeHidden();
    await expect(sectionNamed(page, 'Folders').getByRole('button', { name: 'Create' })).toBeEnabled();
});

async function delayedOrganization(page) {
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    await bootArchive(page, WIDE, {
        fixture: small(['delayed-organization-chat'], {
            organization: emptyOrganization({ chats: { [chatKey('Alice', 'delayed-organization-chat')]: { favorite: true } } }),
        }),
    });
    await page.route('**/user/files/_sbca_organization.json', async route => {
        await gate;
        return route.fallback();
    });
    return release;
}

const delayedChat = page => filenames(page).filter({ hasText: 'delayed-organization-chat' });
const favoriteAction = page => page.locator('.sbca-viewer-content').getByRole('button', { name: 'Favorite', exact: true });

test('an open chat shows its loaded Favorite state as soon as the organization arrives', async ({ page }) => {
    const release = await delayedOrganization(page);
    await openArchive(page);
    await showList(page);
    await openRow(page, 'delayed-organization-chat');
    await expect(favoriteAction(page)).toBeDisabled();
    await expect(favoriteAction(page)).toHaveAttribute('aria-pressed', 'false');
    release();
    await expect(favoriteAction(page)).toBeEnabled();
    await expect(favoriteAction(page)).toHaveAttribute('aria-pressed', 'true');
});

test('the Favorites filter ignores favourites until the organization loads, then applies them', async ({ page }) => {
    const release = await delayedOrganization(page);
    await openArchive(page);
    await showList(page);
    await openFilters(page);
    await filterCheck(page, 'Favorites').uncheck();
    await expect(delayedChat(page)).toBeVisible();
    release();
    await expect(delayedChat(page)).toHaveCount(0);
    await filterCheck(page, 'Favorites').check();
    await expect(delayedChat(page)).toBeVisible();
    await page.keyboard.press('Escape');
    await openRow(page, 'delayed-organization-chat');
    await expect(favoriteAction(page)).toBeEnabled();
    await expect(favoriteAction(page)).toHaveAttribute('aria-pressed', 'true');
});

test('organization changes are saved, a failed save is explained, and Retry keeps the change', async ({ page }) => {
    let failing = true;
    const archive = await bootArchive(page, WIDE, { fixture: small(['save-chat'], { organization: emptyOrganization() }) });
    await page.route('**/api/files/upload', route => (failing ? route.fulfill({ status: 500, body: 'disk full' }) : route.fallback()));
    await openArchive(page);
    await openMenuItem(page, 'Manage Organization');
    const folders = sectionNamed(page, 'Folders');
    await folders.getByRole('textbox', { name: 'Folder Name' }).fill('Kept');
    await folders.getByRole('button', { name: 'Create' }).click();
    await expect(folders.getByText('Kept', { exact: true })).toBeVisible();
    const backup = sectionNamed(page, 'Organization Backup');
    await expect(backup).toContainText('Organization changes could not be saved. Retry to keep these changes.');
    expect(archive.uploads).toHaveLength(0);

    failing = false;
    await backup.getByRole('button', { name: 'Retry' }).click();
    await expect.poll(() => archive.uploads.at(-1)?.folders?.map(folder => folder.name)).toEqual(['Kept']);
    await expect(backup).not.toContainText('could not be saved');
    await expect(backup.getByRole('button', { name: 'Retry' })).toBeHidden();
});

test('Manage Organization validates names, edits one row at a time, and confirms destructive deletes', async ({ page }) => {
    const archive = await bootArchive(page, WIDE, {
        fixture: small(['managed-chat'], {
            organization: emptyOrganization({
                views: [{ id: 'v1', name: 'Saved view', view: {} }],
                folders: [{ id: 'f1', name: 'Roleplay' }, { id: 'f2', name: 'Archive' }],
                collections: [{ id: 'c1', name: 'Slow burn' }],
                chats: { [chatKey('Alice', 'managed-chat')]: { folder: 'f1', collections: ['c1'] } },
            }),
        }),
    });
    await openArchive(page);
    await openMenuItem(page, 'Manage Organization');
    const folders = sectionNamed(page, 'Folders');
    const createName = folders.getByRole('textbox', { name: 'Folder Name' });
    await createName.fill('   ');
    await folders.getByRole('button', { name: 'Create' }).click();
    await expect(alert(page, 'Enter a name.')).toBeVisible();
    await createName.fill('roleplay');
    await folders.getByRole('button', { name: 'Create' }).click();
    await expect(alert(page, 'That name is already in use.')).toBeVisible();
    await createName.fill('Brand new');
    await createName.press('Enter');
    await expect.poll(() => archive.uploads.at(-1)?.folders?.map(folder => folder.name)).toEqual(['Roleplay', 'Archive', 'Brand new']);
    await expect(createName).toHaveValue('');

    await folders.getByRole('button', { name: 'Rename Roleplay' }).click();
    const editor = folders.getByRole('textbox', { name: 'Rename Roleplay' });
    await expect(editor).toBeFocused();
    await expect(folders.getByRole('textbox', { name: /^Rename/ })).toHaveCount(1);
    await sectionNamed(page, 'Collections').getByRole('button', { name: 'Rename Slow burn' }).click();
    await expect(page.getByRole('textbox', { name: /^Rename/ })).toHaveCount(1);
    await expect(page.getByRole('textbox', { name: 'Rename Slow burn' })).toBeFocused();
    await sectionNamed(page, 'Collections').getByRole('button', { name: 'Cancel' }).click();
    await expect(sectionNamed(page, 'Collections').getByRole('button', { name: 'Rename Slow burn' })).toBeFocused();

    await folders.getByRole('button', { name: 'Rename Roleplay' }).click();
    await folders.getByRole('textbox', { name: 'Rename Roleplay' }).fill('Archive');
    await folders.getByRole('button', { name: 'Rename Roleplay' }).click();
    await expect(alert(page, 'That name is already in use.')).toBeVisible();
    await expect(folders.getByRole('textbox', { name: 'Rename Roleplay' })).toHaveValue('Archive');
    await folders.getByRole('textbox', { name: 'Rename Roleplay' }).press('Escape');
    await expect(folders.getByRole('button', { name: 'Rename Roleplay' })).toBeFocused();
    await expect(folders.getByText('Roleplay', { exact: true })).toBeVisible();
    await expect(page.locator('.sbca-organization-page')).toBeVisible();

    await folders.getByRole('button', { name: 'Rename Roleplay' }).click();
    await folders.getByRole('textbox', { name: 'Rename Roleplay' }).fill('Renamed');
    await folders.getByRole('textbox', { name: 'Rename Roleplay' }).press('Enter');
    await expect.poll(() => archive.uploads.at(-1)?.folders?.map(folder => folder.name)).toEqual(['Renamed', 'Archive', 'Brand new']);
    await expect(folders.getByRole('button', { name: 'Rename Renamed' })).toBeFocused();

    // A folder that chats use asks first; Cancel changes nothing, Delete removes it from the chats too.
    const uploadsBefore = archive.uploads.length;
    await folders.getByRole('button', { name: 'Delete Renamed' }).click();
    await expect(page.getByRole('alertdialog')).toContainText('Delete Renamed and remove it from chats and saved views?');
    await page.getByRole('alertdialog').getByRole('button', { name: 'Cancel' }).click();
    expect(archive.uploads).toHaveLength(uploadsBefore);
    await folders.getByRole('button', { name: 'Delete Renamed' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Delete' }).click();
    await expect.poll(() => archive.uploads.at(-1)?.folders?.map(folder => folder.name)).toEqual(['Archive', 'Brand new']);
    expect(archive.uploads.at(-1).chats[chatKey('Alice', 'managed-chat')]).toEqual({ collections: ['c1'] });

    // An unused folder is deleted without asking; a saved view always asks.
    await folders.getByRole('button', { name: 'Delete Brand new' }).click();
    await expect.poll(() => archive.uploads.at(-1)?.folders?.map(folder => folder.name)).toEqual(['Archive']);
    await sectionNamed(page, 'Saved Views').getByRole('button', { name: 'Delete Saved view' }).click();
    await expect(page.getByRole('alertdialog')).toContainText('Delete saved view Saved view?');
    await page.getByRole('alertdialog').getByRole('button', { name: 'Delete' }).click();
    await expect.poll(() => archive.uploads.at(-1)?.views).toEqual([]);
    await expect(sectionNamed(page, 'Saved Views').getByText('None yet.')).toBeVisible();
});

test('organization backups export, reject bad files, and replace only after a confirmation', async ({ page }) => {
    const organization = emptyOrganization({ folders: [{ id: 'f1', name: 'Roleplay' }] });
    const archive = await bootArchive(page, WIDE, { fixture: small(['backup-chat'], { organization }) });
    await showToasts(page);
    await openArchive(page);
    await openMenuItem(page, 'Manage Organization');
    const backup = sectionNamed(page, 'Organization Backup');

    const [download] = await Promise.all([
        page.waitForEvent('download'),
        backup.getByRole('button', { name: 'Export Organization' }).click(),
    ]);
    expect(download.suggestedFilename()).toBe('_sbca_organization.json');
    const exported = JSON.parse(await (await import('node:fs/promises')).readFile(await download.path(), 'utf8'));
    expect(exported.folders).toEqual([{ id: 'f1', name: 'Roleplay' }]);

    const file = page.locator('.sbca-organization-content input[type="file"]');
    await file.setInputFiles({ name: 'broken.json', mimeType: 'application/json', buffer: Buffer.from('{not json') });
    await expect(backup).toContainText('This organization backup is invalid or unsupported.');
    await file.setInputFiles({ name: 'huge.json', mimeType: 'application/json', buffer: Buffer.alloc(5 * 1024 * 1024 + 1, 32) });
    await expect(backup).toContainText('Organization files must be 5 MiB or smaller.');

    const replacement = emptyOrganization({ folders: [{ id: 'f-new', name: 'Imported' }] });
    await file.setInputFiles({ name: 'ok.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(replacement)) });
    await expect(page.getByRole('alertdialog')).toContainText('Replace all current folders, collections, saved views, tags, and favorites?');
    await page.getByRole('alertdialog').getByRole('button', { name: 'Cancel' }).click();
    await expect(sectionNamed(page, 'Folders').getByText('Roleplay', { exact: true })).toBeVisible();
    expect(archive.uploads).toHaveLength(0);

    await file.setInputFiles({ name: 'ok.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(replacement)) });
    await page.getByRole('alertdialog').getByRole('button', { name: 'Replace' }).click();
    await expect.poll(() => archive.uploads.at(-1)?.folders).toEqual([{ id: 'f-new', name: 'Imported' }]);
    await expect(sectionNamed(page, 'Folders').getByText('Imported', { exact: true })).toBeVisible();
    await expect(backup).toContainText('Imported organization. Saving replacement...');
    await expect(sectionNamed(page, 'Collections').getByText('None yet.')).toBeVisible();
});

test('a chat opens as a page with its actions, summary, organizer and messages, and edits save to the organization', async ({ page }) => {
    let releaseExport;
    const exportGate = new Promise(resolve => { releaseExport = resolve; });
    const archive = await bootArchive(page, WIDE, {
        chatBody: () => chatBody([{ name: 'Alice', mes: 'desktop message' }]),
        fixture: small(['desktop-chat'], {
            organization: emptyOrganization({
                folders: [{ id: 'folder-one', name: 'Folder one' }],
                collections: [
                    { id: 'collection-one', name: 'Collection one' },
                    { id: 'collection-two', name: 'Collection two' },
                    { id: 'collection-three', name: 'Collection three' },
                ],
                chats: { [chatKey('Alice', 'desktop-chat')]: { collections: ['collection-one', 'collection-two'] } },
            }),
        }),
    });
    await page.route('**/api/chats/export', async route => {
        await exportGate;
        return route.fallback();
    });
    await openArchive(page);
    await showList(page);
    await expect(page.locator('.sbca-list')).toHaveAttribute('role', 'list');
    await expect(page.locator('.sbca-status')).toHaveAttribute('role', 'status');
    await rows(page).first().click();
    await expect(rows(page).first()).toHaveAttribute('aria-current', 'true');
    const content = page.locator('.sbca-viewer-content');
    await expect(content).toContainText('Loading chat...');
    await expect(content).toHaveAttribute('aria-busy', 'true');
    const order = await content.evaluate(node => [...node.children].map(child => child.className));
    expect(order[0]).toContain('sbca-detail-actions');
    expect(order[2]).toContain('sbca-organize');
    expect(order.at(-1)).toContain('sbca-detail-body');
    await expect(page.locator('.sbca-dialog .sb-dialog__title').last()).toHaveText('desktop-chat');
    await expect(page.locator('.sbca-dialog .sb-dialog__subtitle').last()).toHaveText('Alice');
    releaseExport();
    await waitForDetail(page);
    await expect(content).toContainText('desktop message');
    await expect(page.locator('.sbca-status')).toHaveText('Opened desktop-chat');
    await expect(content.locator('.sbca-open-chat')).toHaveText('Open Chat');
    await expect(content.getByRole('heading', { name: 'Summary' })).toBeVisible();
    await expect(content.getByRole('heading', { name: 'Organize Chat' })).toBeVisible();
    await expect(content.getByRole('heading', { name: 'Messages' })).toBeVisible();
    await expect(content.locator('[data-sb-editor-field="size"] .ds-row-subtitle')).toHaveText('Size');
    await expectCleanLayout(page, 'detail', '.sbca-detail-page');

    const key = chatKey('Alice', 'desktop-chat');
    const saved = () => archive.uploads.at(-1)?.chats?.[key];

    const favorite = content.getByRole('button', { name: 'Favorite', exact: true });
    await expect(favorite).toHaveAttribute('aria-pressed', 'false');
    await favorite.click();
    await expect(favorite).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(() => saved()?.favorite).toBe(true);
    await favorite.click();
    await expect(favorite).toHaveAttribute('aria-pressed', 'false');
    await expect.poll(() => saved()?.favorite).toBeUndefined();

    const organize = content.locator('.sbca-organize');
    await organize.getByRole('button', { name: /^Folder/ }).click();
    await page.locator('.sb-picker__option', { hasText: 'Folder one' }).click();
    await expect.poll(() => saved()?.folder).toBe('folder-one');

    await expect(organize.getByRole('button', { name: /^Remove Collection/ })).toHaveCount(2);
    await organize.getByRole('button', { name: /^Collections/ }).click();
    await expect(page.locator('.sb-picker__option')).toHaveCount(1);
    await page.locator('.sb-picker__option', { hasText: 'Collection three' }).click();
    await expect.poll(() => saved()?.collections).toEqual(['collection-one', 'collection-two', 'collection-three']);
    await organize.getByRole('button', { name: 'Remove Collection Collection one' }).click();
    await expect.poll(() => saved()?.collections).toEqual(['collection-two', 'collection-three']);

    const tags = organize.getByRole('textbox', { name: 'Tags' });
    await tags.fill('alpha, beta');
    await organize.getByRole('button', { name: 'Add Tags' }).click();
    await expect.poll(() => saved()?.tags).toEqual(['alpha', 'beta']);
    await expect(tags).toHaveValue('');
    await organize.getByRole('button', { name: 'Remove Tag alpha' }).click();
    await expect.poll(() => saved()?.tags).toEqual(['beta']);
    await tags.fill('gamma');
    await tags.press('Enter');
    await expect.poll(() => saved()?.tags).toEqual(['beta', 'gamma']);

    // Back returns to the row, and the row and the sidebar already show the changes.
    await goBack(page);
    await expect(rows(page).first()).toBeFocused();
    await expect(page.locator('.sbca-location', { hasText: 'Folder one' }).locator('.sbca-location-count')).toHaveText('1');
});

test('Favorite on a chat page updates the row star and the Favorites count, and Back puts the focus on the row', async ({ page }) => {
    const archive = await bootArchive(page, WIDE, { fixture: bigFixture() });
    await openArchive(page);
    await showList(page);
    const target = rows(page).filter({ hasText: 'Alice - Chapter 1' }).first();
    const key = await target.getAttribute('data-sbca-key');
    await expect(target.locator('.sbca-row-star')).toHaveCount(0);
    const count = page.locator('.sbca-location', { hasText: 'Favorites' }).locator('.sbca-location-count');
    const before = Number(await count.textContent());
    await target.click();
    await waitForDetail(page);
    const toggle = page.locator('.sbca-viewer-content').getByRole('button', { name: 'Favorite', exact: true });
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(() => archive.uploads.at(-1)?.chats?.[key]?.favorite).toBe(true);
    await goBack(page);
    await expect(page.locator(`.sbca-row[data-sbca-key="${key.replaceAll('"', '\\"')}"] .sbca-row-star`)).toHaveCount(1);
    await expect(count).toHaveText(String(before + 1));
    await expect.poll(() => page.evaluate(() => document.activeElement?.dataset?.sbcaKey ?? '')).toBe(key);
});

test('a chat that cannot be parsed shows its raw file, and downloads offer the original JSONL only', async ({ page }) => {
    await bootArchive(page, WIDE, {
        chatBody: file => (file.includes('Malformed') ? '{"chat_metadata": {}}\n{this is not json\n' : chatBody()),
        fixture: small(['valid-chat', 'Malformed notes']),
    });
    await openArchive(page);
    await showList(page);

    await openRow(page, 'valid-chat');
    await waitForDetail(page);
    const downloadButton = page.locator('.sbca-viewer-content').getByRole('button', { name: 'Download', exact: true });
    await downloadButton.click();
    const [original] = await Promise.all([
        page.waitForEvent('download'),
        page.getByRole('menuitem', { name: 'Download Original (.jsonl)' }).click(),
    ]);
    expect(original.suggestedFilename()).toBe('valid-chat.jsonl');
    await downloadButton.click();
    const [readable] = await Promise.all([
        page.waitForEvent('download'),
        page.getByRole('menuitem', { name: 'Download Readable Text' }).click(),
    ]);
    expect(readable.suggestedFilename()).toBe('valid-chat.txt');
    await goBack(page);

    await openRow(page, 'Malformed notes');
    await waitForDetail(page);
    await expect(alert(page, 'This file contains invalid JSONL. You can still download or inspect the original file.')).toBeVisible();
    await expect(page.locator('.sbca-status')).toHaveText('Opened raw file for Malformed notes; message parsing failed.');
    await expect(page.locator('.sbca-message-list')).toHaveCount(0);
    await expect(page.locator('.sbca-raw')).toBeHidden();
    await page.getByRole('button', { name: 'Show Raw File' }).click();
    await expect(page.locator('.sbca-raw')).toContainText('{this is not json');
    await page.getByRole('button', { name: 'Hide Raw File' }).click();
    await expect(page.locator('.sbca-raw')).toBeHidden();
    await downloadButton.click();
    await expect(page.getByRole('menuitem', { name: 'Download Original (.jsonl)' })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: 'Download Readable Text' })).toHaveCount(0);
});

test('a long chat pages forward and back, jumps to the latest messages and reveals its metadata', async ({ page }) => {
    await bootArchive(page, WIDE, { chatBody: () => longChat(), fixture: small(['Long saga']) });
    await openArchive(page);
    await showList(page);
    await openRow(page, 'Long saga');
    await waitForDetail(page);
    const messages = page.locator('.sbca-msg');
    await expect(messages).toHaveCount(100);
    await page.getByRole('button', { name: 'Show 100 More Messages' }).click();
    await expect(messages.first()).toContainText('Message 101');
    await expect(page.getByRole('button', { name: 'Show 100 Earlier Messages' })).toBeVisible();
    await page.getByRole('button', { name: 'Latest Messages' }).click();
    await expect(messages.last()).toContainText('Message 250');
    await messages.last().scrollIntoViewIfNeeded();
    await expect(messages.last()).toBeInViewport();
    const metadata = page.locator('.sbca-messages-group > .ds-row-expander');
    await metadata.scrollIntoViewIfNeeded();
    await metadata.locator('summary').click();
    await expect(metadata.locator('.sbca-json')).toContainText('"note": "kept"');
    await expect(metadata.locator('.sbca-json')).toBeInViewport();
});

const hostChatFixture = () => small([linkedRow('host-chat', { avatar: HOST_AVATAR })], { characters: [] });

test('Open chat loads the chat in the host, closes the archive and focuses the message box', async ({ page }) => {
    const archive = await bootArchive(page, WIDE, { fixture: hostChatFixture() });
    const savedChats = [];
    const lastChats = [];
    const reads = [];
    page.on('request', request => {
        if (request.method() === 'POST' && /\/api\/(?:chats|characters|groups)\/(?:save|edit|create|delete|rename)/.test(request.url())) savedChats.push(request.url());
    });
    await page.route('**/api/characters/chats', route => fulfillJson(route, { 0: { file_name: 'host-chat.jsonl', last_mes: 1_000 } }));
    await page.route('**/api/characters/last-chat', route => {
        lastChats.push(route.request().postDataJSON());
        return route.fulfill({ status: 200, body: 'ok' });
    });
    await page.route('**/api/quick-replies/save', route => route.fulfill({ status: 200, body: 'ok' }));
    await page.route('**/api/chats/get', route => {
        reads.push(route.request().postDataJSON());
        return fulfillJson(route, [
            { chat_metadata: {}, user_name: 'You', character_name: 'Dialog Character' },
            { name: 'Dialog Character', is_user: false, send_date: 'October 1, 2026 1:00pm', mes: 'Welcome back.' },
        ]);
    });
    await openArchive(page);
    await showList(page);
    await openRow(page, 'host-chat');
    await waitForDetail(page);
    await page.locator('.sbca-viewer-content .sbca-open-chat').click();
    await expect(dialog(page)).toHaveCount(0);
    await expect(page.locator('#send_textarea')).toBeFocused();
    await expect(page.locator('#chat .mes_text', { hasText: 'Welcome back.' })).toBeVisible();
    expect(reads.map(body => body.file_name)).toContain('host-chat');
    expect(lastChats).toContainEqual({ avatar: HOST_AVATAR, chat: 'host-chat' });
    expect(savedChats).toEqual([]);
    expect(archive.uploads).toHaveLength(0);
});

test('when the host cannot load the chat, Open chat reports it and leaves the archive open', async ({ page }) => {
    const archive = await bootArchive(page, WIDE, { fixture: hostChatFixture() });
    await showToasts(page);
    await openArchive(page);
    await showList(page);
    await openRow(page, 'host-chat');
    await waitForDetail(page);
    await page.route('**/api/chats/get', route => route.abort());
    await page.locator('.sbca-viewer-content .sbca-open-chat').click();
    await expect(page.getByText('Could not open this chat. The archive is still available.')).toBeVisible();
    await expect(page.locator('.sbca-viewer-content .sbca-open-chat')).toBeEnabled();
    await expect(page.locator('.sbca-viewer-content .sbca-open-chat')).not.toHaveAttribute('aria-disabled', 'true');
    await expect(dialog(page)).toBeVisible();
    expect(archive.uploads).toHaveLength(0);
});

const HOST = 'misc-dialog-character.png';
const sorted = values => [...values].sort();
// A search that must not start can only be shown by letting its debounce elapse.
// eslint-disable-next-line playwright/no-wait-for-timeout
const settleSearchDebounce = page => page.waitForTimeout(SEARCH_CONTENT_DEBOUNCE_MS + 50);

/** Serves the first archive page at once and holds the next one until the returned `release` is called. */
async function pagedInventory(page, { first, second, firstCursor = ARCHIVE_CURSOR }) {
    let release;
    let markStarted;
    const started = new Promise(resolve => { markStarted = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    let archiveRequests = 0;
    await page.route('**/api/chats/archive/inventory', async route => {
        if (route.request().postDataJSON().scope !== 'archive') return route.fallback();
        archiveRequests++;
        if (archiveRequests === 1) return fulfillJson(route, archivePage([first], firstCursor, null, 2));
        markStarted();
        await gate;
        return fulfillJson(route, archivePage([second], null, null, 2));
    });
    return { release, started };
}

const banner = page => page.locator('.sbca-banner');

test('the first page and its progress show before the next page resolves, and content search waits for the load', async ({ page }) => {
    const archive = await bootArchive(page, WIDE, { fixture: small([]) });
    const inventory = await pagedInventory(page, { first: linkedRow('first'), second: linkedRow('second') });
    await openArchive(page);
    await inventory.started;
    await expect(filenames(page)).toHaveText(['first']);
    await expect(page.locator('.sbca-status')).toContainText('1 of 2 indexed chat files');
    await expect(banner(page).getByRole('button', { name: 'Cancel' })).toBeEnabled();
    await expect(page.getByText('second', { exact: true })).toHaveCount(0);

    await (await openSearch(page)).fill('second');
    await settleSearchDebounce(page);
    expect(searchedScopes(archive, 'second')).toEqual([]);

    inventory.release();
    await expect(filenames(page)).toHaveText(['second']);
    await expect.poll(() => sorted(searchedScopes(archive, 'second'))).toEqual(['Alice.png', HOST]);
    await expect(banner(page)).toBeHidden();
    await openMenu(page);
    await expect(page.getByRole('menuitem', { name: 'Refresh' })).toBeEnabled();
});

test('metadata and message-content matches combine, a stale search is ignored, and Select All takes every match', async ({ page }) => {
    let releaseStale;
    let markStaleStarted;
    const staleStarted = new Promise(resolve => { markStaleStarted = resolve; });
    const staleGate = new Promise(resolve => { releaseStale = resolve; });
    const contentMatch = {
        file_name: 'content-match',
        file_size: '2 KB',
        message_count: 4,
        last_mes: 2_000,
        preview_message: 'needle appears in an older message',
    };
    const archive = await bootArchive(page, WIDE, {
        fixture: small(['needle-metadata', 'unrelated']),
        // eslint-disable-next-line playwright/no-conditional-in-test
        search: async body => {
            if (body.avatar_url !== 'Alice.png') return [];
            if (body.query === 'stale') {
                markStaleStarted();
                await staleGate;
                return [{ ...contentMatch, file_name: 'stale-content-match', preview_message: 'stale result' }];
            }
            return body.query === 'needle' ? [contentMatch] : [];
        },
    });
    let archiveRequests = 0;
    await page.route('**/api/chats/archive/inventory', route => {
        if (route.request().postDataJSON().scope !== 'archive') return route.fallback();
        archiveRequests++;
        return archiveRequests === 1 ? route.fallback() : route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"refresh failed"}' });
    });
    await openArchive(page);
    await showList(page);
    await expect(page.getByRole('button', { name: 'Search message content' })).toHaveCount(0);

    const field = await openSearch(page);
    await field.fill('stale');
    await staleStarted;
    await field.fill('needle');
    await expect(filenames(page)).toHaveText(['needle-metadata']);
    await expect.poll(() => searchedScopes(archive, 'needle').length).toBeGreaterThan(0);
    releaseStale();
    await expect.poll(async () => sorted(await filenames(page).allTextContents())).toEqual(['content-match', 'needle-metadata']);
    await expect(page.getByText('stale-content-match', { exact: true })).toHaveCount(0);

    // Choosing an owner location restarts the content search for that owner alone.
    const before = searchedScopes(archive, 'needle').length;
    await page.locator('.sbca-location', { hasText: 'Alice' }).first().click();
    await expect.poll(() => searchedScopes(archive, 'needle').length).toBe(before + 1);
    expect(searchedScopes(archive, 'needle').at(-1)).toBe('Alice.png');

    // A refresh that fails keeps the previous rows and repeats the content search.
    const beforeRefresh = searchedScopes(archive, 'needle').length;
    await openMenuItem(page, 'Refresh');
    await expect.poll(() => searchedScopes(archive, 'needle').length).toBeGreaterThan(beforeRefresh);
    await expect.poll(async () => sorted(await filenames(page).allTextContents())).toEqual(['content-match', 'needle-metadata']);

    await openMenuItem(page, 'Select Chats');
    await page.locator('.sb-dialog__selection-select-all').click();
    await expect(selectionTitle(page)).toHaveText('2 selected');
});

test('the @mention combobox completes fuzzily, scopes the content search, and keeps its keyboard contract', async ({ page }) => {
    const archive = await bootArchive(page, WIDE, {
        fixture: small(['ordinary-chat'], {
            characters: [
                { name: 'Alice', avatar: 'Alice.png' },
                { name: 'Alice', avatar: 'Alice-copy.png' },
                { name: 'Bob', avatar: 'Bob.png' },
                { name: 'Path\\Finder', avatar: 'Path.png' },
                { name: 'Prime "One"', avatar: 'Prime.png' },
            ],
        }),
        search: body => (body.avatar_url === 'Alice.png' && body.query === 'needle' ? [{
            file_name: 'mentioned-content-match',
            file_size: '2 KB',
            message_count: 2,
            last_mes: 2_000,
            preview_message: 'needle in message content',
        }] : []),
    });
    await openArchive(page);
    await showList(page);
    const field = await openSearch(page);
    await expect(field).toHaveAttribute('placeholder', 'Type to search chats. Mention character names with @.');
    const menu = page.getByRole('listbox', { name: 'Character Mentions' });

    await field.fill('@Alce');
    await expect(menu).toBeVisible();
    // The host's own character is offered too, and "Alce" is also a subsequence of its name.
    await expect(menu.getByRole('option')).toHaveText(['Alice', 'Dialog Character']);
    await field.press('Escape');
    await expect(menu).toBeHidden();
    await expect(field).toHaveAttribute('aria-expanded', 'false');
    await expect(dialog(page)).toBeVisible();

    // A bare @ lists every name, the host's own character included.
    await field.fill('@');
    await expect(menu.getByRole('option')).toHaveText(['Alice', 'Bob', 'Dialog Character', 'Path\\Finder', 'Prime "One"']);
    await field.press('ArrowUp');
    const last = menu.getByRole('option', { name: 'Prime "One"' });
    await expect(last).toHaveAttribute('aria-selected', 'true');
    await expect(last).toHaveCSS('outline-style', 'solid');
    await expect(field).toBeFocused();
    await field.press('ArrowDown');
    await expect(menu.getByRole('option', { name: 'Alice' })).toHaveAttribute('aria-selected', 'true');
    await field.press('Escape');
    await expect(field).not.toHaveAttribute('aria-activedescendant', /.+/);

    await field.fill('@Prime');
    await field.press('ArrowDown');
    await field.press('Enter');
    await expect(field).toHaveValue('@"Prime \\"One\\"" ');
    await settleSearchDebounce(page);
    expect(archive.searches).toEqual([]);
    await field.fill('@Path');
    await field.press('ArrowDown');
    await field.press('Enter');
    await expect(field).toHaveValue('@"Path\\\\Finder" ');
    await settleSearchDebounce(page);
    expect(archive.searches).toEqual([]);

    await field.fill('@"Path\\\\Finder" needle');
    await expect.poll(() => searchedScopes(archive, 'needle')).toEqual(['Path.png']);

    await field.fill('@Alce');
    await expect(menu).toBeVisible();
    await field.press('ArrowDown');
    await expect(menu.getByRole('option', { name: 'Alice' })).toHaveAttribute('aria-selected', 'true');
    await expect(field).toHaveAttribute('aria-activedescendant', /sbca_mention_/);
    await field.press('Enter');
    await expect(field).toHaveValue('@Alice ');
    await expect(field).toHaveAttribute('aria-expanded', 'false');
    await settleSearchDebounce(page);
    expect(searchedScopes(archive, 'needle')).toEqual(['Path.png']);

    await field.fill('@Alice needle');
    await expect.poll(() => sorted(searchedScopes(archive, 'needle'))).toEqual(['Alice-copy.png', 'Alice.png', 'Path.png']);
    await expect(filenames(page)).toHaveText(['mentioned-content-match']);
});

test('Cancel stops an incremental load, releases its cursor, and ignores the late page', async ({ page }) => {
    const archive = await bootArchive(page, WIDE, { fixture: small([]) });
    const inventory = await pagedInventory(page, { first: linkedRow('kept'), second: linkedRow('late') });
    await openArchive(page);
    await inventory.started;
    await expect(filenames(page)).toHaveText(['kept']);
    await (await openSearch(page)).fill('kept');
    await settleSearchDebounce(page);
    expect(searchedScopes(archive, 'kept')).toEqual([]);

    await banner(page).getByRole('button', { name: 'Cancel' }).click();
    await expect.poll(() => archive.releases).toContainEqual({ cursor: ARCHIVE_CURSOR });
    await expect.poll(() => searchedScopes(archive, 'kept').length).toBeGreaterThan(0);
    inventory.release();
    await expect(filenames(page)).toHaveText(['kept']);
    await expect(page.getByText('late', { exact: true })).toHaveCount(0);
    await openMenu(page);
    await expect(page.getByRole('menuitem', { name: 'Refresh' })).toBeEnabled();
});

test('Stop Scan releases the scan token and cursor and rolls back the partial orphans', async ({ page }) => {
    let release;
    let markStarted;
    const started = new Promise(resolve => { markStarted = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    let orphanRequests = 0;
    const archive = await bootArchive(page, WIDE, { fixture: small(['linked']) });
    await page.route('**/api/chats/archive/inventory', async route => {
        if (route.request().postDataJSON().scope === 'archive') return route.fallback();
        orphanRequests++;
        if (orphanRequests === 1) {
            return fulfillJson(route, archivePage([orphanRow('partial-orphan', FIRST_ORPHAN_HASH)], ORPHAN_CURSOR, FIRST_READ_TOKEN, 2));
        }
        markStarted();
        await gate;
        return fulfillJson(route, archivePage([orphanRow('late-orphan', SECOND_ORPHAN_HASH)], null, FIRST_READ_TOKEN, 2));
    });
    await openArchive(page);
    await (await openSearch(page)).fill('orphan');
    await openMenuItem(page, 'Find Orphaned Files');
    await started;
    await settleSearchDebounce(page);
    expect(searchedScopes(archive, 'orphan')).toEqual([]);
    await expect(page.getByText('partial-orphan', { exact: true })).toBeVisible();
    await expect(page.locator('.sbca-status')).toContainText('1 of 2 indexed chat files');
    await expect(banner(page).getByRole('button', { name: 'Stop Scan' })).toBeVisible();

    await banner(page).getByRole('button', { name: 'Stop Scan' }).click();
    await expect.poll(() => archive.releases).toContainEqual({ token: FIRST_READ_TOKEN, cursor: ORPHAN_CURSOR });
    release();
    await expect(page.getByText('partial-orphan', { exact: true })).toHaveCount(0);
    await expect(page.getByText('late-orphan', { exact: true })).toHaveCount(0);
    await expect.poll(() => searchedScopes(archive, 'orphan').length).toBeGreaterThan(0);
});

test('after a rescan, a location the complete data hides falls back to All Chats in the sidebar, the list and the saved view', async ({ page }) => {
    let scans = 0;
    const archive = await bootArchive(page, WIDE, { fixture: small(['linked-chat'], { organization: emptyOrganization() }) });
    await page.route('**/api/chats/archive/inventory', route => {
        if (route.request().postDataJSON().scope === 'archive') return route.fallback();
        scans++;
        const rescan = scans === 2;
        return fulfillJson(route, archivePage([
            orphanRow(rescan ? 'unlinked-orphan' : 'missing-orphan', rescan ? SECOND_ORPHAN_HASH : FIRST_ORPHAN_HASH, {
                reason: rescan ? 'unlinked-group' : 'missing-character',
            }),
        ], null, rescan ? SECOND_READ_TOKEN : FIRST_READ_TOKEN, 1));
    });
    await openArchive(page);
    await openMenuItem(page, 'Find Orphaned Files');
    await showList(page, 'Orphaned');
    await expect(filenames(page)).toHaveText(['missing-orphan']);
    await openFilters(page);
    await page.locator('.sbca-filters').getByRole('button', { name: /Orphan Reason/ }).click();
    await page.getByRole('option', { name: 'Missing character' }).click();
    await expect(filenames(page)).toHaveText(['missing-orphan']);
    await expect(page.locator('.sbca-location[aria-pressed="true"]')).toContainText('Orphaned');

    await openMenuItem(page, 'Rescan Orphaned Files');
    await expect.poll(() => scans).toBe(2);
    await expect(page.locator('.sbca-location[aria-pressed="true"]')).toContainText('All Chats');
    await expect(page.getByText('No chats match these filters.')).toBeVisible();
    await expect.poll(() => archive.uploads.at(-1)?.lastView?.kinds).not.toEqual(['orphan']);

    await openMenu(page);
    await page.getByRole('menuitem', { name: 'Save Current View…' }).click();
    await page.getByRole('textbox', { name: 'View Name' }).fill('After scan');
    await page.getByRole('textbox', { name: 'View Name' }).press('Enter');
    await expect.poll(() => archive.uploads.at(-1)?.views?.map(view => view.name)).toEqual(['After scan']);
    expect(archive.uploads.at(-1).views[0].view.kinds).not.toEqual(['orphan']);
});

test('a rescan replaces the scan token, and an orphan opens through the archive namespace', async ({ page }) => {
    let orphanScans = 0;
    const archive = await bootArchive(page, PHONE, { fixture: small(['linked']) });
    await page.route('**/api/chats/archive/inventory', async route => {
        if (route.request().postDataJSON().scope === 'archive') return route.fallback();
        orphanScans++;
        const replacement = orphanScans === 2;
        return fulfillJson(route, archivePage([
            orphanRow(replacement ? 'current-orphan' : 'old-orphan', replacement ? SECOND_ORPHAN_HASH : FIRST_ORPHAN_HASH),
        ], null, replacement ? SECOND_READ_TOKEN : FIRST_READ_TOKEN, 1));
    });
    await openArchive(page);
    await openMenuItem(page, 'Find Orphaned Files');
    await expect(page.locator('.sbca-location', { hasText: 'Orphaned' }).locator('.sbca-location-count')).toHaveText('1');
    await openMenuItem(page, 'Rescan Orphaned Files');
    await expect.poll(() => archive.releases).toContainEqual({ token: FIRST_READ_TOKEN });
    await showList(page);
    await expect(filenames(page).filter({ hasText: 'current-orphan' })).toBeVisible();
    await expect(filenames(page).filter({ hasText: 'old-orphan' })).toHaveCount(0);

    await openRow(page, 'current-orphan');
    await waitForDetail(page);
    await expect(page.locator('.sbca-viewer-content')).toContainText('Nobody is left to remember this.');
    const detail = await page.locator('.sbca-viewer-content').evaluate(content => ({
        noHorizontalOverflow: content.scrollWidth <= content.clientWidth,
        organizerShown: Boolean(content.querySelector('.sbca-organize')?.getClientRects().length),
    }));
    expect(detail.noHorizontalOverflow).toBe(true);
    expect(detail.organizerShown).toBe(true);
    expect(archive.views).toHaveLength(1);
    const viewed = new URL(archive.views[0]);
    expect(viewed.pathname).toBe('/api/chats/archive/view');
    expect(viewed.searchParams.get('token')).toBe(SECOND_READ_TOKEN);
    expect(viewed.searchParams.get('hash')).toBe(SECOND_ORPHAN_HASH);
    expect(archive.dataMaid).toEqual([]);
});

test('saved views appear in the menu, restore their query, keep density and group, and reset when edited by hand', async ({ page }) => {
    const archive = await bootArchive(page, WIDE, {
        fixture: small(['favorite-saved-view-chat', 'ordinary-saved-view-chat'], {
            organization: emptyOrganization({
                views: [
                    { id: 'compact-by-owner', name: 'Compact by owner', view: { density: 'compact', group: 'owner', query: 'saved query' } },
                    { id: 'favorite-only', name: 'Favorite', view: { favorite: true } },
                    { id: 'not-favorite', name: 'Not favorite', view: { favorite: false } },
                ],
                chats: { [chatKey('Alice', 'favorite-saved-view-chat')]: { favorite: true } },
            }),
        }),
    });
    await openArchive(page);
    await showList(page);
    await openMenu(page);
    const savedViews = page.getByRole('group', { name: 'Saved Views' }).getByRole('menuitemradio');
    await expect(savedViews).toHaveText(['Current View', 'Compact by owner', 'Favorite', 'Not favorite']);
    await expect(savedViews.first()).toHaveAttribute('aria-checked', 'true');
    await savedViews.nth(1).click();

    await expect(await openSearch(page)).toHaveValue('saved query');
    await expect.poll(() => sorted(searchedScopes(archive, 'saved query'))).toEqual(['Alice.png', HOST]);
    await expect.poll(() => archive.uploads.at(-1)?.lastView).toMatchObject({ density: 'compact', group: 'owner', query: 'saved query' });

    await openMenu(page);
    await expect(page.getByRole('menuitemradio', { name: 'Compact by owner' })).toHaveAttribute('aria-checked', 'true');
    await page.getByRole('menuitemradio', { name: 'Favorite', exact: true }).click();
    await openFilters(page);
    await expect(filterCheck(page, 'Favorites')).toBeChecked();
    expect(await filterCheck(page, 'Favorites').evaluate(input => input.indeterminate)).toBe(false);
    // A saved `favorite: true` is the Favorites location, so only the favourite is listed.
    await expect(page.locator('.sbca-location', { hasText: 'Favorites' })).toHaveAttribute('aria-pressed', 'true');
    await expect(filenames(page)).toHaveText(['favorite-saved-view-chat']);
    await expect(search(page)).toHaveValue('');
    await page.keyboard.press('Escape');

    await openMenu(page);
    await page.getByRole('menuitemradio', { name: 'Not favorite' }).click();
    await openFilters(page);
    await expect(filterCheck(page, 'Favorites')).not.toBeChecked();
    expect(await filterCheck(page, 'Favorites').evaluate(input => input.indeterminate)).toBe(false);
    await expect(filenames(page)).toHaveText(['ordinary-saved-view-chat']);
    await filterCheck(page, 'Favorites').check();
    await expect(filenames(page)).toHaveText(['favorite-saved-view-chat', 'ordinary-saved-view-chat']);
    await page.keyboard.press('Escape');

    await openMenu(page);
    await expect(page.getByRole('menuitemradio', { name: 'Current View' })).toHaveAttribute('aria-checked', 'true');
});

test('a view can be saved from the menu under a new name and is offered afterwards', async ({ page }) => {
    const archive = await bootArchive(page, WIDE, { fixture: small(['view-chat'], { organization: emptyOrganization() }) });
    await openArchive(page);
    await showList(page);
    await openMenu(page);
    await expect(page.getByRole('group', { name: 'Saved Views' }).getByRole('menuitemradio')).toHaveText(['Current View']);
    await page.getByRole('menuitem', { name: 'Save Current View…' }).click();
    const name = page.getByRole('textbox', { name: 'View Name' });
    await name.fill('   ');
    await page.getByRole('button', { name: 'Create' }).click();
    await expect(alert(page, 'Enter a name.')).toBeVisible();
    await name.fill('Mine');
    await name.press('Enter');
    await expect.poll(() => archive.uploads.at(-1)?.views?.map(view => view.name)).toEqual(['Mine']);
    await openMenu(page);
    await expect(page.getByRole('group', { name: 'Saved Views' }).getByRole('menuitemradio')).toHaveText(['Current View', 'Mine']);
});

test('the sidebar and the list follow the arrow, Home, End and Enter keys', async ({ page }) => {
    await bootArchive(page, WIDE, { fixture: bigFixture() });
    await openArchive(page);
    await showList(page);

    const locations = page.locator('.sbca-location');
    const selected = page.locator('.sbca-location[aria-pressed="true"]');
    await expect(locations.first()).toHaveAttribute('tabindex', '0');
    await expect(page.locator('.sbca-location[tabindex="0"]')).toHaveCount(1);
    await selected.focus();
    await page.keyboard.press('End');
    await expect(locations.last()).toBeFocused();
    await page.keyboard.press('Home');
    await expect(locations.first()).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(locations.nth(1)).toBeFocused();
    await page.keyboard.press('ArrowUp');
    await expect(locations.first()).toBeFocused();

    await rows(page).first().focus();
    await page.keyboard.press('ArrowDown');
    await expect(rows(page).nth(1)).toBeFocused();
    await page.keyboard.press('ArrowUp');
    await expect(rows(page).first()).toBeFocused();
    await page.keyboard.press('ArrowUp');
    await expect(rows(page).first()).toBeFocused();

    await rows(page).nth(99).focus();
    await expect(rows(page)).toHaveCount(100);
    await page.keyboard.press('ArrowDown');
    await expect(rows(page)).toHaveCount(142);
    await expect(rows(page).nth(100)).toBeFocused();
    await expect(page.locator('.sbca-list-more')).toHaveCount(0);

    await rows(page).nth(3).focus();
    const key = await rows(page).nth(3).getAttribute('data-sbca-key');
    await page.keyboard.press('Enter');
    await waitForDetail(page);
    await goBack(page);
    await expect.poll(() => page.evaluate(() => document.activeElement?.dataset?.sbcaKey ?? '')).toBe(key);
});

test('Show more extends the list a page at a time and tells how many remain', async ({ page }) => {
    await bootArchive(page, WIDE, { fixture: bigFixture() });
    await openArchive(page);
    await showList(page);
    await expect(rows(page)).toHaveCount(100);
    const more = page.getByRole('button', { name: 'Show 42 More' });
    await expect(more).toBeVisible();
    await more.click();
    await expect(rows(page)).toHaveCount(142);
    await expect(page.getByRole('button', { name: /^Show \d+ more$/ })).toHaveCount(0);
    await expect(rows(page).nth(100)).toBeFocused();
});

const selectionBar = page => page.locator('.sbca-dialog .sb-selection-action-bar');
const aliceKeys = () => bigFixture().rows
    .filter(row => row.avatar === 'Alice.png')
    .map(row => chatKey('Alice', row.file_name.replace(/\.jsonl$/, '')));

async function selectAllIn(page, location) {
    await showList(page, location);
    await openMenuItem(page, 'Select Chats');
    await page.locator('.sb-dialog__selection-select-all').click();
}

test('Select All counts every chat beyond the first hundred, and selections outside the filters are kept and reported', async ({ page }) => {
    await bootArchive(page, WIDE, { fixture: bigFixture() });
    await openArchive(page);
    await showList(page);
    await openMenuItem(page, 'Select Chats');
    await expect(selectionTitle(page)).toHaveText('0 selected');
    await expect(rows(page)).toHaveCount(100);
    await page.locator('.sb-dialog__selection-select-all').click();
    await expect(selectionTitle(page)).toHaveText('142 selected');
    await expect(page.locator('.sb-dialog__selection-select-all')).toBeVisible();

    // Moving to a location narrows the list but keeps what was chosen.
    await page.locator('.sbca-location', { hasText: 'Alice' }).first().click();
    await expect(selectionTitle(page)).toHaveText('142 selected (128 hidden by filters)');
    await expect(rows(page)).toHaveCount(14);
    await page.keyboard.press('Escape');
    await expect(selectionTitle(page)).toHaveCount(0);
    await expect(selectionBar(page).filter({ visible: true })).toHaveCount(0);
});

test('the selection bar applies each batch change and every one reaches the saved organization', async ({ page }) => {
    const archive = await bootArchive(page, WIDE, { fixture: bigFixture() });
    await openArchive(page);
    await selectAllIn(page, 'Alice');
    await expect(selectionTitle(page)).toHaveText('14 selected');
    const keys = aliceKeys();
    expect(keys).toHaveLength(14);
    const saved = () => archive.uploads.at(-1)?.chats;
    const every = predicate => keys.every(key => predicate(Object.assign({}, saved()?.[key])));
    const action = name => selectionBar(page).getByRole('button', { name, exact: true });

    await action('Favorite').click();
    await page.getByRole('menuitemradio', { name: 'Favorite', exact: true }).click();
    await expect.poll(() => every(metadata => metadata.favorite === true)).toBe(true);
    await action('Favorite').click();
    await page.getByRole('menuitemradio', { name: 'Unfavorite' }).click();
    await expect.poll(() => every(metadata => metadata.favorite === undefined)).toBe(true);

    await action('Folder…').click();
    await page.getByRole('menuitemradio', { name: 'Archive' }).click();
    await expect.poll(() => every(metadata => metadata.folder === 'f-arch')).toBe(true);
    await action('Folder…').click();
    await page.getByRole('menuitem', { name: 'Clear Folder' }).click();
    await expect.poll(() => every(metadata => metadata.folder === undefined)).toBe(true);

    await action('Collections…').click();
    await page.getByRole('group', { name: 'Add Collection' }).getByRole('menuitem', { name: 'One-shots' }).click();
    await expect.poll(() => every(metadata => metadata.collections?.includes('c-one'))).toBe(true);
    await action('Collections…').click();
    await page.getByRole('group', { name: 'Remove Collection' }).getByRole('menuitem', { name: 'One-shots' }).click();
    await expect.poll(() => every(metadata => !metadata.collections?.includes('c-one'))).toBe(true);

    await action('Tags…').click();
    const tags = page.getByRole('textbox', { name: 'Tags (Comma-Separated)' });
    await tags.fill('alpha, Beta');
    await page.locator('.sbca-batch-tags').getByRole('button', { name: 'Add Tags' }).click();
    await expect.poll(() => every(metadata => ['alpha', 'Beta'].every(tag => metadata.tags?.includes(tag)))).toBe(true);
    await action('Tags…').click();
    await page.getByRole('textbox', { name: 'Tags (Comma-Separated)' }).fill('beta');
    await page.locator('.sbca-batch-tags').getByRole('button', { name: 'Remove Tags' }).click();
    await expect.poll(() => every(metadata => metadata.tags?.includes('alpha') && !metadata.tags?.includes('Beta'))).toBe(true);

    // Chats outside the selection never change.
    const other = chatKey('Bob', 'Bob - The summit road 0');
    expect(saved()?.[other]).toEqual(bigFixture().organization.chats[other]);
});

test('the selection bar stays disabled until a chat is selected, and while the organization cannot be written', async ({ page }) => {
    await bootArchive(page, WIDE, { fixture: bigFixture() });
    await page.route('**/user/files/_sbca_organization.json', route => route.fulfill({ status: 503 }));
    await openArchive(page);
    await showList(page);
    await openMenuItem(page, 'Select Chats');
    await rows(page).first().click();
    await expect(selectionTitle(page)).toHaveText('1 selected');
    for (const name of ['Favorite', 'Folder…', 'Collections…', 'Tags…']) {
        await expect(selectionBar(page).getByRole('button', { name, exact: true })).toBeDisabled();
    }
});

test('Escape leaves selection mode first, and the rows follow with their checks', async ({ page }) => {
    await bootArchive(page, WIDE, { fixture: bigFixture() });
    await openArchive(page);
    await showList(page);
    await openMenuItem(page, 'Select Chats');
    await rows(page).nth(0).click();
    await rows(page).nth(2).click({ modifiers: ['Shift'] });
    await expect(selectionTitle(page)).toHaveText('3 selected');
    await expect(page.locator('.sbca-row .sb-selection-check:checked')).toHaveCount(3);
    await page.keyboard.press('Escape');
    await expect(dialog(page)).toBeVisible();
    await expect(page.locator('.sbca-row .sb-selection-check')).toHaveCount(0);
});

test('resizing across the breakpoint keeps the open chat and its focus, and a selection ends', async ({ page }) => {
    await bootArchive(page, WIDE, { fixture: bigFixture(), chatBody: () => longChat() });
    await openArchive(page);
    await showList(page, 'Alice');
    await openRow(page, 'Alice - Long saga');
    await waitForDetail(page);
    await page.locator('.sbca-viewer-content').getByRole('button', { name: 'Favorite', exact: true }).focus();
    await page.setViewportSize(PHONE);
    await expect(page.locator('.sbca-viewer-content')).toBeVisible();
    await expect.poll(() => page.evaluate(() => Boolean(document.activeElement?.closest('.sbca-dialog')))).toBe(true);
    await expect(page.locator('.sbca-dialog .sb-dialog__title').last()).toHaveText('Alice - Long saga');
    await expectCleanLayout(page, 'detail after collapsing', '.sbca-detail-page');
    // On a phone the chat sits above the locations page, so Back lands on the locations with Alice still chosen.
    await goBack(page);
    await expect(page.locator('.sbca-location[aria-pressed="true"]')).toContainText('Alice');
    await expect(rows(page).first()).toBeHidden();
    await showList(page, 'Alice');

    await page.setViewportSize(WIDE);
    await expect(page.locator('.sbca-list-page')).toHaveCount(0);
    await expect(page.locator('.sbca-location').first()).toBeVisible();
    await expect(rows(page).first()).toBeVisible();
    await expect(page.locator('.sbca-location[aria-pressed="true"]')).toContainText('Alice');
    await openMenuItem(page, 'Select Chats');
    await rows(page).first().click();
    await expect(selectionTitle(page)).toHaveText('1 selected');
    await page.setViewportSize(PHONE);
    await expect(selectionTitle(page)).toHaveCount(0);
    await expect(dialog(page)).toBeVisible();
});

test.describe('the layout follows the window while a list page covers the sidebar', () => {
    test('widening leaves the list page for the split view with the location kept and focused', async ({ page }) => {
        await bootArchive(page, PHONE, { fixture: bigFixture() });
        await openArchive(page);
        await page.locator('.sbca-location', { hasText: 'Alice' }).first().click();
        await expect(page.locator('.sbca-list-page')).toBeVisible();
        await expect(rows(page).first()).toBeVisible();
        await expect(page.locator('.sbca-location').first()).toBeHidden();
        await shot(page, 'resize-list-page');

        await page.setViewportSize(WIDE);
        await expect(page.locator('.sbca-list-page')).toHaveCount(0);
        expect(await isCollapsed(page)).toBe(false);
        await expect(page.locator('.sbca-location[aria-pressed="true"]')).toContainText('Alice');
        await expect(rows(page).first()).toBeVisible();
        await expect(page.locator('.sbca-location[aria-pressed="true"]')).toBeFocused();
        await expectCleanLayout(page, 'split view after widening');
        await shot(page, 'resize-split');
    });

    test('a chat page stays through widening, and Back lands on the split view with the row focused', async ({ page }) => {
        await bootArchive(page, PHONE, { fixture: bigFixture(), chatBody: () => longChat() });
        await openArchive(page);
        await page.locator('.sbca-location', { hasText: 'Alice' }).first().click();
        await openRow(page, 'Alice - Long saga');
        await waitForDetail(page);

        await page.setViewportSize(WIDE);
        await expect(page.locator('.sbca-viewer-content')).toBeVisible();
        await expect(page.locator('.sbca-list-page')).toHaveCount(1);

        await goBack(page);
        await expect(page.locator('.sbca-detail-page')).toHaveCount(0);
        await expect(page.locator('.sbca-list-page')).toHaveCount(0);
        expect(await isCollapsed(page)).toBe(false);
        await expect(page.locator('.sbca-location[aria-pressed="true"]')).toContainText('Alice');
        await expect(rows(page).first()).toBeVisible();
        await expect(rows(page).filter({ hasText: 'Alice - Long saga' })).toBeFocused();
        await expectCleanLayout(page, 'split view after Back');
    });

    test('narrowing again gives a working phone flow for the chosen location', async ({ page }) => {
        await bootArchive(page, WIDE, { fixture: bigFixture() });
        await openArchive(page);
        await showList(page, 'Bob');
        await page.setViewportSize(PHONE);
        await expect(page.locator('.sbca-location').first()).toBeVisible();
        await expect(rows(page).first()).toBeHidden();
        await page.locator('.sbca-location', { hasText: 'Alice' }).first().click();
        await expect(page.locator('.sbca-list-page')).toBeVisible();
        await expect(rows(page).first()).toBeVisible();
        await expect(page.locator('.sbca-dialog .sb-dialog__title').last()).toHaveText('Alice');
        await goBack(page);
        await expect(page.locator('.sbca-location[aria-pressed="true"]')).toContainText('Alice');
        await expect(page.locator('.sbca-location').first()).toBeVisible();
    });
});
