/* eslint-disable playwright/no-conditional-in-test, playwright/no-conditional-expect -- The phone and the desktop present the same menus differently. */
import { mkdirSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { DESKTOP, PHONE, bootMiscWithChat } from './helpers/dialog-accessibility-surfaces.js';

/*
 * The composer menus are the upstream nodes that Popper places. In the mobile layout (768px wide or narrower) and in a window 360px tall or shorter they are bottom sheets on the same nodes
 * (grab handle, scrim, swipe to close); above it they stay popovers. At both sizes Escape closes them and the focus
 * goes in and comes back to the trigger.
 */

const SHOTS = '/tmp/opencode/composer-menu-sheets';
const MENUS = [
    { name: 'Options menu', node: '#options', trigger: '#options_button', row: '#options .options-content a:visible', title: 'Chat Actions', role: 'group', desktopRole: null },
    { name: 'wand menu', node: '#extensionsMenu', trigger: '#extensionsMenuButton', row: '#extensionsMenu > .extension_container > div:visible, #extensionsMenu > .list-group-item:visible', title: 'Extensions', role: 'list', desktopRole: 'list' },
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
                expect(placement.role).toBe(menu.role);
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

    test('the width crossing 768px closes an open menu and the next opening is a popover that Popper places', async ({ page, baseURL }) => {
        const options = MENUS[0];
        await boot(page, baseURL, PHONE);
        await openMenu(page, options);
        expect((await readPlacement(page, options)).sheet).toBe(true);

        // 450px is the dialogs' breakpoint, not the menus': the open sheet stays.
        await page.setViewportSize({ width: 600, height: 844 });
        await expect(page.locator(options.node)).toBeVisible();
        expect((await readPlacement(page, options)).sheet).toBe(true);

        await page.setViewportSize({ width: 900, height: 844 });
        await expect(page.locator(options.node)).toBeHidden();
        await expect(page.locator('.sb-menu-sheet-scrim')).toHaveCount(0);

        await openMenu(page, options);
        const placement = await readPlacement(page, options);
        expect(placement.sheet).toBe(false);
        expect(placement.handle).toBe(false);
        expect(placement.width).toBeLessThan(placement.viewportWidth / 2);
    });
});

test.describe('in the mobile layout above the dialogs\' 450px breakpoint', () => {
    for (const viewport of [{ width: 600, height: 900 }, { width: 768, height: 1024 }]) {
        test.describe(`at ${viewport.width}x${viewport.height}`, () => {
            test.use({ viewport, isMobile: true, hasTouch: true });

            for (const menu of MENUS) {
                test(`the ${menu.name} is a bottom sheet`, async ({ page, baseURL }) => {
                    await boot(page, baseURL, viewport);
                    await openMenu(page, menu);
                    await waitForFocusIn(page, menu);

                    const placement = await readPlacement(page, menu);
                    expect(placement.sheet).toBe(true);
                    expect(placement.handle).toBe(true);
                    expect(placement.scrim).toBe(true);
                    expect(placement.position).toBe('fixed');
                    expect(placement.width).toBeCloseTo(placement.viewportWidth, 0);
                    expect(placement.bottom).toBeCloseTo(placement.viewportHeight, 0);
                    const rowHeight = await page.locator(menu.row).first().evaluate(row => row.getBoundingClientRect().height);
                    expect(rowHeight).toBeGreaterThanOrEqual(44);
                    await closeMenuWithEscape(page, menu);
                });
            }
        });
    }
});

