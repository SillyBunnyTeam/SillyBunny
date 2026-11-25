/* global globalThis */
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';

import { hashCommitText, normalizeCommitPlan } from '../public/scripts/generation-commit-plan.js';
import { getConversationMessageRevision } from '../public/scripts/sillybunny-conversation/message-identity-utils.js';
import { createConversationMessageRevisionEntries, createConversationQueueItem, createConversationQueueReplyTarget } from '../public/scripts/sillybunny-conversation/send-queue-utils.js';

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
/** The talkativeness that a card holds, by avatar; a card that is not listed has none. */
const cards = {};

await jest.unstable_mockModule('../public/script.js', () => ({ is_send_press: false, online_status: 'Connected' }));
await jest.unstable_mockModule('../public/scripts/resumable-generation.js', () => ({ pageId: PAGE }));
await jest.unstable_mockModule('../public/scripts/sillybunny-connection-notices.js', () => ({ notifyNotConnected: jest.fn() }));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/auto-engine.js', () => ({
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
    getCharacterForAvatar: avatar => ({ avatar, name: { 'char.png': 'Aster', 'member.png': 'Birch', 'third.png': 'Cyan' }[avatar] ?? 'Someone', ...(avatar in cards ? { talkativeness: cards[avatar] } : {}) }),
    getConversationMemberAvatars: () => [],
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/members.js', () => ({
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

const { enqueueConversationReply, processQueuedConversationReply, queueForcedConversationReply } = await import('../public/scripts/sillybunny-conversation/send-queue.js');
const { sendQueue } = await import('../public/scripts/sillybunny-conversation/state.js');

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
    for (const avatar of Object.keys(cards)) {
        delete cards[avatar];
    }
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

    test('names the last user message of the trigger as the message that its characters react to', async () => {
        answerWith('claimed');
        const later = { id: 'u2', role: 'user', name: 'You', mes: 'are you there?', created_at: 3, extra: {} };
        messages = [...messages, later];

        await processQueuedConversationReply(queueItem({ messageIds: ['u1', 'u2'], messageRevisions: createConversationMessageRevisionEntries([USER_MESSAGE, later]) }));

        expect(postCharacterReply.mock.calls[0][2].reactionTarget).toEqual({ messageId: 'u2' });
    });

    test('names the one message that triggered the reply', async () => {
        answerWith('claimed');
        await processQueuedConversationReply(queueItem());

        expect(postCharacterReply.mock.calls[0][2].reactionTarget).toEqual({ messageId: 'u1' });
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

    test('answers a reply to the message of an extra as a message to the character, because extras do not speak', async () => {
        const extraMessage = { id: 'm1', role: 'member', name: 'Someone', mes: 'Hi there.', created_at: 1, extra: { member_avatar: 'extra.png' } };
        const reply = { id: 'u2', role: 'user', name: 'You', mes: 'and you?', created_at: 3, extra: { conversation_reply_to: { messageId: 'm1' } } };
        messages = [extraMessage, reply];
        const seen = answerWith('claimed');

        await processQueuedConversationReply(queueItem({
            messageIds: ['u2'],
            messageRevisions: createConversationMessageRevisionEntries([reply]),
            replyTarget: createConversationQueueReplyTarget([reply], messages),
            text: 'and you?',
        }));

        expect(seen.map(item => item.options.speakerAvatar)).toEqual(['char.png']);
    });

    test('makes a new token for each reply', async () => {
        const seen = answerWith('claimed');

        await processQueuedConversationReply(queueItem());
        await processQueuedConversationReply(queueItem());

        expect(seen[0].profile.reply.token).not.toBe(seen[1].profile.reply.token);
    });
});

