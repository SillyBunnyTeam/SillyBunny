/** @jest-environment jsdom */
import { describe, expect, jest, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { importScriptModule } from './util/script-harness.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Deferred to Batch 6 (`tabs-harness.js`) where `sillybunny-tabs.js` is executed directly.
const tabsSource = readFileSync(path.join(repoRoot, 'public', 'scripts', 'sillybunny-tabs.js'), 'utf8').replace(/\r\n/g, '\n');

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

        expect(tabsSource).toContain('characters, displayVersion, flushCharacterSaveDebounced');
        expect(tabsSource).toContain('saveSettingsDebounced, this_chid } from \'../script.js\';');
        expect(tabsSource).toContain('avatar: characters[this_chid]?.avatar || \'\',');
        expect(tabsSource).toContain('showToast: false,');
    });
});
