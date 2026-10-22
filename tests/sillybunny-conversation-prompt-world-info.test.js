import { afterAll, beforeAll, describe, expect, jest, test } from '@jest/globals';

await jest.unstable_mockModule('../public/script.js', () => ({ name1: 'User' }));
await jest.unstable_mockModule('../public/scripts/constants.js', () => ({ MEDIA_DISPLAY: { GALLERY: 'gallery', LIST: 'list' } }));
await jest.unstable_mockModule('../public/scripts/personas.js', () => ({ user_avatar: 'persona-a.png' }));
await jest.unstable_mockModule('../public/scripts/power-user.js', () => ({ power_user: { persona_description: '' } }));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/context.js', () => ({
    getActiveConversationBranch: () => null,
    getConversationGroupIdForAvatar: () => '',
    getConversationPersonaId: value => String(typeof value === 'undefined' ? 'persona-a.png' : value || ''),
    getConversationThreadKey: (_avatar, groupId, { personaId }) => `persona:${personaId}:${groupId || 'solo'}`,
    getConversationThreadStore: () => null,
    getCurrentCharAvatar: () => 'reisen.png',
    getCurrentCharName: () => 'Reisen',
    parsePositiveInt: (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : fallback,
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/generation.js', () => ({ generateConversationRaw: jest.fn() }));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/media.js', () => ({
    getCharacterAuthorNote: () => '',
    getCharacterForAvatar: avatar => ({
        avatar,
        name: 'Reisen',
        description: 'Reisen description.',
        personality: 'Reisen personality.',
        scenario: 'Reisen scenario.',
    }),
    getConversationParticipants: () => [],
    getParticipantNamesForDisplay: participants => participants.map(participant => participant.name),
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/personas.js', () => ({
    composeConversationPersonaDescription: () => '',
    getAvailabilityCopy: () => ({ label: 'Online' }),
    getConversationPersonaName: () => 'Moon Fan',
    getUserPersonaStatus: () => '',
    getUserStatus: () => 'online',
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/schedule.js', () => ({
    getCurrentActivityFromSchedule: () => ({ activity: 'free', status: 'online' }),
    getStoredSchedule: () => null,
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/shared-helpers.js', () => ({
    buildConversationGroupReferenceContext: () => '',
    compileGeechanPrompt: () => 'Chat style prompt.',
    formatPromptText: value => String(value || ''),
    getGroundedDialogueRulesPrompt: () => '',
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/settings-store.js', () => ({
    getConversationGroupMemorySummaries: () => [],
    getConversationMemorySummary: () => '',
    getConversationSoloMemorySummary: () => null,
    getSettings: () => ({}),
    saveConversationMemorySummary: jest.fn(),
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/state.js', () => ({
    memorySummaryBusyAvatars: new Set(),
    memorySummaryTimers: new Map(),
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/thread-store.js', () => ({
    getConversationAttachmentSummary: () => '',
    getConversationFileAttachments: () => [],
    getConversationMediaAttachments: () => [],
    getConversationMediaDisplay: () => 'list',
    getConversationMediaIndex: () => 0,
    getConversationPromptMediaAttachments: () => [],
    hasConversationMessageContent: message => Boolean(message?.mes),
}));

const { buildConversationPromptMessages, buildConversationSystemPrompt } = await import('../public/scripts/sillybunny-conversation/prompt.js');

const EMPTY = { before: '', after: '', authorsNoteBefore: '', authorsNoteAfter: '', depth: [] };
const PROMPT_OPTIONS = { branchId: 'branch-a', groupId: '', personaId: 'persona-a.png', threadAvatar: 'reisen.png' };

function message(id, role, name) {
    return { id, role, name, mes: `${name} message ${id}` };
}

