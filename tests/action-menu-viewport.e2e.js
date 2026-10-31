import { expect, test } from '@playwright/test';
import { selectSampleCharacter } from './chat-scroll-regression-helpers.js';
import { testSetup } from './frontend/frontent-test-utils.js';
import { installFixtureChats, pickFixtureCharacters } from './helpers/fixture-chats.js';
import { protectMaintainerServer } from './helpers/maintainer-server.js';
import { fetchBodyOrSkip } from './helpers/route-fetch.js';

/*
 * The shared action menu (sillybunny-action-menu.js) as a popover in a short window, and as a bottom
 * sheet on a phone. A popover stays inside the viewport and scrolls its rows; a closed sheet leaves nothing behind.
 */

test.use({ serviceWorkers: 'block' });
test.describe.configure({ timeout: 90_000 });

const STARTUP_TIMEOUT = 30_000;
const UI_TIMEOUT = 5_000;
const SHEET_LEFTOVERS = '.sb-action-sheet, .sb-action-sheet-backdrop, #sb-action-menu';
const homeMenuButton = page => page.locator('#chat > .welcomePanel .sbHomeMenuButton');

// The test data turns the reduced-motion setting on; the animated variants switch it off again.
async function allowMotion(page) {
    await page.route('**/api/settings/get', async route => {
        const fetched = await fetchBodyOrSkip(route, response => response.json());
        if (!fetched) return;
        const { response, body: data } = fetched;
        const settings = JSON.parse(data.settings);
        settings.power_user.reduced_motion = false;
        return route.fulfill({ response, json: { ...data, settings: JSON.stringify(settings) } });
    });
}

async function bootHome(page, { motion = false } = {}) {
    await protectMaintainerServer(page);
    await installFixtureChats(page);
    if (motion) await allowMotion(page);
    await page.goto('/');
    await page.waitForFunction('document.getElementById("preloader") === null', undefined, { timeout: 60_000 });
    await testSetup.waitForAppReady({ page });
    await expect(page.locator('#sheld')).toHaveAttribute('data-sb-home', 'on', { timeout: STARTUP_TIMEOUT });
    await expect(homeMenuButton(page)).toBeVisible({ timeout: STARTUP_TIMEOUT });
}

async function seedChat(page) {
    await page.evaluate(() => document.querySelectorAll('dialog[open]').forEach(dialog => dialog.close()));
    // Closing a popup of the app by hand would leave it half closed, and its late focus change would close the menu.
    // A character with an embedded lorebook opens one, so the helper declines it through its button.
    await selectSampleCharacter(page);
    await page.evaluate(async () => {
        const context = window.SillyTavern.getContext();
        context.chat.length = 0;
        document.querySelector('#chat').replaceChildren();
        for (let index = 0; index < 4; index++) {
            const isUser = index % 2 === 1;
            context.chat.push({
                name: isUser ? 'Tester' : 'Bunny Guide',
                is_user: isUser,
                is_system: false,
                send_date: new Date(Date.UTC(2026, 8, 30, 12, index)).toISOString(),
                mes: `Message ${index}. ${'The glade is quiet tonight. '.repeat(4)}`,
                extra: {},
            });
        }
        await context.printMessages();
    });
}

/** The popover sits inside the window and, when given, inside its bounds. */
async function expectPopoverInsideViewport(page, bounds = null) {
    const geometry = await page.locator('.sb-action-popover').evaluate((popover, boundsSelector) => {
        const rect = popover.getBoundingClientRect();
        const limit = boundsSelector ? document.querySelector(boundsSelector).getBoundingClientRect() : null;
        return {
            rect: { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right },
            viewport: { width: window.innerWidth, height: window.innerHeight },
            limit: limit && { top: limit.top, bottom: limit.bottom, left: limit.left, right: limit.right },
        };
    }, bounds);
    expect(geometry.rect.top).toBeGreaterThanOrEqual(0);
    expect(geometry.rect.left).toBeGreaterThanOrEqual(0);
    expect(geometry.rect.bottom).toBeLessThanOrEqual(geometry.viewport.height);
    expect(geometry.rect.right).toBeLessThanOrEqual(geometry.viewport.width);
    if (geometry.limit) {
        expect(geometry.rect.top).toBeGreaterThanOrEqual(geometry.limit.top);
        expect(geometry.rect.bottom).toBeLessThanOrEqual(geometry.limit.bottom);
    }
}

