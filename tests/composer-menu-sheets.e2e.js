/* eslint-disable playwright/no-conditional-in-test, playwright/no-conditional-expect -- The phone and the desktop present the same menus differently. */
import { mkdirSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { DESKTOP, PHONE, bootMiscWithChat } from './helpers/dialog-accessibility-surfaces.js';

/*
 * The composer menus are the upstream nodes that Popper places. Under the overlay breakpoint (450px wide, or 360px tall up to 768px wide) they are bottom sheets on the same nodes
 * (grab handle, scrim, swipe to close); above it they stay popovers. At both sizes Escape closes them and the focus
 * goes in and comes back to the trigger.
 */

const SHOTS = '/tmp/opencode/composer-menu-sheets';
const MENUS = [
    { name: 'Options menu', node: '#options', trigger: '#options_button', row: '#options .options-content a:visible', title: 'Chat Actions' },
    { name: 'wand menu', node: '#extensionsMenu', trigger: '#extensionsMenuButton', row: '#extensionsMenu > .extension_container > div:visible, #extensionsMenu > .list-group-item:visible', title: 'Extensions' },
];

test.describe.configure({ timeout: 120_000 });

async function openMenu(page, menu) {
    await page.locator(menu.trigger).click();
    await expect(page.locator(menu.node)).toBeVisible();
}

async function waitForFocusIn(page, menu) {
    await expect.poll(() => page.evaluate(selector => document.querySelector(selector)?.contains(document.activeElement) ?? false, menu.node)).toBe(true);
}

async function closeMenuWithEscape(page, menu) {
    await page.keyboard.press('Escape');
    await expect(page.locator(menu.node)).toBeHidden();
    await expect(page.locator(menu.trigger)).toBeFocused();
}

/** What Popper wrote on the node and what the browser resolved from it. */
function readPlacement(page, menu) {
    return page.evaluate(selector => {
        const node = document.querySelector(selector);
        const box = node.getBoundingClientRect();
        const style = getComputedStyle(node);
        return {
            inlineTransform: node.style.transform,
            transform: style.transform,
            position: style.position,
            sheet: node.hasAttribute('data-sb-menu-sheet'),
            handle: Boolean(node.querySelector(':scope > .sb-dialog__handle')),
            scrim: Boolean(node.previousElementSibling?.classList.contains('sb-menu-sheet-scrim')),
            left: box.left,
            right: box.right,
            bottom: box.bottom,
            width: box.width,
            viewportWidth: innerWidth,
            viewportHeight: innerHeight,
            label: node.getAttribute('aria-label'),
            role: node.getAttribute('role'),
        };
    }, menu.node);
}

async function boot(page, baseURL, viewport) {
    await bootMiscWithChat(page, baseURL, viewport, { motion: false });
    await expect(page.locator('#extensionsMenuButton')).toBeVisible();
}

test.describe('on a phone', () => {
    test.use({ viewport: PHONE, isMobile: true, hasTouch: true });

    for (const menu of MENUS) {
        test(`the ${menu.name} is a bottom sheet with a handle and a scrim, and Escape closes it and returns the focus`, async ({ page, baseURL }) => {
            mkdirSync(SHOTS, { recursive: true });
            await boot(page, baseURL, PHONE);
            if (menu.trigger === '#options_button') {
                await expect(page.locator(menu.trigger)).toHaveRole('button');
                await expect(page.locator(menu.trigger)).toHaveAccessibleName('Chat Actions');
                await expect(page.locator(menu.trigger)).toHaveAttribute('title', 'Chat Actions');
            }
            await openMenu(page, menu);
            await waitForFocusIn(page, menu);

            const placement = await readPlacement(page, menu);
            expect(placement.sheet).toBe(true);
            expect(placement.handle).toBe(true);
            expect(placement.scrim).toBe(true);
            // Popper's inline transform is still there and does not move the sheet.
            expect(placement.inlineTransform).not.toBe('');
            expect(placement.transform).toBe('none');
            expect(placement.position).toBe('fixed');
            expect(placement.left).toBeCloseTo(0, 0);
            expect(placement.width).toBeCloseTo(placement.viewportWidth, 0);
            expect(placement.bottom).toBeCloseTo(placement.viewportHeight, 0);
            if (menu.title) {
                expect(placement.role).toBe('dialog');
                expect(placement.label).toBe(menu.title);
            }
            await expect(page.locator(`${menu.node} > .sb-dialog__handle`)).toBeVisible();
            const scrim = await page.locator(`${menu.node}`).evaluate(node => {
                const box = node.previousElementSibling.getBoundingClientRect();
                return { width: box.width, height: box.height, opacity: getComputedStyle(node.previousElementSibling).opacity };
            });
            expect(scrim.width).toBeCloseTo(PHONE.width, 0);
            expect(scrim.height).toBeCloseTo(PHONE.height, 0);
            const rowHeight = await page.locator(menu.row).first().evaluate(row => row.getBoundingClientRect().height);
            expect(rowHeight).toBeGreaterThanOrEqual(44);
            await page.screenshot({ path: `${SHOTS}/${menu.node.slice(1)}-390x844.png` });

            await closeMenuWithEscape(page, menu);
            await expect(page.locator(`${menu.node} > .sb-dialog__handle`)).toHaveCount(0);
            await expect(page.locator('.sb-menu-sheet-scrim')).toHaveCount(0);

            // The next opening is a sheet again with the same Popper styles in place.
            await openMenu(page, menu);
            expect((await readPlacement(page, menu)).sheet).toBe(true);
            await closeMenuWithEscape(page, menu);
        });

        test(`a swipe down from the handle closes the ${menu.name}, a press on the handle does not, and a press on the scrim does`, async ({ page, baseURL }) => {
            await boot(page, baseURL, PHONE);
            await openMenu(page, menu);
            await waitForFocusIn(page, menu);
            const handle = page.locator(`${menu.node} > .sb-dialog__handle`);
            await expect(handle).toBeVisible();
            const handleBox = await handle.boundingBox();
            const x = handleBox.x + handleBox.width / 2;
            const y = handleBox.y + handleBox.height / 2;

            await handle.click();
            await expect(page.locator(menu.node)).toBeVisible();

            const nodeBox = await page.locator(menu.node).boundingBox();
            const dragged = await page.evaluate(async ([selector, startX, startY, distance]) => {
                const node = document.querySelector(selector);
                const target = node.querySelector(':scope > .sb-dialog__handle');
                const fire = (type, clientY) => target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 7, pointerType: 'touch', clientX: startX, clientY, button: 0 }));
                fire('pointerdown', startY);
                fire('pointermove', startY + distance / 2);
                fire('pointermove', startY + distance);
                await new Promise(resolve => requestAnimationFrame(resolve));
                const moved = getComputedStyle(node).translate;
                fire('pointerup', startY + distance);
                return moved;
            }, [menu.node, x, y, Math.max(120, nodeBox.height * 0.6)]);
            // The finger moves the sheet with `translate`, which leaves Popper's transform to Popper.
            expect(dragged).not.toBe('none');
            await expect(page.locator(menu.node)).toBeHidden();
            await expect(page.locator('.sb-menu-sheet-scrim')).toHaveCount(0);
            await expect(page.locator(menu.node)).toHaveCSS('translate', 'none');

            await openMenu(page, menu);
            await waitForFocusIn(page, menu);
            await page.locator(`${menu.node}`).evaluate(node => node.previousElementSibling.click());
            await expect(page.locator(menu.node)).toBeHidden();
        });
    }

    test('a row that an extension adds to the wand menu while it is open is in the sheet', async ({ page, baseURL }) => {
        const wand = MENUS[1];
        await boot(page, baseURL, PHONE);
        await openMenu(page, wand);
        await waitForFocusIn(page, wand);

        await page.evaluate(() => {
            const row = document.createElement('div');
            row.id = 'qa_extension_row';
            row.className = 'list-group-item flex-container flexGap5';
            row.textContent = 'Added at runtime';
            document.getElementById('extensionsMenu').append(row);
        });

        const row = page.locator('#qa_extension_row');
        await expect(row).toBeAttached();
        // The sheet scrolls when its rows are taller than it, so the added row is brought into view first.
        await row.scrollIntoViewIfNeeded();
        await expect(row).toBeVisible();
        const geometry = await page.evaluate(() => {
            const sheet = document.getElementById('extensionsMenu').getBoundingClientRect();
            const row = document.getElementById('qa_extension_row').getBoundingClientRect();
            return { sheetTop: sheet.top, sheetBottom: sheet.bottom, rowTop: row.top, rowBottom: row.bottom, rowHeight: row.height };
        });
        expect(geometry.rowHeight).toBeGreaterThanOrEqual(44);
        expect(geometry.rowTop).toBeGreaterThanOrEqual(geometry.sheetTop);
        expect(geometry.rowBottom).toBeLessThanOrEqual(geometry.sheetBottom + 1);
        expect((await readPlacement(page, wand)).handle).toBe(true);
        await closeMenuWithEscape(page, wand);
    });

    test('the width crossing 450px closes an open menu and the next opening is a popover that Popper places', async ({ page, baseURL }) => {
        const options = MENUS[0];
        await boot(page, baseURL, PHONE);
        await openMenu(page, options);
        expect((await readPlacement(page, options)).sheet).toBe(true);

        await page.setViewportSize({ width: 600, height: 844 });
        await expect(page.locator(options.node)).toBeHidden();
        await expect(page.locator('.sb-menu-sheet-scrim')).toHaveCount(0);

        await openMenu(page, options);
        const placement = await readPlacement(page, options);
        expect(placement.sheet).toBe(false);
        expect(placement.handle).toBe(false);
        expect(placement.width).toBeLessThan(placement.viewportWidth / 2);
    });
});

