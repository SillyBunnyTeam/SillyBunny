import { expect, test } from '@playwright/test';
import {
    FIRST_ORPHAN_HASH,
    FIRST_READ_TOKEN,
    LAYOUT_VIEWPORTS,
    ORPHAN_CURSOR,
    SECOND_ORPHAN_HASH,
    archivePage,
    bigFixture,
    bootArchive,
    chatBody,
    dialog,
    drawerButton,
    expectCleanLayout,
    expectReachable,
    fulfillJson,
    goBack,
    isCollapsed,
    longChat,
    openArchive,
    openFilters,
    openMenu,
    openMenuItem,
    openRow,
    orphanRow,
    rows,
    shot,
    showCharacterList,
    showList,
    waitForDetail,
} from './helpers/chats-archive.js';
import { showToasts } from './helpers/maintainer-server.js';

const WIDE_VIEWPORTS = LAYOUT_VIEWPORTS.filter(({ width }) => width >= 1280);
const PHONE = { width: 390, height: 844 };
const isTouch = ({ width, height }) => Math.min(width, height) <= 480;
const readLongChat = file => (file.includes('Long saga') ? longChat() : chatBody());

/** A popover or menu may scroll, but each of its choices must be reachable inside the viewport. */
async function expectScrollsIntoView(locator, label) {
    await locator.scrollIntoViewIfNeeded();
    await expect(locator, label).toBeInViewport();
}

