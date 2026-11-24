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
}

test('desktop split view groups bubbles and keeps settings as a pane', async ({ page, isMobile }) => {
    test.skip(isMobile, 'Desktop split view.');
    await seedConversation(page);

    // At 1440 the chat column is about 790px wide: too narrow to dock a third column beside the rail.
    const sheld = page.locator('#sheld[data-sb-conversation-mode="on"]');
    await expect(sheld).toHaveAttribute('data-sb-conversation-layout', 'overlay');
    await expect(page.locator('#sb_conversation_list')).toBeVisible();
    await expect(page.locator('#sb_conversation_header')).toBeVisible();
    await expect(page.locator('#sb_conversation_form [data-sb-conversation-action="attach-file"]')).toBeVisible();
    await expect(page.locator('#sb_conversation_form .sb-conversation-composer-actions')).toBeVisible();
    await expect(page.locator('#sb_conversation_form [data-sb-conversation-action="open-composer-menu"]')).toBeHidden();
    await expect(page.locator('#sb_conversation_timeline .sb-conversation-day-divider')).toHaveCount(2);

    const own = page.locator('#sb_conversation_timeline .sb-conversation-message[data-role="user"]').first();
    await expect(own).toBeVisible();
    await expect(own.locator('.sb-conversation-message-avatar')).toBeHidden();

    await page.locator('[data-sb-conversation-action="open-settings"]').click();
    await expect(page.locator('#sb_conversation_settings_drawer')).toBeVisible();
    await expect(page.locator('#sb_conversation_settings_backdrop')).toBeVisible();
    // The boolean rows are the shared switch rows.
    await expect(page.locator('#sb_conv_idle_followup')).toHaveClass(/sb-switch/);
    await expect(page.locator('#sb_conv_idle_followup')).toHaveAttribute('role', 'switch');
    await expect(page.locator('#sb_conv_grounded_dialogue_rules')).toBeHidden();
    await expect(page.locator('[data-sb-conversation-action="edit-grounded-dialogue-rules"]')).toBeVisible();

    // The pane stays beside the rail, and the content header keeps its full width, so the name and status stay readable.
    const boxes = await page.evaluate(() => {
        const box = selector => {
            const rect = document.querySelector(selector).getBoundingClientRect();
            return { left: rect.left, right: rect.right, width: rect.width };
        };
        return {
            rail: box('#sb_conversation_list'),
            drawer: box('#sb_conversation_settings_drawer'),
            header: box('#sb_conversation_header'),
            name: box('[data-sb-conversation-name]'),
            input: box('#sb_conversation_input'),
        };
    });
    expect(boxes.drawer.left, 'the pane does not cover the rail').toBeGreaterThanOrEqual(boxes.rail.right);
    expect(boxes.header.width, 'the header is not squeezed by the pane').toBeGreaterThan(480);
    expect(boxes.name.width, 'the name keeps room').toBeGreaterThan(60);
    expect(boxes.name.right, 'the name is not under the pane').toBeLessThanOrEqual(boxes.drawer.left);
    expect(boxes.input.width, 'the composer entry stays usable').toBeGreaterThan(150);
});

