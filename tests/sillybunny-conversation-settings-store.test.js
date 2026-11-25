import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';

import { createConversationData } from '../public/scripts/sillybunny-conversation/conversation-data.js';
import { PERSONA, seedConversations, settle, startConversationServer } from './util/conversation-data-fixture.js';

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
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/settings-panel.js', () => ({ renderConversationMemoryPanel: jest.fn() }));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/state.js', () => ({
    conversationState: { conversationSelectedAvatar: null, conversationSelectedGroupId: null, conversationWorkspaceOpen: false },
}));

const {
    getConversationWelcomeChats,
    getConversationSessionMarker,
    getLastUserActivity,
    getSettings,
    hasAnyConversationModeUsage,
    isConversationModeEnabled,
    saveSettings,
    setConversationSessionMarker,
    setLastUserActivity,
} = await import('../public/scripts/sillybunny-conversation/settings-store.js');
const { DEFAULT_SETTINGS } = await import('../public/scripts/sillybunny-conversation/constants.js');

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

describe('saveSettings', () => {
    test('writes only the values that differ from the defaults, and removes a value that went back to its default', async () => {
        await startData([DIRECT]);

        saveSettings('Nova.png', { ...getSettings('Nova.png', { groupId: '' }), inactivity_threshold: 90, geechan_chatroom_prompt: 'Be kind.' }, { groupId: '' });
        await data.flush();

        expect(data.get('conv_1_direct01').settings).toMatchObject({ inactivity_threshold: 90, system_prompt: 'Be kind.' });
        expect(Object.keys(data.get('conv_1_direct01').settings)).not.toContain('geechan_chatroom_prompt');

        saveSettings('Nova.png', { ...getSettings('Nova.png', { groupId: '' }), inactivity_threshold: DEFAULT_SETTINGS.inactivity_threshold }, { groupId: '' });
        await data.flush();

        expect(Object.hasOwn(data.get('conv_1_direct01').settings, 'inactivity_threshold')).toBe(false);
    });

    test('writes a status other than online to the character, and online clears it', async () => {
        await startData([DIRECT]);

        saveSettings('Nova.png', { ...getSettings('Nova.png', { groupId: '' }), availability: 'idle' }, { groupId: '' });
        expect(data.characterState('Nova.png').statusOverride).toBe('idle');

        saveSettings('Nova.png', { ...getSettings('Nova.png', { groupId: '' }), availability: 'online' }, { groupId: '' });
        expect(data.characterState('Nova.png').statusOverride ?? null).toBeNull();
        await data.flush();
    });

    test('never writes the old parts of the store into the object of the mode in settings.json', async () => {
        await startData([DIRECT]);

        saveSettings('Nova.png', { ...getSettings('Nova.png', { groupId: '' }), custom_instructions: 'be brief' }, { groupId: '' });
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

    test('does nothing for a character without a conversation except for the mode-wide values', async () => {
        await startData([]);

        saveSettings('Nova.png', { ...DEFAULT_SETTINGS, inactivity_threshold: 12 }, { groupId: '' });
        await settle();

        expect(data.list()).toHaveLength(0);
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
