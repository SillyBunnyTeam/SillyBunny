/* eslint-disable playwright/no-standalone-expect -- Jest contracts for pure functions. */
import { describe, expect, test } from '@jest/globals';
import { HOME_STUBS, stubAction } from '../../public/scripts/sillybunny-home/stubs.js';

describe('Home stubs', () => {
    test('lists every stubbed action by name', () => {
        expect([...HOME_STUBS]).toEqual([
            'assistant.new-chat',
            'assistant.temporary-chat',
            'assistant.new-chat-in-mode',
        ]);
    });

    test('a stub does nothing and returns nothing', () => {
        expect(stubAction('assistant.new-chat')()).toBeUndefined();
    });

    test('fails loudly on an action that is not listed', () => {
        expect(() => stubAction('assistant.delete')).toThrow(/not a listed stub/i);
    });
});
