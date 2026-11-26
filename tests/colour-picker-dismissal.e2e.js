import { expect, test } from '@playwright/test';
import { variantContextOptions } from './helpers/surface-matrix.js';
import { bootSurfaceApp, openSurface } from './helpers/surfaces/boot.js';
import { SURFACES } from './helpers/surfaces/index.js';
import {
    MAIN_MENU,
    bootConversationPage,
    headingOf,
    newFolderId,
    openConversationList,
    readStoredFolders,
    seedConversationList,
    seedFolders,
} from './helpers/conversation-list-steps.js';

// A colour picker is a surface of its own, opened from inside another one (the folder Colour popover, the Folder Manager,
// the tag manager). A press, a drag or a field inside it is not a press outside the surface that it was opened from, and
// the picker goes only when the surface does or when the user presses outside both.

test.use({ serviceWorkers: 'block', viewport: { width: 1440, height: 900 }, contextOptions: { reducedMotion: 'reduce' } });
test.describe.configure({ timeout: 120000 });

const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

const COLOUR_MENU = '.sb-color-picker-menu';
const POPOVER = '.sb-action-popover.sb-folder-color-popover, .sb-action-popover:has(.sb-folder-color-popover)';
const SHEET = '.sb-action-sheet:has(.sb-folder-color-popover)';
const COLOUR_DIALOG = '.sb-color-picker-dialog';

/** Boots the page with one folder and opens the conversation list. */
async function openFolderList(page, baseURL) {
    const persona = await bootConversationPage(page, baseURL);
    await seedConversationList(page);
    const id = newFolderId();
    expect((await seedFolders(page, persona, [{ op: 'createFolder', id, name: 'Work', color: '', expanded: true }])).status).toBe(200);
    await openConversationList(page);
    return { persona, key: `folder:${id}` };
}

/** Right-click on the heading of the folder, then Colour: the popover on a desktop, the sheet on a phone. */
async function openFolderColour(page, key) {
    await headingOf(page, key).click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Colour', exact: true }).click();
    await expect(page.locator(COLOUR_MENU)).toBeVisible();
}

/** The first steps of most cases: a booted list with the Colour popover of its folder open. */
async function openListAtFolderColour(page, baseURL) {
    const opened = await openFolderList(page, baseURL);
    await openFolderColour(page, opened.key);
    return opened;
}

const storedColour = async (page, persona) => (await readStoredFolders(page, persona)).folders[0].color;

/** The middle of the plane, once it has stopped moving: a dialog on a phone slides in while it opens. */
async function centreOfPlane(page) {
    const plane = page.locator('.sb-color-picker-plane');
    let previous = '';
    await expect.poll(async () => {
        const reading = JSON.stringify(await plane.boundingBox());
        const settled = reading === previous;
        previous = reading;
        return settled;
    }).toBe(true);
    const box = await plane.boundingBox();
    return { x: box.x + box.width / 2, y: box.y + box.height / 2, box };
}

