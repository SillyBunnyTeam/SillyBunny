/**
 * A `settings.json` object in the shape that builds before the conversation storage move wrote:
 * everything under `extension_settings.sillybunny_conversation`.
 *
 * Deterministic and free of the client constants, so the legacy reader's tests and the migration's tests describe
 * the same data. The cases are named in `CASES`; each one is the smallest data that shows one rule.
 */

import { LEGACY_DEFAULT_SETTINGS } from '../../src/conversation-legacy-defaults.js';

export const BASE = 1_700_000_000_000;
const MINUTE = 60_000;

export const PERSONA = 'user-default.png';
export const PERSONA_TWO = 'persona-two.png';
export const PERSONA_GONE = 'persona-gone.png';
export const MISSING_CHARACTER = 'Ghost.png';
export const CHARACTER_FILES = ['Nova.png', 'Orion.png', 'Lyra.png', 'Sol.png', 'Vega.png', 'Aria.png', 'Cass.png'];

const GLOBAL_KEYS = new Set([
    'idle_action', 'idle_followup', 'idle_spontaneous', 'custom_instructions', 'grounded_dialogue_rules_enabled',
    'grounded_dialogue_rules', 'connection_profile', 'lorebooks_enabled',
]);
const GROUP_KEYS = [
    'multi_char', 'auto_character_chat', 'proactive_messaging', 'inactivity_threshold', 'max_followups', 'talkativeness',
    'reply_delay_multiplier', 'reply_max_tokens', 'selfie_command_enabled', 'schedule_command_enabled',
];
const SOLO_THREAD_KEYS = Object.keys(LEGACY_DEFAULT_SETTINGS).filter(key => !GLOBAL_KEYS.has(key));
const GROUP_THREAD_KEYS = SOLO_THREAD_KEYS.filter(key => !GROUP_KEYS.includes(key));

/**
 * @param {string} persona
 * @param {string} avatar
 * @param {string} [groupId]
 * @returns {string} The thread key, in the syntax the old client and server share.
 */
export function keyFor(persona, avatar, groupId = '') {
    const raw = groupId ? `group:${groupId}:${avatar}` : avatar;
    return persona ? `persona:${encodeURIComponent(persona)}:${raw}` : raw;
}

let counter = 0;
const nextId = () => `${BASE + counter * MINUTE}-fx${String(counter++).padStart(4, '0')}`;

export function message(role, text, { name = '', extra = {}, id = '', minute = null } = {}) {
    const at = BASE + (minute ?? counter) * MINUTE;
    return {
        id: id || nextId(),
        role,
        name: name || (role === 'user' ? 'Tester' : 'Speaker'),
        mes: text,
        send_date: new Date(at).toISOString(),
        created_at: at,
        extra,
    };
}

export function branch(id, name, messages, overrides = {}) {
    const last = messages[messages.length - 1];
    return {
        id,
        name,
        messages,
        preview: last ? String(last.mes).slice(0, 40) : 'Conversation ready',
        unread: 0,
        lastActivity: last?.created_at ?? BASE,
        followupCount: 0,
        lastAutoMessageAt: 0,
        scheduleTriggers: {},
        sessionMarkers: {},
        memorySummary: '',
        memoryMessageCount: 0,
        memoryUpdatedAt: 0,
        createdAt: BASE,
        updatedAt: last?.created_at ?? BASE,
        ...overrides,
    };
}

export function thread(kind, branches, { activeBranchId = 'main', settings = {}, schedule = null, summary = null, avatar = '', groupId = '' } = {}) {
    const keys = kind === 'group' ? GROUP_THREAD_KEYS : SOLO_THREAD_KEYS;
    const base = Object.fromEntries(keys.map(key => [key, LEGACY_DEFAULT_SETTINGS[key]]));
    return {
        settings: { ...base, ...settings },
        schedule,
        activeBranchId,
        branches: Object.fromEntries(branches.map(item => [item.id, item])),
        memorySummary: summary?.text ?? '',
        memoryMessageCount: summary?.count ?? 0,
        memoryUpdatedAt: summary?.at ?? 0,
        threadAvatar: avatar,
        groupId,
    };
}

/** Alternating lines, starting with a character line, so counts are easy to state in a test. */
export function lines(count, { role = 'character', prefix = 'line', firstMinute = null } = {}) {
    return Array.from({ length: count }, (_, index) => message(
        index % 2 ? 'user' : role,
        `${prefix} ${index}`,
        { minute: firstMinute === null ? null : firstMinute + index },
    ));
}

