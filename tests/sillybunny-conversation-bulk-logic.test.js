import { describe, expect, test } from '@jest/globals';

import {
    SHOW_MORE_BATCH,
    applyAttachmentRemoval,
    attachmentRemovalTitle,
    chatDeletionTitle,
    isMessageEmpty,
    nextShownCount,
    parseSharedItemKey,
    planAttachmentRemoval,
    planChatDeletion,
} from '../public/scripts/sillybunny-conversation/details/bulk-logic.js';
import { collectSharedItems } from '../public/scripts/sillybunny-conversation/details/details-logic.js';

const message = (id, mes, extra = {}) => ({ id, role: 'user', name: 'Ada', mes, created_at: 1000, extra });

describe('bulk actions: showing long lists in batches', () => {
    test('shows fifty items first and fifty more on each Show More, never more than there are', () => {
        expect(SHOW_MORE_BATCH).toBe(50);
        expect(nextShownCount(0, 120)).toBe(50);
        expect(nextShownCount(50, 120)).toBe(100);
        expect(nextShownCount(100, 120)).toBe(120);
        expect(nextShownCount(0, 12)).toBe(12);
        expect(nextShownCount(0, 0)).toBe(0);
    });
});

describe('bulk actions: the key of a shared item names the attachment of its message', () => {
    test('reads the three kinds of key that the Media and Files pages give their items', () => {
        expect(parseSharedItemKey('m1:image')).toEqual({ messageId: 'm1', part: 'image' });
        expect(parseSharedItemKey('m1:media:2')).toEqual({ messageId: 'm1', part: 'media', index: 2 });
        expect(parseSharedItemKey('m1:file:0')).toEqual({ messageId: 'm1', part: 'file', index: 0 });
    });

    test('keeps a message id that has colons in it', () => {
        expect(parseSharedItemKey('chat:7:media:1')).toEqual({ messageId: 'chat:7', part: 'media', index: 1 });
    });

    test('reads nothing from a key that is not an attachment key, which includes the key of a pin', () => {
        expect(parseSharedItemKey('m1:pin')).toBeNull();
        expect(parseSharedItemKey('m1:media:x')).toBeNull();
        expect(parseSharedItemKey('')).toBeNull();
        expect(parseSharedItemKey(undefined)).toBeNull();
    });

    test('agrees with the keys that collectSharedItems makes', () => {
        const messages = [message('m1', '', { image_url: '/gen.png', media: [{ url: '/a.png' }], files: [{ url: '/f.txt', name: 'f.txt' }] })];
        const shared = collectSharedItems(messages);
        for (const item of [...shared.media, ...shared.files]) {
            expect(parseSharedItemKey(item.key)?.messageId).toBe('m1');
        }
    });
});

describe('bulk actions: what a message is without text or attachments', () => {
    test('is empty with no text and no attachment, whitespace included', () => {
        expect(isMessageEmpty(message('m1', ''))).toBe(true);
        expect(isMessageEmpty(message('m1', '  \n '))).toBe(true);
        expect(isMessageEmpty(message('m1', '', { media: [], files: [], image_url: '' }))).toBe(true);
    });

    test('is not empty while it has text or any attachment', () => {
        expect(isMessageEmpty(message('m1', 'Hello'))).toBe(false);
        expect(isMessageEmpty(message('m1', '', { image_url: '/a.png' }))).toBe(false);
        expect(isMessageEmpty(message('m1', '', { media: [{ url: '/a.png' }] }))).toBe(false);
        expect(isMessageEmpty(message('m1', '', { files: [{ url: '/f.txt' }] }))).toBe(false);
        expect(isMessageEmpty(message('m1', '', { attachments: [{ url: '/f.txt' }] }))).toBe(false);
    });
});

