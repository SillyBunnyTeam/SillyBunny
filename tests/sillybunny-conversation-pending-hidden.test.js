import { describe, expect, jest, test } from '@jest/globals';

import { pendingReply } from './util/conversation-pending-reply.js';

await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/state.js', () => ({
    conversationState: { conversationTimelineChannel: 'main', conversationTimelineSearchQuery: '' },
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/conversation-store.js', () => ({
    getConversationAttachmentLabels: () => [],
    getConversationAttachmentSummary: () => '',
}));

const { getConversationTimelineMessages } = await import('../public/scripts/sillybunny-conversation/timeline-search.js');

const message = (id, mes, extra = {}) => ({ id, role: 'character', name: 'Nova', mes, extra });

describe('the timeline', () => {
    test('does not show a reply that the server wrote and no page has landed yet, in any channel or search', () => {
        const pending = pendingReply({ text: 'RAW unsplit reply' });
        const messages = [message('a', 'hello', { conversation_pinned: true }), { ...pending, extra: { ...pending.extra, conversation_pinned: true } }];

        expect(getConversationTimelineMessages(messages).map(item => item.id)).toEqual(['a']);
        expect(getConversationTimelineMessages(messages, { channel: 'pinned' }).map(item => item.id)).toEqual(['a']);
        expect(getConversationTimelineMessages(messages, { query: 'unsplit' })).toEqual([]);
    });
});