test.describe('in a short landscape window', () => {
    test.use({ viewport: { width: 700, height: 340 }, isMobile: true, hasTouch: true });

    test('the Options menu is a sheet at 700x340 and at 900x340, and a popover at 900x400', async ({ page, baseURL }) => {
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

        // The height rule has no width limit, and its sheet rules are in a stylesheet that every width loads.
        await page.setViewportSize({ width: 900, height: 340 });
        await openMenu(page, options);
        await waitForFocusIn(page, options);
        const wide = await readPlacement(page, options);
        expect(wide.sheet).toBe(true);
        expect(wide.handle).toBe(true);
        expect(wide.position).toBe('fixed');
        expect(wide.width).toBeCloseTo(wide.viewportWidth, 0);
        expect(wide.bottom).toBeCloseTo(wide.viewportHeight, 0);
        await closeMenuWithEscape(page, options);

        await page.setViewportSize({ width: 900, height: 400 });
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
            expect(placement.role).toBe(menu.desktopRole);
            expect(placement.inlineTransform).not.toBe('');
            expect(placement.transform).not.toBe('none');
            expect(placement.width).toBeLessThan(placement.viewportWidth / 2);
            await page.screenshot({ path: `${SHOTS}/${menu.node.slice(1)}-1440x900.png` });

            await closeMenuWithEscape(page, menu);
        });
    }
});

/*
 * What the menus hold and how they look. The rows follow the menu rules of DESIGN.md: the Options menu ends with its
 * destructive item in a section of its own, a row that its code hides stays hidden, every wand row has the same height,
 * inset and full-strength label, and the image-generation drop-down is an opaque popover beside the wand menu (a sheet
 * above it on a phone).
 */

const LANDSCAPE = { width: 844, height: 390 };

/** The rows of a menu as the user sees them, with the geometry that has to agree between rows. */
function readRows(page, selector) {
    return page.evaluate(sel => {
        const node = document.querySelector(sel);
        const rowSelector = node.id === 'options'
            ? ':scope > .options-content > a'
            : ':scope > .extension_container > div, :scope > :not(.extension_container, .sb-dialog__handle)';
        const rows = [...node.querySelectorAll(rowSelector)].filter(row => row.getClientRects().length > 0);
        return rows.map(row => {
            const box = row.getBoundingClientRect();
            const icon = row.querySelector('i, .extensionsMenuExtensionButton');
            const iconBox = icon?.getBoundingClientRect();
            return {
                id: row.id,
                text: row.textContent.trim().replace(/\s+/g, ' '),
                height: Math.round(box.height),
                iconInset: iconBox ? Math.round(iconBox.left - box.left) : null,
                iconGlyph: icon ? getComputedStyle(icon, '::before').content : null,
                opacity: getComputedStyle(row).opacity,
                labelOpacity: getComputedStyle(row.querySelector('span') ?? row).opacity,
                color: getComputedStyle(row).color,
            };
        });
    }, selector);
}

function readDropdown(page) {
    return page.evaluate(() => {
        const read = element => {
            const box = element.getBoundingClientRect();
            return { left: box.left, top: box.top, right: box.right, bottom: box.bottom };
        };
        const dropdown = document.getElementById('sd_dropdown');
        const wand = document.getElementById('extensionsMenu');
        const style = getComputedStyle(dropdown);
        return {
            dropdown: read(dropdown),
            wand: read(wand),
            background: style.backgroundColor,
            backdrop: style.backdropFilter,
            sheet: dropdown.hasAttribute('data-sb-menu-sheet'),
            rowOpacity: getComputedStyle(dropdown.querySelector('.list-group-item')).opacity,
            rowHeight: dropdown.querySelector('.list-group-item').getBoundingClientRect().height,
            viewport: { width: innerWidth, height: innerHeight },
        };
    });
}

function intersects(a, b) {
    return a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5;
}

async function openDropdownFromWand(page) {
    await openMenu(page, MENUS[1]);
    await waitForFocusIn(page, MENUS[1]);
    await page.locator('#sd_gen').click();
    await expect(page.locator('#sd_dropdown')).toBeVisible();
    await expect.poll(() => page.evaluate(() => getComputedStyle(document.getElementById('sd_dropdown')).opacity)).toBe('1');
}

async function expectDropdownClosesFirst(page) {
    await page.keyboard.press('Escape');
    await expect(page.locator('#sd_dropdown')).toBeHidden();
    await expect(page.locator('#extensionsMenu')).toBeVisible();
    await expect(page.locator('#sd_gen')).toBeFocused();
    await closeMenuWithEscape(page, MENUS[1]);
}