test.describe('wide desktop', () => {
    test.use({ viewport: { width: 2400, height: 1200 } });

    test('a chat column of 1120px or more docks settings as a third column', async ({ page, isMobile }) => {
        test.skip(isMobile, 'Desktop split view.');
        await seedConversation(page);

        const sheld = page.locator('#sheld[data-sb-conversation-mode="on"]');
        await expect(sheld).toHaveAttribute('data-sb-conversation-layout', 'split');
        await page.locator('[data-sb-conversation-action="open-settings"]').click();
        await expect(page.locator('#sb_conversation_settings_drawer')).toBeVisible();
        await expect(sheld).toHaveAttribute('data-sb-conversation-page', 'settings');
        await expect.poll(() => page.evaluate(() => Math.round(document.getElementById('sb_conversation_timeline').getBoundingClientRect().width))).toBeGreaterThanOrEqual(480);
        await expect.poll(() => page.evaluate(() => Math.round(document.getElementById('sb_conversation_settings_drawer').getBoundingClientRect().width))).toBe(360);
    });

    test('a docked pane has no shade and Escape closes it from inside the pane only', async ({ page, isMobile }) => {
        test.skip(isMobile, 'Desktop split view.');
        await seedConversation(page);

        const gear = page.locator('[data-sb-conversation-action="open-settings"]');
        const drawer = page.locator('#sb_conversation_settings_drawer');
        await gear.click();
        await expect(drawer).toBeVisible();
        await expect(page.locator('#sb_conversation_settings_backdrop')).toBeHidden();

        // The pane is a column of the layout, as libadwaita's docked sidebar: a press on the content or the rail does not close it.
        await page.locator('#sb_conversation_timeline').click({ position: { x: 100, y: 100 } });
        await page.locator('#sb_conversation_list').click({ position: { x: 80, y: 500 } });
        await expect(drawer).toBeVisible();

        // The content stays usable beside a docked pane, so Escape elsewhere is not the pane's to take.
        await page.locator('#sb_conversation_input').focus();
        await page.keyboard.press('Escape');
        await expect(drawer).toBeVisible();

        await drawer.locator('input, button').first().focus();
        await page.keyboard.press('Escape');
        await expect(drawer).toBeHidden();
        await expect(gear).toBeFocused();
    });
});

test('an overlay pane shades everything outside it, hides on a press anywhere there or on Escape, and returns focus to the gear', async ({ page, isMobile }) => {
    test.skip(isMobile, 'Desktop overlay pane.');
    await page.setViewportSize({ width: 1440, height: 900 });
    await seedConversation(page);

    const sheld = page.locator('#sheld[data-sb-conversation-mode="on"]');
    await expect(sheld).toHaveAttribute('data-sb-conversation-layout', 'overlay');
    const gear = page.locator('[data-sb-conversation-action="open-settings"]');
    const drawer = page.locator('#sb_conversation_settings_drawer');
    const shade = page.locator('#sb_conversation_settings_backdrop');
    await expect(shade).toBeHidden();

    await gear.click();
    await expect(drawer).toBeVisible();
    await expect(shade).toBeVisible();
    await expect(drawer).toHaveCSS('box-shadow', /56px/);
    const boxes = await page.evaluate(() => {
        const box = selector => {
            const rect = document.querySelector(selector).getBoundingClientRect();
            return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
        };
        return {
            shade: box('#sb_conversation_settings_backdrop'),
            drawer: box('#sb_conversation_settings_drawer'),
            rail: box('#sb_conversation_list'),
            header: box('#sb_conversation_header'),
            composer: box('#sb_conversation_form'),
            sheld: box('#sheld'),
            timeline: box('#sb_conversation_timeline'),
            shadeColor: getComputedStyle(document.getElementById('sb_conversation_settings_backdrop')).backgroundColor,
        };
    });
    // The shade fills #sheld's padding box, inside its 1px frame: the rail, header, timeline and composer all lie under it.
    expect(boxes.shade.left - boxes.sheld.left).toBeLessThanOrEqual(2);
    expect(boxes.shade.top - boxes.sheld.top).toBeLessThanOrEqual(2);
    expect(boxes.sheld.right - boxes.shade.right).toBeLessThanOrEqual(2);
    expect(boxes.sheld.bottom - boxes.shade.bottom).toBeLessThanOrEqual(2);
    expect(boxes.shadeColor, 'the shade dims, it is not transparent').not.toMatch(/rgba\(0, 0, 0, 0\)|transparent/);
    expect(boxes.drawer.left, 'the pane stays beside the rail').toBeGreaterThanOrEqual(boxes.rail.right);
    await expect(page.locator('#sb_conversation_list')).toBeVisible();

    // A press anywhere outside the pane hides it, and does not act on what lies under the shade.
    await page.evaluate(() => {
        window.__underClicks = 0;
        for (const id of ['sb_conversation_timeline', 'sb_conversation_form', 'sb_conversation_header', 'sb_conversation_list']) {
            document.getElementById(id).addEventListener('click', () => { window.__underClicks += 1; }, true);
        }
    });
    const presses = {
        'the timeline': [boxes.timeline.left + 100, boxes.timeline.bottom - 60],
        'the composer': [boxes.rail.right + 60, (boxes.composer.top + boxes.composer.bottom) / 2],
        'the header': [boxes.rail.right + 40, (boxes.header.top + boxes.header.bottom) / 2],
        'the Pals rail': [boxes.rail.left + 80, boxes.rail.top + 200],
    };
    for (const [place, [x, y]] of Object.entries(presses)) {
        // The pane is already open on the first pass, and its shade covers the gear.
        if (await drawer.isHidden()) await gear.click();
        await expect(drawer).toBeVisible();
        await expect(shade).toBeVisible();
        // Opening the pane is itself a click on the header, so the count starts here.
        await page.evaluate(() => { window.__underClicks = 0; });
        await clearToasts(page);
        await page.mouse.click(x, y);
        await expect(drawer, `a press on ${place}`).toBeHidden();
        await expect(shade).toBeHidden();
        expect(await page.evaluate(() => window.__underClicks), `a press on ${place} only dismisses the pane`).toBe(0);
        await expect(gear, `focus returns to the gear after a press on ${place}`).toBeFocused();
    }
    // A press inside the pane leaves it open.
    await gear.click();
    await expect(drawer).toBeVisible();
    await drawer.locator('.sb-conversation-settings-title').click();
    await expect(drawer).toBeVisible();
    await expect(shade).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(drawer).toBeHidden();

    // Escape closes it from the pane, from the composer, and with nothing focused.
    const places = {
        'the pane': () => drawer.locator('input, button').first().focus(),
        'the composer': () => page.locator('#sb_conversation_input').focus(),
        'nowhere': () => page.evaluate(() => document.activeElement?.blur()),
    };
    for (const [place, focus] of Object.entries(places)) {
        await gear.click();
        await expect(drawer).toBeVisible();
        await focus();
        await page.keyboard.press('Escape');
        await expect(drawer, `Escape from ${place}`).toBeHidden();
        await expect(shade).toBeHidden();
        await expect(gear, `focus returns to the gear after Escape from ${place}`).toBeFocused();
    }
});