/** The focused row lies inside both the popover's scrollport and the window. */
async function expectFocusedRowVisible(page, label) {
    const geometry = await page.locator('.sb-action-popover').evaluate(popover => {
        const row = document.activeElement;
        const popoverRect = popover.getBoundingClientRect();
        const rowRect = row.getBoundingClientRect();
        return {
            inMenu: popover.contains(row),
            text: row.textContent.trim(),
            row: { top: rowRect.top, bottom: rowRect.bottom },
            scrollport: { top: popoverRect.top + popover.clientTop, bottom: popoverRect.top + popover.clientTop + popover.clientHeight },
            viewportHeight: window.innerHeight,
        };
    });
    expect(geometry.inMenu, label).toBe(true);
    expect(geometry.row.top, `${label}: ${geometry.text} top`).toBeGreaterThanOrEqual(geometry.scrollport.top - 1);
    expect(geometry.row.bottom, `${label}: ${geometry.text} bottom`).toBeLessThanOrEqual(geometry.scrollport.bottom + 1);
    expect(geometry.row.bottom, `${label}: ${geometry.text} in window`).toBeLessThanOrEqual(geometry.viewportHeight);
}

/** Walks the menu with ArrowDown through the wrap, then End and Home, and checks every stop is visible. */
async function walkMenuByKeyboard(page, bounds = null) {
    const rows = page.locator('.sb-action-popover [role^="menuitem"]:not([aria-disabled="true"])');
    await expect(rows.first()).toBeVisible({ timeout: UI_TIMEOUT });
    // Keys sent before the menu takes focus land on the page behind it, which closes the menu.
    await expect(page.locator('.sb-action-popover')).toBeFocused({ timeout: UI_TIMEOUT });
    const count = await rows.count();
    expect(count).toBeGreaterThan(3);
    await expectPopoverInsideViewport(page, bounds);

    for (let step = 0; step < count; step++) {
        await page.keyboard.press('ArrowDown');
        await expectFocusedRowVisible(page, `ArrowDown ${step + 1}`);
    }
    await page.keyboard.press('ArrowDown');
    await expectFocusedRowVisible(page, 'ArrowDown wraps to the first row');

    await page.keyboard.press('End');
    await expectFocusedRowVisible(page, 'End');
    await expect(rows.last()).toBeFocused();
    await page.keyboard.press('Home');
    await expectFocusedRowVisible(page, 'Home');
    await expect(rows.first()).toBeFocused();
}

const assistantCard = page => page.locator('#chat > .welcomePanel .sbHomeCard:has(button[id$="-menu"])');
const assistantMenuButton = card => card.locator('button[id$="-menu"]');

/**
 * Distance from the right edge of an icon's glyph to its label. The icon box has a fixed width, so a wider
 * glyph spills out of the box and the box-to-label gap alone would not show it.
 */
async function readIconGap(page, name) {
    const row = page.locator('.sb-action-popover .sb-action-menu-item, .sb-action-sheet .sb-action-menu-item').filter({ hasText: name });
    await expect(row).toHaveCount(1);
    return row.evaluate((item) => {
        const icon = item.firstElementChild;
        const box = icon.getBoundingClientRect();
        const glyphWidth = Number.parseFloat(getComputedStyle(icon, '::before').width);
        const glyphRight = box.left + (box.width + glyphWidth) / 2;
        return item.querySelector('.sb-action-menu-label').getBoundingClientRect().left - glyphRight;
    });
}

