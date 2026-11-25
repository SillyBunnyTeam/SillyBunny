import { afterAll, beforeAll, describe, expect, jest, test } from '@jest/globals';

const CARDS = { 'aster.png': 'Aster', 'nova.png': 'Nova' };

await jest.unstable_mockModule('../public/script.js', () => ({ name1: 'User' }));
await jest.unstable_mockModule('../public/scripts/constants.js', () => ({ MEDIA_DISPLAY: { GALLERY: 'gallery', LIST: 'list' } }));
await jest.unstable_mockModule('../public/scripts/personas.js', () => ({ user_avatar: 'persona-a.png' }));
await jest.unstable_mockModule('../public/scripts/power-user.js', () => ({ power_user: { persona_description: '' } }));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/context.js', () => ({
    getActiveConversationChat: () => null,
    getConversationGroupIdForAvatar: () => '',
    getConversationPersonaId: value => String(typeof value === 'undefined' ? 'persona-a.png' : value || ''),
    getConversationKey: (_avatar, groupId, { personaId }) => `persona:${personaId}:${groupId || 'solo'}`,
    getConversationRecord: () => null,
    getCurrentCharAvatar: () => 'aster.png',
    getCurrentCharName: () => 'Aster',
    parsePositiveInt: (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : fallback,
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/generation.js', () => ({ generateConversationRaw: jest.fn() }));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/media.js', () => ({
    getCharacterAuthorNote: () => '',
    getCharacterForAvatar: avatar => ({ avatar, name: CARDS[avatar] ?? '', description: '', personality: '', scenario: '' }),
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
    getCharacterStatus: () => ({ activity: null, status: 'online', source: 'manual' }),
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
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/conversation-store.js', () => ({
    getConversationAttachmentSummary: () => '',
    getConversationFileAttachments: () => [],
    getConversationMediaAttachments: () => [],
    getConversationMediaDisplay: () => 'list',
    getConversationMediaIndex: () => 0,
    getConversationPromptMediaAttachments: () => [],
    hasConversationMessageContent: message => Boolean(message?.mes),
}));

const { buildConversationPromptMessages, buildConversationSystemPrompt } = await import('../public/scripts/sillybunny-conversation/prompt.js');

const PROMPT_OPTIONS = { chatId: 'branch-a', groupId: '', personaId: 'persona-a.png', anchorAvatar: 'aster.png', worldInfo: { before: '', after: '', authorsNoteBefore: '', authorsNoteAfter: '', depth: [] } };
const REACTIONS_ID = 'conversation-reactions-context';

const message = (id, role, name, mes, conversationReactions) => ({
    id,
    role,
    name,
    mes,
    ...(conversationReactions ? { extra: { conversation_reactions: conversationReactions } } : {}),
});
const reactionsContext = async (messages, speakerName = 'Aster') => (await buildConversationPromptMessages(messages, 'Reply.', speakerName, { personaId: 'persona-a.png' }))
    .find(item => item.identifier === REACTIONS_ID);

beforeAll(() => {
    jest.useFakeTimers().setSystemTime(new Date('2026-10-23T12:00:00Z'));
});

afterAll(() => {
    jest.useRealTimers();
});

describe('the instruction to react', () => {
    test('is in the list of commands when the characters of the conversation may react, and tells how to write the marker', () => {
        const prompt = buildConversationSystemPrompt({ characters_react: true }, 'aster.png', PROMPT_OPTIONS);

        expect(prompt).toContain('Available commands');
        expect(prompt).toContain('[react: <emoji>]');
        expect(prompt.indexOf('[react: <emoji>]')).toBeGreaterThan(prompt.indexOf('Available commands'));
    });

    test('is not in the prompt of a conversation whose characters may not react', () => {
        expect(buildConversationSystemPrompt({}, 'aster.png', PROMPT_OPTIONS)).not.toContain('[react:');
        expect(buildConversationSystemPrompt({ characters_react: false }, 'aster.png', PROMPT_OPTIONS)).not.toContain('[react:');
    });

    test('leaves the rest of the prompt as it was', () => {
        const on = buildConversationSystemPrompt({ characters_react: true }, 'aster.png', PROMPT_OPTIONS);
        const off = buildConversationSystemPrompt({ characters_react: false }, 'aster.png', PROMPT_OPTIONS);

        expect(on.replace(/\n[^\n]*\[react: <emoji>\][^\n]*/, '')).toBe(off);
    });
});