export function reminder(overrides = {}) {
    return {
        id: `rem_${BASE}_${counter++}`,
        avatar: 'Nova.png',
        groupId: '',
        personaId: PERSONA,
        branchId: 'main',
        triggerAt: BASE + 5000 * MINUTE,
        text: 'take the pills',
        fired: false,
        createdAt: BASE,
        ...overrides,
    };
}

/** Values that differ from the defaults for every key that S5.6 removes. */
export const NON_DEFAULT_REMOVED_SETTINGS = Object.freeze({
    idle_followup: true,
    idle_spontaneous: true,
    idle_action: 'both',
    idle_limit: 45,
    cooldown: 120,
    auto_message: true,
    weekly_schedule: JSON.stringify([{ days: [1, 2], time: '09:00', message: 'good morning' }]),
    ai_schedule: 'Mon: work',
    auto_schedule: 'Mon: work',
    schedule_generated_at: BASE + 100 * MINUTE,
    auto_character_chat: true,
    auto_chat_cooldown: 5,
    auto_chat_names: 'Vega.png',
    multi_char: true,
    talkativeness: 80,
    reply_delay_multiplier: 0,
    reply_max_tokens: 2048,
    copy_memory_to_new_branch: false,
    notification_priority: 'silent',
    quiet_hours_start: '22:00',
    quiet_hours_end: '07:00',
    editable_messages: false,
    selfie_prompt: 'custom selfie of {{char}}',
    enabled: true,
});

/** Values that differ from the defaults for every key that S5.6 keeps per conversation. */
export const NON_DEFAULT_KEPT_SETTINGS = Object.freeze({
    proactive_messaging: true,
    inactivity_threshold: 90,
    max_followups: 2,
    notifications_muted: true,
    offline_message: 'brb',
    selfie_command_enabled: false,
    schedule_command_enabled: false,
    include_related_memory: true,
    geechan_chatroom_prompt: 'A custom system prompt for {{char}}.',
    authors_note: 'Stay in character.',
    lorebook_override: 'My Book',
    prose_polisher: true,
    roleplay_reactions: true,
    image_gen_enabled: true,
    image_gen_prompt_template: 'custom {{char}} {{scene}}',
    image_gen_negative: 'blurry',
    image_gen_cooldown: 3,
    spontaneous_selfies: true,
    availability: 'dnd',
});

/**
 * @returns {{ settings: object, store: object, groupIds: Record<string, string>, conflictMessageId: string }}
 * `settings` is the whole `settings.json` object; `store` is `settings.extension_settings.sillybunny_conversation`.
 */
