import { expect, test } from '@playwright/test';
import { resetConversations, seedConversation as seedStoredConversation } from '../helpers/conversation-seed.js';
import { TOAST_CONTAINERS } from '../helpers/toasts.js';

test.beforeEach(async ({ page, baseURL }) => {
    let settingsVersion = Date.now();
    await page.route('**/*', route => {
        const url = new URL(route.request().url());
        if (url.origin !== baseURL) {
            return route.abort();
        }
        if (url.pathname === '/api/settings/save') {
            return route.fulfill({ json: { version: ++settingsVersion } });
        }
        if (url.pathname === '/api/chats/save') {
            return route.fulfill({ json: {} });
        }
        return route.continue();
    });
});

// The foundation server has no account identity, so Quick Image Gen cannot open its gallery storage and raises a warning toast
// at boot. A toast is centred at the top, over the header, and takes a click aimed at what lies beneath it.
async function clearToasts(page) {
    await page.evaluate(() => window.toastr?.clear());
    await expect(page.locator(`${TOAST_CONTAINERS} > div`)).toHaveCount(0);
}

async function seedConversation(page, { messageOverrides = [] } = {}) {
    await page.goto('/');
    await page.waitForFunction(() => document.getElementById('preloader') === null, null, { timeout: 60000 });
    await page.evaluate(() => document.querySelectorAll('dialog[open]').forEach(dialog => dialog.close()));
    const character = await page.evaluate(async () => {
        const context = window.SillyTavern.getContext();
        if (!context.characters.length) {
            await context.getCharacters();
        }
        const entry = context.characters.find(item => /Seraphina/.test(item?.name ?? ''));
        if (!entry?.avatar) {
            throw new Error('No bundled Conversation character found.');
        }
        const id = context.characters.findIndex(item => item.avatar === entry.avatar);
        await context.selectCharacterById(id, { switchMenu: false });
        document.querySelectorAll('dialog[open]').forEach(dialog => dialog.close());
        return { avatar: entry.avatar, name: entry.name };
    });

    // The server's user is shared by the tests of a worker, so each test starts from no conversations.
    await resetConversations(page);
    const day = Date.UTC(2026, 8, 30, 12, 0, 0);
    const nextDay = Date.UTC(2026, 9, 1, 9, 0, 0);
    await seedStoredConversation(page, {
        avatar: character.avatar,
        chats: [{
            messages: [
                { id: 'seed-0', role: 'character', name: character.name, mes: 'Good morning. The glade is quiet.', created_at: day },
                { id: 'seed-1', role: 'user', name: 'Tester', mes: 'Hi. I wanted to check in.', created_at: day + 60_000 },
                { id: 'seed-2', role: 'character', name: character.name, mes: 'Still here after a longer pause.', created_at: day + 21 * 60_000 },
                { id: 'seed-3', role: 'character', name: character.name, mes: 'A new day in the forest.', created_at: nextDay },
            ].map((message, index) => ({ ...message, ...messageOverrides[index] })),
        }],
    });

    await page.evaluate(async (avatar) => {
        const { openConversationWorkspaceForAvatar } = await import('/scripts/sillybunny-conversation.js');
        if (!await openConversationWorkspaceForAvatar(avatar, { showToast: false, enable: true })) {
            throw new Error(`Could not open Conversation workspace for ${avatar}`);
        }
    }, character.avatar);
    await expect(page.locator('#sheld[data-sb-conversation-mode="on"]')).toBeVisible();
    await expect(page.locator('#sb_conversation_timeline .sb-conversation-message')).toHaveCount(4, { timeout: 15000 });
    await clearToasts(page);
}

// The details window is the Dialog tier, so it is a dialog of the page and a sheet under 450px.
const detailsWindow = page => page.locator('dialog[open]').filter({ has: page.locator('.sb-details-page') });

