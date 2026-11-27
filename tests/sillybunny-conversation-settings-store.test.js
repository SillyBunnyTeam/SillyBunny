import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';

import { createConversationData } from '../public/scripts/sillybunny-conversation/conversation-data.js';
import { PERSONA, seedConversations, startConversationServer } from './util/conversation-data-fixture.js';

const extensionSettings = {};
const knownCharacters = [];
const saveSettingsDebounced = jest.fn();
let data;

// The module under test reads the page's data module through this stand-in, which points at the one of the test.
const conversationData = new Proxy({}, { get: (_target, key) => data[key] });

await jest.unstable_mockModule('../public/script.js', () => ({
    characters: knownCharacters,
    getThumbnailUrl: (type, file) => `/thumb/${type}/${file}`,
    saveSettingsDebounced,
    this_chid: undefined,
}));
await jest.unstable_mockModule('../public/scripts/extensions.js', () => ({ extension_settings: extensionSettings }));
await jest.unstable_mockModule('../public/scripts/group-chats.js', () => ({ editGroup: jest.fn(), groups: [], selected_group: null }));
await jest.unstable_mockModule('../public/scripts/personas.js', () => ({ user_avatar: PERSONA }));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/conversation-data-browser.js', () => ({ conversationData }));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/media.js', () => ({
    getCharacterForAvatar: avatar => knownCharacters.find(character => character.avatar === avatar) ?? null,
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/state.js', () => ({
    conversationState: { conversationSelectedAvatar: null, conversationSelectedGroupId: null, conversationWorkspaceOpen: false },
}));

const {
    clearConversationMemorySummary,
    getConversationMemorySummary,
    getConversationWelcomeChats,
    getConversationSessionMarker,
    getLastUserActivity,
    getSettings,
    hasAnyConversationModeUsage,
    isConversationModeEnabled,
    saveConversationMemorySummary,
    setConversationSessionMarker,
    setLastUserActivity,
} = await import('../public/scripts/sillybunny-conversation/settings-store.js');
const { DEFAULT_SETTINGS } = await import('../public/scripts/sillybunny-conversation/constants.js');
const { getConversationStore, persistConversationStore } = await import('../public/scripts/sillybunny-conversation/context.js');

let server;

/** Puts mode-wide values where the page reads them: the object of the mode in settings.json. */
function setModeWideSettings(values) {
    extensionSettings.sillybunny_conversation = { version: 2, localStorageMigrated: true, settings: values };
}

async function startData(descriptors) {
    seedConversations(server, descriptors);
    data = createConversationData(server.adapter());
    await data.start();
}

const DIRECT = { id: 'conv_1_direct01', characters: ['Nova.png'], chats: [{ id: 'main', name: 'Main', messages: ['hello', 'hi'] }] };
const GROUP = { id: 'conv_2_group001', characters: ['Orion.png', 'Pax.png'], name: 'Crew', chats: [{ id: 'main', messages: [] }] };

beforeEach(async () => {
    server = await startConversationServer();
    for (const avatar of ['Nova.png', 'Orion.png', 'Pax.png']) {
        knownCharacters.push({ avatar, name: avatar.replace('.png', '') });
    }
});

afterEach(async () => {
    data?.destroy();
    data = undefined;
    knownCharacters.length = 0;
    for (const key of Object.keys(extensionSettings)) {
        delete extensionSettings[key];
    }
    saveSettingsDebounced.mockClear();
    await server.stop();
});

