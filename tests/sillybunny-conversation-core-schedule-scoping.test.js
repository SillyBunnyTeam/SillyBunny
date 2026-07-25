import { beforeEach, describe, expect, jest, test } from '@jest/globals';

let activePersonaId = 'persona-a.png';
const stores = new Map();
const runtimeStatusOverrides = new Map();

await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/context.js', () => ({
    getCharacterConversationStore: (avatar, { create = true, personaId = activePersonaId } = {}) => {
        const key = `${personaId}|${avatar}`;
        if (!stores.has(key) && create) stores.set(key, {});
        return stores.get(key) || null;
    },
    getConversationGroupIdForAvatar: () => '',
    getConversationPersonaId: value => String(typeof value === 'undefined' ? activePersonaId : value || ''),
    getCurrentCharAvatar: () => 'char.png',
    parsePositiveInt: (value, fallback, min = 1) => {
        const parsed = Number.parseInt(String(value), 10);
        return Number.isFinite(parsed) && parsed >= min ? parsed : fallback;
    },
    persistConversationStore: jest.fn(),
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/generation.js', () => ({ generateConversationRaw: jest.fn() }));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/shared-helpers.js', () => ({ formatPromptText: value => String(value || '') }));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/settings-store.js', () => ({ getSettings: () => ({}) }));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/state.js', () => ({ runtimeStatusOverrides }));

const {
    getConversationRuntimeStatusKey,
    getCurrentActivityFromSchedule,
    getStoredSchedule,
    saveStoredSchedule,
} = await import('../public/scripts/sillybunny-conversation/schedule.js');

describe('Conversation schedule persona scoping', () => {
    beforeEach(() => {
        activePersonaId = 'persona-a.png';
        stores.clear();
        runtimeStatusOverrides.clear();
    });

    test('reads and writes the explicitly captured persona after the active persona changes', () => {
        const scheduleA = { days: { 0: [] }, marker: 'A' };
        const scheduleB = { days: { 0: [] }, marker: 'B' };
        saveStoredSchedule('char.png', scheduleA, { personaId: 'persona-a.png' });
        saveStoredSchedule('char.png', scheduleB, { personaId: 'persona-b.png' });

        activePersonaId = 'persona-b.png';

        expect(getStoredSchedule('char.png', { personaId: 'persona-a.png' })).toBe(scheduleA);
        expect(getStoredSchedule('char.png', { personaId: 'persona-b.png' })).toBe(scheduleB);
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
