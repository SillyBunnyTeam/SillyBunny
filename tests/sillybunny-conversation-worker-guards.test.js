import { beforeEach, describe, expect, jest, test } from '@jest/globals';

import { createWorld, installAutoEngineMocks, MINUTE, NOW, PERSONA } from './util/auto-engine-harness.js';

const world = createWorld(jest);
await installAutoEngineMocks(jest, world);

const { checkMessagingFirst, conversationModeAutoMessageWorker, sendAutomaticMessage } = await import('../public/scripts/sillybunny-conversation/auto-engine.js');

const { generateConversationReply, postCharacterReply, postMemberConversationReply } = world.spies;
const ON = { proactive_messaging: true };
const SCOPE = { chatId: 'main', groupId: '', personaId: PERSONA };

beforeEach(() => {
    world.reset();
    jest.spyOn(Date, 'now').mockReturnValue(NOW);
});

const tick = () => conversationModeAutoMessageWorker({ signal: new AbortController().signal });

function direct(options = {}) {
    const view = world.addConversation('conv_1_direct', { quietMinutes: 100_000, settings: ON, ...options });
    world.railItems = [world.railItemFor(view)];
    return view;
}

function group(options = {}) {
    const view = world.addConversation('conv_2_group001', { kind: 'group', characters: ['char.png', 'birch.png'], quietMinutes: 100_000, settings: ON, ...options });
    world.railItems = [world.railItemFor(view)];
    return view;
}

/** What a caller of `sendAutomaticMessage` gives for a message of the character of the first conversation. */
function message(overrides = {}) {
    return {
        origin: 'auto',
        anchorAvatar: 'char.png',
        speaker: { avatar: 'char.png', name: 'Aster' },
        directive: '[directive]',
        token: 'abcdef0123456789',
        settings: {},
        ...SCOPE,
        ...overrides,
    };
}

/** Deletes the chat of a conversation while a reply for it is being generated. */
function deleteChatDuringGeneration(view) {
    generateConversationReply.mockImplementation(async () => {
        view.chats = [];
        return 'Hello there.';
    });
}

describe('the worker and a chat that has no message from the user', () => {
    test('does nothing in a direct chat that has none, however long the silence', async () => {
        direct({ hasUserMessage: false });

        await tick();

        expect(generateConversationReply).not.toHaveBeenCalled();
        expect(postCharacterReply).not.toHaveBeenCalled();
    });

    test('does nothing in a group that has none, whatever its members would say to each other', async () => {
        group({ hasUserMessage: false });

        await tick();

        expect(generateConversationReply).not.toHaveBeenCalled();
    });

    test('control: a chat with a message from the user is talked in, so the harness can see the difference', async () => {
        direct({ hasUserMessage: true });

        await tick();

        expect(generateConversationReply).toHaveBeenCalled();
    });

    test('does nothing in a chat that lost its last message from the user since the tick began to build its list', async () => {
        const view = direct({ hasUserMessage: true });
        view.chats[0].hasUserMessage = false;

        await tick();

        expect(generateConversationReply).not.toHaveBeenCalled();
    });

    test('a direct call for a chat that has none makes no request either', async () => {
        world.addConversation('conv_1_direct', { hasUserMessage: false });

        const outcome = await sendAutomaticMessage(message());

        expect(outcome).toBe('not-started');
        expect(generateConversationReply).not.toHaveBeenCalled();
    });

    test('a reminder is sent there anyway, because the user asked for it', async () => {
        world.addConversation('conv_1_direct', { hasUserMessage: false });

        const outcome = await sendAutomaticMessage(message({ origin: 'reminder', reminderId: 'rem_1_aaaaaa', needsUserMessage: false }));

        expect(outcome).toBe('posted');
        expect(postCharacterReply).toHaveBeenCalled();
    });
});

describe('the worker while the user is Invisible', () => {
    test('does not tick', async () => {
        direct();
        world.userStatus = 'offline';

        await tick();

        expect(generateConversationReply).not.toHaveBeenCalled();
    });

    test('drops a message whose model answered after the user went Invisible', async () => {
        direct();
        generateConversationReply.mockImplementation(async () => {
            world.userStatus = 'offline';
            return 'Hello there.';
        });

        await tick();

        expect(generateConversationReply).toHaveBeenCalledTimes(1);
        expect(postCharacterReply).not.toHaveBeenCalled();
    });

    test('does not write the next bubble of a message once the user went Invisible', async () => {
        world.addConversation('conv_1_direct');

        await sendAutomaticMessage(message());

        const { validateTarget } = postCharacterReply.mock.calls[0][2];
        expect(validateTarget()).toBe(true);
        world.userStatus = 'offline';
        expect(validateTarget()).toBe(false);
    });
});

