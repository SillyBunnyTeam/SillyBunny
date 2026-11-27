/* global globalThis */
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';

const listeners = { visibility: [], active: [], missing: [], data: [] };
const state = { usage: true, active: [] };
let chatMessages = [{ id: 'u1', role: 'user', extra: {} }];
let loadedChat = true;
const data = {
    chat: jest.fn(() => (loadedChat ? { messages: chatMessages } : null)),
    get: jest.fn(() => ({ id: 'conv_2', kind: 'group', characters: ['Nova.png', 'Orion.png'], personaId: 'p.png' })),
    loadChat: jest.fn(async () => ({ messages: [{ id: 'u1', role: 'user', extra: {} }] })),
    refresh: jest.fn(async () => {}),
    reloadChat: jest.fn(async () => {}),
    subscribe: jest.fn((listener) => {
        listeners.data.push(listener);
        return () => {};
    }),
};
const queueForcedConversationReply = jest.fn(() => true);
const finalizePendingReplies = jest.fn(async () => []);
const acknowledgeGenerations = jest.fn();

await jest.unstable_mockModule('../public/scripts/resumable-generation.js', () => ({
    getActiveGenerationIds: () => state.active,
    onActiveGenerationsChange: (listener) => {
        listeners.active.push(listener);
        return () => {};
    },
    onServerOwnedReplyMissing: (listener) => {
        listeners.missing.push(listener);
        return () => {};
    },
    pageId: 'page-under-test',
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/send-queue.js', () => ({ queueForcedConversationReply }));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/constants.js', () => ({ SAFE_TOAST_OPTIONS: { escapeHtml: true } }));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/conversation-data-browser.js', () => ({ conversationData: data }));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/media.js', () => ({ getCharacterForAvatar: avatar => (avatar === 'Orion.png' ? { avatar } : null) }));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/reply-finalizer-browser.js', () => ({ acknowledgeGenerations, finalizePendingReplies, wasReplyLanded: () => false }));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/settings-store.js', () => ({ hasAnyConversationModeUsage: () => state.usage }));

const { event_types, eventSource } = await import('../public/scripts/events.js');
const { installReplyEvents, showLostReplyNotice, showFailedReplyNotice } = await import('../public/scripts/sillybunny-conversation/reply-events-browser.js');

class FakeEventSource {
    static instances = [];

    constructor(url) {
        this.url = url;
        this.closed = false;
        FakeEventSource.instances.push(this);
    }

    addEventListener(type, listener) {
        this.listener = listener;
    }

    close() {
        this.closed = true;
    }

    send(pending) {
        this.listener({ data: JSON.stringify({ pending }) });
    }
}

/** A DOM node that is just enough for the notice: text, attributes, children and a click. */
function fakeElement(tag) {
    return {
        tag,
        children: [],
        dataset: {},
        attributes: {},
        textContent: '',
        listeners: {},
        append(...nodes) {
            this.children.push(...nodes);
        },
        setAttribute(name, value) {
            this.attributes[name] = value;
        },
        addEventListener(type, listener) {
            this.listeners[type] = listener;
        },
    };
}

let toastr;
const originalEventSource = globalThis.EventSource;

beforeEach(() => {
    FakeEventSource.instances = [];
    globalThis.EventSource = FakeEventSource;
    globalThis.document = { visibilityState: 'visible', createElement: fakeElement, addEventListener: (type, listener) => listeners.visibility.push(listener) };
    toastr = { warning: jest.fn(), error: jest.fn(), clear: jest.fn() };
    globalThis.toastr = toastr;
    state.usage = true;
    state.active = [];
    loadedChat = true;
    chatMessages = [{ id: 'u1', role: 'user', extra: {} }];
    for (const mock of [queueForcedConversationReply, finalizePendingReplies, acknowledgeGenerations, data.reloadChat, data.refresh]) {
        mock.mockClear();
    }
});

afterEach(() => {
    globalThis.EventSource = originalEventSource;
    delete globalThis.document;
    delete globalThis.toastr;
});

