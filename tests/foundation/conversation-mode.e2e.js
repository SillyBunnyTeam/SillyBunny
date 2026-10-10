import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page, baseURL }) => {
    await page.route('**/*', route => {
        const url = new URL(route.request().url());
        if (url.origin !== baseURL) {
            return route.abort();
        }
        if (url.pathname === '/api/chats/save' || url.pathname === '/api/settings/save') {
            return route.fulfill({ json: {} });
        }
        return route.continue();
    });
});

async function seedConversation(page) {
    await page.goto('/');
    await page.waitForFunction(() => document.getElementById('preloader') === null, null, { timeout: 60000 });
    await page.evaluate(() => document.querySelectorAll('dialog[open]').forEach(dialog => dialog.close()));
    await page.evaluate(async () => {
        const context = window.SillyTavern.getContext();
        if (!context.characters.length) {
            await context.getCharacters();
        }
        const character = context.characters.find(entry => /Bunny Guide|Seraphina/.test(entry?.name ?? ''));
        if (!character?.avatar) {
            throw new Error('No bundled Conversation character found.');
        }
        const id = context.characters.findIndex(entry => entry.avatar === character.avatar);
        await context.selectCharacterById(id, { switchMenu: false });
        document.querySelectorAll('dialog[open]').forEach(dialog => dialog.close());

        const { saveConversationThread } = await import('/scripts/sillybunny-conversation/thread-store.js');
        const day = Date.UTC(2026, 8, 30, 12, 0, 0);
        const nextDay = Date.UTC(2026, 9, 1, 9, 0, 0);
        saveConversationThread(character.avatar, [
            { id: 'seed-0', role: 'character', name: character.name, mes: 'Good morning. The glade is quiet.', send_date: new Date(day).toISOString(), created_at: day, extra: {} },
            { id: 'seed-1', role: 'user', name: 'Tester', mes: 'Hi. I wanted to check in.', send_date: new Date(day + 60_000).toISOString(), created_at: day + 60_000, extra: {} },
            { id: 'seed-2', role: 'character', name: character.name, mes: 'Still here after a longer pause.', send_date: new Date(day + 21 * 60_000).toISOString(), created_at: day + 21 * 60_000, extra: {} },
            { id: 'seed-3', role: 'character', name: character.name, mes: 'A new day in the forest.', send_date: new Date(nextDay).toISOString(), created_at: nextDay, extra: {} },
        ]);

        const { openConversationWorkspaceForAvatar } = await import('/scripts/sillybunny-conversation.js');
        if (!openConversationWorkspaceForAvatar(character.avatar, { showToast: false, enable: true })) {
            throw new Error(`Could not open Conversation workspace for ${character.avatar}`);
        }
    });
    await expect(page.locator('#sheld[data-sb-conversation-mode="on"]')).toBeVisible();
    await expect(page.locator('#sb_conversation_timeline .sb-conversation-message')).toHaveCount(4, { timeout: 15000 });
}

test('desktop split view groups bubbles and keeps settings as a pane', async ({ page, isMobile }) => {
    test.skip(isMobile, 'Desktop split view.');
    await seedConversation(page);

    const sheld = page.locator('#sheld[data-sb-conversation-mode="on"]');
    await expect(sheld).toHaveAttribute('data-sb-conversation-layout', 'split');
    await expect(page.locator('#sb_conversation_pals_rail')).toBeVisible();
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
    await expect(page.locator('#sb_conversation_settings_backdrop')).toBeHidden();
    await expect(page.locator('#sb_conv_idle_followup')).toHaveClass(/sb-conversation-switch/);
    await expect(page.locator('#sb_conv_grounded_dialogue_rules')).toBeHidden();
    await expect(page.locator('[data-sb-conversation-action="edit-grounded-dialogue-rules"]')).toBeVisible();
});

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

    await page.locator('#sb_conversation_pals_toggle').click();
    await expect(sheld).toHaveAttribute('data-sb-conversation-page', 'pals');
    await expect(page.locator('#sb_conversation_pals_rail')).toBeVisible();

    await page.locator('.sb-conversation-pal').first().click();
    await expect(sheld).toHaveAttribute('data-sb-conversation-page', 'chat');
    await page.locator('[data-sb-conversation-action="open-conversation-menu"]').click();
    await page.locator('.sb-action-menu-item', { hasText: 'Conversation settings' }).click();
    await expect(sheld).toHaveAttribute('data-sb-conversation-page', 'settings');
    await expect(page.locator('#sb_conversation_settings_drawer')).toBeVisible();
    await expect(page.locator('#sb_conv_notifications_muted')).toHaveClass(/sb-conversation-switch/);
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
    // sizes (44px/16px, compact 38px/14px), which come from the same --sb-mobile-composer-action-* tokens.
    const conversation = await measureSend('#sb_conversation_send');
    expect(conversation).toEqual({
        default: { width: 44, height: 44, icon: '16px' },
        compact: { width: 38, height: 38, icon: '14px' },
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
