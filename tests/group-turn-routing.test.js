/* eslint-disable playwright/no-standalone-expect -- Jest test.each tables are not Playwright tests. */
import vm from 'node:vm';
import { describe, expect, test } from '@jest/globals';
import { createGroupTurnRouting } from '../public/scripts/group-turn-routing.js';
import { createGroupChatsRuntime } from './util/group-chats-sandbox.js';

const members = new Map([['alice.png', 0], ['bob.png', 1], ['carol.png', 2]]);
const resolveMember = avatar => members.get(avatar) ?? -1;

/**
 * An open group chat whose scope the test can change, with one routing owner that logs every event it receives.
 * `react` runs after each event is logged, as the owner's own handling would.
 */
function createRouting({ plan = () => ({ avatars: ['alice.png'], isCurrent: () => true }), react = () => {} } = {}) {
    const chat = [];
    let scope = { groupId: 'group-1', chatId: 'chat-1', strategy: 0, chat };
    const routing = createGroupTurnRouting({ getScope: () => scope });
    const context = {
        routing,
        chat,
        events: [],
        plans: [],
        setScope: changes => { scope = changes && { ...scope, ...changes }; },
        types: () => context.events.map(event => event.type),
    };
    context.owner = {
        ownerId: 'test-router',
        groupId: 'group-1',
        chatId: 'chat-1',
        plan: input => {
            context.plans.push(input);
            return plan(input);
        },
        onEvent: event => {
            context.events.push(event);
            react(event, context);
        },
    };
    context.lease = routing.api.acquire(context.owner);
    return context;
}

/**
 * Starts a turn, plans it and acknowledges the user message, as the host does before the first reply.
 */
function startPlannedTurn(routing) {
    const turn = routing.startTurn({ turnId: 1, text: 'Hello' });
    turn.plan(resolveMember);
    turn.acknowledge();
    return turn;
}

const twoSpeakers = () => ({ avatars: ['alice.png', 'bob.png'], isCurrent: () => true });

describe('group turn routing leases', () => {
    test('offers version 1 of the contract as one frozen object', () => {
        const { routing } = createRouting();

        expect(routing.api.version).toBe(1);
        expect(typeof routing.api.acquire).toBe('function');
        expect(Object.isFrozen(routing.api)).toBe(true);
    });

    test('grants a lease on the open group chat that is current straight away', () => {
        const { lease, events } = createRouting();

        expect(lease).not.toBeNull();
        expect(lease.isCurrent()).toBe(true);
        expect(Object.isFrozen(lease)).toBe(true);
        expect(events).toEqual([]);
    });

    test('refuses a lease on another group or chat, or while another owner holds one', () => {
        const { routing, lease, owner } = createRouting();

        expect(routing.api.acquire({ ...owner, ownerId: 'other-router' })).toBeNull();
        lease.release('Done.');
        expect(routing.api.acquire({ ...owner, groupId: 'group-2' })).toBeNull();
        expect(routing.api.acquire({ ...owner, chatId: 'chat-2' })).toBeNull();
        expect(routing.api.acquire({ ...owner, ownerId: 'other-router' })?.isCurrent()).toBe(true);
    });

    test('refuses a lease when no group chat is open', () => {
        const { routing, lease, owner, setScope } = createRouting();
        lease.release('Done.');
        setScope(null);

        expect(routing.api.acquire(owner)).toBeNull();
    });

    test('rejects a request without an owner, a planner or an event handler', () => {
        const { routing, owner } = createRouting();

        expect(() => routing.api.acquire()).toThrow(TypeError);
        expect(() => routing.api.acquire({ ...owner, ownerId: '' })).toThrow(TypeError);
        expect(() => routing.api.acquire({ ...owner, plan: null })).toThrow(TypeError);
        expect(() => routing.api.acquire({ ...owner, onEvent: 'log' })).toThrow(TypeError);
    });

    test('a released lease is no longer current and starts no turns', () => {
        const { routing, lease, events } = createRouting();

        lease.release('Turned off.');

        expect(lease.isCurrent()).toBe(false);
        expect(routing.startTurn({ turnId: 1, text: 'Hello' })).toBeNull();
        expect(events).toEqual([]);
    });

    test.each([
        ['the open chat changes', { chatId: 'chat-2' }],
        ['another group is opened', { groupId: 'group-2' }],
        ['the group chat is closed', null],
        ['the group reply strategy changes', { strategy: 1 }],
    ])('revokes the lease when %s', (_, changes) => {
        const { routing, lease, events, setScope } = createRouting();

        setScope(changes);
        expect(lease.isCurrent()).toBe(false);
        expect(events).toEqual([]);
        routing.refresh();
        routing.refresh();

        expect(events).toEqual([{ type: 'revoked', reason: expect.any(String) }]);
        expect(events[0].reason).not.toBe('');
        expect(routing.startTurn({ turnId: 1, text: 'Hello' })).toBeNull();
    });

    test('a new owner can take over once the old lease is out of scope', () => {
        const { routing, owner, types, setScope } = createRouting();

        setScope({ chatId: 'chat-2' });
        const next = routing.api.acquire({ ...owner, ownerId: 'other-router', chatId: 'chat-2' });

        expect(next?.isCurrent()).toBe(true);
        expect(types()).toEqual(['revoked']);
    });

    test('an old lease cannot cancel or release the turn of the owner after it', () => {
        const { routing, lease, owner } = createRouting({ plan: twoSpeakers });
        lease.release('Done.');
        const next = routing.api.acquire({ ...owner, ownerId: 'other-router' });
        const turn = startPlannedTurn(routing);

        lease.cancel('Not mine to cancel.');
        lease.release('Not mine to release.');

        expect(next.isCurrent()).toBe(true);
        expect(turn.startReply('alice.png')).toBe(true);
    });
});