describe('the event stream of this page', () => {
    test('is opened when the mode starts, for a user who has conversations, and is checked again when the page is hidden or a list changes', () => {
        installReplyEvents();
        installReplyEvents();

        expect(FakeEventSource.instances).toHaveLength(1);
        expect(FakeEventSource.instances[0].url).toBe('/api/resumable-generations/events?owner=conversations&page=page-under-test');

        globalThis.document.visibilityState = 'hidden';
        listeners.visibility.forEach(listener => listener());
        expect(FakeEventSource.instances[0].closed).toBe(true);

        globalThis.document.visibilityState = 'visible';
        listeners.data.forEach(listener => listener({ type: 'list' }));
        expect(FakeEventSource.instances.filter(source => !source.closed)).toHaveLength(1);

        globalThis.document.visibilityState = 'hidden';
        state.active = ['gen-1'];
        listeners.active.forEach(listener => listener());
        expect(FakeEventSource.instances.filter(source => !source.closed)).toHaveLength(1);
        expect(FakeEventSource.instances).toHaveLength(2);
    });

    test('re-syncs the stream when PERSONA_CHANGED flips whether the active persona has conversations', async () => {
        installReplyEvents();
        // Close any open stream by switching to a persona without usage.
        state.usage = false;
        await eventSource.emit(event_types.PERSONA_CHANGED);
        expect(FakeEventSource.instances.filter(source => !source.closed)).toHaveLength(0);

        // Switching to a persona with conversations opens the stream immediately.
        state.usage = true;
        await eventSource.emit(event_types.PERSONA_CHANGED);
        expect(FakeEventSource.instances.filter(source => !source.closed)).toHaveLength(1);
    });

    test('reloads and finalizes a loaded conversation chat when a server-owned reply goes missing, and refreshes when unloaded', async () => {
        installReplyEvents();
        expect(listeners.missing).toHaveLength(1);

        // Non-conversation (roleplay) plan is ignored.
        listeners.missing[0]({ chat: { avatar: 'roleplay.png' }, file: 'main' });
        await new Promise(resolve => setImmediate(resolve));
        expect(data.reloadChat).not.toHaveBeenCalled();
        expect(data.refresh).not.toHaveBeenCalled();

        // Loaded conversation chat reloads and finalizes.
        loadedChat = true;
        listeners.missing[0]({ chat: { conversation: 'conv_2' }, file: 'main' });
        await new Promise(resolve => setImmediate(resolve));
        expect(data.reloadChat).toHaveBeenCalledWith({ conversationId: 'conv_2', chatId: 'main' });
        expect(finalizePendingReplies).toHaveBeenCalledWith({ conversationId: 'conv_2', chatId: 'main' });
        expect(data.refresh).not.toHaveBeenCalled();

        // Unloaded conversation chat refreshes list summaries and unread badges.
        data.reloadChat.mockClear();
        finalizePendingReplies.mockClear();
        loadedChat = false;
        listeners.missing[0]({ chat: { conversation: 'conv_2' }, file: 'main' });
        await new Promise(resolve => setImmediate(resolve));
        expect(data.reloadChat).not.toHaveBeenCalled();
        expect(data.refresh).toHaveBeenCalledTimes(1);
    });
});

describe('a reply that the server wrote', () => {
    const committed = { id: 'gen-1', state: 'committed', kind: 'reply', reason: '', page: 'page-b', conversation: 'conv_2', chat: 'main' };
    /** A stream that is opened now: the page is hidden, which closes the one that an earlier test left, and shown again. */
    function freshStream() {
        installReplyEvents();
        globalThis.document.visibilityState = 'hidden';
        listeners.visibility.forEach(listener => listener());
        globalThis.document.visibilityState = 'visible';
        listeners.visibility.forEach(listener => listener());
        return FakeEventSource.instances.find(source => !source.closed);
    }

    test('is landed without reading the chat again when it is in the chat already, which a read that races a save would undo', async () => {
        const source = freshStream();
        chatMessages = [{ id: 'u1', role: 'user', extra: {} }, { id: 'p1', role: 'character', extra: { server_generation: { pending: true } } }];

        source.send([committed]);
        await new Promise(resolve => setImmediate(resolve));

        expect(data.reloadChat).not.toHaveBeenCalled();
        expect(finalizePendingReplies).toHaveBeenCalledWith({ conversationId: 'conv_2', chatId: 'main' });
        expect(acknowledgeGenerations).toHaveBeenCalledWith(['gen-1']);
    });

    test('is read for when it is not in the chat yet, and then landed', async () => {
        const source = freshStream();

        source.send([{ ...committed, id: 'gen-2' }]);
        await new Promise(resolve => setImmediate(resolve));

        expect(data.reloadChat).toHaveBeenCalledWith({ conversationId: 'conv_2', chatId: 'main' });
        expect(finalizePendingReplies).toHaveBeenCalledWith({ conversationId: 'conv_2', chatId: 'main' });
        expect(data.reloadChat.mock.invocationCallOrder[0]).toBeLessThan(finalizePendingReplies.mock.invocationCallOrder[0]);
    });
});