/** The gap of the main menu's Show Welcome row, which the other menus are matched to. */
async function readMainMenuIconGap(page) {
    await homeMenuButton(page).click();
    await expect(page.getByRole('menuitem', { name: 'Show Welcome', exact: true })).toBeVisible({ timeout: UI_TIMEOUT });
    const gap = await readIconGap(page, 'Show Welcome');
    await page.keyboard.press('Escape');
    await expect(page.locator('.sb-action-popover, .sb-action-sheet')).toHaveCount(0, { timeout: UI_TIMEOUT });
    return gap;
}

/** Opens the Assistant Menu of the first card as it reads with the remembered mode, so either item can be checked. */
async function openAssistantMenuFor(page, lastMode) {
    await page.evaluate(async (mode) => {
        const { openAssistantMenu } = await import('/scripts/sillybunny-home/menu.js');
        const trigger = document.querySelector('#chat > .welcomePanel .sbHomeCard button[id$="-menu"]');
        openAssistantMenu(trigger, { lastMode: mode, actions: { newChatInMode() {} } }, { bounds: document.querySelector('#chat > .welcomePanel') });
    }, lastMode);
}

test.describe('short landscape window (844x390), where the menu is still a popover', () => {
    test.use({ viewport: { width: 844, height: 390 } });

    test('the Home main menu stays inside the window and scrolls to its last row by keyboard', async ({ page }) => {
        await bootHome(page);
        await homeMenuButton(page).click();
        await expect(page.locator('.sb-action-popover')).toBeVisible({ timeout: UI_TIMEOUT });
        await expect(page.locator('.sb-action-sheet')).toHaveCount(0);

        await walkMenuByKeyboard(page);
    });

    test('the message menu stays inside the window and its chat, and scrolls to its last row by keyboard', async ({ page }) => {
        await bootHome(page);
        await seedChat(page);
        const message = page.locator('#chat .mes').first();
        await expect(message).toBeVisible({ timeout: STARTUP_TIMEOUT });
        await message.locator('.ch_name').first().click({ button: 'right' });
        await expect(page.locator('.sb-action-popover')).toBeVisible({ timeout: UI_TIMEOUT });

        await walkMenuByKeyboard(page, '#chat');
    });

    test('a menu opened from a trigger at the window edge stays inside a short bounds element', async ({ page }) => {
        await bootHome(page);
        await page.evaluate(async () => {
            const frame = document.createElement('div');
            frame.id = 'qa-bounds';
            frame.style.cssText = 'position: fixed; inset: 40px 40px auto auto; width: 400px; height: 170px;';
            const trigger = document.createElement('button');
            trigger.id = 'qa-trigger';
            trigger.textContent = 'Menu';
            trigger.style.cssText = 'position: absolute; inset: 70px 0 auto auto; height: 40px;';
            frame.append(trigger);
            document.body.append(frame);
            const { openActionMenu } = await import('/scripts/sillybunny-action-menu.js');
            const rows = Array.from({ length: 8 }, (_, index) => ({ label: `Row ${index + 1}`, onSelect() {} }));
            openActionMenu({ trigger, sections: [{ items: rows }], bounds: frame });
        });
        await expect(page.locator('.sb-action-popover')).toBeVisible({ timeout: UI_TIMEOUT });

        await expectPopoverInsideViewport(page, '#qa-bounds');
    });
});

