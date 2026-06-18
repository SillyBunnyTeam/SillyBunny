import { describe, expect, test } from '@jest/globals';

import {
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
});
