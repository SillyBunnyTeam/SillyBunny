import { expect, test } from '@playwright/test';
import { alternatingMessages, resetConversations, seedConversation } from './helpers/conversation-seed.js';
import { bootConversationPage, getCharacterAvatars } from './helpers/conversation-list-steps.js';

test.use({ serviceWorkers: 'block' });

const ENTRY = '#sb_conversation_input';
const EMOJI_BUTTON = '#sb_conversation_emoji';
const SEARCH = '.sb-emoji-search-entry';
// Not `[role="status"]`: the loading page is a status too, so while the table loads that selector names two elements and a check on it fails at once, with no retry.
const LIVE = '.sb-emoji-live';
const POPOVER = '.sb-action-popover:has(.sb-emoji-chooser)';
const SHEET = '.sb-action-sheet:has(.sb-emoji-chooser)';
const TABLE = /\/emoji-[a-z-]+\.json/;
const FONT = /\/SBEmoji-[\d.-]+\.woff2/;

/** Boots the app with a conversation of its own open, and records the requests of the emoji files. */
async function openComposer(page, baseURL, { width = 1440, height = 900, theme = '' } = {}) {
    const requests = { tables: [], fonts: [] };
    page.on('request', (request) => {
        const { pathname, search } = new URL(request.url());
        if (TABLE.test(pathname)) {
            requests.tables.push(pathname + search);
        } else if (FONT.test(pathname)) {
            requests.fonts.push(pathname);
        }
    });
    await page.setViewportSize({ width, height });
    await bootConversationPage(page, baseURL, { theme });
    const { seraphina } = await getCharacterAvatars(page);
    await resetConversations(page);
    await seedConversation(page, { avatar: seraphina, chats: [{ messages: alternatingMessages(['Hello there, traveller.', 'Hi! How is the road?', 'Long, but the view is good.']) }] });
    const fontsBeforeOpen = requests.fonts.length;
    await page.evaluate(async (avatar) => {
        const { setOnlineStatus } = await import('/script.js');
        const { openConversationWorkspaceForAvatar } = await import('/scripts/sillybunny-conversation.js');
        const { stopConversationAutoWorker } = await import('/scripts/sillybunny-conversation/auto-engine.js');
        const { ensureConversationChatLoaded } = await import('/scripts/sillybunny-conversation/conversation-store.js');
        setOnlineStatus('no_connection');
        await openConversationWorkspaceForAvatar(avatar, { showToast: false });
        await ensureConversationChatLoaded(avatar);
        stopConversationAutoWorker();
    }, seraphina);
    await expect(page.locator('#sheld')).toHaveAttribute('data-sb-conversation-mode', 'on');
    await expect(page.locator(ENTRY)).toBeVisible();
    // The reaction buttons of the hover toolbar show emoji, so the face is fetched when a conversation opens and not before.
    requests.fontsBeforeOpen = fontsBeforeOpen;
    return requests;
}

const readRecents = page => page.evaluate(async () => {
    const { getConversationStore } = await import('/scripts/sillybunny-conversation/context.js');
    return getConversationStore().recentEmoji ?? [];
});

const activeCell = page => page.evaluate(() => {
    const cell = document.activeElement;
    return cell?.classList.contains('sb-emoji-cell') ? { emoji: cell.dataset.emoji, section: cell.dataset.section, index: cell.dataset.index } : null;
});

async function hasNativePicker(page) {
    return page.evaluate(async () => {
        const { hasNativeEmojiPicker } = await import('/scripts/sillybunny-conversation/emoji/emoji-shortcut.js');
        return hasNativeEmojiPicker(navigator.userAgent);
    });
}