test.describe('short landscape phone (844x390, coarse pointer), where rows are 44px', () => {
    test.use({ viewport: { width: 844, height: 390 }, isMobile: true, hasTouch: true });

    test('the Home main menu ends above the window edge and reaches its last row by keyboard', async ({ page }) => {
        await bootHome(page);
        await homeMenuButton(page).click();
        await expect(page.locator('.sb-action-popover')).toBeVisible({ timeout: UI_TIMEOUT });
        await expect(page.locator('.sb-action-sheet')).toHaveCount(0);

        const bottom = await page.locator('.sb-action-popover').evaluate(popover => popover.getBoundingClientRect().bottom);
        expect(bottom).toBeLessThanOrEqual(390 - 8);
        await walkMenuByKeyboard(page);
    });

    test('an Assistant Menu from a card in the tall Home panel stays above the window edge', async ({ page }) => {
        await bootHome(page);
        await assistantMenuButton(assistantCard(page).first()).click();
        await expect(page.locator('.sb-action-popover')).toBeVisible({ timeout: UI_TIMEOUT });

        const bottom = await page.locator('.sb-action-popover').evaluate(popover => popover.getBoundingClientRect().bottom);
        expect(bottom).toBeLessThanOrEqual(390 - 8);
        await expectPopoverInsideViewport(page, '#chat > .welcomePanel');
    });
});

test.describe('Home menus at 1440x900', () => {
    test.use({ viewport: { width: 1440, height: 900 } });

    test('an Assistant Menu stays within the inline extent of its own card', async ({ page }) => {
        await bootHome(page);
        const cards = assistantCard(page);
        const count = await cards.count();
        expect(count).toBeGreaterThan(1);

        for (let index = 0; index < count; index++) {
            await assistantMenuButton(cards.nth(index)).click();
            await expect(page.locator('.sb-action-popover')).toBeVisible({ timeout: UI_TIMEOUT });
            const extent = await cards.nth(index).evaluate((card) => {
                const popover = document.querySelector('.sb-action-popover').getBoundingClientRect();
                const bounds = card.getBoundingClientRect();
                return { popoverLeft: popover.left, popoverRight: popover.right, cardLeft: bounds.left, cardRight: bounds.right };
            });
            expect(extent.popoverLeft, `card ${index} left`).toBeGreaterThanOrEqual(extent.cardLeft - 8);
            expect(extent.popoverRight, `card ${index} right`).toBeLessThanOrEqual(extent.cardRight + 8);
            await page.keyboard.press('Escape');
            await expect(page.locator('.sb-action-popover')).toHaveCount(0, { timeout: UI_TIMEOUT });
        }
    });

    test('the Assistant Menu item keeps the same gap between its icon and its label as the main menu', async ({ page }) => {
        await bootHome(page);
        const mainGap = await readMainMenuIconGap(page);

        for (const lastMode of ['roleplay', 'conversation']) {
            await openAssistantMenuFor(page, lastMode);
            await expect(page.locator('.sb-action-popover')).toBeVisible({ timeout: UI_TIMEOUT });
            const gap = await readIconGap(page, 'New Chat in');
            expect(Math.abs(gap - mainGap), `${lastMode}: ${gap}px against ${mainGap}px`).toBeLessThanOrEqual(0.5);
            await page.keyboard.press('Escape');
            await expect(page.locator('.sb-action-popover')).toHaveCount(0, { timeout: UI_TIMEOUT });
        }
    });

    test('the Recent Chats row menu keeps aligning to the end of its button', async ({ page }) => {
        await bootHome(page);
        const [character] = await pickFixtureCharacters(page, 1);
        await page.route('**/api/chats/recent', route => route.fulfill({ json: [{
            file_name: `${character.chat}.jsonl`, avatar: character.avatar, last_mes: Date.now(), mes: 'Fixture message', chat_items: 3, file_size: '1kb',
        }] }));
        await page.evaluate(async () => {
            const { openWelcomeScreen } = await import('/scripts/welcome-screen.js');
            await openWelcomeScreen({ force: true });
        });
        const row = page.locator('#chat > .welcomePanel .recentChat').first();
        await expect(row).toBeVisible({ timeout: STARTUP_TIMEOUT });
        const button = row.locator('.chatMenu');
        await button.click();
        await expect(page.locator('.sb-action-popover')).toBeVisible({ timeout: UI_TIMEOUT });

        const { popoverRight, buttonRight } = await button.evaluate(node => ({
            popoverRight: document.querySelector('.sb-action-popover').getBoundingClientRect().right,
            buttonRight: node.getBoundingClientRect().right,
        }));
        expect(Math.abs(popoverRight - buttonRight)).toBeLessThanOrEqual(1);
    });
});

