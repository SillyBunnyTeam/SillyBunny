import { beforeEach, describe, expect, jest, test } from '@jest/globals';

import { hashCommitText, normalizeCommitPlan } from '../public/scripts/generation-commit-plan.js';
import { getConversationMessageRevision } from '../public/scripts/sillybunny-conversation/message-identity-utils.js';
import { createConversationMessageRevisionEntries, createConversationQueueItem } from '../public/scripts/sillybunny-conversation/send-queue-utils.js';

const PERSONA = 'persona-a.png';
const CONVERSATION = 'conv_1732550000000_abc123';
const PAGE = 'page-under-test';

const generateConversationReply = jest.fn();
const postCharacterReply = jest.fn();
const postMemberConversationReply = jest.fn();
const appendConversationMessage = jest.fn();
const reloadConversationChat = jest.fn(async () => ({ conversationId: CONVERSATION, chatId: 'main' }));
const generateConversationImage = jest.fn();
let settings = { enabled: true };
let messages = [];
let group = null;

await jest.unstable_mockModule('../public/script.js', () => ({ is_send_press: false, online_status: 'Connected' }));
await jest.unstable_mockModule('../public/scripts/resumable-generation.js', () => ({ pageId: PAGE }));
await jest.unstable_mockModule('../public/scripts/sillybunny-connection-notices.js', () => ({ notifyNotConnected: jest.fn() }));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/auto-engine.js', () => ({
    checkMultiCharacterChime: jest.fn(async () => false),
    handleAvailabilityAutoResponder: jest.fn(async () => false),
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/context.js', () => ({
    ensureDirectConversation: jest.fn(),
    getConversationGroupById: () => group,
    getConversationGroupIdForAvatar: () => '',
    getConversationPersonaId: () => PERSONA,
    getConversationKey: () => CONVERSATION,
    getConversationRecord: () => ({ id: CONVERSATION, activeChatId: 'main', chats: [{ id: 'main' }] }),
    getCurrentCharAvatar: () => 'char.png',
    getCurrentCharName: () => 'Aster',
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/generation.js', () => ({
    generateConversationReply,
    postCharacterReply,
    postMemberConversationReply,
    reportConversationGenerationError: jest.fn(),
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/media.js', () => ({
    buildCharacterImagePrompt: () => 'a prompt',
    generateConversationImage,
    getCharacterForAvatar: avatar => ({ avatar, name: avatar === 'char.png' ? 'Aster' : 'Birch' }),
    getConversationMemberAvatars: () => [],
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/members.js', () => ({
    getAllowedMemberCharacters: () => [],
    getConversationMemberSettings: (_avatar, hostSettings) => hostSettings,
    isCharacterMentionedInText: (character, text) => String(text).includes(character.name),
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/personas.js', () => ({ getConversationPersonaName: () => 'User' }));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/prompt.js', () => ({ formatConversationFileSize: () => '' }));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/shared-helpers.js', () => ({ formatPromptText: value => String(value || '') }));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/render-scheduler.js', () => ({ scheduleInterfaceRefresh: jest.fn() }));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/render-utils.js', () => ({ escapeHtmlText: value => String(value || '') }));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/settings-store.js', () => ({ getSettings: () => settings }));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/state.js', () => ({
    beginConversationGenerationOperation: jest.fn(() => Symbol('operation')),
    conversationState: { autoWorkerBusy: false, conversationUploadActive: false, sendQueueNeedsProcessing: false, sendQueueProcessing: false },
    endConversationGenerationOperation: jest.fn(),
    memberReplyBusyKeys: new Set(),
    sendQueue: [],
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/timeline-render.js', () => ({ consumeConversationReplyTarget: () => null }));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/conversation-store.js', () => ({
    appendConversationChatMessage: jest.fn(),
    buildConversationMessageReplyReference: message => (message ? { messageId: message.id, text: message.mes } : null),
    ensureConversationChatLoaded: jest.fn(async () => ({ conversationId: CONVERSATION, chatId: 'main' })),
    getConversationAttachmentSummary: () => '',
    getConversationFileAttachments: () => [],
    getConversationMediaAttachments: () => [],
    getConversationMessages: () => messages,
    getImageCooldownRemainingSeconds: () => 0,
    markImageGenerated: jest.fn(),
    reloadConversationChat,
    updateLastUserActivity: jest.fn(),
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/timeline-slash-commands.js', () => ({ handleConversationSlashAction: jest.fn() }));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/typing.js', () => ({
    getConversationActivityContext: () => ({ status: 'online' }),
    maybePostDelayedReplyNotice: jest.fn(),
    splitChatroomMessages: value => [String(value || '')],
    withTypingParticipant: (_participant, task) => task(),
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/message-writer.js', () => ({ appendConversationMessage }));

const { processQueuedConversationReply } = await import('../public/scripts/sillybunny-conversation/attachments.js');

const USER_MESSAGE = { id: 'u1', role: 'user', name: 'You', mes: 'hello', created_at: 2, extra: {} };

function queueItem(overrides = {}) {
    return createConversationQueueItem({
        avatar: 'char.png',
        chatId: 'main',
        conversationKey: CONVERSATION,
        groupId: '',
        messageIds: ['u1'],
        messageRevisions: createConversationMessageRevisionEntries([USER_MESSAGE]),
        personaId: PERSONA,
        text: 'hello',
        ...overrides,
    });
}

/** What a reply asks of its handle: both plans, the state of the claim, and the text. */
function answerWith(state, text = 'Hello there.') {
    const seen = [];
    generateConversationReply.mockImplementation(async (_directive, _settings, options) => {
        seen.push({ options, profile: options.commit.createPlan('profile'), raw: options.commit.createPlan('raw') });
        options.commit.state = state;
        return text;
    });
    return seen;
}

beforeEach(() => {
    for (const mock of [generateConversationReply, postCharacterReply, postMemberConversationReply, appendConversationMessage, reloadConversationChat, generateConversationImage]) {
        mock.mockClear();
    }
    postCharacterReply.mockResolvedValue('Hello there.');
    postMemberConversationReply.mockResolvedValue(true);
    settings = { enabled: true };
    group = null;
    messages = [{ id: 'g1', role: 'character', name: 'Aster', mes: 'Hi.', created_at: 1, extra: {} }, USER_MESSAGE];
});

describe('a queued reply of a direct conversation', () => {
    test('asks the model with a handle whose plans are accepted by the server and share one token', async () => {
        const seen = answerWith('claimed');

        await processQueuedConversationReply(queueItem());

        expect(seen).toHaveLength(1);
        const { profile, raw } = seen[0];
        expect(normalizeCommitPlan(profile)).not.toBeNull();
        expect(normalizeCommitPlan(raw)).not.toBeNull();
        expect(profile.reply.route).toBe('profile');
        expect(raw.reply.route).toBe('raw');
        expect(raw.reply.token).toBe(profile.reply.token);
        expect(profile).toMatchObject({
            chat: { conversation: CONVERSATION },
            file: 'main',
            kind: 'reply',
            page: PAGE,
            round: [],
            reply: { speaker: 'char.png', anchor: 'char.png', origin: 'reply', needs_user: false, target: null },
        });
        expect(profile.reply.triggers).toEqual([{ id: 'u1', rev: hashCommitText(getConversationMessageRevision(USER_MESSAGE)) }]);
    });

    test('writes the reply itself when the claim answered that the server did not, and marks each bubble with the token of the reply', async () => {
        for (const state of ['claimed', 'unknown', 'missing', null]) {
            postCharacterReply.mockClear();
            const seen = answerWith(state);

            await processQueuedConversationReply(queueItem());

            expect(postCharacterReply).toHaveBeenCalledTimes(1);
            expect(postCharacterReply.mock.calls[0][2].extra).toMatchObject({ conversation_mode_reply: true, reply_token: seen[0].profile.reply.token });
            expect(reloadConversationChat).not.toHaveBeenCalled();
        }
    });

    test('does not write the reply when the server did, reads the chat again, and leaves landing it to the finalizer', async () => {
        answerWith('committed');

        await processQueuedConversationReply(queueItem());

        expect(postCharacterReply).not.toHaveBeenCalled();
        expect(postMemberConversationReply).not.toHaveBeenCalled();
        expect(reloadConversationChat).toHaveBeenCalledWith('char.png', { chatId: 'main', groupId: '', personaId: PERSONA });
    });

    test('lands the reply that the server wrote even though the message that it answers was edited meanwhile', async () => {
        generateConversationReply.mockImplementation(async (_directive, _settings, options) => {
            options.commit.state = 'committed';
            messages = [messages[0], { ...USER_MESSAGE, mes: 'hello, edited' }];
            return 'Hello there.';
        });

        await processQueuedConversationReply(queueItem());

        expect(postCharacterReply).not.toHaveBeenCalled();
        expect(reloadConversationChat).toHaveBeenCalledTimes(1);
    });

    test('sends no plan when a message that it answers is gone, so that the page writes the reply as it always did', async () => {
        const seen = [];
        generateConversationReply.mockImplementation(async (_directive, _settings, options) => {
            messages = [messages[0]];
            seen.push(options.commit.createPlan('profile'));
            return '';
        });

        await processQueuedConversationReply(queueItem());

        expect(seen).toEqual([null]);
    });

    test('marks the picture that a reply adds with the same token', async () => {
        settings = { enabled: true, image_gen_enabled: true, spontaneous_selfies: true };
        generateConversationImage.mockResolvedValue('/img/a.png');
        const seen = answerWith('claimed');

        await processQueuedConversationReply(queueItem());

        expect(appendConversationMessage).toHaveBeenCalledTimes(1);
        expect(appendConversationMessage.mock.calls[0][1].extra).toMatchObject({ conversation_mode_image: true, reply_token: seen[0].profile.reply.token });
    });

    test('makes a new token for each reply', async () => {
        const seen = answerWith('claimed');

        await processQueuedConversationReply(queueItem());
        await processQueuedConversationReply(queueItem());

        expect(seen[0].profile.reply.token).not.toBe(seen[1].profile.reply.token);
    });
});

describe('a queued reply of a group', () => {
    test('gives each member that answers a plan of its own, under its own avatar and token', async () => {
        group = { id: CONVERSATION, members: ['char.png', 'member.png'], disabled_members: [] };
        const seen = answerWith('claimed');

        await processQueuedConversationReply(queueItem({ groupId: CONVERSATION, text: 'Aster and Birch, hello' }));

        const plans = seen.map(item => item.profile);
        expect(plans.map(plan => plan.reply.speaker).sort()).toEqual(['char.png', 'member.png']);
        expect(new Set(plans.map(plan => plan.reply.token)).size).toBe(2);
        expect(plans.every(plan => plan.reply.anchor === 'char.png')).toBe(true);
        expect(plans.every(plan => normalizeCommitPlan(plan) !== null)).toBe(true);
    });
});
