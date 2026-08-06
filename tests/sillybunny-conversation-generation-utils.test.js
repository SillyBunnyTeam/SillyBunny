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