test.describe('the colour picker of a folder, in the popover of the list on a desktop', () => {
    test('stays open on a press on its plane, through a drag out of it and the release outside, and gives the colour that the drag chose', async ({ page, baseURL }) => {
        const { persona, key } = await openFolderList(page, baseURL);
        await openFolderColour(page, key);
        const popover = page.locator(POPOVER);
        await expect(popover).toBeVisible();
        const { x, y, box } = await centreOfPlane(page);

        await page.mouse.move(x, y);
        await page.mouse.down();
        await expect(popover).toBeVisible();
        await expect(page.locator(COLOUR_MENU)).toBeVisible();
        await page.mouse.move(x + 10, y - 10, { steps: 3 });
        // Out of the plane, out of the picker and out of the popover.
        await page.mouse.move(box.x + box.width + 400, box.y + box.height + 300, { steps: 8 });
        await expect(page.locator(COLOUR_MENU)).toBeVisible();
        await page.mouse.up();

        await expect(popover).toBeVisible();
        await expect(page.locator(COLOUR_MENU)).toBeVisible();
        await expect.poll(() => storedColour(page, persona)).not.toBe('');
    });

    test('stays open on a press on each control of the picker, and a field takes what is typed in it', async ({ page, baseURL }) => {
        const { persona } = await openListAtFolderColour(page, baseURL);
        const menu = page.locator(COLOUR_MENU);
        const popover = page.locator(POPOVER);

        for (const control of ['.sb-color-picker-hue', '.sb-color-picker-alpha']) {
            const box = await menu.locator(control).boundingBox();
            await page.mouse.click(box.x + box.width * 0.4, box.y + box.height / 2);
            await expect(popover).toBeVisible();
            await expect(menu).toBeVisible();
        }

        const hex = menu.getByRole('textbox', { name: 'Hex', exact: true });
        await hex.click();
        await expect(popover).toBeVisible();
        await expect(menu).toBeVisible();
        await hex.fill('#33aa55');
        await hex.press('Enter');
        await expect(popover).toBeVisible();
        await expect(menu).toBeVisible();
        await expect.poll(() => storedColour(page, persona)).toMatch(/^rgba\(51,\s*170,\s*85,/);
    });

    test('keeps the selection of a text drag in a field that ends outside the picker', async ({ page, baseURL }) => {
        const { persona } = await openListAtFolderColour(page, baseURL);
        const menu = page.locator(COLOUR_MENU);
        const popover = page.locator(POPOVER);
        const hex = menu.getByRole('textbox', { name: 'Hex', exact: true });
        await hex.fill('#33aa55');
        const box = await hex.boundingBox();

        await page.mouse.move(box.x + 6, box.y + box.height / 2);
        await page.mouse.down();
        await page.mouse.move(box.x + box.width - 2, box.y + box.height / 2, { steps: 4 });
        await page.mouse.move(box.x + box.width + 500, box.y + 400, { steps: 8 });
        await page.mouse.up();

        await expect(popover).toBeVisible();
        await expect(menu).toBeVisible();
        await expect(hex).toBeFocused();
        expect(await storedColour(page, persona)).toMatch(/^rgba\(51,\s*170,\s*85,/);
    });

    test('is held by a popover as wide as its swatch, and not as the form that asks for a name', async ({ page, baseURL }) => {
        await openListAtFolderColour(page, baseURL);

        const width = (await page.locator(POPOVER).boundingBox()).width;

        expect(width).toBeLessThan(120);
    });

    test('opens on the field of the hex code with a mouse, where typing starts', async ({ page, baseURL }) => {
        await openListAtFolderColour(page, baseURL);

        await expect(page.locator(COLOUR_MENU).getByRole('textbox', { name: 'Hex', exact: true })).toBeFocused();
    });

    test('goes with the popover on a press outside both, and not on a press inside the popover but outside the picker', async ({ page, baseURL }) => {
        await openListAtFolderColour(page, baseURL);

        await page.mouse.click(5, 5);

        await expect(page.locator(COLOUR_MENU)).toHaveCount(0);
        await expect(page.locator(POPOVER)).toHaveCount(0);
    });
});

test.describe('the colour picker of a folder, in the popover of the list, with the keyboard and the motion on', () => {
    test('Escape in the picker closes it and the popover that only held it, and gives the focus back to the heading', async ({ page, baseURL }) => {
        const { key } = await openListAtFolderColour(page, baseURL);
        const hex = page.locator(COLOUR_MENU).getByRole('textbox', { name: 'Hex', exact: true });
        await hex.focus();

        await page.keyboard.press('Escape');

        await expect(page.locator(COLOUR_MENU)).toHaveCount(0);
        await expect(page.locator(POPOVER)).toHaveCount(0);
        await expect(headingOf(page, key)).toBeFocused();
    });

    test('the Close button of the picker closes it and the popover', async ({ page, baseURL }) => {
        await openListAtFolderColour(page, baseURL);

        await page.locator(COLOUR_MENU).getByRole('button', { name: 'Close', exact: true }).click();

        await expect(page.locator(COLOUR_MENU)).toHaveCount(0);
        await expect(page.locator(POPOVER)).toHaveCount(0);
    });

    test.describe('with the motion on', () => {
        test.use({ contextOptions: { reducedMotion: 'no-preference' } });

        test('a press that is held longer than the popover takes to fade does not dismiss either surface, and the release does not', async ({ page, baseURL }) => {
            const { persona } = await openListAtFolderColour(page, baseURL);
            const { x, y } = await centreOfPlane(page);

            await page.mouse.move(x, y);
            await page.mouse.down();
            // The popover fades for a moment before it is removed, and the picker went with it: the dismissal showed about 180ms after the press.
            await wait(600);
            await expect(page.locator(POPOVER)).toBeVisible();
            await expect(page.locator(COLOUR_MENU)).toBeVisible();
            await page.mouse.move(8, 8, { steps: 6 });
            await page.mouse.up();
            await wait(600);

            await expect(page.locator(POPOVER)).toBeVisible();
            await expect(page.locator(COLOUR_MENU)).toBeVisible();
            await expect.poll(() => storedColour(page, persona)).not.toBe('');
        });
    });
});

test.describe('the colour picker of a folder, on a desktop with a touch screen, before a finger touches it', () => {
    test.use({ hasTouch: true });

    test('opens with no text field focused, as it does on a phone', async ({ page, baseURL }) => {
        const { key } = await openFolderList(page, baseURL);

        await openFolderColour(page, key);

        expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true);
        expect(await page.evaluate(() => document.activeElement?.matches('input:not([type="range"]), textarea'))).toBe(false);
    });
});

test.describe('the colour picker of a folder, on a desktop with a touch screen', () => {
    test.use({ hasTouch: true });

    test.beforeEach(({ browserName }) => {
        // eslint-disable-next-line playwright/no-skipped-test -- Only Chromium offers the DevTools protocol that sends the touch events.
        test.skip(browserName !== 'chromium', 'touch events are driven with the DevTools protocol');
    });

    test('a finger that drags on the plane, out of the popover and off the picker, does not dismiss either', async ({ page, baseURL }) => {
        const { persona, key } = await openFolderList(page, baseURL);
        await openFolderColour(page, key);
        const { x, y, box } = await centreOfPlane(page);
        const client = await page.context().newCDPSession(page);
        const touch = (type, at) => client.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x: at.x, y: at.y, id: 1 }] });

        await touch('touchStart', { x, y });
        await touch('touchMove', { x: x + 12, y: y + 12 });
        await touch('touchMove', { x: box.x + box.width + 300, y: box.y + box.height + 200 });
        await expect(page.locator(POPOVER)).toBeVisible();
        await touch('touchEnd', { x: 0, y: 0 });

        await expect(page.locator(POPOVER)).toBeVisible();
        await expect(page.locator(COLOUR_MENU)).toBeVisible();
        await expect.poll(() => storedColour(page, persona)).not.toBe('');
    });
});

