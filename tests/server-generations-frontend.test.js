/* global globalThis */
import { beforeEach, describe, expect, jest, test } from '@jest/globals';
import { EventEmitter } from 'node:events';

const PAGE_ID = 'page-a';
const CHAT_CHANGED = 'chat_id_changed';

const scriptEvents = new EventEmitter();
const script = {
    chat: [],
    reloadCurrentChat: jest.fn(async () => scriptEvents.emit(CHAT_CHANGED)),
    isGenerating: jest.fn(() => false),
};
await jest.unstable_mockModule('../public/script.js', () => ({
    characters: [{ avatar: 'Seraphina.png', chat: 'Seraphina - chat' }],
    chat: script.chat,
    cleanUpMessage: ({ getMessage }) => getMessage,
    event_types: { CHAT_CHANGED, MESSAGE_RECEIVED: 'message_received', CHARACTER_MESSAGE_RENDERED: 'character_message_rendered' },
    eventSource: { on: (name, handler) => scriptEvents.on(name, handler), emit: jest.fn(async () => {}) },
    getCurrentChatId: () => 'Seraphina - chat',
    getGeneratingApi: () => 'openai',
    getGeneratingModel: () => 'gpt-test',
    getRequestHeaders: () => ({}),
    getThumbnailUrl: () => '',
    isGenerating: script.isGenerating,
    main_api: 'openai',
    name2: 'Seraphina',
    reloadCurrentChat: script.reloadCurrentChat,
    saveChatConditional: jest.fn(async () => true),
    swipe: jest.fn(),
    this_chid: 0,
    updateMessageBlock: jest.fn(async () => {}),
    updateMessageTokenAccounting: jest.fn(async () => ({})),
}));
await jest.unstable_mockModule('../public/scripts/group-chats.js', () => ({
    getGroupRoundRemaining: () => [],
    group_generation_id: null,
    resumeGroupRound: jest.fn(async () => {}),
    selected_group: null,
}));
await jest.unstable_mockModule('../public/scripts/i18n.js', () => ({
    t: (strings, ...values) => String.raw({ raw: strings }, ...values),
}));
await jest.unstable_mockModule('../public/scripts/openai.js', () => ({ getCurrentReasoningEffort: () => null }));
await jest.unstable_mockModule('../public/scripts/reasoning.js', () => ({
    parseAutoReasoningFromString: () => null,
    parseReasoningInSwipes: () => {},
}));

const resumable = {
    activeIds: [],
    /** @type {(() => void)|null} */
    onActiveChange: null,
    /** @type {((plan: any) => void)|null} */
    onMissing: null,
};
await jest.unstable_mockModule('../public/scripts/resumable-generation.js', () => ({
    getActiveGenerationIds: () => [...resumable.activeIds],
    onActiveGenerationsChange: (listener) => {
        resumable.onActiveChange = listener;
        return () => undefined;
    },
    onServerOwnedReplyMissing: (listener) => {
        resumable.onMissing = listener;
        return () => undefined;
    },
    pageId: PAGE_ID,
}));

class FakeEventSource {
    /** @type {FakeEventSource[]} */
    static instances = [];

    constructor(url) {
        this.url = url;
        this.closed = false;
        /** @type {Map<string, (event: any) => void>} */
        this.listeners = new Map();
        FakeEventSource.instances.push(this);
    }

    addEventListener(type, listener) {
        this.listeners.set(type, listener);
    }

    close() {
        this.closed = true;
    }

    /**
     * @param {any[]} pending Generations the server lists for the chat
     */
    push(pending) {
        this.listeners.get('message')?.({ data: JSON.stringify({ pending }) });
    }

    static get open() {
        return FakeEventSource.instances.filter(source => !source.closed);
    }
}

const documentEvents = new EventEmitter();
globalThis.document = {
    visibilityState: 'visible',
    addEventListener: (name, handler) => documentEvents.on(name, handler),
};
globalThis.EventSource = FakeEventSource;
const toast = { append: () => toast, text: () => toast, on: () => toast };
globalThis.$ = () => toast;
globalThis.toastr = { info: jest.fn(() => ({})), warning: jest.fn(() => ({})), error: jest.fn(() => ({})), clear: jest.fn() };
globalThis.fetch = jest.fn(async () => new Response(null, { status: 204 }));

const { initServerGenerations } = await import('../public/scripts/server-generations.js');
initServerGenerations();

/** Lets CHAT_CHANGED handling and reload chains settle. */
async function settle() {
    for (let i = 0; i < 5; i++) {
        await new Promise(resolve => setTimeout(resolve, 0));
    }
}

/**
 * @param {'visible'|'hidden'} state Page visibility
 */