test.describe('with a pointer at 1440x900', () => {
    test('the Emoji button opens a popover that has the focus in its search, inserts at the caret and closes', async ({ page, baseURL }, testInfo) => {
        test.setTimeout(90_000);
        const requests = await openComposer(page, baseURL);
        const entry = page.locator(ENTRY);
        await entry.fill('hello world');
        await entry.evaluate((element) => {
            element.setSelectionRange(5, 5);
        });

        const button = page.locator(EMOJI_BUTTON);
        await expect(button).toBeVisible();
        await expect(button).toHaveAccessibleName('Insert Emoji');
        expect(requests.tables).toEqual([]);
        expect(requests.fontsBeforeOpen).toBe(0);
        await expect.poll(() => requests.fonts.length).toBeLessThanOrEqual(1);
        const fontsBefore = requests.fonts.length;

        await button.click();
        const popover = page.locator(POPOVER);
        await expect(popover).toBeVisible();
        await expect(popover).toHaveAttribute('role', 'dialog');
        await expect(popover.locator('[role="listbox"] [role="option"]').first()).toBeVisible();
        await expect(popover.locator(SEARCH)).toBeFocused();
        await expect(button).toHaveAttribute('aria-expanded', 'true');
        await page.screenshot({ path: testInfo.outputPath('chooser-popover.png') });

        await popover.locator(SEARCH).fill('red heart');
        await expect(popover.locator(LIVE)).toHaveText(/^\d+ Results?$/);
        await popover.getByRole('option', { name: 'red heart', exact: true }).click();

        await expect(popover).toHaveCount(0);
        await expect(entry).toHaveValue('hello❤️ world');
        await expect(entry).toBeFocused();
        expect(await entry.evaluate(element => element.selectionStart)).toBe('hello❤️'.length);

        // One table for the language, once, with its version in the address; the face is fetched once and the chooser does not fetch it again.
        expect(requests.tables).toHaveLength(1);
        expect(requests.tables[0]).toMatch(/emoji-en\.json\?v=\d+\.\d+\.\d+\.\d+$/);
        expect(requests.fonts).toHaveLength(1);
        expect(requests.fonts.length).toBeGreaterThanOrEqual(fontsBefore);

        expect(await readRecents(page)).toEqual([{ e: '❤️', n: 'red heart' }]);
        await button.click();
        const recent = page.locator(`${POPOVER} [data-section="recent"]`);
        await expect(recent.locator('.sb-emoji-cell')).toHaveCount(1);
        await expect(recent.locator('.sb-emoji-cell').first()).toHaveAttribute('data-emoji', '❤️');
        expect(requests.tables).toHaveLength(1);
        expect(requests.fonts).toHaveLength(1);
    });

    test('opened again from its own button it closes, and a click outside closes it and keeps the draft', async ({ page, baseURL }) => {
        test.setTimeout(90_000);
        await openComposer(page, baseURL);
        const entry = page.locator(ENTRY);
        await entry.fill('draft');
        const button = page.locator(EMOJI_BUTTON);
        await button.click();
        await expect(page.locator(POPOVER)).toBeVisible();
        await button.click();
        await expect(page.locator(POPOVER)).toHaveCount(0);
        await button.click();
        await expect(page.locator(POPOVER)).toBeVisible();
        await page.locator('#sb_conversation_timeline').click({ position: { x: 20, y: 20 } });
        await expect(page.locator(POPOVER)).toHaveCount(0);
        await expect(entry).toHaveValue('draft');
    });

    test('a Shift click picks without closing, and a secondary click opens the skin tones', async ({ page, baseURL }) => {
        test.setTimeout(90_000);
        await openComposer(page, baseURL);
        const entry = page.locator(ENTRY);
        await page.locator(EMOJI_BUTTON).click();
        const popover = page.locator(POPOVER);
        await popover.locator(SEARCH).fill('thumbs up');
        const thumbs = popover.getByRole('option', { name: 'thumbs up', exact: true });
        await thumbs.click({ modifiers: ['Shift'] });
        await expect(popover).toBeVisible();
        await expect(entry).toHaveValue('👍');

        await thumbs.click({ button: 'right' });
        const tones = popover.locator('.sb-emoji-variants');
        await expect(tones).toBeVisible();
        await expect(tones.getByRole('option')).toHaveCount(6);
        await tones.getByRole('option', { name: /: medium skin tone$/ }).click();
        await expect(popover).toHaveCount(0);
        expect(await entry.inputValue()).toMatch(/^👍👍🏽$/);
        expect((await readRecents(page)).map(item => item.e)).toEqual(['👍🏽', '👍']);
    });
});