async function holdOrphanScan(page) {
    let release;
    let markStarted;
    const started = new Promise(resolve => { markStarted = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    let orphanRequests = 0;
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
    return { release, started };
}

for (const viewport of LAYOUT_VIEWPORTS) {
    test.describe(`${viewport.width}x${viewport.height}`, () => {
        test.use({ hasTouch: isTouch(viewport), isMobile: isTouch(viewport) });

        test('every archive state keeps its controls apart and its labels whole', async ({ page }) => {
            await bootArchive(page, viewport, { fixture: bigFixture(), chatBody: readLongChat });
            const scan = await holdOrphanScan(page);
            await openArchive(page);

            // A stacked layout starts on its locations page; a side-by-side one shows the list at once.
            // eslint-disable-next-line playwright/no-conditional-in-test
            if (await isCollapsed(page)) {
                await expectCleanLayout(page, 'locations');
                await shot(page, 'locations');
                await showList(page);
                await shot(page, 'all-chats');
                await expectCleanLayout(page, 'all chats');
                await goBack(page);
            } else {
                await shot(page, 'all-chats');
                await expectCleanLayout(page, 'all chats');
            }
            await showList(page, 'Alice');
            await shot(page, 'location');
            await expectCleanLayout(page, 'location');

            await openFilters(page);
            await shot(page, 'filters');
            await expectScrollsIntoView(page.locator('.sbca-filters').getByRole('button', { name: 'Reset' }), 'Reset in Filters');
            await page.keyboard.press('Escape');
            await page.locator('.sbca-dialog .sbca-view-button:visible').first().click();
            await expect(page.getByRole('menuitemradio')).toHaveCount(9);
            await shot(page, 'view-menu');
            await expectScrollsIntoView(page.getByRole('menuitemradio').last(), 'the last sort choice');
            await page.keyboard.press('Escape');
            await openMenu(page);
            await shot(page, 'menu');
            await expectScrollsIntoView(page.getByRole('menuitem', { name: 'Manage Organization' }), 'Manage Organization in the menu');
            await page.keyboard.press('Escape');

            await openRow(page, 'Alice - Long saga');
            await waitForDetail(page);
            await shot(page, 'detail-top');
            await expectCleanLayout(page, 'detail', '.sbca-detail-page');
            await page.locator('.sbca-msg').nth(2).scrollIntoViewIfNeeded();
            await shot(page, 'detail-messages');
            await page.getByRole('button', { name: 'Latest Messages' }).click();
            await expectReachable(page, page.locator('.sbca-msg').last(), 'the last message');
            const metadata = page.locator('.sbca-messages-group > .ds-row-expander');
            await expectReachable(page, metadata.locator('summary'), 'Metadata');
            await metadata.locator('summary').click();
            await expectReachable(page, metadata.locator('.sbca-json'), 'the metadata JSON');
            await goBack(page);

            await openMenuItem(page, 'Select Chats');
            for (const index of [0, 1, 2]) await rows(page).nth(index).click();
            await shot(page, 'selection');
            await expectCleanLayout(page, 'selection');
            // Header bars raise their text buttons; the selection mode's own flat rule must not reach them.
            for (const control of ['.sb-dialog__selection-cancel', '.sb-dialog__selection-select-all']) {
                const look = await page.locator(`.sbca-dialog ${control}`).evaluate(node => {
                    const style = getComputedStyle(node);
                    return { background: style.backgroundColor, border: style.borderTopWidth };
                });
                expect(look.background, `${control} fill`).not.toBe('rgba(0, 0, 0, 0)');
                expect(look.border, `${control} border`).toBe('1px');
            }
            const bar = page.locator('.sbca-dialog .sb-selection-action-bar');
            for (const name of ['Favorite', 'Folder…', 'Collections…', 'Tags…']) {
                await expectReachable(page, bar.getByRole('button', { name, exact: true }), `the ${name} action`);
            }
            await page.keyboard.press('Escape');

            await openMenuItem(page, 'Manage Organization');
            await shot(page, 'organization');
            await expectCleanLayout(page, 'organization', '.sbca-organization-page');
            await goBack(page);

            await openMenuItem(page, 'Find Orphaned Files');
            await scan.started;
            await expect(page.locator('.sbca-banner')).toBeVisible();
            await shot(page, 'banner');
            await expectCleanLayout(page, 'scan banner');
            await page.locator('.sbca-banner').getByRole('button', { name: 'Stop Scan' }).click();
            scan.release();
            await expect(page.locator('.sbca-banner')).toContainText('Scan stopped.');
            await expect(page.locator('.sbca-banner').getByRole('button')).toBeHidden();
        });

        test('the last chat row, Show more and the Close button stay reachable', async ({ page }) => {
            await bootArchive(page, viewport, { fixture: bigFixture() });
            await openArchive(page);
            await showList(page);
            await expect(rows(page)).toHaveCount(100);
            const more = page.getByRole('button', { name: 'Show 42 More' });
            await expectReachable(page, rows(page).nth(99), 'the hundredth row');
            await expectReachable(page, more, 'Show more');
            await more.click();
            await expect(rows(page)).toHaveCount(142);
            await expectReachable(page, rows(page).last(), 'the last row');
            await expect(page.locator('.sbca-dialog .sb-dialog__close:visible').last()).toBeInViewport();
            const overflow = await dialog(page).evaluate(surface => surface.scrollWidth - surface.clientWidth);
            expect(overflow).toBeLessThanOrEqual(0);
        });
    });
}

for (const viewport of WIDE_VIEWPORTS) {
    test(`the sidebar sits beside the chat list at ${viewport.width}x${viewport.height}`, async ({ page }) => {
        await bootArchive(page, viewport, { fixture: bigFixture() });
        await openArchive(page);
        expect(await isCollapsed(page)).toBe(false);
        const first = page.locator('.sbca-location').first();
        await expect(first).toBeVisible();
        await expect(rows(page).first()).toBeVisible();
        const [sidebar, list] = await Promise.all([
            page.locator('.sbca-sidebar').boundingBox(),
            page.locator('.sbca-detail').boundingBox(),
        ]);
        expect(sidebar.x + sidebar.width).toBeLessThanOrEqual(list.x + 1);
        expect(Math.abs(sidebar.y - list.y)).toBeLessThanOrEqual(1);
        expect(sidebar.width).toBeGreaterThanOrEqual(220);
        await expect(page.locator('.sbca-location[aria-pressed="true"]')).toHaveCount(1);
        await expect(page.locator('.sbca-location[aria-pressed="true"]')).toContainText('All Chats');
    });
}

test.describe('the phone flow', () => {
    test.use({ hasTouch: true, isMobile: true });

    test('locations lead to the chat list, the list to a chat, and Back walks the same way out', async ({ page }) => {
        await bootArchive(page, PHONE, { fixture: bigFixture(), chatBody: readLongChat });
        await openArchive(page);
        expect(await isCollapsed(page)).toBe(true);
        await expect(page.locator('.sbca-location').first()).toBeVisible();
        await expect(rows(page).first()).toBeHidden();

        await page.locator('.sbca-location', { hasText: 'Alice' }).first().click();
        await expect(rows(page).first()).toBeVisible();
        await expect(page.locator('.sbca-location').first()).toBeHidden();
        await expect(page.locator('.sbca-dialog .sb-dialog__title').last()).toHaveText('Alice');

        await openRow(page, 'Alice - Long saga');
        await waitForDetail(page);
        await expect(rows(page).first()).toBeHidden();
        await expect(page.locator('.sbca-dialog .sb-dialog__title').last()).toHaveText('Alice - Long saga');

        await goBack(page);
        await expect(rows(page).first()).toBeVisible();
        await goBack(page);
        await expect(page.locator('.sbca-location').first()).toBeVisible();
        await expect(page.locator('.sbca-location[aria-pressed="true"]')).toContainText('Alice');
        await expect(dialog(page)).toBeVisible();
    });
});

test.describe('the selection title on a phone', () => {
    test.use({ hasTouch: true, isMobile: true });

    test('the count shows in full beside Cancel, Select All and Close', async ({ page }) => {
        await bootArchive(page, PHONE, { fixture: bigFixture() });
        await openArchive(page);
        await showList(page);
        await openMenuItem(page, 'Select Chats');
        const title = page.locator('.sbca-dialog .sb-dialog__header.is-selection-mode .sb-dialog__title');
        const fits = () => title.evaluate(node => node.scrollWidth <= node.clientWidth);
        await expect(title).toHaveText('0 selected');
        expect(await fits(), '0 selected').toBe(true);
        for (const index of [0, 1, 2]) await rows(page).nth(index).click();
        await expect(title).toHaveText('3 selected');
        expect(await fits(), '3 selected').toBe(true);
        await page.locator('.sb-dialog__selection-select-all').click();
        await expect(title).toHaveText('142 selected');
        expect(await fits(), '142 selected').toBe(true);
        await expectCleanLayout(page, 'selection with 142 selected');
        for (const control of ['.sb-dialog__selection-cancel', '.sb-dialog__selection-select-all', '.sb-dialog__close:visible']) {
            const box = await page.locator(`.sbca-dialog ${control}`).last().boundingBox();
            expect(box.height, `${control} height`).toBeGreaterThanOrEqual(44);
        }
    });
});

const ARCHIVE_UI = /\/sillybunny-chats-archive\/src\/ui\.js(\?|$)/;

test('the archive code loads on the first open and not before', async ({ page }) => {
    const requested = [];
    page.on('request', request => requested.push(request.url()));
    await bootArchive(page, { width: 1440, height: 900 }, { fixture: bigFixture() });
    await showCharacterList(page);
    expect(requested.some(url => /\/sillybunny-chats-archive\/index\.js(\?|$)/.test(url)), 'the entry point loads at startup').toBe(true);
    expect(requested.filter(url => ARCHIVE_UI.test(url)), 'nothing loads the archive UI yet').toEqual([]);

    await drawerButton(page).click();
    await expect(dialog(page)).toBeVisible();
    expect(requested.filter(url => ARCHIVE_UI.test(url))).toHaveLength(1);

    await page.keyboard.press('Escape');
    await expect(dialog(page)).toHaveCount(0);
    await drawerButton(page).click();
    await expect(dialog(page)).toBeVisible();
    expect(requested.filter(url => ARCHIVE_UI.test(url)), 'a second open reuses the loaded module').toHaveLength(1);
});

test.describe('when the archive code cannot be fetched', () => {
    // The service worker would answer the module request itself, so Playwright could not fail it.
    test.use({ serviceWorkers: 'block' });

    test('one explanation shows, the button stays usable, and the next open retries', async ({ page }) => {
        await bootArchive(page, { width: 1440, height: 900 }, { fixture: bigFixture() });
        await showToasts(page);
        let failing = true;
        await page.route(ARCHIVE_UI, route => (failing ? route.abort() : route.fallback()));
        await showCharacterList(page);
        await drawerButton(page).click();
        await expect(page.getByText('Could not open Chat Archive.')).toBeVisible();
        await expect(dialog(page)).toHaveCount(0);
        await expect(drawerButton(page)).toBeEnabled();

        failing = false;
        await drawerButton(page).click();
        await expect(dialog(page)).toBeVisible();
    });
});