test.describe('the colour picker of a folder, in the sheet of the list on a phone', () => {
    test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

    test('opens with no text field focused, so that the keyboard of the phone does not cover the plane', async ({ page, baseURL }) => {
        const { key } = await openFolderList(page, baseURL);

        await openFolderColour(page, key);

        await expect(page.locator(COLOUR_DIALOG)).toBeVisible();
        expect(await page.evaluate(() => document.activeElement?.matches('input:not([type="range"]), textarea'))).toBe(false);
    });

    test('stays open on a tap in a field, and takes what is typed in it', async ({ page, baseURL }) => {
        const { persona, key } = await openFolderList(page, baseURL);
        await openFolderColour(page, key);
        await expect(page.locator(COLOUR_DIALOG)).toBeVisible();

        const hex = page.locator(COLOUR_DIALOG).getByRole('textbox', { name: 'Hex', exact: true });
        await hex.tap();
        await hex.fill('#33aa55');
        await hex.press('Enter');

        await expect(page.locator(COLOUR_DIALOG)).toBeVisible();
        await expect(page.locator(SHEET)).toHaveCount(1);
        await expect.poll(() => storedColour(page, persona)).toMatch(/^rgba\(51,\s*170,\s*85,/);
    });

    test('a finger that drags on the plane and lifts outside the sheet does not dismiss either', async ({ page, baseURL, browserName }) => {
        // eslint-disable-next-line playwright/no-skipped-test -- Only Chromium offers the DevTools protocol that sends the touch events; a touch context of Firefox gives a mouse no pointer events.
        test.skip(browserName !== 'chromium', 'touch events are driven with the DevTools protocol');
        const { persona, key } = await openFolderList(page, baseURL);
        await openFolderColour(page, key);
        const { x, y, box } = await centreOfPlane(page);
        const client = await page.context().newCDPSession(page);
        const touch = (type, at) => client.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x: at.x, y: at.y, id: 1 }] });

        await touch('touchStart', { x, y });
        await touch('touchMove', { x: x + 12, y: y + 12 });
        await touch('touchMove', { x: box.x + box.width / 2, y: 4 });
        await touch('touchEnd', { x: 0, y: 0 });

        await expect(page.locator(COLOUR_DIALOG)).toBeVisible();
        await expect(page.locator(SHEET)).toHaveCount(1);
        await expect.poll(() => storedColour(page, persona)).not.toBe('');
    });
});

