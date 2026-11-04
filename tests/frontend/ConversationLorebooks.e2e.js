import { test, expect } from '@playwright/test';
import { testSetup } from './frontent-test-utils.js';

const TRANSCRIPT_HEADER = 'Conversation transcript:';

function getSystemPrompt(body) {
    return body.messages.find(message => message.role === 'system')?.content ?? '';
}

test.describe('Conversation lorebooks', () => {
    // A service worker that controls the page would answer requests before page.route sees them.
    test.use({ serviceWorkers: 'block' });
    test.beforeEach(async ({ page }) => {
        // Settings writes stay in this page, so the global switch and the fixture thread never reach the server.
        let settingsVersion = Date.now();
        await page.route('**/api/settings/save', route => route.fulfill({ status: 200, json: { version: ++settingsVersion } }));
        await testSetup.awaitST({ page });
    });

    test('sends linked lorebook entries in Conversation replies until the switch is off', async ({ page }) => {
        test.setTimeout(120_000);
        const suffix = Date.now();
        const bookName = `CONV_LORE_${suffix}`;
        const entryText = `Lexicon entry ${suffix}: the moon rabbit pounds rice cakes.`;
        const requests = [];
        const replyRequests = () => requests.filter(body => body.messages?.some(message => message.content === TRANSCRIPT_HEADER));
        let avatar = '';

        await page.route('**/api/backends/chat-completions/generate', async (route) => {
            requests.push(route.request().postDataJSON());
            await route.fulfill({ json: { choices: [{ message: { role: 'assistant', content: 'Noted.' }, text: 'Noted.' }] } });
        });

        try {
            avatar = await page.evaluate(async ({ bookName, characterName, entryText }) => {
                const { getCharacters, getRequestHeaders } = await import('./script.js');
                const { convertCharacterBook, saveWorldInfo, updateWorldInfoList } = await import('./scripts/world-info.js');
                const book = convertCharacterBook({
                    entries: [{ id: 1, comment: 'Lexicon', content: entryText, keys: ['lexicon'], insertion_order: 100, enabled: true }],
                });
                if (!await saveWorldInfo(bookName, book, true)) {
                    throw new Error('Could not save the fixture lorebook');
                }
                await updateWorldInfoList();
                const response = await fetch('/api/characters/create', {
                    method: 'POST',
                    headers: getRequestHeaders(),
                    body: JSON.stringify({ ch_name: characterName, description: 'A fixture character.', world: bookName }),
                });
                if (!response.ok) {
                    throw new Error(`Could not create the fixture character: ${response.status}`);
                }
                const createdAvatar = await response.text();
                await getCharacters();
                return createdAvatar;
            }, { bookName, characterName: `Lore Fixture ${suffix}`, entryText });

            await page.evaluate(async (fixtureAvatar) => {
                const { openConversationWorkspaceForAvatar } = await import('./scripts/sillybunny-conversation.js');
                if (!openConversationWorkspaceForAvatar(fixtureAvatar, { showToast: false, enable: true })) {
                    throw new Error('Could not open the fixture Conversation');
                }
            }, avatar);

            const input = page.locator('#sb_conversation_input');
            const send = page.locator('#sb_conversation_send');
            await input.fill('Tell me about the lexicon.');
            await send.click();
            await expect.poll(() => replyRequests().length, { timeout: 30_000 }).toBe(1);
            expect(getSystemPrompt(replyRequests()[0])).toContain(entryText);

            await page.locator('[data-sb-conversation-action="open-settings"]').first().click();
            const lorebookSwitch = page.locator('#sb_conv_lorebooks_enabled');
            await expect(lorebookSwitch).toBeChecked();
            await lorebookSwitch.uncheck();
            await page.locator('[data-sb-conversation-action="close-settings"]').first().click();

            await input.fill('Is the lexicon still there?');
            await send.click();
            await expect.poll(() => replyRequests().length, { timeout: 30_000 }).toBe(2);
            expect(getSystemPrompt(replyRequests()[1])).not.toContain(entryText);
        } finally {
            await page.evaluate(async ({ bookName, fixtureAvatar }) => {
                const { getCharacters, getRequestHeaders } = await import('./script.js');
                const { deleteWorldInfo, world_names } = await import('./scripts/world-info.js');
                if (fixtureAvatar) {
                    await fetch('/api/characters/delete', {
                        method: 'POST',
                        headers: getRequestHeaders(),
                        body: JSON.stringify({ avatar_url: fixtureAvatar, delete_chats: true }),
                    });
                    await getCharacters();
                }
                if (world_names.includes(bookName)) {
                    await deleteWorldInfo(bookName);
                }
            }, { bookName, fixtureAvatar: avatar });
        }
    });
});
