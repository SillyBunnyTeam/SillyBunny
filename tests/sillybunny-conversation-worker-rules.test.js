import { describe, expect, test } from '@jest/globals';

import {
    MAX_AUTOMATIC_FOLLOWUPS,
    pickAutomaticSpeaker,
    planAutomaticMessage,
    readMessagingFirstSettings,
} from '../public/scripts/sillybunny-conversation/worker-rules.js';

const MINUTE = 60_000;
const NOW = Date.UTC(2026, 5, 1, 12, 0, 0);

/** A chat whose user went quiet `quietMinutes` ago and that has had `sentCount` automatic messages since. */
function chat(overrides = {}) {
    const { quietMinutes = 0, ...rest } = overrides;
    return {
        now: NOW,
        lastUserActivity: NOW - quietMinutes * MINUTE,
        lastAutoMessageAt: 0,
        sentCount: 0,
        maxFollowups: 3,
        patienceMinutes: 60,
        lastMessageRole: 'character',
        userStatus: 'online',
        speakerStatus: 'online',
        isGroup: false,
        ...rest,
    };
}

describe('planAutomaticMessage: the first message', () => {
    test('waits until the user has been quiet for the patience', () => {
        expect(planAutomaticMessage(chat({ quietMinutes: 59.9 }))).toBeNull();
        expect(planAutomaticMessage(chat({ quietMinutes: 60 }))).toEqual({ kind: 'check_in' });
    });

    test('waits three times as long when the speaker is busy', () => {
        expect(planAutomaticMessage(chat({ quietMinutes: 179, speakerStatus: 'dnd' }))).toBeNull();
        expect(planAutomaticMessage(chat({ quietMinutes: 180, speakerStatus: 'dnd' }))).toEqual({ kind: 'check_in' });
    });

    test('never starts while the speaker is offline', () => {
        expect(planAutomaticMessage(chat({ quietMinutes: 10_000, speakerStatus: 'offline' }))).toBeNull();
    });

    test('never starts while the user is Invisible or on Do Not Disturb', () => {
        expect(planAutomaticMessage(chat({ quietMinutes: 10_000, userStatus: 'offline' }))).toBeNull();
        expect(planAutomaticMessage(chat({ quietMinutes: 10_000, userStatus: 'dnd' }))).toBeNull();
    });

    test('answers at once a message of the user that nobody answered, whatever the patience', () => {
        expect(planAutomaticMessage(chat({ quietMinutes: 0, lastMessageRole: 'user' }))).toEqual({ kind: 'check_in' });
    });

    test('does not answer at once when the speaker is offline', () => {
        expect(planAutomaticMessage(chat({ lastMessageRole: 'user', speakerStatus: 'offline' }))).toBeNull();
    });
});

describe('planAutomaticMessage: the messages after the first', () => {
    test('measures the wait from the last automatic message and doubles it for each one sent', () => {
        const base = { quietMinutes: 10_000, sentCount: 1, lastMessageRole: 'character' };
        expect(planAutomaticMessage(chat({ ...base, lastAutoMessageAt: NOW - 119 * MINUTE }))).toBeNull();
        expect(planAutomaticMessage(chat({ ...base, lastAutoMessageAt: NOW - 120 * MINUTE }))).toEqual({ kind: 'check_in' });

        const third = { ...base, sentCount: 2 };
        expect(planAutomaticMessage(chat({ ...third, lastAutoMessageAt: NOW - 239 * MINUTE }))).toBeNull();
        expect(planAutomaticMessage(chat({ ...third, lastAutoMessageAt: NOW - 240 * MINUTE }))).toEqual({ kind: 'check_in' });
    });

    test('stops at the maximum of unanswered messages', () => {
        expect(planAutomaticMessage(chat({ quietMinutes: 100_000, sentCount: 3, maxFollowups: 3, lastAutoMessageAt: 1 }))).toBeNull();
        expect(planAutomaticMessage(chat({ quietMinutes: 100_000, sentCount: 1, maxFollowups: 1, lastAutoMessageAt: 1 }))).toBeNull();
    });

    test('the members of a group talk to each other once the first message to the user was sent', () => {
        const base = { quietMinutes: 10_000, isGroup: true, lastAutoMessageAt: NOW - 1000 * MINUTE };
        expect(planAutomaticMessage(chat({ ...base, sentCount: 0 }))).toEqual({ kind: 'check_in' });
        expect(planAutomaticMessage(chat({ ...base, sentCount: 1 }))).toEqual({ kind: 'member_talk' });
        expect(planAutomaticMessage(chat({ ...base, sentCount: 2 }))).toEqual({ kind: 'member_talk' });
    });

    test('a direct conversation keeps checking in with the user', () => {
        expect(planAutomaticMessage(chat({ quietMinutes: 10_000, sentCount: 2, lastAutoMessageAt: NOW - 1000 * MINUTE }))).toEqual({ kind: 'check_in' });
    });
});

