import { describe, expect, jest, test } from '@jest/globals';
import { formatTokenCounterText, updateReasoningTokenAccounting } from '../public/scripts/reasoning-token-accounting.js';

describe('reasoning token accounting', () => {
    test('formats visible token counter text only for positive counts', () => {
        expect(formatTokenCounterText(42)).toBe('42t');
        expect(formatTokenCounterText('7')).toBe('7t');
        expect(formatTokenCounterText(0)).toBe('');
        expect(formatTokenCounterText(undefined)).toBe('');
        expect(formatTokenCounterText(Number.NaN)).toBe('');
    });

    test('counts output and locally parsed reasoning separately', async () => {
        const message = {
            mes: 'Final answer',
            extra: {
                reasoning: 'Hidden chain of thought',
            },
        };
        const countTokens = jest.fn(async text => text.split(/\s+/).filter(Boolean).length);

        const result = await updateReasoningTokenAccounting(message, {
            countTokens,
            reasoning: message.extra.reasoning,
        });

        expect(result).toEqual({ outputTokens: 2, reasoningTokens: 4 });
        expect(message.extra.token_count).toBe(2);
        expect(message.extra.reasoning_tokens).toBe(4);
        expect(countTokens).toHaveBeenNthCalledWith(1, 'Final answer');
        expect(countTokens).toHaveBeenNthCalledWith(2, 'Hidden chain of thought');
    });

    test('keeps provider-reported reasoning tokens when they exceed local count', async () => {
        const message = {
            mes: 'Visible output',
            extra: {
                reasoning: 'Provider thought text',
                reasoning_tokens: 17,
            },
        };
        const countTokens = jest.fn(async text => text.split(/\s+/).filter(Boolean).length);

        const result = await updateReasoningTokenAccounting(message, {
            countTokens,
            reasoning: message.extra.reasoning,
            reasoningTokens: message.extra.reasoning_tokens,
        });

        expect(result).toEqual({ outputTokens: 2, reasoningTokens: 17 });
        expect(message.extra.token_count).toBe(2);
        expect(message.extra.reasoning_tokens).toBe(17);
        expect(countTokens).toHaveBeenNthCalledWith(1, 'Visible output');
        expect(countTokens).toHaveBeenNthCalledWith(2, 'Provider thought text');
    });

    test('uses local reasoning count when provider count is lower', async () => {
        const message = {
            mes: 'Visible output',
            extra: {
                reasoning: 'Locally counted thought text',
                reasoning_tokens: 1,
            },
        };
        const countTokens = jest.fn(async text => text.split(/\s+/).filter(Boolean).length);

        const result = await updateReasoningTokenAccounting(message, {
            countTokens,
            reasoning: message.extra.reasoning,
            reasoningTokens: message.extra.reasoning_tokens,
        });

        expect(result).toEqual({ outputTokens: 2, reasoningTokens: 4 });
        expect(message.extra.token_count).toBe(2);
        expect(message.extra.reasoning_tokens).toBe(4);
        expect(countTokens).toHaveBeenNthCalledWith(1, 'Visible output');
        expect(countTokens).toHaveBeenNthCalledWith(2, 'Locally counted thought text');
    });

    test('can avoid local reasoning estimation when token counting is disabled', async () => {
        const message = {
            mes: 'Visible output',
            extra: {
                token_count: 9,
                reasoning: 'Uncounted thought text',
            },
        };
        const countTokens = jest.fn(async () => 99);

        const result = await updateReasoningTokenAccounting(message, {
            countTokens,
            reasoning: message.extra.reasoning,
            countOutput: false,
            countReasoning: false,
        });

        expect(result).toEqual({ outputTokens: 9, reasoningTokens: 0 });
        expect(message.extra.token_count).toBe(9);
        expect(message.extra.reasoning_tokens).toBe(0);
        expect(countTokens).not.toHaveBeenCalled();
    });

    test('refreshes active swipe token metadata with edited message text', async () => {
        const message = {
            mes: 'Polished text has five words',
            swipe_id: 1,
            swipes: ['Original stale text', 'Polished text has five words'],
            swipe_info: [
                {
                    extra: {
                        token_count: 3,
                        reasoning_tokens: 2,
                    },
                },
                {
                    extra: {
                        token_count: 4,
                        reasoning_tokens: 7,
                    },
                },
            ],
            extra: {
                token_count: 4,
                reasoning_tokens: 7,
            },
        };
        const countTokens = jest.fn(async text => text.split(/\s+/).filter(Boolean).length);

        const result = await updateReasoningTokenAccounting(message, {
            countTokens,
            reasoningTokens: 0,
            countReasoning: false,
        });

        expect(result).toEqual({ outputTokens: 5, reasoningTokens: 0 });
        expect(message.extra.token_count).toBe(5);
        expect(message.extra.reasoning_tokens).toBe(0);
        expect(message.swipe_info[1].extra.token_count).toBe(5);
        expect(message.swipe_info[1].extra.reasoning_tokens).toBe(0);
        expect(message.swipe_info[0].extra.token_count).toBe(3);
        expect(message.swipe_info[0].extra.reasoning_tokens).toBe(2);
    });
});