describe('Conversation prompt lorebook entries', () => {
    beforeAll(() => {
        jest.useFakeTimers().setSystemTime(new Date('2026-10-23T12:00:00Z'));
    });

    afterAll(() => {
        jest.useRealTimers();
    });

    test('places entries around the character fields and the author\'s note', () => {
        const prompt = buildConversationSystemPrompt({ authors_note: 'Keep it short.', lorebook_override: 'Lexicon' }, 'reisen.png', {
            ...PROMPT_OPTIONS,
            worldInfo: {
                before: 'Lore before.',
                after: 'Lore after.',
                authorsNoteBefore: 'Note top lore.',
                authorsNoteAfter: 'Note bottom lore.',
                depth: [],
            },
        });

        const order = [
            'Chat style prompt.',
            'Lore before.',
            'Character description:\nReisen description.',
            'Background context:\nReisen scenario.',
            'Lore after.',
            'Note top lore.',
            'Conversation author\'s note:\nKeep it short.',
            'Note bottom lore.',
            'Conversation lorebook focus: Lexicon.',
        ].map(text => prompt.indexOf(text));
        expect(order).not.toContain(-1);
        expect(order).toEqual([...order].sort((first, second) => first - second));
    });

    test('keeps entries for the author\'s note when the thread has no note', () => {
        const prompt = buildConversationSystemPrompt({}, 'reisen.png', {
            ...PROMPT_OPTIONS,
            worldInfo: { ...EMPTY, authorsNoteBefore: 'Note top lore.', authorsNoteAfter: 'Note bottom lore.' },
        });

        expect(prompt).toContain('Reisen scenario.\n\nNote top lore.\n\nNote bottom lore.');
        expect(prompt).not.toContain('Conversation author\'s note:');
    });

    test('leaves the prompts as they were without entries', async () => {
        const messages = [message('1', 'user', 'Moon Fan'), message('2', 'character', 'Reisen')];

        expect(buildConversationSystemPrompt({}, 'reisen.png', { ...PROMPT_OPTIONS, worldInfo: EMPTY }))
            .toBe(buildConversationSystemPrompt({}, 'reisen.png', PROMPT_OPTIONS));
        expect(await buildConversationPromptMessages(messages, 'Reply.', 'Reisen', { personaId: 'persona-a.png', worldInfo: EMPTY }))
            .toEqual(await buildConversationPromptMessages(messages, 'Reply.', 'Reisen', { personaId: 'persona-a.png' }));
    });

    test('inserts depth entries counted back from the newest transcript message', async () => {
        const messages = [message('1', 'user', 'Moon Fan'), message('2', 'character', 'Reisen'), message('3', 'user', 'Moon Fan'), message('4', 'character', 'Reisen')];

        const prompt = await buildConversationPromptMessages(messages, 'Reply.', 'Reisen', {
            personaId: 'persona-a.png',
            worldInfo: {
                ...EMPTY,
                depth: [
                    { depth: 0, role: 'system', content: 'Depth zero lore.' },
                    { depth: 2, role: 'user', content: 'Depth two lore.' },
                    { depth: 2, role: 'assistant', content: 'Depth two answer lore.' },
                    { depth: 9, role: 'assistant', content: 'Deep lore.' },
                ],
            },
        });

        expect(prompt.map(item => item.identifier)).toEqual([
            'conversation-transcript-header',
            'conversation-world-info-depth-9-assistant',
            'conversation-message-1',
            'conversation-message-2',
            'conversation-world-info-depth-2-user',
            'conversation-world-info-depth-2-assistant',
            'conversation-message-3',
            'conversation-message-4',
            'conversation-world-info-depth-0-system',
            'conversation-reply-directive',
        ]);
        expect(prompt[4]).toEqual({ role: 'user', content: 'Depth two lore.', identifier: 'conversation-world-info-depth-2-user' });
    });

    test('keeps the empty transcript note before a depth zero entry', async () => {
        const prompt = await buildConversationPromptMessages([], 'Reply.', 'Reisen', {
            personaId: 'persona-a.png',
            worldInfo: { ...EMPTY, depth: [{ depth: 0, role: 'system', content: 'Depth zero lore.' }] },
        });

        expect(prompt.map(item => item.identifier)).toEqual([
            'conversation-transcript-header',
            'conversation-empty-transcript',
            'conversation-world-info-depth-0-system',
            'conversation-reply-directive',
        ]);
    });
});
