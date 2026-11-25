import { beforeEach, describe, expect, jest, test } from '@jest/globals';

import { createWorld, installAutoEngineMocks, MINUTE, NOW, PERSONA } from './util/auto-engine-harness.js';
import { getReminderToken, MAX_REMINDER_ATTEMPTS, REMINDER_LEASE_MS } from '../public/scripts/sillybunny-conversation/reminders.js';

const world = createWorld(jest);
await installAutoEngineMocks(jest, world);

const { checkConversationReminders, conversationModeAutoMessageWorker } = await import('../public/scripts/sillybunny-conversation/auto-engine.js');

const { generateConversationReply, postCharacterReply } = world.spies;
let clock = NOW;

beforeEach(() => {
    world.reset();
    clock = NOW;
    jest.spyOn(Date, 'now').mockImplementation(() => clock);
});

const tick = () => conversationModeAutoMessageWorker({ signal: new AbortController().signal });

function remind(overrides = {}) {
    return { id: 'rem_1_aaaaaa', avatar: 'char.png', chatId: 'main', text: 'water the plants', triggerAt: NOW - 1000, fired: false, ...overrides };
}

function conversationWith(reminders, options = {}) {
    const view = world.addConversation('conv_1_direct', { reminders, ...options });
    world.railItems = [world.railItemFor(view)];
    return view;
}

describe('a reminder that is due', () => {
    test('is delivered by the character in its chat, with the flags of a reminder and the token of the reminder', async () => {
        const reminder = remind();
        const view = conversationWith([reminder]);

        await expect(checkConversationReminders(NOW)).resolves.toBe(true);

        const [, , options] = postCharacterReply.mock.calls[0];
        expect(options.extra).toMatchObject({ conversation_mode_reminder: true, reminder_id: 'rem_1_aaaaaa', reminder_text: 'water the plants', reply_token: getReminderToken(reminder) });
        expect(generateConversationReply.mock.calls[0][0]).toContain('water the plants');
        expect(view.reminders[0]).toMatchObject({ fired: true, attempts: 1, firedAt: NOW });
        expect(view.reminders[0]).not.toHaveProperty('retryAfter');
    });

    test('is delivered even when messaging first is off and the chat has no message from the user, because the user asked for it', async () => {
        const view = conversationWith([remind()], { hasUserMessage: false, settings: { proactive_messaging: false } });

        await tick();

        expect(postCharacterReply).toHaveBeenCalledTimes(1);
        expect(view.reminders[0].fired).toBe(true);
    });

    test('is not delivered while the user is Invisible, and is delivered when the user is back', async () => {
        const view = conversationWith([remind()]);
        world.userStatus = 'offline';
        await tick();
        expect(generateConversationReply).not.toHaveBeenCalled();

        world.userStatus = 'online';
        await tick();
        expect(view.reminders[0].fired).toBe(true);
    });

    test('is not delivered before its time', async () => {
        conversationWith([remind({ triggerAt: NOW + 1 })]);

        await expect(checkConversationReminders(NOW)).resolves.toBe(false);

        expect(generateConversationReply).not.toHaveBeenCalled();
    });

    test('is marked invalid, and not delivered, when its chat is gone', async () => {
        const view = conversationWith([remind({ chatId: 'deleted-chat' })]);

        await expect(checkConversationReminders(NOW)).resolves.toBe(false);

        expect(generateConversationReply).not.toHaveBeenCalled();
        expect(view.reminders[0]).toMatchObject({ invalidAt: NOW });
        expect(view.reminders[0].fired).toBe(false);
    });

    test('is written down as an attempt before the model is asked, so that a page that closes meanwhile leaves the attempt behind', async () => {
        const view = conversationWith([remind()]);

        await checkConversationReminders(NOW);

        expect(world.log.indexOf('generate')).toBeGreaterThan(world.log.findIndex(entry => entry.startsWith('reminder:chatId,attempts')));
        expect(view.reminders[0].lastAttemptAt).toBe(NOW);
    });

    test('goes out with a commit plan that the server accepts, for the reminder, with no user message needed', async () => {
        conversationWith([remind()], { hasUserMessage: false });

        await checkConversationReminders(NOW);

        const plan = generateConversationReply.mock.calls[0][2].commit.createPlan('raw');
        expect(plan.reply).toMatchObject({ origin: 'reminder', reminder: 'rem_1_aaaaaa', needs_user: false, triggers: [], token: getReminderToken(remind()) });
    });

    test('in a group is delivered by the member that set it, in the group', async () => {
        const view = world.addConversation('conv_2_group001', { kind: 'group', characters: ['char.png', 'birch.png'], reminders: [remind()] });
        world.railItems = [world.railItemFor(view)];

        await checkConversationReminders(NOW);

        expect(generateConversationReply.mock.calls[0][2]).toMatchObject({ groupId: 'conv_2_group001', anchorAvatar: 'char.png' });
        expect(view.reminders[0].fired).toBe(true);
    });

    test('goes first when several are due, and the next one is delivered by the tick after', async () => {
        const view = conversationWith([remind({ id: 'rem_2_bbbbbb', triggerAt: NOW - 100 }), remind({ id: 'rem_1_aaaaaa', triggerAt: NOW - 200 })]);

        await tick();
        expect(view.reminders.map(item => item.fired)).toEqual([false, true]);
        await tick();

        expect(view.reminders.map(item => item.fired)).toEqual([true, true]);
    });
});

