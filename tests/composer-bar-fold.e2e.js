import { expect, test } from '@playwright/test';
import { openQuietChatForSmoke, waitForAnimationFrames } from './chat-scroll-regression-helpers.js';

/* eslint-disable playwright/no-conditional-in-test, playwright/no-conditional-expect -- Which bound applies depends on how far the bar has folded. */

// The chat column is 55vw by default, so the viewport sets the width of the composer's container.
const SEARCH_MIN_WIDTH = 140;
const SELECT_MIN_WIDTH = 160;

test.use({ viewport: { width: 1440, height: 900 } });

async function setViewport(page, width) {
    await page.setViewportSize({ width, height: 900 });
    await waitForAnimationFrames(page, 4);
    await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 200)));
}

function measureRow(page) {
    return page.evaluate(() => {
        const visible = element => {
            const rect = element.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0 && getComputedStyle(element).display !== 'none';
        };
        const container = document.getElementById('gg-action-button-container');
        const leaves = [...container.querySelectorAll('.stih--button, .gg-action-button, #qr--bar .qr--button')].filter(visible);
        const tops = [];
        for (const leaf of leaves) {
            const rect = leaf.getBoundingClientRect();
            const middle = rect.top + rect.height / 2;
            if (!tops.some(top => Math.abs(top - middle) < 8)) tops.push(middle);
        }
        const bounds = container.getBoundingClientRect();
        const overflow = document.getElementById('gg_overflow_button');
        return {
            rows: tops.length,
            clipped: leaves.filter(leaf => {
                const rect = leaf.getBoundingClientRect();
                return rect.right > bounds.right + 1 || rect.left < bounds.left - 1;
            }).length,
            folded: [...container.querySelectorAll('.gg-action-button[hidden]')].filter(button => button.id !== 'gg_overflow_button').length,
            overflowShown: Boolean(overflow) && visible(overflow),
        };
    });
}

function measureBar(page) {
    return page.evaluate(() => {
        const visible = element => {
            const rect = element?.getBoundingClientRect();
            return Boolean(rect) && rect.width > 0 && rect.height > 0 && getComputedStyle(element).display !== 'none';
        };
        const bar = document.getElementById('sb-bottom-chat-bar');
        const select = document.getElementById('sb-bottom-chat-select');
        const search = bar.querySelector('.sb-bottom-chat-search-field');
        const toggle = bar.querySelector('.sb-bottom-chat-search-toggle');
        const leaves = [...bar.querySelectorAll('#sb-persona-bubble, #sb-bottom-chat-select, .sb-bottom-chat-search-field, .sb-bottom-chat-btn')].filter(visible);
        const tops = [];
        for (const leaf of leaves) {
            const rect = leaf.getBoundingClientRect();
            const middle = rect.top + rect.height / 2;
            if (!tops.some(top => Math.abs(top - middle) < 8)) tops.push(middle);
        }
        const barRect = bar.getBoundingClientRect();
        const foldables = [...document.querySelectorAll('.sb-bottom-chat-nav-actions > .sb-bottom-chat-btn, .sb-bottom-chat-management-actions > .sb-bottom-chat-btn')];
        return {
            rows: tops.length,
            clipped: leaves.filter(leaf => { const r = leaf.getBoundingClientRect(); return r.right > barRect.right + 0.5 || r.left < barRect.left - 0.5; }).length,
            selectWidth: visible(select) ? select.getBoundingClientRect().width : 0,
            searchWidth: visible(search) ? search.getBoundingClientRect().width : 0,
            toggleShown: visible(toggle),
            foldedButtons: foldables.filter(button => button.hidden).length,
            overflowShown: visible(bar.querySelector('.sb-bottom-chat-overflow')),
            docOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        };
    });
}

