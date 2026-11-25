import { beforeEach, describe, expect, jest, test } from '@jest/globals';

const runtimeStatusOverrides = new Map();
const characterStates = new Map();
const patchCharacter = jest.fn((avatar, patch) => {
    const current = characterStates.get(avatar) ?? {};
    const next = { ...current };
    if (patch.routine === null) {
        delete next.routine;
    } else if (patch.routine) {
        next.routine = { ...current.routine, ...patch.routine };
    }
    characterStates.set(avatar, next);
});

await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/context.js', () => ({
    getConversationGroupIdForAvatar: () => '',
    getConversationPersonaId: value => String(typeof value === 'undefined' ? 'persona-a.png' : value || ''),
    getCurrentCharAvatar: () => 'char.png',
    parsePositiveInt: (value, fallback, min = 1) => {
        const parsed = Number.parseInt(String(value), 10);
        return Number.isFinite(parsed) && parsed >= min ? parsed : fallback;
    },
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/conversation-data-browser.js', () => ({
    conversationData: { characterState: avatar => characterStates.get(avatar) ?? {}, patchCharacter },
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/generation.js', () => ({ generateConversationRaw: jest.fn() }));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/shared-helpers.js', () => ({ formatPromptText: value => String(value || '') }));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/settings-store.js', () => ({ getSettings: () => ({}) }));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/state.js', () => ({ runtimeStatusOverrides }));

const {
    getConversationRuntimeStatusKey,
    getCurrentActivityFromSchedule,
    getStoredSchedule,
    setRoutineText,
} = await import('../public/scripts/sillybunny-conversation/schedule.js');

describe('Conversation schedule', () => {
    beforeEach(() => {
        characterStates.clear();
        runtimeStatusOverrides.clear();
        patchCharacter.mockClear();
    });

    test('is the routine of the character, written as JSON text of its days', () => {
        characterStates.set('char.png', { routine: { enabled: true, text: '{"days":{}}', generatedAt: 1234 } });
        const days = '{"days":{"1":[{"time":"08:00-12:00","activity":"working","status":"dnd"}]}}';

        setRoutineText('char.png', days);

        expect(patchCharacter).toHaveBeenCalledWith('char.png', { routine: { text: expect.stringContaining('"days":{"0":[],"1":[{"time":"08:00-12:00","activity":"working","status":"dnd"}]') } });
        expect(getStoredSchedule('char.png')).toMatchObject({ generatedAt: 1234, days: { 1: [{ activity: 'working' }] } });
    });

    test('is the same for every persona, because a character has one routine', () => {
        characterStates.set('char.png', { routine: { enabled: true, text: '{"days":{"1":[]}}' } });

        expect(getStoredSchedule('char.png', { personaId: 'persona-a.png' })).toEqual(getStoredSchedule('char.png', { personaId: 'persona-b.png' }));
    });

    test('is none for a routine that is off, that has no text, or whose text is not an object', () => {
        characterStates.set('off.png', { routine: { enabled: false, text: '{"days":{}}' } });
        characterStates.set('empty.png', { routine: { enabled: true } });
        characterStates.set('unset.png', { routine: { text: '{"days":{}}' } });
        characterStates.set('broken.png', { routine: { enabled: true, text: '{nope' } });
        characterStates.set('list.png', { routine: { enabled: true, text: '[1]' } });

        for (const avatar of ['off.png', 'empty.png', 'unset.png', 'broken.png', 'list.png', 'none.png']) {
            expect(getStoredSchedule(avatar)).toBeNull();
        }
    });

    test('keeps runtime activity overrides isolated by persona', () => {
        const now = new Date('2026-07-25T12:00:00Z');
        runtimeStatusOverrides.set(getConversationRuntimeStatusKey('char.png', 'persona-a.png'), {
            activity: 'working',
            expiresAt: now.getTime() + 60_000,
            status: 'dnd',
        });

        expect(getCurrentActivityFromSchedule(null, 'char.png', now, { personaId: 'persona-a.png' })).toMatchObject({
            activity: 'working',
            source: 'override',
            status: 'dnd',
        });
        expect(getCurrentActivityFromSchedule(null, 'char.png', now, { personaId: 'persona-b.png' })).toMatchObject({
            source: 'default',
            status: 'online',
        });
    });
});
