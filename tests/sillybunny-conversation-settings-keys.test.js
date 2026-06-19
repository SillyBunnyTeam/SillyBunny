import { describe, expect, test } from '@jest/globals';

import {
    CHARACTER_CONVERSATION_SETTINGS_KEYS,
    DEFAULT_SETTINGS,
    GLOBAL_CONVERSATION_SETTINGS_KEYS,
    GROUP_CONVERSATION_SETTINGS_KEYS,
    THREAD_CONVERSATION_SETTINGS_KEYS,
} from '../public/scripts/sillybunny-conversation/constants.js';

describe('sillybunny conversation settings keys', () => {
    test('scopes custom instructions and connection profile globally', () => {
        expect(GLOBAL_CONVERSATION_SETTINGS_KEYS).toEqual([
            'idle_action',
            'idle_followup',
            'idle_spontaneous',
            'custom_instructions',
            'connection_profile',
        ]);
        expect(THREAD_CONVERSATION_SETTINGS_KEYS).not.toContain('custom_instructions');
        expect(THREAD_CONVERSATION_SETTINGS_KEYS).not.toContain('connection_profile');
        expect(CHARACTER_CONVERSATION_SETTINGS_KEYS).not.toContain('custom_instructions');
        expect(CHARACTER_CONVERSATION_SETTINGS_KEYS).not.toContain('connection_profile');
        expect(GROUP_CONVERSATION_SETTINGS_KEYS).not.toContain('custom_instructions');
        expect(GROUP_CONVERSATION_SETTINGS_KEYS).not.toContain('connection_profile');
    });

    test('keeps non-global settings available for solo thread storage', () => {
        const threadKeys = new Set(THREAD_CONVERSATION_SETTINGS_KEYS);

        for (const key of Object.keys(DEFAULT_SETTINGS)) {
            if (GLOBAL_CONVERSATION_SETTINGS_KEYS.includes(key)) {
                continue;
            }

            expect(threadKeys.has(key)).toBe(true);
        }
    });

    test('keeps group-level keys out of per-character group overrides', () => {
        const characterKeys = new Set(CHARACTER_CONVERSATION_SETTINGS_KEYS);

        for (const key of GROUP_CONVERSATION_SETTINGS_KEYS) {
            expect(characterKeys.has(key)).toBe(false);
        }
    });
});
