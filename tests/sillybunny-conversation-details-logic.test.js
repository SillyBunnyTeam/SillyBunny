import { describe, expect, test } from '@jest/globals';

import {
    AVATAR_TILE_LIMIT,
    INLINE_MEMBER_LIMIT,
    describeSettingWrite,
    formatFileSize,
    formatWhen,
    getChatsSignature,
    getGeneralSignature,
    getMembersPage,
    getPageTitle,
    listReminders,
    listsMembersInline,
    pickTileAvatars,
    planMemberRemoval,
    routineToText,
    textToRoutine,
    collectSharedItems,
} from '../public/scripts/sillybunny-conversation/details/details-logic.js';

const group = (...characters) => ({ id: 'conv_1', kind: 'group', name: 'Weekend', description: '', avatar: '', characters, extras: [], settings: {}, chats: [] });
const direct = (avatar, extras = []) => ({ id: 'conv_2', kind: 'direct', name: '', description: '', avatar: '', characters: [avatar], extras, settings: {}, chats: [] });

describe('details window: who is listed where', () => {
    test('lists the members of a group of up to four inline on General, and sends a bigger group to the Members page', () => {
        expect(INLINE_MEMBER_LIMIT).toBe(4);
        expect(listsMembersInline(group('a.png', 'b.png'))).toBe(true);
        expect(listsMembersInline(group('a.png', 'b.png', 'c.png', 'd.png'))).toBe(true);
        expect(listsMembersInline(group('a.png', 'b.png', 'c.png', 'd.png', 'e.png'))).toBe(false);
    });

    test('never lists a direct conversation as members inline', () => {
        expect(listsMembersInline(direct('a.png', ['x.png']))).toBe(false);
    });

    test('has a Members page for a group, an Extras page for a direct conversation that has extras, and none otherwise', () => {
        expect(getMembersPage(group('a.png', 'b.png', 'c.png'))).toEqual({ title: 'Members', avatars: ['a.png', 'b.png', 'c.png'], kind: 'member' });
        expect(getMembersPage(direct('a.png', ['x.png']))).toEqual({ title: 'Extras', avatars: ['x.png'], kind: 'extra' });
        expect(getMembersPage(direct('a.png'))).toBeNull();
    });

    test('titles every page by its id and falls back to the id of a page it does not know', () => {
        expect(getPageTitle('general')).toBe('Details');
        expect(getPageTitle('add-member')).toBe('Add Member');
        expect(getPageTitle('behaviour')).toBe('Behaviour');
        expect(getPageTitle('no-such-page')).toBe('no-such-page');
    });
});

describe('details window: removing a member', () => {
    test('removes a member of a group of three or more at once', () => {
        expect(planMemberRemoval(group('a.png', 'b.png', 'c.png'), 'b.png')).toEqual({ action: 'remove', avatar: 'b.png' });
    });

    test('asks, and converts the group, when the second-to-last member goes', () => {
        expect(planMemberRemoval(group('a.png', 'b.png'), 'a.png')).toEqual({ action: 'convert', avatar: 'a.png', remaining: 'b.png' });
    });

    test('does nothing for a character that is not a member, and for a direct conversation', () => {
        expect(planMemberRemoval(group('a.png', 'b.png', 'c.png'), 'z.png')).toEqual({ action: 'none', avatar: 'z.png' });
        expect(planMemberRemoval(direct('a.png', ['x.png']), 'x.png')).toEqual({ action: 'none', avatar: 'x.png' });
    });
});

describe('details window: the tiled avatar of a group', () => {
    test('takes the first four distinct member pictures', () => {
        expect(AVATAR_TILE_LIMIT).toBe(4);
        expect(pickTileAvatars(['a.png', 'b.png', 'c.png', 'd.png', 'e.png'])).toEqual(['a.png', 'b.png', 'c.png', 'd.png']);
        expect(pickTileAvatars(['a.png', 'a.png', '', 'b.png'])).toEqual(['a.png', 'b.png']);
        expect(pickTileAvatars([])).toEqual([]);
    });
});

