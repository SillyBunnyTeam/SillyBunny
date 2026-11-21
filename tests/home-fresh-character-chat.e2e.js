import { expect, test } from '@playwright/test';
import { openQuietChatForSmoke } from './chat-scroll-regression-helpers.js';
import { assertIsolatedServer } from './helpers/maintainer-server.js';

test.use({ serviceWorkers: 'block', contextOptions: { reducedMotion: 'reduce' } });
test.describe.configure({ timeout: 90_000 });

const FRESH_NAME = 'Qa Fresh Home Character';

/**
 * Makes a character that has no chat on the server, which the app has to be asked for by its card. The server is
 * the real one, because the chat file of a first chat is made by the request that opens it.
 */
async function createFreshCharacter(page) {
    return page.evaluate(async (name) => {
        const script = await import('/script.js');
        const form = new FormData();
        form.append('ch_name', name);
        form.append('description', 'A character with no chat.');
        form.append('first_mes', 'Hello.');
        form.append('avatar_url', 'none');
        const created = await fetch('/api/characters/create', { method: 'POST', headers: script.getRequestHeaders({ omitContentType: true }), body: form });
        if (!created.ok) throw new Error(`The character was not created (${created.status}).`);
        await script.getCharacters();
        return (await created.text()).trim();
    }, FRESH_NAME);
}

test('a New Chat from a Home card on a character with no chat makes one chat file, not two', async ({ page, baseURL }) => {
    assertIsolatedServer(baseURL, 'The fresh character chat');
    const chatRequests = [];
    page.on('request', (request) => {
        if (new URL(request.url()).pathname !== '/api/chats/get') return;
        const payload = request.postDataJSON?.() ?? null;
        if (payload?.allow_create) chatRequests.push(payload.file_name);
    });
    await openQuietChatForSmoke(page, { selectCharacter: false });
    await expect(page.locator('#sheld')).toHaveAttribute('data-sb-home', 'on', { timeout: 30_000 });
    const avatar = await createFreshCharacter(page);

    try {
        await page.evaluate(async (target) => {
            const { createAppAssistantActions } = await import('/scripts/sillybunny-home/assistant-chat.js');
            const actions = createAppAssistantActions({ openConversation: async () => {} });
            await actions.newChat({ state: 'available', avatar: target });
        }, avatar);

        await expect.poll(() => page.evaluate(async () => (await import('/script.js')).getCurrentChatId())).toMatch(new RegExp(`^${FRESH_NAME} - `));
        expect(new Set(chatRequests).size, 'chat files that a request was allowed to make').toBe(1);
    } finally {
        await page.evaluate(async (target) => {
            const script = await import('/script.js');
            await fetch('/api/characters/delete', {
                method: 'POST',
                headers: script.getRequestHeaders(),
                body: JSON.stringify({ avatar_url: target, delete_chats: true }),
            });
        }, avatar);
    }
});
