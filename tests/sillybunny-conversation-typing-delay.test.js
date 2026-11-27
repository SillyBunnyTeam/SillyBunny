import { beforeEach, describe, expect, jest, test } from '@jest/globals';

const cards = new Map();
const statuses = new Map();

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
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/personas.js', () => ({ getAvailabilityCopy: () => ({ detail: 'Available for live DM replies.' }) }));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/render-scheduler.js', () => ({ scheduleInterfaceRefresh: jest.fn() }));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/reply-delay.js', () => ({ waitForDelay: jest.fn(async () => {}) }));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/schedule.js', () => ({
    getCharacterStatus: avatar => statuses.get(avatar) ?? { status: 'online', activity: null, source: 'manual' },
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/settings-store.js', () => ({
    getConversationSessionMarker: () => '',
    getLastUserActivity: () => 0,
    setConversationSessionMarker: jest.fn(),
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/state.js', () => ({ activeTypingParticipants: new Map() }));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/conversation-store.js', () => ({ appendConversationChatMessage: jest.fn() }));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/talkativeness.js', () => ({
    getTalkativeness: avatar => cards.get(avatar) ?? 0.5,
}));

const { getConversationActivityContext, getReplyDelayMs, waitForReplyDelay } = await import('../public/scripts/sillybunny-conversation/typing.js');
const { waitForDelay } = await import('../public/scripts/sillybunny-conversation/reply-delay.js');

const HUNDRED = 'x'.repeat(100);

beforeEach(() => {
    cards.clear();
    statuses.clear();
    waitForDelay.mockClear();
});

describe('the simulated delay of a reply', () => {
    test('follows the talkativeness of the card of the speaker', () => {
        cards.set('quiet.png', 0);
        cards.set('plain.png', 0.5);
        cards.set('loud.png', 1);

        // online: 450 ms and 18 ms a character, times 1.15, 0.9 and 0.65
        expect(getReplyDelayMs(HUNDRED, {}, 'quiet.png')).toBe(2520);
        expect(getReplyDelayMs(HUNDRED, {}, 'plain.png')).toBe(2070);
        expect(getReplyDelayMs(HUNDRED, {}, 'loud.png')).toBe(1620);
    });

    test('is what it was before the card was read, for a card at the default value', () => {
        // 450 + 5 * 18 * (1.15 - 50 / 200) with the mode's own talkativeness of 50 and delay multiplier of 100
        expect(getReplyDelayMs('hello', {}, 'plain.png')).toBe(531);
    });

    test('is none when Simulate reply delay is off', () => {
        expect(getReplyDelayMs(HUNDRED, { simulate_reply_delay: false }, 'plain.png')).toBe(0);
    });

    test('is on when the setting is missing', () => {
        expect(getReplyDelayMs(HUNDRED, {}, 'plain.png')).toBeGreaterThan(0);
        expect(getReplyDelayMs(HUNDRED, { simulate_reply_delay: true }, 'plain.png')).toBeGreaterThan(0);
    });

    test('grows with the busy status of the character and stays between 350 ms and 9 seconds', () => {
        statuses.set('busy.png', { status: 'dnd', activity: null, source: 'manual' });

        expect(getReplyDelayMs('', {}, 'plain.png')).toBe(450);
        expect(getReplyDelayMs('hi', {}, 'busy.png')).toBe(Math.round(1600 + 2 * 52 * 0.9));
        expect(getReplyDelayMs('x'.repeat(5000), {}, 'plain.png')).toBe(9000);
    });

    test('is waited for by waitForReplyDelay(), and not at all when it is none', async () => {
        await waitForReplyDelay('hello', {}, 'plain.png');
        expect(waitForDelay).toHaveBeenCalledWith(531);

        waitForDelay.mockClear();
        await waitForReplyDelay('hello', { simulate_reply_delay: false }, 'plain.png');
        expect(waitForDelay).not.toHaveBeenCalled();
    });
});

describe('what a character is doing', () => {
    test('is worded from its status when the status carries no activity of its own', () => {
        expect(getConversationActivityContext({}, 'plain.png')).toEqual({ status: 'online', activity: 'available for live dm replies', source: 'manual' });
    });

    test('is the activity of the routine, or of what the character set for itself, as it is', () => {
        statuses.set('worker.png', { status: 'dnd', activity: 'working', source: 'schedule' });
        statuses.set('traveller.png', { status: 'idle', activity: 'commuting', source: 'override' });

        expect(getConversationActivityContext({}, 'worker.png')).toEqual({ status: 'dnd', activity: 'working', source: 'schedule' });
        expect(getConversationActivityContext({}, 'traveller.png')).toEqual({ status: 'idle', activity: 'commuting', source: 'override' });
    });
});
