import { afterEach, describe, expect, jest, test } from '@jest/globals';

async function loadState() {
    jest.resetModules();
    return import('../../public/scripts/sillybunny-temporary-chat-state.js');
}

let state;

afterEach(() => {
    state?.exitTemporaryState();
});

describe('temporary chat state', () => {
    test('is off until a temporary chat starts, and off again after it ends', async () => {
        state = await loadState();
        expect(state.isTemporaryChat()).toBe(false);

        state.enterTemporaryState({ avatar: 'Seraphina.png', previousChatName: 'Seraphina - 2026' });
        expect(state.isTemporaryChat()).toBe(true);

        state.exitTemporaryState();
        expect(state.isTemporaryChat()).toBe(false);
    });

    test('hands out a reserved chat name that no saved chat file can have', async () => {
        state = await loadState();
        const reserved = state.enterTemporaryState({ avatar: 'Seraphina.png', previousChatName: 'Seraphina - 2026' });

        expect(reserved).toMatch(/^Temporary Chat: [0-9a-f]{16}$/);
        // The server removes a colon from every chat file name, so no saved chat can have this name.
        expect(reserved).toContain(':');
        expect(state.getTemporaryChatState()).toEqual({ avatar: 'Seraphina.png', previousChatName: 'Seraphina - 2026', reservedName: reserved });
    });

    test('a second start gets another reserved name, so id-keyed caches of the first never match', async () => {
        state = await loadState();
        const first = state.enterTemporaryState({ avatar: 'a.png', previousChatName: 'x' });
        state.exitTemporaryState();
        const second = state.enterTemporaryState({ avatar: 'a.png', previousChatName: 'x' });

        expect(second).not.toBe(first);
    });

    test('a page load never reuses the name of an earlier page load, because a vector collection is keyed by it', async () => {
        const names = new Set();
        for (let session = 0; session < 5; session++) {
            state = await loadState();
            names.add(state.enterTemporaryState({ avatar: 'a.png', previousChatName: 'x' }));
            state.exitTemporaryState();
        }

        expect(names.size).toBe(5);
    });

    test('refuses to start while another temporary chat is open, so one state never hides the other', async () => {
        state = await loadState();
        state.enterTemporaryState({ avatar: 'a.png', previousChatName: 'x' });

        expect(() => state.enterTemporaryState({ avatar: 'b.png', previousChatName: 'y' })).toThrow(/already/i);
        expect(state.getTemporaryChatState().avatar).toBe('a.png');
    });

    test('knows its own reserved name and the character it is with', async () => {
        state = await loadState();
        const reserved = state.enterTemporaryState({ avatar: 'a.png', previousChatName: 'x' });

        expect(state.isReservedChatName(reserved)).toBe(true);
        expect(state.isReservedChatName('Temporary Chat: not-mine')).toBe(false);
        expect(state.isReservedChatName('a.png')).toBe(false);
        expect(state.isTemporaryChatWith('a.png')).toBe(true);
        expect(state.isTemporaryChatWith('b.png')).toBe(false);
        expect(state.isTemporaryChatWith(undefined)).toBe(false);

        state.exitTemporaryState();
        expect(state.isReservedChatName(reserved)).toBe(false);
        expect(state.isTemporaryChatWith('a.png')).toBe(false);
    });

    test('exiting reports what was there, so the caller can put the real chat name back', async () => {
        state = await loadState();
        const reserved = state.enterTemporaryState({ avatar: 'Seraphina.png', previousChatName: 'Seraphina - 2026' });

        expect(state.exitTemporaryState()).toEqual({ avatar: 'Seraphina.png', previousChatName: 'Seraphina - 2026', reservedName: reserved });
        expect(state.exitTemporaryState()).toBeNull();
    });

    test('turns the state back on with the same reserved name after a save that failed', async () => {
        state = await loadState();
        const reserved = state.enterTemporaryState({ avatar: 'Seraphina.png', previousChatName: 'Seraphina - 2026' });
        const ended = state.exitTemporaryState();

        state.restoreTemporaryState(ended);

        expect(state.isTemporaryChat()).toBe(true);
        expect(state.getTemporaryChatState().reservedName).toBe(reserved);
    });

    test('puts the reserved name back on a character list that the server just reset', async () => {
        state = await loadState();
        const reserved = state.enterTemporaryState({ avatar: 'Seraphina.png', previousChatName: 'Seraphina - 2026' });
        const characters = [{ avatar: 'Other.png', chat: 'Other - 1' }, { avatar: 'Seraphina.png', chat: 'Seraphina - 2026' }];

        state.reassertReservedChatName(characters);

        expect(characters.map(character => character.chat)).toEqual(['Other - 1', reserved]);
    });

    test('leaves a character list alone when no temporary chat is open or its character is gone', async () => {
        state = await loadState();
        const characters = [{ avatar: 'Seraphina.png', chat: 'Seraphina - 2026' }];

        state.reassertReservedChatName(characters);
        expect(characters[0].chat).toBe('Seraphina - 2026');

        state.enterTemporaryState({ avatar: 'Gone.png', previousChatName: 'x' });
        state.reassertReservedChatName(characters);
        expect(characters[0].chat).toBe('Seraphina - 2026');
    });

    test('the stored chat name of the temporary character is the real one, the others are unchanged', async () => {
        state = await loadState();
        const seraphina = { avatar: 'Seraphina.png', chat: 'Seraphina - 2026' };
        const other = { avatar: 'Other.png', chat: 'Other - 1' };
        expect(state.getStoredChatName(seraphina)).toBe('Seraphina - 2026');

        const reserved = state.enterTemporaryState({ avatar: 'Seraphina.png', previousChatName: 'Seraphina - 2026' });
        seraphina.chat = reserved;

        expect(state.getStoredChatName(seraphina)).toBe('Seraphina - 2026');
        expect(state.getStoredChatName(other)).toBe('Other - 1');
        expect(state.getStoredChatName(undefined)).toBe('');
    });

    test('a command that needs a chat file is refused while the chat is temporary, and goes on otherwise', async () => {
        state = await loadState();
        expect(() => state.assertChatFileWritable()).not.toThrow();

        state.enterTemporaryState({ avatar: 'a.png', previousChatName: 'x' });
        expect(() => state.assertChatFileWritable()).toThrow('TODO(copy)');

        state.exitTemporaryState();
        expect(() => state.assertChatFileWritable()).not.toThrow();
    });

    test('a chat counts as written in only when the user sent a message', async () => {
        state = await loadState();
        const greeting = { name: 'Seraphina', is_user: false, is_system: false, mes: 'Hello' };

        expect(state.hasSentMessage([])).toBe(false);
        expect(state.hasSentMessage([greeting])).toBe(false);
        expect(state.hasSentMessage([greeting, { name: 'Note', is_user: false, is_system: true, mes: 'note' }])).toBe(false);
        expect(state.hasSentMessage([greeting, { name: 'You', is_user: true, is_system: false, mes: 'Hi' }])).toBe(true);
    });
});