test.describe('the Options menu and the wand menu hold what they should', () => {
    test.use({ viewport: DESKTOP });

    test('the Options menu ends with Delete messages in a section of its own, in Destructive Red, and hides the rows that do not apply', async ({ page, baseURL }) => {
        await boot(page, baseURL, DESKTOP);
        await openMenu(page, MENUS[0]);
        const rows = await readRows(page, '#options');
        const ids = rows.map(row => row.id);
        expect(ids.at(-1)).toBe('option_delete_mes');
        expect(ids.slice(0, -1)).not.toContain('option_delete_mes');
        // Hidden by their own code in a chat that is not a checkpoint, and by the legacy toggle: they stay hidden.
        expect(ids).not.toContain('option_back_to_main');
        expect(ids).not.toContain('option_settings');
        expect(rows.every(row => row.opacity === '1' && row.height === 34)).toBe(true);
        const separators = await page.evaluate(() => [...document.querySelectorAll('#options .options-content > *')]
            .map((node, index, all) => (node.tagName === 'HR' ? all[index + 1]?.id || null : undefined))
            .filter(value => value !== undefined));
        // The last separator sits directly above the destructive item.
        expect(separators.at(-1)).toBe('option_delete_mes');
        const danger = await page.evaluate(() => {
            const probe = document.createElement('span');
            probe.style.color = 'var(--sb-color-danger)';
            document.body.append(probe);
            const expected = getComputedStyle(probe).color;
            probe.remove();
            return { expected, actual: getComputedStyle(document.getElementById('option_delete_mes')).color };
        });
        expect(danger.actual).toBe(danger.expected);
        expect(rows.filter(row => row.color === danger.expected).map(row => row.id)).toEqual(['option_delete_mes']);
    });

    test('every wand row has the same height, inset and full-strength label, and an icon of its own', async ({ page, baseURL }) => {
        await boot(page, baseURL, DESKTOP);
        await openMenu(page, MENUS[1]);
        await waitForFocusIn(page, MENUS[1]);
        const rows = await readRows(page, '#extensionsMenu');
        expect(rows.length).toBeGreaterThan(8);
        expect(new Set(rows.map(row => row.height))).toEqual(new Set([34]));
        expect(new Set(rows.map(row => row.iconInset)).size).toBe(1);
        expect(rows.filter(row => row.opacity !== '1' || row.labelOpacity !== '1').map(row => row.id)).toEqual([]);
        // The rows the shell and an extension add straight to the menu are among them.
        for (const id of ['wand_message_screenshot', 'ica_companions_wand_item', 'ica_tracker_panel_wand_item']) {
            expect(rows.map(row => row.id)).toContain(id);
        }
        // An icon that is not a glyph (none, or the digit the token counter used to show) is a defect.
        expect(rows.filter(row => !row.iconGlyph || row.iconGlyph === 'none' || row.iconGlyph === 'normal' || row.iconGlyph === '"1"').map(row => row.id)).toEqual([]);
        // TTS is off: its playback row is hidden by the extension, and no rule of the shell shows it again.
        expect(rows.map(row => row.id)).not.toContain('ttsExtensionMenuItem');
        // An extension's wrapper only holds its rows: the tab stops and the roles are the rows', never the wrapper's.
        const wrappers = await page.evaluate(() => [...document.querySelectorAll('#extensionsMenu > .extension_container')].map(node => ({
            id: node.id, tabindex: node.getAttribute('tabindex'), role: node.getAttribute('role'), interactable: node.classList.contains('interactable'),
        })));
        expect(wrappers.length).toBeGreaterThan(0);
        expect(wrappers.filter(wrapper => wrapper.tabindex !== null || wrapper.role !== null || wrapper.interactable).map(wrapper => wrapper.id)).toEqual([]);
        await closeMenuWithEscape(page, MENUS[1]);
    });

    test('the composer\'s icon controls have a button role and keep their names', async ({ page, baseURL }) => {
        await boot(page, baseURL, DESKTOP);
        const roles = await page.evaluate(ids => ids.map(id => [id, document.getElementById(id)?.getAttribute('role') ?? null]), [
            'options_button', 'extensionsMenuButton', 'send_but', 'mes_impersonate', 'mes_continue', 'mes_stop', 'sb_prose_polisher_but',
            'stscript_continue', 'stscript_pause', 'stscript_stop',
        ]);
        expect(roles.filter(([, role]) => role !== 'button').map(([id]) => id)).toEqual([]);
        await expect(page.getByRole('button', { name: 'Extensions', exact: true })).toBeVisible();
        await expect(page.getByRole('button', { name: 'Chat Actions', exact: true })).toBeVisible();
    });

    test('the image-generation drop-down opens beside the wand menu on an opaque surface, and Escape closes it before the menu', async ({ page, baseURL }) => {
        await boot(page, baseURL, DESKTOP);
        await openDropdownFromWand(page);
        const placement = await readDropdown(page);
        expect(placement.sheet).toBe(false);
        expect(intersects(placement.dropdown, placement.wand)).toBe(false);
        expect(placement.dropdown.top).toBeGreaterThanOrEqual(0);
        expect(placement.dropdown.bottom).toBeLessThanOrEqual(placement.viewport.height);
        expect(placement.dropdown.right).toBeLessThanOrEqual(placement.viewport.width);
        expect(placement.background).not.toMatch(/rgba\(.*,\s*0(\.\d+)?\)|transparent/);
        expect(placement.background).not.toMatch(/\/\s*0?\.\d/);
        expect(placement.backdrop).toBe('none');
        expect(placement.rowOpacity).toBe('1');
        await expectDropdownClosesFirst(page);
    });
});

