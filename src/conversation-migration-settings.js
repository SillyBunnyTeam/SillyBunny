/**
 * How the setting values of the old conversation store map onto the new files (plan S5.6). Pure functions: they read
 * the old values and return new ones, and touch no file.
 *
 * Old builds copied every default into every thread, so a stored value says nothing about what the user chose. A value
 * counts as chosen only when it differs from `LEGACY_DEFAULT_SETTINGS`, and only those are written, which keeps
 * `conversation.json` small.
 */

import { LEGACY_DEFAULT_SETTINGS, normalizeLegacySettings } from './conversation-legacy.js';

/** Per-conversation keys that the new store keeps. `availability` and `multi_char_names` have their own homes. */
const KEPT_PER_CONVERSATION = Object.freeze([
    'proactive_messaging', 'inactivity_threshold', 'max_followups', 'notifications_muted', 'offline_message',
    'selfie_command_enabled', 'schedule_command_enabled', 'include_related_memory', 'geechan_chatroom_prompt',
    'authors_note', 'lorebook_override', 'prose_polisher', 'roleplay_reactions', 'image_gen_enabled',
    'image_gen_prompt_template', 'image_gen_negative', 'image_gen_cooldown', 'spontaneous_selfies',
]);

/** Stored under another name in the new store (plan S1). */
const RENAMED_KEYS = Object.freeze({ geechan_chatroom_prompt: 'system_prompt' });

/** The idle toggles are mode-wide in the old store, and the mapping consumes them. */
const IDLE_KEYS = Object.freeze(['idle_action', 'idle_followup', 'idle_spontaneous']);

/** What an old group always had on, whatever its record stored. */
const GROUP_FORCED_SETTINGS = Object.freeze({ multi_char: true, auto_character_chat: true });

const QUIET_HOUR_PATTERN = /^(\d{1,2}):(\d{2})$/;
const SCENE_PLACEHOLDER = '{{scene}}';
const STATUS_VALUES = new Set(['online', 'idle', 'dnd', 'offline']);

function sameValue(left, right) {
    return JSON.stringify(left) === JSON.stringify(right);
}

function isChosen(key, value) {
    return !sameValue(value, LEGACY_DEFAULT_SETTINGS[key]);
}

/**
 * The values that the old client used for a conversation: defaults, then what the thread stored, then the mode-wide
 * settings, which win for the keys that are mode-wide. A group's values come from its record, then its anchor thread.
 * @param {{ kind: 'direct'|'group', threadSettings?: object, groupSettings?: object, globalSettings?: object }} sources
 * @returns {Record<string, any>}
 */
export function getEffectiveLegacySettings({ kind, threadSettings = {}, groupSettings = {}, globalSettings = {} }) {
    if (kind === 'group') {
        return normalizeLegacySettings({ ...globalSettings, ...GROUP_FORCED_SETTINGS, ...groupSettings, ...threadSettings });
    }
    return normalizeLegacySettings({ ...threadSettings, ...globalSettings });
}

/**
 * @param {Record<string, any>} globalSettings The mode-wide settings of the old store.
 * @returns {boolean} Whether a user had turned on any of the global idle follow-up toggles.
 */
export function hasGlobalIdleToggle(globalSettings) {
    return Boolean(globalSettings.idle_followup || globalSettings.idle_spontaneous || (globalSettings.idle_action && globalSettings.idle_action !== 'disabled'));
}

/**
 * Plan S5.6 as a function of one conversation.
 * @param {{ kind: 'direct'|'group', effective: Record<string, any>, idleToggleOn: boolean }} input
 * `kind` is the kind of the conversation that is written, not of the thread it came from.
 * @returns {Record<string, any>} The sparse `settings` of the new `conversation.json`.
 */
export function mapConversationSettings({ kind, effective, idleToggleOn }) {
    const settings = {};
    for (const key of KEPT_PER_CONVERSATION) {
        if (isChosen(key, effective[key])) {
            settings[RENAMED_KEYS[key] ?? key] = effective[key];
        }
    }

    if (effective.notification_priority === 'silent') {
        settings.notifications_muted = true;
    }

    // The selfie prompt had its own box, and the new store has one image prompt. A customised prompt of the image
    // box is the newer choice and wins.
    if (isChosen('selfie_prompt', effective.selfie_prompt) && !isChosen('image_gen_prompt_template', effective.image_gen_prompt_template)) {
        const selfie = String(effective.selfie_prompt);
        settings.image_gen_prompt_template = selfie.includes(SCENE_PLACEHOLDER) ? selfie : `${selfie}, ${SCENE_PLACEHOLDER}`;
    }

    if (kind === 'group') {
        delete settings.proactive_messaging;
    } else if (idleToggleOn) {
        settings.proactive_messaging = true;
    }
    return settings;
}

function normalizeQuietHour(value) {
    const match = QUIET_HOUR_PATTERN.exec(String(value ?? '').trim());
    if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) {
        return '';
    }
    return `${match[1].padStart(2, '0')}:${match[2]}`;
}

/**
 * The old store had a quiet-hours window per conversation, and the new one has a single window for the mode.
 * @param {{ effective: Record<string, any>, updatedAt: number }[]} conversations
 * @returns {{ start: string, end: string }|null} The window of the conversation that was updated last, among those that have one.
 */
export function chooseQuietHours(conversations) {
    let chosen = null;
    for (const { effective, updatedAt } of conversations) {
        const start = normalizeQuietHour(effective.quiet_hours_start);
        const end = normalizeQuietHour(effective.quiet_hours_end);
        if (start && end && start !== end && (!chosen || updatedAt >= chosen.updatedAt)) {
            chosen = { start, end, updatedAt };
        }
    }
    return chosen && { start: chosen.start, end: chosen.end };
}

/**
 * A reply delay multiplier of 0 meant "no delay". The mode-wide switch is off only if every conversation said so.
 * @param {Record<string, any>[]} effectiveSettings
 * @returns {boolean} The value of "Simulate reply delay".
 */
export function chooseSimulateReplyDelay(effectiveSettings) {
    return !(effectiveSettings.length > 0 && effectiveSettings.every(effective => Number(effective.reply_delay_multiplier) === 0));
}

/**
 * @param {Record<string, any>} globalSettings The mode-wide settings of the old store.
 * @param {{ quietHours: { start: string, end: string }|null, simulateReplyDelay: boolean }} chosen
 * @returns {Record<string, any>} The mode-wide settings to keep: the idle toggles are consumed, and the two new
 * mode-wide values are added.
 */
export function mapGlobalSettings(globalSettings, { quietHours, simulateReplyDelay }) {
    const settings = { ...globalSettings };
    for (const key of IDLE_KEYS) {
        delete settings[key];
    }
    if (quietHours) {
        settings.quiet_hours_start = quietHours.start;
        settings.quiet_hours_end = quietHours.end;
    }
    settings.simulate_reply_delay = simulateReplyDelay;
    return settings;
}

/**
 * Plan S5.3: a status that is not "online" is the character's choice and becomes its override, unless the character
 * has a routine, which today wins over the manual value. Offline wins when several conversations disagree.
 * @param {unknown[]} values The `availability` of every conversation that holds the character.
 * @param {{ hasRoutine: boolean }} options
 * @returns {string|null} The override, or null for "Automatic".
 */
export function chooseStatusOverride(values, { hasRoutine }) {
    if (hasRoutine) {
        return null;
    }
    const chosen = [...new Set(values.map(String))].filter(value => value !== 'online' && STATUS_VALUES.has(value));
    if (chosen.length === 0) {
        return null;
    }
    return chosen.includes('offline') ? 'offline' : chosen[0];
}