describe('getSettings', () => {
    test('is the defaults for a character that has no conversation, with the mode-wide values on top', async () => {
        await startData([]);
        setModeWideSettings({ custom_instructions: 'be brief' });

        const settings = getSettings('Nova.png', { groupId: '' });

        expect(settings).toMatchObject({ ...DEFAULT_SETTINGS, custom_instructions: 'be brief', availability: 'online' });
        expect(isConversationModeEnabled('Nova.png', { groupId: '' })).toBe(false);
    });

    test('puts the conversation over the defaults, the mode-wide values over the conversation, and the prompt under its old key', async () => {
        await startData([{ ...DIRECT, settings: { inactivity_threshold: 90, custom_instructions: 'conversation value', system_prompt: 'Stay in character.' } }]);
        setModeWideSettings({ custom_instructions: 'mode-wide value' });

        const settings = getSettings('Nova.png', { groupId: '' });

        expect(settings.inactivity_threshold).toBe(90);
        expect(settings.custom_instructions).toBe('mode-wide value');
        expect(settings.geechan_chatroom_prompt).toBe('Stay in character.');
        expect(isConversationModeEnabled('Nova.png', { groupId: '' })).toBe(true);
    });

    test('holds the mode-wide quiet hours and Simulate reply delay for every conversation', async () => {
        await startData([DIRECT, GROUP]);
        setModeWideSettings({ quiet_hours_start: '22:00', quiet_hours_end: '07:00', simulate_reply_delay: false });

        for (const [avatar, groupId] of [['Nova.png', ''], ['Orion.png', 'conv_2_group001']]) {
            expect(getSettings(avatar, { groupId })).toMatchObject({ quiet_hours_start: '22:00', quiet_hours_end: '07:00', simulate_reply_delay: false });
        }
    });

    test('lists the extras of a direct conversation as a read-only value, and nothing of the removed cross-talk keys', async () => {
        await startData([{ ...DIRECT, extras: ['Pax.png'] }, GROUP]);

        expect(getSettings('Nova.png', { groupId: '' }).multi_char_names).toBe('Pax.png');
        for (const settings of [getSettings('Nova.png', { groupId: '' }), getSettings('Orion.png', { groupId: 'conv_2_group001' })]) {
            for (const key of ['multi_char', 'auto_character_chat', 'auto_chat_names', 'auto_chat_cooldown']) {
                expect(Object.keys(settings)).not.toContain(key);
            }
        }
    });

    test('takes the availability of the character from its state, not from the conversation', async () => {
        await startData([DIRECT]);
        data.patchCharacter('Nova.png', { statusOverride: 'dnd' });

        expect(getSettings('Nova.png', { groupId: '' }).availability).toBe('dnd');
    });
});

describe('the mode-wide settings', () => {
    test('are written to the object of the mode in settings.json, without the old parts of the store', async () => {
        await startData([DIRECT]);

        const store = getConversationStore();
        store.settings = { ...store.settings, custom_instructions: 'be brief' };
        persistConversationStore();
        await data.flush();

        const written = JSON.parse(JSON.stringify(extensionSettings.sillybunny_conversation));
        expect(written.version).toBe(2);
        for (const part of ['characters', 'groups', 'reminders', 'legacyThreadPersonaAssignments']) {
            expect(Object.hasOwn(written, part)).toBe(false);
        }
        expect(written.settings.custom_instructions).toBe('be brief');
        expect(Object.hasOwn(data.get('conv_1_direct01').settings, 'custom_instructions')).toBe(false);
        expect(saveSettingsDebounced).toHaveBeenCalled();
    });
});

describe('the state of a chat', () => {
    test('is read from the list and written as a patch of the conversation', async () => {
        await startData([DIRECT]);

        setLastUserActivity('Nova.png', 4242, { groupId: '' });
        setConversationSessionMarker('Nova.png', 'greeted', 'yes', { groupId: '' });

        expect(getLastUserActivity('Nova.png', 1, { groupId: '' })).toBe(4242);
        expect(getConversationSessionMarker('Nova.png', 'greeted', { groupId: '' })).toBe('yes');
        await data.flush();
        const stored = await server.adapter().fetchJson('/get', { id: 'conv_1_direct01' });
        expect(stored.json.conversation.chats[0]).toMatchObject({ lastActivity: 4242, sessionMarkers: { greeted: 'yes' } });
    });
});