describe('an automatic message whose chat is deleted while it is generated', () => {
    test('is not written', async () => {
        const view = world.addConversation('conv_1_direct');
        deleteChatDuringGeneration(view);

        const outcome = await sendAutomaticMessage(message());

        expect(generateConversationReply).toHaveBeenCalledTimes(1);
        expect(postCharacterReply).not.toHaveBeenCalled();
        expect(outcome).toBe('failed');
    });

    test('is handed a check that fails once the chat is gone, for the bubbles that follow the first', async () => {
        const view = world.addConversation('conv_1_direct');

        await sendAutomaticMessage(message());

        const { validateTarget } = postCharacterReply.mock.calls[0][2];
        expect(validateTarget()).toBe(true);
        view.chats = [];
        expect(validateTarget()).toBe(false);
    });

    test('is not written by a member of a group, or for members that talk to each other', async () => {
        const view = world.addConversation('conv_2_group001', { kind: 'group', characters: ['char.png', 'birch.png'] });
        deleteChatDuringGeneration(view);

        const outcome = await sendAutomaticMessage(message({ origin: 'auto_chat', groupId: view.id, speaker: { avatar: 'birch.png', name: 'birch' } }));

        expect(generateConversationReply).toHaveBeenCalledTimes(1);
        expect(postMemberConversationReply).not.toHaveBeenCalled();
        expect(outcome).toBe('failed');
    });

    test('is written when the chat is still there, and the writer gets a check for the next bubble', async () => {
        const view = world.addConversation('conv_2_group001', { kind: 'group', characters: ['char.png', 'birch.png'] });

        const outcome = await sendAutomaticMessage(message({ origin: 'auto_chat', groupId: view.id, speaker: { avatar: 'birch.png', name: 'birch' } }));

        expect(outcome).toBe('posted');
        expect(postMemberConversationReply).toHaveBeenCalledTimes(1);
        expect(postMemberConversationReply.mock.calls[0][3].validateTarget()).toBe(true);
    });

    test('is not written into a conversation of the same character that was made after the first one was deleted', async () => {
        const view = world.addConversation('conv_1_direct');
        generateConversationReply.mockImplementation(async () => {
            world.views.delete(view.id);
            world.addConversation('conv_9_direct99');
            return 'Hello there.';
        });

        const outcome = await sendAutomaticMessage(message());

        expect(postCharacterReply).not.toHaveBeenCalled();
        expect(outcome).toBe('failed');
    });

    test('is not started for a chat that does not exist', async () => {
        world.addConversation('conv_2_group001', { kind: 'group', characters: ['char.png', 'birch.png'] });

        const outcome = await sendAutomaticMessage(message({ origin: 'auto_chat', groupId: 'conv_2_group001', chatId: 'gone', speaker: { avatar: 'birch.png', name: 'birch' } }));

        expect(outcome).toBe('not-started');
        expect(generateConversationReply).not.toHaveBeenCalled();
    });

    test('is not started for a conversation that does not exist', async () => {
        const outcome = await sendAutomaticMessage(message());

        expect(outcome).toBe('not-started');
        expect(generateConversationReply).not.toHaveBeenCalled();
    });
});

describe('a tick', () => {
    test('does not act on a conversation that was deleted earlier in the same tick', async () => {
        const first = world.addConversation('conv_1_direct', { quietMinutes: 100_000, settings: ON });
        const second = world.addConversation('conv_2_group001', { kind: 'group', characters: ['char.png', 'birch.png'], quietMinutes: 100_000, settings: ON });
        world.railItems = [world.railItemFor(first), world.railItemFor(second)];
        generateConversationReply.mockImplementation(async () => {
            world.views.delete(second.id);
            return '';
        });

        await tick();

        expect(generateConversationReply.mock.calls.length).toBeGreaterThan(0);
        for (const call of generateConversationReply.mock.calls) {
            expect(call[2].groupId || '').not.toBe(second.id);
        }
    });

    test('does nothing while a reply to the user is being generated or queued', async () => {
        direct();
        world.state.conversationState.conversationReplyBusy = true;
        await tick();
        world.state.conversationState.conversationReplyBusy = false;
        world.state.sendQueue.push({ id: 'queued' });
        await tick();

        expect(generateConversationReply).not.toHaveBeenCalled();
    });

    test('does nothing when its signal is aborted', async () => {
        direct();
        const controller = new AbortController();
        controller.abort();

        await conversationModeAutoMessageWorker({ signal: controller.signal });

        expect(generateConversationReply).not.toHaveBeenCalled();
    });
});

describe('two messages at once', () => {
    test('a message that starts while another is being generated is not started, whichever tick asked for it', async () => {
        world.addConversation('conv_1_direct');
        let finish;
        generateConversationReply.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));

        const first = sendAutomaticMessage(message());
        await Promise.resolve();
        const second = await sendAutomaticMessage(message({ token: '0123456789abcdef' }));

        expect(second).toBe('not-started');
        expect(generateConversationReply).toHaveBeenCalledTimes(1);
        finish('Hello there.');
        expect(await first).toBe('posted');
        expect(world.state.conversationState.autoWorkerBusy).toBe(false);
    });

    test('lets the next message start once the first one failed', async () => {
        world.addConversation('conv_1_direct');
        generateConversationReply.mockRejectedValueOnce(new Error('the model is down'));

        expect(await sendAutomaticMessage(message())).toBe('failed');
        expect(await sendAutomaticMessage(message({ token: '0123456789abcdef' }))).toBe('posted');
    });

    test('checkMessagingFirst alone is not enough to start twice for one place in the chat: the token names it', async () => {
        const view = direct();
        const item = world.railItems[0];

        await checkMessagingFirst(item, NOW + 100 * MINUTE, { personaId: PERSONA });
        const token = postCharacterReply.mock.calls[0][2].extra.reply_token;
        world.say(view, { id: 'landed', role: 'character', extra: { reply_token: token } });
        view.chats[0].followupCount = 0;
        view.chats[0].lastAutoMessageAt = 0;
        generateConversationReply.mockClear();

        expect(await checkMessagingFirst(item, NOW + 100 * MINUTE, { personaId: PERSONA })).toBe(false);
        expect(generateConversationReply).not.toHaveBeenCalled();
    });
});