describe('bulk actions: removing attachments from messages', () => {
    const chat = () => [
        message('m1', 'Look at these', { media: [{ url: '/a.png', type: 'image' }, { url: '/b.png', type: 'image' }, { url: '/c.mp4', type: 'video' }], files: [{ url: '/f.txt', name: 'f.txt' }], member_avatar: 'ada.png' }),
        message('m2', '', { image_url: '/gen.png', image_prompt: 'a cat' }),
        message('m3', '', { files: [{ url: '/x.pdf', name: 'x.pdf' }, { url: '/y.pdf', name: 'y.pdf' }] }),
        message('m4', 'No attachment here'),
    ];

    test('takes one item out of a message and keeps its text and its other keys', () => {
        const plan = planAttachmentRemoval(chat(), ['m1:media:1']);
        expect(plan.removed).toBe(1);
        expect(plan.emptied).toEqual([]);
        expect(plan.updates).toHaveLength(1);
        expect(plan.updates[0].messageId).toBe('m1');
        expect(plan.updates[0].extra.media.map(item => item.url)).toEqual(['/a.png', '/c.mp4']);
        expect(plan.updates[0].extra.files).toEqual([{ url: '/f.txt', name: 'f.txt' }]);
        expect(plan.updates[0].extra.member_avatar).toBe('ada.png');
    });

    test('counts every index against the list as it was, so that several items of one message go together', () => {
        const plan = planAttachmentRemoval(chat(), ['m1:media:0', 'm1:media:2']);
        expect(plan.removed).toBe(2);
        expect(plan.updates[0].extra.media.map(item => item.url)).toEqual(['/b.png']);
    });

    test('removes the generated picture together with its prompt', () => {
        const messages = chat();
        messages[1].mes = 'Selfie';
        const plan = planAttachmentRemoval(messages, ['m2:image']);
        expect(plan.updates).toHaveLength(1);
        expect(plan.updates[0].extra).not.toHaveProperty('image_url');
        expect(plan.updates[0].extra).not.toHaveProperty('image_prompt');
    });

    test('drops the list key of a message whose last item of that kind goes', () => {
        const plan = planAttachmentRemoval(chat(), ['m1:file:0']);
        expect(plan.updates[0].extra).not.toHaveProperty('files');
        expect(plan.updates[0].extra.media).toHaveLength(3);
    });

    test('leaves a message with no text and no attachment for the deletion path instead of updating it', () => {
        const plan = planAttachmentRemoval(chat(), ['m2:image', 'm3:file:0', 'm3:file:1']);
        expect(plan.removed).toBe(3);
        expect(plan.emptied).toEqual(['m2', 'm3']);
        expect(plan.updates).toEqual([]);
    });

    test('keeps a message that has text, however many attachments it loses', () => {
        const plan = planAttachmentRemoval(chat(), ['m1:media:0', 'm1:media:1', 'm1:media:2', 'm1:file:0']);
        expect(plan.emptied).toEqual([]);
        expect(plan.updates[0].extra).not.toHaveProperty('media');
        expect(plan.updates[0].extra).not.toHaveProperty('files');
    });

    test('keeps a message that has an attachment that was not chosen', () => {
        const plan = planAttachmentRemoval(chat(), ['m3:file:0']);
        expect(plan.emptied).toEqual([]);
        expect(plan.updates[0].extra.files).toEqual([{ url: '/y.pdf', name: 'y.pdf' }]);
    });

    test('ignores a key of a message that is gone, an index that is not there, a pin, and a key twice', () => {
        const plan = planAttachmentRemoval(chat(), ['nope:image', 'm1:media:9', 'm4:pin', 'm1:file:0', 'm1:file:0']);
        expect(plan.removed).toBe(1);
        expect(plan.updates.map(update => update.messageId)).toEqual(['m1']);
    });

    test('changes nothing in the messages it plans from', () => {
        const messages = chat();
        const before = JSON.stringify(messages);
        planAttachmentRemoval(messages, ['m1:media:0', 'm2:image']);
        expect(JSON.stringify(messages)).toBe(before);
    });

    test('writes the plan by replacing the extra of each message, and leaves the emptied ones to the deletion path', () => {
        const messages = chat();
        const emptiedBefore = messages[1];
        const plan = planAttachmentRemoval(messages, ['m1:media:0', 'm2:image']);
        const extraBefore = messages[0].extra;
        applyAttachmentRemoval(messages, plan);
        expect(messages[0].extra).not.toBe(extraBefore);
        expect(messages[0].extra.media).toHaveLength(2);
        expect(messages[1]).toBe(emptiedBefore);
        expect(messages[1].extra.image_url).toBe('/gen.png');
        expect(messages[3].extra).toEqual({});
    });

    test('plans what the Media page lists, by the keys that page gives', () => {
        const messages = chat();
        const { media } = collectSharedItems(messages);
        const picture = media.find(item => item.url === '/b.png');
        const plan = planAttachmentRemoval(messages, [picture.key]);
        expect(plan.updates[0].extra.media.map(item => item.url)).toEqual(['/a.png', '/c.mp4']);
    });
});

describe('bulk actions: deleting chats', () => {
    const chats = [{ id: 'c1' }, { id: 'c2' }, { id: 'c3' }, { id: 'c4' }];

    test('deletes the chosen chats in the order of the list and the open chat last', () => {
        const plan = planChatDeletion(chats, 'c2', ['c4', 'c2', 'c1']);
        expect(plan.order).toEqual(['c1', 'c4', 'c2']);
        expect(plan.deletesActive).toBe(true);
        expect(plan.leavesNone).toBe(false);
    });

    test('does not touch the open chat when it is not chosen', () => {
        const plan = planChatDeletion(chats, 'c4', ['c3', 'c1']);
        expect(plan.order).toEqual(['c1', 'c3']);
        expect(plan.deletesActive).toBe(false);
    });

    test('says that no chat is left when every chat is chosen, so that the server makes one empty chat', () => {
        const plan = planChatDeletion(chats, 'c1', ['c1', 'c2', 'c3', 'c4']);
        expect(plan.leavesNone).toBe(true);
        expect(plan.order.at(-1)).toBe('c1');
    });

    test('drops a chat that is not there and a chat that is chosen twice', () => {
        const plan = planChatDeletion(chats, 'c1', ['c3', 'c3', 'gone']);
        expect(plan.order).toEqual(['c3']);
    });

    test('titles the alert with how many chats go', () => {
        expect(chatDeletionTitle(1)).toBe('Delete 1 Chat?');
        expect(chatDeletionTitle(3)).toBe('Delete 3 Chats?');
    });
});

describe('bulk actions: titles of the alert that asks before items leave a chat', () => {
    test('names the items', () => {
        expect(attachmentRemovalTitle({ removed: 1, noun: 'file', emptied: 0 })).toBe('Remove 1 File From Chat?');
        expect(attachmentRemovalTitle({ removed: 3, noun: 'file', emptied: 0 })).toBe('Remove 3 Files From Chat?');
        expect(attachmentRemovalTitle({ removed: 2, noun: 'item', emptied: 0 })).toBe('Remove 2 Items From Chat?');
    });

    test('counts the messages that go with them', () => {
        expect(attachmentRemovalTitle({ removed: 3, noun: 'item', emptied: 1 })).toBe('Remove 3 Items and Delete 1 Message?');
        expect(attachmentRemovalTitle({ removed: 4, noun: 'file', emptied: 2 })).toBe('Remove 4 Files and Delete 2 Messages?');
        expect(attachmentRemovalTitle({ removed: 1, noun: 'item', emptied: 1 })).toBe('Remove 1 Item and Delete 1 Message?');
    });
});