describe('the reactions that the model is told about', () => {
    test('are not in the prompt when no recent message has one', async () => {
        const prompt = await buildConversationPromptMessages([message('1', 'user', 'Moon Fan', 'hello'), message('2', 'character', 'Aster', 'hi')], 'Reply.', 'Aster', { personaId: 'persona-a.png' });

        expect(prompt.some(item => item.identifier === REACTIONS_ID)).toBe(false);
    });

    test('are one system message before the directive, with a line for each reactor of a message, and the reactor named', async () => {
        const messages = [
            message('1', 'character', 'Aster', 'I made tea for everyone, it is on the table and getting cold', [{ emoji: '❤️', by: 'user', at: 1 }]),
            message('2', 'user', 'Moon Fan', 'See you at six.', [{ emoji: '👍', by: 'aster.png', at: 2 }, { emoji: '😂', by: 'nova.png', at: 3 }]),
        ];

        const prompt = await buildConversationPromptMessages(messages, 'Reply.', 'Aster', { personaId: 'persona-a.png' });
        const context = prompt.find(item => item.identifier === REACTIONS_ID);

        expect(context.role).toBe('system');
        expect(prompt.indexOf(context)).toBe(prompt.length - 2);
        expect(prompt.at(-1).identifier).toBe('conversation-reply-directive');
        expect(context.content).toBe([
            'Recent reactions:',
            '- Moon Fan reacted ❤️ to your message: "I made tea for everyone, it is on the table and…"',
            '- Aster reacted 👍 to Moon Fan\'s message: "See you at six."',
            '- Nova reacted 😂 to Moon Fan\'s message: "See you at six."',
        ].join('\n'));
    });

    test('list the emoji of one reactor on one line, in the order that they were chosen', async () => {
        const context = await reactionsContext([message('1', 'character', 'Nova', 'ready?', [{ emoji: '🎉', by: 'user', at: 9 }, { emoji: '👍', by: 'user', at: 4 }])]);

        expect(context.content).toBe('Recent reactions:\n- Moon Fan reacted 👍 🎉 to Nova\'s message: "ready?"');
    });

    test('are read from the last 8 messages only', async () => {
        const reacted = message('old', 'character', 'Nova', 'old news', [{ emoji: '👍', by: 'user', at: 1 }]);
        const plain = Array.from({ length: 8 }, (_, index) => message(`p${index}`, 'character', 'Nova', `plain ${index}`));

        expect(await reactionsContext([reacted, ...plain])).toBeUndefined();
        expect((await reactionsContext([reacted, ...plain.slice(1)])).content).toContain('old news');
    });

    test('are at most the 6 lines that came last, the newest at the end', async () => {
        const messages = Array.from({ length: 8 }, (_, index) => message(String(index), 'character', 'Nova', `line ${index}`, [{ emoji: '👍', by: 'user', at: index }, { emoji: '😂', by: 'aster.png', at: index }]));

        const lines = (await reactionsContext(messages)).content.split('\n').slice(1);

        expect(lines).toHaveLength(6);
        expect(lines.at(0)).toBe('- Moon Fan reacted 👍 to Nova\'s message: "line 5"');
        expect(lines.at(-1)).toBe('- Aster reacted 😂 to Nova\'s message: "line 7"');
    });

    test('are read from the old object too, as the reactions of the user', async () => {
        const context = await reactionsContext([message('1', 'character', 'Aster', 'hello', { heart: 1 })]);

        expect(context.content).toContain('- Moon Fan reacted ❤️ to your message: "hello"');
    });

    test('leave out the text of a message that has none, and the pending reply that the server wrote', async () => {
        const pending = { ...message('p', 'character', 'Aster', 'raw text', [{ emoji: '❤️', by: 'user', at: 1 }]), extra: { conversation_reactions: [{ emoji: '❤️', by: 'user', at: 1 }], server_generation: { pending: true, kind: 'reply' } } };
        const context = await reactionsContext([message('1', 'user', 'Moon Fan', '', [{ emoji: '🎉', by: 'aster.png', at: 1 }]), pending]);

        expect(context.content).toBe('Recent reactions:\n- Aster reacted 🎉 to Moon Fan\'s message.');
    });

    test('name a reactor whose card is gone by its file name', async () => {
        const context = await reactionsContext([message('1', 'user', 'Moon Fan', 'hi', [{ emoji: '🎉', by: 'ghost.png', at: 1 }])]);

        expect(context.content).toContain('- ghost reacted 🎉 to Moon Fan\'s message');
    });
});
