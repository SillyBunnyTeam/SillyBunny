import { describe, expect, test } from '@jest/globals';

import {
    DEFAULT_SETTINGS,
    GLOBAL_CONVERSATION_SETTINGS_KEYS,
    SETTINGS_FIELDS,
    CONVERSATION_SETTINGS_KEYS,
} from '../public/scripts/sillybunny-conversation/constants.js';

// Plan S5.6, as lists. A key that is kept per conversation, kept mode-wide, moved to the character, or removed.
const KEPT_PER_CONVERSATION = [
    'proactive_messaging', 'inactivity_threshold', 'max_followups', 'notifications_muted', 'offline_message',
    'selfie_command_enabled', 'schedule_command_enabled', 'include_related_memory', 'geechan_chatroom_prompt', 'authors_note',
    'lorebook_override', 'prose_polisher', 'roleplay_reactions', 'image_gen_enabled', 'image_gen_prompt_template',
    'image_gen_negative', 'image_gen_cooldown', 'spontaneous_selfies',
];
const KEPT_MODE_WIDE = [
    'custom_instructions', 'grounded_dialogue_rules_enabled', 'grounded_dialogue_rules', 'lorebooks_enabled', 'connection_profile',
    'quiet_hours_start', 'quiet_hours_end', 'simulate_reply_delay',
];
const MOVED_TO_THE_CHARACTER = ['availability'];
// Not a setting: the extras of a direct conversation are a list of their own that the settings show as a read-only value.
const DERIVED = ['multi_char_names'];
const REMOVED = [
    'enabled', 'idle_followup', 'idle_spontaneous', 'idle_action', 'idle_limit', 'cooldown', 'auto_message', 'weekly_schedule',
    'ai_schedule', 'auto_schedule', 'schedule_generated_at', 'auto_character_chat', 'auto_chat_cooldown', 'auto_chat_names',
    'multi_char', 'talkativeness', 'reply_delay_multiplier', 'reply_max_tokens', 'copy_memory_to_new_branch',
    'notification_priority', 'editable_messages', 'selfie_prompt',
];

describe('sillybunny conversation settings keys', () => {
    test('are the keys of plan S5.6, and no removed key', () => {
        expect(Object.keys(DEFAULT_SETTINGS).sort()).toEqual([...KEPT_PER_CONVERSATION, ...KEPT_MODE_WIDE, ...MOVED_TO_THE_CHARACTER, ...DERIVED].sort());
        for (const key of REMOVED) {
            expect(DEFAULT_SETTINGS).not.toHaveProperty(key);
        }
    });

    test('have a control only for a key that is kept', () => {
        const kept = new Set(Object.keys(DEFAULT_SETTINGS));

        for (const field of SETTINGS_FIELDS) {
            expect(kept.has(field.key)).toBe(true);
        }
        expect(SETTINGS_FIELDS.map(field => field.key)).toEqual(expect.not.arrayContaining(REMOVED));
    });

    test('keep the mode-wide values in settings.json and the others in the conversation', () => {
        expect([...GLOBAL_CONVERSATION_SETTINGS_KEYS].sort()).toEqual([...KEPT_MODE_WIDE].sort());
        expect(CONVERSATION_SETTINGS_KEYS.filter(key => GLOBAL_CONVERSATION_SETTINGS_KEYS.includes(key))).toEqual([]);
        for (const key of KEPT_PER_CONVERSATION) {
            expect(CONVERSATION_SETTINGS_KEYS).toContain(key);
        }
    });

    test('turn Conversation lorebooks on by default with one global switch', () => {
        expect(DEFAULT_SETTINGS.lorebooks_enabled).toBe(true);
        expect(CONVERSATION_SETTINGS_KEYS).not.toContain('lorebooks_enabled');
        expect(SETTINGS_FIELDS).toContainEqual({ id: 'sb_conv_lorebooks_enabled', key: 'lorebooks_enabled', prop: 'checked' });
    });

    test('turn the reply delay on, and messaging first off, until the user chooses', () => {
        expect(DEFAULT_SETTINGS.simulate_reply_delay).toBe(true);
        expect(DEFAULT_SETTINGS.proactive_messaging).toBe(false);
        expect(DEFAULT_SETTINGS.notifications_muted).toBe(false);
        expect(DEFAULT_SETTINGS.quiet_hours_start).toBe('');
        expect(DEFAULT_SETTINGS.quiet_hours_end).toBe('');
    });
});