test('desktop split view groups bubbles, and the title of the header opens the details above it', async ({ page, isMobile }) => {
    test.skip(isMobile, 'Desktop split view.');
    await seedConversation(page);

    // At 1440 the list and the chat share #sheld.
    const sheld = page.locator('#sheld[data-sb-conversation-mode="on"]');
    await expect(sheld).toHaveAttribute('data-sb-conversation-layout', 'panes');
    await expect(page.locator('#sb_conversation_list')).toBeVisible();
    await expect(page.locator('#sb_conversation_header')).toBeVisible();
    await expect(page.locator('#sb_conversation_timeline .sb-conversation-day-divider')).toHaveCount(2);

    const own = page.locator('#sb_conversation_timeline .sb-conversation-message[data-role="user"]').first();
    await expect(own).toBeVisible();
    await expect(own.locator('.sb-conversation-message-avatar')).toBeHidden();

    // The header has the title, the search and one menu: no gear.
    await expect(page.locator('[data-sb-conversation-action="open-settings"]')).toHaveCount(0);
    const title = page.locator('#sb_conversation_header .sb-conversation-header-title');
    await title.click();
    const details = detailsWindow(page);
    await expect(details).toBeVisible();
    await expect(details.getByRole('heading', { name: 'Details' }).first()).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(details).toHaveCount(0);
    await expect(title, 'focus returns to the title').toBeFocused();
});

test.describe('wide desktop', () => {
    test.use({ viewport: { width: 2400, height: 1200 } });

    test('the list and the chat stay side by side, and the details open over both', async ({ page, isMobile }) => {
        test.skip(isMobile, 'Desktop split view.');
        await seedConversation(page);

        const sheld = page.locator('#sheld[data-sb-conversation-mode="on"]');
        await expect(sheld).toHaveAttribute('data-sb-conversation-layout', 'panes');
        await expect(sheld).toHaveAttribute('data-sb-conversation-page', 'chat');
        const before = await page.evaluate(() => Math.round(document.getElementById('sb_conversation_timeline').getBoundingClientRect().width));
        await page.locator('#sb_conversation_header .sb-conversation-header-title').click();
        await expect(detailsWindow(page)).toBeVisible();
        // The window is modal and does not take a column of the layout: the timeline keeps its width.
        await expect.poll(() => page.evaluate(() => Math.round(document.getElementById('sb_conversation_timeline').getBoundingClientRect().width))).toBe(before);
    });
});

test('the details window returns focus to the control that opened it: the title, or the menu button for the Details item', async ({ page, isMobile }) => {
    test.skip(isMobile, 'Desktop widths.');
    await page.setViewportSize({ width: 1024, height: 700 });
    await seedConversation(page);

    const menuButton = page.locator('[data-sb-conversation-action="open-conversation-menu"]');
    await menuButton.click();
    await page.getByRole('menuitem', { name: 'Details' }).click();
    const details = detailsWindow(page);
    await expect(details).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(details).toHaveCount(0);
    await expect(menuButton).toBeFocused();
});

