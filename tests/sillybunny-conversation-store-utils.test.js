import { describe, expect, test } from '@jest/globals';

import {
    getConversationAttachmentSummary,
    getConversationMediaDisplay,
    getConversationMediaIndex,
    getConversationPromptMediaAttachments,
    normalizeConversationStoredMessage,
    resolveConversationReminderChatId,
    safeParseMessages,
} from '../public/scripts/sillybunny-conversation/conversation-store-utils.js';

describe('sillybunny conversation thread store utils', () => {
    test('normalizes legacy messages with deterministic ids', () => {
        expect(normalizeConversationStoredMessage({ role: 'user', mes: 'hello', created_at: 1234 }, 2, 9999)).toEqual({
            role: 'user',
            mes: 'hello',
            created_at: 1234,
            id: 'legacy-1234-2',
        });
    });

    test('safely parses and filters stored thread content', () => {
        const messages = safeParseMessages(JSON.stringify([
            { id: 'empty', role: 'user', mes: '' },
            { id: 'text', role: 'user', mes: 'hello' },
            { id: 'media', role: 'character', mes: '', extra: { media: [{ url: 'image.png', type: 'image' }] } },
        ]));

        expect(messages.map(message => message.id)).toEqual(['text', 'media']);
        expect(safeParseMessages('{not-json')).toEqual([]);
    });

    test('summarizes media, file, and generated image attachments', () => {
        const message = {
            id: 'message',
            mes: '',
            extra: {
                image_url: 'generated.png',
                media_display: 'gallery',
                media_index: 99,
                media: [
                    { url: 'image.png', type: 'image', title: 'Desk' },
                    { url: 'clip.mp4', type: 'video' },
                    { type: 'image', title: 'missing url' },
                ],
                files: [
                    { url: 'notes.pdf', name: 'Notes' },
                    { name: 'missing url' },
                ],
            },
        };

        expect(getConversationMediaDisplay(message)).toBe('gallery');
        expect(getConversationMediaIndex(message, [{}, {}])).toBe(1);
        expect(getConversationPromptMediaAttachments(message)).toEqual([
            { url: 'image.png', type: 'image', title: 'Desk' },
            { url: 'generated.png', type: 'image', title: 'Generated Image' },
        ]);
        expect(getConversationAttachmentSummary(message)).toBe('[Attachments: generated image; image: Desk; video; file: Notes]');
    });

    test('resolves only existing reminder chats', () => {
        const conversationRecord = {
            activeChatId: 'main',
            chats: [{ id: 'main' }],
        };
        expect(resolveConversationReminderChatId({ chatId: 'main' }, conversationRecord)).toBe('main');
        expect(resolveConversationReminderChatId({ chatId: 'deleted' }, conversationRecord)).toBe('');
        expect(resolveConversationReminderChatId({}, conversationRecord)).toBe('main');
        expect(resolveConversationReminderChatId({}, null)).toBe('');
    });
});