describe('routed turns', () => {
    test('reports each step of a planned turn to the owner in order', () => {
        const { routing, events, plans, chat, types } = createRouting({
            plan: () => ({ avatars: ['bob.png', 'alice.png'], isCurrent: () => true }),
        });

        const turn = routing.startTurn({ turnId: 7, text: 'Hello everyone' });
        expect(types()).toEqual(['turn-started']);
        const { requestId } = events[0];
        expect(requestId).toBeDefined();
        expect(events[0].turnId).toBe(7);

        expect(turn.plan(resolveMember)).toEqual([1, 0]);
        expect(plans).toEqual([{ requestId, turnId: 7, groupId: 'group-1', chatId: 'chat-1', chat, text: 'Hello everyone', addressed: { avatar: '', wholeGroup: false } }]);
        expect(plans[0].chat).toBe(chat);

        turn.acknowledge();
        expect(turn.startReply('bob.png')).toBe(true);
        expect(turn.finishReply('bob.png', 'success')).toBe(true);
        expect(turn.startReply('alice.png')).toBe(true);
        expect(turn.finishReply('alice.png', 'success')).toBe(true);
        turn.finish('success');

        expect(events.slice(1)).toEqual([
            { type: 'acknowledged', requestId, turnId: 7 },
            { type: 'reply-started', requestId, turnId: 7, avatar: 'bob.png' },
            { type: 'reply-completed', requestId, turnId: 7, avatar: 'bob.png', status: 'success' },
            { type: 'reply-started', requestId, turnId: 7, avatar: 'alice.png' },
            { type: 'reply-completed', requestId, turnId: 7, avatar: 'alice.png', status: 'success' },
            { type: 'finished', requestId, turnId: 7, status: 'success', reason: '' },
        ]);
    });

    test('gives every turn its own request id', () => {
        const { routing, events } = createRouting();

        routing.startTurn({ turnId: 1, text: 'One' }).finish('success');
        routing.startTurn({ turnId: 2, text: 'Two' }).finish('success');

        const [first, , second] = events;
        expect(first.requestId).not.toBe(second.requestId);
    });

    test('an empty plan is a turn without replies', () => {
        const { routing, types } = createRouting({ plan: () => ({ avatars: [], isCurrent: () => true }) });

        const turn = routing.startTurn({ turnId: 1, text: 'Just thinking out loud.' });

        expect(turn.plan(resolveMember)).toEqual([]);
        turn.acknowledge();
        turn.finish('success');
        expect(types()).toEqual(['turn-started', 'acknowledged', 'finished']);
    });

    test.each([
        ['declines', () => null],
        ['throws', () => { throw new Error('Planner broke.'); }],
        ['returns no list', () => ({ avatars: 'alice.png' })],
        ['names a card outside the group', () => ({ avatars: ['dave.png'] })],
        ['names a card twice', () => ({ avatars: ['alice.png', 'alice.png'] })],
        ['names something that is not a card', () => ({ avatars: [0] })],
    ])('hands the message back to native routing when the owner %s', (_, plan) => {
        const { routing, events, types } = createRouting({ plan });

        const turn = routing.startTurn({ turnId: 1, text: 'Hello' });

        expect(turn.plan(resolveMember)).toBeNull();
        expect(types()).toEqual(['turn-started', 'finished']);
        expect(events[1]).toMatchObject({ status: 'declined', reason: expect.any(String) });
        turn.acknowledge();
        turn.finish('success');
        expect(types()).toEqual(['turn-started', 'finished']);
    });

    test('a turn cancelled before planning goes to native routing without asking for a plan', () => {
        const { routing, plans, events, types } = createRouting({
            react: (event, { lease }) => {
                if (event.type === 'turn-started') lease.cancel('Busy elsewhere.');
            },
        });

        const turn = routing.startTurn({ turnId: 1, text: 'Hello' });

        expect(turn.plan(resolveMember)).toBeNull();
        expect(plans).toEqual([]);
        expect(types()).toEqual(['turn-started', 'finished']);
        expect(events.at(-1)).toMatchObject({ status: 'cancelled', reason: 'Busy elsewhere.' });
    });

    test('cancelling stops the turn before the next reply', () => {
        const { routing, lease, events, types } = createRouting({ plan: twoSpeakers });
        const turn = startPlannedTurn(routing);
        turn.startReply('alice.png');
        turn.finishReply('alice.png', 'success');

        lease.cancel('Changed my mind.');

        expect(turn.startReply('bob.png')).toBe(false);
        expect(lease.isCurrent()).toBe(true);
        expect(types()).toEqual(['turn-started', 'acknowledged', 'reply-started', 'reply-completed', 'finished']);
        expect(events.at(-1)).toMatchObject({ status: 'cancelled', reason: 'Changed my mind.' });
    });

    test('a plan that goes stale stops the turn before the next reply', () => {
        let current = true;
        const { routing, events } = createRouting({
            plan: () => ({ avatars: ['alice.png', 'bob.png'], isCurrent: () => current }),
        });
        const turn = startPlannedTurn(routing);
        turn.startReply('alice.png');
        turn.finishReply('alice.png', 'success');

        current = false;

        expect(turn.startReply('bob.png')).toBe(false);
        expect(events.at(-1)).toMatchObject({ type: 'finished', status: 'cancelled', reason: expect.any(String) });
    });

    test('releasing the lease mid-turn stops the remaining replies but still reports the end', () => {
        const { routing, lease, events } = createRouting({ plan: twoSpeakers });
        const turn = startPlannedTurn(routing);

        lease.release('Automatic replies turned off.');

        expect(turn.startReply('alice.png')).toBe(false);
        expect(events.at(-1)).toMatchObject({ type: 'finished', status: 'cancelled', reason: 'Automatic replies turned off.' });
    });

    test('revoking the lease mid-turn stops the remaining replies', () => {
        const { routing, events, setScope, types } = createRouting({ plan: twoSpeakers });
        const turn = startPlannedTurn(routing);

        setScope({ strategy: 2 });
        routing.refresh();

        expect(turn.startReply('alice.png')).toBe(false);
        expect(types()).toEqual(['turn-started', 'acknowledged', 'revoked', 'finished']);
        expect(events.at(-1)).toMatchObject({ status: 'cancelled', reason: events[2].reason });
    });

    test('a reply that was not saved ends the turn', () => {
        const { routing, events, types } = createRouting({ plan: twoSpeakers });
        const turn = startPlannedTurn(routing);
        turn.startReply('alice.png');

        expect(turn.finishReply('alice.png', 'failed')).toBe(false);
        expect(turn.startReply('bob.png')).toBe(false);
        expect(types()).toEqual(['turn-started', 'acknowledged', 'reply-started', 'reply-completed', 'finished']);
        expect(events.at(-2)).toMatchObject({ avatar: 'alice.png', status: 'failed' });
        expect(events.at(-1)).toMatchObject({ status: 'failed', reason: expect.any(String) });
    });

    test('ending a turn mid-reply closes the reply first, and only once', () => {
        const { routing, events, types } = createRouting();
        const turn = startPlannedTurn(routing);
        turn.startReply('alice.png');

        turn.finish('cancelled', 'Stopped.');
        turn.finish('failed');

        expect(types()).toEqual(['turn-started', 'acknowledged', 'reply-started', 'reply-completed', 'finished']);
        expect(events.at(-2)).toMatchObject({ avatar: 'alice.png', status: 'cancelled' });
        expect(events.at(-1)).toMatchObject({ status: 'cancelled', reason: 'Stopped.' });
    });

    test('an owner that throws while handling events never breaks the turn', () => {
        const { routing } = createRouting({
            react: () => { throw new Error('Owner broke.'); },
        });

        const turn = routing.startTurn({ turnId: 1, text: 'Hello' });

        expect(turn.plan(resolveMember)).toEqual([0]);
        expect(() => {
            turn.acknowledge();
            turn.startReply('alice.png');
            turn.finishReply('alice.png', 'success');
            turn.finish('success');
        }).not.toThrow();
    });
});

