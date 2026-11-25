import { beforeEach, describe, expect, jest, test } from '@jest/globals';

import { normalizeCommitPlan } from '../public/scripts/generation-commit-plan.js';
import { createWorld, installAutoEngineMocks, MINUTE, NOW, PERSONA } from './util/auto-engine-harness.js';

const world = createWorld(jest);
await installAutoEngineMocks(jest, world);

const { conversationModeAutoMessageWorker } = await import('../public/scripts/sillybunny-conversation/auto-engine.js');

const { generateConversationReply, postCharacterReply, postMemberConversationReply, generateConversationImage } = world.spies;
let clock = NOW;

beforeEach(() => {
    world.reset();
    clock = NOW;
    jest.spyOn(Date, 'now').mockImplementation(() => clock);
});

/** One tick of the worker at the time `clock` shows. */
async function tick() {
    await conversationModeAutoMessageWorker({ signal: new AbortController().signal });
}

const ON = { proactive_messaging: true };

/** The kind of each message that was written, in the order that the worker wrote them. */
function postedFlags() {
    const posts = [
        ...postCharacterReply.mock.calls.map((call, index) => ({ order: postCharacterReply.mock.invocationCallOrder[index], extra: call[2].extra })),
        ...postMemberConversationReply.mock.calls.map((call, index) => ({ order: postMemberConversationReply.mock.invocationCallOrder[index], extra: call[3].extra })),
    ];
    return posts.sort((first, second) => first.order - second.order).map(post => Object.keys(post.extra).find(key => key.startsWith('conversation_mode_')));
}

function direct(options = {}) {
    const view = world.addConversation('conv_1_direct', options);
    world.railItems = [world.railItemFor(view)];
    return view;
}

function group(options = {}) {
    const characters = options.characters ?? ['char.png', 'birch.png', 'cedar.png'];
    const view = world.addConversation('conv_2_group001', { kind: 'group', characters, ...options });
    world.railItems = [world.railItemFor(view)];
    return view;
}

describe('with messaging first off, which is the default', () => {
    test.each([0, 60, 600, 10_000, 1_000_000])('a direct chat that has a message from the user stays silent after %s minutes', async (quietMinutes) => {
        direct({ quietMinutes });

        await tick();

        expect(generateConversationReply).not.toHaveBeenCalled();
        expect(postCharacterReply).not.toHaveBeenCalled();
    });

    test.each([0, 60, 600, 10_000, 1_000_000])('a group that has a message from the user stays silent after %s minutes: no check-in, no chime, no talk among the members', async (quietMinutes) => {
        group({ quietMinutes });

        await tick();
        clock += 10 * MINUTE;
        await tick();

        expect(generateConversationReply).not.toHaveBeenCalled();
        expect(postMemberConversationReply).not.toHaveBeenCalled();
        expect(postCharacterReply).not.toHaveBeenCalled();
    });

    test('sends no spontaneous selfie either, with every picture setting on', async () => {
        direct({ quietMinutes: 100_000, settings: { image_gen_enabled: true, spontaneous_selfies: true } });
        generateConversationImage.mockResolvedValue('/img.png');

        await tick();

        expect(generateConversationImage).not.toHaveBeenCalled();
        expect(world.spies.appendConversationMessage).not.toHaveBeenCalled();
    });

    test('is off for a conversation whose switch is not true, whatever else it holds', async () => {
        direct({ quietMinutes: 100_000, settings: { proactive_messaging: 'yes', idle_followup: true, auto_message: true, multi_char: true, auto_character_chat: true } });

        await tick();

        expect(generateConversationReply).not.toHaveBeenCalled();
    });

    test('the switch is per conversation: one that is on does not turn another one on', async () => {
        const first = direct({ quietMinutes: 100_000 });
        const second = world.addConversation('conv_2_group001', { kind: 'group', characters: ['char.png', 'birch.png'], quietMinutes: 100_000, settings: ON });
        world.railItems = [world.railItemFor(first), world.railItemFor(second)];

        await tick();

        expect(generateConversationReply).toHaveBeenCalledTimes(1);
        expect(generateConversationReply.mock.calls[0][2].groupId).toBe('conv_2_group001');
    });
});

