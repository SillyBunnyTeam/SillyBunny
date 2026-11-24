import { beforeEach, describe, expect, jest, test } from '@jest/globals';

const saveSettingsDebounced = jest.fn();
const emit = jest.fn();
const powerUser = {
    persona_description: 'active persona description',
    persona_descriptions: {},
    personas: {
        'active.png': 'Active',
        'target.png': 'Target',
    },
};

await jest.unstable_mockModule('../public/scripts/popup.js', () => ({
    POPUP_RESULT: { AFFIRMATIVE: 1, NEGATIVE: 0, CANCELLED: null },
    POPUP_TYPE: { TEXT: 1, CONFIRM: 2, INPUT: 3 },
    Popup: class Popup {},
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/dialogs.js', () => ({
    confirmConversationAction: jest.fn(async () => false),
    promptConversationText: jest.fn(async () => null),
}));
await jest.unstable_mockModule('../public/script.js', () => ({
    name1: 'Active',
    saveSettingsDebounced,
}));
await jest.unstable_mockModule('../public/scripts/events.js', () => ({
    eventSource: { emit },
    event_types: { PERSONA_UPDATED: 'persona-updated' },
}));
await jest.unstable_mockModule('../public/scripts/extensions.js', () => ({ extension_settings: {} }));
await jest.unstable_mockModule('../public/scripts/personas.js', () => ({ user_avatar: 'active.png' }));
await jest.unstable_mockModule('../public/scripts/power-user.js', () => ({ power_user: powerUser }));
// The conversations of the test: the persona and the group decide which one a call means.
const conversationRecords = new Map();
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/context.js', () => ({
    getConversationGroupIdForAvatar: () => '',
    getConversationPersonaId: value => String(typeof value === 'undefined' ? 'active.png' : value || ''),
    getConversationRecord: (avatar, { groupId = '', personaId = '' } = {}) => conversationRecords.get(`${personaId}|${groupId}|${avatar}`) ?? null,
    getConversationStore: () => ({}),
    getConversationKey: (avatar, groupId, { personaId } = {}) => `conv_${personaId}_${groupId || avatar}`,
    getCurrentCharAvatar: () => 'char.png',
    persistConversationStore: jest.fn(),
    isAvatarInConversationGroup: (_avatar, groupId, { personaId } = {}) => groupId === 'active-group' && personaId === 'active.png',
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/pickers.js', () => ({ updateUserFooter: jest.fn() }));

const {
    getActiveConversationPersonaAppendixIds,
    setActiveConversationPersonaAppendixIds,
} = await import('../public/scripts/sillybunny-conversation/personas.js');

function descriptor(activeAppendices) {
    return {
        activeAppendices,
        appendices: [
            { id: 'note-a', name: 'Note A', description: 'A' },
            { id: 'note-b', name: 'Note B', description: 'B' },
        ],
        description: 'Target base',
    };
}

describe('Conversation persona appendix scoping', () => {
    beforeEach(() => {
        powerUser.persona_description = 'active persona description';
        powerUser.persona_descriptions = {};
        conversationRecords.clear();
        saveSettingsDebounced.mockClear();
        emit.mockClear();
    });

    test('reads a selection that was stored under the unscoped key of the old store, and keeps it under the id of the conversation', () => {
        const targetDescriptor = descriptor({ 'char.png': ['note-a'] });
        powerUser.persona_descriptions['target.png'] = targetDescriptor;

        expect(getActiveConversationPersonaAppendixIds('target.png', {
            avatar: 'char.png',
            groupId: '',
            personaId: 'target.png',
        })).toEqual(['note-a']);
        expect(targetDescriptor.activeAppendices['conv_target.png_char.png']).toEqual(['note-a']);
        expect(saveSettingsDebounced).toHaveBeenCalledTimes(1);
    });

    test('reads a selection that was stored under the key of the conversation in the old store', () => {
        conversationRecords.set('target.png||char.png', { id: 'conv_7_target', legacyKey: 'persona:target.png:char.png' });
        const targetDescriptor = descriptor({ 'persona:target.png:char.png': ['note-b'], 'char.png': ['note-a'] });
        powerUser.persona_descriptions['target.png'] = targetDescriptor;

        expect(getActiveConversationPersonaAppendixIds('target.png', {
            avatar: 'char.png',
            groupId: '',
            personaId: 'target.png',
        })).toEqual(['note-b']);
        expect(targetDescriptor.activeAppendices['conv_target.png_char.png']).toEqual(['note-b']);
    });

    test('migrates the old array selection through the default scope', () => {
        const targetDescriptor = descriptor(['note-b']);
        powerUser.persona_descriptions['target.png'] = targetDescriptor;

        expect(getActiveConversationPersonaAppendixIds('target.png', {
            avatar: 'char.png',
            groupId: '',
            personaId: 'target.png',
        })).toEqual(['note-b']);
        expect(targetDescriptor.activeAppendices).toMatchObject({
            __default__: ['note-b'],
            'conv_target.png_char.png': ['note-b'],
        });
    });

    test('a selection that exists for the conversation wins over the legacy keys', () => {
        const targetDescriptor = descriptor({ 'conv_target.png_char.png': ['note-b'], 'char.png': ['note-a'] });
        powerUser.persona_descriptions['target.png'] = targetDescriptor;

        expect(getActiveConversationPersonaAppendixIds('target.png', { avatar: 'char.png', groupId: '', personaId: 'target.png' })).toEqual(['note-b']);
        expect(saveSettingsDebounced).not.toHaveBeenCalled();
    });

    test('writes a non-active persona selection under the target persona identity', () => {
        const targetDescriptor = descriptor({});
        powerUser.persona_descriptions['target.png'] = targetDescriptor;

        setActiveConversationPersonaAppendixIds('target.png', ['note-b'], {
            avatar: 'char.png',
            groupId: '',
            personaId: 'target.png',
        });

        expect(targetDescriptor.activeAppendices['conv_target.png_char.png']).toEqual(['note-b']);
        expect(targetDescriptor.activeAppendices['conv_active.png_char.png']).toBeUndefined();
        expect(powerUser.persona_description).toBe('active persona description');
        expect(emit).toHaveBeenCalledWith('persona-updated', 'target.png');
    });

    test('falls back to solo scope when the active group does not belong to the target persona', () => {
        const targetDescriptor = descriptor({});
        powerUser.persona_descriptions['target.png'] = targetDescriptor;

        setActiveConversationPersonaAppendixIds('target.png', ['note-a'], {
            avatar: 'char.png',
            groupId: 'active-group',
            personaId: 'target.png',
        });

        expect(targetDescriptor.activeAppendices['conv_target.png_char.png']).toEqual(['note-a']);
        expect(targetDescriptor.activeAppendices['conv_target.png_active-group']).toBeUndefined();
    });
});
