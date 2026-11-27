/* global globalThis */
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';

import { waitForDelay } from '../public/scripts/sillybunny-conversation/reply-delay.js';

await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/context.js', () => ({
    getActiveConversationChat: jest.fn(),
    getConversationGroupIdForAvatar: () => '',
    getConversationPersonaId: () => 'persona-a.png',
    getConversationRecord: () => ({ activeChatId: 'main' }),
    getConversationKey: () => 'conv_1',
    getCurrentCharAvatar: () => 'char.png',
    parsePositiveInt: (value, fallback) => (Number.isFinite(Number(value)) ? Number(value) : fallback),
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/media.js', () => ({ getCharacterForAvatar: jest.fn() }));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/notifications.js', () => ({ isConversationActive: jest.fn(() => false) }));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/personas.js', () => ({ getAvailabilityCopy: () => ({ detail: 'Online.' }) }));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/render-scheduler.js', () => ({ scheduleInterfaceRefresh: jest.fn() }));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/schedule.js', () => ({
    getCharacterStatus: () => ({ status: 'online', activity: null, source: 'manual' }),
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/settings-store.js', () => ({
    getConversationSessionMarker: () => '',
    getLastUserActivity: () => 0,
    setConversationSessionMarker: jest.fn(),
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/state.js', () => ({ activeTypingParticipants: new Map() }));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/conversation-store.js', () => ({ appendConversationChatMessage: jest.fn() }));

const { waitForReplyDelay } = await import('../public/scripts/sillybunny-conversation/typing.js');

/** A document that tells its listeners when it becomes hidden. */
function createDocument(state = 'visible') {
    const target = new EventTarget();
    return Object.assign(target, {
        visibilityState: state,
        hide() {
            this.visibilityState = 'hidden';
            this.dispatchEvent(new Event('visibilitychange'));
        },
    });
}

beforeEach(() => {
    jest.useFakeTimers();
});

afterEach(() => {
    jest.useRealTimers();
    delete globalThis.document;
});

describe('the wait before a bubble of a reply', () => {
    test('lasts as long as the delay while the page is visible', async () => {
        const doc = createDocument();
        let done = false;
        const wait = waitForDelay(1000, { doc }).then(() => { done = true; });

        await jest.advanceTimersByTimeAsync(999);
        expect(done).toBe(false);
        await jest.advanceTimersByTimeAsync(1);
        await wait;

        expect(done).toBe(true);
    });

    test('ends at once when the page becomes hidden, so that the rest of the reply is written before the tab is gone', async () => {
        const doc = createDocument();
        let done = false;
        const wait = waitForDelay(9000, { doc }).then(() => { done = true; });
        await jest.advanceTimersByTimeAsync(100);

        doc.hide();
        await wait;

        expect(done).toBe(true);
    });

    test('does not wait at all when the page is hidden already', async () => {
        const doc = createDocument('hidden');

        await expect(waitForDelay(9000, { doc })).resolves.toBeUndefined();
    });

    test('lets go of the listener and the timer when it ends, either way', async () => {
        const doc = createDocument();
        const remove = jest.spyOn(doc, 'removeEventListener');
        const first = waitForDelay(10, { doc });
        await jest.advanceTimersByTimeAsync(10);
        await first;
        const second = waitForDelay(9000, { doc });
        doc.hide();
        await second;

        expect(remove).toHaveBeenCalledTimes(2);
        expect(jest.getTimerCount()).toBe(0);
    });

    test('is a plain timer where there is no document', async () => {
        const wait = waitForDelay(50, { doc: undefined });

        await jest.advanceTimersByTimeAsync(50);

        await expect(wait).resolves.toBeUndefined();
    });
});

describe('waitForReplyDelay()', () => {
    const settings = { reply_delay_multiplier: 100, availability: 'online' };

    test('waits for the delay of a reply, and not at all when the page is hidden', async () => {
        globalThis.document = createDocument();
        let done = false;
        const wait = waitForReplyDelay('hello there', settings, 'char.png').then(() => { done = true; });

        await jest.advanceTimersByTimeAsync(300);
        expect(done).toBe(false);
        globalThis.document.hide();
        await wait;

        expect(done).toBe(true);
        globalThis.document = createDocument('hidden');
        await expect(waitForReplyDelay('another one', settings, 'char.png')).resolves.toBeUndefined();
    });
});