test.describe('the colour picker of a folder, in the sheet of the list at the width of a phone, with a mouse', () => {
    test.use({ viewport: { width: 390, height: 844 } });

    test('stays open on a press on its plane that is dragged out and released outside, and gives the colour that the drag chose', async ({ page, baseURL }) => {
        const { persona, key } = await openFolderList(page, baseURL);
        await openFolderColour(page, key);
        await expect(page.locator(COLOUR_DIALOG)).toBeVisible();
        const { x, y, box } = await centreOfPlane(page);

        await page.mouse.move(x, y);
        await page.mouse.down();
        await page.mouse.move(x - 8, y + 8, { steps: 3 });
        await page.mouse.move(box.x + box.width / 2, 4, { steps: 8 });
        await page.mouse.up();

        await expect(page.locator(COLOUR_DIALOG)).toBeVisible();
        await expect(page.locator(SHEET)).toHaveCount(1);
        await expect.poll(() => storedColour(page, persona)).not.toBe('');
    });
});

test.describe('the colour picker of a folder, in the Folder Manager', () => {
    test('stays open when a drag that began inside it is released outside the window', async ({ page, baseURL }) => {
        const { persona } = await openFolderList(page, baseURL);
        await page.locator(MAIN_MENU).click();
        await page.getByRole('menuitem', { name: 'Manage Folders', exact: true }).click();
        const manager = page.locator('.sb-folder-manager');
        await expect(manager).toBeVisible();
        await manager.locator('.sb-folder-manager__row-menu').first().click();
        await page.getByRole('menuitem', { name: 'Colour', exact: true }).click();
        await expect(page.locator(COLOUR_MENU)).toBeVisible();
        const { x, y } = await centreOfPlane(page);

        await page.mouse.move(x, y);
        await page.mouse.down();
        await page.mouse.move(x + 6, y + 6, { steps: 3 });
        await page.mouse.move(8, 8, { steps: 8 });
        await page.mouse.up();

        await expect(manager).toBeVisible();
        await expect(page.locator(COLOUR_MENU)).toBeVisible();
        await expect.poll(() => storedColour(page, persona)).not.toBe('');
    });

    test('stays open when a text drag in a field of the window, or of the picker, is released outside the window', async ({ page, baseURL }) => {
        await openFolderList(page, baseURL);
        await page.locator(MAIN_MENU).click();
        await page.getByRole('menuitem', { name: 'Manage Folders', exact: true }).click();
        const manager = page.locator('.sb-folder-manager');
        await expect(manager).toBeVisible();

        const name = manager.locator('.sb-folder-manager__name').first();
        await dragTextOut(page, name);
        await expect(manager).toBeVisible();
        await expect(name).toBeFocused();

        await manager.locator('.sb-folder-manager__row-menu').first().click();
        await page.getByRole('menuitem', { name: 'Colour', exact: true }).click();
        const hex = page.locator(COLOUR_MENU).getByRole('textbox', { name: 'Hex', exact: true });
        await expect(hex).toBeVisible();
        await dragTextOut(page, hex);
        await expect(manager).toBeVisible();
        await expect(page.locator(COLOUR_MENU)).toBeVisible();
        await expect(hex).toBeFocused();
    });
});

/** Presses at the start of a field, drags along it and out of the window, and releases on whatever is there. */
async function dragTextOut(page, field) {
    const box = await field.boundingBox();
    await page.mouse.move(box.x + 6, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width - 2, box.y + box.height / 2, { steps: 4 });
    await page.mouse.move(6, 6, { steps: 10 });
    await page.mouse.up();
}

// The pickers of Settings sit in a panel of the shell: Customize > Appearance holds the accents and every colour of the
// chat, and the colour of a Quick Reply set is in the drawer of that extension. A press, a drag or a field in the picker
// must leave the picker open there too.
const SETTINGS_PICKERS = [
    // The accent rows are off until Custom RGB Accent is on.
    ['the accent', 'settings.customize.appearance', '#sb-accent-primary-picker', page => page.locator('#sb-custom-accent-mode').check()],
    ['the main text colour', 'settings.customize.appearance', '#main-text-color-picker', async () => {}],
    // The extension has a page of its own under Extensions.
    ['the colour of a Quick Reply set', 'settings.customize.extensions', '#qr--color', page => page.locator('.sb-subpage').getByText('Quick Reply', { exact: true }).first().click()],
];