describe('a queued reply of a group', () => {
    const MEMBERS = ['char.png', 'member.png', 'third.png'];
    const setGroup = (members = MEMBERS) => {
        group = { id: CONVERSATION, members: [...members], disabled_members: [] };
    };
    const groupItem = (overrides = {}) => queueItem({ groupId: CONVERSATION, text: 'Aster and Birch, hello', ...overrides });

    beforeEach(() => {
        setGroup();
        sendQueue.length = 0;
        // A member that is not mentioned may be drawn as a second speaker by chance; these tests choose who speaks.
        jest.spyOn(Math, 'random').mockReturnValue(0.99);
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    /** Replies that wait until the test lets each member finish, and record who was asked when. */
    function gatedReplies() {
        const asked = [];
        const gates = [];
        generateConversationReply.mockImplementation(async (_directive, _settings, options) => {
            asked.push({ speaker: options.speakerAvatar, plan: options.commit.createPlan('profile') });
            options.commit.state = 'claimed';
            await new Promise(resolve => gates.push(resolve));
            return 'A reply.';
        });
        const finishNext = async () => {
            gates.shift()();
            await new Promise(resolve => setImmediate(resolve));
        };
        return { asked, finishNext };
    }

    test('gives each member that answers a plan of its own, under its own avatar and token', async () => {
        const seen = answerWith('claimed');

        await processQueuedConversationReply(groupItem());

        const plans = seen.map(item => item.profile);
        expect(plans.map(plan => plan.reply.speaker)).toEqual(['char.png', 'member.png']);
        expect(new Set(plans.map(plan => plan.reply.token)).size).toBe(2);
        expect(plans.every(plan => plan.reply.anchor === 'char.png')).toBe(true);
        expect(plans.every(plan => normalizeCommitPlan(plan) !== null)).toBe(true);
    });

    test('gives every member that answers the same message to react to', async () => {
        answerWith('claimed');

        await processQueuedConversationReply(groupItem());

        expect(postCharacterReply.mock.calls[0][2].reactionTarget).toEqual({ messageId: 'u1' });
        expect(postMemberConversationReply.mock.calls[0][3].reactionTarget).toEqual({ messageId: 'u1' });
    });

    test('asks the second member only when the reply of the first is in the chat, so that it reads it', async () => {
        const { asked, finishNext } = gatedReplies();
        const done = processQueuedConversationReply(groupItem());
        await new Promise(resolve => setImmediate(resolve));

        expect(asked.map(item => item.speaker)).toEqual(['char.png']);
        await finishNext();
        expect(postCharacterReply).toHaveBeenCalledTimes(1);
        await new Promise(resolve => setImmediate(resolve));
        expect(asked.map(item => item.speaker)).toEqual(['char.png', 'member.png']);
        await finishNext();
        await done;

        expect(postMemberConversationReply).toHaveBeenCalledTimes(1);
    });

    test('lists the members still to speak in the plan of each reply, with the same start of the round for all', async () => {
        const seen = answerWith('claimed');

        await processQueuedConversationReply(groupItem());

        const [first, second] = seen.map(item => item.profile);
        expect(first.round).toEqual(['member.png']);
        expect(second.round).toEqual([]);
        expect(first.reply.round_started).toBe(second.reply.round_started);
    });

    test('lets the member who spoke last answer a message that names nobody, and gives the turn to another when its card is at 0', async () => {
        const seen = answerWith('claimed');
        await processQueuedConversationReply(groupItem({ text: 'hello' }));
        expect(seen.map(item => item.profile.reply.speaker)).toEqual(['char.png']);

        cards['char.png'] = 0;
        seen.length = 0;
        await processQueuedConversationReply(groupItem({ text: 'hello' }));

        expect(seen.map(item => item.profile.reply.speaker)).toEqual(['third.png']);
    });

    test('lets a member at 0 answer when it is named, and reads the card at that moment', async () => {
        cards['member.png'] = 0;
        const seen = answerWith('claimed');

        await processQueuedConversationReply(groupItem({ text: 'Birch, hello' }));

        expect(seen.map(item => item.profile.reply.speaker)).toContain('member.png');
    });

    test('lets at most two members speak, whoever is mentioned', async () => {
        const seen = answerWith('claimed');

        await processQueuedConversationReply(groupItem({ text: 'Aster, Birch and Cyan, hello' }));

        expect(seen).toHaveLength(2);
    });

    test('marks the last bubble of a reply with the rest of the round, and no reply that ends the round', async () => {
        const seen = answerWith('claimed');

        await processQueuedConversationReply(groupItem());

        const first = postCharacterReply.mock.calls[0][2].roundMarker;
        expect(first).toEqual({ remaining: ['member.png'], started: seen[0].profile.reply.round_started, triggers: ['u1'] });
        expect(postMemberConversationReply.mock.calls[0][3].roundMarker).toBeNull();
    });

    test('stops before the second member when the user wrote a message meanwhile, and lets the reply being written finish', async () => {
        const { asked, finishNext } = gatedReplies();
        const done = processQueuedConversationReply(groupItem());
        await new Promise(resolve => setImmediate(resolve));
        messages = [...messages, { id: 'u2', role: 'user', name: 'You', mes: 'wait, one more thing', created_at: 3, extra: {} }];

        await finishNext();
        await done;

        expect(postCharacterReply).toHaveBeenCalledTimes(1);
        expect(asked.map(item => item.speaker)).toEqual(['char.png']);
        expect(postMemberConversationReply).not.toHaveBeenCalled();
    });

    test('stops before the second member when a reply for this chat waits in the queue, forced or not', async () => {
        for (const force of [false, true]) {
            generateConversationReply.mockClear();
            const { asked, finishNext } = gatedReplies();
            const done = processQueuedConversationReply(groupItem());
            await new Promise(resolve => setImmediate(resolve));
            sendQueue.push(queueItem({ groupId: CONVERSATION, force, messageIds: force ? ['u1'] : [] }));

            await finishNext();
            await done;

            expect(asked.map(item => item.speaker)).toEqual(['char.png']);
            sendQueue.length = 0;
        }
    });

    test('stops before the second member when the message that the round answers was edited meanwhile', async () => {
        const { asked, finishNext } = gatedReplies();
        const done = processQueuedConversationReply(groupItem());
        await new Promise(resolve => setImmediate(resolve));
        messages = [messages[0], { ...USER_MESSAGE, mes: 'hello, edited' }];

        await finishNext();
        await done;

        expect(asked.map(item => item.speaker)).toEqual(['char.png']);
    });

    test('skips a member that left the group, and does not stop for it', async () => {
        const { asked, finishNext } = gatedReplies();
        const done = processQueuedConversationReply(groupItem({ text: 'Aster, Birch and Cyan, hello' }));
        await new Promise(resolve => setImmediate(resolve));
        expect(asked.map(item => item.speaker)).toEqual(['char.png']);
        setGroup(['char.png', 'third.png']);

        await finishNext();
        await done;

        expect(asked.map(item => item.speaker)).toEqual(['char.png']);
    });

    test('discards the reply of a member that left the group while the reply was being written', async () => {
        const { finishNext } = gatedReplies();
        const done = processQueuedConversationReply(groupItem({ text: 'Birch, hello' }));
        await new Promise(resolve => setImmediate(resolve));
        setGroup(['char.png', 'third.png']);

        await finishNext();
        await done;

        expect(postMemberConversationReply).not.toHaveBeenCalled();
        expect(postCharacterReply).not.toHaveBeenCalled();
    });

    test('goes on to the second member after a reply that the server wrote, once the chat is read again', async () => {
        const seen = [];
        generateConversationReply.mockImplementation(async (_directive, _settings, options) => {
            seen.push(options.speakerAvatar);
            options.commit.state = seen.length === 1 ? 'committed' : 'claimed';
            return 'A reply.';
        });

        await processQueuedConversationReply(groupItem());

        expect(seen).toEqual(['char.png', 'member.png']);
        expect(postCharacterReply).not.toHaveBeenCalled();
        expect(reloadConversationChat).toHaveBeenCalledTimes(1);
        expect(postMemberConversationReply).toHaveBeenCalledTimes(1);
    });

    test('carries on a round that a page resumed: only the members that remain, from the start that the round had', async () => {
        const seen = answerWith('claimed');

        await processQueuedConversationReply(groupItem({ round: { remaining: ['member.png'], started: 1234 }, coalesced: true }));

        expect(seen).toHaveLength(1);
        expect(seen[0].profile.reply).toMatchObject({ speaker: 'member.png', round_started: 1234 });
        expect(seen[0].profile.round).toEqual([]);
    });

    test('does nothing for a resumed round whose members have all left the group', async () => {
        setGroup(['char.png']);
        const seen = answerWith('claimed');

        await processQueuedConversationReply(groupItem({ round: { remaining: ['member.png'], started: 1234 }, coalesced: true }));

        expect(seen).toHaveLength(0);
    });

    test('leaves no member marked as busy when the round is over', async () => {
        answerWith('claimed');
        const { memberReplyBusyKeys } = await import('../public/scripts/sillybunny-conversation/state.js');

        await processQueuedConversationReply(groupItem());

        expect(memberReplyBusyKeys.size).toBe(0);
    });
});

describe('a reply that is put in the queue and waited for', () => {
    beforeEach(() => {
        globalThis.document = { getElementById: () => null };
        globalThis.HTMLTextAreaElement = class {};
        sendQueue.length = 0;
        group = { id: CONVERSATION, members: ['char.png', 'member.png'], disabled_members: [] };
        jest.spyOn(Math, 'random').mockReturnValue(0.99);
    });

    afterEach(() => {
        delete globalThis.document;
        delete globalThis.HTMLTextAreaElement;
        jest.restoreAllMocks();
    });

    test('is done when the queue has processed it, and not before', async () => {
        let release;
        generateConversationReply.mockImplementation(async (_directive, _settings, options) => {
            options.commit.state = 'claimed';
            await new Promise((resolve) => { release = resolve; });
            return 'A reply.';
        });
        let done = false;

        const waiting = enqueueConversationReply(queueItem({ groupId: CONVERSATION, text: 'Birch, hello', coalesced: true })).then(() => { done = true; });
        await new Promise(resolve => setImmediate(resolve));
        expect(done).toBe(false);
        release();
        await waiting;

        expect(done).toBe(true);
        expect(postMemberConversationReply).toHaveBeenCalledTimes(1);
        expect(sendQueue).toHaveLength(0);
    });

    test('is done also when its reply came to nothing', async () => {
        answerWith('claimed', '');

        await expect(enqueueConversationReply(queueItem({ groupId: CONVERSATION, text: 'Birch, hello', coalesced: true, messageIds: ['gone'] }))).resolves.toBeUndefined();
    });
});

describe('a forced reply', () => {
    beforeEach(() => {
        globalThis.document = { getElementById: () => null };
        globalThis.HTMLTextAreaElement = class {};
        sendQueue.length = 0;
        group = { id: CONVERSATION, members: ['char.png', 'member.png', 'third.png'], disabled_members: [] };
        jest.spyOn(Math, 'random').mockReturnValue(0.99);
    });

    afterEach(() => {
        delete globalThis.document;
        delete globalThis.HTMLTextAreaElement;
        jest.restoreAllMocks();
    });

    test('is queued for the last message of the user, and does nothing in a chat where the user has written nothing', async () => {
        messages = [messages[0]];
        expect(queueForcedConversationReply('char.png', { chatId: 'main', groupId: '', personaId: PERSONA })).toBe(false);
        expect(generateConversationReply).not.toHaveBeenCalled();

        messages = [messages[0], USER_MESSAGE];
        answerWith('claimed');
        expect(queueForcedConversationReply('char.png', { chatId: 'main', groupId: '', personaId: PERSONA })).toBe(true);
        await new Promise(resolve => setTimeout(resolve, 20));

        expect(generateConversationReply).toHaveBeenCalledTimes(1);
    });

    test('carries on with the members that it is given for a group, from the start that it is given', async () => {
        const seen = answerWith('claimed');

        queueForcedConversationReply('char.png', { chatId: 'main', groupId: CONVERSATION, personaId: PERSONA, round: { remaining: ['member.png', 'third.png'], started: 9 } });
        await new Promise(resolve => setTimeout(resolve, 20));

        expect(seen.map(item => item.profile.reply.speaker)).toEqual(['member.png', 'third.png']);
        expect(seen[0].profile.reply.round_started).toBe(9);
        expect(seen[0].profile.round).toEqual(['third.png']);
    });
});
