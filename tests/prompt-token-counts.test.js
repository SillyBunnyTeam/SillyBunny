import { describe, expect, test } from '@jest/globals';
import { getPromptDisplayTokenCounts, getPromptSourceTokenCounts, isCommentOnlyPromptContent, mergePromptTokenCounts } from '../public/scripts/prompt-token-counts.js';

function makeMessage(identifier, tokens) {
    return {
        identifier,
        getTokens: () => tokens,
    };
}

function makeCollection(identifier, collection) {
    return {
        identifier,
        getCollection: () => collection,
        getTokens: () => collection.reduce((total, item) => total + item.getTokens(), 0),
    };
}

describe('prompt token display counts', () => {
    test('uses direct prompt tokens instead of injected collection totals', () => {
        const messages = makeCollection('root', [
            makeCollection('main', [
                makeMessage('main', 550),
                makeMessage('inchat_agent_style', 1100),
            ]),
        ]);

        const counts = getPromptDisplayTokenCounts(messages);

        expect(counts.main).toBe(550);
        expect(counts.inchat_agent_style).toBe(1100);
    });

    test('keeps aggregate totals for marker collections without direct prompt messages', () => {
        const messages = makeCollection('root', [
            makeCollection('chatHistory', [
                makeMessage('chatHistory-2', 34),
                makeMessage('chatHistory-1', 55),
            ]),
        ]);

        const counts = getPromptDisplayTokenCounts(messages);

        expect(counts.chatHistory).toBe(89);
        expect(counts['chatHistory-2']).toBe(34);
        expect(counts['chatHistory-1']).toBe(55);
    });

    test('counts enabled source prompt content when runtime messages are absent', async () => {
        const countedMessages = [];
        const prompts = [
            { identifier: 'main', role: 'system', content: 'Main prompt text' },
            { identifier: 'jailbreak', role: 'user', content: 'Post-history instruction' },
            { identifier: 'chatHistory', marker: true, content: 'Marker content is not source prompt text' },
            { identifier: 'empty', role: 'system', content: '' },
        ];

        const counts = await getPromptSourceTokenCounts(prompts, async (message, extraArgument) => {
            expect(extraArgument).toBeUndefined();
            countedMessages.push(message);
            return message.content.length;
        });

        expect(counts).toEqual({
            main: 16,
            jailbreak: 24,
        });
        expect(countedMessages).toEqual([
            { role: 'system', content: 'Main prompt text' },
            { role: 'user', content: 'Post-history instruction' },
        ]);
    });

    test('merges source estimates under runtime counts', () => {
        const merged = mergePromptTokenCounts(
            { main: 500, injection: 120, variable: 80 },
            { main: 550, chatHistory: 900, variable: 0 },
        );

        expect(merged).toEqual({
            main: 550,
            chatHistory: 900,
            injection: 120,
            variable: 80,
        });
    });

    test('merge tolerates missing count maps', () => {
        expect(mergePromptTokenCounts(null, null)).toEqual({});
        expect(mergePromptTokenCounts(undefined, { main: 3 })).toEqual({ main: 3 });
        expect(mergePromptTokenCounts({ main: 4 }, undefined)).toEqual({ main: 4 });
        expect(mergePromptTokenCounts({ main: 4 }, { main: 'NaN-ish' })).toEqual({ main: 4 });
    });

    test('detects comment-only prompt content', () => {
        expect(isCommentOnlyPromptContent('{{// A note to the user}}')).toBe(true);
        expect(isCommentOnlyPromptContent('{{comment same via alias}}')).toBe(true);
        expect(isCommentOnlyPromptContent('{{//}}First line\nSecond line{{///}}')).toBe(true);
        expect(isCommentOnlyPromptContent(' {{// one}} \n {{// two}} ')).toBe(true);
        expect(isCommentOnlyPromptContent('{{// preset readme text}}{{trim}}')).toBe(true);
        expect(isCommentOnlyPromptContent('{{// docs can mention {{char}} or {{getvar::mode}} inline}}{{trim}}')).toBe(true);
        expect(isCommentOnlyPromptContent('')).toBe(true);

        expect(isCommentOnlyPromptContent('{{// a note}}{{setvar::mode::on}}')).toBe(false);
        expect(isCommentOnlyPromptContent('plain instruction text')).toBe(false);
        expect(isCommentOnlyPromptContent('{{commentary}}')).toBe(false);
    });
});
