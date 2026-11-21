import { expect, test } from '@playwright/test';
import { gunzipSync } from 'node:zlib';
import { waitForAppReady } from './helpers/app-ready.js';
import { protectMaintainerServer } from './helpers/maintainer-server.js';

/* eslint-disable playwright/no-conditional-in-test -- The header shows the Search button at wide widths and folds it into More on a phone. */

const CHARACTER_COUNT = 60;
const PAGE_SIZE = 50;
const list = page => page.locator('.sb-character-list[data-mounted="true"]');
const rows = page => list(page).locator('.character_select');
const showMore = page => list(page).locator('.sb-list-show-more__button');
const stops = page => list(page).locator('.sb-character-list__rows [tabindex="0"], #rm_print_characters_block [tabindex="0"]');
const activeKind = page => page.evaluate(() => {
    const active = document.activeElement;
    if (!active) return null;
    if (active.matches('.ds-entity-row')) return 'row';
    if (active.matches('.sb-list-show-more__button')) return 'show-more';
    return active.getAttribute('aria-label') ?? active.className;
});

test.beforeEach(async ({ page }) => {
    await protectMaintainerServer(page);
    const characters = Array.from({ length: CHARACTER_COUNT }, (_, index) => {
        const name = `QA character ${String(index).padStart(2, '0')}`;
        const data = {
            name, description: '', personality: '', scenario: '', first_mes: 'QA greeting', mes_example: '',
            creator_notes: '', system_prompt: '', post_history_instructions: '', alternate_greetings: [],
            tags: [], creator: '', character_version: '', extensions: { fav: false, talkativeness: 0.5 },
        };
        return {
            ...data, avatar: `qa-keys-character-${index}.png`, chat: `qa-keys-character-chat-${index}`,
            create_date: `2026-10-${String(index % 28 + 1).padStart(2, '0')}`, date_added: index + 1,
            spec: 'chara_card_v2', spec_version: '2.0', data,
        };
    });
    await page.route('**/api/characters/all', route => route.fulfill({ json: characters }));
    await page.route('**/api/characters/get', route => {
        const body = route.request().postDataBuffer();
        const payload = JSON.parse((route.request().headers()['content-encoding'] === 'gzip' ? gunzipSync(body) : body).toString());
        return route.fulfill({ json: characters.find(character => character.avatar === payload.avatar_url) });
    });
    await page.route('**/api/characters/chats', route => route.fulfill({ json: {} }));
    await page.route('**/api/chats/get', route => route.fulfill({ json: [] }));
    await page.route('**/api/settings/save', route => {
        const request = route.request();
        const body = request.headers()['content-encoding'] === 'gzip' ? gunzipSync(request.postDataBuffer()) : request.postDataBuffer();
        return route.fulfill({ json: { result: 'ok', version: JSON.parse(body.toString())._version + 1 } });
    });
    for (const endpoint of ['groups/edit', 'chats/group/save', 'chats/save', 'characters/edit', 'characters/edit-attribute', 'characters/merge-attributes']) {
        await page.route(`**/api/${endpoint}`, route => route.fulfill({ json: {} }));
    }
    await page.route(/\/api\/(?:characters|groups|chats)\/(?:create|delete|duplicate|rename)$/, route => route.abort());
});

async function openCharacters(page, viewport, { grid = false } = {}) {
    await page.setViewportSize(viewport);
    await page.goto('/');
    await waitForAppReady(page);
    await page.waitForFunction(() => !document.getElementById('preloader'));
    await page.evaluate(async grid => {
        const { power_user } = await import('/scripts/power-user.js');
        power_user.bogus_folders = false;
        power_user.charListGrid = grid;
        document.body.classList.toggle('charListGrid', grid);
        await window.SillyBunnyShell.openTab('characters', 'characters');
    }, grid);
    await expect(list(page)).toBeVisible();
    await expect(rows(page)).toHaveCount(PAGE_SIZE);
}

