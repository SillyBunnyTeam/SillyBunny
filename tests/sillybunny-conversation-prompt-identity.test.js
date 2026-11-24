/* global globalThis */
import { beforeEach, describe, expect, jest, test } from '@jest/globals';

const chat = {
    id: 'branch-a',
    memoryMessageCount: 0,
    messages: Array.from({ length: 24 }, (_, index) => ({
        id: `message-${index}`,
        role: index % 2 ? 'character' : 'user',
        name: index % 2 ? 'Aster' : 'User',
        mes: `message ${index}`,
    })),
};
const conversationRecord = {
    activeBranchId: 'branch-a',
    branches: { 'branch-a': chat },
    memoryMessageCount: 100,
};
const composeConversationPersonaDescription = jest.fn(() => 'captured persona appendix');
const generateConversationRaw = jest.fn(async () => 'new branch summary');
const getConversationGroupMemorySummaries = jest.fn(() => [{ groupId: 'group-a', groupName: 'Group A', summary: 'captured group memory' }]);
const getConversationParticipants = jest.fn(() => [{ avatar: 'char.png', name: 'Aster' }]);
const getConversationSoloMemorySummary = jest.fn(() => ({ summary: 'captured solo memory' }));
const saveConversationMemorySummary = jest.fn();

await jest.unstable_mockModule('../public/script.js', () => ({ name1: 'User' }));
await jest.unstable_mockModule('../public/scripts/constants.js', () => ({ MEDIA_DISPLAY: { GALLERY: 'gallery', LIST: 'list' } }));
await jest.unstable_mockModule('../public/scripts/personas.js', () => ({ user_avatar: 'persona-b.png' }));
await jest.unstable_mockModule('../public/scripts/power-user.js', () => ({ power_user: { persona_description: 'active persona fallback' } }));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/context.js', () => ({
    getActiveConversationChat: () => chat,
    getConversationGroupIdForAvatar: () => '',
    getConversationPersonaId: value => String(typeof value === 'undefined' ? 'persona-b.png' : value || ''),
    getConversationKey: (_avatar, groupId, { personaId }) => `persona:${personaId}:${groupId || 'solo'}`,
    getConversationRecord: () => conversationRecord,
    getCurrentCharAvatar: () => 'char.png',
    getCurrentCharName: () => 'Aster',
    parsePositiveInt: (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : fallback,
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/generation.js', () => ({ generateConversationRaw }));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/media.js', () => ({
    getCharacterAuthorNote: () => '',
    getCharacterForAvatar: avatar => ({ avatar, name: 'Aster' }),
    getConversationParticipants,
    getParticipantNamesForDisplay: participants => participants.map(participant => participant.name),
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/personas.js', () => ({
    composeConversationPersonaDescription,
    getAvailabilityCopy: () => ({ label: 'Online' }),
    getConversationPersonaName: personaId => personaId === 'persona-a.png' ? 'Captured User' : 'Active User',
    getUserPersonaStatus: () => '',
    getUserStatus: () => 'online',
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/schedule.js', () => ({
    getCurrentActivityFromSchedule: () => ({ activity: 'free', status: 'online' }),
    getStoredSchedule: () => null,
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/shared-helpers.js', () => ({
    buildConversationGroupReferenceContext: () => '',
    compileGeechanPrompt: () => '',
    formatPromptText: value => String(value || ''),
    getGroundedDialogueRulesPrompt: () => '',
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/settings-store.js', () => ({
    getConversationGroupMemorySummaries,
    getConversationMemorySummary: () => '',
    getConversationSoloMemorySummary,
    getSettings: () => ({}),
    saveConversationMemorySummary,
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/state.js', () => ({
    memorySummaryBusyAvatars: new Set(),
    memorySummaryTimers: new Map(),
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/conversation-store.js', () => ({
    getConversationAttachmentSummary: () => '',
    getConversationFileAttachments: () => [],
    getConversationMediaAttachments: () => [],
    getConversationMediaDisplay: () => 'list',
    getConversationMediaIndex: () => 0,
    getConversationPromptMediaAttachments: () => [],
    hasConversationMessageContent: message => Boolean(message?.mes),
}));

const {
    buildConversationSystemPrompt,
    updateConversationMemorySummary,
} = await import('../public/scripts/sillybunny-conversation/prompt.js');

describe('conversation prompt captured identity', () => {
    beforeEach(() => {
        chat.messages.forEach((message, index) => {
            message.mes = `message ${index}`;
        });
        composeConversationPersonaDescription.mockClear();
        generateConversationRaw.mockReset().mockResolvedValue('new branch summary');
        getConversationGroupMemorySummaries.mockClear();
        getConversationParticipants.mockClear();
        getConversationSoloMemorySummary.mockClear();
        saveConversationMemorySummary.mockClear();
        globalThis.toastr = { info: jest.fn(), success: jest.fn(), warning: jest.fn() };
    });

    test('uses captured persona appendix scope and related memory without active-persona fallback', () => {
        const prompt = buildConversationSystemPrompt({ include_related_memory: true }, 'char.png', {
            chatId: 'branch-a',
            groupId: '',
            personaId: 'persona-a.png',
            anchorAvatar: 'char.png',
        });

        expect(prompt).toContain('captured persona appendix');
        expect(prompt).toContain('Captured User');
        expect(prompt).toContain('captured group memory');
        expect(prompt).not.toContain('active persona fallback');
        expect(composeConversationPersonaDescription).toHaveBeenCalledWith('persona-a.png', {
            avatar: 'char.png',
            groupId: '',
            personaId: 'persona-a.png',
        });
        expect(getConversationGroupMemorySummaries).toHaveBeenCalledWith('char.png', { max: 4, personaId: 'persona-a.png' });

        const groupPrompt = buildConversationSystemPrompt({ include_related_memory: true }, 'char.png', {
            chatId: 'branch-a',
            groupId: 'group-a',
            personaId: 'persona-a.png',
            anchorAvatar: 'char.png',
        });
        expect(groupPrompt).toContain('captured solo memory');
        expect(getConversationSoloMemorySummary).toHaveBeenCalledWith('char.png', { personaId: 'persona-a.png' });
        expect(getConversationParticipants).toHaveBeenLastCalledWith('char.png', expect.any(Object), {
            chatId: 'branch-a',
            groupId: 'group-a',
            personaId: 'persona-a.png',
        });
    });

    test('uses selected branch memory count instead of the thread-level count', async () => {
        await expect(updateConversationMemorySummary('char.png', {
            chatId: 'branch-a',
            groupId: '',
            personaId: 'persona-a.png',
        })).resolves.toBe(true);

        expect(generateConversationRaw).toHaveBeenCalledTimes(1);
        expect(generateConversationRaw.mock.calls[0][0].prompt).toContain('Captured User');
        expect(saveConversationMemorySummary).toHaveBeenCalledWith('char.png', 'new branch summary', 24, {
            chatId: 'branch-a',
            groupId: '',
            personaId: 'persona-a.png',
        });
    });

    test('does not save a memory completion after branch messages change', async () => {
        let resolveGeneration;
        generateConversationRaw.mockImplementationOnce(() => new Promise((resolve) => {
            resolveGeneration = resolve;
        }));

        const update = updateConversationMemorySummary('char.png', {
            chatId: 'branch-a',
            groupId: '',
            personaId: 'persona-a.png',
        });
        chat.messages[0].mes = 'edited while summarizing';
        resolveGeneration('stale summary');

        await expect(update).resolves.toBe(false);
        expect(saveConversationMemorySummary).not.toHaveBeenCalled();
    });
});
