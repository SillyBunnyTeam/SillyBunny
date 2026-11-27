import { describe, expect, test } from '@jest/globals';

import { summarizeChat } from '../public/scripts/sillybunny-conversation/conversation-summary.js';
import { summarizeChatRecords } from '../src/conversation-schema.js';

const header = () => ({ chat_metadata: {}, user_name: 'unused', character_name: 'unused' });
const message = (id, mes, { role = 'character', minute = 0, extra = {} } = {}) => ({
    id,
    role,
    name: role === 'user' ? 'Me' : 'Her',
    mes,
    is_user: role === 'user',
    is_system: role === 'system',
    send_date: new Date(Date.UTC(2026, 0, 1, 0, minute)).toISOString(),
    created_at: Date.UTC(2026, 0, 1, 0, minute),
    extra,
});

// The server's function is the oracle: the list that the server sends and the summary that the browser works out for
// a chat that it holds must agree, or a badge would change when the page loads the list again.
const CASES = [
    ['an empty chat', []],
    ['a single character line', [message('a', 'hi')]],
    ['a mixed chat', [message('a', 'first', { minute: 1 }), message('b', 'me', { role: 'user', minute: 2 }), message('c', 'reply', { role: 'member', minute: 3 }), message('d', 'note', { role: 'system', minute: 4 })]],
    ['markup and long text', [message('a', '<b>bold</b>   text\nbreak'), message('b', 'w'.repeat(500))]],
    ['a line with only a role', [{ id: 'x', name: 'A', mes: 'x', role: 'user' }]],
    ['a line with only flags', [{ id: 'x', name: 'A', mes: 'x', is_system: true }]],
    ['a line with a send date and no created_at', [{ id: 'x', name: 'A', mes: 'x', is_user: false, send_date: '2026-03-04T05:06:07.000Z' }]],
    ['a line with no text', [message('a', ''), message('b', undefined)]],
];

describe('summarizeChat', () => {
    test.each(CASES.flatMap(([name, messages]) => ['', 'a', 'b', 'gone', messages.at(-1)?.id ?? 'x'].map(readThrough => [name, messages, readThrough])))(
        'agrees with the server for %s read through "%s"',
        (_name, messages, readThrough) => {
            expect(summarizeChat(messages, readThrough)).toEqual(summarizeChatRecords([header(), ...messages], readThrough));
        },
    );

    test('does not look at the header, because it takes messages only', () => {
        expect(summarizeChat([], '')).toEqual({ messageCount: 0, lastMessageAt: 0, preview: '', unread: 0, lastMessageRole: '', hasUserMessage: false });
    });
});