export function buildLegacySettingsFixture() {
    counter = 0;
    const characters = {};
    const groups = [];
    const reminders = [];
    const groupIds = {
        owned: `conversation_${BASE + 2000 * MINUTE}_g1aaaa`,
        belowTwo: `conversation_${BASE + 2200 * MINUTE}_g2bbbb`,
        noThread: `conversation_${BASE + 2300 * MINUTE}_g3cccc`,
        uploaded: `conversation_${BASE + 2400 * MINUTE}_g4dddd`,
        noPersona: `conversation_${BASE + 2600 * MINUTE}_g6ffff`,
        roleplay: 'rp-group-1',
        roleplayMissing: 'rp-group-missing',
    };

    // Unscoped key with no scoped twin: moves to the active persona as it is.
    characters['Nova.png'] = thread('solo', [
        branch('main', 'Main', lines(8, { prefix: 'nova' }), { unread: 1 }),
        branch('br_1700000500000_aaa111', 'Weekend', lines(4, { prefix: 'nova-weekend', firstMinute: 500 }), { createdAt: BASE + 500 * MINUTE }),
    ], { settings: { enabled: true }, avatar: 'Nova.png' });

    // Unscoped copy that is a message-for-message prefix of the scoped thread: the merge is complete.
    const orionScoped = thread('solo', [branch('main', 'Main', [...lines(4, { prefix: 'orion-shared' }), message('character', 'only in the scoped copy')])], { settings: { enabled: true }, avatar: 'Orion.png' });
    const orionUnscoped = structuredClone(orionScoped);
    orionUnscoped.branches.main.messages = orionUnscoped.branches.main.messages.slice(0, 4);
    characters['Orion.png'] = orionUnscoped;
    characters[keyFor(PERSONA, 'Orion.png')] = orionScoped;

    // Unscoped copy whose message has the scoped message's id but another text: the merge is incomplete.
    const conflictMessageId = '1700000900000-conflict';
    characters['Lyra.png'] = thread('solo', [branch('main', 'Main', [message('character', 'old text', { id: conflictMessageId }), ...lines(2, { prefix: 'lyra-old' })])], { settings: { enabled: true }, avatar: 'Lyra.png' });
    characters[keyFor(PERSONA, 'Lyra.png')] = thread('solo', [branch('main', 'Main', [message('character', 'new text', { id: conflictMessageId }), ...lines(2, { prefix: 'lyra-new' })])], { settings: { enabled: true }, avatar: 'Lyra.png' });

    // Unscoped key assigned to another persona than the active one.
    characters['Sol.png'] = thread('solo', [branch('main', 'Main', lines(3, { prefix: 'sol-two' }))], { settings: { enabled: true } });

    // Scoped thread with several branches, a summary on the thread and on a branch, an unread count larger than the
    // thread, extras, a schedule, markers and a reply reference.
    const memory = { text: 'Thread-level summary of the chat so far.', count: 12, at: BASE + 900 * MINUTE };
    characters[keyFor(PERSONA, 'Aria.png')] = thread('solo', [
        branch('main', 'Main', lines(10, { prefix: 'aria-main' }), {
            unread: 25,
            memorySummary: 'A different branch-level summary.',
            memoryMessageCount: 8,
            memoryUpdatedAt: BASE + 800 * MINUTE,
            sessionMarkers: { seen_at: BASE + 700 * MINUTE, auto_chat_at: BASE + 710 * MINUTE },
            followupCount: 2,
            lastAutoMessageAt: BASE + 705 * MINUTE,
        }),
        branch('br_1700000600000_bbb222', 'Trip', [
            message('character', 'aria-trip 0'),
            message('partner', 'from vega', { name: 'Vega', extra: { partner_avatar: 'Vega.png', conversation_reply_to: { messageId: 'x', role: 'partner', name: 'Vega', text: 'q', attachmentSummary: '', createdAt: BASE } } }),
            message('system', 'system note'),
            message('character', 'image line', { extra: { image_url: '/user/images/a.png', conversation_mode_image: true } }),
        ], { createdAt: BASE + 600 * MINUTE, sessionMarkers: { memory_copied_from: 'main' }, scheduleTriggers: { 'slot-1': BASE } }),
        branch('main-merged-Vega.png', 'Merged overflow', lines(2, { prefix: 'aria-merged' }), { createdAt: BASE + 660 * MINUTE }),
    ], {
        activeBranchId: 'br_1700000600000_bbb222',
        summary: memory,
        settings: { enabled: true, multi_char_names: 'Vega.png, Cass.png, Ghost.png', availability: 'offline' },
        schedule: { days: { 0: [], 1: [{ time: '09:00-17:00', activity: 'work', status: 'dnd' }], 2: [], 3: [], 4: [], 5: [], 6: [] }, talkativeness: 70, inactivityThresholdMinutes: 90, generatedAt: BASE + 100 * MINUTE },
        avatar: 'Aria.png',
    });

    // Hidden and empty, and hidden with messages.
    characters[keyFor(PERSONA, 'Cass.png')] = thread('solo', [branch('main', 'Main', [])], { settings: { enabled: false }, avatar: 'Cass.png' });
    characters[keyFor(PERSONA, 'Vega.png')] = thread('solo', [branch('main', 'Main', lines(3, { prefix: 'vega-hidden' }))], { settings: { enabled: false }, avatar: 'Vega.png' });

    // A character with no card, and a persona that was deleted.
    characters[keyFor(PERSONA, MISSING_CHARACTER)] = thread('solo', [branch('main', 'Main', lines(4, { prefix: 'ghost' }))], { settings: { enabled: true }, avatar: MISSING_CHARACTER });
    characters[keyFor(PERSONA_GONE, 'Nova.png')] = thread('solo', [branch('main', 'Main', lines(3, { prefix: 'gone-persona' }))], { settings: { enabled: true }, avatar: 'Nova.png' });

    // Every removed key and every kept key at a non-default value.
    characters[keyFor(PERSONA_TWO, 'Cass.png')] = thread('solo', [branch('main', 'Main', lines(3, { prefix: 'kitchen' }))], {
        settings: { ...NON_DEFAULT_REMOVED_SETTINGS, ...NON_DEFAULT_KEPT_SETTINGS, availability: 'offline', quiet_hours_start: '23:00' },
        avatar: 'Cass.png',
    });
    characters[keyFor(PERSONA_TWO, 'Vega.png')] = thread('solo', [branch('main', 'Main', lines(2, { prefix: 'priority' }))], {
        settings: { enabled: true, notification_priority: 'priority', selfie_prompt: 'selfie only {{char}}', image_gen_prompt_template: LEGACY_DEFAULT_SETTINGS.image_gen_prompt_template },
        avatar: 'Vega.png',
    });

    // Group with an alias thread for every member, one of them unscoped. One line is in two aliases.
    const sharedLine = message('character', 'shared line in two aliases', { id: '1700000990000-shared' });
    groups.push({
        id: groupIds.owned,
        personaId: PERSONA,
        name: 'Fixture Group One',
        members: ['Nova.png', 'Orion.png', 'Lyra.png'],
        avatar_url: 'img/ai4.png',
        disabled_members: [],
        conversation_settings: { ...Object.fromEntries(GROUP_KEYS.map(key => [key, LEGACY_DEFAULT_SETTINGS[key]])), multi_char: true, auto_character_chat: true, proactive_messaging: true, talkativeness: 90 },
        createdAt: BASE + 2000 * MINUTE,
        updatedAt: BASE + 2100 * MINUTE,
        is_conversation_group: true,
    });
    characters[keyFor(PERSONA, 'Nova.png', groupIds.owned)] = thread('group', [branch('main', 'Main', [
        message('user', 'hello group'),
        sharedLine,
        message('partner', 'orion here', { name: 'Orion', extra: { partner_avatar: 'Orion.png', conversation_reply_to: { messageId: 'y', role: 'partner', name: 'Orion', text: 'q', attachmentSummary: '', createdAt: BASE } } }),
        message('character', 'nova again'),
        message('assistant', 'a REST-written line'),
    ], { unread: 2, sessionMarkers: { seen_at: BASE + 2050 * MINUTE } })], { settings: { enabled: false, availability: 'offline' }, avatar: 'Nova.png', groupId: groupIds.owned });
    characters[keyFor(PERSONA, 'Orion.png', groupIds.owned)] = thread('group', [branch('main', 'Main', [sharedLine, message('partner', 'orion alias only', { extra: { partner_avatar: 'Orion.png' } })], { unread: 1 })], { settings: { enabled: false }, avatar: 'Orion.png', groupId: groupIds.owned });
    characters[keyFor('', 'Lyra.png', groupIds.owned)] = thread('group', [branch('main', 'Main', [message('partner', 'lyra via unscoped alias', { extra: { partner_avatar: 'Lyra.png' } })])], { settings: { enabled: false }, avatar: 'Lyra.png', groupId: groupIds.owned });

    // A group that falls below two usable members (one disabled, one card missing) but has messages.
    groups.push({
        id: groupIds.belowTwo,
        personaId: PERSONA,
        name: 'Fixture Group Two',
        members: ['Sol.png', 'Vega.png', MISSING_CHARACTER],
        avatar_url: '',
        disabled_members: ['Vega.png'],
        conversation_settings: { multi_char: true, auto_character_chat: true },
        createdAt: BASE + 2200 * MINUTE,
        updatedAt: BASE + 2210 * MINUTE,
        is_conversation_group: true,
    });
    characters[keyFor(PERSONA, 'Sol.png', groupIds.belowTwo)] = thread('group', [branch('main', 'Main', lines(3, { prefix: 'g2' }))], { settings: { enabled: false }, avatar: 'Sol.png', groupId: groupIds.belowTwo });

    // Groups with no thread store, with an uploaded avatar, and with no persona at all.
    groups.push({
        id: groupIds.noThread,
        personaId: PERSONA,
        name: 'Fixture Group Three',
        members: ['Orion.png', 'Aria.png'],
        avatar_url: '',
        disabled_members: [],
        conversation_settings: {},
        createdAt: BASE + 2300 * MINUTE,
        updatedAt: BASE + 2300 * MINUTE,
        is_conversation_group: true,
    });
    groups.push({
        id: groupIds.uploaded,
        personaId: PERSONA_TWO,
        name: 'Fixture Group Four',
        members: ['Nova.png', 'Sol.png'],
        avatar_url: '/user/images/group-four.png',
        disabled_members: [],
        conversation_settings: { multi_char: true, auto_character_chat: false, proactive_messaging: false },
        createdAt: BASE + 2400 * MINUTE,
        updatedAt: BASE + 2410 * MINUTE,
        is_conversation_group: true,
    });
    characters[keyFor(PERSONA_TWO, 'Nova.png', groupIds.uploaded)] = thread('group', [branch('main', 'Main', lines(4, { prefix: 'g4' }))], {
        settings: { enabled: false, notification_priority: 'silent', quiet_hours_start: '21:30', quiet_hours_end: '06:30', selfie_prompt: 'g4 selfie', authors_note: 'group note' },
        avatar: 'Nova.png',
        groupId: groupIds.uploaded,
    });
    groups.push({ id: groupIds.noPersona, name: 'Fixture Group Six', members: ['Lyra.png', 'Sol.png'], avatar_url: '', conversation_settings: {}, createdAt: BASE + 2600 * MINUTE, updatedAt: BASE + 2600 * MINUTE });
    characters[`group:${groupIds.noPersona}:Lyra.png`] = thread('group', [branch('main', 'Main', lines(2, { prefix: 'g6' }))], { settings: { enabled: false }, avatar: 'Lyra.png', groupId: groupIds.noPersona });

    // Threads keyed to roleplay group ids: one has a group file in `groups/`, one has not.
    for (const avatar of ['Nova.png', 'Orion.png']) {
        characters[keyFor(PERSONA, avatar, groupIds.roleplay)] = thread('group', [branch('main', 'Main', lines(3, { prefix: `rp1-${avatar}` }))], { settings: { enabled: false }, avatar, groupId: groupIds.roleplay });
    }
    characters[keyFor(PERSONA, 'Nova.png', groupIds.roleplayMissing)] = thread('group', [branch('main', 'Main', lines(2, { prefix: 'rp-missing' }))], { settings: { enabled: false }, avatar: 'Nova.png', groupId: groupIds.roleplayMissing });

    // Messages the normaliser changes: empty text, a non-object, no id, duplicate ids, an unsafe id that a reply
    // reference points to, and a message with only a file.
    const unsafeId = 'has space/and slash';
    characters[keyFor(PERSONA_TWO, 'Orion.png')] = thread('solo', [branch('main', 'Main', [
        message('character', 'kept'),
        message('character', ''),
        'not an object',
        { role: 'user', name: 'Tester', mes: 'no id here', created_at: BASE + 3000 * MINUTE, extra: {} },
        message('character', 'dup a', { id: 'dup-1' }),
        message('user', 'dup b', { id: 'dup-1' }),
        message('character', 'unsafe id', { id: unsafeId }),
        message('user', 'replying', { extra: { conversation_reply_to: { messageId: unsafeId, role: 'character', name: 'Speaker', text: 'unsafe id', attachmentSummary: '', createdAt: BASE } } }),
        message('user', 'with files', { extra: { files: [{ url: '/user/files/a.txt', name: 'a.txt', size: 10 }] } }),
        message('user', 'old attachments', { extra: { attachments: [{ url: '/user/images/b.png', type: 'image' }, { url: '/user/files/c.pdf', type: 'file' }] } }),
    ])], { settings: { enabled: true }, avatar: 'Orion.png' });

    // Keys that must never become object properties.
    characters.constructor = thread('solo', [branch('main', 'Main', lines(1))]);

    reminders.push(
        reminder({}),
        reminder({ fired: true, firedAt: BASE + 5001 * MINUTE }),
        reminder({ groupId: groupIds.owned }),
        reminder({ branchId: 'gone-branch', invalidAt: BASE + 5002 * MINUTE }),
        reminder({ avatar: 'Orion.png', personaId: '', skippedAt: BASE + 5003 * MINUTE }),
        reminder({ avatar: MISSING_CHARACTER }),
        reminder({ personaId: PERSONA_GONE }),
        reminder({ avatar: 'Aria.png', branchId: 'br_1700000600000_bbb222', retryAfter: BASE + 5004 * MINUTE, lastAttemptAt: BASE + 5003 * MINUTE }),
    );

    const store = {
        version: 1,
        localStorageMigrated: true,
        settings: {
            idle_action: 'both',
            idle_followup: true,
            idle_spontaneous: true,
            custom_instructions: 'Be brief.',
            grounded_dialogue_rules_enabled: true,
            grounded_dialogue_rules: 'rules',
            connection_profile: 'profile-1',
            lorebooks_enabled: false,
        },
        characters,
        groups,
        legacyThreadPersonaAssignments: { 'Sol.png': PERSONA_TWO },
        reminders,
        userStatus: 'online',
        userPersonaStatus: 'working from home',
    };

    const settings = {
        username: 'Tester',
        user_avatar: PERSONA,
        power_user: { personas: { [PERSONA]: 'Tester', [PERSONA_TWO]: 'Tester Two' }, default_persona: PERSONA },
        extension_settings: { sillybunny_conversation: store, unrelated: { padding: 'x'.repeat(200) } },
        _version: 7,
    };
    return { settings, store, groupIds, conflictMessageId };
}