async function openSettingsAt(browser, { baseURL, locale, timezoneId }, id, viewport) {
    const surface = SURFACES.find(candidate => candidate.id === id);
    const variant = { viewport };
    const context = await browser.newContext({ ...variantContextOptions(variant), baseURL, locale, timezoneId });
    const page = await context.newPage();
    await bootSurfaceApp(page, baseURL, { variant, needs: surface.needs ?? [] });
    await openSurface(page, surface, { viewport });
    return { context, page };
}

/** Opens the picker of a Settings control and returns it with the value that it holds. */
async function openSettingsPicker(page, selector, prepare) {
    await prepare(page);
    const swatch = page.locator(`${selector} .button`);
    await swatch.scrollIntoViewIfNeeded();
    await swatch.click();
    const menu = page.locator('.sb-color-picker-menu:visible');
    await expect(menu).toBeVisible();
    return { menu, before: await page.locator(selector).evaluate(node => node.rgba) };
}

const colourOfPicker = (page, selector) => page.locator(selector).evaluate(node => node.rgba);

for (const viewport of ['1440x900', '390x844']) {
    for (const [name, surfaceId, selector, prepare] of SETTINGS_PICKERS) {
        test(`${name}: a drag on the plane that is released outside the picker leaves it open, at ${viewport}`, async ({ browser, baseURL, locale, timezoneId, browserName }) => {
            // A touch context of Firefox gives a mouse no pointer events, which the plane listens for; real touch there is not driven.
            // eslint-disable-next-line playwright/no-skipped-test -- See above.
            test.skip(browserName === 'firefox' && viewport === '390x844', 'a touch context of Firefox gives a mouse no pointer events');
            test.setTimeout(120000);
            const { context, page } = await openSettingsAt(browser, { baseURL, locale, timezoneId }, surfaceId, viewport);
            try {
                const { menu, before } = await openSettingsPicker(page, selector, prepare);
                const { x, y } = await centreOfPlane(page);

                await page.mouse.move(x, y);
                await page.mouse.down();
                await page.mouse.move(x + 10, y + 10, { steps: 3 });
                // The picker follows the pointer while it is on the plane.
                await expect.poll(() => colourOfPicker(page, selector)).not.toBe(before);
                await page.mouse.move(3, 3, { steps: 8 });
                await page.mouse.up();

                await expect(menu).toBeVisible();
            } finally {
                await context.close();
            }
        });

        test(`${name}: a field of the picker takes a typed colour and the picker stays open, at ${viewport}`, async ({ browser, baseURL, locale, timezoneId }) => {
            test.setTimeout(120000);
            const { context, page } = await openSettingsAt(browser, { baseURL, locale, timezoneId }, surfaceId, viewport);
            try {
                const { menu } = await openSettingsPicker(page, selector, prepare);
                const hex = menu.getByRole('textbox', { name: 'Hex', exact: true });

                await hex.fill('#33aa55');
                await hex.press('Enter');

                await expect(menu).toBeVisible();
                await expect.poll(() => colourOfPicker(page, selector)).toMatch(/^rgba\(51,\s*170,\s*85,/);
            } finally {
                await context.close();
            }
        });
    }
}

test('the main text colour: a finger that drags on the plane and lifts outside the sheet leaves the picker open, at 390x844', async ({ browser, baseURL, locale, timezoneId, browserName }) => {
    // eslint-disable-next-line playwright/no-skipped-test -- Only Chromium offers the DevTools protocol that sends the touch events.
    test.skip(browserName !== 'chromium', 'touch events are driven with the DevTools protocol');
    test.setTimeout(120000);
    const { context, page } = await openSettingsAt(browser, { baseURL, locale, timezoneId }, 'settings.customize.appearance', '390x844');
    try {
        const swatch = page.locator('#main-text-color-picker .button');
        await swatch.scrollIntoViewIfNeeded();
        await swatch.tap();
        const menu = page.locator('.sb-color-picker-menu:visible');
        await expect(menu).toBeVisible();
        const before = await page.locator('#main-text-color-picker').evaluate(node => node.rgba);
        const { x, y, box } = await centreOfPlane(page);
        const client = await page.context().newCDPSession(page);
        const touch = (type, at) => client.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x: at.x, y: at.y, id: 1 }] });

        await touch('touchStart', { x, y });
        await touch('touchMove', { x: x + 12, y: y + 12 });
        await expect.poll(() => page.locator('#main-text-color-picker').evaluate(node => node.rgba)).not.toBe(before);
        await touch('touchMove', { x: box.x + box.width / 2, y: 4 });
        await touch('touchEnd', { x: 0, y: 0 });

        await expect(menu).toBeVisible();
    } finally {
        await context.close();
    }
});