test.describe('a narrow chat area', () => {
    test('the layout follows the #sheld width, so the composer entry keeps its room', async ({ page, isMobile }) => {
        test.skip(isMobile, 'Desktop widths.');
        test.setTimeout(120000);
        await page.setViewportSize({ width: 1440, height: 900 });
        await seedConversation(page);
        const sheld = page.locator('#sheld[data-sb-conversation-mode="on"]');

        // [viewport width, height, layout]: #sheld is about 55% of the viewport, and the pages layout takes over below 670px of it.
        for (const [width, height, layout] of [[1440, 900, 'panes'], [1269, 900, 'panes'], [1169, 900, 'pages'], [1024, 600, 'pages'], [800, 900, 'pages']]) {
            await page.setViewportSize({ width, height });
            await expect(sheld, `${width}x${height}`).toHaveAttribute('data-sb-conversation-layout', layout);
            await expect.poll(() => page.locator('#sb_conversation_input').evaluate(element => Math.round(element.getBoundingClientRect().width)), { message: `${width}x${height}: composer entry width` }).toBeGreaterThanOrEqual(160);
        }

        await page.setViewportSize({ width: 1024, height: 600 });
        await expect(sheld).toHaveAttribute('data-sb-conversation-page', 'chat');
        await expect(page.locator('#sb_conversation_header .sb-conversation-header-back')).toBeVisible();
        await expect(page.locator('#sb_conversation_form [data-sb-conversation-action="open-composer-menu"]')).toBeVisible();
        await expect(page.locator('#sb_conversation_form [data-sb-conversation-action="attach-file"]')).toBeVisible();
        await page.locator('#sb_conversation_list_toggle').click();
        await expect(sheld).toHaveAttribute('data-sb-conversation-page', 'list');
        await expect(page.locator('#sb_conversation_list')).toBeVisible();
    });

    test('the details open from the header at a narrow width too, over the chat page', async ({ page, isMobile }) => {
        test.skip(isMobile, 'Desktop widths.');
        await page.setViewportSize({ width: 1024, height: 700 });
        await seedConversation(page);

        await expect(page.locator('#sheld')).toHaveAttribute('data-sb-conversation-layout', 'pages');
        await page.locator('#sb_conversation_header .sb-conversation-header-title').click();
        await expect(detailsWindow(page)).toBeVisible();
        // Widening the window while the details are open leaves them open.
        await page.setViewportSize({ width: 1440, height: 900 });
        await expect(page.locator('#sheld')).toHaveAttribute('data-sb-conversation-layout', 'panes');
        await expect(detailsWindow(page)).toBeVisible();
    });
});