test.describe('in a short landscape window', () => {
    test.use({ viewport: { width: 700, height: 340 }, isMobile: true, hasTouch: true });

    test('the Options menu is a sheet at 700x340 and a popover at 900x340', async ({ page, baseURL }) => {
        const options = MENUS[0];
        await boot(page, baseURL, { width: 700, height: 340 });
        await openMenu(page, options);
        await waitForFocusIn(page, options);
        const sheet = await readPlacement(page, options);
        expect(sheet.sheet).toBe(true);
        expect(sheet.handle).toBe(true);
        expect(sheet.scrim).toBe(true);
        expect(sheet.width).toBeCloseTo(sheet.viewportWidth, 0);
        expect(sheet.bottom).toBeCloseTo(sheet.viewportHeight, 0);
        await closeMenuWithEscape(page, options);

        // Wider than the phone stylesheet's 768px: no sheet rules load, so the popover stays.
        await page.setViewportSize({ width: 900, height: 340 });
        await openMenu(page, options);
        const popover = await readPlacement(page, options);
        expect(popover.sheet).toBe(false);
        expect(popover.handle).toBe(false);
        expect(popover.width).toBeLessThan(popover.viewportWidth / 2);
    });
});

test.describe('on a desktop', () => {
    test.use({ viewport: DESKTOP });

    for (const menu of MENUS) {
        test(`the ${menu.name} stays a popover that Popper places, and Escape closes it and returns the focus`, async ({ page, baseURL }) => {
            mkdirSync(SHOTS, { recursive: true });
            await boot(page, baseURL, DESKTOP);
            await openMenu(page, menu);
            await waitForFocusIn(page, menu);

            const placement = await readPlacement(page, menu);
            expect(placement.sheet).toBe(false);
            expect(placement.handle).toBe(false);
            expect(placement.scrim).toBe(false);
            expect(placement.role).not.toBe('dialog');
            expect(placement.inlineTransform).not.toBe('');
            expect(placement.transform).not.toBe('none');
            expect(placement.width).toBeLessThan(placement.viewportWidth / 2);
            await page.screenshot({ path: `${SHOTS}/${menu.node.slice(1)}-1440x900.png` });

            await closeMenuWithEscape(page, menu);
        });
    }
});
