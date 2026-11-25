import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';

import { createConversationData } from '../public/scripts/sillybunny-conversation/conversation-data.js';
import {
    claimReminderAttempt,
    getReminderState,
    getReminderToken,
    isReminderDue,
    markReminderDelivered,
    MAX_REMINDER_ATTEMPTS,
    settleFailedReminderAttempt,
} from '../public/scripts/sillybunny-conversation/reminders.js';
import { REMINDER_RETRY_DELAY_MS } from '../public/scripts/sillybunny-conversation/constants.js';
import { seedConversations, startConversationServer } from './util/conversation-data-fixture.js';
import { addCharacters } from './util/conversation-store-sandbox.js';

const { readConversation: readStoredConversation } = await import('../src/conversation-store.js');

const NOW = Date.UTC(2026, 5, 1, 12, 0, 0);
const reminder = (overrides = {}) => ({ id: 'rem_1_aaaaaa', avatar: 'Nova.png', chatId: 'main', text: 'water the plants', triggerAt: NOW - 1000, fired: false, ...overrides });

describe('the state of a reminder', () => {
    test('is scheduled until something ends it', () => {
        expect(getReminderState(reminder())).toBe('scheduled');
        expect(getReminderState(reminder({ fired: true, firedAt: NOW }))).toBe('delivered');
        expect(getReminderState(reminder({ invalidAt: NOW }))).toBe('invalid');
        expect(getReminderState(reminder({ skippedAt: NOW }))).toBe('given-up');
    });

    test('is due once its time has come and any retry wait is over', () => {
        expect(isReminderDue(reminder({ triggerAt: NOW + 1 }), NOW)).toBe(false);
        expect(isReminderDue(reminder({ triggerAt: NOW }), NOW)).toBe(true);
        expect(isReminderDue(reminder({ retryAfter: NOW + 1 }), NOW)).toBe(false);
        expect(isReminderDue(reminder({ retryAfter: NOW }), NOW)).toBe(true);
    });

    test('is never due again once it was delivered, is invalid, was given up, or used every attempt', () => {
        expect(isReminderDue(reminder({ fired: true }), NOW)).toBe(false);
        expect(isReminderDue(reminder({ invalidAt: 1 }), NOW)).toBe(false);
        expect(isReminderDue(reminder({ skippedAt: 1 }), NOW)).toBe(false);
        expect(isReminderDue(reminder({ attempts: MAX_REMINDER_ATTEMPTS }), NOW)).toBe(false);
    });
});

/** What `patchReminder()` does with a change: a field given as null is removed. */
function applied(reminder, change) {
    const next = { ...reminder, ...change };
    return Object.fromEntries(Object.entries(next).filter(([, value]) => value !== null));
}

describe('the attempts of a reminder', () => {
    test('are counted before the request starts, and the next one waits', () => {
        const claimed = applied(reminder(), claimReminderAttempt(reminder(), NOW));

        expect(claimed).toMatchObject({ attempts: 1, lastAttemptAt: NOW, retryAfter: NOW + REMINDER_RETRY_DELAY_MS });
        expect(isReminderDue(claimed, NOW + REMINDER_RETRY_DELAY_MS - 1)).toBe(false);
        expect(isReminderDue(claimed, NOW + REMINDER_RETRY_DELAY_MS)).toBe(true);
    });

    test('stop after a fixed number: the last failed one gives the reminder up', () => {
        let current = reminder();
        for (let attempt = 1; attempt <= MAX_REMINDER_ATTEMPTS; attempt++) {
            const at = NOW + attempt * 1_000_000;
            current = applied(current, claimReminderAttempt(current, at));
            current = applied(current, settleFailedReminderAttempt(current, at));
            expect(getReminderState(current)).toBe(attempt < MAX_REMINDER_ATTEMPTS ? 'scheduled' : 'given-up');
        }

        expect(current.attempts).toBe(MAX_REMINDER_ATTEMPTS);
        expect(isReminderDue(current, Number.MAX_SAFE_INTEGER)).toBe(false);
    });

    test('a failed attempt before the last one changes nothing: the wait that the claim set stays', () => {
        const claimed = applied(reminder(), claimReminderAttempt(reminder(), NOW));

        expect(settleFailedReminderAttempt(claimed, NOW)).toEqual({});
    });

    test('a delivered reminder keeps its count and loses the wait', () => {
        const claimed = applied(reminder(), claimReminderAttempt(reminder(), NOW));
        const delivered = applied(claimed, markReminderDelivered(NOW + 5));

        expect(delivered).toMatchObject({ fired: true, firedAt: NOW + 5, attempts: 1 });
        expect(delivered).not.toHaveProperty('retryAfter');
        expect(getReminderState(delivered)).toBe('delivered');
    });
});