function setVisibility(state) {
    globalThis.document.visibilityState = state;
    documentEvents.emit('visibilitychange');
}

/**
 * @returns {string[]} Ids the page acknowledged
 */
function acknowledged() {
    return globalThis.fetch.mock.calls
        .filter(([url]) => url === '/api/resumable-generations/acknowledge')
        .flatMap(([, init]) => JSON.parse(init.body).ids);
}

beforeEach(async () => {
    setVisibility('visible');
    resumable.activeIds = [];
    script.isGenerating.mockReturnValue(false);
    scriptEvents.emit(CHAT_CHANGED);
    await settle();
    FakeEventSource.instances.length = 0;
    // The open chat follows its events again from a clean slate for each test.
    scriptEvents.emit(CHAT_CHANGED);
    await settle();
    jest.clearAllMocks();
});

describe('server-generations event stream', () => {
    test('a hidden tab lets go of its event stream unless it is reading a reply of its own', () => {
        expect(FakeEventSource.open).toHaveLength(1);

        setVisibility('hidden');
        expect(FakeEventSource.open).toHaveLength(0);

        resumable.activeIds = ['a'.repeat(32)];
        resumable.onActiveChange();
        expect(FakeEventSource.open).toHaveLength(1);
        expect(FakeEventSource.open[0].url).toContain(`page=${PAGE_ID}`);

        resumable.activeIds = [];
        resumable.onActiveChange();
        expect(FakeEventSource.open).toHaveLength(0);

        setVisibility('visible');
        expect(FakeEventSource.open).toHaveLength(1);
    });

    test('reloads once for a reply another page already finished, then marks it seen', async () => {
        const id = 'b'.repeat(32);
        const pending = [{ id, state: 'committed', kind: 'append', page: 'page-b' }];
        FakeEventSource.open[0].push(pending);
        await settle();
        expect(script.reloadCurrentChat).toHaveBeenCalledTimes(1);

        // The reload found no mark for it and reconnected; the server still lists it.
        FakeEventSource.open[0].push(pending);
        await settle();
        expect(script.reloadCurrentChat).toHaveBeenCalledTimes(1);
        expect(acknowledged()).toEqual([id]);
    });

    test('reloads the chat this page reads its own reply from once the server kept that reply', async () => {
        const id = 'c'.repeat(32);
        FakeEventSource.open[0].push([{ id, state: 'committed', kind: 'append', page: PAGE_ID }]);
        await settle();
        expect(script.reloadCurrentChat).toHaveBeenCalledTimes(1);
    });

    test('waits for this page to stop reading its reply before acting on it', async () => {
        const id = 'd'.repeat(32);
        resumable.activeIds = [id];
        FakeEventSource.open[0].push([{ id, state: 'committed', kind: 'append', page: PAGE_ID }]);
        await settle();
        expect(script.reloadCurrentChat).not.toHaveBeenCalled();
    });

    test('reloads the chat when the server no longer has a reply this page was reading', async () => {
        resumable.onMissing({ chat: { avatar: 'Other.png' }, file: 'Other - chat' });
        await settle();
        expect(script.reloadCurrentChat).not.toHaveBeenCalled();

        jest.useFakeTimers();
        try {
            // The broken stream's generation is still unwinding when the server says the reply is gone.
            script.isGenerating.mockReturnValue(true);
            resumable.onMissing({ chat: { avatar: 'Seraphina.png' }, file: 'Seraphina - chat' });
            await jest.advanceTimersByTimeAsync(1000);
            expect(script.reloadCurrentChat).not.toHaveBeenCalled();

            script.isGenerating.mockReturnValue(false);
            await jest.advanceTimersByTimeAsync(1000);
            expect(script.reloadCurrentChat).toHaveBeenCalledTimes(1);
        } finally {
            jest.useRealTimers();
        }
    });

    test('tells about a lost reply of this page once it stops reading it, and acknowledges its own failed commits quietly', async () => {
        const lost = { id: 'e'.repeat(32), state: 'lost', kind: 'append', page: PAGE_ID, index: 2, anchor: null, started: '' };
        const failed = { id: 'f'.repeat(32), state: 'failed', kind: 'append', page: PAGE_ID, reason: 'chat-changed' };

        resumable.activeIds = [lost.id];
        FakeEventSource.open[0].push([lost, failed]);
        expect(globalThis.toastr.warning).not.toHaveBeenCalled();
        expect(acknowledged()).toEqual([failed.id]);

        resumable.activeIds = [];
        FakeEventSource.open[0].push([lost]);
        expect(globalThis.toastr.warning).toHaveBeenCalledTimes(1);
        expect(acknowledged()).toEqual([failed.id, lost.id]);
    });
});