/** Presses Tab from the control before the list until Show More (the first control after it) has focus; returns the presses. */
async function tabsThroughList(page) {
    await list(page).locator('.sb-character-list__filters button').last().focus();
    for (let presses = 1; presses <= 80; presses++) {
        await page.keyboard.press('Tab');
        if (await activeKind(page) === 'show-more') return presses;
    }
    return Infinity;
}

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    test.describe(`Characters by keyboard at ${viewport.width}px`, () => {
        test('the list is one Tab stop, and its controls follow their row', async ({ page }) => {
            await openCharacters(page, viewport);
            await expect(stops(page)).toHaveCount(1);
            // One stop for the list (the row), one for each of its two controls, then Show More.
            expect(await tabsThroughList(page)).toBeLessThanOrEqual(4);

            await rows(page).nth(3).focus();
            await page.keyboard.press('Tab');
            await expect(rows(page).nth(3).getByRole('button', { name: 'Edit', exact: true })).toBeFocused();
            await page.keyboard.press('Tab');
            await expect(rows(page).nth(3).getByRole('button', { name: /^Actions for / })).toBeFocused();
            await page.keyboard.press('Tab');
            expect(await activeKind(page)).toBe('show-more');
            await page.keyboard.press('Shift+Tab');
            await page.keyboard.press('Shift+Tab');
            await page.keyboard.press('Shift+Tab');
            await expect(rows(page).nth(3)).toBeFocused();
            await page.keyboard.press('Shift+Tab');
            expect(await page.evaluate(() => document.activeElement?.closest('.sb-character-list__rows, #rm_print_characters_block'))).toBeNull();
        });

        test('Shift+Tab into a list that has no selected or visited row enters on its last row', async ({ page }) => {
            await openCharacters(page, viewport);
            await showMore(page).focus();
            await page.keyboard.press('Shift+Tab');
            await expect(rows(page).last()).toBeFocused();
            await expect(stops(page)).toHaveCount(1);
            await page.keyboard.press('Shift+Tab');
            expect(await page.evaluate(() => document.activeElement?.closest('.sb-character-list__rows, #rm_print_characters_block'))).toBeNull();
            // A later visit goes back to the row that was left: its last control comes last in the page order.
            await showMore(page).focus();
            await page.keyboard.press('Shift+Tab');
            await expect(rows(page).last().getByRole('button', { name: /^Actions for / })).toBeFocused();
        });

        test('the arrow keys, Home, End and Page Down move between rows and the stop follows focus', async ({ page }) => {
            await openCharacters(page, viewport);
            await rows(page).first().focus();
            await page.keyboard.press('ArrowDown');
            await expect(rows(page).nth(1)).toBeFocused();
            await expect(rows(page).nth(1)).toHaveAttribute('tabindex', '0');
            await expect(rows(page).first()).toHaveAttribute('tabindex', '-1');
            await expect(stops(page)).toHaveCount(1);
            await page.keyboard.press('ArrowUp');
            await expect(rows(page).first()).toBeFocused();
            await page.keyboard.press('ArrowUp');
            await expect(rows(page).first()).toBeFocused();
            await page.keyboard.press('End');
            await expect(rows(page).last()).toBeFocused();
            await page.keyboard.press('Home');
            await expect(rows(page).first()).toBeFocused();
            await page.keyboard.press('PageDown');
            const paged = await rows(page).evaluateAll(nodes => nodes.indexOf(document.activeElement));
            expect(paged).toBeGreaterThan(1);
            await page.keyboard.press('PageUp');
            await expect(rows(page).first()).toBeFocused();
            // The row the focus left keeps the stop for the next visit.
            await rows(page).nth(5).focus();
            await list(page).locator('.sb-character-list__filters button').last().focus();
            await expect(rows(page).nth(5)).toHaveAttribute('tabindex', '0');
            await expect(stops(page)).toHaveCount(1);
        });

        test('a row that scrolls into view is focused where the list has not drawn it', async ({ page }) => {
            await openCharacters(page, viewport);
            await showMore(page).focus();
            await page.keyboard.press('Enter');
            await expect(rows(page)).toHaveCount(CHARACTER_COUNT);
            await rows(page).first().focus();
            await page.keyboard.press('End');
            const last = rows(page).last();
            await expect(last).toBeFocused();
            await expect(last).toBeInViewport();
            await page.keyboard.press('Home');
            await expect(rows(page).first()).toBeFocused();
            await expect(rows(page).first()).toBeInViewport();
        });

        test('Show More is reached by Down, Enter loads more, and focus lands on the first new row', async ({ page }) => {
            await openCharacters(page, viewport);
            await rows(page).last().focus();
            await page.keyboard.press('ArrowDown');
            expect(await activeKind(page)).toBe('show-more');
            await page.keyboard.press('ArrowUp');
            await expect(rows(page).last()).toBeFocused();
            await page.keyboard.press('ArrowDown');
            await page.keyboard.press('Enter');
            await expect(rows(page)).toHaveCount(CHARACTER_COUNT);
            await expect(rows(page).nth(PAGE_SIZE)).toBeFocused();
            await expect(stops(page)).toHaveCount(1);
        });

        test('in selection mode the arrows move focus and Space toggles the focused row', async ({ page }) => {
            await openCharacters(page, viewport);
            await list(page).locator('.sb-character-list__header [data-action-id="more"]').click();
            await page.getByRole('menuitem', { name: 'Select', exact: true }).click();
            await expect(list(page)).toHaveAttribute('data-selection-mode', 'true');
            await rows(page).first().focus();
            await page.keyboard.press('ArrowDown');
            await expect(rows(page).nth(1)).toBeFocused();
            await page.keyboard.press(' ');
            await expect(rows(page).nth(1)).toHaveClass(/is-selection-selected/);
            await page.keyboard.press('ArrowDown');
            await page.keyboard.press('ArrowDown');
            await expect(rows(page).nth(3)).toBeFocused();
            await expect(rows(page).nth(1)).toHaveClass(/is-selection-selected/);
            await page.keyboard.press(' ');
            await expect(list(page).locator('.sb-selection-title')).toHaveText('2 selected');
            await page.keyboard.press(' ');
            await expect(list(page).locator('.sb-selection-title')).toHaveText('1 selected');
        });

        test('a search that filters the rows gives the stop to the first row left, and the arrows stay among them', async ({ page }) => {
            await openCharacters(page, viewport);
            await rows(page).nth(6).focus();
            await expect(rows(page).nth(6)).toHaveAttribute('tabindex', '0');
            const searchButton = list(page).locator('[data-action-id="search"]');
            if (await searchButton.isVisible()) await searchButton.click();
            else {
                await list(page).locator('[data-action-id="more"]').click();
                await page.getByRole('menuitem', { name: 'Search', exact: true }).click();
            }
            await page.locator('#character_search_bar').fill('QA character 3');
            await expect.poll(() => rows(page).count()).toBeLessThan(PAGE_SIZE);
            const keys = await rows(page).evaluateAll(nodes => nodes.map(node => node.dataset.sbListKey));
            expect(keys).not.toContain('character:qa-keys-character-6.png');
            await expect(stops(page)).toHaveCount(1);
            await expect(rows(page).first()).toHaveAttribute('tabindex', '0');
            await rows(page).first().focus();
            await page.keyboard.press('End');
            await expect(rows(page).last()).toBeFocused();
        });
    });
}

test.describe('Characters as a grid by keyboard', () => {
    test('Left and Right move between cards, Up and Down by a line of cards', async ({ page }) => {
        await openCharacters(page, { width: 1440, height: 900 }, { grid: true });
        await expect(list(page).locator('#rm_print_characters_block')).toHaveCSS('display', 'grid');
        const geometry = await rows(page).evaluateAll(nodes => nodes.map(node => {
            const rect = node.getBoundingClientRect();
            return { top: Math.round(rect.top), left: Math.round(rect.left) };
        }));
        const columns = geometry.filter(card => card.top === geometry[0].top).length;
        expect(columns).toBeGreaterThan(1);
        await rows(page).first().focus();
        await page.keyboard.press('ArrowRight');
        await expect(rows(page).nth(1)).toBeFocused();
        await page.keyboard.press('ArrowLeft');
        await expect(rows(page).first()).toBeFocused();
        await page.keyboard.press('ArrowDown');
        await expect(rows(page).nth(columns)).toBeFocused();
        await page.keyboard.press('ArrowUp');
        await expect(rows(page).first()).toBeFocused();
        await expect(stops(page)).toHaveCount(1);
    });
});