describe('the token of a reminder', () => {
    test('is the same on every attempt and every page, and differs from one reminder to the next', () => {
        const first = getReminderToken(reminder());

        expect(first).toMatch(/^[0-9a-f]{16}$/);
        expect(getReminderToken(reminder({ attempts: 3, retryAfter: NOW }))).toBe(first);
        expect(getReminderToken(reminder({ id: 'rem_2_bbbbbb' }))).not.toBe(first);
    });
});

describe('the reminders of a conversation, in the data module', () => {
    let server;
    let data;

    beforeEach(async () => {
        server = await startConversationServer();
        addCharacters(server.user, ['Nova.png']);
    });

    afterEach(async () => {
        data?.destroy();
        await server.stop();
        jest.restoreAllMocks();
    });

    const DIRECT = {
        id: 'conv_1_direct01',
        characters: ['Nova.png'],
        chats: [{ id: 'main', name: 'Main', messages: ['hello', 'hi'] }],
        reminders: [
            { id: 'rem_2_bbbbbb', avatar: 'Nova.png', chatId: 'main', text: 'pack the bag', triggerAt: NOW + 2000, fired: false },
            { id: 'rem_1_aaaaaa', avatar: 'Nova.png', chatId: 'main', text: 'water the plants', triggerAt: NOW + 1000, fired: false },
            { id: 'rem_3_cccccc', avatar: 'Nova.png', chatId: 'main', text: 'old news', triggerAt: NOW - 1000, fired: true, firedAt: NOW - 900 },
            { id: 'rem_4_dddddd', avatar: 'Nova.png', chatId: 'main', text: 'never sent', triggerAt: NOW - 1000, fired: false, attempts: 5, skippedAt: NOW - 500 },
        ],
    };

    async function started() {
        seedConversations(server, [DIRECT]);
        data = createConversationData(server.adapter());
        await data.start();
        await data.whenReady();
        return data;
    }

    test('lists them with their state, by time', async () => {
        await started();

        const listed = data.reminders(DIRECT.id);

        expect(listed.map(item => [item.id, item.state])).toEqual([
            ['rem_3_cccccc', 'delivered'],
            ['rem_4_dddddd', 'given-up'],
            ['rem_1_aaaaaa', 'scheduled'],
            ['rem_2_bbbbbb', 'scheduled'],
        ]);
        expect(data.reminders(DIRECT.id, { state: 'scheduled' }).map(item => item.id)).toEqual(['rem_1_aaaaaa', 'rem_2_bbbbbb']);
        expect(data.reminders('conv_9_nothing')).toEqual([]);
    });

    test('hands out copies, so that a caller cannot change the stored reminder', async () => {
        await started();

        data.reminders(DIRECT.id)[0].text = 'changed';

        expect(data.get(DIRECT.id).reminders.find(item => item.id === 'rem_3_cccccc').text).toBe('old news');
    });

    test('cancels one, in the cache and on the server, and keeps the others', async () => {
        await started();

        expect(data.cancelReminder(DIRECT.id, 'rem_1_aaaaaa')).toBe(true);
        await data.flush();

        expect(data.get(DIRECT.id).reminders.map(item => item.id)).not.toContain('rem_1_aaaaaa');
        expect(readStoredConversation(server.user, DIRECT.id).reminders.map(item => item.id)).toEqual(['rem_2_bbbbbb', 'rem_3_cccccc', 'rem_4_dddddd']);
    });

    test('says so when the reminder or the conversation is not there', async () => {
        await started();

        expect(data.cancelReminder(DIRECT.id, 'rem_9_zzzzzz')).toBe(false);
        expect(data.cancelReminder('conv_9_nothing', 'rem_1_aaaaaa')).toBe(false);
    });

    test('changes one field set of a reminder and drops the fields that are given as null', async () => {
        await started();

        expect(data.patchReminder(DIRECT.id, 'rem_2_bbbbbb', { attempts: 2, retryAfter: NOW + 5 })).toBe(true);
        expect(data.patchReminder(DIRECT.id, 'rem_2_bbbbbb', { retryAfter: null, fired: true })).toBe(true);
        await data.flush();

        const stored = readStoredConversation(server.user, DIRECT.id).reminders.find(item => item.id === 'rem_2_bbbbbb');
        expect(stored).toMatchObject({ attempts: 2, fired: true });
        expect(stored).not.toHaveProperty('retryAfter');
        expect(data.patchReminder(DIRECT.id, 'rem_9_zzzzzz', { fired: true })).toBe(false);
    });
});