describe('readMessagingFirstSettings', () => {
    test('is off unless the conversation switched it on', () => {
        expect(readMessagingFirstSettings({}).enabled).toBe(false);
        expect(readMessagingFirstSettings({ proactive_messaging: false }).enabled).toBe(false);
        expect(readMessagingFirstSettings({ proactive_messaging: 'yes' }).enabled).toBe(false);
        expect(readMessagingFirstSettings({ proactive_messaging: true }).enabled).toBe(true);
    });

    test('keeps the maximum of unanswered messages between one and the cap', () => {
        expect(readMessagingFirstSettings({ max_followups: 2 }).maxFollowups).toBe(2);
        expect(readMessagingFirstSettings({ max_followups: 0 }).maxFollowups).toBe(1);
        expect(readMessagingFirstSettings({ max_followups: 99 }).maxFollowups).toBe(MAX_AUTOMATIC_FOLLOWUPS);
        expect(readMessagingFirstSettings({ max_followups: 'many' }).maxFollowups).toBe(3);
    });
});

describe('pickAutomaticSpeaker', () => {
    const anchorAvatar = 'anchor.png';
    const member = (avatar, talkativeness = 0.5, status = 'online') => ({ avatar, talkativeness, status });
    const said = (avatar, role = 'member') => (role === 'character'
        ? { role, extra: {} }
        : { role, extra: { member_avatar: avatar } });

    test('in a direct conversation the character speaks, unless it is offline', () => {
        const messages = [{ role: 'user', extra: {} }];
        expect(pickAutomaticSpeaker({ members: [member(anchorAvatar)], messages, anchorAvatar, isGroup: false })?.avatar).toBe(anchorAvatar);
        expect(pickAutomaticSpeaker({ members: [member(anchorAvatar, 0.5, 'offline')], messages, anchorAvatar, isGroup: false })).toBeNull();
    });

    test('a direct conversation character at talkativeness 0 still speaks: the value only scales its patience there', () => {
        expect(pickAutomaticSpeaker({ members: [member(anchorAvatar, 0)], messages: [], anchorAvatar, isGroup: false })?.avatar).toBe(anchorAvatar);
    });

    test('in a group the member who spoke least recently speaks', () => {
        const members = [member(anchorAvatar), member('b.png'), member('c.png')];
        const messages = [said(anchorAvatar, 'character'), said('b.png'), said('c.png'), said('b.png')];
        expect(pickAutomaticSpeaker({ members, messages, anchorAvatar, isGroup: true })?.avatar).toBe(anchorAvatar);
    });

    test('a member who never spoke goes before one who did, and the list order breaks a tie', () => {
        const members = [member(anchorAvatar), member('b.png'), member('c.png')];
        const messages = [said(anchorAvatar, 'character')];
        expect(pickAutomaticSpeaker({ members, messages, anchorAvatar, isGroup: true })?.avatar).toBe('b.png');
    });

    test('a member at talkativeness 0 never starts talk, and neither does an offline one', () => {
        const members = [member(anchorAvatar, 0), member('b.png', 0.5, 'offline'), member('c.png', 0.1)];
        expect(pickAutomaticSpeaker({ members, messages: [], anchorAvatar, isGroup: true })?.avatar).toBe('c.png');
        expect(pickAutomaticSpeaker({ members: members.slice(0, 2), messages: [], anchorAvatar, isGroup: true })).toBeNull();
    });
});