test.describe('when the table is slow or cannot be loaded', () => {
    test('shows the shared status page while it loads, and the grid once it arrives', async ({ page, baseURL }, testInfo) => {
        test.setTimeout(90_000);
        await openComposer(page, baseURL);
        let release = () => {};
        const held = new Promise((resolve) => {
            release = resolve;
        });
        await page.route(TABLE, async (route) => {
            await held;
            await route.continue();
        });
        await page.locator(EMOJI_BUTTON).click();
        const popover = page.locator(POPOVER);
        const loading = popover.locator('.sb-status-page[data-state="loading"]');
        // The status page waits a moment before it shows, so a quick load shows nothing.
        await expect(loading).toBeVisible();
        await expect(loading).toContainText('Loading Emoji');
        await expect(popover.locator('[role="listbox"]')).toHaveCount(0);
        await page.screenshot({ path: testInfo.outputPath('chooser-loading.png') });
        release();
        await expect(popover.locator('[role="listbox"] [role="option"]').first()).toBeVisible();
        await expect(loading).toHaveCount(0);
    });

    test('searches the text that was typed while it loaded, once it arrives', async ({ page, baseURL }) => {
        test.setTimeout(90_000);
        await openComposer(page, baseURL);
        let release = () => {};
        const held = new Promise((resolve) => {
            release = resolve;
        });
        await page.route(TABLE, async (route) => {
            await held;
            await route.continue();
        });
        await page.locator(EMOJI_BUTTON).click();
        const popover = page.locator(POPOVER);
        await expect(popover.locator('.sb-status-page[data-state="loading"]')).toBeVisible();
        await page.keyboard.type('waving hand');
        await expect(popover.locator(SEARCH)).toHaveValue('waving hand');
        await expect(popover.locator(LIVE)).toHaveText('');

        release();

        await expect(popover.locator(LIVE)).toHaveText(/^\d+ Results?$/);
        await expect(popover.locator('[role="listbox"] [role="option"]').first()).toHaveAccessibleName(/waving hand/);
        await expect(popover.locator(SEARCH)).toHaveValue('waving hand');
    });

    test('says so when the table cannot be loaded, and Try Again loads it', async ({ page, baseURL }, testInfo) => {
        test.setTimeout(90_000);
        await openComposer(page, baseURL);
        await page.route(TABLE, route => route.abort());
        await page.locator(EMOJI_BUTTON).click();
        const popover = page.locator(POPOVER);
        const failed = popover.locator('.sb-status-page[data-state="error"]');
        await expect(failed).toBeVisible();
        await expect(failed).toContainText('Emoji Unavailable');
        await page.screenshot({ path: testInfo.outputPath('chooser-error.png') });
        await page.unroute(TABLE);
        await failed.getByRole('button', { name: 'Try Again' }).click();
        await expect(popover.locator('[role="listbox"] [role="option"]').first()).toBeVisible();
        await expect(failed).toHaveCount(0);
    });
});

test.describe('with the keyboard at 1440x900', () => {
    test('Control+Period opens the chooser from the entry; the arrows, the sections and Enter work; Escape returns to the entry', async ({ page, baseURL }) => {
        test.setTimeout(90_000);
        await openComposer(page, baseURL);
        test.skip(await hasNativePicker(page), 'the browser opens its own emoji chooser on this key');
        const entry = page.locator(ENTRY);
        await entry.fill('hi ');
        await entry.focus();
        await page.keyboard.press('Control+Period');
        const popover = page.locator(POPOVER);
        await expect(popover.locator(SEARCH)).toBeFocused();
        await expect(popover.locator('.sb-emoji-cell').first()).toBeVisible();

        // Search entry, grid, categories: three Tab stops, wrapping, and the grid is one of them.
        await page.keyboard.press('Tab');
        expect(await activeCell(page)).not.toBeNull();
        const first = await activeCell(page);
        await page.keyboard.press('ArrowRight');
        const second = await activeCell(page);
        expect(second.index).toBe(String(Number(first.index) + 1));
        await page.keyboard.press('ArrowDown');
        expect(Number((await activeCell(page)).index)).toBeGreaterThan(Number(second.index));
        await page.keyboard.press('Alt+ArrowDown');
        const jumped = await activeCell(page);
        expect(jumped.section).not.toBe(first.section);
        expect(jumped.index).toBe('0');
        await page.keyboard.press('Control+p');
        expect(await activeCell(page)).toMatchObject({ section: first.section, index: '0' });

        await page.keyboard.press('Tab');
        await expect(popover.locator('.sb-emoji-categories [tabindex="0"]')).toBeFocused();
        await page.keyboard.press('Tab');
        await expect(popover.locator(SEARCH)).toBeFocused();

        await page.keyboard.press('Escape');
        await expect(popover).toHaveCount(0);
        await expect(entry).toBeFocused();

        await page.keyboard.press('Control+Period');
        await expect(popover.locator(SEARCH)).toBeFocused();
        await page.keyboard.type('face with tears of joy');
        await page.keyboard.press('Enter');
        await expect(popover).toHaveCount(0);
        await expect(entry).toHaveValue('hi 😂');
        await expect(entry).toBeFocused();
    });

    test('the arrows go from the search into the results, and the skin tones open on Shift+F10', async ({ page, baseURL }) => {
        test.setTimeout(90_000);
        await openComposer(page, baseURL);
        const entry = page.locator(ENTRY);
        await page.locator(EMOJI_BUTTON).focus();
        await page.keyboard.press('Enter');
        const popover = page.locator(POPOVER);
        await expect(popover.locator(SEARCH)).toBeFocused();
        await page.keyboard.type('waving hand');
        await expect(popover.locator(LIVE)).toHaveText(/Results?$/);
        await page.keyboard.press('ArrowDown');
        expect(await activeCell(page)).toMatchObject({ emoji: '👋' });
        await page.keyboard.press('Shift+F10');
        const tones = popover.locator('.sb-emoji-variants');
        await expect(tones).toBeVisible();
        await expect(tones.getByRole('option').first()).toBeFocused();
        await page.keyboard.press('ArrowRight');
        await page.keyboard.press('ArrowRight');
        await page.keyboard.press('Enter');
        await expect(popover).toHaveCount(0);
        expect(await entry.inputValue()).toMatch(/^👋🏼$/);
    });
});

