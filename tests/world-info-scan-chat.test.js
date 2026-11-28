/** @jest-environment jsdom */
import { afterEach, describe, expect, test } from '@jest/globals';

import { buildWorldInfoScanChat, substituteWorldInfoGreeting } from '../public/scripts/world-info-scan-chat.js';
import { importScriptModule } from './util/script-harness.js';

let activeScript = null;

afterEach(() => {
    activeScript?.cleanup();
    activeScript = null;
});

describe('World Info scan chat', () => {
    test('prompt assembly does not overwrite the stored greeting', async () => {
        const loaded = await importScriptModule({
            keepReal: ['scripts/world-info-scan-chat.js'],
        });
        activeScript = loaded;
        const { script } = loaded;

        script.characters.push({
            name: 'Kaveh & Alhaitham',
            avatar: 'kaveh-alhaitham.png',
            chat: 'chat-1',
            first_mes: '{{char}} greets {{user}}.',
            description: '',
            personality: '',
            scenario: '',
            mes_example: '',
        });
        script.setCharacterId(0);
        script.setCharacterName('Kaveh & Alhaitham');
        script.chat.push({
            name: 'Kaveh & Alhaitham',
            is_user: false,
            is_system: false,
            mes: '{{char}} greets {{user}}.',
            swipe_id: 0,
            swipes: ['{{char}} greets {{user}}.'],
        });
        loaded.mocks['scripts/openai.js'].sendOpenAIRequest.mockResolvedValueOnce({
            choices: [{ message: { content: 'Reply text' } }],
        });
        const evaluateMacros = loaded.mocks['scripts/macros.js'].evaluateMacros;
        evaluateMacros.mockImplementation(text => String(text ?? '')
            .replaceAll('{{char}}', 'Kaveh & Alhaitham')
            .replaceAll('{{user}}', 'Traveler'));
        loaded.mocks['scripts/world-info.js'].getWorldInfoPrompt.mockClear();

        await script.Generate('normal', { automatic_trigger: false, force_name2: false, quiet_prompt: '', quietToLoud: false, skipWIAN: false, force_chid: null, signal: null, quietImage: null, quietName: null }, true);

        expect(script.chat[0].mes).toBe('{{char}} greets {{user}}.');
        expect(loaded.mocks['scripts/world-info.js'].getWorldInfoPrompt).toHaveBeenCalled();
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