test('the header title is named by what it shows, and Details is its description', async ({ page }) => {
    await seedConversation(page);
    const title = page.locator('#sb_conversation_header .sb-conversation-header-title');
    const shown = (await page.locator('#sb_conversation_header [data-sb-conversation-name]').textContent()).trim();
    expect(shown.length).toBeGreaterThan(0);
    // The visible label stays inside the accessible name (WCAG 2.5.3).
    await expect(title).toHaveAccessibleName(new RegExp(`^${shown.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    await expect(title).toHaveAccessibleDescription('Details');
});

test.describe('the hover toolbar', () => {
    const measureCover = (page, id) => page.evaluate(id => {
        const message = document.querySelector(`.sb-conversation-message[data-message-id="${id}"]`);
        const toolbar = message.querySelector('.sb-conversation-message-actions');
        const box = toolbar.getBoundingClientRect();
        const covered = [];
        const walker = document.createTreeWalker(document.getElementById('sb_conversation_timeline'), NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
            const parent = node.parentElement;
            if (!node.textContent.trim() || parent.closest('.sb-conversation-message-actions, .sb-conversation-mobile-menu-trigger')) {
                continue;
            }
            if (getComputedStyle(parent).visibility === 'hidden' || !parent.getClientRects().length) {
                continue;
            }
            const range = document.createRange();
            range.selectNodeContents(node);
            for (const rect of range.getClientRects()) {
                const width = Math.min(rect.right, box.right) - Math.max(rect.left, box.left);
                const height = Math.min(rect.bottom, box.bottom) - Math.max(rect.top, box.top);
                if (width > 0.5 && height > 0.5) {
                    covered.push(node.textContent.trim().slice(0, 24));
                }
            }
        }
        const rows = new Set([...toolbar.querySelectorAll('button')]
            .filter(button => button.getClientRects().length)
            .map(button => Math.round(button.getBoundingClientRect().top)));
        return { covered, rows: rows.size };
    }, id);

    test('covers no text of the messages around it and stays one row, at every width', async ({ page, isMobile }) => {
        test.skip(isMobile, 'A hover toolbar needs a fine pointer; the mobile projects use the menu trigger.');
        test.setTimeout(150000);
        await page.setViewportSize({ width: 1440, height: 900 });
        await seedConversation(page, { messageOverrides: [
            { mes: 'Good morning. The glade is quiet and the light is coming through the leaves in long, slow ribbons this morning.' },
        ] });

        for (const [width, height] of [[1440, 900], [1024, 600], [768, 1024], [390, 844]]) {
            await page.setViewportSize({ width, height });
            for (const expanded of [false, true]) {
                await page.evaluate(expanded => document.body.classList.toggle('expandMessageActions', expanded), expanded);
                for (const id of ['seed-0', 'seed-1', 'seed-2', 'seed-3']) {
                    const message = page.locator(`.sb-conversation-message[data-message-id="${id}"]`);
                    await message.scrollIntoViewIfNeeded();
                    await page.mouse.move(2, 2);
                    const bubble = await message.locator('.sb-conversation-message-bubble').boundingBox();
                    await page.mouse.move(bubble.x + Math.min(bubble.width / 2, 60), bubble.y + bubble.height / 2);
                    await expect(message.locator('.sb-conversation-message-actions')).toHaveCSS('opacity', '1');
                    const label = `${id} at ${width}x${height}${expanded ? ' with the actions expanded' : ''}`;
                    const cover = await measureCover(page, id);
                    expect(cover.covered, `${label}: text under the toolbar`).toEqual([]);
                    expect(cover.rows, `${label}: the toolbar is one row`).toBe(1);
                }
            }
        }
    });

    test('hides the name and time it would reach, and shows them again when it leaves', async ({ page, isMobile }) => {
        test.skip(isMobile, 'A hover toolbar needs a fine pointer.');
        await seedConversation(page);

        const message = page.locator('.sb-conversation-message[data-message-id="seed-2"]');
        const meta = message.locator('.sb-conversation-message-meta');
        await expect(meta).toHaveCSS('visibility', 'visible');
        const bubble = await message.locator('.sb-conversation-message-bubble').boundingBox();
        await page.mouse.move(bubble.x + 20, bubble.y + bubble.height / 2);
        await expect(message.locator('.sb-conversation-message-actions')).toHaveCSS('opacity', '1');
        await expect(message).toHaveAttribute('data-sb-meta-covered', '');
        await expect(meta).toHaveCSS('visibility', 'hidden');

        await page.mouse.move(2, 2);
        await expect(meta).toHaveCSS('visibility', 'visible');
    });
});

test.describe('pickers', () => {
    const openPersonaPicker = page => page.evaluate(async () => {
        const { togglePersonaPicker } = await import('/scripts/sillybunny-conversation/pickers.js');
        togglePersonaPicker(document.querySelector('[data-sb-conversation-action="open-persona-menu"]'));
    });
    const pickerBox = page => page.evaluate(() => {
        const picker = document.querySelector('.sb-conversation-persona-picker');
        const sheld = document.getElementById('sheld').getBoundingClientRect();
        const rect = picker.getBoundingClientRect();
        return { hidden: picker.hidden, width: rect.width, bottom: rect.bottom, sheldWidth: sheld.width, sheldBottom: sheld.bottom };
    });

    test('are bottom sheets at the menu width, not only on a phone', async ({ page, isMobile }) => {
        test.skip(isMobile, 'The mobile projects are already under the menu width.');
        await page.setViewportSize({ width: 600, height: 800 });
        await seedConversation(page);
        await openPersonaPicker(page);

        await expect(page.locator('.sb-conversation-persona-picker')).toBeVisible();
        await expect.poll(async () => (await pickerBox(page)).width).toBeCloseTo((await pickerBox(page)).sheldWidth, 0);
        const box = await pickerBox(page);
        expect(box.bottom, 'docked to the bottom edge of the chat area').toBeCloseTo(box.sheldBottom, 0);
        await expect(page.locator('.sb-conversation-picker-backdrop[data-open="true"]')).toBeVisible();
    });

    test('are popovers above the menu width', async ({ page, isMobile }) => {
        test.skip(isMobile, 'Desktop popover.');
        await seedConversation(page);
        await openPersonaPicker(page);

        await expect(page.locator('.sb-conversation-persona-picker')).toBeVisible();
        const box = await pickerBox(page);
        expect(box.width, 'a popover is narrower than the chat area').toBeLessThan(box.sheldWidth * 0.7);
        await expect(page.locator('.sb-conversation-picker-backdrop[data-open="true"]')).toBeHidden();
    });
});

for (const compact of [false, true]) {
    test(`desktop message toolbar stays inside the timeline for short and long bubbles${compact ? ' in compact mode' : ''}`, async ({ page, isMobile }, testInfo) => {
        test.skip(isMobile, 'The hover toolbar is desktop-only.');
        const date = Date.UTC(2026, 8, 30, 12, 22, 0);
        await seedConversation(page, { messageOverrides: [
            { mes: 'This longer message has enough room for all of its quick actions.' },
            { mes: 'test' },
            { mes: 'This longer message has enough room for all of its quick actions.' },
            { mes: 'test', send_date: new Date(date).toISOString(), created_at: date },
        ] });
        if (compact) {
            await page.evaluate(() => { document.documentElement.dataset.sbCompactMode = 'true'; });
        }

        for (const expanded of [false, true]) {
            await page.evaluate(expanded => document.body.classList.toggle('expandMessageActions', expanded), expanded);
            for (const id of ['seed-3', 'seed-2', 'seed-1']) {
                const message = page.locator(`.sb-conversation-message[data-message-id="${id}"]`);
                await message.hover();
                const toolbar = message.locator('.sb-conversation-message-actions');
                await expect(toolbar).toHaveCSS('opacity', '1');
                const layout = await toolbar.evaluate(element => {
                    const rect = element.getBoundingClientRect();
                    const timeline = document.getElementById('sb_conversation_timeline').getBoundingClientRect();
                    const bubble = element.closest('.sb-conversation-message').querySelector('.sb-conversation-message-bubble').getBoundingClientRect();
                    const controls = [...element.querySelectorAll('button')].filter(button => button.getClientRects().length);
                    return {
                        left: rect.left,
                        right: rect.right,
                        timelineLeft: timeline.left,
                        timelineRight: timeline.right,
                        width: rect.width,
                        bubbleWidth: bubble.width,
                        bubbleRight: bubble.right,
                        controlsReachable: controls.every(button => {
                            const box = button.getBoundingClientRect();
                            return button.contains(document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2));
                        }),
                    };
                });
                expect(layout.left, `${id}: toolbar start must not be clipped`).toBeGreaterThanOrEqual(layout.timelineLeft);
                expect(layout.right, `${id}: toolbar end must not be clipped`).toBeLessThanOrEqual(layout.timelineRight);
                expect(layout.controlsReachable, `${id}: every quick action must be reachable`).toBe(true);
                if (id === 'seed-3') {
                    expect(layout.bubbleWidth, 'Short bubbles must keep their content width').toBeLessThan(layout.width);
                    await page.screenshot({ path: testInfo.outputPath(`short-message-${expanded ? 'expanded-' : ''}toolbar.png`) });
                } else {
                    expect(layout.right, `${id}: toolbar keeps the bubble end alignment`).toBeCloseTo(layout.bubbleRight, 0);
                }
            }
        }
    });
}

test('mobile pages keep the list and the chat as full screens, and the details open as a sheet', async ({ page, isMobile }) => {
    test.skip(!isMobile, 'Mobile pages.');
    await seedConversation(page);

    const sheld = page.locator('#sheld[data-sb-conversation-mode="on"]');
    await expect(sheld).toHaveAttribute('data-sb-conversation-layout', 'pages');
    await expect(sheld).toHaveAttribute('data-sb-conversation-page', 'chat');
    await expect(page.locator('#sb_conversation_header .sb-conversation-header-back')).toBeVisible();
    await expect(page.locator('#sb_conversation_timeline .sb-conversation-mobile-menu-trigger').first()).toBeVisible();
    // Attach and the "+" menu are in the composer at every width.
    await expect(page.locator('#sb_conversation_form [data-sb-conversation-action="open-composer-menu"]')).toBeVisible();
    await expect(page.locator('#sb_conversation_form [data-sb-conversation-action="attach-file"]')).toBeVisible();

    await page.locator('#sb_conversation_list_toggle').click();
    await expect(sheld).toHaveAttribute('data-sb-conversation-page', 'list');
    await expect(page.locator('#sb_conversation_list')).toBeVisible();

    await page.locator('.sb-conversation-list-item').first().click();
    await expect(sheld).toHaveAttribute('data-sb-conversation-page', 'chat');
    await page.locator('#sb_conversation_header .sb-conversation-header-title').click();
    const details = detailsWindow(page);
    await expect(details).toBeVisible();
    // The page of the chat stays under the sheet, and the sheet holds the same rows as the window.
    await expect(sheld).toHaveAttribute('data-sb-conversation-page', 'chat');
    await expect(details.getByRole('switch').first()).toBeVisible();
});

test.describe('the header', () => {
    test('has the title, the search and one menu with Details, New Chat, Add Member, Mute, Select Messages and the two deletes', async ({ page }) => {
        await seedConversation(page);

        const header = page.locator('#sb_conversation_header');
        await expect(header.locator('.sb-conversation-header-actions button')).toHaveCount(2);
        await expect(header.locator('[data-sb-conversation-action="toggle-search"]')).toBeVisible();
        await expect(header.locator('[data-sb-conversation-action="open-settings"]')).toHaveCount(0);
        await expect(header.locator('[data-sb-conversation-action="open-chat-menu"]')).toHaveCount(0);

        await header.locator('[data-sb-conversation-action="open-conversation-menu"]').click();
        const items = page.getByRole('menuitem');
        await expect(items).toHaveText(['Details', 'New Chat', 'Add Member', 'Mute', 'Select Messages', 'Delete Chat', 'Delete Conversation']);
    });

    test('Add Member opens the details on the Add Member page', async ({ page }) => {
        await seedConversation(page);

        await page.locator('[data-sb-conversation-action="open-conversation-menu"]').click();
        await page.getByRole('menuitem', { name: 'Add Member' }).click();
        const details = detailsWindow(page);
        await expect(details).toBeVisible();
        await expect(details.getByRole('heading', { name: 'Add Member' }).first()).toBeVisible();
    });

    test('Mute changes the item to Unmute and back', async ({ page }) => {
        await seedConversation(page);

        const menuButton = page.locator('[data-sb-conversation-action="open-conversation-menu"]');
        await menuButton.click();
        await page.getByRole('menuitem', { name: 'Mute', exact: true }).click();
        await menuButton.click();
        await expect(page.getByRole('menuitem', { name: 'Unmute' })).toBeVisible();
        await page.getByRole('menuitem', { name: 'Unmute' }).click();
        await menuButton.click();
        await expect(page.getByRole('menuitem', { name: 'Mute', exact: true })).toBeVisible();
    });

    test('names the conversation as the list does, and shows the status of the character beneath', async ({ page }) => {
        await seedConversation(page);

        const shown = (await page.locator('#sb_conversation_header [data-sb-conversation-name]').textContent()).trim();
        // The list is hidden behind its page on a phone, so the row is read from the DOM.
        const listed = await page.locator('.sb-conversation-list-item[aria-current="true"]').first().evaluate(row => row.querySelector('.sb-conversation-list-item-name')?.textContent.trim());
        expect(shown).toBe(listed);
        await expect(page.locator('#sb_conversation_header [data-sb-conversation-status]')).toHaveText(/^(Online|Idle|Do Not Disturb|Offline)\b/);
    });
});

test.describe('the composer', () => {
    test('is Attach, the "+" menu, the entry and Send, with none of the four quick buttons', async ({ page }) => {
        await seedConversation(page);

        const composer = page.locator('#sb_conversation_form');
        await expect(composer.locator('.sb-conversation-composer-row > button, .sb-conversation-composer-row > textarea')).toHaveCount(4);
        await expect(composer.locator('[data-sb-conversation-action="attach-file"]')).toBeVisible();
        await expect(composer.locator('[data-sb-conversation-action="open-composer-menu"]')).toBeVisible();
        await expect(composer.locator('#sb_conversation_input')).toBeVisible();
        await expect(composer.locator('#sb_conversation_send')).toBeVisible();
        for (const action of ['quick-selfie', 'quick-remind', 'quick-summarize', 'force-response']) {
            await expect(composer.locator(`[data-sb-conversation-action="${action}"]`)).toHaveCount(0);
        }
    });

    test('the "+" menu holds Selfie, Remind, Summarize and Force Reply', async ({ page }) => {
        await seedConversation(page);

        await page.locator('#sb_conversation_form [data-sb-conversation-action="open-composer-menu"]').click();
        await expect(page.getByRole('menuitem')).toHaveText(['Send a Selfie', 'Remind Me', 'Summarize Memory', 'Force a Reply']);
    });
});

test.describe('the timeline', () => {
    test('has a search and no filter tabs', async ({ page }) => {
        await seedConversation(page);

        await page.locator('[data-sb-conversation-action="toggle-search"]').click();
        await expect(page.locator('#sb_conversation_tools .sb-conversation-search-entry')).toBeVisible();
        await expect(page.locator('[data-sb-conversation-action="set-channel"]')).toHaveCount(0);
        await expect(page.locator('.sb-conversation-channel-tabs')).toHaveCount(0);

        await page.locator('#sb_conversation_tools .sb-conversation-search-entry').fill('glade');
        await expect(page.locator('#sb_conversation_timeline .sb-conversation-message')).toHaveCount(1);
        await page.locator('#sb_conversation_tools .sb-conversation-search-entry').fill('');
        await expect(page.locator('#sb_conversation_timeline .sb-conversation-message')).toHaveCount(4);
    });

    test('offers Edit on every message, the character\'s and the user\'s', async ({ page }) => {
        await seedConversation(page);

        const messages = page.locator('#sb_conversation_timeline .sb-conversation-message');
        for (let index = 0; index < 4; index++) {
            await expect(messages.nth(index).locator('[data-sb-conversation-action="edit-message"]')).toHaveCount(1);
        }
    });
});

test('composer entry only scrolls once it reaches its max height', async ({ page }) => {
    await seedConversation(page);
    const input = page.locator('#sb_conversation_input');
    const measure = () => input.evaluate(el => ({
        overflow: getComputedStyle(el).overflowY,
        scrollable: el.scrollHeight > el.clientHeight,
        height: el.getBoundingClientRect().height,
    }));

    // First load must use the CSS height, not one measured before the lazy stylesheet applied.
    const initial = await measure();
    expect(await input.evaluate(el => el.style.height)).toBe('');
    expect(initial.height).toBeLessThanOrEqual(46);

    await input.fill('');
    const empty = await measure();
    expect(empty.overflow).toBe('hidden');
    expect(Math.round(empty.height)).toBe(Math.round(initial.height));
    expect(empty.scrollable).toBe(false);

    await input.fill('Line\n'.repeat(3).trim());
    const grown = await measure();
    expect(grown.scrollable).toBe(false);
    expect(grown.height).toBeGreaterThan(empty.height);

    await input.fill('Line\n'.repeat(30).trim());
    expect((await measure()).overflow).toBe('auto');

    await input.fill('');
    const cleared = await measure();
    expect(cleared.overflow).toBe('hidden');
    expect(Math.round(cleared.height)).toBe(Math.round(empty.height));
});

test('mobile send button uses the shared Roleplay composer sizes', async ({ page, isMobile }) => {
    test.skip(!isMobile, 'Mobile composer.');
    const measureSend = selector => page.evaluate(async ({ selector }) => {
        const sizes = {};
        for (const compact of [false, true]) {
            if (compact) {
                document.documentElement.dataset.sbCompactMode = 'true';
            } else {
                delete document.documentElement.dataset.sbCompactMode;
            }
            await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
            const button = document.querySelector(selector);
            const rect = button.getBoundingClientRect();
            sizes[compact ? 'compact' : 'default'] = { width: rect.width, height: rect.height, icon: getComputedStyle(button).fontSize };
        }
        delete document.documentElement.dataset.sbCompactMode;
        return sizes;
    }, { selector });

    await seedConversation(page);
    // Roleplay's #send_but is not rendered on this seeded page, so compare against its measured
    // sizes (44px/16px; compact keeps the 44px touch floor with a 14px icon), which come from the same
    // --sb-mobile-composer-action-* tokens.
    const conversation = await measureSend('#sb_conversation_send');
    expect(conversation).toEqual({
        default: { width: 44, height: 44, icon: '16px' },
        compact: { width: 44, height: 44, icon: '14px' },
    });

});

test('inline message editor uses libadwaita pill buttons', async ({ page }) => {
    await seedConversation(page);
    await page.evaluate(async () => {
        const { editConversationMessage } = await import('/scripts/sillybunny-conversation/generation.js');
        await editConversationMessage('seed-1');
    });
    const editor = page.locator('.sb-conversation-message.is-editing');
    await expect(editor.locator('.sb-conversation-message-edit-textarea')).toBeVisible();
    const save = editor.locator('.sb-conversation-message-edit-save');
    await expect(save).toHaveText('Save');
    await expect(editor.locator('.sb-conversation-message-edit-cancel')).toHaveText('Cancel');
    await expect(save).not.toHaveClass(/menu_button/);
    const layout = await editor.evaluate(element => {
        const rect = selector => element.querySelector(selector).getBoundingClientRect();
        const style = getComputedStyle(element.querySelector('.sb-conversation-message-edit-save'));
        return {
            radius: parseFloat(style.borderTopLeftRadius),
            height: rect('.sb-conversation-message-edit-save').height,
            deleteLeft: rect('.sb-conversation-message-edit-delete').left,
            cancelLeft: rect('.sb-conversation-message-edit-cancel').left,
            saveLeft: rect('.sb-conversation-message-edit-save').left,
        };
    });
    expect(layout.radius).toBeGreaterThanOrEqual(layout.height / 2 - 1);
    expect(layout.deleteLeft).toBeLessThan(layout.cancelLeft);
    expect(layout.cancelLeft).toBeLessThan(layout.saveLeft);

    await page.locator('.sb-conversation-message-edit-cancel').click();
    await expect(editor).toHaveCount(0);
});

test('the group picker counts its selection and announces each change politely', async ({ page }) => {
    await seedConversation(page);
    await page.evaluate(async () => {
        const { toggleConversationGroupPicker } = await import('/scripts/sillybunny-conversation/pickers.js');
        const anchor = document.querySelector('[data-sb-conversation-action="open-conversation-menu"]');
        toggleConversationGroupPicker({ anchor });
    });

    const count = page.locator('.sb-picker__count');
    await expect(count).toBeVisible();
    await expect(count).toHaveAttribute('role', 'status');
    await expect(count).toHaveAttribute('aria-live', 'polite');
    await expect(count).toHaveText('0 selected');
    const options = page.locator('.sb-picker__option');
    await options.nth(0).click();
    await expect(count).toHaveText('1 selected');
    await options.nth(1).click();
    await expect(count).toHaveText('2 selected');
    await options.nth(1).click();
    await expect(count).toHaveText('1 selected');
});
