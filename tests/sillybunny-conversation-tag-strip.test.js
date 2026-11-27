import { describe, expect, test } from '@jest/globals';

import { summarizeChat } from '../public/scripts/sillybunny-conversation/conversation-summary.js';
import { stripPreviewText } from '../public/scripts/sillybunny-conversation/preview-utils.js';
import { formatPromptText } from '../public/scripts/sillybunny-conversation/shared-helpers.js';
import { summarizeChatRecords } from '../src/conversation-schema.js';

const header = () => ({ chat_metadata: {}, user_name: 'unused', character_name: 'unused' });
const line = mes => ({ id: 'a', role: 'character', name: 'Her', mes, is_user: false, is_system: false, created_at: Date.UTC(2026, 0, 1) });

// Every place that takes the markup out of a message's text, for a list preview, a notification or a prompt.
const STRIPPERS = [
    ['the server list preview', text => summarizeChatRecords([header(), line(text)], '').preview],
    ['the page list preview', text => summarizeChat([line(text)], '').preview],
    ['the notification preview', text => stripPreviewText(text)],
    ['the prompt text', text => formatPromptText(text)],
];

describe.each(STRIPPERS)('%s', (_name, strip) => {
    test('takes out tags and keeps the words between them', () => {
        expect(strip('<b>bold</b>   text\n<i>break</i>')).toBe('bold text break');
    });

    test('keeps the text after a lone "<" up to the next tag', () => {
        expect(strip('a < b <i>c</i>')).toBe('a < b c');
    });

    test('works through a message full of unclosed "<" in linear time', () => {
        // Each "<" with no ">" after it made the old pattern scan to the end of the text, so the time grew with its square.
        const text = `start ${'<'.repeat(60_000)} end`;
        const startedAt = performance.now();

        const result = strip(text);

        expect(performance.now() - startedAt).toBeLessThan(1000);
        expect(result.startsWith('start <<<')).toBe(true);
    });
});
