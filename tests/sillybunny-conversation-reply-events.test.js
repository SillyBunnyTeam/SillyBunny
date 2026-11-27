import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';

import { createReplyEvents } from '../public/scripts/sillybunny-conversation/reply-events.js';

const PAGE = 'page-a';
const CONVERSATION = 'conv_2_group001';
const ADDRESS = { conversationId: CONVERSATION, chatId: 'main' };

class FakeSource {
    static instances = [];

    constructor(url) {
        this.url = url;
        this.closed = false;
        this.listeners = new Map();
        FakeSource.instances.push(this);
    }

    addEventListener(type, listener) {
        this.listeners.set(type, listener);
    }

    close() {
        this.closed = true;
    }

    send(pending) {
        this.listeners.get('message')({ data: JSON.stringify({ pending }) });
    }
}

const open = () => FakeSource.instances.filter(source => !source.closed);

let state;
let page;
let chats;
let views;
let data;
let refresh;

function messagesOf(...items) {
    return items.map(([id, role, extra = {}]) => ({ id, role, mes: id, extra }));
}

function makeEvents(overrides = {}) {
    return createReplyEvents({
        data,
        pageId: PAGE,
        createSource: url => new FakeSource(url),
        getActiveGenerationIds: () => state.active,
        isVisible: () => state.visible,
        hasUsage: () => state.usage,
        page,
        now: () => 1_000_000,
        ...overrides,
    });
}

beforeEach(() => {
    jest.useFakeTimers();
    FakeSource.instances = [];
    state = { visible: true, usage: true, active: [] };
    chats = new Map([[`${CONVERSATION}/main`, { messages: messagesOf(['g1', 'character'], ['u1', 'user']) }]]);
    views = new Map([[CONVERSATION, { id: CONVERSATION, kind: 'group', characters: ['Nova.png', 'Orion.png'], personaId: 'p.png' }]]);
    refresh = jest.fn(async () => {});
    data = {
        chat: address => chats.get(`${address.conversationId}/${address.chatId}`) ?? null,
        get: id => views.get(id) ?? null,
        loadChat: jest.fn(async (address) => {
            chats.set(`${address.conversationId}/${address.chatId}`, { messages: messagesOf(['g1', 'character'], ['u1', 'user']) });
            return chats.get(`${address.conversationId}/${address.chatId}`);
        }),
        refresh,
    };
    page = {
        reloadChat: jest.fn(async () => {}),
        wasLanded: jest.fn(() => false),
        acknowledge: jest.fn(),
        showLost: jest.fn(),
        showFailed: jest.fn(),
        regenerate: jest.fn(),
    };
});

afterEach(() => {
    jest.useRealTimers();
});

describe('the event stream of the mode', () => {
    test('is one stream for every conversation of the user, with the id of this page', () => {
        makeEvents().sync();

        expect(open()).toHaveLength(1);
        expect(open()[0].url).toBe(`/api/resumable-generations/events?owner=conversations&page=${PAGE}`);
    });

    test('is not opened for a user who has never used the mode, so that roleplay-only users keep their connections', () => {
        state.usage = false;

        makeEvents().sync();

        expect(FakeSource.instances).toHaveLength(0);
    });

    test('is opened once however often the rules are checked, and closed when the page is hidden and reads no reply', () => {
        const events = makeEvents();
        events.sync();
        events.sync();
        expect(FakeSource.instances).toHaveLength(1);

        state.visible = false;
        events.sync();

        expect(open()).toHaveLength(0);
        state.visible = true;
        events.sync();
        expect(open()).toHaveLength(1);
    });

    test('stays open on a hidden page that reads a reply of its own, because the server must see that page follow the chat', () => {
        const events = makeEvents();
        events.sync();
        state.visible = false;
        state.active = ['gen-1'];

        events.sync();

        expect(open()).toHaveLength(1);
        state.active = [];
        events.sync();
        expect(open()).toHaveLength(0);
    });

    test('opens when the first conversation is made, because the rules are checked again after a change of the list', () => {
        state.usage = false;
        const events = makeEvents();
        events.sync();

        state.usage = true;
        events.sync();

        expect(open()).toHaveLength(1);
    });

    test('is closed by close(), and a message after that is not acted on', () => {
        const events = makeEvents();
        events.sync();
        const [source] = open();

        events.close();

        expect(source.closed).toBe(true);
        expect(open()).toHaveLength(0);
    });
});