test.describe('the Emoji button in a narrow composer', () => {
    for (const width of [320, 343, 359]) {
        test(`is folded into the + menu at ${width}px`, async ({ page, baseURL }) => {
            test.setTimeout(90_000);
            await openComposer(page, baseURL, { width, height: 740 });
            await expect(page.locator(EMOJI_BUTTON)).toBeHidden();
            await page.getByRole('button', { name: 'Add to Message' }).click();
            const menu = page.getByRole('menu');
            expect((await menu.getByRole('menuitem').allTextContents())[0]).toBe('Insert Emoji');
            await menu.getByRole('menuitem', { name: 'Insert Emoji' }).click();
            await expect(page.locator(`${POPOVER}, ${SHEET}`)).toBeVisible();
            // Without the fourth button the entry is 154px at 320px.
            expect((await page.locator(ENTRY).boundingBox()).width).toBeGreaterThanOrEqual(100);
        });
    }

    for (const width of [360, 390]) {
        test(`is drawn beside the entry at ${width}px, and the + menu does not repeat it`, async ({ page, baseURL }) => {
            test.setTimeout(90_000);
            await openComposer(page, baseURL, { width, height: 740 });
            await expect(page.locator(EMOJI_BUTTON)).toBeVisible();
            await page.getByRole('button', { name: 'Add to Message' }).click();
            expect(await page.getByRole('menu').getByRole('menuitem').allTextContents()).not.toContain('Insert Emoji');
            // The entry keeps 144px beside four buttons at 360px.
            expect((await page.locator(ENTRY).boundingBox()).width).toBeGreaterThanOrEqual(140);
        });
    }

    test('the shortcut opens the chooser from the "+" button when the Emoji button is folded', async ({ page, baseURL }) => {
        test.setTimeout(90_000);
        await openComposer(page, baseURL, { width: 320, height: 740 });
        test.skip(await hasNativePicker(page), 'the browser opens its own emoji chooser on this key');
        await page.locator(ENTRY).focus();
        await page.keyboard.press('Control+Period');
        await expect(page.locator(`${POPOVER}, ${SHEET}`)).toBeVisible();
    });
});

