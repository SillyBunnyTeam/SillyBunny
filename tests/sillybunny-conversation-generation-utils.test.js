import { describe, expect, test } from '@jest/globals';

import {
    buildSelfieImagePromptTemplate,
    extractCharacterReplyCommandParts,
    normalizeConversationOutputText,
    parseCommandArgs,
} from '../public/scripts/sillybunny-conversation/generation-utils.js';

describe('sillybunny conversation generation utils', () => {
    test('parses quoted command arguments with lower-cased keys', () => {
        expect(parseCommandArgs('Status="dnd" activity="deep work" duration="1h 15m"')).toEqual({
            status: 'dnd',
            activity: 'deep work',
            duration: '1h 15m',
        });
    });

    test('extracts enabled reply commands and cleans visible text', () => {
        const result = extractCharacterReplyCommandParts(
            '"I can do that !"  [schedule_update: status="dnd" activity="coding" duration="1h"]\n[selfie: context="desk"]\n[reminder: 15m | check back]',
            { schedule_command_enabled: true, selfie_command_enabled: true },
        );

        expect(result).toEqual({
            text: 'I can do that!',
            selfieRequests: ['desk'],
            scheduleUpdates: ['status="dnd" activity="coding" duration="1h"'],
            reminders: [{ delay: '15m', memo: 'check back' }],
            reaction: null,
        });
    });

    describe('the reaction of a character', () => {
        const parse = (text, settings = {}) => extractCharacterReplyCommandParts(text, settings);

        test('is read from [react: <emoji>] anywhere in the reply and taken out of the text', () => {
            expect(parse('haha [react: 😂] that is great')).toMatchObject({ text: 'haha that is great', reaction: '😂' });
            expect(parse('[react: 👍] sounds good')).toMatchObject({ text: 'sounds good', reaction: '👍' });
            expect(parse('sounds good [react: 👍]')).toMatchObject({ text: 'sounds good', reaction: '👍' });
        });

        test('is read with no space after the colon, in any case, and in quotes or backticks', () => {
            expect(parse('ok [react:🎉]').reaction).toBe('🎉');
            expect(parse('ok [REACT: 🎉]').reaction).toBe('🎉');
            expect(parse('ok [react: "🎉"]').reaction).toBe('🎉');
            expect(parse('ok [react: `🎉`]').reaction).toBe('🎉');
        });

        test('is the first of several emoji, and fully qualified', () => {
            expect(parse('ok [react: 😂👍]').reaction).toBe('😂');
            expect(parse('ok [react: ❤]').reaction).toBe('❤️');
        });

        test('is none for text that is not an emoji, and the marker is taken out all the same', () => {
            expect(parse('ok [react: laughing]')).toMatchObject({ text: 'ok', reaction: null });
            expect(parse('ok [react: 😂 lol]')).toMatchObject({ text: 'ok', reaction: null });
            expect(parse('ok [react: ]')).toMatchObject({ text: 'ok', reaction: null });
        });

        test('is taken out whether or not characters may react, so that a model that echoes it shows no brackets', () => {
            expect(parse('haha [react: 😂]', { characters_react: false })).toMatchObject({ text: 'haha', reaction: '😂' });
        });

        test('is the first marker when a reply holds two', () => {
            expect(parse('a [react: 😂] b [react: 👍]')).toMatchObject({ text: 'a b', reaction: '😂' });
        });

        test('makes a reply of only the marker a reaction with no text, and not a bubble that shows the marker', () => {
            expect(parse('[react: 👍]')).toMatchObject({ text: '', reaction: '👍' });
            expect(parse('  [react: 👍]\n')).toMatchObject({ text: '', reaction: '👍' });
            expect(parse('[react: nope]')).toMatchObject({ text: '', reaction: null });
        });

        test('is read before the quotes of the text go, with the other commands, in any order', () => {
            const result = parse('"On my way" [react: 🏃] [schedule_update: status="idle" activity="walking"] [reminder: 5m | leave]', { schedule_command_enabled: true });

            expect(result).toMatchObject({
                text: 'On my way',
                reaction: '🏃',
                scheduleUpdates: ['status="idle" activity="walking"'],
                reminders: [{ delay: '5m', memo: 'leave' }],
            });
        });

        test('is none for a reply without the marker', () => {
            expect(parse('plain reply').reaction).toBeNull();
        });
    });

    test('leaves disabled optional commands in the visible text', () => {
        const result = extractCharacterReplyCommandParts('[selfie: desk] hi [schedule_update: status="idle"]', {
            schedule_command_enabled: false,
            selfie_command_enabled: false,
        });

        expect(result.selfieRequests).toEqual([]);
        expect(result.scheduleUpdates).toEqual([]);
        expect(result.text).toContain('[selfie: desk]');
        expect(result.text).toContain('[schedule_update: status=idle]');
    });

    test('normalizes repeated wrapper quotes and punctuation spacing', () => {
        expect(normalizeConversationOutputText('""Hello ?!""')).toBe('Hello?!');
    });

    test('does not blank a reply when bracket-stripping consumes all visible content', () => {
        const original = '[selfie: context="smiling"]';
        const result = extractCharacterReplyCommandParts(original, {
            schedule_command_enabled: true,
            selfie_command_enabled: true,
        });

        expect(result.selfieRequests).toEqual(['smiling']);
        expect(result.scheduleUpdates).toEqual([]);
        expect(result.reminders).toEqual([]);
        // SillyBunny: even though the only content was a stripped command, the reply is
        // never blanked back to the original text instead.
        expect(result.text.length).toBeGreaterThan(0);
    });

    test('does not blank a reply composed entirely of reminder commands', () => {
        const original = '[reminder: 15m | check back]';
        const result = extractCharacterReplyCommandParts(original, {});

        expect(result.reminders).toEqual([{ delay: '15m', memo: 'check back' }]);
        expect(result.text.length).toBeGreaterThan(0);
    });

    test('returns empty text when input is empty or whitespace only', () => {
        expect(extractCharacterReplyCommandParts('   \n  ', {}).text).toBe('');
        expect(extractCharacterReplyCommandParts('', {}).text).toBe('');
    });

    test('preserves selfie command context when falling back to configured image prompt', () => {
        expect(buildSelfieImagePromptTemplate('', 'raw photo, selfie of {{char}}', 'at a cluttered desk')).toBe(
            'raw photo, selfie of {{char}}\nPhoto context: {{scene}}',
        );
    });

    test('does not duplicate selfie context when template already contains scene token', () => {
        expect(buildSelfieImagePromptTemplate('', 'raw photo of {{char}} in {{scene}}', 'at a cluttered desk')).toBe(
            'raw photo of {{char}} in {{scene}}',
        );
    });

    test('preserves selfie command context when generated image prompt is generic', () => {
        expect(buildSelfieImagePromptTemplate('detailed selfie prompt', 'raw photo, selfie of {{char}}', 'at a cluttered desk')).toBe(
            'detailed selfie prompt\nPhoto context: {{scene}}',
        );
    });

    test('does not duplicate selfie context when generated image prompt already contains it', () => {
        expect(buildSelfieImagePromptTemplate('selfie at a cluttered desk', 'raw photo, selfie of {{char}}', 'at a cluttered desk')).toBe('selfie at a cluttered desk');
    });
});