test.describe('the image-generation drop-down in a short landscape window', () => {
    test.use({ viewport: LANDSCAPE, isMobile: true, hasTouch: true });

    test('it stays inside the window and does not cover the wand menu', async ({ page, baseURL }) => {
        await boot(page, baseURL, LANDSCAPE);
        await openDropdownFromWand(page);
        const placement = await readDropdown(page);
        expect(placement.sheet).toBe(false);
        expect(intersects(placement.dropdown, placement.wand)).toBe(false);
        expect(placement.dropdown.top).toBeGreaterThanOrEqual(0);
        expect(placement.dropdown.bottom).toBeLessThanOrEqual(placement.viewport.height);
        expect(placement.rowHeight).toBeGreaterThanOrEqual(44);
        await expectDropdownClosesFirst(page);
    });
});

test.describe('the image-generation drop-down on a phone', () => {
    test.use({ viewport: PHONE, isMobile: true, hasTouch: true });

    test('it is a sheet above the wand sheet, opaque, with rows of 44px, and Escape closes it first', async ({ page, baseURL }) => {
        await boot(page, baseURL, PHONE);
        await openDropdownFromWand(page);
        const placement = await readDropdown(page);
        expect(placement.sheet).toBe(true);
        expect(placement.dropdown.left).toBeCloseTo(0, 0);
        expect(placement.dropdown.right).toBeCloseTo(PHONE.width, 0);
        expect(placement.dropdown.bottom).toBeCloseTo(PHONE.height, 0);
        expect(placement.background).not.toMatch(/rgba\(.*,\s*0(\.\d+)?\)|transparent/);
        expect(placement.rowOpacity).toBe('1');
        expect(placement.rowHeight).toBeGreaterThanOrEqual(44);
        const stacking = await page.evaluate(() => ({
            sd: Number(getComputedStyle(document.getElementById('sd_dropdown')).zIndex),
            wand: Number(getComputedStyle(document.getElementById('extensionsMenu')).zIndex),
        }));
        expect(stacking.sd).toBeGreaterThan(stacking.wand);
        await expectDropdownClosesFirst(page);
    });
});