test.describe('with touch at 390x844', () => {
    test.use({ hasTouch: true });

    test('the chooser is a bottom sheet whose cells are touch targets and that a tap inserts from', async ({ page, baseURL }, testInfo) => {
        test.setTimeout(90_000);
        await openComposer(page, baseURL, { width: 390, height: 844 });
        const entry = page.locator(ENTRY);
        await entry.fill('ok ');
        await page.locator(EMOJI_BUTTON).tap();
        const sheet = page.locator(SHEET);
        await expect(sheet).toBeVisible();
        await expect(sheet.locator('[role="option"]').first()).toBeVisible();
        // The sheet takes the focus, and the search entry does not, so the keyboard stays down.
        await expect(sheet.locator(SEARCH)).not.toBeFocused();
        await page.screenshot({ path: testInfo.outputPath('chooser-sheet.png') });

        const box = await sheet.boundingBox();
        expect(box.width).toBeLessThanOrEqual(390);
        expect(box.y + box.height).toBeLessThanOrEqual(844 + 1);
        // A cell is at least a 44px touch target.
        const cell = await sheet.locator('.sb-emoji-grid .sb-emoji-cell').first().boundingBox();
        expect(cell.width).toBeGreaterThanOrEqual(43.5);
        expect(cell.height).toBeGreaterThanOrEqual(43.5);

        await sheet.locator('.sb-emoji-cell[data-emoji="😀"]').first().tap();
        await expect(sheet).toHaveCount(0);
        await expect(entry).toHaveValue('ok 😀');
    });

    test('a long press opens the skin tones, and a tap on one inserts it', async ({ page, baseURL }) => {
        test.setTimeout(90_000);
        await openComposer(page, baseURL, { width: 390, height: 844 });
        const entry = page.locator(ENTRY);
        await page.locator(EMOJI_BUTTON).tap();
        const sheet = page.locator(SHEET);
        await sheet.locator(SEARCH).tap();
        await sheet.locator(SEARCH).fill('waving hand');
        const wave = sheet.locator('.sb-emoji-grid').getByRole('option', { name: 'waving hand', exact: true });
        await expect(wave).toBeVisible();
        // A touch that stays: the browsers' tools have no long press of their own, so the page gets the events that one makes.
        await wave.evaluate((cell) => {
            const box = cell.getBoundingClientRect();
            cell.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch', clientX: box.x + 10, clientY: box.y + 10 }));
        });
        const tones = sheet.locator('.sb-emoji-variants');
        await expect(tones).toBeVisible();
        await expect(tones.getByRole('option')).toHaveCount(6);
        await wave.evaluate((cell) => {
            cell.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerType: 'touch' }));
            cell.click();
        });
        await expect(tones).toBeVisible();
        await expect(sheet.locator(LIVE)).toHaveText(/Result/);
        await tones.getByRole('option').nth(3).tap();
        await expect(sheet).toHaveCount(0);
        await expect(entry).toHaveValue('👋🏽');
    });
});

test.describe('the font', () => {
    test('leads the stack of every surface that shows emoji, and the preference puts the device emoji back', async ({ page, baseURL }) => {
        test.setTimeout(90_000);
        await openComposer(page, baseURL);
        const lead = selector => page.locator(selector).first().evaluate(element => getComputedStyle(element).fontFamily.split(',')[0].replace(/["']/g, '').trim());
        for (const selector of ['#sheld', ENTRY, '.sb-conversation-message-text', '.sb-conversation-composer-emoji']) {
            expect([selector, await lead(selector)]).toEqual([selector, 'SB Emoji']);
        }
        await expect(page.locator('html')).not.toHaveAttribute('data-sb-emoji-font', /.*/);

        // The details window is outside #sheld.
        await page.evaluate(async () => {
            const { openConversationPreferences } = await import('/scripts/sillybunny-conversation/chrome.js');
            await openConversationPreferences();
        });
        const window = page.locator('.sb-details-window').first();
        await expect(window).toBeVisible();
        expect(await lead('.sb-details-window')).toBe('SB Emoji');

        const toggle = page.getByRole('switch', { name: 'Use Device Emoji' });
        await expect(toggle).not.toBeChecked();
        await toggle.check();
        await expect(page.locator('html')).toHaveAttribute('data-sb-emoji-font', 'device');
        for (const selector of ['#sheld', ENTRY, '.sb-details-window']) {
            expect([selector, await lead(selector)]).not.toEqual([selector, 'SB Emoji']);
        }
        const saved = await page.evaluate(async () => {
            const { getGlobalConversationSettings } = await import('/scripts/sillybunny-conversation/settings-store.js');
            return getGlobalConversationSettings().use_device_emoji;
        });
        expect(saved).toBe(true);
        await toggle.uncheck();
        await expect(page.locator('html')).not.toHaveAttribute('data-sb-emoji-font', /.*/);
    });

    test('is one file, fetched once by the page that shows emoji and never by one that does not', async ({ page, baseURL }) => {
        test.setTimeout(90_000);
        const requests = await openComposer(page, baseURL);
        expect(requests.fontsBeforeOpen).toBe(0);
        await page.locator(EMOJI_BUTTON).click();
        await expect(page.locator(`${POPOVER} [role="option"]`).first()).toBeVisible();
        await page.waitForFunction(() => document.fonts.check('20px "SB Emoji"', '😀'));
        expect(requests.fonts).toHaveLength(1);
        const drawn = await page.evaluate(() => [...document.fonts].filter(face => face.family.replace(/["']/g, '') === 'SB Emoji').map(face => face.status));
        expect(drawn).toEqual(['loaded']);
    });
});
