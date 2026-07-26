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
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/context.js', () => ({
    getConversationGroupIdForAvatar: () => '',
    getConversationPersonaId: value => String(typeof value === 'undefined' ? 'active.png' : value || ''),
    getConversationStore: () => ({}),
    getConversationThreadKey: (avatar, groupId, { personaId } = {}) => {
        const raw = groupId ? `group:${groupId}:${avatar}` : avatar;
        return personaId ? `persona:${personaId}:${raw}` : raw;
    },
    getCurrentCharAvatar: () => 'char.png',
    getRawConversationThreadKey: (avatar, groupId, personaId) => {
        const raw = groupId ? `group:${groupId}:${avatar}` : avatar;
        return personaId ? `persona:${personaId}:${raw}` : raw;
    },
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
        saveSettingsDebounced.mockClear();
        emit.mockClear();
    });

    test('migrates a legacy unscoped thread selection into the persona-scoped key', () => {
        const targetDescriptor = descriptor({ 'char.png': ['note-a'] });
        powerUser.persona_descriptions['target.png'] = targetDescriptor;

        expect(getActiveConversationPersonaAppendixIds('target.png', {
            avatar: 'char.png',
            groupId: '',
            personaId: 'target.png',
        })).toEqual(['note-a']);
        expect(targetDescriptor.activeAppendices['persona:target.png:char.png']).toEqual(['note-a']);
        expect(saveSettingsDebounced).toHaveBeenCalledTimes(1);
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
            'persona:target.png:char.png': ['note-b'],
        });
    });

    test('writes a non-active persona selection under the target persona identity', () => {
        const targetDescriptor = descriptor({});
        powerUser.persona_descriptions['target.png'] = targetDescriptor;

        setActiveConversationPersonaAppendixIds('target.png', ['note-b'], {
            avatar: 'char.png',
            groupId: '',
            personaId: 'target.png',
        });

        expect(targetDescriptor.activeAppendices['persona:target.png:char.png']).toEqual(['note-b']);
        expect(targetDescriptor.activeAppendices['persona:active.png:char.png']).toBeUndefined();
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

        expect(targetDescriptor.activeAppendices['persona:target.png:char.png']).toEqual(['note-a']);
        expect(targetDescriptor.activeAppendices['persona:target.png:group:active-group:char.png']).toBeUndefined();
    });
});
