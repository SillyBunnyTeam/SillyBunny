import { describe, expect, test } from '@jest/globals';
import { buildConversationRenderKey, getRenderKeyConversation } from '../public/scripts/sillybunny-conversation/render-key.js';

describe('the conversation inside a render key', () => {
    test('is the key without its chat, so that the chats of one conversation share it', () => {
        const first = buildConversationRenderKey('a.png', 'g1', 'chat-1', 'p.png');
        const second = buildConversationRenderKey('a.png', 'g1', 'chat-2', 'p.png');
        const none = buildConversationRenderKey('a.png', 'g1', '', 'p.png');

        expect(getRenderKeyConversation(first)).toBe(getRenderKeyConversation(second));
        expect(getRenderKeyConversation(first)).toBe(getRenderKeyConversation(none));
    });

    test('differs by persona, character and group', () => {
        const base = getRenderKeyConversation(buildConversationRenderKey('a.png', '', 'chat', 'p.png'));

        expect(getRenderKeyConversation(buildConversationRenderKey('b.png', '', 'chat', 'p.png'))).not.toBe(base);
        expect(getRenderKeyConversation(buildConversationRenderKey('a.png', 'g1', 'chat', 'p.png'))).not.toBe(base);
        expect(getRenderKeyConversation(buildConversationRenderKey('a.png', '', 'chat', 'q.png'))).not.toBe(base);
    });

    test('is empty for the empty key, which is no conversation', () => {
        expect(getRenderKeyConversation('')).toBe('');
    });
});