describe('with messaging first on, in a direct conversation', () => {
    test('writes first once the user has been quiet for the patience, and not before', async () => {
        direct({ quietMinutes: 59, settings: ON });
        await tick();
        expect(generateConversationReply).not.toHaveBeenCalled();

        clock += MINUTE;
        await tick();

        expect(generateConversationReply).toHaveBeenCalledTimes(1);
        expect(postCharacterReply).toHaveBeenCalledTimes(1);
    });

    test('writes the message with the flags of an automatic message and the token of its place in the chat', async () => {
        direct({ quietMinutes: 120, settings: ON });

        await tick();

        const [, , options] = postCharacterReply.mock.calls[0];
        expect(options.extra).toMatchObject({ conversation_mode_auto: true, proactive: true });
        expect(options.extra.reply_token).toMatch(/^[0-9a-f]{16}$/);
        expect(options.validateTarget()).toBe(true);
        expect(postCharacterReply.mock.calls[0][3]).toBe('char.png');
    });

    test('writes what it knows about the message before it asks the model, so that a page that closes meanwhile leaves it behind', async () => {
        const view = direct({ quietMinutes: 120, settings: ON });

        await tick();

        expect(world.log.indexOf('generate')).toBeGreaterThan(world.log.indexOf('claim:followupCount'));
        expect(world.log.indexOf('generate')).toBeGreaterThan(world.log.indexOf('patch:lastAutoMessageAt'));
        expect(world.entryOf(view)).toMatchObject({ followupCount: 1, lastAutoMessageAt: NOW });
    });

    test('keeps that record when the model fails, so that the next tick does not ask again at once', async () => {
        const view = direct({ quietMinutes: 120, settings: ON });
        generateConversationReply.mockRejectedValue(new Error('the model is down'));

        await tick();
        await tick();
        await tick();

        expect(generateConversationReply).toHaveBeenCalledTimes(1);
        expect(world.entryOf(view).followupCount).toBe(1);
    });

    test('does not send the same message twice on the next ticks', async () => {
        direct({ quietMinutes: 120, settings: ON });

        await tick();
        await tick();
        clock += 30 * MINUTE;
        await tick();

        expect(generateConversationReply).toHaveBeenCalledTimes(1);
    });

    test('sends the next one after twice the patience, and one more after twice that, and then no more', async () => {
        const view = direct({ quietMinutes: 60, settings: ON });

        await tick();
        expect(generateConversationReply).toHaveBeenCalledTimes(1);

        clock += 119 * MINUTE;
        await tick();
        expect(generateConversationReply).toHaveBeenCalledTimes(1);
        clock += MINUTE;
        await tick();
        expect(generateConversationReply).toHaveBeenCalledTimes(2);

        clock += 239 * MINUTE;
        await tick();
        expect(generateConversationReply).toHaveBeenCalledTimes(2);
        clock += MINUTE;
        await tick();
        expect(generateConversationReply).toHaveBeenCalledTimes(3);

        clock += 100_000 * MINUTE;
        await tick();
        expect(generateConversationReply).toHaveBeenCalledTimes(3);
        expect(world.entryOf(view).followupCount).toBe(3);
    });

    test('stops at the maximum that the conversation allows', async () => {
        direct({ quietMinutes: 60, settings: { ...ON, max_followups: 1 } });

        await tick();
        clock += 100_000 * MINUTE;
        await tick();

        expect(generateConversationReply).toHaveBeenCalledTimes(1);
    });

    test.each([
        [0, 90],
        [0.5, 60],
        [1, 30],
    ])('waits as long as the card says: talkativeness %s, %s minutes of a patience of 60', async (talkativeness, minutes) => {
        world.addCharacter('char.png', { name: 'Aster', talkativeness });
        direct({ quietMinutes: minutes - 1, settings: ON });
        await tick();
        expect(generateConversationReply).not.toHaveBeenCalled();

        clock += MINUTE;
        await tick();

        expect(generateConversationReply).toHaveBeenCalledTimes(1);
    });

    test('sends nothing while the user is Invisible or on Do Not Disturb', async () => {
        direct({ quietMinutes: 100_000, settings: ON });

        world.userStatus = 'offline';
        await tick();
        world.userStatus = 'dnd';
        await tick();

        expect(generateConversationReply).not.toHaveBeenCalled();
    });

    test('sends nothing while the character is offline, and waits three times as long while it is busy', async () => {
        direct({ quietMinutes: 100_000, settings: ON });
        world.statuses.set('char.png', 'offline');
        await tick();
        expect(generateConversationReply).not.toHaveBeenCalled();

        world.statuses.set('char.png', 'dnd');
        world.entryOf(world.views.get('conv_1_direct')).lastActivity = NOW - 179 * MINUTE;
        await tick();
        expect(generateConversationReply).not.toHaveBeenCalled();
        clock += MINUTE;
        await tick();
        expect(generateConversationReply).toHaveBeenCalledTimes(1);
    });

    test('answers at once a message of the user that nobody answered', async () => {
        direct({ quietMinutes: 1, lastMessageRole: 'user', settings: ON });

        await tick();

        expect(generateConversationReply).toHaveBeenCalledTimes(1);
    });

    test('the extra characters of an old conversation do not speak: only its character does', async () => {
        const view = direct({ quietMinutes: 100_000, settings: ON });
        view.extras = ['birch.png'];
        world.addCharacter('birch.png');

        await tick();

        expect(generateConversationReply).toHaveBeenCalledTimes(1);
        expect(generateConversationReply.mock.calls[0][2].speakerAvatar).toBe('char.png');
        expect(postMemberConversationReply).not.toHaveBeenCalled();
    });

    test('a picture may follow the message when the conversation has spontaneous selfies on', async () => {
        direct({ quietMinutes: 100_000, settings: { ...ON, image_gen_enabled: true, spontaneous_selfies: true } });
        generateConversationImage.mockResolvedValue('/img.png');

        await tick();

        expect(generateConversationImage).toHaveBeenCalledTimes(1);
        expect(world.spies.appendConversationMessage).toHaveBeenCalledTimes(1);
    });
});