describe('details window: one setting per row', () => {
    test('clears a per-conversation key that is set back to its default, so that the conversation file keeps only what differs', () => {
        expect(describeSettingWrite('proactive_messaging', false)).toEqual({ scope: 'conversation', name: 'proactive_messaging', value: null });
        expect(describeSettingWrite('proactive_messaging', true)).toEqual({ scope: 'conversation', name: 'proactive_messaging', value: true });
        expect(describeSettingWrite('image_gen_prompt_template', 'a photo of {{char}}, {{scene}}')).toEqual({ scope: 'conversation', name: 'image_gen_prompt_template', value: null });
    });

    test('stores the system prompt under the name that the conversation file uses', () => {
        expect(describeSettingWrite('geechan_chatroom_prompt', 'Be brief.')).toEqual({ scope: 'conversation', name: 'system_prompt', value: 'Be brief.' });
    });

    test('keeps the mode-wide keys apart from the conversation', () => {
        expect(describeSettingWrite('simulate_reply_delay', false)).toEqual({ scope: 'mode', name: 'simulate_reply_delay', value: false });
        expect(describeSettingWrite('quiet_hours_start', '22:00')).toEqual({ scope: 'mode', name: 'quiet_hours_start', value: '22:00' });
    });

    test('keeps a number inside the range that its row offers', () => {
        expect(describeSettingWrite('inactivity_threshold', 5).value).toBe(15);
        expect(describeSettingWrite('inactivity_threshold', 9999).value).toBe(360);
        expect(describeSettingWrite('inactivity_threshold', 'soon').value).toBeNull();
        expect(describeSettingWrite('max_followups', 0).value).toBe(1);
        expect(describeSettingWrite('max_followups', 2).value).toBe(2);
        expect(describeSettingWrite('image_gen_cooldown', -4).value).toBe(0);
        expect(describeSettingWrite('image_gen_cooldown', 30).value).toBe(30);
    });

    test('refuses a key that is not a setting, and the two that the conversation file does not hold', () => {
        expect(() => describeSettingWrite('idle_followup', true)).toThrow(RangeError);
        expect(() => describeSettingWrite('availability', 'idle')).toThrow(RangeError);
        expect(() => describeSettingWrite('multi_char_names', 'x.png')).toThrow(RangeError);
    });
});

describe('details window: what a conversation shares', () => {
    const user = { id: 'm1', role: 'user', name: 'You', mes: 'look at this', created_at: 1000, extra: { media: [{ url: '/u/a.png', type: 'image', title: 'a.png' }] } };
    const selfie = { id: 'm2', role: 'character', name: 'Ada', mes: '', created_at: 2000, extra: { conversation_mode_image: true, image_url: '/u/selfie.png' } };
    const document_ = { id: 'm3', role: 'user', name: 'You', mes: '', created_at: 3000, extra: { files: [{ url: '/u/notes.txt', name: 'notes.txt', size: 1200 }] } };
    const clip = { id: 'm4', role: 'member', name: 'Grace', mes: '', created_at: 4000, extra: { member_avatar: 'grace.png', media: [{ url: '/u/c.mp4', type: 'video', title: 'c.mp4' }, { url: '/u/s.mp3', type: 'audio', title: 's.mp3' }] } };
    const pinned = { id: 'm5', role: 'member', name: 'Grace', mes: 'Noon on Saturday.', created_at: 5000, extra: { member_avatar: 'grace.png', conversation_pinned: true } };
    const pending = { id: 'm6', role: 'character', mes: 'raw', created_at: 6000, extra: { server_generation: { pending: true }, conversation_pinned: true } };
    const everything = [user, selfie, document_, clip, pinned, pending];

    test('collects pictures and videos as media, newest first, with their sender', () => {
        const { media } = collectSharedItems(everything);
        expect(media.map(item => [item.messageId, item.kind, item.url])).toEqual([
            ['m4', 'video', '/u/c.mp4'],
            ['m2', 'image', '/u/selfie.png'],
            ['m1', 'image', '/u/a.png'],
        ]);
        expect(media[0]).toMatchObject({ senderName: 'Grace', memberAvatar: 'grace.png', createdAt: 4000 });
    });

    test('collects documents and audio as files', () => {
        const { files } = collectSharedItems(everything);
        expect(files.map(item => [item.messageId, item.kind, item.name])).toEqual([
            ['m4', 'audio', 's.mp3'],
            ['m3', 'file', 'notes.txt'],
        ]);
        expect(files[1].size).toBe(1200);
    });

    test('collects pinned messages, and leaves a reply that the server wrote and the page has not split yet', () => {
        const { pinned: pins } = collectSharedItems(everything);
        expect(pins.map(item => item.messageId)).toEqual(['m5']);
        expect(pins[0]).toMatchObject({ text: 'Noon on Saturday.', senderName: 'Grace' });
    });

    test('gives an item a key that is the same on every read, so that a list can keep its rows', () => {
        const first = collectSharedItems(everything).media.map(item => item.key);
        const second = collectSharedItems([...everything].reverse()).media.map(item => item.key);
        expect(second).toEqual(first);
        expect(new Set(first).size).toBe(first.length);
    });

    test('reads nothing from a chat that is not loaded', () => {
        expect(collectSharedItems(undefined)).toEqual({ media: [], files: [], pinned: [] });
        expect(collectSharedItems([null, {}, { id: 'x' }])).toEqual({ media: [], files: [], pinned: [] });
    });

    test('writes a file size as a person reads it', () => {
        expect(formatFileSize(860)).toBe('860 B');
        expect(formatFileSize(1200)).toBe('1.2 KB');
        expect(formatFileSize(3.4 * 1024 * 1024)).toBe('3.4 MB');
        expect(formatFileSize(undefined)).toBe('');
        expect(formatFileSize(-1)).toBe('');
    });
});

