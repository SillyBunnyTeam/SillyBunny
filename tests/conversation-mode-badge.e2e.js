import { expect, test } from '@playwright/test';
import { bootConversationPage, getCharacterAvatars, patchConversation } from './helpers/conversation-list-steps.js';
import { seedConversation } from './helpers/conversation-seed.js';

test.use({ serviceWorkers: 'block' });
test.describe.configure({ timeout: 120000 });

const MODE_BUTTON = '#sb-mode-toggle';
const BADGE = `${MODE_BUTTON} .sb-mode-badge`;
const MENU_ITEMS = '#sb-mode-menu .sb-mode-menu-item';

/**
 * A page in Roleplay mode with a conversation that has two unread replies (Seraphina) and one that has none (Tewi).
 * @returns {Promise<{ seraphina: string, tewi: string, unread: { conversationId: string, chatIds: string[] } }>}
 */
async function bootWithUnreadReplies(page, baseURL, options = {}) {
    await bootConversationPage(page, baseURL, options);
    const { seraphina, tewi } = await getCharacterAvatars(page);
    const unread = await seedConversation(page, {
        avatar: seraphina,
        chats: [{ messages: [
            { role: 'character', mes: 'Hi' },
            { role: 'user', mes: 'Hey' },
            { role: 'character', mes: 'Almost.' },
            { role: 'character', mes: 'Ten more minutes.' },
        ] }],
    });
    await seedConversation(page, { avatar: tewi, chats: [{ messages: [{ role: 'character', mes: 'A very lucky rabbit. Me.' }] }] });
    // The seed reads every chat through its last message; the marker moves back so that the last two replies are unread.
    await patchConversation(page, unread.conversationId, { chats: { [unread.chatIds[0]]: { readThrough: 'seed-0-1' } } });
    return { seraphina, tewi, unread };
}

const open = (page, avatar) => page.evaluate(
    value => window.dispatchEvent(new CustomEvent('sb:open-conversation-workspace', { detail: { avatar: value, showToast: false } })),
    avatar,
);

/** The unread messages that the data module counts for the persona of the page. */
const countUnread = page => page.evaluate(async () => {
    const { conversationData } = await import('/scripts/sillybunny-conversation/conversation-data-browser.js');
    const { user_avatar: personaId } = await import('/scripts/personas.js');
    return conversationData.list({ personaId }).reduce((total, conversation) => total + conversation.unread, 0);
});

const close = page => page.evaluate(() => window.dispatchEvent(new CustomEvent('sb:close-conversation-workspace')));

for (const [name, viewport, touch] of [
    ['desktop 1440x900', { width: 1440, height: 900 }, false],
    ['phone 390x844', { width: 390, height: 844 }, true],
]) {
    test.describe(`the unread count on the chat mode button at ${name}`, () => {
        test.use({ viewport, hasTouch: touch, isMobile: touch });

        test('shows on the button in Roleplay mode, and the button is named by it', async ({ page, baseURL }) => {
            await bootWithUnreadReplies(page, baseURL);

            await expect(page.locator(BADGE)).toHaveText('2');
            await expect(page.locator(BADGE)).toBeVisible();
            await expect(page.getByRole('button', { name: 'Chat Mode: Roleplay (Ctrl+M), 2 Unread' })).toBeVisible();
            await expect(page.locator(MODE_BUTTON)).toHaveAttribute('title', 'Chat Mode: Roleplay (Ctrl+M), 2 Unread');
            const button = await page.locator(MODE_BUTTON).boundingBox();
            const badge = await page.locator(BADGE).boundingBox();
            expect(badge.x + badge.width / 2).toBeGreaterThan(button.x + button.width / 2);
            expect(badge.y + badge.height / 2).toBeLessThan(button.y + button.height / 2);
        });

        test('shows on the Conversation item of the menu that the button opens', async ({ page, baseURL }) => {
            await bootWithUnreadReplies(page, baseURL);
            await expect(page.locator(BADGE)).toHaveText('2');

            await page.locator(MODE_BUTTON).click();

            await expect(page.locator(MENU_ITEMS)).toHaveCount(2);
            await expect(page.locator(`${MENU_ITEMS} .sb-mode-badge`)).toHaveCount(1);
            await expect(page.locator(MENU_ITEMS).last().locator('.sb-mode-badge')).toHaveText('2');
            await expect(page.getByRole('menuitemradio', { name: /^Conversation.*2 Unread/ })).toBeVisible();
            await expect(page.getByRole('menuitemradio', { name: /^Roleplay/ })).not.toContainText('Unread');
        });

        test('is gone while Conversation Mode is open, and comes back when it closes', async ({ page, baseURL }) => {
            const { tewi } = await bootWithUnreadReplies(page, baseURL);
            await expect(page.locator(BADGE)).toHaveText('2');

            await open(page, tewi);
            await expect(page.locator('#sheld')).toHaveAttribute('data-sb-conversation-mode', 'on');

            await expect(page.locator(BADGE)).toHaveCount(0);
            await expect(page.getByRole('button', { name: /^Chat Mode: Conversation \(Ctrl\+M\)$/ })).toBeVisible();

            await close(page);
            await expect(page.locator('#sheld')).not.toHaveAttribute('data-sb-conversation-mode', 'on');
            await expect(page.locator(BADGE)).toHaveText('2');
        });

        test('clears when the replies are read', async ({ page, baseURL }) => {
            const { unread } = await bootWithUnreadReplies(page, baseURL);
            await expect(page.locator(BADGE)).toHaveText('2');

            await patchConversation(page, unread.conversationId, { chats: { [unread.chatIds[0]]: { readThrough: 'seed-0-3' } } });

            await expect(page.locator(BADGE)).toHaveCount(0);
            await expect(page.getByRole('button', { name: 'Chat Mode: Roleplay (Ctrl+M)', exact: true })).toBeVisible();
            await expect(page.locator(MODE_BUTTON)).toHaveAttribute('title', 'Chat Mode: Roleplay (Ctrl+M)');
        });

        test('clears when the conversation is opened, because opening reads it', async ({ page, baseURL }) => {
            const { seraphina } = await bootWithUnreadReplies(page, baseURL);
            await expect(page.locator(BADGE)).toHaveText('2');

            await open(page, seraphina);
            await expect(page.locator('#sheld')).toHaveAttribute('data-sb-conversation-mode', 'on');
            await expect.poll(() => countUnread(page)).toBe(0);
            await close(page);

            await expect(page.locator('#sheld')).not.toHaveAttribute('data-sb-conversation-mode', 'on');
            await expect(page.locator(BADGE)).toHaveCount(0);
        });
    });
}