describe('with messaging first on, in a group', () => {
    test('a member who has not spoken writes first to the user, as a member of the group', async () => {
        const view = group({ quietMinutes: 100_000, settings: ON });
        world.say(view, { role: 'character', extra: {} });
        world.say(view, { role: 'member', extra: { member_avatar: 'birch.png' } });

        await tick();

        expect(generateConversationReply).toHaveBeenCalledTimes(1);
        expect(generateConversationReply.mock.calls[0][2]).toMatchObject({ speakerAvatar: 'cedar.png', anchorAvatar: 'char.png', groupId: 'conv_2_group001' });
        expect(postMemberConversationReply).toHaveBeenCalledTimes(1);
        expect(postMemberConversationReply.mock.calls[0][1].avatar).toBe('cedar.png');
        expect(postMemberConversationReply.mock.calls[0][3].extra).toMatchObject({ conversation_mode_auto: true, member_avatar: 'cedar.png' });
        expect(postCharacterReply).not.toHaveBeenCalled();
    });

    test('once that went unanswered the members talk to each other, one at a time, and the user is not their target', async () => {
        const view = group({ quietMinutes: 60, settings: ON });
        await tick();
        clock += 120 * MINUTE;
        await tick();
        clock += 240 * MINUTE;
        await tick();

        expect(generateConversationReply).toHaveBeenCalledTimes(3);
        const [first, second, third] = generateConversationReply.mock.calls;
        expect(first[0]).toContain('The user has not replied in a while');
        for (const call of [second, third]) {
            expect(call[0]).toContain('Aim this message at');
            expect(call[0]).toContain('not the user');
        }
        expect(postedFlags()).toEqual(['conversation_mode_auto', 'conversation_mode_auto_chat', 'conversation_mode_auto_chat']);
        expect(world.entryOf(view).followupCount).toBe(3);
    });

    test('the talk of the members stops at the same maximum as the check-ins, because they count together', async () => {
        group({ quietMinutes: 60, settings: { ...ON, max_followups: 2 } });

        for (const wait of [0, 120, 240, 480, 100_000]) {
            clock += wait * MINUTE;
            await tick();
        }

        expect(generateConversationReply).toHaveBeenCalledTimes(2);
    });

    test('a member whose card says talkativeness 0 starts nothing, and a group of such members stays silent', async () => {
        group({ quietMinutes: 100_000, settings: ON });
        for (const avatar of ['char.png', 'birch.png', 'cedar.png']) {
            world.addCharacter(avatar, { talkativeness: 0 });
        }

        await tick();

        expect(generateConversationReply).not.toHaveBeenCalled();

        world.addCharacter('birch.png', { talkativeness: 0.2 });
        await tick();
        expect(generateConversationReply).toHaveBeenCalledTimes(1);
        expect(generateConversationReply.mock.calls[0][2].speakerAvatar).toBe('birch.png');
    });

    test('each member waits as long as its own card says, and the one whose patience ran out first writes', async () => {
        group({ quietMinutes: 31, settings: ON });
        world.addCharacter('char.png', { talkativeness: 0.5 });
        world.addCharacter('birch.png', { talkativeness: 0.5 });
        world.addCharacter('cedar.png', { talkativeness: 1 });

        await tick();

        expect(generateConversationReply).toHaveBeenCalledTimes(1);
        expect(generateConversationReply.mock.calls[0][2].speakerAvatar).toBe('cedar.png');
    });

    test('a member that is offline does not write, and another one does', async () => {
        group({ quietMinutes: 100_000, settings: ON });
        world.statuses.set('char.png', 'offline');
        world.statuses.set('birch.png', 'offline');

        await tick();

        expect(generateConversationReply.mock.calls[0][2].speakerAvatar).toBe('cedar.png');
    });

    test('sends nothing in a chat that has no message from the user, however long the silence', async () => {
        group({ quietMinutes: 100_000, hasUserMessage: false, settings: ON });

        await tick();

        expect(generateConversationReply).not.toHaveBeenCalled();
    });
});