describe('details window: reminders', () => {
    const base = { text: 'Call Ada', attempts: 0 };

    test('lists the reminders that wait, soonest first, and the ones that gave up, and leaves the delivered ones', () => {
        const listed = listReminders([
            { ...base, id: 'rem_late', triggerAt: 9000, state: 'scheduled' },
            { ...base, id: 'rem_done', triggerAt: 1000, state: 'delivered' },
            { ...base, id: 'rem_soon', triggerAt: 2000, state: 'scheduled' },
            { ...base, id: 'rem_failed', triggerAt: 3000, state: 'given-up' },
            { ...base, id: 'rem_gone', triggerAt: 4000, state: 'invalid' },
        ]);
        expect(listed.map(item => [item.id, item.state])).toEqual([
            ['rem_soon', 'scheduled'],
            ['rem_failed', 'given-up'],
            ['rem_gone', 'invalid'],
            ['rem_late', 'scheduled'],
        ]);
    });

    test('gives a reminder without text a name so that its row and its Cancel button are named', () => {
        expect(listReminders([{ id: 'rem_a', triggerAt: 1, state: 'scheduled' }])[0].text).toBe('Reminder');
    });
});

describe('details window: dates', () => {
    const now = Date.UTC(2026, 10, 25, 15, 0, 0);
    const options = { locale: 'en-US', timeZone: 'UTC' };

    test('writes today and yesterday as words and an older day as a date', () => {
        expect(formatWhen(Date.UTC(2026, 10, 25, 9, 5), now, options)).toBe('Today, 9:05 AM');
        expect(formatWhen(Date.UTC(2026, 10, 24, 23, 30), now, options)).toBe('Yesterday, 11:30 PM');
        expect(formatWhen(Date.UTC(2026, 10, 3, 8, 0), now, options)).toBe('Nov 3');
        expect(formatWhen(Date.UTC(2025, 11, 30, 8, 0), now, options)).toBe('Dec 30, 2025');
    });

    test('writes nothing for a time that is missing', () => {
        expect(formatWhen(0, now, options)).toBe('');
        expect(formatWhen(undefined, now, options)).toBe('');
    });
});

describe('details window: the signature of General', () => {
    test('changes when the name, the description, the picture, the members or the chats change', () => {
        const before = getGeneralSignature({ ...group('a.png', 'b.png'), chats: [{ id: 'c1', name: 'One' }], settings: {} });
        expect(getGeneralSignature({ ...group('a.png', 'b.png'), name: 'Other', chats: [{ id: 'c1', name: 'One' }] })).not.toBe(before);
        expect(getGeneralSignature({ ...group('a.png', 'b.png'), description: 'Plans', chats: [{ id: 'c1', name: 'One' }] })).not.toBe(before);
        expect(getGeneralSignature({ ...group('a.png', 'b.png'), avatar: 'avatar.png', chats: [{ id: 'c1', name: 'One' }] })).not.toBe(before);
        expect(getGeneralSignature({ ...group('a.png', 'c.png'), chats: [{ id: 'c1', name: 'One' }] })).not.toBe(before);
        expect(getGeneralSignature({ ...group('a.png', 'b.png'), chats: [{ id: 'c1', name: 'One' }, { id: 'c2', name: 'Two' }] })).not.toBe(before);
        expect(getGeneralSignature({ ...group('a.png', 'b.png'), chats: [{ id: 'c1', name: 'One' }], settings: { notifications_muted: true } })).not.toBe(before);
    });

    test('stays the same while only a message arrives, so that an open page is not rebuilt under the user', () => {
        const chats = [{ id: 'c1', name: 'One', messageCount: 3, unread: 0, lastMessageAt: 10, preview: 'hi' }];
        const before = getGeneralSignature({ ...group('a.png', 'b.png'), chats });
        const after = getGeneralSignature({ ...group('a.png', 'b.png'), chats: [{ ...chats[0], messageCount: 4, unread: 1, lastMessageAt: 20, preview: 'hello' }], updatedAt: 99 });
        expect(after).toBe(before);
    });
});