test('the settings page returns focus to the control that opened it, which is the menu when the gear is hidden', async ({ page, isMobile }) => {
    test.skip(isMobile, 'Desktop widths.');
    await page.setViewportSize({ width: 1024, height: 700 });
    await seedConversation(page);

    const drawer = page.locator('#sb_conversation_settings_drawer');
    const menuButton = page.locator('[data-sb-conversation-action="open-conversation-menu"]');
    await menuButton.click();
    await page.locator('.sb-action-menu-item', { hasText: 'Conversation settings' }).click();
    await expect(drawer).toBeVisible();
    await drawer.locator('input, button').first().focus();
    await page.keyboard.press('Escape');
    await expect(drawer).toBeHidden();
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
        for (const [width, height, layout] of [[1440, 900, 'overlay'], [1269, 900, 'overlay'], [1169, 900, 'pages'], [1024, 600, 'pages'], [800, 900, 'pages']]) {
            await page.setViewportSize({ width, height });
            await expect(sheld, `${width}x${height}`).toHaveAttribute('data-sb-conversation-layout', layout);
            await expect.poll(() => page.locator('#sb_conversation_input').evaluate(element => Math.round(element.getBoundingClientRect().width)), { message: `${width}x${height}: composer entry width` }).toBeGreaterThanOrEqual(160);
        }

        await page.setViewportSize({ width: 1024, height: 600 });
        await expect(sheld).toHaveAttribute('data-sb-conversation-page', 'chat');
        await expect(page.locator('#sb_conversation_header .sb-conversation-header-back')).toBeVisible();
        await expect(page.locator('#sb_conversation_form [data-sb-conversation-action="open-composer-menu"]')).toBeVisible();
        await page.locator('#sb_conversation_list_toggle').click();
        await expect(sheld).toHaveAttribute('data-sb-conversation-page', 'list');
        await expect(page.locator('#sb_conversation_list')).toBeVisible();
    });

    test('opening the pane at a narrow width shows the page, not an overlay', async ({ page, isMobile }) => {
        test.skip(isMobile, 'Desktop widths.');
        await page.setViewportSize({ width: 1024, height: 700 });
        await seedConversation(page);

        // The pages layout hides the header gear, so the conversation menu is the way in even though the viewport is over 768px.
        await expect(page.locator('[data-sb-conversation-action="open-settings"]')).toBeHidden();
        await page.locator('[data-sb-conversation-action="open-conversation-menu"]').click();
        await page.locator('.sb-action-menu-item', { hasText: 'Conversation settings' }).click();
        const sheld = page.locator('#sheld[data-sb-conversation-mode="on"]');
        await expect(sheld).toHaveAttribute('data-sb-conversation-page', 'settings');
        await expect(page.locator('#sb_conversation_settings_drawer')).toBeVisible();
        await expect(page.locator('#sb_conversation_settings_backdrop')).toBeHidden();

        // Widening the window while the pane is open moves to the overlay, with its shade.
        await page.setViewportSize({ width: 1440, height: 900 });
        await expect(sheld).toHaveAttribute('data-sb-conversation-layout', 'overlay');
        await expect(page.locator('#sb_conversation_settings_drawer')).toBeVisible();
        await expect(page.locator('#sb_conversation_settings_backdrop')).toBeVisible();
    });
});

