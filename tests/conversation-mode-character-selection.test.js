/** @jest-environment jsdom */
import { describe, expect, jest, test } from '@jest/globals';
import { importScriptModule } from './util/script-harness.js';
import { importTabsModule } from './util/tabs-harness.js';

describe('Conversation mode character selection', () => {
    test('dispatches sb:roleplay-character-selected with the chosen character avatar when selecting a character', async () => {
        const fetchMock = jest.fn(async url => {
            if (String(url).includes('/api/chats/get')) {
                return { ok: true, status: 200, json: async () => [{ chat_metadata: {} }, { name: 'Alice', is_user: false, mes: 'Hi!' }] };
            }
            return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
        });

        const loaded = await importScriptModule({ fetch: fetchMock });
        const { script } = loaded;
        script.characters.push({
            name: 'Alice',
            avatar: 'alice.png',
            chat: 'Alice - chat 1',
            first_mes: 'Hi!',
        });

        const selectedEvents = [];
        const onSelected = event => selectedEvents.push(event.detail);
        window.addEventListener('sb:roleplay-character-selected', onSelected);
        try {
            const ok = await script.selectCharacterById(0);
            expect(ok).toBe(true);
            expect(selectedEvents).toEqual([{ avatar: 'alice.png' }]);
        } finally {
            window.removeEventListener('sb:roleplay-character-selected', onSelected);
            loaded.cleanup();
        }
    });

    test('switching to Conversation mode from the top-bar mode menu dispatches the active character avatar without a toast', async () => {
        const loaded = await importTabsModule({
            characters: [{ name: 'Alice', avatar: 'alice.png' }],
            this_chid: 0,
        });
        const openedEvents = [];
        const onOpen = event => openedEvents.push(event.detail);
        window.addEventListener('sb:open-conversation-workspace', onOpen);
        try {
            document.getElementById('sb-mode-toggle').click();
            const conversationItem = [...document.querySelectorAll('#sb-mode-menu .sb-mode-menu-item')]
                .find(item => !item.classList.contains('is-active'));
            expect(conversationItem).not.toBeUndefined();
            conversationItem.click();

            expect(openedEvents).toEqual([{
                avatar: 'alice.png',
                showToast: false,
            }]);
        } finally {
            window.removeEventListener('sb:open-conversation-workspace', onOpen);
            loaded.cleanup();
        }
    });
});