describe('the conversations of the persona', () => {
    test('a group without messages is listed, as a conversation of its own', async () => {
        await startData([DIRECT, GROUP]);

        expect(hasAnyConversationModeUsage()).toBe(true);
        const names = getConversationWelcomeChats().map(chat => chat.char_name);
        expect(names).toContain('Crew');
        expect(names).toContain('Nova');
    });

    test('another persona has no conversations here', async () => {
        await startData([{ ...DIRECT, personaId: 'other.png' }]);

        expect(hasAnyConversationModeUsage()).toBe(false);
        expect(getConversationWelcomeChats()).toEqual([]);
    });

    test('Home gets the ids of the conversation and of its active chat, newest message first', async () => {
        await startData([
            { ...DIRECT, chats: [{ id: 'main', name: 'Main', messages: ['old'] }] },
            { id: 'conv_3_second001', characters: ['Orion.png'], chats: [{ id: 'trip', name: 'Trip', messages: [{ text: 'new', minute: 500 }] }] },
        ]);

        const chats = getConversationWelcomeChats();

        expect(chats.map(chat => chat.conversation_id)).toEqual(['conv_3_second001', 'conv_1_direct01']);
        expect(chats[0]).toMatchObject({ conversation_chat_id: 'trip', conversation_chat_name: 'Trip', is_conversation: true, avatar: 'Orion.png', group: '' });
        expect(getConversationWelcomeChats({ max: 1 })).toHaveLength(1);
    });
});

describe('memory summaries', () => {
    test('clearConversationMemorySummary clears only the resolved target chat and leaves other loaded chats intact', async () => {
        await startData([{
            ...DIRECT,
            chats: [
                { id: 'main', name: 'Main', messages: ['hello'] },
                { id: 'side', name: 'Side', messages: ['other branch'] },
            ],
            activeChatId: 'main',
        }]);
        await data.loadChat({ conversationId: 'conv_1_direct01', chatId: 'main' });
        await data.loadChat({ conversationId: 'conv_1_direct01', chatId: 'side' });
        saveConversationMemorySummary('Nova.png', 'Main summary', 1, { chatId: 'main', groupId: '' });
        saveConversationMemorySummary('Nova.png', 'Side summary', 1, { chatId: 'side', groupId: '' });

        expect(clearConversationMemorySummary('Nova.png', { groupId: '' })).toBe(true);
        expect(getConversationMemorySummary('Nova.png', { chatId: 'main', groupId: '' })).toBe('');
        expect(getConversationMemorySummary('Nova.png', { chatId: 'side', groupId: '' })).toBe('Side summary');

        expect(clearConversationMemorySummary('Nova.png', { chatId: 'side', groupId: '' })).toBe(true);
        expect(getConversationMemorySummary('Nova.png', { chatId: 'side', groupId: '' })).toBe('');
        expect(clearConversationMemorySummary('Nova.png', { chatId: 'missing', groupId: '' })).toBe(false);
        await data.flush();
    });

    test('saveConversationMemorySummary and clearConversationMemorySummary initialize missing header.chat_metadata', async () => {
        await startData([DIRECT]);
        const loaded = await data.loadChat({ conversationId: 'conv_1_direct01', chatId: 'main' });
        delete loaded.header.chat_metadata;

        saveConversationMemorySummary('Nova.png', 'Recovered summary', 2, { chatId: 'main', groupId: '' });
        expect(getConversationMemorySummary('Nova.png', { chatId: 'main', groupId: '' })).toBe('Recovered summary');

        delete loaded.header.chat_metadata;
        expect(clearConversationMemorySummary('Nova.png', { chatId: 'main', groupId: '' })).toBe(true);
        expect(getConversationMemorySummary('Nova.png', { chatId: 'main', groupId: '' })).toBe('');
        await data.flush();
    });
});
