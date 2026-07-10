/* eslint-disable playwright/no-standalone-expect */
import { describe, expect, test } from '@jest/globals';

import {
    buildConversationGroupReferenceContext,
    buildConversationRoleplayContext,
    hasConversationMessageContent,
} from '../public/scripts/sillybunny-conversation/shared-helpers.js';

describe('conversation shared browser helpers', () => {
    test.each([
        { attachments: [{ url: 'legacy.png' }] },
        { media: [{ url: 'image.png' }] },
        { files: [{ url: 'notes.txt' }] },
        { image_url: 'generated.png' },
    ])('recognizes attachment-only messages in actual storage fields', (extra) => {
        expect(hasConversationMessageContent({ mes: '', extra })).toBe(true);
    });

    test.each(['', 'group-1'])('includes bounded attachment-only reply context for solo and group threads', (groupId) => {
        const context = buildConversationGroupReferenceContext([
            {
                id: 'attachment-message',
                role: 'character',
                name: 'Aster',
                mes: '',
                extra: { files: [{ url: 'notes.txt' }] },
            },
            {
                id: 'user-reply',
                role: 'user',
                name: 'User',
                mes: '',
                extra: {
                    media: [{ url: 'reply.png' }],
                    conversation_reply_to: {
                        messageId: 'attachment-message',
                        name: 'Aster',
                        attachmentSummary: `[Attachments: file: ${'x'.repeat(900)}]`,
                    },
                },
            },
        ], { groupId, speakerName: 'Aster' });

        expect(context).toContain('explicit reply to Aster');
        expect(context).toContain('Referenced message or attachment: [Attachments: file:');
        expect(context.length).toBeLessThan(1200);
    });

    test('uses the canonical 32-message transcript window for implicit group references', () => {
        const messages = [
            { role: 'user', mes: 'outside the window' },
            { role: 'character', name: 'Aster', mes: 'still in the canonical window' },
            ...Array.from({ length: 31 }, (_, index) => ({ role: 'user', mes: `user message ${index}` })),
        ];

        const context = buildConversationGroupReferenceContext(messages, { groupId: 'group-1', speakerName: 'Nova' });
        expect(context).toContain('most likely addresses Aster');
    });

    test('captures a bounded roleplay transcript at the originating message', () => {
        const messages = Array.from({ length: 9 }, (_, index) => ({
            name: index % 2 ? 'Aster' : 'User',
            mes: `message ${index}`,
        }));

        const context = buildConversationRoleplayContext(messages, 6);
        expect(context).toContain('message 1');
        expect(context).toContain('message 6');
        expect(context).not.toContain('message 0');
        expect(context).not.toContain('message 7');
    });
});