describe('the commit plan of an automatic message', () => {
    test('lets the server write the message into the chat when the page is gone, with a token that names the message', async () => {
        direct({ quietMinutes: 120, settings: ON });

        await tick();

        const { commit } = generateConversationReply.mock.calls[0][2];
        const plan = normalizeCommitPlan(commit.createPlan('raw'));
        expect(plan).not.toBeNull();
        expect(plan).toMatchObject({
            chat: { conversation: 'conv_1_direct' },
            file: 'main',
            kind: 'reply',
            round: [],
            reply: { origin: 'auto', route: 'raw', speaker: 'char.png', anchor: 'char.png', triggers: [], target: null, needs_user: true },
        });
        expect(plan.reply.token).toBe(postCharacterReply.mock.calls[0][2].extra.reply_token);
    });

    test('is for members talking to each other an auto_chat plan from the member who talks', async () => {
        group({ quietMinutes: 60, settings: ON });
        await tick();
        clock += 120 * MINUTE;
        await tick();

        const plan = normalizeCommitPlan(generateConversationReply.mock.calls[1][2].commit.createPlan('profile'));

        expect(plan.reply).toMatchObject({ origin: 'auto_chat', route: 'profile', needs_user: true });
        expect(plan.reply.speaker).toBe(generateConversationReply.mock.calls[1][2].speakerAvatar);
        expect(plan.reply.anchor).toBe('char.png');
    });

    test('is not followed by a write of this page when the server wrote the message while the page waited', async () => {
        const view = direct({ quietMinutes: 120, settings: ON });
        generateConversationReply.mockImplementation(async (_directive, _settings, { commit }) => {
            commit.state = 'committed';
            return 'Hello there.';
        });

        await tick();

        expect(postCharacterReply).not.toHaveBeenCalled();
        expect(world.spies.reloadConversationChat).toHaveBeenCalledWith('char.png', { chatId: 'main', groupId: '', personaId: PERSONA });
        expect(world.entryOf(view).followupCount).toBe(1);
    });

    test('asks for no message when the chat already holds the one that this place in the chat is due', async () => {
        const view = direct({ quietMinutes: 120, settings: ON });
        await tick();
        const token = postCharacterReply.mock.calls[0][2].extra.reply_token;
        generateConversationReply.mockClear();
        postCharacterReply.mockClear();
        // Another page wrote the message and the record of this page is older than that page's write.
        world.entryOf(view).followupCount = 0;
        world.entryOf(view).lastAutoMessageAt = 0;
        world.say(view, { id: 'bubble', role: 'character', extra: { reply_token: token } });

        await tick();

        expect(generateConversationReply).not.toHaveBeenCalled();
        expect(postCharacterReply).not.toHaveBeenCalled();
    });

    test('is dropped when the chat holds the message by the time the model answered', async () => {
        const view = direct({ quietMinutes: 120, settings: ON });
        generateConversationReply.mockImplementation(async (_directive, _settings, { commit }) => {
            const { reply } = commit.createPlan('raw');
            world.say(view, { id: 'landed', role: 'character', extra: { reply_token: reply.token } });
            return 'Hello there.';
        });

        await tick();

        expect(postCharacterReply).not.toHaveBeenCalled();
    });
});