describe('a reminder that cannot be delivered', () => {
    test('waits a minute after an attempt, and is tried again then', async () => {
        const view = conversationWith([remind()]);
        generateConversationReply.mockRejectedValue(new Error('the model is down'));

        await tick();
        expect(generateConversationReply).toHaveBeenCalledTimes(1);
        clock += REMINDER_LEASE_MS - 1;
        await tick();
        expect(generateConversationReply).toHaveBeenCalledTimes(1);
        clock += 1;
        await tick();

        expect(generateConversationReply).toHaveBeenCalledTimes(2);
        expect(view.reminders[0].attempts).toBe(2);
    });

    test('is tried a fixed number of times and then given up, and never asks the model again', async () => {
        const view = conversationWith([remind()]);
        generateConversationReply.mockRejectedValue(new Error('the model is down'));

        for (let attempt = 0; attempt < MAX_REMINDER_ATTEMPTS + 4; attempt++) {
            await tick();
            clock += REMINDER_LEASE_MS;
        }

        expect(generateConversationReply).toHaveBeenCalledTimes(MAX_REMINDER_ATTEMPTS);
        expect(view.reminders[0]).toMatchObject({ attempts: MAX_REMINDER_ATTEMPTS, fired: false });
        expect(view.reminders[0].skippedAt).toBeGreaterThan(0);
    });

    test('is given up after an attempt that the page did not live to settle', async () => {
        const view = conversationWith([remind({ attempts: MAX_REMINDER_ATTEMPTS, lastAttemptAt: NOW - 5 * MINUTE, retryAfter: NOW - 4 * MINUTE })]);

        await tick();

        expect(generateConversationReply).not.toHaveBeenCalled();
        expect(view.reminders[0].skippedAt).toBe(NOW);
    });

    test('is not given up while the last attempt may still be running', async () => {
        const view = conversationWith([remind({ attempts: MAX_REMINDER_ATTEMPTS, lastAttemptAt: NOW - 10, retryAfter: NOW + 50_000 })]);

        await tick();

        expect(view.reminders[0]).not.toHaveProperty('skippedAt');
    });

    test('counts as no attempt when the model was never asked, because the page was busy', async () => {
        const view = conversationWith([remind()]);
        world.state.conversationState.autoWorkerBusy = true;

        await expect(checkConversationReminders(NOW)).resolves.toBe(false);

        expect(view.reminders[0]).not.toHaveProperty('attempts');
    });

    test('is not written when the user cancelled it while its reply was being generated', async () => {
        const view = conversationWith([remind()]);
        generateConversationReply.mockImplementation(async () => {
            view.reminders = [];
            return 'Time to water the plants.';
        });

        await expect(checkConversationReminders(NOW)).resolves.toBe(false);

        expect(postCharacterReply).not.toHaveBeenCalled();
    });
});

describe('a reminder that the server wrote or that a page wrote already', () => {
    test('is delivered once when the server wrote its reply while the page waited, and this page writes nothing', async () => {
        const view = conversationWith([remind()]);
        generateConversationReply.mockImplementation(async (_directive, _settings, { commit }) => {
            commit.state = 'committed';
            return 'Time to water the plants.';
        });

        await expect(checkConversationReminders(NOW)).resolves.toBe(true);

        expect(postCharacterReply).not.toHaveBeenCalled();
        expect(world.spies.reloadConversationChat).toHaveBeenCalledTimes(1);
        expect(view.reminders[0].fired).toBe(true);
    });

    test('is delivered with no new request when the chat holds its reply: a page wrote it and closed before it marked the reminder', async () => {
        const reminder = remind({ attempts: 1, lastAttemptAt: NOW - 2 * MINUTE, retryAfter: NOW - MINUTE });
        const view = conversationWith([reminder]);
        world.say(view, { id: 'bubble', role: 'character', extra: { reply_token: getReminderToken(reminder) } });

        await expect(checkConversationReminders(NOW)).resolves.toBe(true);

        expect(generateConversationReply).not.toHaveBeenCalled();
        expect(view.reminders[0].fired).toBe(true);
    });

    test('is not sent a second time when its reply was landed from the server and the reminder was marked by the page that landed it', async () => {
        const view = conversationWith([remind({ fired: true, firedAt: NOW - 1000, attempts: 1 })]);

        await tick();

        expect(generateConversationReply).not.toHaveBeenCalled();
        expect(view.reminders[0].attempts).toBe(1);
    });

    test('is not sent when the reply of an earlier attempt lands between the check and the post', async () => {
        const reminder = remind();
        const view = conversationWith([reminder]);
        generateConversationReply.mockImplementation(async () => {
            world.say(view, { id: 'landed', role: 'character', extra: { reply_token: getReminderToken(reminder) } });
            return 'Time to water the plants.';
        });

        await expect(checkConversationReminders(NOW)).resolves.toBe(true);

        expect(postCharacterReply).not.toHaveBeenCalled();
        expect(view.reminders[0].fired).toBe(true);
    });
});

describe('the persona of the worker', () => {
    test('only the reminders of the conversations of the current persona are delivered', async () => {
        const view = conversationWith([remind()]);
        view.personaId = 'someone-else.png';

        await expect(checkConversationReminders(NOW)).resolves.toBe(false);

        expect(generateConversationReply).not.toHaveBeenCalled();
        expect(PERSONA).not.toBe(view.personaId);
    });
});