test('the header title is named by what it shows, and Branches is its description', async ({ page }) => {
    await seedConversation(page);
    const title = page.locator('#sb_conversation_header .sb-conversation-header-title');
    const shown = (await page.locator('#sb_conversation_header [data-sb-conversation-name]').textContent()).trim();
    expect(shown.length).toBeGreaterThan(0);
    // The visible label stays inside the accessible name (WCAG 2.5.3), and the name no longer carries ", branches".
    await expect(title).toHaveAccessibleName(new RegExp(`^${shown.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    await expect(title).not.toHaveAccessibleName(/branches/i);
    await expect(title).toHaveAccessibleDescription('Branches');
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

test('mobile pages keep pals, chat, and settings as full screens', async ({ page, isMobile }) => {
    test.skip(!isMobile, 'Mobile pages.');
    await seedConversation(page);

    const sheld = page.locator('#sheld[data-sb-conversation-mode="on"]');
    await expect(sheld).toHaveAttribute('data-sb-conversation-layout', 'pages');
    await expect(sheld).toHaveAttribute('data-sb-conversation-page', 'chat');
    await expect(page.locator('#sb_conversation_header .sb-conversation-header-back')).toBeVisible();
    await expect(page.locator('#sb_conversation_timeline .sb-conversation-mobile-menu-trigger').first()).toBeVisible();
    await expect(page.locator('#sb_conversation_form [data-sb-conversation-action="open-composer-menu"]')).toBeVisible();
    await expect(page.locator('#sb_conversation_form [data-sb-conversation-action="attach-file"]')).toBeHidden();

    await page.locator('#sb_conversation_list_toggle').click();
    await expect(sheld).toHaveAttribute('data-sb-conversation-page', 'list');
    await expect(page.locator('#sb_conversation_list')).toBeVisible();

    await page.locator('.sb-conversation-list-item').first().click();
    await expect(sheld).toHaveAttribute('data-sb-conversation-page', 'chat');
    await page.locator('[data-sb-conversation-action="open-conversation-menu"]').click();
    await page.locator('.sb-action-menu-item', { hasText: 'Conversation settings' }).click();
    await expect(sheld).toHaveAttribute('data-sb-conversation-page', 'settings');
    await expect(page.locator('#sb_conversation_settings_drawer')).toBeVisible();
    await expect(page.locator('#sb_conv_notifications_muted')).toHaveClass(/sb-switch/);
    await expect(page.locator('#sb_conv_notifications_muted')).toHaveAttribute('role', 'switch');
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