describe('a reply that the server wrote', () => {
    const committed = (overrides = {}) => ({ id: 'gen-1', state: 'committed', kind: 'reply', reason: '', page: 'page-b', conversation: CONVERSATION, chat: 'main', ...overrides });
    const stream = () => {
        const events = makeEvents();
        events.sync();
        return open()[0];
    };

    test('is read again and landed when its chat is loaded in this page, and acknowledged', async () => {
        stream().send([committed()]);
        await jest.advanceTimersByTimeAsync(0);

        expect(page.reloadChat).toHaveBeenCalledWith(ADDRESS);
        expect(page.acknowledge).toHaveBeenCalledWith(['gen-1']);
    });

    test('is read again on the next message of the server when reading it failed, which is not marked as done', async () => {
        page.reloadChat.mockRejectedValueOnce(new Error('offline'));
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        const source = stream();

        source.send([committed()]);
        await jest.advanceTimersByTimeAsync(0);
        source.send([committed()]);
        await jest.advanceTimersByTimeAsync(0);

        expect(page.reloadChat).toHaveBeenCalledTimes(2);
        expect(page.acknowledge).toHaveBeenCalledTimes(1);
        warn.mockRestore();
    });

    test('is not read for twice when the server repeats it before the acknowledgement lands', async () => {
        const source = stream();
        source.send([committed()]);
        await jest.advanceTimersByTimeAsync(0);
        source.send([committed()]);
        await jest.advanceTimersByTimeAsync(0);

        expect(page.reloadChat).toHaveBeenCalledTimes(1);
    });

    test('is left to the finalizer when the chat is not loaded, and the list is read again once so that the badge and the preview change', async () => {
        chats.clear();
        const source = stream();

        source.send([committed()]);
        source.send([committed()]);
        await jest.advanceTimersByTimeAsync(600);

        expect(page.reloadChat).not.toHaveBeenCalled();
        expect(page.acknowledge).not.toHaveBeenCalled();
        expect(refresh).toHaveBeenCalledTimes(1);
    });

    test('is only acknowledged when this page landed it already', async () => {
        page.wasLanded.mockReturnValue(true);

        stream().send([committed()]);
        await jest.advanceTimersByTimeAsync(0);

        expect(page.reloadChat).not.toHaveBeenCalled();
        expect(page.acknowledge).toHaveBeenCalledWith(['gen-1']);
    });

    test('is not acted on for a generation that this page is reading itself', async () => {
        state.active = ['gen-1'];

        stream().send([committed({ page: PAGE })]);
        await jest.advanceTimersByTimeAsync(0);

        expect(page.reloadChat).not.toHaveBeenCalled();
        expect(page.acknowledge).not.toHaveBeenCalled();
    });

    test('is ignored while another page is still writing it: the typing of another page is not shown', async () => {
        stream().send([committed({ state: 'running' }), committed({ id: 'gen-2', state: 'waiting' }), committed({ id: 'gen-3', state: 'committing' })]);
        await jest.advanceTimersByTimeAsync(600);

        expect(page.reloadChat).not.toHaveBeenCalled();
        expect(page.showFailed).not.toHaveBeenCalled();
        expect(page.acknowledge).not.toHaveBeenCalled();
    });
});

describe('a reply that failed', () => {
    const failed = reason => ({ id: `gen-${reason}`, state: 'failed', kind: 'reply', reason, page: 'page-b', conversation: CONVERSATION, chat: 'main' });
    const stream = () => {
        makeEvents().sync();
        return open()[0];
    };

    test('is shown once when the model or the provider failed, whatever the status', async () => {
        const source = stream();

        source.send([failed('error-reply'), failed('empty-reply'), failed('status-429'), failed('no-reply'), failed('error')]);
        source.send([failed('error-reply')]);
        await jest.advanceTimersByTimeAsync(0);

        expect(page.showFailed).toHaveBeenCalledTimes(5);
        expect([...new Set(page.acknowledge.mock.calls.flatMap(([ids]) => ids))].sort()).toEqual(['gen-empty-reply', 'gen-error', 'gen-error-reply', 'gen-no-reply', 'gen-status-429']);
    });

    test('is silent when the queue would have dropped the reply, and acknowledged', async () => {
        const reasons = ['trigger-changed', 'target-changed', 'reply-landed', 'no-user-message', 'speaker-gone', 'missing', 'invalid-target'];

        stream().send(reasons.map(failed));
        await jest.advanceTimersByTimeAsync(0);

        expect(page.showFailed).not.toHaveBeenCalled();
        expect(page.acknowledge.mock.calls.flatMap(([ids]) => ids)).toHaveLength(reasons.length);
    });

    test('never shows a reason that the server worded itself, such as a conflict that names a path', async () => {
        stream().send([failed('conflict: /home/user/SillyBunny/data/default-user/conversations/x.jsonl changed'), failed('something new')]);
        await jest.advanceTimersByTimeAsync(0);

        expect(page.showFailed).not.toHaveBeenCalled();
        expect(page.acknowledge).toHaveBeenCalledTimes(1);
    });

    test('is only acknowledged when it is a reply of this page, which saved the reply itself after a late claim', async () => {
        stream().send([{ ...failed('error-reply'), page: PAGE }]);
        await jest.advanceTimersByTimeAsync(0);

        expect(page.showFailed).not.toHaveBeenCalled();
        expect(page.acknowledge).toHaveBeenCalledWith(['gen-error-reply']);
    });
});

