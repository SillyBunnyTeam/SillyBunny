import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';

import { buildWorldInfoScanChat, substituteWorldInfoGreeting } from '../public/scripts/world-info-scan-chat.js';

describe('World Info scan chat', () => {
    test('prompt assembly does not overwrite the stored greeting', () => {
        const source = readFileSync(new URL('../public/script.js', import.meta.url), 'utf8');
        expect(source).not.toMatch(/chat\[0\]\.mes\s*=/);
    });

    test('prefixes speaker names only when enabled', () => {
        const chat = [{ name: 'Kaveh & Alhaitham', mes: 'Hello', index: 0 }];
        expect(buildWorldInfoScanChat(chat, [], new Map(), true)).toEqual(['Kaveh & Alhaitham: Hello']);
        expect(buildWorldInfoScanChat(chat, [], new Map(), false)).toEqual(['Hello']);
    });

    test('preserves automatic greeting names while expanding other macros', () => {
        let substitutions = 0;
        const substitute = value => value
            .replace('{{season}}', () => {
                substitutions++;
                return 'summer';
            });
        const greeting = '{{char}} and <BOT> greet {{user}} and <USER> in {{season}}. Literal Kaveh stays.';

        expect(substituteWorldInfoGreeting(greeting, substitute, { char: 'Kaveh & Alhaitham', user: 'Traveler' })).toEqual({
            prompt: 'Kaveh & Alhaitham and Kaveh & Alhaitham greet Traveler and Traveler in summer. Literal Kaveh stays.',
            worldInfo: '{{char}} and <BOT> greet {{user}} and <USER> in summer. Literal Kaveh stays.',
        });
        expect(substitutions).toBe(1);
    });

    test('uses a name-excluded greeting variant without removing literal authored names', () => {
        const prompt = 'Kaveh & Alhaitham greets Traveler. Literal Kaveh stays.';
        const worldInfo = '{{char}} greets {{user}}. Literal Kaveh stays.';
        const chat = [{ name: 'Kaveh & Alhaitham', mes: prompt, index: 0 }];
        const variants = new Map([[0, { prompt, worldInfo }]]);

        expect(buildWorldInfoScanChat(chat, [], variants, false)).toEqual([worldInfo]);
    });
});