/**
 * A group chat sandbox where a routing owner holds the lease. The owner's plan requests and events go into the
 * sandbox log next to the user message and each reply, so tests can check the order they happen in.
 */
function createRoutedGroupChat({ plan = () => ({ avatars: ['alice.png'], isCurrent: () => true }), react = () => {}, exclude } = {}) {
    const sandbox = createGroupChatsRuntime({ exclude });
    const { runtime, log } = sandbox;
    const context = { ...sandbox, events: [], plans: [] };
    context.api = vm.runInContext('groupTurnRoutingApi', runtime);
    context.lease = context.api.acquire({
        ownerId: 'test-router',
        groupId: 'group-1',
        chatId: 'chat-1',
        plan: input => {
            context.plans.push(input);
            log.push('plan');
            return plan(input);
        },
        onEvent: event => {
            context.events.push(event);
            log.push(event.avatar ? `${event.type} ${event.avatar}` : event.type);
            react(event, context);
        },
    });
    return context;
}

async function send(sandbox, text, params = {}) {
    sandbox.composer.value = text;
    return sandbox.runtime.generateGroupWrapper(false, 'normal', params);
}

describe('group sends with a routing owner', () => {
    test('the owner plans who answers an ordinary message, and each reply waits for the one before it', async () => {
        const sandbox = createRoutedGroupChat({ plan: () => ({ avatars: ['bob.png', 'alice.png'], isCurrent: () => true }) });

        await send(sandbox, 'Hello everyone, how is Alice?');

        expect(sandbox.log).toEqual([
            'turn-started',
            'user message: Hello everyone, how is Alice?',
            'plan',
            'acknowledged',
            'reply-started bob.png',
            'normal reply by bob.png',
            'reply-completed bob.png',
            'reply-started alice.png',
            'normal reply by alice.png',
            'reply-completed alice.png',
            'finished',
        ]);
        expect(sandbox.plans[0]).toMatchObject({ groupId: 'group-1', chatId: 'chat-1', text: 'Hello everyone, how is Alice?' });
        expect(sandbox.plans[0].chat).toBe(sandbox.runtime.chat);
        expect(sandbox.events.filter(event => event.status).map(event => event.status)).toEqual(['success', 'success', 'success']);
        expect(sandbox.events.every(event => event.turnId === vm.runInContext('group_generation_id', sandbox.runtime))).toBe(true);
    });

    test('the owner plans against a chat that already ends with the saved user message', async () => {
        const seen = [];
        const sandbox = createRoutedGroupChat({
            plan: ({ chat }) => {
                seen.push({ ...chat.at(-1) });
                return { avatars: ['bob.png'], isCurrent: () => true };
            },
        });
        let saves = 0;
        sandbox.runtime.saveChatConditional = async () => {
            saves++;
            return true;
        };

        await send(sandbox, 'Where did everyone go?');

        expect(seen).toEqual([{ name: 'User', mes: 'Where did everyone go?', is_user: true }]);
        expect(saves).toBe(1);
    });

    test.each([
        ['names a member', 'Alice, are you there?', { avatar: 'alice.png', wholeGroup: false }],
        ['addresses the whole group', 'Hello everyone.', { avatar: '', wholeGroup: true }],
        ['names a muted member only', 'Carol, are you there?', { avatar: '', wholeGroup: false }],
        ['addresses nobody', 'Nice weather.', { avatar: '', wholeGroup: false }],
    ])('the owner hears what native addressing found when a message %s, and its plan still answers', async (_, text, addressed) => {
        const sandbox = createRoutedGroupChat({ plan: () => ({ avatars: ['bob.png'], isCurrent: () => true }) });

        await send(sandbox, text);

        expect(sandbox.plans[0].addressed).toEqual(addressed);
        expect(sandbox.generations).toEqual([{ type: 'normal', avatar: 'bob.png' }]);
    });

    test('routed replies run without auto-continue or auto-swipe, which could add or redo a reply', async () => {
        const routed = createRoutedGroupChat();
        const native = createGroupChatsRuntime();

        await send(routed, 'Hello');
        await send(native, 'Hello');

        expect(routed.generationOptions[0]).toMatchObject({ suppressAutoContinue: true, suppressAutoSwipe: true });
        expect(native.generationOptions[0].suppressAutoContinue).toBeFalsy();
        expect(native.generationOptions[0].suppressAutoSwipe).toBeFalsy();
    });

    test('native routing answers when the owner declines', async () => {
        const sandbox = createRoutedGroupChat({ plan: () => null });

        await send(sandbox, 'Alice, are you there?');

        expect(sandbox.generations).toEqual([{ type: 'normal', avatar: 'alice.png' }]);
        expect(sandbox.events.map(event => event.type)).toEqual(['turn-started', 'finished']);
        expect(sandbox.events[1]).toMatchObject({ status: 'declined' });
    });

    test('native routing answers when the owner plans a muted member', async () => {
        const sandbox = createRoutedGroupChat({ plan: () => ({ avatars: ['carol.png'], isCurrent: () => true }) });

        await send(sandbox, 'Alice, are you there?');

        expect(sandbox.generations).toEqual([{ type: 'normal', avatar: 'alice.png' }]);
        expect(sandbox.events.at(-1)).toMatchObject({ type: 'finished', status: 'declined' });
    });

    test('an empty plan saves the message without a reply', async () => {
        const sandbox = createRoutedGroupChat({ plan: () => ({ avatars: [], isCurrent: () => true }) });

        await send(sandbox, 'Just thinking out loud.');

        expect(sandbox.generations).toEqual([]);
        expect(sandbox.runtime.chat.at(-1)).toMatchObject({ is_user: true, mes: 'Just thinking out loud.' });
        expect(sandbox.events.map(event => event.type)).toEqual(['turn-started', 'acknowledged', 'finished']);
        expect(sandbox.events.at(-1).status).toBe('success');
    });

    test('the speaker bar pick answers instead of the plan, and the owner is not asked', async () => {
        const sandbox = createRoutedGroupChat();
        sandbox.runtime.setSelectedGroupSpeakerAvatar('bob.png');

        await send(sandbox, 'Hello');

        expect(sandbox.generations).toEqual([{ type: 'normal', avatar: 'bob.png' }]);
        expect(sandbox.events).toEqual([]);
        expect(sandbox.runtime.getSelectedGroupSpeakerAvatar()).toBe('');
        expect(sandbox.lease.isCurrent()).toBe(true);
    });

    test.each([
        ['a forced speaker', sandbox => sandbox.runtime.generateGroupWrapper(false, 'normal', { force_chid: 1 })],
        ['forced speakers', sandbox => sandbox.runtime.generateGroupWrapper(false, 'normal', { force_chids: [1, 0] })],
        ['a swipe', sandbox => sandbox.runtime.generateGroupWrapper(false, 'swipe', {})],
        ['Continue', sandbox => sandbox.runtime.generateGroupWrapper(false, 'continue', {})],
        ['a regenerate generation', sandbox => sandbox.runtime.generateGroupWrapper(false, 'regenerate', {})],
        ['Regenerate with a draft in the composer', sandbox => sandbox.runtime.regenerateGroup()],
        ['a quiet generation', sandbox => sandbox.runtime.generateGroupWrapper(false, 'quiet', { quiet_prompt: 'Summarize.' })],
        ['Impersonate', sandbox => sandbox.runtime.generateGroupWrapper(false, 'impersonate', {})],
        ['auto mode', sandbox => sandbox.runtime.generateGroupWrapper(true, 'normal', {})],
    ])('%s never starts a routed turn', async (_, generate) => {
        const sandbox = createRoutedGroupChat();
        sandbox.composer.value = 'Hello';
        vm.runInContext('Math.random = () => 0;', sandbox.runtime);

        await generate(sandbox);

        expect(sandbox.events).toEqual([]);
        expect(sandbox.plans).toEqual([]);
    });

    test('an empty send never starts a routed turn', async () => {
        const sandbox = createRoutedGroupChat();

        await send(sandbox, '');

        expect(sandbox.events).toEqual([]);
    });

    test('with tool calling on, native routing answers and the owner hears why', async () => {
        const sandbox = createRoutedGroupChat({ plan: () => ({ avatars: ['bob.png'], isCurrent: () => true }) });
        sandbox.runtime.ToolManager.canPerformToolCalls = () => true;

        await send(sandbox, 'Alice, are you there?');

        expect(sandbox.generations).toEqual([{ type: 'normal', avatar: 'alice.png' }]);
        expect(sandbox.events.map(event => event.type)).toEqual(['turn-started', 'finished']);
        expect(sandbox.events[1]).toMatchObject({ status: 'declined', reason: expect.stringMatching(/tool/i) });
    });

    test.each([
        ['a planned member\'s model can call tools though the chat model cannot', 'plain-model', { 'bob.png': 'tool-model' }, 'declined',
            [{ type: 'normal', avatar: 'alice.png' }]],
        ['no planned member\'s model can call tools though the chat model can', 'tool-model', { 'alice.png': 'plain-model', 'bob.png': 'plain-model' }, 'success',
            [{ type: 'normal', avatar: 'bob.png' }, { type: 'normal', avatar: 'alice.png' }]],
    ])('tool calling is checked under each planned member\'s model override: %s', async (_, chatModel, memberModels, status, generations) => {
        const sandbox = createRoutedGroupChat({ plan: () => ({ avatars: ['bob.png', 'alice.png'], isCurrent: () => true }) });
        const { runtime } = sandbox;
        Object.assign(runtime, { oai_settings: { model: chatModel }, getCurrentChatCompletionModelSettingKey: () => 'model' });
        runtime.groups[0].member_models = memberModels;
        runtime.ToolManager.canPerformToolCalls = () => runtime.oai_settings.model === 'tool-model';

        await send(sandbox, 'Alice, are you there?');

        expect(sandbox.events.at(-1)).toMatchObject({ type: 'finished', status });
        expect(sandbox.generations).toEqual(generations);
        expect(runtime.oai_settings.model).toBe(chatModel);
    });

    test('a routed turn whose message was not saved writes no replies', async () => {
        const sandbox = createRoutedGroupChat();
        sandbox.runtime.saveChatConditional = async () => false;

        await send(sandbox, 'Hello');

        expect(sandbox.generations).toEqual([]);
        expect(sandbox.runtime.chat.at(-1)).toMatchObject({ is_user: true, mes: 'Hello' });
        expect(sandbox.events.map(event => event.type)).toEqual(['turn-started', 'finished']);
        expect(sandbox.events[1]).toMatchObject({ status: 'failed', reason: expect.stringMatching(/not saved/i) });
    });

    test('Stop ends the routed turn with the reply it interrupted', async () => {
        const sandbox = createRoutedGroupChat({ plan: () => ({ avatars: ['alice.png', 'bob.png'], isCurrent: () => true }) });
        const controller = new AbortController();
        const generate = sandbox.runtime.Generate;
        sandbox.runtime.Generate = async (...args) => {
            await generate(...args);
            controller.abort();
        };

        await send(sandbox, 'Hello', { signal: controller.signal });

        expect(sandbox.generations).toEqual([{ type: 'normal', avatar: 'alice.png' }]);
        expect(sandbox.events.slice(-2)).toMatchObject([
            { type: 'reply-completed', avatar: 'alice.png', status: 'cancelled' },
            { type: 'finished', status: 'cancelled' },
        ]);
    });

    test('a reply that was not saved ends the routed turn', async () => {
        const sandbox = createRoutedGroupChat({ plan: () => ({ avatars: ['alice.png', 'bob.png'], isCurrent: () => true }) });
        sandbox.runtime.Generate = async () => {};

        await send(sandbox, 'Hello');

        expect(sandbox.events.slice(-2)).toMatchObject([
            { type: 'reply-completed', avatar: 'alice.png', status: 'failed' },
            { type: 'finished', status: 'failed' },
        ]);
        expect(sandbox.log).not.toContain('reply-started bob.png');
    });

    test('a reply that throws still ends the routed turn', async () => {
        const sandbox = createRoutedGroupChat();
        sandbox.runtime.Generate = async () => { throw new Error('Backend went away.'); };

        await expect(send(sandbox, 'Hello')).rejects.toThrow('Backend went away.');

        expect(sandbox.events.slice(-2)).toMatchObject([
            { type: 'reply-completed', avatar: 'alice.png', status: 'failed' },
            { type: 'finished', status: 'failed' },
        ]);
    });

    test('a turn whose cards fail to load still ends', async () => {
        const sandbox = createRoutedGroupChat();
        sandbox.runtime.unshallowCharacter = async () => { throw new Error('Card file is missing.'); };

        await expect(send(sandbox, 'Hello')).rejects.toThrow('Card file is missing.');

        expect(sandbox.plans).toEqual([]);
        expect(sandbox.events.map(event => event.type)).toEqual(['turn-started', 'finished']);
        expect(sandbox.events[1]).toMatchObject({ status: 'failed' });
    });

    test('the owner can cancel the replies still to come', async () => {
        const sandbox = createRoutedGroupChat({
            plan: () => ({ avatars: ['alice.png', 'bob.png'], isCurrent: () => true }),
            react: (event, { lease }) => {
                if (event.type === 'reply-completed') lease.cancel('That will do.');
            },
        });

        await send(sandbox, 'Hello');

        expect(sandbox.generations).toEqual([{ type: 'normal', avatar: 'alice.png' }]);
        expect(sandbox.events.at(-1)).toMatchObject({ type: 'finished', status: 'cancelled', reason: 'That will do.' });
    });

    test('changing the group reply strategy ends the lease', async () => {
        const sandbox = createRoutedGroupChat({ exclude: ['editGroup'] });
        sandbox.runtime.editGroup = async () => {};
        vm.runInContext('openGroupId = "group-1";', sandbox.runtime);

        await sandbox.runtime.onGroupActivationStrategyInput({ target: { value: '1' } });

        expect(sandbox.lease.isCurrent()).toBe(false);
        expect(sandbox.events).toEqual([{ type: 'revoked', reason: expect.any(String) }]);
    });
});

describe('swipes and Continue stay with the author', () => {
    for (const type of ['swipe', 'continue']) {
        test(`a ${type} of a message that names another member is still written by its author`, async () => {
            const sandbox = createGroupChatsRuntime();
            sandbox.runtime.chat.push({ name: 'Bob', original_avatar: 'bob.png', mes: 'Alice, what do you think?', is_user: false });

            await sandbox.runtime.generateGroupWrapper(false, type, {});

            expect(sandbox.generations).toEqual([{ type, avatar: 'bob.png' }]);
        });

        test(`a ${type} with everyone addressed in the composer is still written by the author alone`, async () => {
            const sandbox = createGroupChatsRuntime();
            sandbox.composer.value = 'Over to you, everyone.';

            await sandbox.runtime.generateGroupWrapper(false, type, {});

            expect(sandbox.generations).toEqual([{ type, avatar: 'bob.png' }]);
        });
    }
});