describe('the notice of a lost reply', () => {
    const item = { id: 'lost-1', conversation: 'conv_2', chat: 'main', member: 'Nova.png', round: ['Orion.png'] };

    test('has a short title and a placeholder for its text, marked as one', () => {
        showLostReplyNotice({ item, regenerate: null });

        const [content, title, options] = toastr.warning.mock.calls[0];
        expect(title).toBe('Reply lost');
        expect(content.children[0].textContent).toBe('TODO(copy)');
        expect(content.children[0].dataset.sbCopyPlaceholder).toBe('true');
        expect(content.children).toHaveLength(1);
        expect(options).toMatchObject({ escapeHtml: false, timeOut: 0, extendedTimeOut: 0, closeButton: true });
    });

    test('offers Regenerate as a link that does it once, and closes the notice', () => {
        const regenerate = jest.fn();
        toastr.warning.mockReturnValue({ id: 'the toast' });

        showLostReplyNotice({ item, regenerate });

        const [content] = toastr.warning.mock.calls[0];
        const [, link] = content.children;
        expect(link.textContent).toBe('Regenerate');
        const event = { stopPropagation: jest.fn(), preventDefault: jest.fn() };
        link.listeners.click(event);
        expect(regenerate).toHaveBeenCalledTimes(1);
        // toastr leaves a toast that holds the focused element, and the link that was just clicked has the focus.
        expect(toastr.clear).toHaveBeenCalledWith({ id: 'the toast' }, { force: true });
    });
});

describe('the notice of a failed reply', () => {
    test('has a short title, and a placeholder for its text', () => {
        showFailedReplyNotice({ id: 'gen-1', reason: 'status-500' });

        expect(toastr.error).toHaveBeenCalledWith('TODO(copy)', 'Reply failed', expect.objectContaining({ escapeHtml: true }));
    });
});

describe('Regenerate', () => {
    test('queues a forced reply for the conversation of the lost reply, anchored on its first member with a card', async () => {
        const { regenerateLostReply } = await import('../public/scripts/sillybunny-conversation/reply-events-browser.js');

        regenerateLostReply({ conversationId: 'conv_2', chatId: 'main' }, { remaining: ['Nova.png', 'Orion.png'], started: 9 });

        expect(queueForcedConversationReply).toHaveBeenCalledWith('Orion.png', { chatId: 'main', groupId: 'conv_2', personaId: 'p.png', round: { remaining: ['Nova.png', 'Orion.png'], started: 9 } });
    });

    test('does nothing for a conversation that is gone', async () => {
        data.get.mockReturnValueOnce(null);
        const { regenerateLostReply } = await import('../public/scripts/sillybunny-conversation/reply-events-browser.js');

        regenerateLostReply({ conversationId: 'conv_gone', chatId: 'main' }, null);

        expect(queueForcedConversationReply).not.toHaveBeenCalled();
    });
});

describe('the wiring of the mode', () => {
    test('installs the stream when the mode starts', () => {
        expect(readFileSync(new URL('../public/scripts/sillybunny-conversation/runtime.js', import.meta.url), 'utf8')).toContain('installReplyEvents();');
        expect(readFileSync(new URL('../public/scripts/sillybunny-conversation/init.js', import.meta.url), 'utf8')).toContain('installConversationReplyStream();');
    });

});