describe('details window: the signature of Chats', () => {
    const chat = { id: 'c1', name: 'One', messageCount: 3, lastMessageAt: 10, preview: 'hi', unread: 0 };

    test('changes when a chat is renamed, grows, or becomes the open one', () => {
        const before = getChatsSignature({ activeChatId: 'c1', chats: [chat] });
        expect(getChatsSignature({ activeChatId: 'c1', chats: [{ ...chat, name: 'Renamed' }] })).not.toBe(before);
        expect(getChatsSignature({ activeChatId: 'c1', chats: [{ ...chat, messageCount: 4, lastMessageAt: 20, preview: 'hello' }] })).not.toBe(before);
        expect(getChatsSignature({ activeChatId: 'c2', chats: [chat] })).not.toBe(before);
    });

    test('stays the same for a read that changes nothing it shows', () => {
        expect(getChatsSignature({ activeChatId: 'c1', chats: [{ ...chat }], updatedAt: 5 })).toBe(getChatsSignature({ activeChatId: 'c1', chats: [chat] }));
    });
});

describe('details window: the routine as text', () => {
    const stored = JSON.stringify({
        days: {
            0: [{ time: '10:00-12:00', activity: 'sleeping in', status: 'offline' }],
            1: [{ time: '09:00-17:00', activity: 'working at the shop', status: 'dnd' }, { time: '17:00-19:00', activity: 'cooking', status: 'idle' }],
            2: [], 3: [], 4: [], 5: [], 6: [],
        },
    });

    test('shows each day that has blocks, one block to a line, with its status', () => {
        expect(routineToText(stored)).toBe([
            'Sunday',
            '10:00-12:00 sleeping in (offline)',
            '',
            'Monday',
            '09:00-17:00 working at the shop (dnd)',
            '17:00-19:00 cooking (idle)',
        ].join('\n'));
    });

    test('reads the text back into the stored form', () => {
        const parsed = JSON.parse(textToRoutine(routineToText(stored)));
        expect(parsed.days[0]).toEqual([{ time: '10:00-12:00', activity: 'sleeping in', status: 'offline' }]);
        expect(parsed.days[1]).toEqual([
            { time: '09:00-17:00', activity: 'working at the shop', status: 'dnd' },
            { time: '17:00-19:00', activity: 'cooking', status: 'idle' },
        ]);
        expect(parsed.days[6]).toEqual([]);
    });

    test('takes a short day name, any case, a block without a status, and a single-digit hour', () => {
        const parsed = JSON.parse(textToRoutine('sat\n9:30-11:00 jogging\n\nSUN\n12:00-13:00 lunch (idle)'));
        expect(parsed.days[6]).toEqual([{ time: '09:30-11:00', activity: 'jogging' }]);
        expect(parsed.days[0]).toEqual([{ time: '12:00-13:00', activity: 'lunch', status: 'idle' }]);
    });

    test('lets a block end at midnight', () => {
        expect(JSON.parse(textToRoutine('Friday\n22:00-24:00 gaming')).days[5]).toEqual([{ time: '22:00-24:00', activity: 'gaming' }]);
    });

    test('refuses text with a block that comes before any day, or a line that is no block', () => {
        expect(() => textToRoutine('09:00-10:00 early')).toThrow(/day/i);
        expect(() => textToRoutine('Monday\nwork all day')).toThrow(/line 2/i);
        expect(() => textToRoutine('Monday\n25:00-26:00 odd')).toThrow(/line 2/i);
    });

    test('refuses text that holds no block at all', () => {
        expect(() => textToRoutine('')).toThrow();
        expect(() => textToRoutine('Monday\n\nTuesday')).toThrow();
    });

    test('shows nothing for a routine that is missing or is not a schedule', () => {
        expect(routineToText('')).toBe('');
        expect(routineToText('not json')).toBe('');
        expect(routineToText(JSON.stringify({ days: 3 }))).toBe('');
    });
});