test.describe('phone (390x844), where the menu is a bottom sheet', () => {
    test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

    const CLOSE_PATHS = {
        'choosing an item': page => page.getByRole('menuitemradio', { name: 'Compact', exact: true }).click(),
        Escape: page => page.keyboard.press('Escape'),
        'the backdrop': page => page.locator('.sb-action-sheet-backdrop').click({ position: { x: 24, y: 24 } }),
        'the close button': page => page.locator('.sb-action-sheet-close').click(),
    };

    for (const [motionName, motion] of [['with reduced motion', false], ['with motion', true]]) {
        test.describe(`${motionName}`, () => {
            for (const [path, close] of Object.entries(CLOSE_PATHS)) {
                test(`closing by ${path} removes the sheet, its backdrop and its menu`, async ({ page }) => {
                    await bootHome(page, { motion });

                    await homeMenuButton(page).click();
                    await expect(page.locator('.sb-action-sheet')).toBeVisible({ timeout: UI_TIMEOUT });
                    await expect(page.locator('#sb-action-menu')).toHaveCount(1);
                    await close(page);

                    await expect(page.locator(SHEET_LEFTOVERS)).toHaveCount(0, { timeout: UI_TIMEOUT });
                    await expect(homeMenuButton(page)).toHaveAttribute('aria-expanded', 'false');
                    await expect(homeMenuButton(page)).not.toHaveAttribute('aria-controls', /.*/);

                    await homeMenuButton(page).click();
                    await expect(page.locator('.sb-action-sheet')).toBeVisible({ timeout: UI_TIMEOUT });
                    await expect(page.locator('.sb-action-sheet')).toHaveCount(1);
                    await expect(page.locator('#sb-action-menu')).toHaveCount(1);
                    await expect(page.getByRole('menuitemradio', { name: 'Full', exact: true })).toBeVisible();
                    await page.keyboard.press('Escape');
                    await expect(page.locator(SHEET_LEFTOVERS)).toHaveCount(0, { timeout: UI_TIMEOUT });
                });
            }
        });
    }

    test('a menu that opens as a popover after a sheet closed is the one its trigger controls', async ({ page }) => {
        await bootHome(page);
        await homeMenuButton(page).click();
        await expect(page.locator('.sb-action-sheet')).toBeVisible({ timeout: UI_TIMEOUT });
        await page.keyboard.press('Escape');
        await expect(page.locator(SHEET_LEFTOVERS)).toHaveCount(0, { timeout: UI_TIMEOUT });

        await page.setViewportSize({ width: 844, height: 600 });
        await homeMenuButton(page).click();
        await expect(page.locator('.sb-action-popover')).toBeVisible({ timeout: UI_TIMEOUT });

        await expect(page.locator('#sb-action-menu')).toHaveCount(1);
        const controlled = await homeMenuButton(page).evaluate(button => {
            const menu = document.getElementById(button.getAttribute('aria-controls'));
            return Boolean(menu?.closest('.sb-action-popover'));
        });
        expect(controlled).toBe(true);
    });

    test('the Assistant Menu item in the sheet keeps the same gap between its icon and its label as the main menu', async ({ page }) => {
        await bootHome(page);
        const mainGap = await readMainMenuIconGap(page);

        await openAssistantMenuFor(page, 'roleplay');
        await expect(page.locator('.sb-action-sheet')).toBeVisible({ timeout: UI_TIMEOUT });
        const gap = await readIconGap(page, 'New Chat in');

        expect(Math.abs(gap - mainGap), `${gap}px against ${mainGap}px`).toBeLessThanOrEqual(0.5);
    });
});