describe('a reply that a restart lost', () => {
    const lost = (overrides = {}) => ({ id: 'lost-1', state: 'lost', kind: 'reply', reason: 'server-restart', conversation: CONVERSATION, chat: 'main', member: 'Nova.png', round: ['Orion.png'], triggers: ['u1'], token: 'aaaaaaaaaaaaaaaa', started: 1, ...overrides });
    const stream = () => {
        makeEvents().sync();
        return open()[0];
    };

    test('is shown once, with a way to regenerate it when the chat still ends in the message that it answered, and acknowledged', async () => {
        const source = stream();

        source.send([lost()]);
        source.send([lost()]);
        await jest.advanceTimersByTimeAsync(0);

        expect(page.showLost).toHaveBeenCalledTimes(1);
        const [{ item, regenerate }] = page.showLost.mock.calls[0];
        expect(item.id).toBe('lost-1');
        expect(typeof regenerate).toBe('function');
        expect(page.acknowledge).toHaveBeenCalledWith(['lost-1']);
    });

    test('regenerates as a forced reply of the lost member, with the members that were to follow it as the round, for a group', async () => {
        stream().send([lost()]);
        await jest.advanceTimersByTimeAsync(0);

        page.showLost.mock.calls[0][0].regenerate();

        expect(page.regenerate).toHaveBeenCalledWith(ADDRESS, { remaining: ['Nova.png', 'Orion.png'], started: 1_000_000 });
    });

    test('regenerates with no round for a direct conversation', async () => {
        views.set(CONVERSATION, { ...views.get(CONVERSATION), kind: 'direct', characters: ['Nova.png'] });
        stream().send([lost({ round: [] })]);
        await jest.advanceTimersByTimeAsync(0);

        page.showLost.mock.calls[0][0].regenerate();

        expect(page.regenerate).toHaveBeenCalledWith(ADDRESS, null);
    });

    test('has no way to regenerate when the reply landed after all, which a message with its token shows', async () => {
        chats.set(`${CONVERSATION}/main`, { messages: messagesOf(['u1', 'user'], ['b1', 'character', { reply_token: 'aaaaaaaaaaaaaaaa' }]) });

        stream().send([lost()]);
        await jest.advanceTimersByTimeAsync(0);

        expect(page.showLost.mock.calls[0][0].regenerate).toBeNull();
    });

    test('has no way to regenerate when the user wrote again, or when the message that it answered is gone', async () => {
        chats.set(`${CONVERSATION}/main`, { messages: messagesOf(['u1', 'user'], ['u2', 'user']) });
        const source = stream();

        source.send([lost()]);
        chats.set(`${CONVERSATION}/main`, { messages: messagesOf(['g1', 'character']) });
        source.send([lost({ id: 'lost-2' })]);
        await jest.advanceTimersByTimeAsync(0);

        expect(page.showLost.mock.calls.map(([call]) => call.regenerate)).toEqual([null, null]);
    });

    test('loads a chat that is not loaded to decide, and shows the notice without a way to regenerate when the chat cannot be read', async () => {
        chats.clear();
        stream().send([lost()]);
        await jest.advanceTimersByTimeAsync(0);
        expect(data.loadChat).toHaveBeenCalledWith(ADDRESS);
        expect(typeof page.showLost.mock.calls[0][0].regenerate).toBe('function');

        page.showLost.mockClear();
        data.loadChat.mockRejectedValue(new Error('gone'));
        chats.clear();
        stream().send([lost({ id: 'lost-2' })]);
        await jest.advanceTimersByTimeAsync(0);

        expect(page.showLost.mock.calls[0][0].regenerate).toBeNull();
    });
});