test.describe('composer row and bottom chat bar on a desktop window', () => {
    test.beforeEach(async ({ page }) => {
        await openQuietChatForSmoke(page);
        await expect(page.locator('#gg-action-button-container')).toBeVisible();
        await expect(page.locator('#sb-bottom-chat-bar')).toBeVisible();
    });

    test('keeps the input-history and Guided Generations row on one row from 769px up', async ({ page }) => {
        for (const width of [769, 900, 1100, 1440]) {
            await setViewport(page, width);
            const row = await measureRow(page);
            expect(row.rows, `${width}px rows`).toBe(1);
            expect(row.clipped, `${width}px clipped`).toBe(0);
        }
    });

    test('folds Guided Generations buttons that do not fit into the menu, and keeps them all at a wide window', async ({ page }) => {
        await setViewport(page, 1440);
        const wide = await measureRow(page);
        expect(wide.folded).toBe(0);
        expect(wide.overflowShown).toBe(false);

        await setViewport(page, 769);
        const narrow = await measureRow(page);
        expect(narrow.overflowShown).toBe(true);
        expect(narrow.folded).toBeGreaterThan(0);

        const overflow = page.locator('#gg_overflow_button');
        await expect(overflow).toHaveAccessibleName('Guided Generations');
        await overflow.click();
        const items = page.locator('.sb-action-popover [role="menuitem"]');
        await expect(items).toHaveCount(narrow.folded);
        await items.first().focus();
        await page.keyboard.press('Escape');
        await expect(page.locator('.sb-action-popover')).toHaveCount(0);
        await expect(overflow).toBeFocused();

        await setViewport(page, 1440);
        expect((await measureRow(page)).folded).toBe(0);
    });

    test('keeps the bottom chat bar on one row at every width and folds in the order of the rule', async ({ page }) => {
        const states = [];
        for (const width of [769, 850, 950, 1050, 1150, 1250, 1300, 1440]) {
            await setViewport(page, width);
            const bar = await measureBar(page);
            states.push({ width, ...bar });
            expect(bar.rows, `${width}px rows`).toBe(1);
            expect(bar.clipped, `${width}px clipped`).toBe(0);
            expect(bar.docOverflow, `${width}px page overflow`).toBe(0);
            if (bar.selectWidth > 0) {
                expect(bar.selectWidth, `${width}px picker`).toBeGreaterThanOrEqual(SELECT_MIN_WIDTH);
            }
            if (bar.searchWidth > 0) {
                expect(bar.searchWidth, `${width}px search`).toBeGreaterThanOrEqual(SEARCH_MIN_WIDTH);
            }
            // The search field folds before any button does, and a folded button always has the menu.
            if (bar.foldedButtons > 0) {
                expect(bar.searchWidth, `${width}px search folds first`).toBe(0);
                expect(bar.overflowShown, `${width}px menu`).toBe(true);
            } else {
                expect(bar.overflowShown, `${width}px no menu without a folded button`).toBe(false);
            }
        }
        const wide = states.at(-1);
        expect(wide.searchWidth).toBeGreaterThan(0);
        expect(wide.foldedButtons).toBe(0);
        expect(states[0].foldedButtons).toBeGreaterThan(0);
        // Narrower never shows more: the folded count does not fall as the window narrows.
        const folded = states.map(state => state.foldedButtons);
        expect(folded).toEqual([...folded].sort((a, b) => b - a));
    });

    test('opens a folded search in the picker\'s place and a folded button from the menu, on the same row', async ({ page }) => {
        await setViewport(page, 1200);
        const folded = await measureBar(page);
        expect(folded.searchWidth).toBe(0);
        expect(folded.toggleShown).toBe(true);

        await page.locator('#sb-bottom-chat-bar .sb-bottom-chat-search-toggle').click();
        await expect(page.locator('#sb-bottom-chat-bar .sb-bottom-chat-search-field')).toBeVisible();
        const open = await measureBar(page);
        expect(open.searchWidth).toBeGreaterThanOrEqual(SEARCH_MIN_WIDTH);
        expect(open.selectWidth).toBe(0);
        expect(open.rows).toBe(1);
        // The toggle ignores a second press inside its debounce window.
        await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 800)));
        await page.locator('#sb-bottom-chat-bar .sb-bottom-chat-search-toggle').click();
        await expect(page.locator('#sb-bottom-chat-select')).toBeVisible();

        await setViewport(page, 769);
        const narrow = await measureBar(page);
        expect(narrow.overflowShown).toBe(true);
        const trigger = page.locator('#sb-bottom-chat-bar .sb-bottom-chat-overflow');
        await expect(trigger).toHaveAccessibleName('Chat Actions');
        await trigger.click();
        const items = page.locator('.sb-action-popover [role="menuitem"]');
        await expect(items).toHaveCount(narrow.foldedButtons);
        await page.locator('.sb-action-popover').getByRole('menuitem', { name: 'Search chat' }).click();
        await expect(page.locator('#sb-bottom-chat-bar')).toHaveClass(/sb-bottom-chat-search-open/);
        expect((await measureBar(page)).rows).toBe(1);
    });
});

test.describe('composer row on a phone', () => {
    test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

    test('folds the arrows and Guided Generations buttons onto one row at the 44px target floor', async ({ page }) => {
        await openQuietChatForSmoke(page);
        const toggle = page.locator('.sb-bottom-chat-tray-toggle');
        await expect(toggle).toBeVisible();
        await toggle.click();
        await expect(page.locator('#gg-action-button-container')).toBeVisible();
        // The tray opens with a short animation that scales its buttons.
        await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 800)));
        const row = await page.evaluate(() => {
            const container = document.getElementById('gg-action-button-container');
            const leaves = [...container.querySelectorAll('.stih--button, .gg-action-button')].filter(leaf => leaf.getBoundingClientRect().width > 0);
            const tops = new Set(leaves.map(leaf => Math.round(leaf.getBoundingClientRect().top)));
            return {
                rows: tops.size,
                smallest: Math.min(...leaves.map(leaf => Math.min(leaf.getBoundingClientRect().width, leaf.getBoundingClientRect().height))),
                folded: container.querySelectorAll('.gg-action-button[hidden]:not(#gg_overflow_button)').length,
                overflow: Boolean(leaves.find(leaf => leaf.id === 'gg_overflow_button')),
            };
        });
        expect(row.rows).toBe(1);
        expect(row.smallest).toBeGreaterThanOrEqual(44);
        expect(row.folded).toBeGreaterThan(0);
        expect(row.overflow).toBe(true);

        // A menu is a sheet on a phone.
        await page.locator('#gg_overflow_button').click();
        await expect(page.locator('.sb-action-sheet')).toBeVisible();
        await expect(page.locator('.sb-action-sheet [role="menuitem"]')).toHaveCount(row.folded);
    });
});
