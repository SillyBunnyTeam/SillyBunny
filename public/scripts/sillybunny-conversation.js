import { getMessageTimeStamp } from './RossAscends-mods.js';
import { eventSource, event_types } from './events.js';
import { selected_group, groups, group_activation_strategy, group_generation_mode } from './group-chats.js';
import { world_names } from './world-info.js';
import { playMessageSound, power_user } from './power-user.js';
import { user_avatar, setUserAvatar } from './personas.js';
import { executeSlashCommandsWithOptions } from './slash-commands.js';
import { extension_settings } from './extensions.js';
import { MEDIA_DISPLAY, MEDIA_TYPE } from './constants.js';
import { characters, chat, default_avatar, default_user_avatar, generateRaw, getCharacters, getRequestHeaders, getThumbnailUrl, is_send_press, messageFormatting, name1, saveSettingsDebounced, this_chid } from '../script.js';

const GEECHAN_DEFAULT_PROMPT = `{{// The main system prompt, designed for an output reminiscent of an instant messaging interface.

A derivative of this system prompt is currently in use with Discord Pals, made by my friend TheLonelyDevil. Check it out if you want to integrate AI characters with Discord! https://github.com/TheLonelyDevil9/discord-pals
}}
{{trim}}
# Role Preamble

This is a conversational instant messaging chatroom with several users, including {{user}} and {{char}}. Solely embody {{char}} as they casually converse in the chatroom.

**Review and strictly adhere to the following guidelines before responding. Look through the Chatroom Context for current character, history, and world information.**

## Chatting Guidelines

- Speak purely from a first person perspective, only using dialogue to communicate in plain text. Refrain from writing narration or roleplay actions.
- This is a chatroom, so messages should feel natural and conversational, with varied emoji and emoticon usage. Converse through multiple, individual messages, as real people would, to simulate natural conversation.
- Be flexible and varied with {{char}}'s responses. Short, lazy inquiries should get short answers in return, while more thoughtful inquiries should allow for longer responses.
- Rely on defined assertion rather than describing absences. {{char}} has inherently distinct opinions, and speaks without hedging or moralizing.
- Keep the conversation flowing so the other users can respond easily. Ask proactive follow up questions and employ subtle hooks where necessary.
- Exclusively respond as {{char}} in-character, with no exceptions. The other users in chat, including {{user}} are their own autonomous selves unable to be portrayed. Any other extraneous, out of character information, meta-commentary or reply information is considered completely out of scope.

## Character Guidelines

- Reference {{char}}'s example dialogue for guidance on their portrayal and their speech patterns.
- Embody {{char}} as a fully autonomous individual with their own wants, fears, values, goals and sense of agency, operated under bounded rationality, restricted by their subjective framing, biases, and history.
- Portray {{char}} accurately by consistently and believably using their unique traits, quirks, emotions, inner thoughts, idiolects, vernacular, and non-verbal cues.
- Ensure that their reactions, interactions, and decision-making align with their established personality and values. Prioritise their wants and fears over anyone else in chat - if they come across something disagreeable, they should show objection to it.
- Reference chat history and call back to appropriate context where necessary. They can notice when someone gets talked over, or have their minds changed with enough persuasion.
- {{char}} will only use emojis, slang, and emoticons that are completely fitting for their personality and typing style. They also like to vary it up, by frequently posting different emojis for different situations. Some characters will rarely use emojis; pay attention to their traits.
{{#if .player-instructions}}
## Custom Player Instructions

**These are custom-made instructions designed by the individual player, and take precedence over all other instructions:**

{{getvar::player-instructions}}
{{/if}}

## Chatroom Mechanics

- Emojis: Use unicode emojis as found in the Unicode database.
- Emoticons: Use chatroom emoticons as found in message boards.
- Kaomoji: Use kaomoji as alternatives for regular emoticons.
- Internet slang: Use internet slang and acronyms of all kinds.

Only use what is fitting for {{char}}.

# Chatroom Context

Use the information below as a reference point on how {{char}} should act in the chatroom:`;

const WEEKDAY_LABELS = Object.freeze(['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']);
const USER_STATUS_OPTIONS = Object.freeze(['online', 'idle', 'dnd', 'offline']);
const CONVERSATION_NOTIFICATION_PRIORITIES = Object.freeze(['normal', 'silent', 'priority']);
const CONVERSATION_TIMELINE_CHANNELS = Object.freeze(['main', 'pinned', 'selfies', 'media', 'ooc', 'memories']);
const CONVERSATION_REACTION_LABELS = Object.freeze({
    heart: '❤️',
    spark: '✨',
    laugh: '😂',
});
const USER_STATUS_STORAGE_KEY = 'sb_conv_user_status';
const PERSONA_APPENDICES_SELECTIONS_KEY = 'activeAppendices';
const PERSONA_APPENDICES_DEFAULT_SCOPE_KEY = '__default__';

const SETTINGS_KEY_PREFIX = 'sb_conv_settings_';
const THREAD_KEY_PREFIX = 'sb_conv_thread_';
const CONVERSATION_STORE_KEY = 'sillybunny_conversation';
const GROUP_CONVERSATION_STORE_PREFIX = 'group:';
const DEFAULT_BRANCH_ID = 'main';
const LAST_USER_ACTIVITY_PREFIX = 'sb_conv_last_user_activity_';
const LAST_AUTO_MESSAGE_PREFIX = 'sb_conv_last_auto_msg_';
const LAST_SCHEDULE_TRIGGER_PREFIX = 'sb_conv_last_trigger_';
const LAST_IDLE_SESSION_PREFIX = 'sb_conv_last_idle_session_';
const LAST_CHIME_SESSION_PREFIX = 'sb_conv_last_chime_session_';
const LAST_PREVIEW_PREFIX = 'sb_conv_last_preview_';
const UNREAD_PREFIX = 'sb_conv_unread_';
const SCHEDULE_PREFIX = 'sb_conv_schedule_';
const FOLLOWUP_COUNT_PREFIX = 'sb_conv_followup_count_';
const AUTO_WORKER_INTERVAL_MS = 30000;
const AUTO_WORKER_WAIT_TIMEOUT_MS = 45000;
const AUTO_WORKER_INTERVAL_GLOBAL_KEY = '__sbConversationAutoWorkerIntervalId';
const MAX_THREAD_MESSAGES = 250;
const TRANSCRIPT_MESSAGE_LIMIT = 32;
const SCHEDULE_STATUSES = Object.freeze(['online', 'idle', 'dnd', 'offline']);
const DEFAULT_INACTIVITY_THRESHOLD = 120;
const MIN_INACTIVITY_THRESHOLD = 15;
const MAX_INACTIVITY_THRESHOLD = 360;
const DEFAULT_TALKATIVENESS = 50;
const DEFAULT_MAX_FOLLOWUPS = 3;
const DEFAULT_REPLY_DELAY_MULTIPLIER = 100;
const DEFAULT_AUTO_CHAT_COOLDOWN = 10;
const SEND_QUEUE_BATCH_MS = 900;
const MIN_CONVERSATION_REPLY_MAX_TOKENS = 64;
const DEFAULT_CONVERSATION_REPLY_MAX_TOKENS = 16000;
const MAX_CONVERSATION_REPLY_MAX_TOKENS = 64000;
const CONVERSATION_ERROR_DETAIL_MAX_LENGTH = 180;
const STATUS_NOTICE_COOLDOWN_MS = 30 * 60 * 1000;
const REMINDER_RETRY_DELAY_MS = 60 * 1000;
const CONVERSATION_ATTACHMENT_MAX_FILES = 4;
const CONVERSATION_ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024;
const CONVERSATION_ATTACHMENT_ALLOWED_EXTENSIONS = Object.freeze([
    '.png', '.jpg', '.jpeg', '.webp', '.gif', '.avif', '.bmp',
    '.mp3', '.wav', '.ogg', '.m4a', '.flac', '.mp4', '.webm', '.mov',
    '.txt', '.md', '.markdown', '.pdf', '.epub', '.docx', '.xlsx', '.pptx',
    '.odt', '.ods', '.odp', '.json', '.csv',
]);
const CONVERSATION_ATTACHMENT_ACCEPT = [
    'image/*', 'video/*', 'audio/*',
    ...CONVERSATION_ATTACHMENT_ALLOWED_EXTENSIONS,
].join(',');
const PARTNER_FOLLOWUP_RECENT_WINDOW = 6;
const PARALLEL_CHIME_MAX_PARTNERS = 2;
const GROUP_ASIDE_CONTEXT_LIMIT = 8;
const GROUP_ASIDE_RANDOM_CHANCE = 0.18;
const GROUP_ASIDE_COOLDOWN_MS = 8 * 60 * 1000;
const GROUP_ASIDE_MENTION_COOLDOWN_MS = 45 * 1000;
const AUTO_CHAT_LAST_SENT_MARKER = 'auto_chat_at';
const MAX_STACKED_PARTICIPANT_AVATARS = 4;
const MEMORY_SUMMARY_MIN_MESSAGES = 24;
const MEMORY_SUMMARY_INTERVAL_MESSAGES = 12;
const MEMORY_SUMMARY_RECENT_MESSAGES = 36;
const SELFIE_COMMAND_RE = /\[selfie(?::\s*(?:context=)?"?([^"\]]*)"?)?\]/gi;
const SCHEDULE_UPDATE_RE = /\[schedule_update:\s*([^\]]+)\]/gi;
const REMINDER_COMMAND_RE = /\[reminder:\s*([^|\]]+)\s*\|\s*([^\]]+)\]/gi;
const CHROME_IDS = Object.freeze({
    header: 'sb_conversation_header',
    palsToggle: 'sb_conversation_pals_toggle',
    palsRail: 'sb_conversation_pals_rail',
    palsList: 'sb_conversation_pals_list',
    stage: 'sb_conversation_stage',
    timeline: 'sb_conversation_timeline',
    tools: 'sb_conversation_tools',
    search: 'sb_conversation_search',
    dropHint: 'sb_conversation_drop_hint',
    form: 'sb_conversation_form',
    input: 'sb_conversation_input',
    attach: 'sb_conversation_attach',
    fileInput: 'sb_conversation_file_input',
    attachmentPreview: 'sb_conversation_attachment_preview',
    send: 'sb_conversation_send',
    composerPolish: 'sb_conversation_composer_polish',
    settingsBackdrop: 'sb_conversation_settings_backdrop',
    settingsDrawer: 'sb_conversation_settings_drawer',
    railFooter: 'sb_conversation_rail_footer',
    personaPicker: 'sb_conversation_persona_picker',
    userStatusPicker: 'sb_conversation_user_status_picker',
});
const AVAILABILITY_COPY = Object.freeze({
    online: { label: 'Online', detail: 'Available for live DM replies.' },
    idle: { label: 'Idle', detail: 'May follow up after a quiet stretch.' },
    dnd: { label: 'Do Not Disturb', detail: 'Auto-responder answers new messages.' },
    offline: { label: 'Offline', detail: 'Auto-responder answers while away.' },
});

const DEFAULT_SETTINGS = Object.freeze({
    enabled: false,
    availability: 'online',
    idle_action: 'disabled',
    idle_followup: false,
    idle_spontaneous: false,
    idle_limit: 15,
    offline_message: '[{{char}} is currently offline. Leave a message!]',
    auto_message: false,
    cooldown: 60,
    ai_schedule: '',
    weekly_schedule: '[]',
    proactive_messaging: false,
    inactivity_threshold: DEFAULT_INACTIVITY_THRESHOLD,
    talkativeness: DEFAULT_TALKATIVENESS,
    max_followups: DEFAULT_MAX_FOLLOWUPS,
    reply_delay_multiplier: DEFAULT_REPLY_DELAY_MULTIPLIER,
    reply_max_tokens: DEFAULT_CONVERSATION_REPLY_MAX_TOKENS,
    copy_memory_to_new_branch: true,
    auto_schedule: '',
    schedule_generated_at: 0,
    selfie_command_enabled: true,
    schedule_command_enabled: true,
    geechan_chatroom_prompt: GEECHAN_DEFAULT_PROMPT,
    custom_instructions: '',
    multi_char: false,
    multi_char_names: '',
    auto_character_chat: false,
    auto_chat_cooldown: DEFAULT_AUTO_CHAT_COOLDOWN,
    auto_chat_names: '',
    roleplay_reactions: false,
    lorebook_override: '',
    connection_profile: '',
    authors_note: '',
    notifications_muted: false,
    notification_priority: 'normal',
    quiet_hours_start: '',
    quiet_hours_end: '',
    editable_messages: true,
    prose_polisher: false,
    image_gen_enabled: false,
    image_gen_prompt_template: 'a photo of {{char}}, {{scene}}',
    image_gen_negative: '',
    image_gen_cooldown: 10,
    spontaneous_selfies: false,
    selfie_prompt: 'raw photo, selfie of {{char}}',
});

const SETTINGS_FIELDS = Object.freeze([
    { id: 'sb_conv_availability', key: 'availability', prop: 'value' },
    { id: 'sb_conv_idle_followup', key: 'idle_followup', prop: 'checked' },
    { id: 'sb_conv_idle_spontaneous', key: 'idle_spontaneous', prop: 'checked' },
    { id: 'sb_conv_idle_limit', key: 'idle_limit', prop: 'value', type: 'number', fallback: DEFAULT_SETTINGS.idle_limit, min: 1 },
    { id: 'sb_conv_offline_message', key: 'offline_message', prop: 'value' },
    { id: 'sb_conv_auto_message', key: 'auto_message', prop: 'checked' },
    { id: 'sb_conv_cooldown', key: 'cooldown', prop: 'value', type: 'number', fallback: DEFAULT_SETTINGS.cooldown, min: 1 },
    { id: 'sb_conv_ai_schedule', key: 'ai_schedule', prop: 'value' },
    { id: 'sb_conv_weekly_schedule', key: 'weekly_schedule', prop: 'value' },
    { id: 'sb_conv_proactive_messaging', key: 'proactive_messaging', prop: 'checked' },
    { id: 'sb_conv_inactivity_threshold', key: 'inactivity_threshold', prop: 'value', type: 'number', fallback: DEFAULT_INACTIVITY_THRESHOLD, min: MIN_INACTIVITY_THRESHOLD },
    { id: 'sb_conv_talkativeness', key: 'talkativeness', prop: 'value', type: 'number', fallback: DEFAULT_TALKATIVENESS, min: 0 },
    { id: 'sb_conv_max_followups', key: 'max_followups', prop: 'value', type: 'number', fallback: DEFAULT_MAX_FOLLOWUPS, min: 1 },
    { id: 'sb_conv_reply_delay_multiplier', key: 'reply_delay_multiplier', prop: 'value', type: 'number', fallback: DEFAULT_REPLY_DELAY_MULTIPLIER, min: 0 },
    { id: 'sb_conv_reply_max_tokens', key: 'reply_max_tokens', prop: 'value', type: 'number', fallback: DEFAULT_CONVERSATION_REPLY_MAX_TOKENS, min: MIN_CONVERSATION_REPLY_MAX_TOKENS, max: MAX_CONVERSATION_REPLY_MAX_TOKENS },
    { id: 'sb_conv_copy_memory_to_new_branch', key: 'copy_memory_to_new_branch', prop: 'checked' },
    { id: 'sb_conv_auto_schedule', key: 'auto_schedule', prop: 'value' },
    { id: 'sb_conv_selfie_command_enabled', key: 'selfie_command_enabled', prop: 'checked' },
    { id: 'sb_conv_schedule_command_enabled', key: 'schedule_command_enabled', prop: 'checked' },
    { id: 'sb_conv_geechan_chatroom_prompt', key: 'geechan_chatroom_prompt', prop: 'value' },
    { id: 'sb_conv_custom_instructions', key: 'custom_instructions', prop: 'value' },
    { id: 'sb_conv_multi_char', key: 'multi_char', prop: 'checked' },
    { id: 'sb_conv_multi_char_names', key: 'multi_char_names', prop: 'value' },
    { id: 'sb_conv_auto_character_chat', key: 'auto_character_chat', prop: 'checked' },
    { id: 'sb_conv_auto_chat_cooldown', key: 'auto_chat_cooldown', prop: 'value', type: 'number', fallback: DEFAULT_AUTO_CHAT_COOLDOWN, min: 1 },
    { id: 'sb_conv_auto_chat_names', key: 'auto_chat_names', prop: 'value' },
    { id: 'sb_conv_roleplay_reactions', key: 'roleplay_reactions', prop: 'checked' },
    { id: 'sb_conv_lorebook_override', key: 'lorebook_override', prop: 'value' },
    { id: 'sb_conv_connection_profile', key: 'connection_profile', prop: 'value' },
    { id: 'sb_conv_authors_note', key: 'authors_note', prop: 'value' },
    { id: 'sb_conv_notifications_muted', key: 'notifications_muted', prop: 'checked' },
    { id: 'sb_conv_notification_priority', key: 'notification_priority', prop: 'value' },
    { id: 'sb_conv_quiet_hours_start', key: 'quiet_hours_start', prop: 'value' },
    { id: 'sb_conv_quiet_hours_end', key: 'quiet_hours_end', prop: 'value' },
    { id: 'sb_conv_editable_messages', key: 'editable_messages', prop: 'checked' },
    { id: 'sb_conv_prose_polisher', key: 'prose_polisher', prop: 'checked' },
    { id: 'sb_conv_image_gen_enabled', key: 'image_gen_enabled', prop: 'checked' },
    { id: 'sb_conv_image_gen_prompt_template', key: 'image_gen_prompt_template', prop: 'value' },
    { id: 'sb_conv_image_gen_negative', key: 'image_gen_negative', prop: 'value' },
    { id: 'sb_conv_image_gen_cooldown', key: 'image_gen_cooldown', prop: 'value', type: 'number', fallback: 10, min: 0 },
    { id: 'sb_conv_spontaneous_selfies', key: 'spontaneous_selfies', prop: 'checked' },
    { id: 'sb_conv_selfie_prompt', key: 'selfie_prompt', prop: 'value' },
]);

let initialized = false;
let autoWorkerIntervalId = null;
let autoWorkerBusy = false;
let generationActive = false;
let conversationReplyBusy = false;
let conversationUploadActive = false;
let sendQueueProcessing = false;
let conversationProfileSwitchQueue = Promise.resolve();
let scheduleGenerationBusy = false;
let conversationWorkspaceOpen = false;
let conversationSelectedAvatar = null;
let conversationSelectedGroupId = null;
let conversationTimelineChannel = 'main';
let conversationTimelineSearchQuery = '';
let imageGenerationActive = false;
let imageGenerationAbortController = null;
let lastRenderedAvatar = null;
let lastRenderedMessageCount = 0;
let originalDocumentTitle = typeof document !== 'undefined' ? document.title : '';
let originalFaviconHref = '';
let faviconUpdateToken = 0;
const sendQueue = [];
const runtimeStatusOverrides = new Map();
const memorySummaryBusyAvatars = new Set();
const memorySummaryTimers = new Map();
const activeTypingParticipants = new Map();
const partnerReplyBusyKeys = new Set();
const groupAsideBusyKeys = new Set();
const groupAsideLastSent = new Map();
const SAFE_TOAST_OPTIONS = Object.freeze({ escapeHtml: true });

function getRoleplayCurrentCharacter() {
    if (typeof this_chid === 'undefined' || !Array.isArray(characters)) {
        return null;
    }

    return characters[this_chid] ?? null;
}

function getCurrentCharacter() {
    if (conversationWorkspaceOpen && conversationSelectedAvatar) {
        const selected = getCharacterForAvatar(conversationSelectedAvatar);
        if (selected) {
            return selected;
        }
    }

    return getRoleplayCurrentCharacter();
}

function getCurrentCharAvatar() {
    return getCurrentCharacter()?.avatar ?? null;
}

function getCurrentCharName(fallback = 'Character') {
    return getCurrentCharacter()?.name || fallback;
}

function getConversationGroupById(groupId) {
    if (!groupId || !Array.isArray(groups)) {
        return null;
    }

    return groups.find(group => String(group?.id) === String(groupId)) || null;
}

function isAvatarInConversationGroup(avatar, groupId) {
    const group = getConversationGroupById(groupId);
    return Boolean(avatar && group?.members?.includes(avatar) && !group.disabled_members?.includes(avatar));
}

function getConversationGroupIdForAvatar(avatar) {
    if (!avatar) {
        return null;
    }

    if (conversationWorkspaceOpen) {
        return conversationSelectedGroupId && isAvatarInConversationGroup(avatar, conversationSelectedGroupId)
            ? conversationSelectedGroupId
            : null;
    }

    return selected_group && isAvatarInConversationGroup(avatar, selected_group) ? String(selected_group) : null;
}

function getConversationThreadKey(avatar, groupId = getConversationGroupIdForAvatar(avatar)) {
    if (!avatar) {
        return '';
    }

    const safeGroupId = groupId && isAvatarInConversationGroup(avatar, groupId) ? String(groupId) : '';
    return safeGroupId ? `${GROUP_CONVERSATION_STORE_PREFIX}${safeGroupId}:${avatar}` : avatar;
}

function parseConversationThreadKey(key) {
    const value = String(key || '');
    if (!value.startsWith(GROUP_CONVERSATION_STORE_PREFIX)) {
        return { avatar: value, groupId: '' };
    }

    const withoutPrefix = value.slice(GROUP_CONVERSATION_STORE_PREFIX.length);
    const separatorIndex = withoutPrefix.indexOf(':');
    if (separatorIndex < 0) {
        return { avatar: '', groupId: '' };
    }

    return {
        groupId: withoutPrefix.slice(0, separatorIndex),
        avatar: withoutPrefix.slice(separatorIndex + 1),
    };
}

function getCharacterStorageKey(prefix, avatar) {
    return `${prefix}${avatar}`;
}

function parsePositiveInt(value, fallback, min = 1) {
    const parsed = Number.parseInt(String(value), 10);
    return Number.isFinite(parsed) && parsed >= min ? parsed : fallback;
}

function getIdleActionFromSettings(settings) {
    const hasFollowup = Boolean(settings?.idle_followup);
    const hasSpontaneous = Boolean(settings?.idle_spontaneous);
    if (hasFollowup && hasSpontaneous) {
        return 'both';
    }
    if (hasFollowup) {
        return 'followup';
    }
    if (hasSpontaneous) {
        return 'spontaneous';
    }
    return 'disabled';
}

function normalizeConversationQuietHour(value) {
    const text = String(value || '').trim();
    const match = /^(\d{1,2}):(\d{2})$/.exec(text);
    if (!match) {
        return '';
    }

    const hours = Number(match[1]);
    const minutes = Number(match[2]);
    if (!Number.isInteger(hours) || !Number.isInteger(minutes) || hours < 0 || hours > 23 || minutes < 0 || minutes > 59) {
        return '';
    }

    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

function getConversationMinuteOfDay(value) {
    const normalized = normalizeConversationQuietHour(value);
    if (!normalized) {
        return null;
    }

    const [hours, minutes] = normalized.split(':').map(Number);
    return hours * 60 + minutes;
}

function isConversationQuietHoursActive(settings, date = new Date()) {
    const start = getConversationMinuteOfDay(settings?.quiet_hours_start);
    const end = getConversationMinuteOfDay(settings?.quiet_hours_end);
    if (start === null || end === null || start === end) {
        return false;
    }

    const now = date.getHours() * 60 + date.getMinutes();
    if (start < end) {
        return now >= start && now < end;
    }

    return now >= start || now < end;
}

function shouldSurfaceConversationNotification(settings) {
    if (settings?.notifications_muted || settings?.notification_priority === 'silent') {
        return false;
    }

    if (settings?.notification_priority === 'priority') {
        return true;
    }

    return !isConversationQuietHoursActive(settings);
}

function safeParseSettings(stored) {
    if (!stored) {
        return { ...DEFAULT_SETTINGS };
    }

    try {
        const parsed = typeof stored === 'string' ? JSON.parse(stored) : stored;
        const parsedSettings = parsed && typeof parsed === 'object' ? parsed : {};
        const settings = { ...DEFAULT_SETTINGS, ...parsedSettings };
        const hasIdleFollowup = Object.prototype.hasOwnProperty.call(parsedSettings, 'idle_followup');
        const hasIdleSpontaneous = Object.prototype.hasOwnProperty.call(parsedSettings, 'idle_spontaneous');
        if (!hasIdleFollowup && !hasIdleSpontaneous) {
            settings.idle_followup = settings.idle_action === 'followup' || settings.idle_action === 'both';
            settings.idle_spontaneous = settings.idle_action === 'spontaneous' || settings.idle_action === 'both';
        }
        settings.idle_action = getIdleActionFromSettings(settings);
        if (!settings.multi_char_names && settings.auto_chat_names) {
            settings.multi_char_names = settings.auto_chat_names;
        }
        settings.auto_chat_names = settings.multi_char_names;
        settings.auto_chat_cooldown = parsePositiveInt(settings.auto_chat_cooldown, DEFAULT_AUTO_CHAT_COOLDOWN, 1);
        settings.reply_max_tokens = getConversationReplyMaxTokens(settings);
        settings.notification_priority = CONVERSATION_NOTIFICATION_PRIORITIES.includes(settings.notification_priority)
            ? settings.notification_priority
            : DEFAULT_SETTINGS.notification_priority;
        settings.quiet_hours_start = normalizeConversationQuietHour(settings.quiet_hours_start);
        settings.quiet_hours_end = normalizeConversationQuietHour(settings.quiet_hours_end);
        if (settings.reply_max_tokens === 1024) {
            settings.reply_max_tokens = DEFAULT_CONVERSATION_REPLY_MAX_TOKENS;
        }
        return settings;
    } catch {
        return { ...DEFAULT_SETTINGS };
    }
}

function getConversationStore() {
    const store = extension_settings[CONVERSATION_STORE_KEY];
    if (!store || typeof store !== 'object') {
        extension_settings[CONVERSATION_STORE_KEY] = {
            version: 1,
            localStorageMigrated: false,
            characters: {},
            reminders: [],
        };
    }

    const current = extension_settings[CONVERSATION_STORE_KEY];
    current.version = current.version || 1;
    current.characters = current.characters && typeof current.characters === 'object' ? current.characters : {};
    current.reminders = Array.isArray(current.reminders) ? current.reminders : [];
    return current;
}

function persistConversationStore() {
    saveSettingsDebounced();
}

function createConversationBranch(name = 'Main', id = `br_${Date.now()}_${Math.random().toString(36).slice(2)}`) {
    return {
        id,
        name,
        messages: [],
        preview: 'Conversation ready',
        unread: 0,
        lastActivity: Date.now(),
        followupCount: 0,
        lastAutoMessageAt: 0,
        scheduleTriggers: {},
        sessionMarkers: {},
        memorySummary: '',
        memoryMessageCount: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
    };
}

function normalizeConversationBranch(branch, id = DEFAULT_BRANCH_ID) {
    const normalized = branch && typeof branch === 'object' ? branch : {};
    return {
        ...createConversationBranch(id === DEFAULT_BRANCH_ID ? 'Main' : 'Conversation', id),
        ...normalized,
        id: normalized.id || id,
        name: normalized.name || (id === DEFAULT_BRANCH_ID ? 'Main' : 'Conversation'),
        messages: Array.isArray(normalized.messages) ? normalized.messages : [],
        scheduleTriggers: normalized.scheduleTriggers && typeof normalized.scheduleTriggers === 'object' ? normalized.scheduleTriggers : {},
        sessionMarkers: normalized.sessionMarkers && typeof normalized.sessionMarkers === 'object' ? normalized.sessionMarkers : {},
        memorySummary: typeof normalized.memorySummary === 'string' ? normalized.memorySummary : '',
        memoryMessageCount: parsePositiveInt(normalized.memoryMessageCount, 0, 0),
    };
}

function getCharacterConversationStore(avatar, { create = true } = {}) {
    if (!avatar) {
        return null;
    }

    const store = getConversationStore();
    if (!store.characters[avatar] && !create) {
        return null;
    }
    if (!store.characters[avatar]) {
        store.characters[avatar] = {
            settings: { ...DEFAULT_SETTINGS },
            schedule: null,
            activeBranchId: DEFAULT_BRANCH_ID,
            branches: {
                [DEFAULT_BRANCH_ID]: createConversationBranch('Main', DEFAULT_BRANCH_ID),
            },
        };
    }

    const characterStore = store.characters[avatar];
    characterStore.settings = safeParseSettings(characterStore.settings);
    characterStore.branches = characterStore.branches && typeof characterStore.branches === 'object' ? characterStore.branches : {};
    characterStore.activeBranchId = characterStore.activeBranchId || DEFAULT_BRANCH_ID;
    if (!characterStore.branches[characterStore.activeBranchId]) {
        characterStore.branches[characterStore.activeBranchId] = createConversationBranch('Main', characterStore.activeBranchId);
    }
    characterStore.branches[characterStore.activeBranchId] = normalizeConversationBranch(characterStore.branches[characterStore.activeBranchId], characterStore.activeBranchId);
    return characterStore;
}

function getConversationThreadStore(avatar, { create = true, groupId = getConversationGroupIdForAvatar(avatar) } = {}) {
    const threadKey = getConversationThreadKey(avatar, groupId);
    if (!threadKey) {
        return null;
    }

    const threadStore = getCharacterConversationStore(threadKey, { create });
    if (!threadStore) {
        return null;
    }

    threadStore.threadAvatar = avatar;
    threadStore.groupId = groupId || '';
    return threadStore;
}

function getActiveConversationBranch(avatar, { create = true, groupId = getConversationGroupIdForAvatar(avatar) } = {}) {
    const characterStore = getConversationThreadStore(avatar, { create, groupId });
    if (!characterStore) {
        return null;
    }

    const id = characterStore.activeBranchId || DEFAULT_BRANCH_ID;
    characterStore.branches[id] = normalizeConversationBranch(characterStore.branches[id], id);
    return characterStore.branches[id];
}

function getConversationBranches(avatar, { groupId = getConversationGroupIdForAvatar(avatar) } = {}) {
    const characterStore = getConversationThreadStore(avatar, { create: false, groupId });
    if (!characterStore) {
        return [];
    }

    return Object.values(characterStore.branches).map((branch) => normalizeConversationBranch(branch, branch.id));
}

function setActiveConversationBranch(avatar, branchId, { groupId = getConversationGroupIdForAvatar(avatar) } = {}) {
    const characterStore = getConversationThreadStore(avatar, { groupId });
    if (!characterStore?.branches?.[branchId]) {
        return;
    }

    characterStore.activeBranchId = branchId;
    persistConversationStore();
}

function createConversationBranchForAvatar(avatar, name = 'New chat', { groupId = getConversationGroupIdForAvatar(avatar), copyMemory = null } = {}) {
    const characterStore = getConversationThreadStore(avatar, { groupId });
    if (!characterStore) {
        return null;
    }

    const sourceBranch = normalizeConversationBranch(
        characterStore.branches?.[characterStore.activeBranchId || DEFAULT_BRANCH_ID],
        characterStore.activeBranchId || DEFAULT_BRANCH_ID,
    );
    const branch = createConversationBranch(name || 'New chat');
    const shouldCopyMemory = copyMemory ?? Boolean(getSettings(avatar).copy_memory_to_new_branch);
    if (shouldCopyMemory && sourceBranch.memorySummary) {
        branch.memorySummary = sourceBranch.memorySummary;
        branch.memoryMessageCount = 0;
        branch.sessionMarkers.memory_copied_from = sourceBranch.id;
    }
    characterStore.branches[branch.id] = branch;
    characterStore.activeBranchId = branch.id;
    persistConversationStore();
    return branch;
}

function renameConversationBranch(avatar, branchId, name, { groupId = getConversationGroupIdForAvatar(avatar) } = {}) {
    const characterStore = getConversationThreadStore(avatar, { create: false, groupId });
    const branch = characterStore?.branches?.[branchId];
    if (!branch || !String(name || '').trim()) {
        return;
    }

    branch.name = String(name).trim();
    branch.updatedAt = Date.now();
    persistConversationStore();
}

function deleteConversationBranch(avatar, branchId, { groupId = getConversationGroupIdForAvatar(avatar) } = {}) {
    const characterStore = getConversationThreadStore(avatar, { create: false, groupId });
    if (!characterStore?.branches?.[branchId]) {
        return false;
    }

    const branchIds = Object.keys(characterStore.branches);
    if (branchIds.length <= 1) {
        characterStore.branches[branchId] = createConversationBranch('Main', branchId);
        characterStore.activeBranchId = branchId;
    } else {
        delete characterStore.branches[branchId];
        if (characterStore.activeBranchId === branchId) {
            characterStore.activeBranchId = Object.keys(characterStore.branches)[0] || DEFAULT_BRANCH_ID;
        }
    }
    persistConversationStore();
    return true;
}

function resetCharacterConversationBranches(avatar, { groupId = getConversationGroupIdForAvatar(avatar) } = {}) {
    const characterStore = getConversationThreadStore(avatar, { groupId });
    if (!characterStore) {
        return;
    }

    characterStore.activeBranchId = DEFAULT_BRANCH_ID;
    characterStore.branches = {
        [DEFAULT_BRANCH_ID]: createConversationBranch('Main', DEFAULT_BRANCH_ID),
    };
    persistConversationStore();
}

function migrateConversationLocalStorage() {
    const store = getConversationStore();
    if (store.localStorageMigrated || typeof localStorage === 'undefined') {
        return;
    }

    const prefixes = [
        SETTINGS_KEY_PREFIX,
        THREAD_KEY_PREFIX,
        SCHEDULE_PREFIX,
        LAST_USER_ACTIVITY_PREFIX,
        FOLLOWUP_COUNT_PREFIX,
        UNREAD_PREFIX,
        LAST_PREVIEW_PREFIX,
        LAST_AUTO_MESSAGE_PREFIX,
        LAST_SCHEDULE_TRIGGER_PREFIX,
    ];
    const avatars = new Set();
    for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i) || '';
        const prefix = prefixes.find(value => key.startsWith(value));
        if (prefix) {
            avatars.add(key.slice(prefix.length));
        }
    }

    for (const avatar of avatars) {
        const characterStore = getCharacterConversationStore(avatar);
        const settingsRaw = localStorage.getItem(getCharacterStorageKey(SETTINGS_KEY_PREFIX, avatar));
        if (settingsRaw) {
            characterStore.settings = safeParseSettings(settingsRaw);
        }

        const branch = getActiveConversationBranch(avatar);
        const threadRaw = localStorage.getItem(getCharacterStorageKey(THREAD_KEY_PREFIX, avatar));
        if (threadRaw) {
            branch.messages = safeParseThread(threadRaw).slice(-MAX_THREAD_MESSAGES);
        }
        const preview = localStorage.getItem(getCharacterStorageKey(LAST_PREVIEW_PREFIX, avatar));
        if (preview) {
            branch.preview = preview;
        } else if (branch.messages.length) {
            branch.preview = stripPreviewText(branch.messages[branch.messages.length - 1].mes) || 'Conversation ready';
        }
        branch.unread = parsePositiveInt(localStorage.getItem(getCharacterStorageKey(UNREAD_PREFIX, avatar)), 0, 0);
        branch.lastActivity = parsePositiveInt(localStorage.getItem(getCharacterStorageKey(LAST_USER_ACTIVITY_PREFIX, avatar)), branch.lastActivity, 1);
        branch.followupCount = parsePositiveInt(localStorage.getItem(getCharacterStorageKey(FOLLOWUP_COUNT_PREFIX, avatar)), 0, 0);
        branch.lastAutoMessageAt = parsePositiveInt(localStorage.getItem(getCharacterStorageKey(LAST_AUTO_MESSAGE_PREFIX, avatar)), 0, 0);
        try {
            branch.scheduleTriggers = JSON.parse(localStorage.getItem(getCharacterStorageKey(LAST_SCHEDULE_TRIGGER_PREFIX, avatar))) || {};
        } catch {
            branch.scheduleTriggers = {};
        }

        const scheduleRaw = localStorage.getItem(getScheduleStorageKey(avatar));
        if (scheduleRaw) {
            try {
                const schedule = JSON.parse(scheduleRaw);
                characterStore.schedule = schedule && typeof schedule === 'object' ? schedule : null;
            } catch {
                characterStore.schedule = null;
            }
        }
    }

    store.localStorageMigrated = true;
    persistConversationStore();
}

function getSettings(avatar = getCurrentCharAvatar()) {
    if (!avatar) {
        return { ...DEFAULT_SETTINGS };
    }

    return { ...DEFAULT_SETTINGS, ...getCharacterConversationStore(avatar).settings };
}

export function isConversationModeEnabled(avatar) {
    return Boolean(getCharacterConversationStore(avatar, { create: false })?.settings?.enabled);
}

export function getConversationWelcomeChats({ max = Infinity } = {}) {
    if (!Array.isArray(characters)) {
        return [];
    }

    const chats = [];
    const pushConversationChat = (character, threadStore, group = null) => {
        const avatar = character?.avatar;
        const settings = avatar ? getSettings(avatar) : { ...DEFAULT_SETTINGS };
        if (!avatar || !settings.enabled || !threadStore) {
            return;
        }

        const branchId = threadStore.activeBranchId || DEFAULT_BRANCH_ID;
        const branch = normalizeConversationBranch(threadStore.branches?.[branchId], branchId);
        const messages = Array.isArray(branch?.messages) ? branch.messages : [];
        if (group && !messages.length && !branch.unread && branch.preview === 'Conversation ready') {
            return;
        }

        const timestamp = parsePositiveInt(branch?.updatedAt || branch?.createdAt, Date.now(), 1);
        const date = new Date(timestamp);
        const branchName = branch?.name && branch.name !== 'Main' ? branch.name : 'Conversation Mode';
        const groupName = group?.name || '';
        chats.push({
            avatar,
            group: group?.id || '',
            char_name: groupName || character.name || 'Character',
            char_thumbnail: getThumbnailUrl('avatar', avatar),
            chat_name: groupName ? `${character.name || 'Character'} · ${branchName}` : branchName,
            file_name: groupName ? `${groupName} · ${character.name || 'Character'}` : branchName,
            mes: branch?.preview || getConversationMessagePreviewText(messages[messages.length - 1]) || 'Conversation ready',
            chat_items: messages.length,
            file_size: groupName ? 'Group DM' : 'DM',
            date_short: date.toLocaleDateString(),
            date_long: date.toLocaleString(),
            last_mes: timestamp,
            is_group: Boolean(group),
            is_agent: false,
            is_conversation: true,
            recent_chat_type: 'conversation',
            hidden: false,
            pinned: false,
        });
    };

    characters.forEach((character) => {
        const avatar = character?.avatar;
        if (!avatar) {
            return;
        }

        pushConversationChat(character, getConversationThreadStore(avatar, { create: false, groupId: '' }));
    });

    Object.entries(getConversationStore().characters || {}).forEach(([storeKey, threadStore]) => {
        const parsed = parseConversationThreadKey(storeKey);
        if (!parsed.groupId || !parsed.avatar) {
            return;
        }

        const character = getCharacterForAvatar(parsed.avatar);
        const group = getConversationGroupById(parsed.groupId);
        if (!character || !group) {
            return;
        }

        pushConversationChat(character, threadStore, group);
    });

    return chats
        .sort((first, second) => Number(second.last_mes || 0) - Number(first.last_mes || 0))
        .slice(0, Number.isFinite(max) ? max : undefined);
}

function saveSettings(avatar, settings) {
    if (!avatar) {
        return;
    }

    getCharacterConversationStore(avatar).settings = safeParseSettings(settings);
    persistConversationStore();
}

function getLastUserActivity(avatar, fallback = Date.now(), { groupId = getConversationGroupIdForAvatar(avatar) } = {}) {
    return parsePositiveInt(getActiveConversationBranch(avatar, { create: false, groupId })?.lastActivity, fallback, 1);
}

function setLastUserActivity(avatar, timestamp = Date.now(), { groupId = getConversationGroupIdForAvatar(avatar) } = {}) {
    const branch = getActiveConversationBranch(avatar, { groupId });
    if (branch) {
        branch.lastActivity = timestamp;
        branch.updatedAt = Date.now();
        persistConversationStore();
    }
}

function getFollowupCount(avatar, { groupId = getConversationGroupIdForAvatar(avatar) } = {}) {
    return parsePositiveInt(getActiveConversationBranch(avatar, { create: false, groupId })?.followupCount, 0, 0);
}

function setFollowupCount(avatar, count, { groupId = getConversationGroupIdForAvatar(avatar) } = {}) {
    const branch = getActiveConversationBranch(avatar, { groupId });
    if (branch) {
        branch.followupCount = Math.max(0, count);
        persistConversationStore();
    }
}

function resetFollowupCount(avatar, { groupId = getConversationGroupIdForAvatar(avatar) } = {}) {
    if (!avatar) {
        return;
    }

    setFollowupCount(avatar, 0, { groupId });
}

function getConversationSessionMarker(avatar, markerKey, { groupId = getConversationGroupIdForAvatar(avatar) } = {}) {
    return String(getActiveConversationBranch(avatar, { create: false, groupId })?.sessionMarkers?.[markerKey] ?? '');
}

function setConversationSessionMarker(avatar, markerKey, value, { groupId = getConversationGroupIdForAvatar(avatar) } = {}) {
    const branch = getActiveConversationBranch(avatar, { groupId });
    if (!branch) {
        return;
    }

    branch.sessionMarkers = branch.sessionMarkers && typeof branch.sessionMarkers === 'object' ? branch.sessionMarkers : {};
    branch.sessionMarkers[markerKey] = String(value);
    persistConversationStore();
}

function getConversationBranchActivityTime(avatar, { groupId = getConversationGroupIdForAvatar(avatar) } = {}) {
    const branch = getActiveConversationBranch(avatar, { create: false, groupId });
    return parsePositiveInt(branch?.updatedAt || branch?.createdAt, Date.now(), 1);
}

function getLastAutoCharacterChatTime(avatar, { groupId = getConversationGroupIdForAvatar(avatar) } = {}) {
    return parsePositiveInt(getConversationSessionMarker(avatar, AUTO_CHAT_LAST_SENT_MARKER, { groupId }), 0, 0);
}

function setLastAutoCharacterChatTime(avatar, timestamp = Date.now(), { groupId = getConversationGroupIdForAvatar(avatar) } = {}) {
    setConversationSessionMarker(avatar, AUTO_CHAT_LAST_SENT_MARKER, timestamp, { groupId });
}

function getAutoCharacterChatCooldownMs(settings) {
    return parsePositiveInt(settings?.auto_chat_cooldown, DEFAULT_AUTO_CHAT_COOLDOWN, 1) * 60 * 1000;
}

function getConversationMemorySummary(avatar = getCurrentCharAvatar(), { groupId = getConversationGroupIdForAvatar(avatar) } = {}) {
    return String(getActiveConversationBranch(avatar, { create: false, groupId })?.memorySummary || '').trim();
}

function saveConversationMemorySummary(avatar, summary, messageCount, { groupId = getConversationGroupIdForAvatar(avatar) } = {}) {
    const branch = getActiveConversationBranch(avatar, { groupId });
    if (!branch) {
        return;
    }

    branch.memorySummary = String(summary || '').trim();
    branch.memoryMessageCount = Math.max(0, messageCount || 0);
    persistConversationStore();
    renderConversationMemoryPanel();
}

function clearConversationMemorySummary(avatar = getCurrentCharAvatar(), { groupId = getConversationGroupIdForAvatar(avatar) } = {}) {
    const branch = getActiveConversationBranch(avatar, { create: false, groupId });
    if (!branch) {
        return false;
    }

    branch.memorySummary = '';
    branch.memoryMessageCount = 0;
    persistConversationStore();
    renderConversationMemoryPanel();
    return true;
}

function markConversationSeen(avatar = getCurrentCharAvatar(), timestamp = Date.now(), { groupId = getConversationGroupIdForAvatar(avatar) } = {}) {
    if (!avatar) {
        return;
    }

    setConversationSessionMarker(avatar, 'seen_at', timestamp, { groupId });
}

function getConversationSeenAt(avatar = getCurrentCharAvatar(), { groupId = getConversationGroupIdForAvatar(avatar) } = {}) {
    return parsePositiveInt(getConversationSessionMarker(avatar, 'seen_at', { groupId }), 0, 0);
}

function getImageCooldownRemainingSeconds(avatar, settings, now = Date.now(), { groupId = getConversationGroupIdForAvatar(avatar) } = {}) {
    const cooldownMinutes = parsePositiveInt(settings.image_gen_cooldown, 10, 0);
    if (!cooldownMinutes) {
        return 0;
    }

    const lastImageAt = parsePositiveInt(getConversationSessionMarker(avatar, 'image_at', { groupId }), 0, 0);
    const remainingMs = (cooldownMinutes * 60 * 1000) - (now - lastImageAt);
    return Math.max(0, Math.ceil(remainingMs / 1000));
}

function markImageGenerated(avatar, timestamp = Date.now(), { groupId = getConversationGroupIdForAvatar(avatar) } = {}) {
    setConversationSessionMarker(avatar, 'image_at', timestamp, { groupId });
}

function parseReminderDelayToMs(rawDelay) {
    const delay = String(rawDelay || '').trim().toLowerCase();
    if (!delay) {
        return 0;
    }

    const match = delay.match(/^(\d+(?:\.\d+)?)\s*(s|m|h|d|secs?|mins?|hours?|days?)$/);
    if (match) {
        const value = parseFloat(match[1]);
        const unit = match[2];
        if (unit.startsWith('s')) return value * 1000;
        if (unit.startsWith('m')) return value * 60 * 1000;
        if (unit.startsWith('h')) return value * 60 * 60 * 1000;
        if (unit.startsWith('d')) return value * 24 * 60 * 60 * 1000;
    }

    const numeric = parseFloat(delay);
    if (Number.isFinite(numeric) && numeric > 0) {
        return numeric * 60 * 1000;
    }

    const timeMatch = delay.match(/^(\d{1,2}):(\d{2})$/);
    if (timeMatch) {
        const hours = parseInt(timeMatch[1], 10);
        const minutes = parseInt(timeMatch[2], 10);
        const now = new Date();
        const target = new Date();
        target.setHours(hours, minutes, 0, 0);
        if (target.getTime() <= now.getTime()) {
            target.setDate(target.getDate() + 1);
        }
        return target.getTime() - now.getTime();
    }

    return 0;
}

function addConversationReminder(avatar, groupId, delayText, memoText) {
    const delayMs = parseReminderDelayToMs(delayText);
    if (delayMs <= 0) {
        console.warn(`Conversation Mode: invalid reminder delay "${delayText}"`);
        return null;
    }

    const triggerAt = Date.now() + delayMs;
    const store = getConversationStore();
    const characterStore = getConversationThreadStore(avatar, { groupId });
    const branchId = characterStore?.activeBranchId || DEFAULT_BRANCH_ID;

    const reminder = {
        id: `rem_${Date.now()}_${Math.random().toString(36).slice(2)}`,
        avatar,
        groupId: groupId || '',
        branchId,
        triggerAt,
        text: String(memoText || '').trim(),
        fired: false,
        createdAt: Date.now(),
    };

    store.reminders.push(reminder);
    persistConversationStore();

    const triggerLabel = new Date(triggerAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    toastr.info(`Reminder scheduled: "${reminder.text}" at ${triggerLabel}.`, '', SAFE_TOAST_OPTIONS);
    console.log('Conversation Mode: added reminder', reminder);
    return reminder;
}

function updateLastUserActivity(avatar = getCurrentCharAvatar(), { groupId = getConversationGroupIdForAvatar(avatar) } = {}) {
    if (!avatar) {
        return;
    }

    setLastUserActivity(avatar, Date.now(), { groupId });
    // Marinara-style: any user activity resets the escalating follow-up counter.
    resetFollowupCount(avatar, { groupId });
}

function createConversationMessage({ role = 'character', name = getCurrentCharName(), mes = '', extra = {} } = {}) {
    const createdAt = Date.now();
    return {
        id: `${createdAt}-${Math.random().toString(36).slice(2)}`,
        role,
        name,
        mes,
        send_date: getMessageTimeStamp(),
        created_at: createdAt,
        extra,
    };
}

function getConversationMediaAttachments(message) {
    return Array.isArray(message?.extra?.media) ? message.extra.media.filter(item => item?.url) : [];
}

function getConversationPromptMediaAttachments(message) {
    const media = getConversationMediaAttachments(message)
        .filter(item => String(item?.type || MEDIA_TYPE.IMAGE) === MEDIA_TYPE.IMAGE);
    const generatedImage = message?.extra?.image_url;
    if (typeof generatedImage === 'string' && generatedImage) {
        media.push({ url: generatedImage, type: MEDIA_TYPE.IMAGE, title: 'Generated image' });
    }

    return media;
}

function getConversationMediaDisplay(message) {
    const value = message?.extra?.media_display;
    return Object.values(MEDIA_DISPLAY).includes(value) ? value : MEDIA_DISPLAY.LIST;
}

function getConversationMediaIndex(message, media) {
    if (!Array.isArray(media) || !media.length) {
        return 0;
    }

    return clamp(parsePositiveInt(message?.extra?.media_index, 0, 0), 0, media.length - 1);
}

function getConversationFileAttachments(message) {
    return Array.isArray(message?.extra?.files) ? message.extra.files.filter(item => item?.url) : [];
}

function hasConversationMessageContent(message) {
    return Boolean(
        message?.id
        && (
            String(message.mes || '').trim()
            || getConversationMediaAttachments(message).length
            || getConversationFileAttachments(message).length
            || message.extra?.image_url
        ),
    );
}

function normalizeConversationStoredMessage(message, index = 0) {
    if (!message || typeof message !== 'object') {
        return message;
    }

    if (message.id) {
        return message;
    }

    const createdAt = parsePositiveInt(message.created_at || message.send_date || Date.now(), Date.now(), 0);
    return {
        ...message,
        id: `legacy-${createdAt}-${index}`,
        created_at: message.created_at || createdAt,
    };
}

function getConversationAttachmentLabels(message) {
    const labels = [];
    const generatedImage = message?.extra?.image_url;
    if (typeof generatedImage === 'string' && generatedImage) {
        labels.push('generated image');
    }

    for (const media of getConversationMediaAttachments(message)) {
        const title = String(media.title || '').trim();
        const type = String(media.type || 'media').trim() || 'media';
        labels.push(title ? `${type}: ${title}` : type);
    }

    for (const file of getConversationFileAttachments(message)) {
        const name = String(file.name || '').trim();
        labels.push(name ? `file: ${name}` : 'file');
    }

    return labels;
}

function getConversationAttachmentSummary(message) {
    const labels = getConversationAttachmentLabels(message);
    return labels.length ? `[Attachments: ${labels.join('; ')}]` : '';
}

function getConversationMessagePreviewText(message) {
    return stripPreviewText(message?.mes) || stripPreviewText(getConversationAttachmentLabels(message).join(', '));
}

function safeParseThread(stored) {
    if (!stored) {
        return [];
    }

    try {
        const parsed = typeof stored === 'string' ? JSON.parse(stored) : stored;
        return Array.isArray(parsed)
            ? parsed.map(normalizeConversationStoredMessage).filter(hasConversationMessageContent)
            : [];
    } catch {
        return [];
    }
}

function getConversationThread(avatar = getCurrentCharAvatar(), { groupId = getConversationGroupIdForAvatar(avatar) } = {}) {
    if (!avatar) {
        return [];
    }

    return [...(getActiveConversationBranch(avatar, { groupId })?.messages ?? [])];
}

function saveConversationThread(avatar, messages, { groupId = getConversationGroupIdForAvatar(avatar) } = {}) {
    if (!avatar) {
        return;
    }

    const branch = getActiveConversationBranch(avatar, { groupId });
    if (!branch) {
        return;
    }

    branch.messages = safeParseThread(messages).slice(-MAX_THREAD_MESSAGES);
    branch.updatedAt = Date.now();
    persistConversationStore();
}

function appendConversationThreadMessage(avatar, messageInput, { groupId = getConversationGroupIdForAvatar(avatar) } = {}) {
    const messages = getConversationThread(avatar, { groupId });
    const message = createConversationMessage(messageInput);
    messages.push(message);
    saveConversationThread(avatar, messages, { groupId });
    setLastConversationPreview(avatar, getConversationMessagePreviewText(message), { groupId });
    if (isConversationActiveThread(avatar, groupId)) {
        renderConversationTimeline();
    }
    return message;
}

function updateConversationThreadMessage(avatar, messageId, messageText, extra = null, { groupId = getConversationGroupIdForAvatar(avatar) } = {}) {
    const messages = getConversationThread(avatar, { groupId });
    const message = messages.find(item => item.id === messageId);
    if (!message) {
        return;
    }

    message.mes = messageText;
    if (extra && typeof extra === 'object') {
        message.extra = { ...message.extra, ...extra };
    }
    saveConversationThread(avatar, messages, { groupId });
    updateLastPreviewFromConversation(avatar, { groupId });
    if (isConversationActiveThread(avatar, groupId)) {
        renderConversationTimeline();
    }
}

function getAvailabilityCopy(status) {
    return AVAILABILITY_COPY[status] ?? AVAILABILITY_COPY.online;
}

function getUserStatus() {
    const status = getConversationStore().userStatus || localStorage.getItem(USER_STATUS_STORAGE_KEY) || 'online';
    return USER_STATUS_OPTIONS.includes(status) ? status : 'online';
}

function normalizeUserPersonaStatus(value) {
    return String(value || '').replace(/\s+/g, ' ').trim().slice(0, 80);
}

function getUserPersonaStatus() {
    return normalizeUserPersonaStatus(getConversationStore().userPersonaStatus);
}

function setUserStatus(status) {
    if (USER_STATUS_OPTIONS.includes(status)) {
        getConversationStore().userStatus = status;
        persistConversationStore();
    }
}

function setUserPersonaStatus(statusText) {
    getConversationStore().userPersonaStatus = normalizeUserPersonaStatus(statusText);
    persistConversationStore();
}

function editUserPersonaStatus() {
    const nextStatus = globalThis.prompt?.('Set your Conversation persona status. Leave blank to clear it.', getUserPersonaStatus());
    if (typeof nextStatus !== 'string') {
        return;
    }

    setUserPersonaStatus(nextStatus);
    document.getElementById(CHROME_IDS.personaPicker)?.setAttribute('hidden', '');
    document.getElementById(CHROME_IDS.userStatusPicker)?.setAttribute('hidden', '');
    updateUserFooter();
}

function safeParseWeeklySchedule(value) {
    try {
        const parsed = JSON.parse(value || '[]');
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

function getConnectionProfiles() {
    return extension_settings.connectionManager?.profiles ?? [];
}

function getPersonaOptions() {
    const personas = power_user?.personas;
    if (!personas || typeof personas !== 'object') {
        return [];
    }

    return Object.entries(personas).map(([avatarId, personaName]) => ({ avatarId, personaName: String(personaName) }));
}

function getConversationPersonaAppendixScopeKey() {
    const avatar = getCurrentCharAvatar();
    return String(getConversationThreadKey(avatar) || PERSONA_APPENDICES_DEFAULT_SCOPE_KEY);
}

function getConversationPersonaAppendices(avatarId) {
    const descriptor = power_user?.persona_descriptions?.[avatarId];
    if (!descriptor || !Array.isArray(descriptor.appendices)) {
        return [];
    }

    return descriptor.appendices.map((appendix, index) => {
        const name = String(appendix?.name || `Scenario Note ${index + 1}`).trim() || `Scenario Note ${index + 1}`;
        const id = String(appendix?.id || `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${index}`).trim();
        return {
            id,
            name,
            description: String(appendix?.description ?? ''),
        };
    }).filter(appendix => appendix.id);
}

function getActiveConversationPersonaAppendixIds(avatarId) {
    const descriptor = power_user?.persona_descriptions?.[avatarId];
    const appendices = getConversationPersonaAppendices(avatarId);
    const appendixIds = new Set(appendices.map(appendix => appendix.id));
    const selections = descriptor?.[PERSONA_APPENDICES_SELECTIONS_KEY];
    const scopeKey = getConversationPersonaAppendixScopeKey();
    const activeIds = selections && typeof selections === 'object' && !Array.isArray(selections)
        ? selections[scopeKey] ?? selections[PERSONA_APPENDICES_DEFAULT_SCOPE_KEY] ?? []
        : [];
    return Array.isArray(activeIds)
        ? activeIds.map(String).filter((id, index, array) => appendixIds.has(id) && array.indexOf(id) === index)
        : [];
}

function composeConversationPersonaDescription(avatarId) {
    const descriptor = power_user?.persona_descriptions?.[avatarId];
    const chunks = [];
    const baseDescription = String(descriptor?.description ?? '').trim();

    if (baseDescription) {
        chunks.push(baseDescription);
    }

    const activeIds = new Set(getActiveConversationPersonaAppendixIds(avatarId));
    for (const appendix of getConversationPersonaAppendices(avatarId)) {
        if (activeIds.has(appendix.id) && appendix.description.trim()) {
            chunks.push(`[${appendix.name}]\n${appendix.description.trim()}`);
        }
    }

    return chunks.join('\n\n');
}

function setActiveConversationPersonaAppendixIds(avatarId, ids) {
    const descriptor = power_user?.persona_descriptions?.[avatarId];
    if (!descriptor) {
        return;
    }

    const availableIds = new Set(getConversationPersonaAppendices(avatarId).map(appendix => appendix.id));
    const cleanIds = ids.map(String).filter((id, index, array) => availableIds.has(id) && array.indexOf(id) === index);
    const selections = descriptor[PERSONA_APPENDICES_SELECTIONS_KEY]
        && typeof descriptor[PERSONA_APPENDICES_SELECTIONS_KEY] === 'object'
        && !Array.isArray(descriptor[PERSONA_APPENDICES_SELECTIONS_KEY])
        ? descriptor[PERSONA_APPENDICES_SELECTIONS_KEY]
        : {};
    selections[getConversationPersonaAppendixScopeKey()] = cleanIds;
    descriptor[PERSONA_APPENDICES_SELECTIONS_KEY] = selections;

    if (avatarId === user_avatar) {
        power_user.persona_description = composeConversationPersonaDescription(avatarId);
    }

    saveSettingsDebounced();
    void eventSource.emit(event_types.PERSONA_UPDATED, avatarId);
}

async function applyConnectionProfileByName(profileName) {
    if (!profileName) {
        return;
    }

    try {
        await executeSlashCommandsWithOptions(`/profile ${quoteSlashArg(profileName)}`, {});
    } catch (error) {
        console.warn('Conversation Mode: could not apply connection profile', profileName, error);
    }
}

function quoteSlashArg(value) {
    return `"${String(value ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r?\n/g, '\\n')}"`;
}

function queueConversationProfileSwitch(task) {
    const run = conversationProfileSwitchQueue.catch(() => {}).then(task);
    conversationProfileSwitchQueue = run.catch(() => {});
    return run;
}

async function withConversationConnectionProfile(settings, task) {
    const profileName = String(settings?.connection_profile || '').trim();
    if (!profileName) {
        return task();
    }

    return queueConversationProfileSwitch(async () => {
        const previousProfile = getSelectedConnectionProfileName();
        const shouldSwitch = previousProfile !== profileName;
        if (shouldSwitch) {
            await applyConnectionProfileByName(profileName);
        }

        try {
            return await task();
        } finally {
            if (shouldSwitch && previousProfile) {
                await applyConnectionProfileByName(previousProfile);
            }
        }
    });
}

async function generateConversationImage(prompt, negative = '') {
    if (imageGenerationActive) {
        return null;
    }

    imageGenerationActive = true;
    imageGenerationAbortController = new AbortController();
    renderConversationTimeline();
    try {
        const qig = await import('./extensions/quick-image-gen/index.js');
        const entry = await qig.withTransientGenerationSettings({}, async () => {
            const settings = qig.getGenerationSettingsForRun();
            const raw = await qig.generateForProvider(prompt, negative, settings, imageGenerationAbortController.signal, {});
            return raw ? qig.finalizeGeneratedEntry(raw, prompt, negative, settings, {}) : null;
        });

        return entry?.url ?? null;
    } catch (error) {
        console.warn('Conversation Mode: QIG not available or generation failed', error);
        return null;
    } finally {
        imageGenerationActive = false;
        imageGenerationAbortController = null;
        renderConversationTimeline();
    }
}

function getCharacterForAvatar(avatar = getCurrentCharAvatar()) {
    if (!avatar) {
        return getCurrentCharacter();
    }

    return (Array.isArray(characters) ? characters : []).find(character => character?.avatar === avatar) || null;
}

function getCharacterIndexForAvatar(avatar) {
    return (Array.isArray(characters) ? characters : []).findIndex(character => character?.avatar === avatar);
}

function addUniqueAvatar(avatars, avatar, currentAvatar = '') {
    if (!avatar || avatar === currentAvatar || avatars.includes(avatar)) {
        return;
    }

    avatars.push(avatar);
}

function getConversationPartnerAvatars(avatar = getCurrentCharAvatar(), settings = getSettings(avatar), { includeThreadPartners = true, groupId = getConversationGroupIdForAvatar(avatar) } = {}) {
    const partnerAvatars = [];
    parseAvatarList(settings?.multi_char_names).forEach(partnerAvatar => addUniqueAvatar(partnerAvatars, partnerAvatar, avatar));

    const group = getConversationGroupById(groupId);
    if (group?.members?.length) {
        group.members
            .filter(memberAvatar => !group.disabled_members?.includes(memberAvatar))
            .forEach(memberAvatar => addUniqueAvatar(partnerAvatars, memberAvatar, avatar));
    }

    if (includeThreadPartners) {
        getConversationThread(avatar, { groupId }).forEach((message) => {
            if (message?.role !== 'partner') {
                return;
            }

            addUniqueAvatar(partnerAvatars, message.extra?.partner_avatar, avatar);
        });
    }

    return partnerAvatars.filter(partnerAvatar => getCharacterForAvatar(partnerAvatar));
}

function getConversationParticipants(avatar = getCurrentCharAvatar(), settings = getSettings(avatar), options = {}) {
    const participants = [];
    const primary = getCharacterForAvatar(avatar);
    if (primary?.avatar) {
        participants.push(primary);
    }

    getConversationPartnerAvatars(avatar, settings, options).forEach((partnerAvatar) => {
        const partner = getCharacterForAvatar(partnerAvatar);
        if (partner?.avatar && !participants.some(participant => participant.avatar === partner.avatar)) {
            participants.push(partner);
        }
    });

    return participants;
}

function getEffectiveConversationStatus(avatar = getCurrentCharAvatar(), settings = getSettings(avatar)) {
    const schedule = getStoredSchedule(avatar);
    if (schedule) {
        return getCurrentActivityFromSchedule(schedule, avatar).status;
    }

    return settings?.availability || DEFAULT_SETTINGS.availability;
}

function getParticipantNamesForDisplay(participants) {
    return participants
        .map(participant => participant?.name || 'Character')
        .filter(Boolean);
}

function renderConversationParticipantStack(container, participants, { status = 'online', max = MAX_STACKED_PARTICIPANT_AVATARS } = {}) {
    if (!(container instanceof HTMLElement)) {
        return;
    }

    const participantList = Array.isArray(participants) ? participants : [];
    const visibleParticipants = participantList.filter(participant => participant?.avatar).slice(0, max);
    container.textContent = '';
    container.title = getParticipantNamesForDisplay(participantList).join(', ');

    if (!visibleParticipants.length) {
        const fallbackItem = document.createElement('span');
        fallbackItem.className = 'sb-conversation-participant-avatar';
        fallbackItem.dataset.primary = 'true';
        const fallbackImage = document.createElement('img');
        fallbackImage.alt = '';
        fallbackImage.loading = 'lazy';
        fallbackImage.src = default_user_avatar;
        fallbackItem.appendChild(fallbackImage);
        container.appendChild(fallbackItem);
        return;
    }

    visibleParticipants.forEach((participant, index) => {
        const avatarItem = document.createElement('span');
        avatarItem.className = 'sb-conversation-participant-avatar';
        avatarItem.dataset.primary = String(index === 0);

        const image = document.createElement('img');
        image.alt = '';
        image.loading = index > 0 ? 'lazy' : 'eager';
        image.src = getThumbnailUrl('avatar', participant.avatar) || default_user_avatar;
        avatarItem.appendChild(image);

        if (index === 0) {
            const statusDot = document.createElement('span');
            statusDot.className = 'sb-conversation-status-dot';
            statusDot.dataset.status = status;
            statusDot.setAttribute('aria-hidden', 'true');
            avatarItem.appendChild(statusDot);
        }

        container.appendChild(avatarItem);
    });

    if (participantList.length > visibleParticipants.length) {
        const overflow = document.createElement('span');
        overflow.className = 'sb-conversation-participant-overflow';
        overflow.textContent = `+${participantList.length - visibleParticipants.length}`;
        overflow.setAttribute('aria-hidden', 'true');
        container.appendChild(overflow);
    }
}

function getCharacterImageDetails(avatar = getCurrentCharAvatar()) {
    const character = getCharacterForAvatar(avatar);
    if (!character) {
        return '';
    }

    return [
        character.description ? `Description: ${character.description}` : '',
        character.personality ? `Personality: ${character.personality}` : '',
        character.scenario ? `Context: ${character.scenario}` : '',
        character.data?.creator_notes ? `Creator notes: ${character.data.creator_notes}` : '',
    ].filter(Boolean).map(value => formatPromptText(value, 900)).join('\n');
}

function getCharacterAuthorNote(avatar = getCurrentCharAvatar()) {
    const character = getCharacterForAvatar(avatar);
    return String(character?.data?.extensions?.depth_prompt?.prompt || '').trim();
}

function getConversationDisplayName(avatar = getCurrentCharAvatar(), settings = getSettings(avatar), { groupId = getConversationGroupIdForAvatar(avatar) } = {}) {
    const branch = getActiveConversationBranch(avatar, { create: false, groupId });
    if (branch?.name && branch.name !== 'Main') {
        return branch.name;
    }

    const names = getParticipantNamesForDisplay(getConversationParticipants(avatar, settings, { groupId }));
    return names.length ? names.join(', ') : 'Conversation';
}

function buildCharacterImagePrompt(template, scene = 'the current DM conversation', avatar = getCurrentCharAvatar()) {
    const character = getCharacterForAvatar(avatar);
    const charName = character?.name || getCurrentCharName();
    const details = getCharacterImageDetails(avatar);
    const basePrompt = String(template || DEFAULT_SETTINGS.image_gen_prompt_template)
        .replace(/\{\{char\}\}/g, charName)
        .replace(/\{\{scene\}\}/g, scene)
        .replace(/\{\{appearance\}\}/g, details || `${charName}'s established appearance`);

    if (!details) {
        return basePrompt;
    }

    return [
        basePrompt,
        `Depict ${charName} specifically, not a generic person. Use these character-card details: ${details}`,
    ].join('\n');
}

function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

function getConversationReplyMaxTokens(settings = {}) {
    return clamp(
        parsePositiveInt(settings?.reply_max_tokens, DEFAULT_CONVERSATION_REPLY_MAX_TOKENS, MIN_CONVERSATION_REPLY_MAX_TOKENS),
        MIN_CONVERSATION_REPLY_MAX_TOKENS,
        MAX_CONVERSATION_REPLY_MAX_TOKENS,
    );
}

function getScheduleStorageKey(avatar) {
    return `${SCHEDULE_PREFIX}${avatar}`;
}

function getStoredSchedule(avatar = getCurrentCharAvatar()) {
    if (!avatar) {
        return null;
    }

    const schedule = getCharacterConversationStore(avatar, { create: false })?.schedule;
    return schedule && typeof schedule === 'object' ? schedule : null;
}

function saveStoredSchedule(avatar, schedule) {
    if (!avatar) {
        return;
    }

    const characterStore = getCharacterConversationStore(avatar);
    characterStore.schedule = schedule && typeof schedule === 'object' ? schedule : null;
    persistConversationStore();
}

function inferStatusFromActivity(activity) {
    const text = String(activity || '').toLowerCase();
    if (/sleep|asleep|nap|passed out|unconscious|bed|resting/.test(text)) {
        return 'offline';
    }
    if (/work|working|class|study|studying|meeting|training|focus|exam|shift|busy/.test(text)) {
        return 'dnd';
    }
    if (/eat|eating|commut|shower|cook|driving|errand|gym|lunch|dinner|breakfast/.test(text)) {
        return 'idle';
    }
    return 'online';
}

function repairScheduleJson(raw) {
    let text = String(raw || '').trim();
    // Strip markdown code fences.
    text = text.replace(/```(?:json)?/gi, '').trim();
    // Extract the outermost JSON object if extra prose surrounds it.
    const firstBrace = text.indexOf('{');
    const lastBrace = text.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
        text = text.slice(firstBrace, lastBrace + 1);
    }
    // Remove trailing commas before } or ].
    text = text.replace(/,\s*([}\]])/g, '$1');
    return text;
}

function normalizeScheduleBlock(block) {
    if (!block || typeof block !== 'object') {
        return null;
    }

    const time = String(block.time || '').trim();
    const activity = String(block.activity || '').trim();
    if (!time || !activity) {
        return null;
    }

    let status = String(block.status || '').toLowerCase().trim();
    if (!SCHEDULE_STATUSES.includes(status)) {
        status = inferStatusFromActivity(activity);
    }

    return { time, activity, status };
}

function parseScheduleResponse(rawText) {
    let parsed;
    try {
        parsed = JSON.parse(repairScheduleJson(rawText));
    } catch (error) {
        console.warn('Conversation Mode: failed to parse generated schedule', error);
        return null;
    }

    if (!parsed || typeof parsed !== 'object') {
        return null;
    }

    const days = {};
    const sourceDays = parsed.days && typeof parsed.days === 'object' ? parsed.days : parsed;
    let hasAnyBlock = false;
    for (let day = 0; day < 7; day++) {
        const dayKeys = [String(day), WEEKDAY_LABELS[day], WEEKDAY_LABELS[day].toLowerCase()];
        let blocks = null;
        for (const key of dayKeys) {
            if (Array.isArray(sourceDays?.[key])) {
                blocks = sourceDays[key];
                break;
            }
        }
        const normalized = Array.isArray(blocks)
            ? blocks.map(normalizeScheduleBlock).filter(Boolean)
            : [];
        if (normalized.length) {
            hasAnyBlock = true;
        }
        days[day] = normalized;
    }

    if (!hasAnyBlock) {
        return null;
    }

    const talkativeness = clamp(parsePositiveInt(parsed.talkativeness, DEFAULT_TALKATIVENESS, 0), 0, 100);
    const inactivityThresholdMinutes = clamp(
        parsePositiveInt(parsed.inactivityThresholdMinutes ?? parsed.inactivity_threshold, DEFAULT_INACTIVITY_THRESHOLD, MIN_INACTIVITY_THRESHOLD),
        MIN_INACTIVITY_THRESHOLD,
        MAX_INACTIVITY_THRESHOLD,
    );

    return {
        days,
        talkativeness,
        inactivityThresholdMinutes,
        generatedAt: Date.now(),
    };
}

async function generateCharacterSchedule(character) {
    if (!character) {
        return null;
    }

    const name = character.name || 'The character';
    const description = formatPromptText(character.description || '', 1800);
    const personality = formatPromptText(character.personality || '', 1200);

    const systemPrompt = [
        'You are a schedule generator. Create a realistic weekly schedule for a character based on their personality and description.',
        'Each time block must include a "status" field indicating availability:',
        '- "online": awake and available (free time, socializing, casual activities)',
        '- "idle": semi-available (eating, commuting, showering, cooking)',
        '- "dnd": busy / do not disturb (working, studying, training, in a meeting, focused tasks)',
        '- "offline": unavailable (sleeping, passed out, unconscious)',
        'Also assess the character\'s talkativeness on a scale of 0-100 (how often they initiate contact).',
        'And estimate how long in minutes this character would wait before messaging someone who has not replied (very patient: 180-360, average: 90-150, eager: 15-60).',
        'RESPOND IN EXACTLY THIS JSON FORMAT (no markdown, no code blocks, just raw JSON):',
        '{"talkativeness":50,"inactivityThresholdMinutes":120,"days":{"0":[{"time":"08:00-12:00","activity":"working","status":"dnd"}],"1":[],"2":[],"3":[],"4":[],"5":[],"6":[]}}',
        'Days are keyed 0=Sunday through 6=Saturday. Cover each day with several blocks spanning a full 24 hours including sleep.',
    ].join('\n');

    const promptParts = [`Character name: ${name}`];
    if (description) {
        promptParts.push(`Description: ${description}`);
    }
    if (personality) {
        promptParts.push(`Personality: ${personality}`);
    }
    promptParts.push('Generate the weekly schedule JSON now.');

    const settings = getSettings(character.avatar);
    const response = await withConversationConnectionProfile(settings, () => generateRaw({
        prompt: promptParts.join('\n\n'),
        systemPrompt,
        responseLength: 1400,
        trimNames: false,
        cacheScope: 'conversation-mode-schedule',
    }));

    return parseScheduleResponse(response);
}

function parseScheduleTimeRange(range) {
    const match = String(range || '').match(/(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})/);
    if (!match) {
        return null;
    }

    const startMinutes = parseInt(match[1], 10) * 60 + parseInt(match[2], 10);
    const endMinutes = parseInt(match[3], 10) * 60 + parseInt(match[4], 10);
    return { startMinutes, endMinutes };
}

function getCurrentActivityFromSchedule(schedule, avatar = getCurrentCharAvatar(), now = new Date()) {
    // Runtime self-override from [schedule_update] commands takes precedence.
    if (avatar && runtimeStatusOverrides.has(avatar)) {
        const override = runtimeStatusOverrides.get(avatar);
        if (override.expiresAt > now.getTime()) {
            return { status: override.status, activity: override.activity, source: 'override' };
        }
        runtimeStatusOverrides.delete(avatar);
    }

    if (!schedule || !schedule.days) {
        return { status: 'online', activity: 'free time', source: 'default' };
    }

    const day = now.getDay();
    const nowMinutes = now.getHours() * 60 + now.getMinutes();
    const blocks = Array.isArray(schedule.days[day]) ? schedule.days[day] : [];

    for (const block of blocks) {
        const range = parseScheduleTimeRange(block.time);
        if (!range) {
            continue;
        }

        const { startMinutes, endMinutes } = range;
        const inRange = startMinutes <= endMinutes
            ? nowMinutes >= startMinutes && nowMinutes < endMinutes
            : nowMinutes >= startMinutes || nowMinutes < endMinutes; // midnight wrap
        if (inRange) {
            return { status: block.status, activity: block.activity, source: 'schedule' };
        }
    }

    return { status: 'online', activity: 'free time', source: 'default' };
}

function parseDurationToMs(text) {
    const match = String(text || '').match(/(?:(\d+)\s*h)?\s*(?:(\d+)\s*m)?/i);
    if (!match) {
        return 0;
    }
    const hours = parseInt(match[1] || '0', 10);
    const minutes = parseInt(match[2] || '0', 10);
    return (hours * 60 + minutes) * 60 * 1000;
}

function getUnreadCount(avatar, { groupId = getConversationGroupIdForAvatar(avatar) } = {}) {
    return parsePositiveInt(getActiveConversationBranch(avatar, { create: false, groupId })?.unread, 0, 0);
}

function setUnreadCount(avatar, count, { groupId = getConversationGroupIdForAvatar(avatar) } = {}) {
    const branch = getActiveConversationBranch(avatar, { groupId });
    if (branch) {
        branch.unread = Math.max(0, count);
        persistConversationStore();
    }
}

function clearUnreadCount(avatar, { groupId = getConversationGroupIdForAvatar(avatar) } = {}) {
    setUnreadCount(avatar, 0, { groupId });
}

function incrementUnreadCount(avatar, { groupId = getConversationGroupIdForAvatar(avatar) } = {}) {
    if (!avatar) {
        return;
    }

    setUnreadCount(avatar, getUnreadCount(avatar, { groupId }) + 1, { groupId });
}

function getTotalUnreadCount() {
    return getConversationRailItems().reduce((sum, item) => sum + getUnreadCount(item.character.avatar, { groupId: item.groupId }), 0);
}

function getBadgeLabel(count) {
    return count > 99 ? '99+' : String(count || '');
}

function getDocumentTitleBase() {
    const currentTitle = String(document.title || '').replace(/^\(\d+\+?\)\s+/, '').trim();
    if (!originalDocumentTitle || /^\(\d+\+?\)\s+/.test(originalDocumentTitle)) {
        originalDocumentTitle = currentTitle || 'SillyBunny';
    }
    return originalDocumentTitle;
}

function getFaviconLink() {
    let link = document.querySelector('link[rel~="icon"]');
    if (!(link instanceof HTMLLinkElement)) {
        link = document.createElement('link');
        link.rel = 'icon';
        document.head.appendChild(link);
    }

    if (!originalFaviconHref && link.href) {
        originalFaviconHref = link.href;
    }
    return link;
}

function updateConversationTitleBadge(totalUnread = getTotalUnreadCount()) {
    const baseTitle = getDocumentTitleBase();
    document.title = totalUnread > 0 ? `(${getBadgeLabel(totalUnread)}) ${baseTitle}` : baseTitle;
}

function updateConversationFaviconBadge(totalUnread = getTotalUnreadCount()) {
    const link = getFaviconLink();
    const sourceHref = originalFaviconHref || link.href;
    if (!sourceHref) {
        return;
    }

    const token = ++faviconUpdateToken;
    if (totalUnread <= 0) {
        link.href = sourceHref;
        return;
    }

    const image = new Image();
    image.onload = () => {
        if (token !== faviconUpdateToken) {
            return;
        }

        const canvas = document.createElement('canvas');
        canvas.width = 32;
        canvas.height = 32;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
            return;
        }

        ctx.drawImage(image, 0, 0, 32, 32);
        ctx.fillStyle = '#fb7185';
        ctx.beginPath();
        ctx.arc(23, 9, 8, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#1b1f26';
        ctx.font = '700 9px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(totalUnread > 9 ? '9+' : String(totalUnread), 23, 9);
        try {
            link.href = canvas.toDataURL('image/png');
        } catch (error) {
            console.warn('Conversation Mode: favicon badge failed', error);
        }
    };
    image.onerror = () => {
        if (token === faviconUpdateToken) {
            link.href = sourceHref;
        }
    };
    image.src = sourceHref;
}

function updatePalsToggleBadge(totalUnread = getTotalUnreadCount()) {
    const badge = document.querySelector(`#${CHROME_IDS.palsToggle} .sb-conversation-pals-toggle-badge`);
    if (!(badge instanceof HTMLElement)) {
        return;
    }

    badge.textContent = getBadgeLabel(totalUnread);
    badge.hidden = totalUnread <= 0;
}

function updateConversationTabBadge(totalUnread = getTotalUnreadCount()) {
    const tabButton = document.getElementById('sb_character_tab_conversation');
    if (!tabButton) {
        return;
    }
    let badge = tabButton.querySelector('.sb-tab-notification-badge');
    if (!badge) {
        badge = document.createElement('span');
        badge.className = 'sb-tab-notification-badge';
        tabButton.appendChild(badge);
    }
    badge.textContent = getBadgeLabel(totalUnread);
    badge.style.display = totalUnread > 0 ? 'inline-flex' : 'none';
}

function updateCharactersDrawerBadge(totalUnread = getTotalUnreadCount()) {
    const ids = ['rm_button_characters', 'rightNavDrawerIcon'];
    for (const id of ids) {
        const drawerButton = document.getElementById(id);
        if (!drawerButton) {
            continue;
        }
        let badge = drawerButton.querySelector('.sb-drawer-notification-badge');
        if (!badge) {
            badge = document.createElement('span');
            badge.className = 'sb-drawer-notification-badge';
            drawerButton.appendChild(badge);
        }
        badge.style.display = totalUnread > 0 ? 'block' : 'none';
    }
}

function updateConversationNotificationIndicators() {
    const totalUnread = getTotalUnreadCount();
    updatePalsToggleBadge(totalUnread);
    updateConversationTitleBadge(totalUnread);
    updateConversationFaviconBadge(totalUnread);
    updateConversationTabBadge(totalUnread);
    updateCharactersDrawerBadge(totalUnread);
}

function getActiveConversationThreadKey() {
    if (!conversationWorkspaceOpen) {
        return '';
    }

    return getConversationThreadKey(getCurrentCharAvatar(), conversationSelectedGroupId || '');
}

function isConversationActiveThread(avatar, groupId = getConversationGroupIdForAvatar(avatar)) {
    return Boolean(
        conversationWorkspaceOpen
        && avatar
        && getConversationThreadKey(avatar, groupId || '') === getActiveConversationThreadKey(),
    );
}

function isConversationActiveForAvatar(avatar) {
    return isConversationActiveThread(avatar);
}

function openConversationFromNotification(avatar, { groupId = null } = {}) {
    if (!openConversationWorkspaceForAvatar(avatar, { groupId, showToast: false })) {
        return;
    }
}

function showConversationToast(avatar, message, { groupId = null } = {}) {
    const toastr = globalThis.toastr;
    if (!toastr?.info) {
        return;
    }

    const character = getCharacterForAvatar(avatar);
    const title = `New DM from ${message.name || character?.name || 'Character'}`;
    const preview = stripPreviewText(message.mes) || 'New Conversation message';
    toastr.info(preview, title, {
        ...SAFE_TOAST_OPTIONS,
        timeOut: 6000,
        onclick: () => openConversationFromNotification(avatar, { groupId }),
    });
}

function notifyNewConversationMessage(avatar, message, shouldNotify, { groupId = null } = {}) {
    updateConversationNotificationIndicators();
    if (!shouldNotify || !message || message.role === 'user' || message.role === 'system') {
        return;
    }

    const settings = getSettings(avatar);
    if (!shouldSurfaceConversationNotification(settings)) {
        return;
    }

    try {
        playMessageSound({ force: true });
    } catch (error) {
        console.warn('Conversation Mode: notification sound failed', error);
    }

    showConversationToast(avatar, message, { groupId });
}

function parseAvatarList(value) {
    return String(value || '')
        .split(',')
        .map(part => part.trim())
        .filter(Boolean);
}

function getAllowedPartnerCharacters(selectedAvatars, currentAvatar = getCurrentCharAvatar(), settings = getSettings(currentAvatar), { groupId = getConversationGroupIdForAvatar(currentAvatar), includeThreadPartners = true } = {}) {
    const configuredAvatars = Array.isArray(selectedAvatars)
        ? selectedAvatars
        : parseAvatarList(selectedAvatars ?? settings?.multi_char_names);
    const avatars = Array.from(new Set([
        ...configuredAvatars,
        ...getConversationPartnerAvatars(currentAvatar, {
            ...settings,
            multi_char_names: configuredAvatars.join(','),
        }, { groupId, includeThreadPartners }),
    ]));
    return avatars
        .map(avatar => getCharacterForAvatar(avatar))
        .filter(character => character?.avatar && character.avatar !== currentAvatar);
}

function getLastUserConversationText(avatar, { groupId = getConversationGroupIdForAvatar(avatar) } = {}) {
    const userMessage = [...getConversationThread(avatar, { groupId })].reverse().find(message => message?.role === 'user' && message.mes);
    return userMessage?.mes || '';
}

function hasMentionBoundaryMatch(messageText, mention) {
    const needle = String(mention || '').toLowerCase().trim();
    if (!messageText || !needle) {
        return false;
    }

    const pattern = new RegExp(`(^|[^a-z0-9_])${escapeRegExp(needle)}($|[^a-z0-9_])`, 'i');
    return pattern.test(messageText);
}

function getCharacterMentionHandles(character) {
    const charName = String(character?.name || '').trim();
    if (!charName) {
        return [];
    }

    const parts = charName.split(/[\s_-]+/).filter(part => part.length > 2);
    return Array.from(new Set([
        `@${charName}`,
        `@${charName.replace(/[\s_-]+/g, '')}`,
        ...parts.map(part => `@${part}`),
    ].map(handle => handle.trim()).filter(handle => handle.length > 1)));
}

function isCharacterMentionedInText(character, text, candidates = []) {
    const messageText = String(text || '').toLowerCase();
    const charName = String(character?.name || '').toLowerCase().trim();
    if (!messageText || !charName) {
        return false;
    }

    if (getCharacterMentionHandles(character).some(handle => hasMentionBoundaryMatch(messageText, handle))) {
        return true;
    }

    if (hasMentionBoundaryMatch(messageText, charName)) {
        return true;
    }

    const candidateList = Array.isArray(candidates) && candidates.length ? candidates : [character];
    return charName
        .split(/[\s_-]+/)
        .filter(part => part.length > 2)
        .filter((part) => {
            const partMatches = candidateList.filter(candidate => String(candidate?.name || '').toLowerCase().split(/[\s_-]+/).includes(part));
            return partMatches.length === 1;
        })
        .some(part => hasMentionBoundaryMatch(messageText, part));
}

function chooseConversationPartner(avatar, selectedAvatars, settings = getSettings(avatar), { groupId = getConversationGroupIdForAvatar(avatar) } = {}) {
    const partners = getAllowedPartnerCharacters(selectedAvatars, avatar, settings, { groupId });
    if (!partners.length) {
        return null;
    }

    const lastUserText = getLastUserConversationText(avatar, { groupId });
    const mentioned = partners.find(character => isCharacterMentionedInText(character, lastUserText, partners));
    return mentioned || (Math.random() < 0.75 ? getLeastRecentPartner(avatar, selectedAvatars, settings, { groupId }) : partners[Math.floor(Math.random() * partners.length)]);
}

function getConversationPartnerSettings(partnerAvatar, hostSettings) {
    if (!partnerAvatar) {
        return hostSettings;
    }

    const partnerSettings = getSettings(partnerAvatar);
    return {
        ...hostSettings,
        availability: partnerSettings.availability,
        ai_schedule: partnerSettings.ai_schedule,
        weekly_schedule: partnerSettings.weekly_schedule,
        auto_schedule: partnerSettings.auto_schedule,
        schedule_generated_at: partnerSettings.schedule_generated_at,
        talkativeness: partnerSettings.talkativeness,
        inactivity_threshold: partnerSettings.inactivity_threshold,
        reply_delay_multiplier: partnerSettings.reply_delay_multiplier,
        authors_note: partnerSettings.authors_note,
        lorebook_override: partnerSettings.lorebook_override,
        connection_profile: partnerSettings.connection_profile,
    };
}

function getLeastRecentPartner(avatar, selectedAvatars, settings = getSettings(avatar), { groupId = getConversationGroupIdForAvatar(avatar) } = {}) {
    const partners = getAllowedPartnerCharacters(selectedAvatars, avatar, settings, { groupId });
    if (!partners.length) {
        return null;
    }

    const thread = getConversationThread(avatar, { groupId });
    return [...partners].sort((left, right) => {
        const leftIndex = getLastPartnerMessageIndex(thread, left);
        const rightIndex = getLastPartnerMessageIndex(thread, right);
        return leftIndex - rightIndex;
    })[0];
}

function getLastPartnerMessageIndex(thread, partner) {
    for (let index = thread.length - 1; index >= 0; index--) {
        const message = thread[index];
        if (message?.extra?.partner_avatar === partner.avatar) {
            return index;
        }
    }

    return -1;
}

function getRecentlySilentMentionedPartner(avatar, selectedAvatars, settings = getSettings(avatar), { groupId = getConversationGroupIdForAvatar(avatar) } = {}) {
    const partners = getAllowedPartnerCharacters(selectedAvatars, avatar, settings, { groupId });
    if (!partners.length) {
        return null;
    }

    const thread = getConversationThread(avatar, { groupId });
    const recentMessages = thread.slice(-PARTNER_FOLLOWUP_RECENT_WINDOW);
    const mentionedPartner = partners.find(partner => recentMessages.some(message => isCharacterMentionedInText(partner, message?.mes || '', partners)));
    if (!mentionedPartner) {
        return null;
    }

    const lastMentionIndex = recentMessages.reduce((lastIndex, message, index) => {
        return isCharacterMentionedInText(mentionedPartner, message?.mes || '', partners) ? index : lastIndex;
    }, -1);
    const spokeAfterMention = recentMessages.slice(lastMentionIndex + 1).some((message) => {
        const isPartnerMessage = message?.extra?.partner_avatar === mentionedPartner.avatar;
        return isPartnerMessage && !['user', 'system'].includes(message.role);
    });
    return spokeAfterMention ? null : mentionedPartner;
}

function escapeRegExp(value) {
    return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function stripSpeakerPrefix(messageText, speakerName) {
    const text = String(messageText || '').trim();
    const namePattern = escapeRegExp(speakerName);
    if (!namePattern) {
        return normalizeConversationOutputText(text);
    }

    return normalizeConversationOutputText(text
        .replace(new RegExp(`^\\s*(?:\\*\\*)?${namePattern}\\s*[:：-](?:\\*\\*)?\\s*`, 'i'), '')
        .trim());
}

function getConversationActivityContext(settings, avatar, now = new Date()) {
    const schedule = getStoredSchedule(avatar);
    if (schedule) {
        return getCurrentActivityFromSchedule(schedule, avatar, now);
    }

    const status = settings?.availability || DEFAULT_SETTINGS.availability;
    const copy = getAvailabilityCopy(status);
    return { status, activity: copy.detail.replace(/\.$/, '').toLowerCase(), source: 'manual' };
}

function getReplyDelayMs(messageText, settings, avatar) {
    const multiplier = clamp(parsePositiveInt(settings?.reply_delay_multiplier, DEFAULT_REPLY_DELAY_MULTIPLIER, 0), 0, 300) / 100;
    if (multiplier <= 0) {
        return 0;
    }

    const current = getConversationActivityContext(settings, avatar);
    const status = current.status || 'online';
    const baseMs = { online: 450, idle: 900, dnd: 1600, offline: 2200 }[status] ?? 450;
    const perCharMs = { online: 18, idle: 32, dnd: 52, offline: 68 }[status] ?? 18;
    const talkativeness = clamp(parsePositiveInt(settings?.talkativeness, DEFAULT_TALKATIVENESS, 0), 0, 100);
    const talkFactor = 1.15 - (talkativeness / 200);
    const delay = (baseMs + String(messageText || '').length * perCharMs * talkFactor) * multiplier;
    return Math.min(9000, Math.max(350, Math.round(delay)));
}

async function waitForReplyDelay(messageText, settings, avatar) {
    const delay = getReplyDelayMs(messageText, settings, avatar);
    if (delay <= 0) {
        return;
    }

    if (isConversationActiveForAvatar(avatar)) {
        refreshConversationInterface({ syncControls: false });
    }
    await new Promise(resolve => setTimeout(resolve, delay));
}

function getTypingParticipantMap(avatar = getCurrentCharAvatar(), { create = false } = {}) {
    const threadAvatar = avatar || getCurrentCharAvatar();
    if (!threadAvatar) {
        return null;
    }

    let participantMap = activeTypingParticipants.get(threadAvatar);
    if (!participantMap && create) {
        participantMap = new Map();
        activeTypingParticipants.set(threadAvatar, participantMap);
    }

    return participantMap || null;
}

function getActiveTypingParticipants(avatar = getCurrentCharAvatar()) {
    const participantMap = getTypingParticipantMap(avatar);
    return participantMap ? Array.from(participantMap.values()).filter(participant => participant?.avatar) : [];
}

function getPrimaryTypingParticipant(avatar = getCurrentCharAvatar()) {
    const participants = getActiveTypingParticipants(avatar);
    return participants.length ? participants[participants.length - 1] : null;
}

async function withTypingParticipant(participant, task, avatar = getCurrentCharAvatar()) {
    const threadAvatar = avatar || getCurrentCharAvatar();
    const participantAvatar = participant?.avatar || threadAvatar;
    const participantMap = getTypingParticipantMap(threadAvatar, { create: true });
    const previousTypingParticipant = participantMap?.get(participantAvatar) || null;
    if (participantMap && participantAvatar) {
        participantMap.set(participantAvatar, participant || { avatar: participantAvatar, name: 'Character' });
    }

    if (isConversationActiveForAvatar(threadAvatar)) {
        refreshConversationInterface({ syncControls: false });
    }
    try {
        return await task();
    } finally {
        if (participantMap && participantAvatar) {
            if (previousTypingParticipant) {
                participantMap.set(participantAvatar, previousTypingParticipant);
            } else {
                participantMap.delete(participantAvatar);
            }
            if (!participantMap.size) {
                activeTypingParticipants.delete(threadAvatar);
            }
        }
        if (isConversationActiveForAvatar(threadAvatar)) {
            refreshConversationInterface({ syncControls: false });
        }
    }
}

function maybePostDelayedReplyNotice(avatar, settings, { groupId = getConversationGroupIdForAvatar(avatar) } = {}) {
    const current = getConversationActivityContext(settings, avatar);
    if (current.source === 'manual' && ['dnd', 'offline'].includes(settings?.availability)) {
        return;
    }
    if (!['dnd', 'offline'].includes(current.status)) {
        return;
    }

    const lastUserActivity = getLastUserActivity(avatar, Date.now(), { groupId });
    const markerKey = 'sb_conv_busy_reply_notice';
    const markerValue = getConversationSessionMarker(avatar, markerKey, { groupId });
    const markerTime = parsePositiveInt(markerValue.split(':')[1], 0, 0);
    if (markerTime > 0 && Date.now() - markerTime < STATUS_NOTICE_COOLDOWN_MS) {
        return;
    }

    const character = getCharacterForAvatar(avatar);
    const charName = character?.name || 'This character';
    appendConversationThreadMessage(avatar, {
        role: 'system',
        name: 'Status',
        mes: `${charName} is ${current.activity} right now. Replies may take a little longer.`,
        extra: { conversation_mode_notice: true, availability: current.status },
    }, { groupId });
    setConversationSessionMarker(avatar, markerKey, `${lastUserActivity}:${Date.now()}`, { groupId });
}

function stripPreviewText(messageText) {
    return String(messageText || '')
        .replace(/<[^>]*>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 130);
}

function splitChatroomMessages(text) {
    const parts = String(text || '')
        .split(/\n\s*\n+/)
        .map(part => part.trim())
        .filter(Boolean);
    return parts.length ? parts : [String(text || '').trim()].filter(Boolean);
}

function setLastConversationPreview(avatar, messageText, { groupId = getConversationGroupIdForAvatar(avatar) } = {}) {
    const preview = stripPreviewText(messageText);
    if (!avatar || !preview) {
        return;
    }

    const branch = getActiveConversationBranch(avatar, { groupId });
    if (branch) {
        branch.preview = preview;
        branch.updatedAt = Date.now();
        persistConversationStore();
    }
}

function getLastConversationPreview(avatar, { groupId = getConversationGroupIdForAvatar(avatar) } = {}) {
    return getActiveConversationBranch(avatar, { create: false, groupId })?.preview || 'Conversation ready';
}

function updateLastPreviewFromConversation(avatar = getCurrentCharAvatar(), { groupId = getConversationGroupIdForAvatar(avatar) } = {}) {
    if (!avatar) {
        return;
    }

    const messages = getConversationThread(avatar, { groupId });
    const message = [...messages].reverse().find(hasConversationMessageContent);
    if (message) {
        setLastConversationPreview(avatar, getConversationMessagePreviewText(message), { groupId });
    }

    updateConversationNotificationIndicators();
}

function getConversationSettingsForCharacter(character) {
    return character?.avatar ? getSettings(character.avatar) : { ...DEFAULT_SETTINGS };
}

function getConversationPals() {
    if (!Array.isArray(characters)) {
        return [];
    }

    return characters
        .map((character, index) => ({ character, index, settings: getConversationSettingsForCharacter(character) }))
        .filter(item => item.character?.avatar && item.settings.enabled);
}

function getConversationRailItems() {
    const items = [];
    const seen = new Set();
    const activeKey = getActiveConversationThreadKey();
    const addItem = ({ character, index, settings, groupId = '', group = null, threadStore = null }) => {
        const avatar = character?.avatar;
        if (!avatar || !settings?.enabled) {
            return;
        }

        const key = getConversationThreadKey(avatar, groupId || '');
        if (!key || seen.has(key)) {
            return;
        }

        if (groupId) {
            const branchId = threadStore?.activeBranchId || DEFAULT_BRANCH_ID;
            const branch = normalizeConversationBranch(threadStore?.branches?.[branchId], branchId);
            const isEmptyThread = !branch.messages.length && !branch.unread && branch.preview === 'Conversation ready';
            if (isEmptyThread && key !== activeKey) {
                return;
            }
        }

        seen.add(key);
        items.push({ character, index, settings, groupId: groupId || '', group, key });
    };

    getConversationPals().forEach(pal => addItem({ ...pal, groupId: '' }));

    Object.entries(getConversationStore().characters || {}).forEach(([storeKey, threadStore]) => {
        const parsed = parseConversationThreadKey(storeKey);
        if (!parsed.groupId || !parsed.avatar) {
            return;
        }

        const character = getCharacterForAvatar(parsed.avatar);
        const group = getConversationGroupById(parsed.groupId);
        const settings = getConversationSettingsForCharacter(character);
        if (!character || !group) {
            return;
        }

        addItem({
            character,
            index: getCharacterIndexForAvatar(parsed.avatar),
            settings,
            groupId: parsed.groupId,
            group,
            threadStore,
        });
    });

    return items.sort((first, second) => {
        if (first.key === activeKey) return -1;
        if (second.key === activeKey) return 1;
        const firstBranch = getActiveConversationBranch(first.character.avatar, { create: false, groupId: first.groupId });
        const secondBranch = getActiveConversationBranch(second.character.avatar, { create: false, groupId: second.groupId });
        return Number(secondBranch?.updatedAt || 0) - Number(firstBranch?.updatedAt || 0);
    });
}

function getSelectedConversationGroup() {
    return getConversationGroupById(conversationWorkspaceOpen ? conversationSelectedGroupId : selected_group);
}

function getCurrentGroupConversationMembers({ requireRoleplayReactions = false } = {}) {
    const group = getSelectedConversationGroup();
    if (!group || !Array.isArray(group.members)) {
        return [];
    }

    return group.members
        .filter(avatar => avatar && !group.disabled_members?.includes(avatar))
        .map((avatar) => {
            const character = getCharacterForAvatar(avatar);
            const index = getCharacterIndexForAvatar(avatar);
            const settings = getConversationSettingsForCharacter(character);
            return { character, index, settings };
        })
        .filter(item => item.character?.avatar && item.settings.enabled)
        .filter(item => !requireRoleplayReactions || item.settings.roleplay_reactions);
}

function getScheduleEditorTargets(baseAvatar = getCurrentCharAvatar()) {
    const targets = [];
    const addTarget = (character, sourceLabel = '') => {
        if (!character?.avatar || targets.some(target => target.avatar === character.avatar)) {
            return;
        }

        targets.push({
            avatar: character.avatar,
            name: character.name || 'Character',
            sourceLabel,
        });
    };

    const baseSettings = baseAvatar ? getSettings(baseAvatar) : null;
    if (baseAvatar) {
        getConversationParticipants(baseAvatar, baseSettings || getSettings(baseAvatar)).forEach(character => addTarget(character, 'Conversation'));
    }

    getCurrentGroupConversationMembers().forEach(({ character }) => addTarget(character, 'Group chat'));

    if (!targets.length && baseAvatar) {
        addTarget(getCharacterForAvatar(baseAvatar), 'Conversation');
    }

    return targets;
}

function getCharacterForGroupChatMessage(message) {
    const avatar = String(message?.original_avatar || message?.extra?.original_avatar || message?.extra?.avatar || '').trim();
    return avatar ? getCharacterForAvatar(avatar) : null;
}

function buildGroupChatContext(limit = GROUP_ASIDE_CONTEXT_LIMIT) {
    const startIndex = Math.max(0, chat.length - limit);
    const lines = [];
    for (let index = startIndex; index < chat.length; index++) {
        const message = chat[index];
        const text = stripPreviewText(message?.mes || '');
        if (!text) {
            continue;
        }

        const speaker = message?.name || (message?.is_user || message?.role === 'user' ? name1 || 'User' : 'Character');
        lines.push(`${speaker}: ${formatPromptText(text, 600)}`);
    }

    return lines.join('\n');
}

function getGroupAsideKey(avatar, groupId = selected_group) {
    return `${groupId || 'group'}:${avatar || 'unknown'}`;
}

function getConversationMessageAvatar(message, avatar = getCurrentCharAvatar()) {
    if (message.role === 'user') {
        return (typeof user_avatar === 'string' && user_avatar)
            ? getThumbnailUrl('persona', user_avatar) || default_user_avatar
            : default_user_avatar;
    }

    if (message.role === 'partner') {
        const partnerAvatar = message.extra?.partner_avatar;
        if (partnerAvatar) {
            return getThumbnailUrl('avatar', partnerAvatar);
        }
    }

    if (avatar) {
        return getThumbnailUrl('avatar', avatar);
    }

    return default_user_avatar;
}

function getConversationMessageReceipt(message, avatar = getCurrentCharAvatar(), { groupId = getConversationGroupIdForAvatar(avatar) } = {}) {
    if (!message || message.role !== 'user') {
        return '';
    }

    const thread = getConversationThread(avatar, { groupId });
    const messageIndex = thread.findIndex(item => item.id === message.id);
    if (messageIndex >= 0 && thread.slice(messageIndex + 1).some(item => !['user', 'system'].includes(item.role))) {
        return 'Seen';
    }

    const seenAt = getConversationSeenAt(avatar, { groupId });
    const createdAt = parsePositiveInt(message.created_at, 0, 0);
    return seenAt > 0 && createdAt > 0 && seenAt >= createdAt ? 'Seen' : 'Delivered';
}

function formatConversationFileSize(size) {
    const bytes = Number(size);
    if (!Number.isFinite(bytes) || bytes <= 0) {
        return '';
    }

    const units = ['B', 'KB', 'MB', 'GB'];
    let value = bytes;
    let unitIndex = 0;
    while (value >= 1024 && unitIndex < units.length - 1) {
        value /= 1024;
        unitIndex += 1;
    }

    const precision = value >= 10 || unitIndex === 0 ? 0 : 1;
    return `${value.toFixed(precision)} ${units[unitIndex]}`;
}

function renderConversationAttachments(container, message) {
    const media = getConversationMediaAttachments(message);
    const files = getConversationFileAttachments(message);
    if (!media.length && !files.length) {
        return;
    }

    const wrapper = document.createElement('div');
    wrapper.className = 'sb-conversation-attachments';

    media.forEach((attachment) => {
        const figure = document.createElement('figure');
        figure.className = 'sb-conversation-media-attachment';

        const title = String(attachment.title || '').trim();
        const type = String(attachment.type || 'image');
        if (type === 'video') {
            const video = document.createElement('video');
            video.src = attachment.url;
            video.controls = true;
            video.preload = 'metadata';
            video.title = title;
            figure.appendChild(video);
        } else if (type === 'audio') {
            const audio = document.createElement('audio');
            audio.src = attachment.url;
            audio.controls = true;
            audio.preload = 'metadata';
            audio.title = title;
            figure.appendChild(audio);
        } else {
            const img = document.createElement('img');
            img.src = attachment.url;
            img.alt = title || 'Uploaded image';
            img.loading = 'lazy';
            figure.appendChild(img);
        }

        if (title) {
            const caption = document.createElement('figcaption');
            caption.textContent = title;
            figure.appendChild(caption);
        }

        wrapper.appendChild(figure);
    });

    files.forEach((file) => {
        const link = document.createElement('a');
        link.className = 'sb-conversation-file-attachment';
        link.href = file.url;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.download = file.name || '';

        const icon = document.createElement('span');
        icon.className = 'fa-solid fa-file-lines';
        icon.setAttribute('aria-hidden', 'true');

        const copy = document.createElement('span');
        copy.className = 'sb-conversation-file-copy';
        const name = document.createElement('span');
        name.className = 'sb-conversation-file-name';
        name.textContent = file.name || 'Attached file';
        const size = document.createElement('span');
        size.className = 'sb-conversation-file-size';
        size.textContent = formatConversationFileSize(file.size);
        copy.append(name, size);

        link.append(icon, copy);
        wrapper.appendChild(link);
    });

    container.appendChild(wrapper);
}

function formatPromptText(value, maxLength = 1400) {
    return String(value || '')
        .replace(/<[^>]*>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, maxLength);
}

function formatConversationTranscript(messages) {
    return messages
        .slice(-TRANSCRIPT_MESSAGE_LIMIT)
        .map(message => {
            const parts = [
                formatPromptText(message.mes, 1800),
                getConversationAttachmentSummary(message),
            ].filter(Boolean);
            return parts.length ? `${message.name || 'Speaker'}: ${parts.join(' ')}` : '';
        })
        .filter(Boolean)
        .join('\n');
}

async function convertImageUrlToBase64(imageUrl) {
    if (typeof imageUrl !== 'string' || !imageUrl) {
        return '';
    }
    if (imageUrl.startsWith('data:')) {
        return imageUrl;
    }

    try {
        const response = await fetch(imageUrl, { method: 'GET', cache: 'force-cache' });
        if (!response.ok) {
            throw new Error(`Failed to fetch image: status ${response.status}`);
        }
        const blob = await response.blob();
        return await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onloadend = () => resolve(reader.result);
            reader.onerror = reject;
            reader.readAsDataURL(blob);
        });
    } catch (error) {
        console.error('Conversation Mode: failed to convert image to base64', error);
        return imageUrl;
    }
}

async function buildConversationPromptMessages(messages, directive, speakerName = getCurrentCharName()) {
    const promptMessages = [{
        role: 'user',
        content: 'Conversation transcript:',
        identifier: 'conversation-transcript-header',
    }];

    const sliceMessages = messages.slice(-TRANSCRIPT_MESSAGE_LIMIT);
    const convertedMessages = await Promise.all(sliceMessages.map(async (message, index) => {
        const parts = [
            formatPromptText(message.mes, 1800),
            getConversationAttachmentSummary(message),
        ].filter(Boolean);
        const media = getConversationPromptMediaAttachments(message);
        if (!parts.length && !media.length) {
            return null;
        }

        const role = message.role === 'user' ? 'user' : message.role === 'system' ? 'system' : 'assistant';
        const textContent = parts.length ? `${message.name || 'Speaker'}: ${parts.join(' ')}` : `${message.name || 'Speaker'} sent an attachment.`;

        if (!media.length) {
            return {
                role,
                content: textContent,
                identifier: `conversation-message-${message.id || index}`,
            };
        }

        const contentParts = [
            { type: 'text', text: textContent },
        ];

        const mediaDisplay = getConversationMediaDisplay(message);
        const mediaIndex = getConversationMediaIndex(message, media);
        const mediaToInline = mediaDisplay === MEDIA_DISPLAY.GALLERY
            ? [media[mediaIndex]]
            : media;

        for (const item of mediaToInline) {
            if (item && item.url) {
                const base64Url = await convertImageUrlToBase64(item.url);
                if (base64Url) {
                    contentParts.push({
                        type: 'image_url',
                        image_url: {
                            url: base64Url,
                            detail: 'high',
                        },
                    });
                }
            }
        }

        return {
            role,
            content: contentParts,
            identifier: `conversation-message-${message.id || index}`,
        };
    }));

    convertedMessages.filter(Boolean).forEach(msg => promptMessages.push(msg));

    if (promptMessages.length === 1) {
        promptMessages.push({
            role: 'user',
            content: '(No prior DM messages.)',
            identifier: 'conversation-empty-transcript',
        });
    }

    promptMessages.push({
        role: 'user',
        content: [directive, `${speakerName}:`].filter(Boolean).join('\n\n'),
        identifier: 'conversation-reply-directive',
    });

    return promptMessages;
}

function buildConversationMemoryPrompt(avatar, messages, { groupId = getConversationGroupIdForAvatar(avatar) } = {}) {
    const character = getCharacterForAvatar(avatar);
    const participants = getParticipantNamesForDisplay(getConversationParticipants(avatar, getSettings(avatar), { groupId }));
    return [
        `Main DM: ${character?.name || 'Character'} with ${name1 || 'User'}.`,
        participants.length > 1 ? `Other possible participants: ${participants.slice(1).join(', ')}.` : '',
        'Summarize durable DM memory only: relationship tone, promises, unresolved topics, preferences, private jokes, boundaries, and emotionally important beats.',
        'Ignore filler small talk unless it changes the relationship. Keep it compact and useful for future replies.',
        '',
        formatConversationTranscript(messages.slice(-MEMORY_SUMMARY_RECENT_MESSAGES)),
    ].filter(Boolean).join('\n');
}

async function updateConversationMemorySummary(avatar = getCurrentCharAvatar(), { force = false, groupId = getConversationGroupIdForAvatar(avatar), notify = false } = {}) {
    const memoryKey = getConversationThreadKey(avatar, groupId);
    if (!avatar || !memoryKey || memorySummaryBusyAvatars.has(memoryKey)) {
        return false;
    }

    const branch = getActiveConversationBranch(avatar, { create: false, groupId });
    const messages = Array.isArray(branch?.messages) ? branch.messages.filter(message => hasConversationMessageContent(message) && message.role !== 'system') : [];
    if (!messages.length || (!force && messages.length < MEMORY_SUMMARY_MIN_MESSAGES)) {
        if (notify) {
            toastr.info(`Memory appears after at least ${MEMORY_SUMMARY_MIN_MESSAGES} messages, or when there is enough chat to summarize.`);
        }
        return false;
    }

    const lastSummarizedCount = parsePositiveInt(branch?.memoryMessageCount, 0, 0);
    if (!force && messages.length - lastSummarizedCount < MEMORY_SUMMARY_INTERVAL_MESSAGES) {
        return false;
    }

    memorySummaryBusyAvatars.add(memoryKey);
    try {
        const previousSummary = getConversationMemorySummary(avatar, { groupId });
        const prompt = [
            previousSummary ? `Existing DM memory summary:\n${previousSummary}` : '',
            buildConversationMemoryPrompt(avatar, messages, { groupId }),
            'Return the updated memory summary in 6 concise bullets or fewer. No preamble.',
        ].filter(Boolean).join('\n\n');
        const settings = getSettings(avatar);
        const response = await withConversationConnectionProfile(settings, () => generateRaw({
            prompt,
            systemPrompt: 'You maintain a concise private DM memory summary for realistic ongoing chat continuity.',
            responseLength: 420,
            trimNames: false,
            cacheScope: 'conversation-mode-memory',
        }));

        if (response?.trim()) {
            saveConversationMemorySummary(avatar, response.trim(), messages.length, { groupId });
            if (notify) {
                toastr.success('Conversation memory refreshed.');
            }
            return true;
        }
    } catch (error) {
        console.warn('Conversation Mode: memory summary update failed', error);
        if (notify) {
            toastr.warning('Conversation memory refresh failed. Check console for details.');
        }
    } finally {
        memorySummaryBusyAvatars.delete(memoryKey);
    }

    return false;
}

function scheduleConversationMemorySummary(avatar = getCurrentCharAvatar(), { groupId = getConversationGroupIdForAvatar(avatar) } = {}) {
    if (!avatar) {
        return;
    }

    const memoryKey = getConversationThreadKey(avatar, groupId);
    const existingTimer = memorySummaryTimers.get(memoryKey);
    if (existingTimer) {
        window.clearTimeout(existingTimer);
    }

    const timer = window.setTimeout(() => {
        memorySummaryTimers.delete(memoryKey);
        void updateConversationMemorySummary(avatar, { groupId });
    }, 2500);
    memorySummaryTimers.set(memoryKey, timer);
}

function buildConversationSystemPrompt(settings, avatar = getCurrentCharAvatar(), { threadAvatar = avatar, groupId = getConversationGroupIdForAvatar(threadAvatar) } = {}) {
    const character = getCharacterForAvatar(avatar);
    const charName = character?.name || getCurrentCharName();
    const userName = name1 || 'User';
    const threadSettings = threadAvatar === avatar ? settings : getSettings(threadAvatar);
    const threadCharacter = threadAvatar !== avatar ? getCharacterForAvatar(threadAvatar) : null;
    const fields = [
        threadCharacter
            ? `You are ${charName} in a private group direct-message conversation with ${userName} and ${threadCharacter.name || 'another character'}.`
            : `You are ${charName} in a private direct-message conversation with ${userName}.`,
        'This Conversation Mode transcript is separate from the roleplay/story chat. Do not continue roleplay scenes unless the user explicitly asks about them.',
        'Formatting: write plain chat text. Do not wrap words or phrases in double quotation marks or smart quotes for emphasis. If sending multiple chat bubbles, put each bubble on its own line.',
    ];

    let compiledPrompt = settings.geechan_chatroom_prompt || GEECHAN_DEFAULT_PROMPT;
    compiledPrompt = compiledPrompt.replace(/\{\{\/\/[\s\S]*?\}\}/g, '');
    compiledPrompt = compiledPrompt.replace(/\{\{trim\}\}/g, '');
    if (settings.custom_instructions && settings.custom_instructions.trim()) {
        compiledPrompt = compiledPrompt.replace(/\{\{#if \.player-instructions\}\}([\s\S]*?)\{\{\/if\}\}/gi, (match, p1) => {
            return p1.replace(/\{\{getvar::player-instructions\}\}/gi, settings.custom_instructions);
        });
    } else {
        compiledPrompt = compiledPrompt.replace(/\{\{#if \.player-instructions\}\}([\s\S]*?)\{\{\/if\}\}/gi, '');
    }
    compiledPrompt = compiledPrompt
        .replace(/\{\{char\}\}/g, charName)
        .replace(/\{\{user\}\}/g, userName);
    fields.push(compiledPrompt.trim());

    if (character?.description) {
        fields.push(`Character description:\n${formatPromptText(character.description, 2400)}`);
    }
    if (character?.personality) {
        fields.push(`Personality:\n${formatPromptText(character.personality, 1600)}`);
    }
    if (character?.scenario) {
        fields.push(`Background context:\n${formatPromptText(character.scenario, 1200)}`);
    }
    const authorNote = settings.authors_note || getCharacterAuthorNote(avatar);
    if (authorNote) {
        fields.push(`Conversation author's note:\n${authorNote.replace('{{char}}', charName).replace('{{user}}', userName)}`);
    }
    if (settings.lorebook_override) {
        fields.push(`Conversation lorebook focus: ${settings.lorebook_override}. Prefer this lore/context over roleplay scene continuity.`);
    }

    const userAvailability = getAvailabilityCopy(getUserStatus());
    const userPersonaStatus = getUserPersonaStatus();
    fields.push(userPersonaStatus
        ? `User presence: ${userName} is ${userAvailability.label.toLowerCase()}. Their Conversation status: ${userPersonaStatus}.`
        : `User presence: ${userName} is ${userAvailability.label.toLowerCase()}.`);
    const personaContext = composeConversationPersonaDescription(user_avatar).trim() || String(power_user?.persona_description ?? '').trim();
    if (personaContext) {
        fields.push(`User persona and active Scenario Notes:\n${formatPromptText(personaContext, 2600)}`);
    }

    const partners = getConversationParticipants(threadAvatar, threadSettings, { groupId }).filter(participant => participant?.avatar && participant.avatar !== avatar);
    if (partners.length) {
        fields.push(`Group DM participants who may chime in: ${getParticipantNamesForDisplay(partners).join(', ')}. Treat them as independent people in the chat. Do not speak for them unless specifically generating their message.`);
    }

    const memorySummary = getConversationMemorySummary(threadAvatar, { groupId });
    if (memorySummary) {
        fields.push(`Long-term DM memory summary:\n${memorySummary}`);
    }

    const schedule = getStoredSchedule(avatar);
    if (schedule) {
        const current = getCurrentActivityFromSchedule(schedule, avatar);
        const now = new Date();
        const timeLabel = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        fields.push(`Current life context: It is ${timeLabel} for ${charName}, who is currently ${current.activity} (status: ${current.status}). Let this naturally color your availability, mood, and what you mention. Stay in this moment of your day.`);
    }

    const commandHints = [];
    if (settings.selfie_command_enabled) {
        commandHints.push('To send a selfie or photo, embed [selfie] (optionally [selfie: context="what the photo shows"]) anywhere in your reply. It is stripped from the visible message and turned into a real image.');
    }
    if (settings.schedule_command_enabled) {
        commandHints.push('To change what you are doing right now, embed [schedule_update: status="online|idle|dnd|offline", activity="short description", duration="1h30m"]. Use this when your situation shifts (you got off work, went to sleep, etc.).');
    }
    commandHints.push('To schedule a reminder for the user at their request, embed [reminder: delay_or_time | memo] anywhere in your reply. delay_or_time can be durations (e.g. "2h", "15m", "30s") or explicit clock times (e.g. "14:30"). memo is what you are reminding them about (e.g. "wash the dishes"). This command is stripped from the visible message.');
    if (commandHints.length) {
        fields.push(`Available commands (use sparingly and only when natural):\n${commandHints.join('\n')}`);
    }

    return fields.join('\n\n');
}

async function generateConversationReply(directive, settings, { responseLength = null, speakerName = getCurrentCharName(), trimNames = true, avatar = getCurrentCharAvatar(), threadAvatar = avatar, speakerAvatar = avatar, groupId = getConversationGroupIdForAvatar(threadAvatar) } = {}) {
    const messages = getConversationThread(threadAvatar, { groupId });
    const resolvedResponseLength = Number.isFinite(responseLength) && responseLength > 0
        ? clamp(Math.round(responseLength), MIN_CONVERSATION_REPLY_MAX_TOKENS, MAX_CONVERSATION_REPLY_MAX_TOKENS)
        : getConversationReplyMaxTokens(settings);
    const prompt = await buildConversationPromptMessages(messages, directive, speakerName);

    return withConversationConnectionProfile(settings, () => generateRaw({
        prompt,
        systemPrompt: buildConversationSystemPrompt(settings, speakerAvatar, { threadAvatar, groupId }),
        responseLength: resolvedResponseLength,
        trimNames,
        cacheScope: 'conversation-mode',
    }));
}

function editConversationMessage(messageId) {
    const avatar = getCurrentCharAvatar();
    const groupId = getConversationGroupIdForAvatar(avatar);
    const message = getConversationThread(avatar, { groupId }).find(item => item.id === messageId);
    if (!avatar || !message) {
        return;
    }

    const edited = globalThis.prompt?.('Edit Conversation message', message.mes);
    if (typeof edited !== 'string' || !edited.trim() || edited === message.mes) {
        return;
    }

    updateConversationThreadMessage(avatar, messageId, edited.trim(), null, { groupId });
}

function parseCommandArgs(rawArgs) {
    const args = {};
    const re = /(\w+)\s*=\s*"([^"]*)"/g;
    let match;
    while ((match = re.exec(rawArgs)) !== null) {
        args[match[1].toLowerCase()] = match[2];
    }
    return args;
}

function applyScheduleUpdateCommand(avatar, rawArgs) {
    const args = parseCommandArgs(rawArgs);
    const status = SCHEDULE_STATUSES.includes(args.status) ? args.status : null;
    const activity = (args.activity || '').trim();
    if (!avatar || (!status && !activity)) {
        return;
    }

    const durationMs = parseDurationToMs(args.duration) || (2 * 60 * 60 * 1000);
    runtimeStatusOverrides.set(avatar, {
        status: status || 'online',
        activity: activity || 'free time',
        expiresAt: Date.now() + durationMs,
    });
}

// Scans a generated reply for embedded [selfie] / [schedule_update] commands.
// Strips them from the visible text, applies schedule overrides, and returns
// { text, selfieRequests:[context] } so callers can fire image generation.
function extractCharacterReplyCommands(rawText, settings, avatar = getCurrentCharAvatar(), { groupId = getConversationGroupIdForAvatar(avatar), reminderAvatar = avatar } = {}) {
    let text = String(rawText || '');
    const selfieRequests = [];

    if (settings.schedule_command_enabled) {
        text = text.replace(SCHEDULE_UPDATE_RE, (full, rawArgs) => {
            applyScheduleUpdateCommand(avatar, rawArgs);
            return '';
        });
    }

    if (settings.selfie_command_enabled) {
        text = text.replace(SELFIE_COMMAND_RE, (full, context) => {
            selfieRequests.push((context || '').trim());
            return '';
        });
    }

    // Always enable parsing of the reminder command from character DMs!
    text = text.replace(REMINDER_COMMAND_RE, (full, delay, memo) => {
        addConversationReminder(reminderAvatar, groupId, delay, memo);
        return '';
    });

    text = text.replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
    text = normalizeConversationOutputText(text);
    return { text, selfieRequests };
}

function normalizeConversationOutputText(rawText) {
    let text = String(rawText || '').trim();
    let changed = true;
    while (changed) {
        changed = false;
        const normalized = text
            .replace(/[“”]"([^"\n]{1,240})"[“”]/g, '"$1"')
            .replace(/"[“”]([^“”\n]{1,240})[“”]"/g, '"$1"')
            .replace(/^[“”]+/, '"')
            .replace(/[“”]+$/, '"')
            .replace(/^['"]{2,}\s*/, '"')
            .replace(/\s*['"]{2,}$/, '"')
            .replace(/^"([\s\S]*)"$/, '$1')
            .replace(/[“”"]/g, '')
            .replace(/\s+([?!.,:;])/g, '$1')
            .trim();
        if (normalized !== text) {
            text = normalized;
            changed = true;
        }
    }
    return text;
}

function getConversationErrorDetail(error) {
    let detail = '';
    if (typeof error === 'string') {
        detail = error;
    } else if (error?.message) {
        detail = error.message;
    } else if (error?.response) {
        detail = error.response;
    } else if (error?.error?.message) {
        detail = error.error.message;
    } else if (error?.error) {
        detail = error.error;
    } else if (error) {
        try {
            detail = JSON.stringify(error);
        } catch {
            detail = String(error);
        }
    }

    return String(detail || '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, CONVERSATION_ERROR_DETAIL_MAX_LENGTH);
}

function reportConversationGenerationError(context, error, { toast = true, level = 'error' } = {}) {
    const detail = getConversationErrorDetail(error);
    const label = context ? `Conversation ${context}` : 'Conversation generation';
    const log = level === 'warning' ? console.warn : console.error;
    log(`${label} failed${detail ? `: ${detail}` : ''}`, error);

    if (!toast) {
        return;
    }

    const message = `${label} failed${detail ? `: ${detail}` : '. Check the browser console for details.'}`;
    if (level === 'warning') {
        globalThis.toastr?.warning?.(message, '', SAFE_TOAST_OPTIONS);
    } else {
        globalThis.toastr?.error?.(message, '', SAFE_TOAST_OPTIONS);
    }
}

function splitPartnerChatroomMessages(text) {
    const messages = String(text || '')
        .split(/\n+/)
        .map(part => normalizeConversationOutputText(part))
        .filter(Boolean);
    return messages.length ? messages : splitChatroomMessages(text).map(part => normalizeConversationOutputText(part)).filter(Boolean);
}

async function postPartnerConversationReply(rawText, partner, partnerSettings, { avatar = getCurrentCharAvatar(), extra = {}, groupId = getConversationGroupIdForAvatar(avatar) } = {}) {
    if (!avatar || !partner) {
        return false;
    }

    const partnerName = partner.name || 'A friend';
    const { text, selfieRequests } = extractCharacterReplyCommands(stripSpeakerPrefix(rawText, partnerName), partnerSettings, partner.avatar, { groupId, reminderAvatar: avatar });
    const messages = splitPartnerChatroomMessages(text);

    if (messages.length) {
        await withTypingParticipant(partner, async () => {
            for (const messageText of messages) {
                await waitForReplyDelay(messageText, partnerSettings, partner.avatar);
                await appendConversationMessage(messageText, {
                    name: partnerName,
                    role: 'partner',
                    extra,
                    groupId,
                }, avatar);
            }
        }, avatar);
    }

    for (const context of selfieRequests) {
        await withTypingParticipant(partner, () => generateSelfieFromContext(context, partnerSettings, partner.avatar, {
            threadAvatar: avatar,
            role: 'partner',
            name: partnerName,
            extra: { ...extra, partner_avatar: partner.avatar },
            groupId,
        }), avatar);
    }

    return Boolean(messages.length || selfieRequests.length);
}

// Turns a free-form selfie context into a real image via QIG. Uses a meta-prompt
// so the LLM writes a focused image prompt, then appends an image message.
async function generateSelfieFromContext(context, settings, avatar = getCurrentCharAvatar(), { threadAvatar = avatar, role = 'character', name = '', extra = {}, groupId = undefined } = {}) {
    if (!settings.image_gen_enabled || !avatar || getImageCooldownRemainingSeconds(avatar, settings, Date.now(), { groupId }) > 0) {
        return;
    }

    const character = getCharacterForAvatar(avatar);
    const charName = character?.name || 'Character';
    const appearance = getCharacterImageDetails(avatar);
    const metaPrompt = [
        'You are an image prompt generator. Write a concise, detailed image generation prompt for a selfie photo.',
        `Character name: ${charName}.`,
        appearance ? `Appearance: ${appearance}` : '',
        context ? `Photo context: ${context}` : 'Photo context: a casual selfie in the current moment.',
        'Include appearance, clothing, expression and selfie pose, setting/background, and lighting. Output ONLY the prompt text, nothing else.',
    ].filter(Boolean).join('\n');

    let imagePrompt = '';
    try {
        imagePrompt = await withConversationConnectionProfile(settings, () => generateRaw({
            prompt: metaPrompt,
            systemPrompt: 'You output only a raw image generation prompt with no preamble.',
            responseLength: 200,
            trimNames: false,
            cacheScope: 'conversation-mode-selfie',
        }));
    } catch (error) {
        console.warn('Conversation Mode: selfie prompt generation failed', error);
    }

    imagePrompt = buildCharacterImagePrompt(
        formatPromptText(imagePrompt, 600) || settings.selfie_prompt || 'raw photo, selfie of {{char}}',
        context || 'a casual selfie in the current moment',
        avatar,
    );

    const imageUrl = await generateConversationImage(imagePrompt, settings.image_gen_negative || '');
    if (imageUrl) {
        markImageGenerated(avatar, Date.now(), { groupId });
        await appendConversationMessage('Sending you a selfie.', {
            name,
            role,
            extra: { ...extra, conversation_mode_image: true, image_url: imageUrl, image_prompt: imagePrompt },
            groupId,
        }, threadAvatar);
    }
}

// Handles a freshly generated character reply: strips commands, posts the visible
// message, applies status overrides, and fires any requested selfies.
async function postCharacterReply(rawText, settings, { extra = {}, groupId = undefined } = {}, avatar = getCurrentCharAvatar()) {
    if (!avatar) {
        return '';
    }
    const { text, selfieRequests } = extractCharacterReplyCommands(rawText, settings, avatar, { groupId });

    if (text) {
        const character = (Array.isArray(characters) ? characters : []).find(c => c?.avatar === avatar);
        const speakerName = character?.name || getCurrentCharName();

        for (const messageText of splitChatroomMessages(text)) {
            const cleanMessageText = normalizeConversationOutputText(messageText);
            if (!cleanMessageText) {
                continue;
            }

            await withTypingParticipant(character || { avatar, name: speakerName }, async () => {
                await waitForReplyDelay(cleanMessageText, settings, avatar);
                await appendConversationMessage(cleanMessageText, {
                    name: speakerName,
                    role: 'character',
                    extra,
                    groupId,
                }, avatar);
            }, avatar);
        }
    }

    for (const context of selfieRequests) {
        await generateSelfieFromContext(context, settings, avatar, {
            role: 'character',
            name: (Array.isArray(characters) ? characters : []).find(c => c?.avatar === avatar)?.name || '',
            extra,
            groupId,
        });
    }

    return text;
}

function renderConversationTimeline() {
    const timeline = document.getElementById(CHROME_IDS.timeline);
    const avatar = getCurrentCharAvatar();
    if (!(timeline instanceof HTMLElement)) {
        return;
    }

    const previousScrollTop = timeline.scrollTop;
    const previousScrollBottom = timeline.scrollHeight - previousScrollTop - timeline.clientHeight;
    const previousAvatar = lastRenderedAvatar;
    const previousMessageCount = lastRenderedMessageCount;

    if (!avatar) {
        timeline.innerHTML = `
            <div class="sb-conversation-thread-empty">
                <div class="sb-conversation-thread-empty-icon fa-solid fa-comments" aria-hidden="true"></div>
                <div>
                    <strong>Choose a DM to begin</strong>
                    <p>Use the Pals rail plus button to start messaging a character without opening the character drawer.</p>
                </div>
            </div>
        `;
        lastRenderedAvatar = null;
        lastRenderedMessageCount = 0;
        updateConversationToolsState();
        return;
    }

    const settings = getSettings(avatar);
    const groupId = getConversationGroupIdForAvatar(avatar);
    const allMessages = getConversationThread(avatar, { groupId });
    const messages = getConversationTimelineMessages(allMessages);
    const contextChanged = previousAvatar !== avatar;
    const messagesAdded = allMessages.length > previousMessageCount;
    const isNearBottom = previousScrollBottom <= 150;
    timeline.textContent = '';

    if (!allMessages.length) {
        const empty = document.createElement('div');
        empty.className = 'sb-conversation-thread-empty';
        empty.innerHTML = `
            <div class="sb-conversation-thread-empty-icon fa-solid fa-message" aria-hidden="true"></div>
            <div>
                <strong>No DM messages yet</strong>
                <p>Roleplay chat stays separate. Start a casual conversation here when you want direct messages.</p>
            </div>
        `;
        timeline.appendChild(empty);
        lastRenderedAvatar = avatar;
        lastRenderedMessageCount = allMessages.length;
        updateConversationToolsState();
        if (contextChanged || messagesAdded || isNearBottom) {
            timeline.scrollTop = timeline.scrollHeight;
        } else {
            timeline.scrollTop = previousScrollTop;
        }
        return;
    }

    if (!messages.length) {
        const empty = document.createElement('div');
        empty.className = 'sb-conversation-thread-empty';
        empty.innerHTML = `
            <div class="sb-conversation-thread-empty-icon fa-solid fa-filter" aria-hidden="true"></div>
            <div>
                <strong>No matching messages</strong>
                <p>Clear search or switch back to Main to see the full Conversation.</p>
            </div>
        `;
        timeline.appendChild(empty);
        lastRenderedAvatar = avatar;
        lastRenderedMessageCount = allMessages.length;
        updateConversationToolsState();
        return;
    }

    messages.forEach((message, index) => {
        const item = document.createElement('article');
        item.className = 'sb-conversation-message';
        item.dataset.role = message.role || 'character';
        item.dataset.messageId = message.id;
        item.dataset.pinned = String(Boolean(message.extra?.conversation_pinned));

        const avatarWrap = document.createElement('div');
        avatarWrap.className = 'sb-conversation-message-avatar';
        const image = document.createElement('img');
        image.alt = '';
        image.loading = index > 8 ? 'lazy' : 'eager';
        image.src = getConversationMessageAvatar(message, avatar);
        avatarWrap.appendChild(image);

        const bubble = document.createElement('div');
        bubble.className = 'sb-conversation-message-bubble';

        const meta = document.createElement('div');
        meta.className = 'sb-conversation-message-meta';
        const name = document.createElement('span');
        name.className = 'sb-conversation-message-name';
        name.textContent = message.name || (message.role === 'user' ? name1 || 'You' : getCurrentCharName());
        const time = document.createElement('time');
        time.className = 'sb-conversation-message-time';
        time.textContent = message.send_date || '';
        meta.append(name, time);

        const receiptText = getConversationMessageReceipt(message, avatar, { groupId });
        if (receiptText) {
            const receipt = document.createElement('span');
            receipt.className = 'sb-conversation-message-receipt';
            receipt.textContent = receiptText;
            meta.appendChild(receipt);
        }

        const actionBar = document.createElement('span');
        actionBar.className = 'sb-conversation-message-actions';

        if (settings.editable_messages) {
            const editButton = document.createElement('button');
            editButton.type = 'button';
            editButton.className = 'sb-conversation-message-action sb-conversation-message-edit fa-solid fa-pencil';
            editButton.title = 'Edit Conversation message';
            editButton.setAttribute('aria-label', 'Edit Conversation message');
            editButton.dataset.sbConversationAction = 'edit-message';
            editButton.dataset.messageId = message.id;
            actionBar.appendChild(editButton);
        }

        if (settings.prose_polisher && message.role !== 'user') {
            const polishButton = document.createElement('button');
            polishButton.type = 'button';
            polishButton.className = 'sb-conversation-message-action sb-conversation-message-polish fa-solid fa-wand-magic-sparkles';
            polishButton.title = 'Polish character message';
            polishButton.setAttribute('aria-label', 'Polish character message');
            polishButton.dataset.sbConversationAction = 'polish-character-message';
            polishButton.dataset.messageId = message.id;
            actionBar.appendChild(polishButton);
        }

        const messageActions = [
            { action: 'copy-message', icon: 'fa-copy', label: 'Copy message' },
            { action: 'toggle-message-pin', icon: 'fa-thumbtack', label: message.extra?.conversation_pinned ? 'Unpin message' : 'Pin message' },
            { action: 'branch-from-message', icon: 'fa-code-branch', label: 'Branch from here' },
        ];
        if (!['user', 'system'].includes(message.role || '')) {
            messageActions.push({ action: 'regenerate-message', icon: 'fa-rotate-right', label: 'Regenerate message' });
        }
        messageActions.push({ action: 'delete-message', icon: 'fa-trash-can', label: 'Delete message' });
        for (const messageAction of messageActions) {
            const actionButton = document.createElement('button');
            actionButton.type = 'button';
            actionButton.className = `sb-conversation-message-action fa-solid ${messageAction.icon}`;
            actionButton.title = messageAction.label;
            actionButton.setAttribute('aria-label', messageAction.label);
            actionButton.dataset.sbConversationAction = messageAction.action;
            actionButton.dataset.messageId = message.id;
            actionBar.appendChild(actionButton);
        }
        for (const reaction of Object.keys(CONVERSATION_REACTION_LABELS)) {
            const reactionButton = document.createElement('button');
            reactionButton.type = 'button';
            reactionButton.className = 'sb-conversation-reaction-button';
            reactionButton.textContent = normalizeConversationReactionLabel(reaction);
            reactionButton.dataset.sbConversationAction = 'react-message';
            reactionButton.dataset.messageId = message.id;
            reactionButton.dataset.reaction = reaction;
            actionBar.appendChild(reactionButton);
        }

        const mobileTrigger = document.createElement('button');
        mobileTrigger.type = 'button';
        mobileTrigger.className = 'sb-conversation-mobile-menu-trigger fa-solid fa-ellipsis';
        mobileTrigger.title = 'Message options';
        mobileTrigger.setAttribute('aria-label', 'Message options');

        const text = document.createElement('div');
        text.className = 'sb-conversation-message-text';
        if (message.mes) {
            text.innerHTML = messageFormatting(message.mes, message.name, false, message.role === 'user', -1, {}, false);
            highlightConversationMentions(text, avatar);
        }

        const imageUrl = message.extra?.image_url;
        if (typeof imageUrl === 'string' && imageUrl) {
            const figure = document.createElement('figure');
            figure.className = 'sb-conversation-image-preview';
            const img = document.createElement('img');
            img.src = imageUrl;
            img.alt = message.extra?.image_prompt || 'Generated image';
            img.loading = 'lazy';
            figure.appendChild(img);
            text.appendChild(figure);
        }

        renderConversationAttachments(text, message);

        const activeReactions = Object.entries(message.extra?.conversation_reactions || {})
            .filter(([, count]) => Number(count) > 0);
        if (activeReactions.length) {
            const reactions = document.createElement('div');
            reactions.className = 'sb-conversation-message-reactions';
            for (const [reaction, count] of activeReactions) {
                const chip = document.createElement('span');
                chip.className = 'sb-conversation-message-reaction-chip';
                chip.textContent = `${normalizeConversationReactionLabel(reaction)} ${count}`;
                reactions.appendChild(chip);
            }
            text.appendChild(reactions);
        }

        bubble.append(meta, text, actionBar, mobileTrigger);
        item.append(avatarWrap, bubble);
        timeline.appendChild(item);
    });

    const typingParticipants = getActiveTypingParticipants(avatar);
    const fallbackTypingCharacter = generationActive ? getCharacterForAvatar(avatar) : null;
    if (fallbackTypingCharacter?.avatar && !typingParticipants.some(participant => participant.avatar === fallbackTypingCharacter.avatar)) {
        typingParticipants.unshift(fallbackTypingCharacter);
    }

    for (const typingParticipant of typingParticipants) {
        const typingAvatar = typingParticipant?.avatar || getCurrentCharAvatar();
        const typingName = typingParticipant?.name || getCurrentCharName();
        const typingItem = document.createElement('div');
        typingItem.className = 'sb-conversation-message sb-conversation-typing-indicator';
        typingItem.dataset.role = typingAvatar !== getCurrentCharAvatar() ? 'partner' : 'character';

        const typingAvatarWrap = document.createElement('div');
        typingAvatarWrap.className = 'sb-conversation-message-avatar';
        const typingImage = document.createElement('img');
        typingImage.alt = '';
        typingImage.src = getThumbnailUrl('avatar', typingAvatar) || default_user_avatar;
        typingAvatarWrap.appendChild(typingImage);

        const typingBubble = document.createElement('div');
        typingBubble.className = 'sb-conversation-message-bubble';
        typingBubble.innerHTML = `
            <div class="sb-conversation-message-meta">
                <span class="sb-conversation-message-name">${escapeHtmlText(typingName)}</span>
            </div>
            <div class="sb-conversation-message-text sb-conversation-typing-dots">
                <span></span><span></span><span></span>
            </div>
        `;
        typingItem.append(typingAvatarWrap, typingBubble);
        timeline.appendChild(typingItem);
    }

    if (imageGenerationActive) {
        const pendingParticipant = getPrimaryTypingParticipant(avatar);
        const pendingAvatar = pendingParticipant?.avatar || getCurrentCharAvatar();
        const imageItem = document.createElement('div');
        imageItem.className = 'sb-conversation-message sb-conversation-image-pending';
        imageItem.dataset.role = pendingParticipant && pendingAvatar !== getCurrentCharAvatar() ? 'partner' : 'character';
        const imageAvatarWrap = document.createElement('div');
        imageAvatarWrap.className = 'sb-conversation-message-avatar';
        const pendingImage = document.createElement('img');
        pendingImage.alt = '';
        pendingImage.src = getThumbnailUrl('avatar', pendingAvatar) || default_user_avatar;
        imageAvatarWrap.appendChild(pendingImage);
        const imageBubble = document.createElement('div');
        imageBubble.className = 'sb-conversation-message-bubble';
        imageBubble.innerHTML = `
            <div class="sb-conversation-message-meta">
                <span class="sb-conversation-message-name">Image generation</span>
                <button type="button" class="sb-conversation-stop-image" data-sb-conversation-action="stop-image-generation">Stop</button>
            </div>
            <div class="sb-conversation-message-text sb-conversation-typing-dots">
                <span></span><span></span><span></span>
            </div>
        `;
        imageItem.append(imageAvatarWrap, imageBubble);
        timeline.appendChild(imageItem);
    }

    lastRenderedAvatar = avatar;
    lastRenderedMessageCount = allMessages.length;
    updateConversationToolsState();
    if (contextChanged || messagesAdded || isNearBottom) {
        timeline.scrollTop = timeline.scrollHeight;
    } else {
        timeline.scrollTop = previousScrollTop;
    }
}

function buildLorebookOptions(selected) {
    const options = ['<option value="">Character default (no override)</option>'];
    for (const worldName of (Array.isArray(world_names) ? world_names : [])) {
        const safe = escapeHtmlAttribute(worldName);
        options.push(`<option value="${safe}"${worldName === selected ? ' selected' : ''}>${escapeHtmlText(worldName)}</option>`);
    }
    return options.join('');
}

function buildConnectionProfileOptions(selected) {
    const options = ['<option value="">Use current connection</option>'];
    for (const profile of getConnectionProfiles()) {
        if (!profile?.name) {
            continue;
        }
        const safe = escapeHtmlAttribute(profile.name);
        options.push(`<option value="${safe}"${profile.name === selected ? ' selected' : ''}>${escapeHtmlText(profile.name)}</option>`);
    }
    return options.join('');
}

function buildPartnerOptions(selectedNames, emptyText = 'Enable more characters to pick partners.') {
    const selectedSet = new Set(parseAvatarList(selectedNames));
    const currentAvatar = getCurrentCharAvatar();
    const rows = [];
    (Array.isArray(characters) ? characters : []).forEach((character) => {
        if (!character?.avatar || character.avatar === currentAvatar) {
            return;
        }
        const charName = character.name || 'Character';
        const charAvatar = character.avatar;
        const checked = selectedSet.has(charAvatar) ? ' checked' : '';
        const thumbUrl = getThumbnailUrl('avatar', charAvatar);
        const profileOptions = buildConnectionProfileOptions(getSettings(charAvatar).connection_profile);
        rows.push(`
            <div class="sb-conversation-partner-option" data-char-name="${escapeHtmlAttribute(charName.toLowerCase())}">
                <label class="sb-conversation-partner-pick">
                    <input type="checkbox" class="sb-conversation-partner-checkbox" value="${escapeHtmlAttribute(charAvatar)}"${checked} />
                    <img class="sb-conversation-partner-avatar" src="${escapeHtmlAttribute(thumbUrl)}" alt="${escapeHtmlAttribute(charName)}" loading="lazy" />
                    <span class="sb-conversation-partner-name">${escapeHtmlText(charName)}</span>
                </label>
                <label class="sb-conversation-partner-profile-wrap" title="Connection profile for ${escapeHtmlAttribute(charName)}">
                    <span class="sr-only">${escapeHtmlText(charName)} connection profile</span>
                    <select class="text_pole textarea_compact sb-conversation-partner-profile" data-partner-avatar="${escapeHtmlAttribute(charAvatar)}">
                        ${profileOptions}
                    </select>
                </label>
            </div>
        `);
    });
    if (!rows.length) {
        return `<div class="sb-conversation-empty">${escapeHtmlText(emptyText)}</div>`;
    }
    return rows.join('');
}

function buildChimingPartnerOptions(selectedNames) {
    return buildPartnerOptions(selectedNames, 'Enable more characters to pick chiming partners.');
}

function getConversationTimelineMessages(messages) {
    const query = conversationTimelineSearchQuery.trim().toLowerCase();
    const channel = conversationTimelineChannel;
    return (Array.isArray(messages) ? messages : []).filter((message) => {
        if (!message) {
            return false;
        }

        if (channel === 'pinned') {
            if (!message.extra?.conversation_pinned) {
                return false;
            }
        } else if (channel === 'selfies') {
            if (!message.extra?.conversation_mode_image) {
                return false;
            }
        } else if (channel === 'media') {
            if (!getConversationAttachmentLabels(message).length) {
                return false;
            }
        } else if (channel === 'ooc') {
            if (!message.extra?.conversation_mode_ooc) {
                return false;
            }
        } else if (channel === 'memories') {
            const isMemoryMessage = Boolean(
                message.extra?.conversation_pinned
                || message.extra?.conversation_mode_reminder
                || message.extra?.conversation_mode_image,
            );
            if (!isMemoryMessage) {
                return false;
            }
        }

        if (query) {
            const haystack = [message.name, message.role, message.mes, getConversationAttachmentSummary(message)]
                .filter(Boolean)
                .join(' ')
                .toLowerCase();
            if (!haystack.includes(query)) {
                return false;
            }
        }

        return true;
    });
}

function setConversationTimelineChannel(channel) {
    conversationTimelineChannel = CONVERSATION_TIMELINE_CHANNELS.includes(channel) ? channel : 'main';
    updateConversationToolsState();
    renderConversationTimeline();
}

function updateConversationToolsState() {
    const tools = document.getElementById(CHROME_IDS.tools);
    if (!(tools instanceof HTMLElement)) {
        return;
    }

    tools.querySelectorAll('[data-channel]').forEach((button) => {
        if (button instanceof HTMLButtonElement) {
            const active = button.dataset.channel === conversationTimelineChannel;
            button.setAttribute('aria-pressed', String(active));
            button.dataset.active = String(active);
        }
    });

    const searchInput = document.getElementById(CHROME_IDS.search);
    if (searchInput instanceof HTMLInputElement && searchInput.value !== conversationTimelineSearchQuery) {
        searchInput.value = conversationTimelineSearchQuery;
    }
}

function updateConversationSearchQuery(value) {
    conversationTimelineSearchQuery = String(value || '').trim();
    renderConversationTimeline();
}

function getConversationMessageById(messageId, { groupId = getConversationGroupIdForAvatar(getCurrentCharAvatar()) } = {}) {
    const avatar = getCurrentCharAvatar();
    if (!avatar || !messageId) {
        return null;
    }

    const messages = getConversationThread(avatar, { groupId });
    const message = messages.find(item => item.id === messageId);
    return message ? { avatar, groupId, messages, message } : null;
}

function saveConversationMessageThread(context) {
    if (!context?.avatar) {
        return;
    }

    saveConversationThread(context.avatar, context.messages, { groupId: context.groupId });
    if (context.messages.length) {
        updateLastPreviewFromConversation(context.avatar, { groupId: context.groupId });
    } else {
        const branch = getActiveConversationBranch(context.avatar, { groupId: context.groupId });
        if (branch) {
            branch.preview = 'Conversation ready';
            persistConversationStore();
        }
    }
    renderConversationTimeline();
}

async function copyConversationMessage(messageId) {
    const context = getConversationMessageById(messageId);
    if (!context) {
        return;
    }

    const payload = context.message.mes || getConversationAttachmentSummary(context.message) || '';
    if (!payload) {
        return;
    }

    try {
        await navigator.clipboard.writeText(payload);
        globalThis.toastr?.success?.('Message copied.');
    } catch {
        globalThis.toastr?.warning?.('Could not copy message text.');
    }
}

function toggleConversationMessagePin(messageId) {
    const context = getConversationMessageById(messageId);
    if (!context) {
        return;
    }

    context.message.extra = { ...context.message.extra, conversation_pinned: !context.message.extra?.conversation_pinned };
    saveConversationMessageThread(context);
}

function reactConversationMessage(messageId, reaction) {
    const context = getConversationMessageById(messageId);
    if (!context || !reaction) {
        return;
    }

    const reactions = { ...(context.message.extra?.conversation_reactions || {}) };
    reactions[reaction] = reactions[reaction] ? 0 : 1;
    context.message.extra = { ...context.message.extra, conversation_reactions: reactions };
    saveConversationMessageThread(context);
}

function deleteConversationMessage(messageId) {
    const context = getConversationMessageById(messageId);
    if (!context) {
        return;
    }

    context.messages = context.messages.filter(item => item.id !== messageId);
    saveConversationMessageThread(context);
}

async function regenerateConversationMessage(messageId) {
    const context = getConversationMessageById(messageId);
    if (!context || ['user', 'system'].includes(context.message.role || '')) {
        return;
    }

    const index = context.messages.findIndex(item => item.id === messageId);
    if (index < 0) {
        return;
    }

    const speakerAvatar = context.message.extra?.partner_avatar || context.avatar;
    const settings = getSettings(speakerAvatar);
    const speakerName = context.message.name || getCharacterForAvatar(speakerAvatar)?.name || getCurrentCharName();
    const prompt = await buildConversationPromptMessages(
        context.messages.slice(0, index),
        '[System directive: Regenerate the selected Conversation reply. Keep the same speaker, casual DM style, and current context. Output only the replacement message.]',
        speakerName,
    );

    try {
        const response = await withConversationConnectionProfile(settings, () => generateRaw({
            prompt,
            systemPrompt: buildConversationSystemPrompt(settings, speakerAvatar, {
                threadAvatar: context.avatar,
                groupId: context.groupId,
            }),
            responseLength: getConversationReplyMaxTokens(settings),
            trimNames: true,
            cacheScope: 'conversation-mode',
        }));

        const text = normalizeConversationOutputText(response || '');
        if (!text) {
            globalThis.toastr?.warning?.('Regenerate returned no message.');
            return;
        }

        context.message.mes = text;
        context.message.extra = { ...context.message.extra, regenerated_at: Date.now() };
        saveConversationMessageThread(context);
        globalThis.toastr?.success?.('Message regenerated.');
    } catch (error) {
        reportConversationGenerationError('regenerate', error, { level: 'warning' });
    }
}

function branchConversationFromMessage(messageId) {
    const context = getConversationMessageById(messageId);
    if (!context) {
        return;
    }

    const index = context.messages.findIndex(item => item.id === messageId);
    if (index < 0) {
        return;
    }

    const sourceBranch = getActiveConversationBranch(context.avatar, { groupId: context.groupId });
    if (!sourceBranch) {
        return;
    }

    const branch = createConversationBranch(`Branch ${getConversationBranches(context.avatar, { groupId: context.groupId }).length + 1}`);
    branch.messages = context.messages.slice(0, index + 1).map(item => ({ ...item, extra: { ...(item.extra || {}) } }));
    branch.preview = getConversationMessagePreviewText(branch.messages[branch.messages.length - 1]) || 'Conversation ready';
    branch.updatedAt = Date.now();
    if (sourceBranch.memorySummary) {
        branch.memorySummary = sourceBranch.memorySummary;
        branch.memoryMessageCount = sourceBranch.memoryMessageCount;
    }
    const store = getConversationThreadStore(context.avatar, { groupId: context.groupId });
    if (!store) {
        return;
    }

    store.branches[branch.id] = branch;
    store.activeBranchId = branch.id;
    persistConversationStore();
    openConversationWorkspaceForAvatar(context.avatar, { groupId: context.groupId || null, showToast: false });
    renderConversationTimeline();
    renderPalsRail();
}

async function quickConversationSelfie() {
    const avatar = getCurrentCharAvatar();
    if (!avatar) {
        return;
    }

    const settings = getSettings(avatar);
    const groupId = getConversationGroupIdForAvatar(avatar);
    const context = globalThis.prompt?.('Describe the selfie context', 'a casual selfie in the current DM conversation');
    if (typeof context !== 'string') {
        return;
    }

    await generateSelfieFromContext(context.trim(), settings, avatar, { groupId });
}

async function quickConversationReminder() {
    const avatar = getCurrentCharAvatar();
    if (!avatar) {
        return;
    }

    const groupId = getConversationGroupIdForAvatar(avatar);
    const delay = globalThis.prompt?.('When should the reminder fire?', '1h');
    if (typeof delay !== 'string' || !delay.trim()) {
        return;
    }

    const memo = globalThis.prompt?.('Reminder text', 'Reply to this later');
    if (typeof memo !== 'string') {
        return;
    }

    addConversationReminder(avatar, groupId, delay, memo);
}

async function quickConversationSummarize() {
    const avatar = getCurrentCharAvatar();
    if (!avatar) {
        return;
    }

    const groupId = getConversationGroupIdForAvatar(avatar);
    await updateConversationMemorySummary(avatar, { force: true, groupId, notify: true });
    renderConversationMemoryPanel();
}

function parseConversationSlashCommand(text) {
    const value = String(text || '').trim();
    if (!value.startsWith('/')) {
        return null;
    }

    const match = value.match(/^\/([a-z]+)(?:\s+([\s\S]*))?$/i);
    if (!match) {
        return null;
    }

    return {
        command: match[1].toLowerCase(),
        args: String(match[2] || '').trim(),
    };
}

function parseConversationReminderArgs(args) {
    const value = String(args || '').trim();
    if (!value) {
        return null;
    }

    const [delayPart, ...memoParts] = value.split('|');
    if (memoParts.length) {
        const delay = delayPart.trim();
        const memo = memoParts.join('|').trim();
        return delay && memo ? { delay, memo } : null;
    }

    const [delay, ...memoWords] = value.split(/\s+/);
    const memo = memoWords.join(' ').trim();
    return delay && memo ? { delay, memo } : null;
}

function appendConversationOocNote(note, { avatar = getCurrentCharAvatar(), groupId = getConversationGroupIdForAvatar(avatar) } = {}) {
    const text = String(note || '').trim();
    if (!avatar || !text) {
        return false;
    }

    appendConversationThreadMessage(avatar, {
        role: 'system',
        name: 'OOC Note',
        mes: text,
        extra: {
            conversation_mode_ooc: true,
        },
    }, { groupId });
    updateLastPreviewFromConversation(avatar, { groupId });
    renderConversationTimeline();
    return true;
}

async function handleConversationSlashAction(text, { avatar = getCurrentCharAvatar(), settings = getSettings(avatar), groupId = getConversationGroupIdForAvatar(avatar) } = {}) {
    const parsed = parseConversationSlashCommand(text);
    if (!parsed || !avatar) {
        return false;
    }

    switch (parsed.command) {
        case 'selfie': {
            const context = parsed.args || 'a casual selfie in the current DM conversation';
            await generateSelfieFromContext(context, settings, avatar, { groupId });
            return true;
        }
        case 'remind': {
            const reminder = parseConversationReminderArgs(parsed.args);
            if (!reminder) {
                globalThis.toastr?.warning?.('Use /remind 1h | message to schedule a reminder.', '', SAFE_TOAST_OPTIONS);
                return true;
            }

            addConversationReminder(avatar, groupId, reminder.delay, reminder.memo);
            return true;
        }
        case 'schedule':
            openScheduleEditorModal(avatar);
            return true;
        case 'summarize':
            await quickConversationSummarize();
            return true;
        case 'ooc':
            if (!parsed.args) {
                globalThis.toastr?.warning?.('Use /ooc followed by a note for the OOC channel.', '', SAFE_TOAST_OPTIONS);
                return true;
            }
            appendConversationOocNote(parsed.args, { avatar, groupId });
            return true;
        default:
            return false;
    }
}

function updateConversationNotificationSettingsVisibility() {
    const muted = document.getElementById('sb_conv_notifications_muted');
    const priority = document.getElementById('sb_conv_notification_priority');
    const shouldDisablePriority = muted instanceof HTMLInputElement && muted.checked;
    if (priority instanceof HTMLSelectElement) {
        priority.disabled = shouldDisablePriority;
    }
}

function addConversationFilesToInput(files) {
    const fileInput = document.getElementById(CHROME_IDS.fileInput);
    if (!(fileInput instanceof HTMLInputElement) || !files?.length) {
        return;
    }

    const transfer = typeof DataTransfer === 'function' ? new DataTransfer() : null;
    const previousTransfer = typeof DataTransfer === 'function' ? new DataTransfer() : null;
    if (!transfer || !previousTransfer) {
        return;
    }

    for (const file of Array.from(fileInput.files || [])) {
        previousTransfer.items.add(file);
        transfer.items.add(file);
    }
    for (const file of files) {
        transfer.items.add(file);
    }

    fileInput.files = transfer.files;
    if (getValidatedConversationPendingFiles({ notify: true })) {
        updateConversationAttachmentPreview();
    } else {
        fileInput.files = previousTransfer.files;
        updateConversationAttachmentPreview();
    }
}

function normalizeConversationReactionLabel(reaction) {
    return CONVERSATION_REACTION_LABELS[reaction] || reaction;
}

function escapeHtmlAttribute(value) {
    return String(value ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeHtmlText(value) {
    return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function getConversationMentionTargets(avatar = getCurrentCharAvatar()) {
    if (!avatar) {
        return [];
    }

    return getConversationParticipants(avatar, getSettings(avatar))
        .filter(character => character?.avatar && character.name);
}

function collectMentionTextNodes(node, nodes = []) {
    if (!node) {
        return nodes;
    }

    if (node.nodeType === Node.TEXT_NODE) {
        if (node.nodeValue?.includes('@')) {
            nodes.push(node);
        }
        return nodes;
    }

    if (node instanceof HTMLElement && node.matches('a, code, pre, .sb-conversation-mention')) {
        return nodes;
    }

    node.childNodes.forEach(child => collectMentionTextNodes(child, nodes));
    return nodes;
}

function highlightConversationMentions(container, avatar = getCurrentCharAvatar()) {
    if (!(container instanceof HTMLElement)) {
        return;
    }

    const handles = [];
    for (const character of getConversationMentionTargets(avatar)) {
        for (const handle of getCharacterMentionHandles(character)) {
            if (!handles.includes(handle)) {
                handles.push(handle);
            }
        }
    }

    if (!handles.length) {
        return;
    }

    const mentionRe = new RegExp(`(^|[^a-z0-9_])(${handles.sort((left, right) => right.length - left.length).map(escapeRegExp).join('|')})(?=$|[^a-z0-9_])`, 'gi');
    for (const textNode of collectMentionTextNodes(container)) {
        const value = textNode.nodeValue || '';
        mentionRe.lastIndex = 0;
        if (!mentionRe.test(value)) {
            continue;
        }

        mentionRe.lastIndex = 0;
        const fragment = document.createDocumentFragment();
        let lastIndex = 0;
        let match;
        while ((match = mentionRe.exec(value)) !== null) {
            const prefix = match[1] || '';
            const mention = match[2] || '';
            const mentionStart = match.index + prefix.length;
            if (mentionStart > lastIndex) {
                fragment.appendChild(document.createTextNode(value.slice(lastIndex, mentionStart)));
            }

            const tag = document.createElement('span');
            tag.className = 'sb-conversation-mention';
            tag.textContent = mention;
            fragment.appendChild(tag);
            lastIndex = mentionStart + mention.length;
        }

        if (lastIndex < value.length) {
            fragment.appendChild(document.createTextNode(value.slice(lastIndex)));
        }
        textNode.parentNode?.replaceChild(fragment, textNode);
    }
}

function buildSettingsDrawerHtml() {
    const settings = getSettings();
    return `
        <div class="sb-conversation-settings-header">
            <div>
                <div class="sb-conversation-settings-kicker">Conversation Mode</div>
                <div class="sb-conversation-settings-title">DM controls</div>
            </div>
            <button type="button" class="menu_button menu_button_icon" data-sb-conversation-action="close-settings" title="Close Conversation settings" aria-label="Close Conversation settings">
                <i class="fa-solid fa-xmark"></i>
            </button>
        </div>
        <div class="sb-conversation-settings-body">
            <div class="sb-settings-group">
                <h4 class="sb-settings-group-title"><i class="fa-solid fa-signal" aria-hidden="true"></i><span>Presence & Availability</span></h4>
                <div class="sb-conversation-field-stack">
                    <label for="sb_conv_availability">Status</label>
                    <select id="sb_conv_availability" class="text_pole textarea_compact wide100p">
                        <option value="online">Online</option>
                        <option value="idle">Idle</option>
                        <option value="dnd">Do Not Disturb</option>
                        <option value="offline">Offline</option>
                    </select>
                </div>
                <div class="sb-conversation-field-stack">
                    <label>User Idle Actions</label>
                    <div class="sb-conversation-idle-actions">
                        <label class="checkbox_label" title="After the user has been quiet, send a check-in tied to the current conversation.">
                            <input id="sb_conv_idle_followup" type="checkbox" />
                            <span>Send auto follow-up</span>
                        </label>
                        <label class="checkbox_label" title="After a longer quiet stretch, start a casual new topic or send an ambient thought.">
                            <input id="sb_conv_idle_spontaneous" type="checkbox" />
                            <span>Spontaneous ping</span>
                        </label>
                    </div>
                    <p class="sb-conversation-field-hint">Follow-ups react to silence in the current thread. Spontaneous pings can start a fresh thought; when both are enabled, pings wait for a longer quiet stretch.</p>
                </div>
                <div class="sb-conversation-field-stack">
                    <label for="sb_conv_idle_limit">Idle Minimum (minutes)</label>
                    <input id="sb_conv_idle_limit" class="text_pole textarea_compact wide100p" type="number" min="1" max="1440" step="1" value="15" />
                </div>
                <div class="sb-conversation-field-stack">
                    <label for="sb_conv_offline_message">Offline/DND Auto-responder</label>
                    <input id="sb_conv_offline_message" class="text_pole textarea_compact wide100p" type="text" placeholder="[Character is currently away. Leave a message!]" />
                </div>
                <div class="sb-conversation-field-stack">
                    <label>DM Notifications</label>
                    <div class="sb-conversation-notification-grid">
                        <label class="checkbox_label" title="Keep unread badges but suppress sounds and popups for this Conversation.">
                            <input id="sb_conv_notifications_muted" type="checkbox" />
                            <span>Mute this DM</span>
                        </label>
                        <label class="sb-conversation-field-stack" for="sb_conv_notification_priority">
                            <span>Priority</span>
                            <select id="sb_conv_notification_priority" class="text_pole textarea_compact wide100p">
                                <option value="normal">Normal</option>
                                <option value="silent">Silent</option>
                                <option value="priority">Priority</option>
                            </select>
                        </label>
                        <label class="sb-conversation-field-stack" for="sb_conv_quiet_hours_start">
                            <span>Quiet start</span>
                            <input id="sb_conv_quiet_hours_start" class="text_pole textarea_compact wide100p" type="time" />
                        </label>
                        <label class="sb-conversation-field-stack" for="sb_conv_quiet_hours_end">
                            <span>Quiet end</span>
                            <input id="sb_conv_quiet_hours_end" class="text_pole textarea_compact wide100p" type="time" />
                        </label>
                    </div>
                    <p class="sb-conversation-field-hint">Unread badges still update while muted or inside quiet hours.</p>
                </div>
            </div>
            <div class="sb-settings-group">
                <h4 class="sb-settings-group-title"><i class="fa-solid fa-calendar-days" aria-hidden="true"></i><span>Character Schedule</span></h4>
                <p class="sb-conversation-field-hint">Auto-generate a weekly schedule using the current active connection profile and selected model. This informs when the character is available to chat.</p>
                <div class="sb-conversation-field-stack">
                    <div class="sb-conversation-field-row" style="gap: 8px;">
                        <button type="button" class="menu_button sb-conversation-generate-schedule" data-sb-conversation-action="generate-schedule" style="flex: 1;">
                            <i class="fa-solid fa-wand-magic-sparkles" aria-hidden="true"></i><span>Generate schedule</span>
                        </button>
                        <button type="button" class="menu_button" data-sb-conversation-action="edit-schedule" style="flex: 1;">
                            <i class="fa-solid fa-pencil" aria-hidden="true"></i><span>Edit schedule</span>
                        </button>
                    </div>
                    <div class="sb-conversation-schedule-display" id="sb_conv_schedule_display" aria-live="polite"></div>
                    <input id="sb_conv_auto_schedule" type="hidden" value="${escapeHtmlAttribute(settings.auto_schedule)}" />
                </div>
            </div>
            <div class="sb-settings-group">
                <h4 class="sb-settings-group-title"><i class="fa-solid fa-comment-dots" aria-hidden="true"></i><span>Proactive Messaging</span></h4>
                <label class="checkbox_label" title="Let the character message you first based on their schedule and mood">
                    <input id="sb_conv_proactive_messaging" type="checkbox" />
                    <span>Let this character message me first</span>
                </label>
                <div class="sb-conversation-proactive-inputs">
                    <div class="sb-conversation-field-stack">
                        <label for="sb_conv_inactivity_threshold">Patience (mins)</label>
                        <input id="sb_conv_inactivity_threshold" class="text_pole textarea_compact wide100p" type="number" min="15" max="360" step="5" value="120" />
                    </div>
                    <div class="sb-conversation-field-stack">
                        <label for="sb_conv_max_followups">Max follow-ups</label>
                        <input id="sb_conv_max_followups" class="text_pole textarea_compact wide100p" type="number" min="1" max="3" step="1" value="3" />
                    </div>
                    <div class="sb-conversation-field-stack">
                        <label for="sb_conv_talkativeness">Talkativeness</label>
                        <input id="sb_conv_talkativeness" class="text_pole textarea_compact wide100p" type="number" min="0" max="100" step="5" value="50" />
                    </div>
                    <div class="sb-conversation-field-stack">
                        <label for="sb_conv_reply_delay_multiplier">Reply delay</label>
                        <input id="sb_conv_reply_delay_multiplier" class="text_pole textarea_compact wide100p" type="number" min="0" max="300" step="10" value="100" />
                    </div>
                    <div class="sb-conversation-field-stack">
                        <label for="sb_conv_reply_max_tokens">Max reply tokens</label>
                        <input id="sb_conv_reply_max_tokens" class="text_pole textarea_compact wide100p" type="number" min="64" max="64000" step="64" value="16000" />
                    </div>
                </div>
                <p class="sb-conversation-field-hint">Max reply tokens is the generation budget for each Conversation reply. Raise it if messages cut off mid-thought.</p>
                <div class="sb-conversation-field-row">
                    <label class="checkbox_label" title="Let the character turn [selfie: prompt] into a Quick Image Gen request">
                        <input id="sb_conv_selfie_command_enabled" type="checkbox" />
                        <span>Selfies through Quick Image Gen ([selfie])</span>
                    </label>
                    <label class="checkbox_label" title="Let the character update its current availability/activity through [schedule_update]">
                        <input id="sb_conv_schedule_command_enabled" type="checkbox" />
                        <span>Character status updates ([schedule_update])</span>
                    </label>
                </div>
                <p class="sb-conversation-field-hint">Selfie commands are hidden from the chat and sent as image prompts. Schedule updates let the character adjust what they are doing now.</p>
            </div>
            <div class="sb-settings-group">
                <h4 class="sb-settings-group-title"><i class="fa-solid fa-brain" aria-hidden="true"></i><span>Chat Memories</span></h4>
                <p class="sb-conversation-field-hint">Branch-specific notes the LLM writes for continuity. They are sent back into future Conversation replies, but they do not copy old messages.</p>
                <div class="sb-conversation-field-stack">
                    <label for="sb_conv_memory_summary">Current branch memory</label>
                    <textarea id="sb_conv_memory_summary" class="text_pole textarea_compact wide100p sb-conversation-memory-summary" rows="5" readonly placeholder="No memory summary yet. It appears after enough messages, or you can refresh it manually once this branch has chat history."></textarea>
                    <p id="sb_conv_memory_meta" class="sb-conversation-field-hint sb-conversation-memory-meta"></p>
                </div>
                <div class="sb-conversation-field-row sb-conversation-memory-actions">
                    <button type="button" class="menu_button" data-sb-conversation-action="refresh-memory">
                        <i class="fa-solid fa-rotate" aria-hidden="true"></i><span>Refresh memory</span>
                    </button>
                    <button type="button" class="menu_button" data-sb-conversation-action="clear-memory">
                        <i class="fa-solid fa-eraser" aria-hidden="true"></i><span>Clear memory</span>
                    </button>
                </div>
                <label class="checkbox_label" title="Copy this branch's memory summary into newly created Conversation branches for this character">
                    <input id="sb_conv_copy_memory_to_new_branch" type="checkbox" />
                    <span>Carry current memory into new branches</span>
                </label>
            </div>
            <div class="sb-settings-group">
                <h4 class="sb-settings-group-title"><i class="fa-solid fa-clock" aria-hidden="true"></i><span>Manual Scheduling (optional)</span></h4>
                <p class="sb-conversation-field-hint">Use this for fixed-time check-ins. Weekly slots decide when messages can happen; cooldown prevents repeated sends too close together.</p>
                <div class="sb-conversation-field-row">
                    <label class="checkbox_label" title="Enable autonomous scheduled messages">
                        <input id="sb_conv_auto_message" type="checkbox" />
                        <span>Enable Scheduling</span>
                    </label>
                    <label class="checkbox_label sb-conversation-inline-number" title="Auto-message minimum delay/cooldown in seconds">
                        <span>Cooldown</span>
                        <input id="sb_conv_cooldown" class="text_pole textarea_compact widthUnset" type="number" min="10" max="9999" step="1" value="60" />
                        <span class="auto_mode_delay_unit">secs</span>
                    </label>
                </div>
                <div class="sb-conversation-field-stack">
                    <label>Weekly Schedule</label>
                    <div class="sb-conversation-weekly-schedule" id="sb_conv_weekly_schedule_editor"></div>
                    <button type="button" class="menu_button sb-conversation-weekly-add" data-sb-conversation-action="weekly-add">
                        <i class="fa-solid fa-plus" aria-hidden="true"></i><span>Add weekly slot</span>
                    </button>
                    <input id="sb_conv_weekly_schedule" type="hidden" value="${escapeHtmlAttribute(settings.weekly_schedule)}" />
                </div>
            </div>
            <div class="sb-settings-group">
                <h4 class="sb-settings-group-title"><i class="fa-solid fa-scroll" aria-hidden="true"></i><span>Prompts & Formats</span></h4>
                <div class="sb-conversation-field-stack">
                    <label for="sb_conv_geechan_chatroom_prompt">Geechan Chatroom System Prompt</label>
                    <textarea id="sb_conv_geechan_chatroom_prompt" class="text_pole textarea_compact autoSetHeight wide100p" rows="3" placeholder="Type the chatroom system prompt here..."></textarea>
                    <button type="button" class="menu_button sb-conversation-reset-prompt" data-sb-conversation-action="reset-prompt" style="margin-top: 4px; align-self: flex-start; padding: 4px 8px; font-size: var(--sb-type-meta);">
                        <i class="fa-solid fa-rotate-left" aria-hidden="true"></i><span>Reset to default</span>
                    </button>
                </div>
                <div class="sb-conversation-field-stack">
                    <label for="sb_conv_custom_instructions">Custom Instructions</label>
                    <textarea id="sb_conv_custom_instructions" class="text_pole textarea_compact autoSetHeight wide100p" rows="3" placeholder="Type any custom instructions or guidelines here..."></textarea>
                </div>
                <label class="checkbox_label" title="Enable additional characters in the chat to chime in">
                    <input id="sb_conv_multi_char" type="checkbox" />
                    <span>Add additional members in the chat</span>
                </label>
                <div id="sb_conv_group_members_wrapper" class="sb-conversation-field-stack">
                    <div class="sb-conversation-field-stack" style="margin: 0; padding: 0;">
                        <label>Group DM Members</label>
                        <p class="sb-conversation-field-hint">Selected characters are considered part of this Conversation thread. Type @Name, such as @Kaveh, to tag them. Autonomous character-to-character chat uses this same group list.</p>
                        <input type="text" id="sb_conv_multi_char_search" class="text_pole textarea_compact wide100p" placeholder="Search group members..." style="margin-bottom: 8px;" />
                        <div class="sb-conversation-partner-list" id="sb_conv_chiming_partner_list">${buildChimingPartnerOptions(settings.multi_char_names)}</div>
                        <input id="sb_conv_multi_char_names" type="hidden" value="${escapeHtmlAttribute(settings.multi_char_names)}" />
                    </div>
                    <label class="checkbox_label" title="Allow enabled characters to chat with each other autonomously in this thread">
                        <input id="sb_conv_auto_character_chat" type="checkbox" />
                        <span>Allow characters to talk to each other</span>
                    </label>
                    <label class="checkbox_label sb-conversation-inline-number" title="Minimum time between autonomous character-to-character messages in this Conversation thread">
                        <span>Character chat cooldown</span>
                        <input id="sb_conv_auto_chat_cooldown" class="text_pole textarea_compact widthUnset" type="number" min="1" max="1440" step="1" value="${DEFAULT_AUTO_CHAT_COOLDOWN}" />
                        <span class="auto_mode_delay_unit">mins</span>
                    </label>
                </div>
                <label class="checkbox_label" title="Allow this character to privately react to the current roleplay or group chat">
                    <input id="sb_conv_roleplay_reactions" type="checkbox" />
                    <span>React to current roleplay</span>
                </label>
            </div>
            <div class="sb-settings-group">
                <h4 class="sb-settings-group-title"><i class="fa-solid fa-book-atlas" aria-hidden="true"></i><span>Context Overrides</span></h4>
                <div class="sb-conversation-field-stack">
                    <label for="sb_conv_lorebook_override">Lorebook Override</label>
                    <select id="sb_conv_lorebook_override" class="text_pole textarea_compact wide100p">
                        ${buildLorebookOptions(settings.lorebook_override)}
                    </select>
                </div>
                <div class="sb-conversation-field-stack">
                    <label for="sb_conv_connection_profile">Connection Profile</label>
                    <select id="sb_conv_connection_profile" class="text_pole textarea_compact wide100p">
                        ${buildConnectionProfileOptions(settings.connection_profile)}
                    </select>
                </div>
                <div class="sb-conversation-field-stack">
                    <label for="sb_conv_authors_note">Author's Note Override</label>
                    <textarea id="sb_conv_authors_note" class="text_pole textarea_compact autoSetHeight wide100p" rows="2" placeholder="[Author's Note: Keep responses short, direct, and conversational as if chatting in a DM.]"></textarea>
                </div>
            </div>
            <div class="sb-settings-group">
                <h4 class="sb-settings-group-title"><i class="fa-solid fa-image" aria-hidden="true"></i><span>Image Generation</span></h4>
                <label class="checkbox_label" title="Enable in-chat image generation via Quick Image Gen">
                    <input id="sb_conv_image_gen_enabled" type="checkbox" />
                    <span>Enable chatroom image generation (Quick Image Gen)</span>
                </label>
                <div class="sb-conversation-field-stack">
                    <label for="sb_conv_image_gen_prompt_template">Image Prompt Template</label>
                    <input id="sb_conv_image_gen_prompt_template" type="text" class="text_pole wide100p" placeholder="a photo of {{char}}, {{scene}}" />
                </div>
                <div class="sb-conversation-field-stack">
                    <label for="sb_conv_image_gen_negative">Negative Prompt</label>
                    <input id="sb_conv_image_gen_negative" type="text" class="text_pole wide100p" placeholder="blurry, distorted" />
                </div>
                <div class="sb-conversation-field-stack">
                    <label for="sb_conv_image_gen_cooldown">Image Cooldown (minutes)</label>
                    <input id="sb_conv_image_gen_cooldown" type="number" min="0" max="1440" step="1" class="text_pole wide100p" value="10" />
                </div>
                <label class="checkbox_label" title="Character spontaneously generates selfies during the conversation">
                    <input id="sb_conv_spontaneous_selfies" type="checkbox" />
                    <span>Enable Spontaneous Selfies</span>
                </label>
                <div class="sb-conversation-field-stack">
                    <label for="sb_conv_selfie_prompt">Selfie Prompt Template</label>
                    <input id="sb_conv_selfie_prompt" type="text" class="text_pole wide100p" placeholder="raw photo, selfie of {{char}}" />
                </div>
            </div>
            <div class="sb-settings-group">
                <h4 class="sb-settings-group-title"><i class="fa-solid fa-wand-magic-sparkles" aria-hidden="true"></i><span>DM Tweaks</span></h4>
                <label class="checkbox_label" title="Add quick inline edit buttons next to messages in the Conversation thread">
                    <input id="sb_conv_editable_messages" type="checkbox" />
                    <span>Enable Quick-Edit DM Actions</span>
                </label>
                <label class="checkbox_label" title="Enable a magic wand icon on character replies to polish and refine their outputs.">
                    <input id="sb_conv_prose_polisher" type="checkbox" />
                    <span>Character Prose Polisher</span>
                </label>
            </div>
        </div>
    `;
}

function ensureConversationChrome() {
    const sheld = document.getElementById('sheld');
    const chatElement = document.getElementById('chat');
    if (!(sheld instanceof HTMLElement) || !(chatElement instanceof HTMLElement)) {
        return null;
    }

    let header = document.getElementById(CHROME_IDS.header);
    if (!(header instanceof HTMLElement)) {
        header = document.createElement('div');
        header.id = CHROME_IDS.header;
        header.classList.add('drag-grabber');
        header.hidden = true;
        header.innerHTML = `
            <button id="${CHROME_IDS.palsToggle}" type="button" class="menu_button menu_button_icon" data-sb-conversation-action="toggle-pals" title="Open Conversation pals" aria-label="Open Conversation pals">
                <i class="fa-solid fa-address-book"></i>
                <span class="sb-conversation-pals-toggle-badge" hidden></span>
            </button>
            <div class="sb-conversation-header-avatar" data-sb-conversation-participants></div>
            <div class="sb-conversation-header-copy">
                <div class="sb-conversation-header-kicker">Conversation Workspace</div>
                <div class="sb-conversation-header-name" data-sb-conversation-name>Conversation</div>
                <div class="sb-conversation-header-status" data-sb-conversation-status>Available for live DM replies.</div>
            </div>
            <div class="sb-conversation-header-actions">
                <button type="button" class="menu_button menu_button_icon sb-conversation-header-add-member" data-sb-conversation-action="open-add-member" title="Add member to Conversation" aria-label="Add member to Conversation" hidden>
                    <i class="fa-solid fa-user-plus" aria-hidden="true"></i>
                    <span>Add Member</span>
                </button>
                <button type="button" class="menu_button menu_button_icon" data-sb-conversation-action="new-chat" title="Clear DM History (New Chat)" aria-label="Clear DM History (New Chat)">
                    <i class="fa-solid fa-trash-can" aria-hidden="true"></i>
                    <span>New Chat</span>
                </button>
                <button type="button" class="menu_button menu_button_icon" data-sb-conversation-action="return-roleplay" title="Return to roleplay chat" aria-label="Return to roleplay chat">
                    <i class="fa-solid fa-masks-theater" aria-hidden="true"></i>
                    <span>Roleplay</span>
                </button>
                <button type="button" class="menu_button menu_button_icon sb-conversation-header-settings" data-sb-conversation-action="open-settings" title="Conversation settings" aria-label="Conversation settings">
                    <i class="fa-solid fa-gear"></i>
                </button>
            </div>
        `;
        sheld.insertBefore(header, chatElement);
    }

    let stage = document.getElementById(CHROME_IDS.stage);
    if (!(stage instanceof HTMLElement)) {
        stage = document.createElement('section');
        stage.id = CHROME_IDS.stage;
        stage.hidden = true;
        stage.setAttribute('aria-label', 'Conversation messages');
        stage.innerHTML = `
            <div id="${CHROME_IDS.timeline}" class="sb-conversation-timeline" role="log" aria-live="polite"></div>
            <div id="${CHROME_IDS.tools}" class="sb-conversation-tools" aria-label="Conversation tools">
                <div class="sb-conversation-channel-tabs" role="tablist" aria-label="Conversation filters">
                    <button type="button" class="sb-conversation-channel-tab" data-sb-conversation-action="set-channel" data-channel="main" aria-pressed="true">Main</button>
                    <button type="button" class="sb-conversation-channel-tab" data-sb-conversation-action="set-channel" data-channel="pinned" aria-pressed="false">Pins</button>
                    <button type="button" class="sb-conversation-channel-tab" data-sb-conversation-action="set-channel" data-channel="selfies" aria-pressed="false">Selfies</button>
                    <button type="button" class="sb-conversation-channel-tab" data-sb-conversation-action="set-channel" data-channel="media" aria-pressed="false">Files</button>
                    <button type="button" class="sb-conversation-channel-tab" data-sb-conversation-action="set-channel" data-channel="ooc" aria-pressed="false">OOC</button>
                    <button type="button" class="sb-conversation-channel-tab" data-sb-conversation-action="set-channel" data-channel="memories" aria-pressed="false">Memories</button>
                </div>
                <label class="sb-conversation-search-wrap" for="${CHROME_IDS.search}">
                    <i class="fa-solid fa-magnifying-glass" aria-hidden="true"></i>
                    <span class="sr-only">Search Conversation messages</span>
                    <input id="${CHROME_IDS.search}" class="text_pole textarea_compact" type="search" placeholder="Search this DM" autocomplete="off" />
                </label>
                <div class="sb-conversation-quick-actions" aria-label="Quick actions">
                    <button type="button" class="sb-conversation-tool-button" data-sb-conversation-action="quick-selfie" title="Generate a selfie from the current context">
                        <i class="fa-solid fa-camera" aria-hidden="true"></i><span>Selfie</span>
                    </button>
                    <button type="button" class="sb-conversation-tool-button" data-sb-conversation-action="quick-remind" title="Schedule a reminder in this DM">
                        <i class="fa-solid fa-bell" aria-hidden="true"></i><span>Remind</span>
                    </button>
                    <button type="button" class="sb-conversation-tool-button" data-sb-conversation-action="edit-schedule" title="Edit character schedule">
                        <i class="fa-solid fa-calendar-days" aria-hidden="true"></i><span>Schedule</span>
                    </button>
                    <button type="button" class="sb-conversation-tool-button" data-sb-conversation-action="quick-summarize" title="Refresh Conversation memory">
                        <i class="fa-solid fa-book-open" aria-hidden="true"></i><span>Summarize</span>
                    </button>
                </div>
            </div>
            <div id="${CHROME_IDS.dropHint}" class="sb-conversation-drop-hint" hidden>Drop files to attach</div>
            <form id="${CHROME_IDS.form}" class="sb-conversation-composer">
                <label class="sr-only" for="${CHROME_IDS.input}">Conversation message</label>
                <textarea id="${CHROME_IDS.input}" class="text_pole" rows="1" placeholder="Message this character outside roleplay..."></textarea>
                <div id="${CHROME_IDS.attachmentPreview}" class="sb-conversation-attachment-preview" hidden></div>
                <div class="sb-conversation-composer-actions">
                    <button id="sb_conversation_toggle_tools" type="button" class="menu_button menu_button_icon" data-sb-conversation-action="toggle-tools" title="Toggle filters and tools" aria-label="Toggle filters and tools">
                        <i class="fa-solid fa-sliders" aria-hidden="true"></i>
                    </button>
                    <button id="${CHROME_IDS.attach}" type="button" class="menu_button menu_button_icon" data-sb-conversation-action="attach-file" title="Attach images or files" aria-label="Attach images or files">
                        <i class="fa-solid fa-paperclip" aria-hidden="true"></i>
                    </button>
                    <input id="${CHROME_IDS.fileInput}" class="displayNone" type="file" accept="${CONVERSATION_ATTACHMENT_ACCEPT}" multiple aria-label="Conversation attachments" />
                    <button id="${CHROME_IDS.send}" type="submit" class="menu_button menu_button_icon" title="Send Conversation message" aria-label="Send Conversation message">
                        <i class="fa-solid fa-paper-plane" aria-hidden="true"></i>
                        <span>Send</span>
                    </button>
                </div>
            </form>
        `;
        sheld.insertBefore(stage, chatElement);
    }

    let palsRail = document.getElementById(CHROME_IDS.palsRail);
    if (!(palsRail instanceof HTMLElement)) {
        palsRail = document.createElement('aside');
        palsRail.id = CHROME_IDS.palsRail;
        palsRail.hidden = true;
        palsRail.setAttribute('aria-label', 'Conversation pals');
        palsRail.innerHTML = `
            <div class="sb-conversation-rail-header" style="position: relative;">
                <div>
                    <div class="sb-conversation-rail-kicker">Pals</div>
                </div>
                <div class="sb-conversation-rail-start-actions">
                    <button type="button" class="menu_button menu_button_icon sb-conversation-rail-new-button" data-sb-conversation-action="open-add-dm" title="New Solo Chat" aria-label="New Solo Chat">
                        <i class="fa-solid fa-user-plus" aria-hidden="true"></i>
                    </button>
                    <button type="button" class="menu_button menu_button_icon sb-conversation-rail-new-button" data-sb-conversation-action="open-new-group-chat" title="New Group Chat" aria-label="New Group Chat">
                        <i class="fa-solid fa-user-group" aria-hidden="true"></i>
                    </button>
                    <button type="button" class="menu_button menu_button_icon sb-conversation-rail-close" data-sb-conversation-action="close-pals" title="Close Conversation pals" aria-label="Close Conversation pals">
                        <i class="fa-solid fa-xmark"></i>
                    </button>
                </div>
                <div id="sb_conversation_add_dm_picker" class="sb-conversation-add-dm-picker" style="position: absolute; inset-block-start: calc(100% + 4px); inset-inline-start: 12px; inset-inline-end: 12px; z-index: 95; padding: 10px; border-radius: var(--sb-radius-md); border: 1px solid var(--sb-shell-border); background-color: var(--SmartThemeBlurTintColor); backdrop-filter: blur(12px); box-shadow: 0 4px 20px var(--black50a);" hidden></div>
            </div>
            <div class="sb-conversation-rail-search" style="padding: 0 14px 8px;">
                <input type="text" id="sb_conversation_pals_search" class="text_pole textarea_compact wide100p" placeholder="Search direct messages..." style="font-size: var(--sb-type-meta);" />
            </div>
            <div id="${CHROME_IDS.palsList}" class="sb-conversation-pals-list"></div>
            <div id="${CHROME_IDS.railFooter}" class="sb-conversation-rail-footer">
                <div class="sb-conversation-rail-footer-avatar" data-sb-conversation-action="open-persona-picker" role="button" tabindex="0" title="Switch persona" aria-label="Switch persona">
                    <img id="sb_conv_footer_persona_avatar" alt="" loading="lazy" />
                    <span class="sb-conversation-status-dot sb-conversation-rail-footer-dot" data-status="online" aria-hidden="true"></span>
                    <div id="${CHROME_IDS.personaPicker}" class="sb-conversation-persona-picker" role="listbox" aria-label="Choose persona" hidden></div>
                </div>
                <div class="sb-conversation-rail-footer-copy">
                    <span id="sb_conv_footer_persona_name" class="sb-conversation-rail-footer-name"></span>
                    <span id="sb_conv_footer_user_status" class="sb-conversation-rail-footer-status"></span>
                </div>
                <div class="sb-conversation-rail-footer-actions">
                    <button type="button" class="menu_button menu_button_icon" data-sb-conversation-action="edit-user-persona-status" title="Edit persona status" aria-label="Edit persona status">
                        <i class="fa-solid fa-user-pen" aria-hidden="true"></i>
                    </button>
                    <button type="button" class="menu_button menu_button_icon" data-sb-conversation-action="open-user-status-picker" title="Set your status" aria-label="Set your status" aria-haspopup="listbox">
                        <i class="fa-solid fa-circle-dot" aria-hidden="true"></i>
                    </button>
                    <div id="${CHROME_IDS.userStatusPicker}" class="sb-conversation-status-picker" role="listbox" aria-label="Set your status" hidden>
                        <button type="button" class="sb-conversation-status-option" data-status="online" data-sb-conversation-action="set-user-status" role="option">
                            <span class="sb-conversation-status-dot" data-status="online" aria-hidden="true"></span>Online
                        </button>
                        <button type="button" class="sb-conversation-status-option" data-status="idle" data-sb-conversation-action="set-user-status" role="option">
                            <span class="sb-conversation-status-dot" data-status="idle" aria-hidden="true"></span>Idle
                        </button>
                        <button type="button" class="sb-conversation-status-option" data-status="dnd" data-sb-conversation-action="set-user-status" role="option">
                            <span class="sb-conversation-status-dot" data-status="dnd" aria-hidden="true"></span>Do Not Disturb
                        </button>
                        <button type="button" class="sb-conversation-status-option" data-status="offline" data-sb-conversation-action="set-user-status" role="option">
                            <span class="sb-conversation-status-dot" data-status="offline" aria-hidden="true"></span>Invisible
                        </button>
                    </div>
                </div>
            </div>
        `;
        sheld.insertBefore(palsRail, header);
    }

    let backdrop = document.getElementById(CHROME_IDS.settingsBackdrop);
    if (!(backdrop instanceof HTMLElement)) {
        backdrop = document.createElement('div');
        backdrop.id = CHROME_IDS.settingsBackdrop;
        backdrop.hidden = true;
        sheld.appendChild(backdrop);
    }

    let drawer = document.getElementById(CHROME_IDS.settingsDrawer);
    if (!(drawer instanceof HTMLElement)) {
        drawer = document.createElement('aside');
        drawer.id = CHROME_IDS.settingsDrawer;
        drawer.hidden = true;
        drawer.setAttribute('role', 'dialog');
        drawer.setAttribute('aria-modal', 'true');
        drawer.setAttribute('aria-label', 'Conversation settings');
        drawer.innerHTML = buildSettingsDrawerHtml();
        sheld.appendChild(drawer);
    }

    bindConversationChromeControls(sheld);
    return { sheld, header, stage, palsRail, backdrop, drawer };
}

function setConversationBackdropVisible() {
    const backdrop = document.getElementById(CHROME_IDS.settingsBackdrop);
    const drawer = document.getElementById(CHROME_IDS.settingsDrawer);
    const palsRail = document.getElementById(CHROME_IDS.palsRail);
    if (!(backdrop instanceof HTMLElement)) {
        return;
    }

    const settingsOpen = drawer instanceof HTMLElement && !drawer.hidden;
    const palsOpen = palsRail instanceof HTMLElement && palsRail.dataset.open === 'true';
    backdrop.hidden = !(settingsOpen || palsOpen);
}

function closePalsRail() {
    const palsRail = document.getElementById(CHROME_IDS.palsRail);
    if (palsRail instanceof HTMLElement) {
        palsRail.dataset.open = 'false';
    }
    setConversationBackdropVisible();
}

function togglePalsRail() {
    const palsRail = document.getElementById(CHROME_IDS.palsRail);
    if (!(palsRail instanceof HTMLElement)) {
        return;
    }

    palsRail.dataset.open = palsRail.dataset.open === 'true' ? 'false' : 'true';
    setConversationBackdropVisible();
}

function formatScheduleTimestamp(timestamp) {
    const value = Number(timestamp);
    if (!Number.isFinite(value) || value <= 0) {
        return '';
    }

    try {
        return new Date(value).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' });
    } catch {
        return '';
    }
}

function openScheduleEditorModal(initialAvatar = getCurrentCharAvatar()) {
    const targets = getScheduleEditorTargets(initialAvatar);
    let editAvatar = targets.some(target => target.avatar === initialAvatar) ? initialAvatar : targets[0]?.avatar;
    if (!editAvatar) {
        toastr.warning('No character available for schedule editing.');
        return;
    }

    const previouslyFocusedElement = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const overlay = document.createElement('div');
    overlay.id = 'sb_conversation_schedule_modal';
    overlay.className = 'sb-conversation-schedule-modal-overlay';
    overlay.style.cssText = `
        position: fixed;
        inset: 0;
        background: rgba(0, 0, 0, 0.7);
        backdrop-filter: blur(8px);
        z-index: 9999;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 20px;
    `;

    function createEditableSchedule(schedule) {
        const editable = JSON.parse(JSON.stringify(schedule || {
            days: { '0': [], '1': [], '2': [], '3': [], '4': [], '5': [], '6': [] },
            talkativeness: DEFAULT_TALKATIVENESS,
            inactivityThresholdMinutes: DEFAULT_INACTIVITY_THRESHOLD,
        }));

        if (!editable.days || typeof editable.days !== 'object') {
            editable.days = {};
        }

        for (let d = 0; d <= 6; d++) {
            if (!Array.isArray(editable.days[String(d)])) {
                editable.days[String(d)] = [];
            }
        }

        editable.talkativeness = clamp(parsePositiveInt(editable.talkativeness, DEFAULT_TALKATIVENESS, 0), 0, 100);
        editable.inactivityThresholdMinutes = clamp(
            parsePositiveInt(editable.inactivityThresholdMinutes, DEFAULT_INACTIVITY_THRESHOLD, MIN_INACTIVITY_THRESHOLD),
            MIN_INACTIVITY_THRESHOLD,
            MAX_INACTIVITY_THRESHOLD,
        );

        return editable;
    }

    const editedSchedulesByAvatar = new Map();
    const getEditedSchedule = (avatar) => {
        if (!editedSchedulesByAvatar.has(avatar)) {
            editedSchedulesByAvatar.set(avatar, createEditableSchedule(getStoredSchedule(avatar)));
        }

        return editedSchedulesByAvatar.get(avatar);
    };

    let editedSchedule = getEditedSchedule(editAvatar);

    let currentTabDay = new Date().getDay();

    const modal = document.createElement('div');
    modal.className = 'sb-conversation-schedule-modal sb-shell-root';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-labelledby', 'sb_schedule_modal_title');
    modal.style.cssText = `
        display: flex;
        flex-direction: column;
        width: min(650px, 100%);
        max-height: calc(100vh - 40px);
        background: var(--SmartThemeBlurTintColor);
        border: 1px solid var(--sb-shell-border);
        border-radius: var(--sb-radius-md, 12px);
        box-shadow: 0 10px 30px rgba(0, 0, 0, 0.5);
        color: var(--SmartThemeBodyColor);
        overflow: hidden;
    `;

    function updateModalBody() {
        const listContainer = modal.querySelector('.sb-schedule-modal-blocks-list');
        if (!listContainer) return;

        const dayBlocks = editedSchedule.days[String(currentTabDay)] || [];
        listContainer.innerHTML = '';

        if (!dayBlocks.length) {
            listContainer.innerHTML = '<div class="sb-conversation-empty" style="text-align: center; padding: 20px; opacity: 0.7;">No blocks scheduled for this day. Click "Add Time Block" below to create one!</div>';
        } else {
            dayBlocks.forEach((block, idx) => {
                const row = document.createElement('div');
                row.className = 'sb-schedule-modal-row';
                row.style.cssText = `
                    display: grid;
                    grid-template-columns: 130px 1fr 100px auto;
                    gap: 10px;
                    align-items: center;
                    margin-bottom: 8px;
                    padding-bottom: 8px;
                    border-bottom: 1px solid color-mix(in srgb, var(--sb-shell-border) 40%, transparent);
                `;

                const timeInput = document.createElement('input');
                timeInput.type = 'text';
                timeInput.className = 'text_pole textarea_compact sb-schedule-modal-time';
                timeInput.placeholder = '08:00-12:00';
                timeInput.value = block.time || '';
                timeInput.style.fontFamily = 'monospace';
                timeInput.addEventListener('input', () => {
                    block.time = timeInput.value;
                });

                const activityInput = document.createElement('input');
                activityInput.type = 'text';
                activityInput.className = 'text_pole textarea_compact sb-schedule-modal-activity';
                activityInput.placeholder = 'e.g. working, sleeping';
                activityInput.value = block.activity || '';
                activityInput.addEventListener('input', () => {
                    block.activity = activityInput.value;
                });

                const statusSelect = document.createElement('select');
                statusSelect.className = 'text_pole sb-schedule-modal-status';
                statusSelect.style.height = '32px';
                ['online', 'idle', 'dnd', 'offline'].forEach(st => {
                    const opt = document.createElement('option');
                    opt.value = st;
                    opt.textContent = st;
                    if (block.status === st) opt.selected = true;
                    statusSelect.appendChild(opt);
                });
                statusSelect.addEventListener('change', () => {
                    block.status = statusSelect.value;
                });

                const delBtn = document.createElement('button');
                delBtn.type = 'button';
                delBtn.className = 'menu_button menu_button_icon';
                delBtn.style.padding = '4px 8px';
                delBtn.innerHTML = '<i class="fa-solid fa-trash-can"></i>';
                delBtn.addEventListener('click', () => {
                    editedSchedule.days[String(currentTabDay)].splice(idx, 1);
                    updateModalBody();
                });

                row.appendChild(timeInput);
                row.appendChild(activityInput);
                row.appendChild(statusSelect);
                row.appendChild(delBtn);
                listContainer.appendChild(row);
            });
        }
    }

    const targetOptionsHtml = targets.map((target) => {
        const source = target.sourceLabel ? ` (${target.sourceLabel})` : '';
        return `<option value="${escapeHtmlAttribute(target.avatar)}"${target.avatar === editAvatar ? ' selected' : ''}>${escapeHtmlText(target.name + source)}</option>`;
    }).join('');

    modal.innerHTML = `
        <div class="sb-conversation-schedule-modal-header" style="display: flex; justify-content: space-between; align-items: center; padding: 14px 20px; border-bottom: 1px solid var(--sb-shell-border);">
            <span id="sb_schedule_modal_title" style="font-weight: var(--sb-weight-title); font-size: 1.1em;"><i class="fa-solid fa-calendar-days" style="color: var(--sb-accent); margin-right: 8px;"></i>Edit Weekly Routine</span>
            <button type="button" class="menu_button menu_button_icon sb-schedule-modal-close" style="padding: 4px 8px;"><i class="fa-solid fa-xmark"></i></button>
        </div>
        <div class="sb-schedule-modal-target" style="display: grid; gap: 6px; padding: 12px 20px; border-bottom: 1px solid var(--sb-shell-border); background: color-mix(in srgb, var(--SmartThemeBlurTintColor) 82%, transparent);">
            <label for="sb_schedule_modal_target" style="font-size: var(--sb-type-meta); font-weight: var(--sb-weight-control); opacity: 0.82;">Editing schedule for</label>
            <select id="sb_schedule_modal_target" class="text_pole textarea_compact wide100p"${targets.length <= 1 ? ' disabled' : ''}>
                ${targetOptionsHtml}
            </select>
            <p class="sb-conversation-field-hint" style="margin: 0;">Conversation members and current group-chat members use their own character-card schedules.</p>
        </div>
        <div class="sb-conversation-schedule-modal-tabs" style="display: flex; gap: 4px; padding: 10px 20px; background: rgba(0,0,0,0.15); border-bottom: 1px solid var(--sb-shell-border); overflow-x: auto;">
            ${WEEKDAY_LABELS.map((day, idx) => `
                <button type="button" class="menu_button sb-schedule-modal-tab" data-day="${idx}" style="flex: 1; padding: 6px 4px; font-size: var(--sb-type-meta); min-width: 50px;">${day}</button>
            `).join('')}
        </div>
        <div style="flex: 1; overflow-y: auto; padding: 20px;" class="sb-schedule-modal-body">
            <div class="sb-schedule-modal-blocks-list" style="min-height: 120px;"></div>
            <button type="button" class="menu_button sb-schedule-modal-add" style="margin-top: 12px; width: 100%; display: flex; align-items: center; justify-content: center; gap: 6px;">
                <i class="fa-solid fa-plus"></i><span>Add Time Block</span>
            </button>
        </div>
        <div class="sb-conversation-schedule-modal-footer" style="padding: 16px 20px; border-top: 1px solid var(--sb-shell-border); background: rgba(0,0,0,0.15); display: flex; flex-direction: column; gap: 12px;">
            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 16px;">
                <div class="sb-conversation-field-stack">
                    <label style="font-size: var(--sb-type-meta); opacity: 0.8; margin-bottom: 4px;">Talkativeness (0-100)</label>
                    <input type="number" class="text_pole sb-schedule-modal-talkativeness" min="0" max="100" step="5" value="${editedSchedule.talkativeness}" />
                </div>
                <div class="sb-conversation-field-stack">
                    <label style="font-size: var(--sb-type-meta); opacity: 0.8; margin-bottom: 4px;">Inactivity Threshold (mins)</label>
                    <input type="number" class="text_pole sb-schedule-modal-patience" min="15" max="360" step="5" value="${editedSchedule.inactivityThresholdMinutes}" />
                </div>
            </div>
            <div style="display: flex; justify-content: flex-end; gap: 10px; margin-top: 4px;">
                <button type="button" class="menu_button sb-schedule-modal-save" style="padding: 6px 14px; font-weight: var(--sb-weight-control); color: white;">Save Changes</button>
                <button type="button" class="menu_button sb-schedule-modal-cancel" style="padding: 6px 14px;">Cancel</button>
            </div>
        </div>
    `;

    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    function selectDayTab(dayIdx) {
        currentTabDay = dayIdx;
        modal.querySelectorAll('.sb-schedule-modal-tab').forEach(btn => {
            const btnDay = parseInt(btn.dataset.day, 10);
            if (btnDay === currentTabDay) {
                btn.style.borderColor = 'var(--sb-accent)';
                btn.style.background = 'color-mix(in srgb, var(--sb-accent) 15%, transparent)';
                btn.style.fontWeight = 'var(--sb-weight-control)';
            } else {
                btn.style.borderColor = '';
                btn.style.background = '';
                btn.style.fontWeight = '';
            }
        });
        updateModalBody();
    }

    function syncScheduleMetaInputs() {
        const talkInput = modal.querySelector('.sb-schedule-modal-talkativeness');
        if (talkInput instanceof HTMLInputElement) {
            talkInput.value = String(editedSchedule.talkativeness ?? DEFAULT_TALKATIVENESS);
        }

        const patienceInput = modal.querySelector('.sb-schedule-modal-patience');
        if (patienceInput instanceof HTMLInputElement) {
            patienceInput.value = String(editedSchedule.inactivityThresholdMinutes ?? DEFAULT_INACTIVITY_THRESHOLD);
        }
    }

    function selectScheduleTarget(nextAvatar) {
        if (!nextAvatar || nextAvatar === editAvatar || !targets.some(target => target.avatar === nextAvatar)) {
            return;
        }

        editAvatar = nextAvatar;
        editedSchedule = getEditedSchedule(editAvatar);
        syncScheduleMetaInputs();
        selectDayTab(currentTabDay);
    }

    syncScheduleMetaInputs();
    selectDayTab(currentTabDay);

    const targetSelect = modal.querySelector('#sb_schedule_modal_target');
    if (targetSelect instanceof HTMLSelectElement) {
        targetSelect.addEventListener('change', () => {
            selectScheduleTarget(targetSelect.value);
        });
    }

    modal.querySelectorAll('.sb-schedule-modal-tab').forEach(btn => {
        btn.addEventListener('click', () => {
            selectDayTab(parseInt(btn.dataset.day, 10));
        });
    });

    const addBtn = modal.querySelector('.sb-schedule-modal-add');
    addBtn?.addEventListener('click', () => {
        const dayBlocks = editedSchedule.days[String(currentTabDay)] || [];
        dayBlocks.push({ time: '12:00-14:00', activity: 'free time', status: 'online' });
        editedSchedule.days[String(currentTabDay)] = dayBlocks;
        updateModalBody();
    });

    const talkInput = modal.querySelector('.sb-schedule-modal-talkativeness');
    talkInput?.addEventListener('input', () => {
        editedSchedule.talkativeness = clamp(parseInt(talkInput.value, 10) || 50, 0, 100);
    });

    const patienceInput = modal.querySelector('.sb-schedule-modal-patience');
    patienceInput?.addEventListener('input', () => {
        editedSchedule.inactivityThresholdMinutes = clamp(parseInt(patienceInput.value, 10) || 120, MIN_INACTIVITY_THRESHOLD, MAX_INACTIVITY_THRESHOLD);
    });

    const closeBtn = modal.querySelector('.sb-schedule-modal-close');
    const cancelBtn = modal.querySelector('.sb-schedule-modal-cancel');
    const saveBtn = modal.querySelector('.sb-schedule-modal-save');

    function closeModal() {
        overlay.remove();
        previouslyFocusedElement?.focus?.({ preventScroll: true });
    }

    closeBtn?.addEventListener('click', closeModal);
    cancelBtn?.addEventListener('click', closeModal);
    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) closeModal();
    });
    overlay.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') {
            event.preventDefault();
            closeModal();
            return;
        }

        if (event.key !== 'Tab') {
            return;
        }

        const focusable = Array.from(modal.querySelectorAll('button, input, select, textarea, [tabindex]:not([tabindex="-1"])'))
            .filter(element => element instanceof HTMLElement && !element.hasAttribute('disabled') && element.offsetParent !== null);
        if (!focusable.length) {
            return;
        }

        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
        }
    });
    setTimeout(() => {
        modal.querySelector('button, input, select, textarea')?.focus?.({ preventScroll: true });
    }, 0);

    saveBtn?.addEventListener('click', () => {
        if (!editAvatar) {
            closeModal();
            return;
        }

        const normalized = {
            days: {},
            talkativeness: editedSchedule.talkativeness,
            inactivityThresholdMinutes: editedSchedule.inactivityThresholdMinutes,
            generatedAt: Date.now(),
        };

        for (let d = 0; d <= 6; d++) {
            const rawBlocks = editedSchedule.days[String(d)] || [];
            const normalizedBlocks = [];
            for (const b of rawBlocks) {
                const norm = normalizeScheduleBlock(b);
                if (norm) {
                    normalizedBlocks.push(norm);
                }
            }
            normalizedBlocks.sort((x, y) => {
                const xr = parseScheduleTimeRange(x.time);
                const yr = parseScheduleTimeRange(y.time);
                return (xr?.startMinutes ?? Number.MAX_SAFE_INTEGER) - (yr?.startMinutes ?? Number.MAX_SAFE_INTEGER);
            });
            normalized.days[String(d)] = normalizedBlocks;
        }

        saveStoredSchedule(editAvatar, normalized);
        const editSettings = getSettings(editAvatar);
        editSettings.auto_schedule = JSON.stringify(normalized);
        editSettings.talkativeness = normalized.talkativeness;
        editSettings.inactivity_threshold = normalized.inactivityThresholdMinutes;
        editSettings.schedule_generated_at = normalized.generatedAt;
        saveSettings(editAvatar, editSettings);
        if (editAvatar === getCurrentCharAvatar()) {
            applySettingsToPanel(editSettings);
            renderScheduleDisplay();
            updateConversationChrome(editSettings);
        } else {
            updateConversationChrome(getSettings());
        }
        const targetName = targets.find(target => target.avatar === editAvatar)?.name || 'character';
        toastr.success(`Schedule saved for ${targetName}.`);
        closeModal();
    });
}

function renderScheduleDisplay() {
    const display = document.getElementById('sb_conv_schedule_display');
    if (!(display instanceof HTMLElement)) {
        return;
    }

    const avatar = getCurrentCharAvatar();
    const schedule = avatar ? getStoredSchedule(avatar) : null;

    if (!schedule || !schedule.days) {
        display.dataset.empty = 'true';
        display.innerHTML = '<p class="sb-conversation-schedule-empty">No schedule yet. Generate one to give this character a daily rhythm and let them message you on their own.</p>';
        return;
    }

    display.dataset.empty = 'false';
    const now = new Date();
    const todayIndex = now.getDay();
    const current = getCurrentActivityFromSchedule(schedule, avatar, now);
    const todayBlocks = Array.isArray(schedule.days[todayIndex]) ? schedule.days[todayIndex] : [];

    const settings = getSettings(avatar);
    const talkativeness = parsePositiveInt(settings.talkativeness, DEFAULT_TALKATIVENESS, 0);
    const generatedLabel = formatScheduleTimestamp(settings.schedule_generated_at);

    const currentLine = `<div class="sb-conversation-schedule-now" data-status="${escapeHtmlAttribute(current.status)}">`
        + '<span class="sb-conversation-status-dot" data-status="' + escapeHtmlAttribute(current.status) + '"></span>'
        + `<span class="sb-conversation-schedule-now-text">Right now: <strong>${escapeHtmlText(current.activity)}</strong> (${escapeHtmlText(current.status)})</span>`
        + '</div>';

    let blocksHtml = '';
    if (todayBlocks.length) {
        const rows = todayBlocks.map((block) => {
            const isCurrent = current.source === 'schedule' && block.activity === current.activity && block.status === current.status;
            return `<li class="sb-conversation-schedule-block${isCurrent ? ' is-current' : ''}" data-status="${escapeHtmlAttribute(block.status)}">`
                + `<span class="sb-conversation-schedule-time">${escapeHtmlText(block.time)}</span>`
                + `<span class="sb-conversation-schedule-activity">${escapeHtmlText(block.activity)}</span>`
                + `<span class="sb-conversation-schedule-status" data-status="${escapeHtmlAttribute(block.status)}">${escapeHtmlText(block.status)}</span>`
                + '</li>';
        }).join('');
        blocksHtml = `<p class="sb-conversation-schedule-label">${escapeHtmlText(WEEKDAY_LABELS[todayIndex])} today</p><ul class="sb-conversation-schedule-blocks">${rows}</ul>`;
    } else {
        blocksHtml = `<p class="sb-conversation-schedule-empty">No blocks scheduled for ${escapeHtmlText(WEEKDAY_LABELS[todayIndex])}.</p>`;
    }

    const metaParts = [`Talkativeness ${talkativeness}`];
    if (generatedLabel) {
        metaParts.push(`Updated ${generatedLabel}`);
    }
    const metaHtml = `<p class="sb-conversation-schedule-meta">${escapeHtmlText(metaParts.join(' \u00b7 '))}</p>`;

    display.innerHTML = currentLine + blocksHtml + metaHtml;
}

function renderConversationMemoryPanel() {
    const memoryInput = document.getElementById('sb_conv_memory_summary');
    const meta = document.getElementById('sb_conv_memory_meta');
    if (!(memoryInput instanceof HTMLTextAreaElement)) {
        return;
    }

    const avatar = getCurrentCharAvatar();
    const groupId = getConversationGroupIdForAvatar(avatar);
    const branch = avatar ? getActiveConversationBranch(avatar, { create: false, groupId }) : null;
    const memorySummary = String(branch?.memorySummary || '').trim();
    const messageCount = Array.isArray(branch?.messages) ? branch.messages.filter(message => hasConversationMessageContent(message) && message.role !== 'system').length : 0;
    const summarizedCount = parsePositiveInt(branch?.memoryMessageCount, 0, 0);

    memoryInput.value = memorySummary;
    memoryInput.placeholder = messageCount
        ? 'No memory summary yet. Click Refresh memory to write one now, or keep chatting and it will update automatically.'
        : 'No memory summary yet. This branch has no messages to summarize.';

    if (meta instanceof HTMLElement) {
        const branchName = branch?.name || 'Current branch';
        const copied = branch?.sessionMarkers?.memory_copied_from ? ' · copied from previous branch' : '';
        meta.textContent = `${branchName} · ${messageCount} message${messageCount === 1 ? '' : 's'} · summarized through ${summarizedCount}${copied}`;
    }
}

async function refreshConversationMemoryFromPanel() {
    const avatar = getCurrentCharAvatar();
    if (!avatar) {
        toastr.warning('Pick a DM first.');
        return;
    }

    const groupId = getConversationGroupIdForAvatar(avatar);
    const refreshed = await updateConversationMemorySummary(avatar, { force: true, groupId, notify: true });
    if (!refreshed) {
        renderConversationMemoryPanel();
    }
}

function clearConversationMemoryFromPanel() {
    const avatar = getCurrentCharAvatar();
    if (!avatar) {
        toastr.warning('Pick a DM first.');
        return;
    }

    const confirmed = typeof globalThis.confirm === 'function'
        ? globalThis.confirm('Clear the memory summary for this Conversation branch? This does not delete chat messages.')
        : true;
    if (!confirmed) {
        return;
    }

    if (clearConversationMemorySummary(avatar)) {
        toastr.success('Conversation memory cleared.');
    }
}

function openConversationSettings() {
    const chrome = ensureConversationChrome();
    if (!chrome) {
        return;
    }

    closePalsRail();
    const settings = getSettings();

    // Refresh live-data dropdowns before showing the drawer.
    const lorebookSelect = document.getElementById('sb_conv_lorebook_override');
    if (lorebookSelect instanceof HTMLSelectElement) {
        lorebookSelect.innerHTML = buildLorebookOptions(settings.lorebook_override);
    }
    const profileSelect = document.getElementById('sb_conv_connection_profile');
    if (profileSelect instanceof HTMLSelectElement) {
        profileSelect.innerHTML = buildConnectionProfileOptions(settings.connection_profile);
    }
    const partnerList = document.getElementById('sb_conv_chiming_partner_list');
    if (partnerList instanceof HTMLElement) {
        partnerList.innerHTML = buildChimingPartnerOptions(settings.multi_char_names);
    }

    applySettingsToPanel(settings);
    bindWeeklyScheduleEditor();
    bindPartnerList('sb_conv_chiming_partner_list', 'sb_conv_multi_char_search');
    renderScheduleDisplay();
    renderConversationMemoryPanel();
    updateUserFooter();
    chrome.drawer.hidden = false;
    setConversationBackdropVisible();
    chrome.drawer.querySelector('input, select, textarea, button')?.focus?.({ preventScroll: true });
}

function closeConversationSettings() {
    const drawer = document.getElementById(CHROME_IDS.settingsDrawer);
    if (drawer instanceof HTMLElement) {
        const shouldSave = drawer.hidden === false;
        drawer.hidden = true;
        if (shouldSave) {
            saveCurrentPanelSettings();
        }
    }
    setConversationBackdropVisible();
}

function renderWeeklyScheduleEditor(container, scheduleJson) {
    const entries = safeParseWeeklySchedule(scheduleJson);
    container.innerHTML = '';
    for (const entry of entries) {
        container.appendChild(createWeeklyScheduleRow(entry));
    }
}

function createWeeklyScheduleRow(entry = {}) {
    const row = document.createElement('div');
    row.className = 'sb-conversation-weekly-row';
    const dayPills = WEEKDAY_LABELS.map((label, idx) => {
        const checked = Array.isArray(entry.days) && entry.days.includes(idx) ? ' checked' : '';
        return `<label class="sb-conversation-day-pill"><input type="checkbox" class="sb-conv-day-check" data-day="${idx}"${checked} /><span>${label}</span></label>`;
    }).join('');
    row.innerHTML = `
        <div class="sb-conversation-day-pills">${dayPills}</div>
        <div class="sb-conversation-weekly-row-meta">
            <input type="time" class="text_pole textarea_compact sb-conv-weekly-time" value="${escapeHtmlAttribute(entry.time || '08:00')}" aria-label="Schedule time" />
            <input type="text" class="text_pole textarea_compact sb-conv-weekly-message" value="${escapeHtmlAttribute(entry.message || '')}" placeholder="Good morning selfie!" aria-label="Schedule message" />
            <label class="checkbox_label sb-conv-weekly-enabled">
                <input type="checkbox" class="sb-conv-weekly-enabled-check"${entry.enabled !== false ? ' checked' : ''} />
                <span>On</span>
            </label>
            <button type="button" class="menu_button menu_button_icon sb-conv-weekly-remove" data-sb-conversation-action="weekly-remove" title="Remove slot" aria-label="Remove slot">
                <i class="fa-solid fa-trash-can" aria-hidden="true"></i>
            </button>
        </div>
    `;
    return row;
}

function addWeeklyScheduleRow() {
    const editor = document.getElementById('sb_conv_weekly_schedule_editor');
    if (!(editor instanceof HTMLElement)) {
        return;
    }

    editor.appendChild(createWeeklyScheduleRow({ days: [], time: '08:00', message: '', enabled: true }));
    saveCurrentPanelSettings();
}

function readWeeklyScheduleFromEditor() {
    const editor = document.getElementById('sb_conv_weekly_schedule_editor');
    if (!(editor instanceof HTMLElement)) {
        return '[]';
    }

    const entries = [];
    for (const row of editor.querySelectorAll('.sb-conversation-weekly-row')) {
        const days = [];
        row.querySelectorAll('.sb-conv-day-check:checked').forEach((cb) => {
            const day = parseInt(cb.dataset.day, 10);
            if (!Number.isNaN(day)) {
                days.push(day);
            }
        });
        const timeEl = row.querySelector('.sb-conv-weekly-time');
        const messageEl = row.querySelector('.sb-conv-weekly-message');
        const enabledEl = row.querySelector('.sb-conv-weekly-enabled-check');
        entries.push({
            days,
            time: timeEl instanceof HTMLInputElement ? timeEl.value : '08:00',
            message: messageEl instanceof HTMLInputElement ? messageEl.value : '',
            enabled: enabledEl instanceof HTMLInputElement ? enabledEl.checked : true,
        });
    }

    return JSON.stringify(entries);
}

function readPartnersFromList(listId) {
    const list = document.getElementById(listId);
    if (!(list instanceof HTMLElement)) {
        return '';
    }

    const checked = [];
    list.querySelectorAll('.sb-conversation-partner-checkbox:checked').forEach((cb) => {
        if (cb instanceof HTMLInputElement && cb.value) {
            checked.push(cb.value);
        }
    });
    return checked.join(', ');
}

function readChimingPartnersFromList() {
    return readPartnersFromList('sb_conv_chiming_partner_list');
}

function saveConversationPartnerConnectionProfile(select) {
    const partnerAvatar = select?.dataset?.partnerAvatar;
    if (!partnerAvatar) {
        return;
    }

    const settings = getSettings(partnerAvatar);
    settings.connection_profile = select.value || '';
    saveSettings(partnerAvatar, settings);
}

function updateUserFooter() {
    const footer = document.getElementById(CHROME_IDS.railFooter);
    if (!(footer instanceof HTMLElement)) {
        return;
    }

    const personaName = name1 || 'You';
    const status = getUserStatus();
    const statusCopy = AVAILABILITY_COPY[status] ?? AVAILABILITY_COPY.online;
    const personaStatus = getUserPersonaStatus();

    const avatarEl = document.getElementById('sb_conv_footer_persona_avatar');
    const nameEl = document.getElementById('sb_conv_footer_persona_name');
    const statusEl = document.getElementById('sb_conv_footer_user_status');
    const activeDot = footer.querySelector('.sb-conversation-rail-footer-dot');

    if (avatarEl instanceof HTMLImageElement) {
        const activeAvatar = typeof user_avatar === 'string' ? user_avatar : null;
        avatarEl.src = activeAvatar ? getThumbnailUrl('persona', activeAvatar) : (default_user_avatar || '');
        avatarEl.alt = personaName;
    }
    if (nameEl instanceof HTMLElement) {
        nameEl.textContent = personaName;
    }
    if (statusEl instanceof HTMLElement) {
        statusEl.textContent = personaStatus || statusCopy.label;
        statusEl.dataset.status = status;
        statusEl.title = personaStatus ? `${statusCopy.label}: ${statusCopy.detail}` : statusCopy.detail;
    }
    if (activeDot instanceof HTMLElement) {
        activeDot.dataset.status = status;
    }
}

function toggleUserStatusPicker() {
    const picker = document.getElementById(CHROME_IDS.userStatusPicker);
    if (!(picker instanceof HTMLElement)) {
        return;
    }

    const isHidden = picker.hidden;
    document.getElementById(CHROME_IDS.personaPicker)?.setAttribute('hidden', '');
    picker.hidden = !isHidden;
}

function renderConversationPersonaPicker(picker) {
    picker.innerHTML = '';
    const personas = getPersonaOptions();
    if (!personas.length) {
        picker.innerHTML = '<div class="sb-conversation-empty">No personas configured.</div>';
        return;
    }

    for (const { avatarId, personaName } of personas) {
        const entry = document.createElement('div');
        entry.className = 'sb-conversation-persona-entry';
        entry.dataset.personaAvatar = avatarId;

        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'sb-conversation-persona-option';
        btn.dataset.sbConversationAction = 'pick-persona';
        btn.dataset.personaAvatar = avatarId;
        btn.setAttribute('role', 'option');
        btn.setAttribute('aria-selected', String(avatarId === user_avatar));

        const img = document.createElement('img');
        img.src = getThumbnailUrl('persona', avatarId);
        img.alt = '';
        img.loading = 'lazy';

        const name = document.createElement('span');
        name.className = 'sb-conversation-persona-option-name';
        name.textContent = personaName;
        btn.append(img, name);
        entry.appendChild(btn);

        const appendices = getConversationPersonaAppendices(avatarId);
        if (appendices.length) {
            const activeIds = new Set(getActiveConversationPersonaAppendixIds(avatarId));
            const notes = document.createElement('div');
            notes.className = 'sb-conversation-persona-notes';

            const notesTitle = document.createElement('div');
            notesTitle.className = 'sb-conversation-persona-notes-title';
            notesTitle.textContent = 'Scenario Notes';
            notes.appendChild(notesTitle);

            for (const appendix of appendices) {
                const label = document.createElement('label');
                label.className = 'sb-conversation-persona-note-option';
                const checkbox = document.createElement('input');
                checkbox.type = 'checkbox';
                checkbox.value = appendix.id;
                checkbox.dataset.personaAvatar = avatarId;
                checkbox.className = 'sb-conversation-persona-note-checkbox';
                checkbox.checked = activeIds.has(appendix.id);
                const noteName = document.createElement('span');
                noteName.textContent = appendix.name;
                label.append(checkbox, noteName);
                notes.appendChild(label);
            }

            entry.appendChild(notes);
        }

        picker.appendChild(entry);
    }
}

function togglePersonaPicker() {
    const picker = document.getElementById(CHROME_IDS.personaPicker);
    if (!(picker instanceof HTMLElement)) {
        return;
    }

    const isHidden = picker.hidden;
    document.getElementById(CHROME_IDS.userStatusPicker)?.setAttribute('hidden', '');

    if (isHidden) {
        renderConversationPersonaPicker(picker);
    }

    picker.hidden = !isHidden;
}

function bindWeeklyScheduleEditor() {
    const editor = document.getElementById('sb_conv_weekly_schedule_editor');
    const hiddenInput = document.getElementById('sb_conv_weekly_schedule');
    if (!(editor instanceof HTMLElement)) {
        return;
    }

    const scheduleJson = hiddenInput instanceof HTMLInputElement ? hiddenInput.value : '[]';
    renderWeeklyScheduleEditor(editor, scheduleJson);

    if (editor.dataset.sbConversationBound !== 'true') {
        editor.dataset.sbConversationBound = 'true';
        editor.addEventListener('change', saveCurrentPanelSettings);
    }
}

function bindPartnerList(listId, searchId) {
    const list = document.getElementById(listId);
    if (!(list instanceof HTMLElement) || list.dataset.sbConversationBound === 'true') {
        return;
    }

    list.dataset.sbConversationBound = 'true';
    list.addEventListener('change', (event) => {
        const target = event.target instanceof Element ? event.target : null;
        const profileSelect = target?.closest('.sb-conversation-partner-profile');
        if (profileSelect instanceof HTMLSelectElement) {
            saveConversationPartnerConnectionProfile(profileSelect);
            return;
        }

        saveCurrentPanelSettings();
    });

    const searchInput = document.getElementById(searchId);
    if (searchInput instanceof HTMLInputElement) {
        searchInput.addEventListener('input', () => {
            const query = searchInput.value.toLowerCase().trim();
            const options = list.querySelectorAll('.sb-conversation-partner-option');
            options.forEach(opt => {
                if (opt instanceof HTMLElement) {
                    const charName = opt.dataset.charName || '';
                    if (charName.includes(query)) {
                        opt.style.display = '';
                    } else {
                        opt.style.display = 'none';
                    }
                }
            });
        });
    }
}

function toggleAddDmPicker() {
    const picker = document.getElementById('sb_conversation_add_dm_picker');
    if (!(picker instanceof HTMLElement)) {
        return;
    }

    if (!picker.hasAttribute('hidden') && picker.dataset.pickerType === 'solo') {
        picker.setAttribute('hidden', '');
        return;
    }

    picker.dataset.pickerType = 'solo';
    picker.dataset.selectedMembers = '';
    picker.onchange = null;
    picker.removeAttribute('hidden');
    picker.innerHTML = `
        <div class="sb-conversation-add-dm-header">
            <span style="font-weight: var(--sb-weight-title); font-size: var(--sb-type-meta);">Open a solo DM</span>
            <p class="sb-conversation-field-hint" style="margin: 4px 0 0;">This opens the character alone, even if they also have a group Conversation.</p>
            <input type="text" id="sb_conversation_add_dm_search" class="text_pole textarea_compact" placeholder="Search characters..." style="inline-size: 100%; margin-top: 8px;" />
        </div>
        <div class="sb-conversation-add-dm-list" id="sb_conversation_add_dm_list" style="margin-top: 8px; max-block-size: 200px; overflow-y: auto; display: flex; flex-direction: column; gap: 4px;"></div>
    `;

    const listContainer = document.getElementById('sb_conversation_add_dm_list');
    const searchInput = document.getElementById('sb_conversation_add_dm_search');

    function renderList(query = '') {
        if (!listContainer) return;
        const rows = [];
        (Array.isArray(characters) ? characters : []).forEach((character, idx) => {
            if (!character?.avatar) return;
            const name = character.name || 'Character';
            if (query && !name.toLowerCase().includes(query)) return;

            const thumb = getThumbnailUrl('avatar', character.avatar);
            rows.push(`
                <button type="button" class="sb-conversation-add-dm-option" data-sb-conversation-action="add-character-dm" data-character-index="${idx}" style="display: flex; align-items: center; gap: 8px; inline-size: 100%; background: none; border: none; padding: 6px; border-radius: var(--sb-radius-sm); text-align: left; cursor: pointer; color: inherit;">
                    <img src="${escapeHtmlAttribute(thumb)}" alt="" style="inline-size: 24px; block-size: 24px; border-radius: 50%; object-fit: cover;" loading="lazy" />
                    <span style="font-size: var(--sb-type-caption);">${escapeHtmlText(name)}</span>
                </button>
            `);
        });

        if (!rows.length) {
            listContainer.innerHTML = '<div class="sb-conversation-empty" style="padding: 8px; font-size: var(--sb-type-meta); opacity: 0.7;">No matching characters found.</div>';
        } else {
            listContainer.innerHTML = rows.join('');
        }
    }

    renderList();

    if (searchInput instanceof HTMLInputElement) {
        searchInput.focus();
        searchInput.addEventListener('input', () => {
            renderList(searchInput.value.toLowerCase().trim());
        });
    }
}

function hideConversationStartPicker() {
    const picker = document.getElementById('sb_conversation_add_dm_picker');
    if (picker instanceof HTMLElement) {
        picker.setAttribute('hidden', '');
    }
}

function openPalsRail() {
    const palsRail = document.getElementById(CHROME_IDS.palsRail);
    if (palsRail instanceof HTMLElement) {
        palsRail.dataset.open = 'true';
    }
    setConversationBackdropVisible();
}

function getUniqueConversationGroupMembers(memberAvatars) {
    const members = [];
    for (const avatar of Array.isArray(memberAvatars) ? memberAvatars : []) {
        if (avatar && !members.includes(avatar) && getCharacterForAvatar(avatar)) {
            members.push(avatar);
        }
    }

    return members;
}

function getConversationGroupMemberNames(memberAvatars) {
    return getUniqueConversationGroupMembers(memberAvatars)
        .map(avatar => getCharacterForAvatar(avatar)?.name || 'Character')
        .filter(Boolean);
}

function buildConversationGroupName(memberAvatars) {
    const names = getConversationGroupMemberNames(memberAvatars);
    if (!names.length) {
        return 'Conversation Group';
    }

    const visibleNames = names.slice(0, 3).join(', ');
    const hiddenCount = Math.max(0, names.length - 3);
    return `Group: ${visibleNames}${hiddenCount ? ` +${hiddenCount}` : ''}`;
}

function cloneConversationStoreValue(value) {
    try {
        return JSON.parse(JSON.stringify(value));
    } catch {
        return null;
    }
}

function copyConversationThreadToGroup(sourceAvatar, targetGroupId, { sourceGroupId = '' } = {}) {
    if (!sourceAvatar || !targetGroupId) {
        return false;
    }

    const sourceStore = getConversationThreadStore(sourceAvatar, { create: false, groupId: sourceGroupId || '' });
    const targetStore = getConversationThreadStore(sourceAvatar, { create: true, groupId: targetGroupId });
    if (!sourceStore?.branches || !targetStore) {
        return false;
    }

    const clonedBranches = cloneConversationStoreValue(sourceStore.branches);
    targetStore.activeBranchId = sourceStore.activeBranchId || DEFAULT_BRANCH_ID;
    targetStore.branches = clonedBranches && typeof clonedBranches === 'object'
        ? clonedBranches
        : { [DEFAULT_BRANCH_ID]: createConversationBranch('Main', DEFAULT_BRANCH_ID) };

    const activeBranchId = targetStore.activeBranchId || DEFAULT_BRANCH_ID;
    targetStore.branches[activeBranchId] = normalizeConversationBranch(targetStore.branches[activeBranchId], activeBranchId);
    targetStore.branches[activeBranchId].sessionMarkers = {
        ...(targetStore.branches[activeBranchId].sessionMarkers || {}),
        copied_to_group_at: Date.now(),
    };
    persistConversationStore();
    return true;
}

async function createConversationGroup(memberAvatars, { sourceAvatar = '', copySourceGroupId = null } = {}) {
    const members = getUniqueConversationGroupMembers(memberAvatars);
    if (members.length < 2) {
        toastr.warning('Pick at least two characters for a group Conversation.');
        return null;
    }

    const chatId = `conversation_${Date.now()}`;
    const groupCreateModel = {
        name: buildConversationGroupName(members),
        members,
        avatar_url: default_avatar,
        allow_self_responses: false,
        activation_strategy: group_activation_strategy.NATURAL,
        generation_mode: group_generation_mode.SWAP,
        disabled_members: [],
        fav: false,
        chat_id: chatId,
        chats: [chatId],
        auto_mode_delay: 120,
    };

    const response = await fetch('/api/groups/create', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify(groupCreateModel),
    });

    if (!response.ok) {
        const detail = await response.text().catch(() => '');
        toastr.error(`Could not create group Conversation${detail ? `: ${detail.slice(0, 120)}` : '.'}`);
        return null;
    }

    const group = await response.json();
    if (!group?.id) {
        toastr.error('The group Conversation was created without a group id.');
        return null;
    }

    if (Array.isArray(groups)) {
        const existingIndex = groups.findIndex(item => String(item?.id) === String(group.id));
        if (existingIndex >= 0) {
            groups[existingIndex] = { ...groups[existingIndex], ...group };
        } else {
            groups.push(group);
        }
    }

    if (sourceAvatar && copySourceGroupId !== null) {
        copyConversationThreadToGroup(sourceAvatar, String(group.id), { sourceGroupId: copySourceGroupId || '' });
    }

    try {
        await getCharacters();
    } catch (error) {
        console.warn('Could not refresh characters after creating a Conversation group.', error);
    }

    return getConversationGroupById(group.id) || group;
}

async function createAndOpenConversationGroup(memberAvatars, { sourceAvatar = '', copySourceGroupId = null } = {}) {
    const group = await createConversationGroup(memberAvatars, { sourceAvatar, copySourceGroupId });
    if (!group?.id || !Array.isArray(group.members)) {
        return false;
    }

    const targetAvatar = sourceAvatar && group.members.includes(sourceAvatar)
        ? sourceAvatar
        : group.members.find(avatar => getCharacterForAvatar(avatar));
    if (!targetAvatar) {
        toastr.warning('This group does not have any available character cards for Conversation Mode.');
        return false;
    }

    hideConversationStartPicker();
    closePalsRail();
    const opened = openConversationWorkspaceForAvatar(targetAvatar, {
        groupId: String(group.id),
        showToast: false,
    });
    if (opened) {
        renderPalsRail();
        setTimeout(() => {
            document.getElementById(CHROME_IDS.input)?.focus?.({ preventScroll: true });
        }, 100);
        toastr.success(`Opened group Conversation for ${group.name || 'this group'}.`);
    }

    return opened;
}

function getCurrentGroupMemberAvatars(groupId) {
    const group = getConversationGroupById(groupId);
    if (!group?.members?.length) {
        return [];
    }

    return group.members.filter(avatar => avatar && !group.disabled_members?.includes(avatar) && getCharacterForAvatar(avatar));
}

function toggleConversationGroupPicker({ sourceAvatar = '', sourceGroupId = '' } = {}) {
    const picker = document.getElementById('sb_conversation_add_dm_picker');
    if (!(picker instanceof HTMLElement)) {
        return;
    }

    const normalizedSourceGroupId = sourceGroupId || '';
    const sourceMembers = normalizedSourceGroupId ? getCurrentGroupMemberAvatars(normalizedSourceGroupId) : [];
    const lockedMembers = new Set(sourceAvatar ? (sourceMembers.length ? sourceMembers : [sourceAvatar]) : []);
    const selectedMembers = new Set(lockedMembers);
    const copyFromCurrentThread = Boolean(sourceAvatar);

    if (!picker.hasAttribute('hidden')
        && picker.dataset.pickerType === 'group'
        && picker.dataset.sourceAvatar === (sourceAvatar || '')
        && picker.dataset.copySourceGroupId === normalizedSourceGroupId) {
        picker.setAttribute('hidden', '');
        return;
    }

    picker.dataset.pickerType = 'group';
    picker.dataset.sourceAvatar = sourceAvatar || '';
    picker.dataset.copySource = String(copyFromCurrentThread);
    picker.dataset.copySourceGroupId = normalizedSourceGroupId;
    picker.removeAttribute('hidden');

    const title = sourceAvatar
        ? (normalizedSourceGroupId ? 'Add members to this group' : 'Add members to this DM')
        : 'Start a group DM';
    const description = sourceAvatar
        ? 'Selected members will open as a new group Conversation with this thread copied over.'
        : 'Pick two or more characters to create a group Conversation independent of the active roleplay chat.';

    picker.innerHTML = `
        <div class="sb-conversation-add-dm-header">
            <span style="font-weight: var(--sb-weight-title); font-size: var(--sb-type-meta);">${escapeHtmlText(title)}</span>
            <p class="sb-conversation-field-hint" style="margin: 4px 0 0;">${escapeHtmlText(description)}</p>
            <input type="text" id="sb_conversation_group_search" class="text_pole textarea_compact" placeholder="Search characters..." style="inline-size: 100%; margin-top: 8px;" />
        </div>
        <div class="sb-conversation-add-dm-list" id="sb_conversation_group_list" style="margin-top: 8px; max-block-size: 220px; overflow-y: auto; display: flex; flex-direction: column; gap: 4px;"></div>
        <div class="sb-conversation-group-picker-actions" style="display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-top: 10px;">
            <span id="sb_conversation_group_selected_count" class="sb-conversation-field-hint" style="margin: 0;"></span>
            <span style="display: flex; gap: 6px;">
                <button type="button" class="menu_button" data-sb-conversation-action="cancel-conversation-group">Cancel</button>
                <button type="button" class="menu_button" data-sb-conversation-action="create-conversation-group">Create Group</button>
            </span>
        </div>
    `;

    const listContainer = document.getElementById('sb_conversation_group_list');
    const searchInput = document.getElementById('sb_conversation_group_search');
    const selectedCount = document.getElementById('sb_conversation_group_selected_count');
    const createButton = picker.querySelector('[data-sb-conversation-action="create-conversation-group"]');

    function syncSelectedMembers() {
        lockedMembers.forEach(avatar => selectedMembers.add(avatar));
        picker.dataset.selectedMembers = JSON.stringify([...selectedMembers]);
        if (selectedCount instanceof HTMLElement) {
            selectedCount.textContent = `${selectedMembers.size} selected`;
        }
        if (createButton instanceof HTMLButtonElement) {
            createButton.disabled = selectedMembers.size < 2;
        }
    }

    function renderList(query = '') {
        if (!(listContainer instanceof HTMLElement)) return;
        const rows = [];
        (Array.isArray(characters) ? characters : []).forEach((character) => {
            if (!character?.avatar) return;
            const name = character.name || 'Character';
            if (query && !name.toLowerCase().includes(query)) return;

            const checked = selectedMembers.has(character.avatar) ? ' checked' : '';
            const disabled = lockedMembers.has(character.avatar) ? ' disabled' : '';
            const thumb = getThumbnailUrl('avatar', character.avatar);
            rows.push(`
                <label class="sb-conversation-add-dm-option sb-conversation-group-member-option" style="display: flex; align-items: center; gap: 8px; inline-size: 100%; background: none; border: none; padding: 6px; border-radius: var(--sb-radius-sm); text-align: left; cursor: pointer; color: inherit;">
                    <input type="checkbox" class="sb-conversation-group-member-checkbox" value="${escapeHtmlAttribute(character.avatar)}"${checked}${disabled} />
                    <img src="${escapeHtmlAttribute(thumb)}" alt="" style="inline-size: 24px; block-size: 24px; border-radius: 50%; object-fit: cover;" loading="lazy" />
                    <span style="font-size: var(--sb-type-caption);">${escapeHtmlText(name)}</span>
                </label>
            `);
        });

        listContainer.innerHTML = rows.length
            ? rows.join('')
            : '<div class="sb-conversation-empty" style="padding: 8px; font-size: var(--sb-type-meta); opacity: 0.7;">No matching characters found.</div>';
        syncSelectedMembers();
    }

    picker.onchange = (event) => {
        const checkbox = event.target instanceof HTMLInputElement && event.target.classList.contains('sb-conversation-group-member-checkbox')
            ? event.target
            : null;
        if (!checkbox) {
            return;
        }

        if (checkbox.checked) {
            selectedMembers.add(checkbox.value);
        } else if (!lockedMembers.has(checkbox.value)) {
            selectedMembers.delete(checkbox.value);
        }
        syncSelectedMembers();
    };

    renderList();

    if (searchInput instanceof HTMLInputElement) {
        searchInput.focus();
        searchInput.addEventListener('input', () => {
            renderList(searchInput.value.toLowerCase().trim());
        });
    }
}

async function handleCreateConversationGroupFromPicker() {
    const picker = document.getElementById('sb_conversation_add_dm_picker');
    if (!(picker instanceof HTMLElement)) {
        return false;
    }

    let members = [];
    try {
        members = JSON.parse(picker.dataset.selectedMembers || '[]');
    } catch {
        members = [];
    }

    const sourceAvatar = picker.dataset.copySource === 'true' ? picker.dataset.sourceAvatar || '' : '';
    const copySourceGroupId = picker.dataset.copySource === 'true' ? picker.dataset.copySourceGroupId || '' : null;
    return createAndOpenConversationGroup(members, { sourceAvatar, copySourceGroupId });
}

function openAddMemberPicker() {
    const avatar = getCurrentCharAvatar();
    if (!avatar) {
        toastr.warning('Open a Conversation before adding members.');
        return;
    }

    openPalsRail();
    toggleConversationGroupPicker({
        sourceAvatar: avatar,
        sourceGroupId: conversationSelectedGroupId || '',
    });
}

function bindConversationChromeControls(sheld) {
    if (sheld.dataset.sbConversationChromeBound === 'true') {
        return;
    }

    sheld.dataset.sbConversationChromeBound = 'true';
    sheld.addEventListener('click', async (event) => {
        const target = event.target instanceof Element ? event.target.closest('[data-sb-conversation-action], .sb-conversation-pal, .sb-conversation-mobile-menu-trigger') : null;

        if (!target || (!target.closest('.sb-conversation-message-actions') && !target.closest('.sb-conversation-mobile-menu-trigger'))) {
            document.querySelectorAll('.sb-conversation-message-actions.open').forEach(el => {
                el.classList.remove('open');
            });
        }

        if (!(target instanceof HTMLElement)) {
            return;
        }

        if (target.classList.contains('sb-conversation-mobile-menu-trigger')) {
            event.stopPropagation();
            const currentBubble = target.closest('.sb-conversation-message-bubble');
            const currentActionBar = currentBubble?.querySelector('.sb-conversation-message-actions');
            if (currentActionBar) {
                const isOpen = currentActionBar.classList.contains('open');
                document.querySelectorAll('.sb-conversation-message-actions.open').forEach(el => {
                    if (el !== currentActionBar) {
                        el.classList.remove('open');
                    }
                });
                if (isOpen) {
                    currentActionBar.classList.remove('open');
                } else {
                    currentActionBar.classList.add('open');
                }
            }
            return;
        }

        if (target.classList.contains('sb-conversation-pal')) {
            const avatar = target.dataset.avatar || characters[parsePositiveInt(target.dataset.characterIndex, -1, 0)]?.avatar;
            const groupId = target.dataset.groupId || '';
            if (avatar) {
                closePalsRail();
                openConversationWorkspaceForAvatar(avatar, {
                    groupId: groupId || null,
                    showToast: false,
                });
            }
            return;
        }

        switch (target.dataset.sbConversationAction) {
            case 'toggle-tools': {
                const currentVisible = localStorage.getItem('sb_conv_tools_visible') === 'true';
                localStorage.setItem('sb_conv_tools_visible', String(!currentVisible));
                syncConversationToolsVisibility();
                break;
            }
            case 'toggle-pals':
                togglePalsRail();
                break;
            case 'close-pals':
                closePalsRail();
                break;
            case 'open-settings':
                openConversationSettings();
                break;
            case 'close-settings':
                closeConversationSettings();
                break;
            case 'return-roleplay':
                disableConversationModeForCurrentCharacter();
                break;
            case 'polish-character-message':
                await handleCharacterMessagePolish(target.dataset.messageId, target);
                break;
            case 'open-add-member':
                openAddMemberPicker();
                break;
            case 'open-add-dm':
                toggleAddDmPicker();
                break;
            case 'open-new-group-chat':
                toggleConversationGroupPicker();
                break;
            case 'create-conversation-group':
                await handleCreateConversationGroupFromPicker();
                break;
            case 'cancel-conversation-group':
                hideConversationStartPicker();
                break;
            case 'attach-file': {
                const fileInput = document.getElementById(CHROME_IDS.fileInput);
                if (fileInput instanceof HTMLInputElement) {
                    fileInput.click();
                }
                break;
            }
            case 'clear-attachments':
                clearConversationAttachmentInput();
                break;
            case 'refresh-memory':
                await refreshConversationMemoryFromPanel();
                break;
            case 'clear-memory':
                clearConversationMemoryFromPanel();
                break;
            case 'stop-image-generation':
                imageGenerationAbortController?.abort?.();
                imageGenerationActive = false;
                imageGenerationAbortController = null;
                renderConversationTimeline();
                toastr.info('Image generation stopped.');
                break;
            case 'add-character-dm': {
                const index = parsePositiveInt(target.dataset.characterIndex, -1, 0);
                if (index >= 0) {
                    const char = characters[index];
                    if (char?.avatar) {
                        const charSettings = getSettings(char.avatar);
                        charSettings.enabled = true;
                        saveSettings(char.avatar, charSettings);
                        document.getElementById('sb_conversation_add_dm_picker')?.setAttribute('hidden', '');
                        closePalsRail();
                        openConversationWorkspaceForAvatar(char.avatar, {
                            groupId: null,
                            showToast: false,
                        });
                        renderPalsRail();
                        setTimeout(() => {
                            const input = document.getElementById(CHROME_IDS.input);
                            if (input instanceof HTMLTextAreaElement) {
                                input.focus();
                            }
                        }, 100);
                    }
                }
                break;
            }
            case 'select-branch': {
                const avatar = target.dataset.avatar;
                const groupId = target.dataset.groupId || '';
                const branchId = target.dataset.branchId;
                if (avatar && branchId) {
                    setActiveConversationBranch(avatar, branchId, { groupId });
                    openConversationWorkspaceForAvatar(avatar, {
                        groupId: groupId || null,
                        showToast: false,
                    });
                    refreshConversationInterface({ syncControls: false });
                    renderConversationMemoryPanel();
                    document.getElementById(CHROME_IDS.input)?.focus?.({ preventScroll: true });
                }
                break;
            }
            case 'new-branch': {
                const avatar = target.dataset.avatar;
                const groupId = target.dataset.groupId || '';
                const character = getCharacterForAvatar(avatar);
                if (!avatar) {
                    break;
                }
                const fallbackName = `Chat ${getConversationBranches(avatar, { groupId }).length + 1}`;
                const name = globalThis.prompt?.(`Name this Conversation branch for ${character?.name || 'this character'}`, fallbackName) || fallbackName;
                createConversationBranchForAvatar(avatar, name, { groupId });
                openConversationWorkspaceForAvatar(avatar, {
                    groupId: groupId || null,
                    showToast: false,
                });
                refreshConversationInterface({ syncControls: false });
                renderConversationMemoryPanel();
                document.getElementById(CHROME_IDS.input)?.focus?.({ preventScroll: true });
                break;
            }
            case 'rename-branch': {
                const avatar = target.dataset.avatar;
                const groupId = target.dataset.groupId || '';
                const branchId = target.dataset.branchId;
                const branch = getConversationBranches(avatar, { groupId }).find(item => item.id === branchId);
                if (avatar && branchId && branch) {
                    const name = globalThis.prompt?.('Rename Conversation branch', branch.name || 'Conversation');
                    if (name?.trim()) {
                        renameConversationBranch(avatar, branchId, name, { groupId });
                        renderPalsRail();
                        if (isConversationActiveThread(avatar, groupId)) {
                            updateConversationHeader(getSettings(avatar));
                            renderConversationMemoryPanel();
                        }
                    }
                }
                break;
            }
            case 'delete-branch': {
                const avatar = target.dataset.avatar;
                const groupId = target.dataset.groupId || '';
                const branchId = target.dataset.branchId;
                const branch = getConversationBranches(avatar, { groupId }).find(item => item.id === branchId);
                if (avatar && branchId && branch) {
                    const confirmed = typeof globalThis.confirm === 'function'
                        ? globalThis.confirm(`Delete the "${branch.name || 'Conversation'}" branch? This cannot be undone.`)
                        : true;
                    if (confirmed) {
                        deleteConversationBranch(avatar, branchId, { groupId });
                        if (isConversationActiveThread(avatar, groupId)) {
                            renderConversationTimeline();
                            refreshConversationInterface({ syncControls: false });
                            renderConversationMemoryPanel();
                        } else {
                            renderPalsRail();
                        }
                    }
                }
                break;
            }
            case 'delete-dm': {
                const avatar = target.dataset.avatar;
                const groupId = target.dataset.groupId || '';
                const character = getCharacterForAvatar(avatar);
                if (!avatar) {
                    break;
                }
                const name = character?.name || 'this character';
                const historyLabel = groupId ? `group Conversation history with ${name}` : `solo DM history with ${name}`;
                const confirmed = typeof globalThis.confirm === 'function'
                    ? globalThis.confirm(`Delete your previous ${historyLabel}? This cannot be undone.`)
                    : true;
                if (confirmed) {
                    resetCharacterConversationBranches(avatar, { groupId });
                    setLastConversationPreview(avatar, 'Conversation ready', { groupId });
                    clearUnreadCount(avatar, { groupId });
                    resetFollowupCount(avatar, { groupId });

                    if (!groupId) {
                        const charSettings = getSettings(avatar);
                        charSettings.enabled = false;
                        saveSettings(avatar, charSettings);
                    }

                    if (isConversationActiveThread(avatar, groupId)) {
                        const remainingPals = getConversationRailItems()
                            .filter(item => !(item.character.avatar === avatar && item.groupId === groupId));
                        if (remainingPals.length > 0) {
                            const nextPal = remainingPals[0];
                            openConversationWorkspaceForAvatar(nextPal.character.avatar, { groupId: nextPal.groupId || null, showToast: false });
                            renderConversationTimeline();
                            refreshConversationInterface({ syncControls: true });
                        } else {
                            conversationWorkspaceOpen = false;
                            refreshConversationInterface({ syncControls: false });
                        }
                    } else {
                        renderPalsRail();
                    }
                    toastr.success(`Deleted ${historyLabel}.`);
                }
                break;
            }
            case 'new-chat': {
                const avatar = getCurrentCharAvatar();
                if (!avatar) {
                    toastr.warning('Pick a DM first.');
                    break;
                }
                const groupId = getConversationGroupIdForAvatar(avatar);
                createConversationBranchForAvatar(avatar, `Chat ${getConversationBranches(avatar, { groupId }).length + 1}`, { groupId });
                updateLastUserActivity(avatar, { groupId });
                renderConversationTimeline();
                refreshConversationInterface({ syncControls: false });
                renderConversationMemoryPanel();
                toastr.success('New Conversation branch started.');
                break;
            }
            case 'edit-message':
                editConversationMessage(target.dataset.messageId);
                break;
            case 'copy-message':
                await copyConversationMessage(target.dataset.messageId);
                break;
            case 'toggle-message-pin':
                toggleConversationMessagePin(target.dataset.messageId);
                break;
            case 'react-message':
                reactConversationMessage(target.dataset.messageId, target.dataset.reaction);
                break;
            case 'branch-from-message':
                branchConversationFromMessage(target.dataset.messageId);
                break;
            case 'regenerate-message':
                await regenerateConversationMessage(target.dataset.messageId);
                break;
            case 'delete-message': {
                const confirmed = typeof globalThis.confirm === 'function'
                    ? globalThis.confirm('Delete this Conversation message?')
                    : true;
                if (confirmed) {
                    deleteConversationMessage(target.dataset.messageId);
                }
                break;
            }
            case 'quick-selfie':
                await quickConversationSelfie();
                break;
            case 'quick-remind':
                await quickConversationReminder();
                break;
            case 'quick-summarize':
                await quickConversationSummarize();
                break;
            case 'set-channel':
                setConversationTimelineChannel(target.dataset.channel);
                break;
            case 'weekly-add':
                addWeeklyScheduleRow();
                break;
            case 'edit-schedule': {
                const avatar = getCurrentCharAvatar();
                if (avatar || getCurrentGroupConversationMembers().length) {
                    openScheduleEditorModal(avatar);
                }
                break;
            }
            case 'reset-prompt': {
                const area = document.getElementById('sb_conv_geechan_chatroom_prompt');
                if (area instanceof HTMLTextAreaElement) {
                    area.value = GEECHAN_DEFAULT_PROMPT;
                    area.dispatchEvent(new Event('input', { bubbles: true }));
                    toastr.success('System prompt reset to default Geechan preset.');
                }
                break;
            }
            case 'weekly-remove': {
                const row = target.closest('.sb-conversation-weekly-row');
                if (row instanceof HTMLElement) {
                    row.remove();
                    saveCurrentPanelSettings();
                }
                break;
            }
            case 'set-user-status': {
                const status = target.dataset.status;
                if (status) {
                    setUserStatus(status);
                    updateUserFooter();
                    document.getElementById(CHROME_IDS.userStatusPicker)?.setAttribute('hidden', '');
                }
                break;
            }
            case 'open-user-status-picker':
                toggleUserStatusPicker();
                break;
            case 'edit-user-persona-status':
                editUserPersonaStatus();
                break;
            case 'open-persona-picker':
                togglePersonaPicker();
                break;
            case 'pick-persona': {
                const avatarId = target.dataset.personaAvatar;
                if (avatarId) {
                    await setUserAvatar(avatarId, { toastPersonaNameChange: false });
                    updateUserFooter();
                    saveCurrentPanelSettings();
                    const picker = document.getElementById(CHROME_IDS.personaPicker);
                    if (picker instanceof HTMLElement) {
                        renderConversationPersonaPicker(picker);
                    }
                }
                break;
            }
            case 'generate-schedule': {
                if (scheduleGenerationBusy) {
                    break;
                }
                const character = getCurrentCharacter();
                const genAvatar = getCurrentCharAvatar();
                if (!character || !genAvatar) {
                    toastr.warning('No character selected.');
                    break;
                }
                scheduleGenerationBusy = true;
                const genBtn = target;
                genBtn.setAttribute('disabled', '');
                toastr.info(`Generating schedule for ${character.name}…`);
                try {
                    const schedule = await generateCharacterSchedule(character);
                    if (schedule) {
                        saveStoredSchedule(genAvatar, schedule);
                        const genSettings = getSettings(genAvatar);
                        genSettings.auto_schedule = JSON.stringify(schedule);
                        genSettings.talkativeness = schedule.talkativeness;
                        genSettings.inactivity_threshold = schedule.inactivityThresholdMinutes;
                        genSettings.schedule_generated_at = Date.now();
                        saveSettings(genAvatar, genSettings);
                        applySettingsToPanel(genSettings);
                        renderScheduleDisplay();
                        updateConversationChrome(genSettings);
                        toastr.success(`Schedule generated for ${character.name}.`);
                    } else {
                        toastr.warning('Schedule generation returned no data. Try again.');
                    }
                } catch (err) {
                    console.error('Schedule generation error:', err);
                    toastr.error('Schedule generation failed.');
                } finally {
                    scheduleGenerationBusy = false;
                    genBtn.removeAttribute('disabled');
                }
                break;
            }
            default:
                break;
        }
    });

    const form = document.getElementById(CHROME_IDS.form);
    if (form instanceof HTMLFormElement && form.dataset.sbConversationBound !== 'true') {
        form.dataset.sbConversationBound = 'true';
        form.addEventListener('submit', (event) => {
            event.preventDefault();
            void submitConversationInput();
        });
    }

    const input = document.getElementById(CHROME_IDS.input);
    if (input instanceof HTMLTextAreaElement && input.dataset.sbConversationBound !== 'true') {
        input.dataset.sbConversationBound = 'true';
        input.addEventListener('keydown', (event) => {
            if (event.isComposing || event.key !== 'Enter' || event.shiftKey) {
                return;
            }

            event.preventDefault();
            void submitConversationInput();
        });
        input.addEventListener('input', () => {
            input.style.height = 'auto';
            input.style.height = `${input.scrollHeight}px`;
        });
        input.addEventListener('paste', (event) => {
            const files = Array.from(event.clipboardData?.files || []);
            if (!files.length) {
                return;
            }

            event.preventDefault();
            addConversationFilesToInput(files);
        });
    }

    const fileInput = document.getElementById(CHROME_IDS.fileInput);
    if (fileInput instanceof HTMLInputElement && fileInput.dataset.sbConversationBound !== 'true') {
        fileInput.dataset.sbConversationBound = 'true';
        fileInput.addEventListener('change', updateConversationAttachmentPreview);
    }

    const drawer = document.getElementById(CHROME_IDS.settingsDrawer);
    if (drawer instanceof HTMLElement && drawer.dataset.sbConversationBound !== 'true') {
        drawer.dataset.sbConversationBound = 'true';
        drawer.addEventListener('change', saveCurrentPanelSettings);
    }

    const notificationMuted = document.getElementById('sb_conv_notifications_muted');
    if (notificationMuted instanceof HTMLInputElement && notificationMuted.dataset.sbConversationBound !== 'true') {
        notificationMuted.dataset.sbConversationBound = 'true';
        notificationMuted.addEventListener('change', updateConversationNotificationSettingsVisibility);
    }

    const searchInput = document.getElementById(CHROME_IDS.search);
    if (searchInput instanceof HTMLInputElement && searchInput.dataset.sbConversationBound !== 'true') {
        searchInput.dataset.sbConversationBound = 'true';
        searchInput.addEventListener('input', () => updateConversationSearchQuery(searchInput.value));
    }

    const stage = document.getElementById(CHROME_IDS.stage);
    if (stage instanceof HTMLElement && stage.dataset.sbConversationDropBound !== 'true') {
        stage.dataset.sbConversationDropBound = 'true';
        const stopDrag = () => {
            stage.dataset.dragging = 'false';
            const dropHint = document.getElementById(CHROME_IDS.dropHint);
            if (dropHint instanceof HTMLElement) {
                dropHint.hidden = true;
            }
        };

        stage.addEventListener('dragover', (event) => {
            event.preventDefault();
            stage.dataset.dragging = 'true';
            const dropHint = document.getElementById(CHROME_IDS.dropHint);
            if (dropHint instanceof HTMLElement) {
                dropHint.hidden = false;
            }
        });
        stage.addEventListener('dragleave', stopDrag);
        stage.addEventListener('drop', (event) => {
            event.preventDefault();
            stopDrag();
            const files = Array.from(event.dataTransfer?.files || []);
            if (files.length) {
                addConversationFilesToInput(files);
            }
        });
    }

    const backdrop = document.getElementById(CHROME_IDS.settingsBackdrop);
    if (backdrop instanceof HTMLElement && backdrop.dataset.sbConversationBound !== 'true') {
        backdrop.dataset.sbConversationBound = 'true';
        backdrop.addEventListener('click', () => {
            closeConversationSettings();
            closePalsRail();
        });
    }

    const palsSearch = document.getElementById('sb_conversation_pals_search');
    if (palsSearch instanceof HTMLInputElement && palsSearch.dataset.sbConversationBound !== 'true') {
        palsSearch.dataset.sbConversationBound = 'true';
        palsSearch.addEventListener('input', () => {
            const query = palsSearch.value.toLowerCase().trim();
            const pals = document.querySelectorAll('.sb-conversation-pal');
            pals.forEach(pal => {
                if (pal instanceof HTMLElement) {
                    const palName = pal.querySelector('.sb-conversation-pal-name')?.textContent?.toLowerCase() || '';
                    const row = pal.closest('.sb-conversation-pal-row');
                    const targetElement = row instanceof HTMLElement ? row : pal;
                    if (palName.includes(query)) {
                        targetElement.style.display = '';
                    } else {
                        targetElement.style.display = 'none';
                    }
                }
            });
        });
    }

    const personaPicker = document.getElementById(CHROME_IDS.personaPicker);
    if (personaPicker instanceof HTMLElement && personaPicker.dataset.sbConversationAppendicesBound !== 'true') {
        personaPicker.dataset.sbConversationAppendicesBound = 'true';
        personaPicker.addEventListener('change', (event) => {
            const checkbox = event.target instanceof Element
                ? event.target.closest('.sb-conversation-persona-note-checkbox')
                : null;
            if (!(checkbox instanceof HTMLInputElement)) {
                return;
            }

            const avatarId = checkbox.dataset.personaAvatar;
            if (!avatarId) {
                return;
            }

            const selectedIds = Array.from(personaPicker.querySelectorAll('.sb-conversation-persona-note-checkbox'))
                .filter(input => input instanceof HTMLInputElement && input.dataset.personaAvatar === avatarId && input.checked)
                .map(input => input.value);
            setActiveConversationPersonaAppendixIds(avatarId, selectedIds);
            renderConversationPersonaPicker(personaPicker);
            updateUserFooter();
        });
    }
}

function getDefaultConversationAvatar() {
    const group = getConversationGroupById(selected_group);
    const groupAvatar = group?.members
        ?.filter(avatar => avatar && !group.disabled_members?.includes(avatar))
        ?.find(avatar => getCharacterForAvatar(avatar));
    if (selected_group && groupAvatar) {
        return groupAvatar;
    }

    const currentAvatar = getRoleplayCurrentCharacter()?.avatar;
    if (currentAvatar) {
        return currentAvatar;
    }

    const pal = getConversationPals().find(item => item.character?.avatar);
    if (pal?.character?.avatar) {
        return pal.character.avatar;
    }

    return (Array.isArray(characters) ? characters : []).find(character => character?.avatar)?.avatar || null;
}

export function openConversationWorkspaceForAvatar(avatar, { groupId = null, showToast = true } = {}) {
    const character = avatar ? getCharacterForAvatar(avatar) : null;
    const targetAvatar = character?.avatar || null;
    const targetGroupId = groupId && targetAvatar && isAvatarInConversationGroup(targetAvatar, groupId) ? String(groupId) : null;
    const threadChanged = conversationSelectedAvatar !== targetAvatar || conversationSelectedGroupId !== targetGroupId;
    conversationWorkspaceOpen = true;
    conversationSelectedAvatar = targetAvatar;
    conversationSelectedGroupId = targetGroupId;
    if (threadChanged) {
        conversationTimelineChannel = 'main';
        conversationTimelineSearchQuery = '';
    }

    if (!targetAvatar) {
        refreshConversationInterface({ syncControls: false });
        setTimeout(() => {
            document.getElementById(CHROME_IDS.input)?.focus?.({ preventScroll: false });
        }, 100);
        return false;
    }

    const settings = getSettings(targetAvatar);
    const wasEnabled = Boolean(settings.enabled);
    settings.enabled = true;
    saveSettings(targetAvatar, settings);
    applySettingsToPanel(settings);
    refreshConversationInterface({ syncControls: true });
    if (showToast && !wasEnabled) {
        toastr.info(`Conversation Mode activated for ${character.name || 'Character'}.`);
    }
    setTimeout(() => {
        document.getElementById(CHROME_IDS.input)?.focus?.({ preventScroll: false });
    }, 100);
    return true;
}

export function openConversationWorkspaceFromWelcome() {
    const avatar = conversationSelectedAvatar || getDefaultConversationAvatar();
    const groupId = selected_group && avatar && isAvatarInConversationGroup(avatar, selected_group) ? String(selected_group) : null;
    if (!avatar || !openConversationWorkspaceForAvatar(avatar, { groupId, showToast: false })) {
        toastr.warning('Pick or import a character before opening Conversation Mode.');
        return false;
    }

    return true;
}

function disableConversationModeForCurrentCharacter({ focusRoleplay = true } = {}) {
    conversationWorkspaceOpen = false;
    conversationSelectedAvatar = null;
    conversationSelectedGroupId = null;
    conversationTimelineChannel = 'main';
    conversationTimelineSearchQuery = '';
    refreshConversationInterface({ syncControls: false });
    if (focusRoleplay) {
        document.getElementById('send_textarea')?.focus?.({ preventScroll: false });
    }
}

function getSelectedConnectionProfileName() {
    const manager = extension_settings.connectionManager;
    if (!manager || !Array.isArray(manager.profiles)) {
        return '';
    }
    const selected = manager.profiles.find((profile) => profile?.id === manager.selectedProfile);
    return selected?.name ?? '';
}

function applyConversationContext(settings) {
    // Deprecated: rely entirely on temporary switches during generation to avoid corrupting global connection profile state.
}

function restoreConversationContext() {
    // Deprecated: rely entirely on temporary switches during generation to avoid corrupting global connection profile state.
}

function setConversationInterfaceActive(active) {
    const chrome = active ? ensureConversationChrome() : { sheld: document.getElementById('sheld') };
    if (!(chrome?.sheld instanceof HTMLElement)) {
        return;
    }

    if (!active) {
        chrome.sheld.removeAttribute('data-sb-conversation-mode');
        closeConversationSettings();
        closePalsRail();
        restoreConversationContext();
        for (const id of [CHROME_IDS.header, CHROME_IDS.stage, CHROME_IDS.palsRail]) {
            const element = document.getElementById(id);
            if (element instanceof HTMLElement) {
                element.hidden = true;
            }
        }
        return;
    }

    chrome.sheld.dataset.sbConversationMode = 'on';
    for (const id of [CHROME_IDS.header, CHROME_IDS.stage, CHROME_IDS.palsRail]) {
        const element = document.getElementById(id);
        if (element instanceof HTMLElement) {
            element.hidden = false;
        }
    }
    const avatar = getCurrentCharAvatar();
    if (avatar) {
        applyConversationContext(getSettings(avatar));
    }
    updateUserFooter();
}

function renderPalsRail() {
    const list = document.getElementById(CHROME_IDS.palsList);
    if (!(list instanceof HTMLElement)) {
        return;
    }

    const pals = getConversationRailItems();
    list.textContent = '';

    if (!pals.length) {
        const empty = document.createElement('div');
        empty.className = 'sb-conversation-empty';
        empty.textContent = 'Use + to start a DM with a character.';
        list.appendChild(empty);
        updateConversationNotificationIndicators();
        return;
    }

    for (const { character, index, settings, groupId, group } of pals) {
        const unreadCount = getUnreadCount(character.avatar, { groupId });
        const row = document.createElement('div');
        row.className = 'sb-conversation-pal-row';
        row.dataset.groupId = groupId || '';

        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'sb-conversation-pal';
        button.dataset.characterIndex = String(index);
        button.dataset.avatar = character.avatar;
        button.dataset.groupId = groupId || '';
        button.dataset.unread = String(unreadCount > 0);
        button.setAttribute('aria-current', String(isConversationActiveThread(character.avatar, groupId)));
        button.innerHTML = `
            <span class="sb-conversation-pal-avatar"></span>
            <span class="sb-conversation-pal-copy">
                <span class="sb-conversation-pal-name-row"><span class="sb-conversation-pal-name"></span><span class="sb-conversation-pal-kind"></span></span>
                <span class="sb-conversation-pal-preview"></span>
            </span>
            <span class="sb-conversation-pal-unread" aria-hidden="true"></span>
        `;

        const deleteButton = document.createElement('button');
        deleteButton.type = 'button';
        deleteButton.className = 'sb-conversation-pal-delete fa-solid fa-trash-can';
        deleteButton.dataset.sbConversationAction = 'delete-dm';
        deleteButton.dataset.avatar = character.avatar;
        deleteButton.dataset.groupId = groupId || '';
        const deleteTitle = groupId
            ? `Delete group Conversation history with ${character.name || 'Character'}`
            : `Delete solo DM history with ${character.name || 'Character'}`;
        deleteButton.title = deleteTitle;
        deleteButton.setAttribute('aria-label', deleteTitle);

        const avatarStack = button.querySelector('.sb-conversation-pal-avatar');
        const name = button.querySelector('.sb-conversation-pal-name');
        const kind = button.querySelector('.sb-conversation-pal-kind');
        const preview = button.querySelector('.sb-conversation-pal-preview');
        const unreadBadge = button.querySelector('.sb-conversation-pal-unread');

        renderConversationParticipantStack(avatarStack, getConversationParticipants(character.avatar, settings, { groupId }), {
            status: getEffectiveConversationStatus(character.avatar, settings),
            max: 3,
        });
        if (name instanceof HTMLElement) {
            name.textContent = groupId
                ? getConversationDisplayName(character.avatar, settings, { groupId })
                : character.name || 'Character';
        }
        if (kind instanceof HTMLElement) {
            kind.textContent = groupId ? (group?.name || 'Group DM') : 'Solo';
        }
        if (preview instanceof HTMLElement) {
            preview.textContent = getLastConversationPreview(character.avatar, { groupId });
        }
        if (unreadBadge instanceof HTMLElement) {
            unreadBadge.textContent = getBadgeLabel(unreadCount);
            unreadBadge.hidden = unreadCount <= 0;
        }

        const characterStore = getConversationThreadStore(character.avatar, { create: false, groupId });
        const activeBranchId = characterStore?.activeBranchId || DEFAULT_BRANCH_ID;
        const branchList = document.createElement('div');
        branchList.className = 'sb-conversation-branch-list';
        for (const branch of getConversationBranches(character.avatar, { groupId })) {
            const branchRow = document.createElement('div');
            branchRow.className = 'sb-conversation-branch-row';
            branchRow.dataset.active = String(branch.id === activeBranchId);

            const branchButton = document.createElement('button');
            branchButton.type = 'button';
            branchButton.className = 'sb-conversation-branch-button';
            branchButton.dataset.sbConversationAction = 'select-branch';
            branchButton.dataset.avatar = character.avatar;
            branchButton.dataset.groupId = groupId || '';
            branchButton.dataset.branchId = branch.id;
            branchButton.innerHTML = '<span class="sb-conversation-branch-name"></span><span class="sb-conversation-branch-preview"></span>';
            const branchName = branchButton.querySelector('.sb-conversation-branch-name');
            const branchPreview = branchButton.querySelector('.sb-conversation-branch-preview');
            if (branchName instanceof HTMLElement) {
                branchName.textContent = branch.name || 'Conversation';
            }
            if (branchPreview instanceof HTMLElement) {
                branchPreview.textContent = branch.preview || 'Conversation ready';
            }

            const renameBranch = document.createElement('button');
            renameBranch.type = 'button';
            renameBranch.className = 'sb-conversation-branch-action fa-solid fa-pen';
            renameBranch.dataset.sbConversationAction = 'rename-branch';
            renameBranch.dataset.avatar = character.avatar;
            renameBranch.dataset.groupId = groupId || '';
            renameBranch.dataset.branchId = branch.id;
            renameBranch.title = `Rename ${branch.name || 'conversation'}`;
            renameBranch.setAttribute('aria-label', renameBranch.title);

            const deleteBranch = document.createElement('button');
            deleteBranch.type = 'button';
            deleteBranch.className = 'sb-conversation-branch-action fa-solid fa-trash-can';
            deleteBranch.dataset.sbConversationAction = 'delete-branch';
            deleteBranch.dataset.avatar = character.avatar;
            deleteBranch.dataset.groupId = groupId || '';
            deleteBranch.dataset.branchId = branch.id;
            deleteBranch.title = `Delete ${branch.name || 'conversation'}`;
            deleteBranch.setAttribute('aria-label', deleteBranch.title);

            branchRow.append(branchButton, renameBranch, deleteBranch);
            branchList.appendChild(branchRow);
        }

        const newBranch = document.createElement('button');
        newBranch.type = 'button';
        newBranch.className = 'sb-conversation-new-branch';
        newBranch.dataset.sbConversationAction = 'new-branch';
        newBranch.dataset.avatar = character.avatar;
        newBranch.dataset.groupId = groupId || '';
        newBranch.innerHTML = '<i class="fa-solid fa-plus" aria-hidden="true"></i><span>New branch</span>';
        branchList.appendChild(newBranch);

        row.append(button, deleteButton, branchList);
        list.appendChild(row);
    }
    updateConversationNotificationIndicators();
}

function updateConversationHeader(settings = getSettings()) {
    const character = getCurrentCharacter();
    const avatar = getCurrentCharAvatar();
    const stage = document.getElementById(CHROME_IDS.stage);
    const name = document.querySelector(`#${CHROME_IDS.header} [data-sb-conversation-name]`);
    const status = document.querySelector(`#${CHROME_IDS.header} [data-sb-conversation-status]`);
    const participantsContainer = document.querySelector(`#${CHROME_IDS.header} [data-sb-conversation-participants]`);
    const addMemberButton = document.querySelector(`#${CHROME_IDS.header} [data-sb-conversation-action="open-add-member"]`);
    const statusCopy = getAvailabilityCopy(settings.availability);
    const schedule = avatar ? getStoredSchedule(avatar) : null;
    const current = schedule ? getCurrentActivityFromSchedule(schedule, avatar) : null;
    const effectiveStatus = current ? current.status : settings.availability;

    if (!avatar || !character) {
        if (stage instanceof HTMLElement) {
            stage.dataset.ambientStatus = 'offline';
        }
        if (addMemberButton instanceof HTMLButtonElement) {
            addMemberButton.hidden = true;
        }
        renderConversationParticipantStack(participantsContainer, [], { status: 'offline' });
        if (name instanceof HTMLElement) {
            name.textContent = 'Conversation';
        }
        if (status instanceof HTMLElement) {
            status.textContent = 'Pick or start a DM from the Pals rail.';
        }
        return;
    }

    if (stage instanceof HTMLElement) {
        stage.dataset.ambientStatus = String(effectiveStatus || settings.availability || 'online');
    }

    const participants = getConversationParticipants(avatar, settings);
    const partnerCount = Math.max(0, participants.length - 1);
    if (addMemberButton instanceof HTMLButtonElement) {
        addMemberButton.hidden = !conversationWorkspaceOpen;
        const label = conversationSelectedGroupId ? 'Add member to group Conversation' : 'Add member to this DM';
        addMemberButton.title = label;
        addMemberButton.setAttribute('aria-label', label);
    }
    renderConversationParticipantStack(participantsContainer, participants, { status: effectiveStatus });
    if (name instanceof HTMLElement) {
        name.textContent = getConversationDisplayName(avatar, settings);
    }
    if (status instanceof HTMLElement) {
        const typingParticipants = getActiveTypingParticipants(avatar);
        if (generationActive && character?.avatar && !typingParticipants.some(participant => participant.avatar === character.avatar)) {
            typingParticipants.unshift(character);
        }
        if (typingParticipants.length) {
            const typingNames = typingParticipants.map(participant => participant?.name || 'Character').filter(Boolean);
            status.textContent = typingNames.length > 1
                ? `${typingNames.join(', ')} are writing...`
                : `${typingNames[0] || 'Character'} is writing...`;
        } else if (current) {
            const currentCopy = getAvailabilityCopy(current.status);
            const delayedNotice = ['dnd', 'offline'].includes(current.status) ? ' · replies may be delayed' : '';
            const partnerNotice = partnerCount ? ` · ${partnerCount} pal${partnerCount === 1 ? '' : 's'} can chime in` : '';
            status.textContent = `${currentCopy.label} · ${current.activity}${delayedNotice}${partnerNotice}`;
        } else {
            const partnerNotice = partnerCount ? ` ${partnerCount} pal${partnerCount === 1 ? '' : 's'} can chime in.` : '';
            status.textContent = `${statusCopy.label}: ${statusCopy.detail}${partnerNotice}`;
        }
    }
}

function syncConversationToolsVisibility() {
    const tools = document.getElementById(CHROME_IDS.tools);
    const toggleBtn = document.getElementById('sb_conversation_toggle_tools');
    if (tools instanceof HTMLElement) {
        const visible = localStorage.getItem('sb_conv_tools_visible') === 'true';
        if (visible) {
            tools.classList.add('visible');
            tools.style.setProperty('display', 'grid', 'important');
            if (toggleBtn) {
                toggleBtn.classList.add('active');
            }
        } else {
            tools.classList.remove('visible');
            tools.style.setProperty('display', 'none', 'important');
            if (toggleBtn) {
                toggleBtn.classList.remove('active');
            }
        }
    }
}

function updateConversationChrome(settings = getSettings()) {
    updateConversationHeader(settings);
    renderPalsRail();
}

function refreshConversationInterface({ syncControls = false } = {}) {
    const avatar = getCurrentCharAvatar();
    const settings = getSettings(avatar);
    if (conversationWorkspaceOpen && avatar && !settings.enabled) {
        settings.enabled = true;
        saveSettings(avatar, settings);
    }
    const active = Boolean(conversationWorkspaceOpen);

    setConversationInterfaceActive(active);

    if (syncControls && avatar) {
        applySettingsToPanel(settings);
    }

    if (active) {
        if (avatar) {
            const groupId = conversationSelectedGroupId || '';
            clearUnreadCount(avatar, { groupId });
            updateLastPreviewFromConversation(avatar, { groupId });
        }
        renderConversationTimeline();
        updateConversationChrome(settings);
        updateUserFooter();
        syncConversationToolsVisibility();

        const input = document.getElementById(CHROME_IDS.input);
        const send = document.getElementById(CHROME_IDS.send);
        if (input instanceof HTMLTextAreaElement) {
            input.disabled = !avatar;
            input.placeholder = avatar ? 'Message this character outside roleplay...' : 'Pick or start a DM from the Pals rail...';
        }
        if (send instanceof HTMLButtonElement) {
            send.disabled = !avatar;
        }
    }

    updateProsePolisherButtonVisibility();
}

function readSettingsFromPanel(avatar) {
    const settings = getSettings(avatar);

    for (const field of SETTINGS_FIELDS) {
        const element = document.getElementById(field.id);
        if (!(element instanceof HTMLElement)) {
            continue;
        }

        if (field.prop === 'checked') {
            settings[field.key] = Boolean(element.checked);
        } else if (field.type === 'number') {
            const parsed = parsePositiveInt(element.value, field.fallback, field.min);
            settings[field.key] = typeof field.max === 'number' ? clamp(parsed, field.min, field.max) : parsed;
        } else {
            settings[field.key] = element.value ?? '';
        }
    }

    return settings;
}

function saveCurrentPanelSettings() {
    const avatar = getCurrentCharAvatar();
    if (!avatar) {
        return;
    }

    // Sync dynamic editor state into hidden backing inputs before reading
    const weeklyInput = document.getElementById('sb_conv_weekly_schedule');
    if (weeklyInput instanceof HTMLInputElement) {
        weeklyInput.value = readWeeklyScheduleFromEditor();
    }
    const chimingInput = document.getElementById('sb_conv_multi_char_names');
    if (chimingInput instanceof HTMLInputElement) {
        chimingInput.value = readChimingPartnersFromList();
    }

    const settings = readSettingsFromPanel(avatar);
    settings.idle_action = getIdleActionFromSettings(settings);
    settings.reply_max_tokens = getConversationReplyMaxTokens(settings);
    settings.auto_chat_names = settings.multi_char_names;
    saveSettings(avatar, settings);
    refreshConversationInterface({ syncControls: false });
    updateGroupMembersVisibility();
}

function applySettingsToPanel(settings) {
    for (const field of SETTINGS_FIELDS) {
        const element = document.getElementById(field.id);
        if (!(element instanceof HTMLElement)) {
            continue;
        }

        if (field.prop === 'checked') {
            element.checked = Boolean(settings[field.key]);
        } else {
            element.value = settings[field.key] ?? '';
        }
    }
    updateGroupMembersVisibility();
    updateConversationNotificationSettingsVisibility();
}

function updateGroupMembersVisibility() {
    const checkbox = document.getElementById('sb_conv_multi_char');
    const wrapper = document.getElementById('sb_conv_group_members_wrapper');
    if (checkbox instanceof HTMLInputElement && wrapper instanceof HTMLElement) {
        wrapper.hidden = !checkbox.checked;
    }
}

function loadCurrentPanelSettings() {
    const avatar = getCurrentCharAvatar();

    if (!avatar) {
        applySettingsToPanel(DEFAULT_SETTINGS);
        refreshConversationInterface({ syncControls: false });
        return;
    }

    const settings = getSettings(avatar);
    applySettingsToPanel(settings);
    refreshConversationInterface({ syncControls: false });
}

function updateProsePolisherButtonVisibility() {
    const button = document.getElementById('sb_prose_polisher_but');
    if (button instanceof HTMLElement) {
        button.classList.add('displayNone');
        button.hidden = true;
    }
}

async function handleCharacterMessagePolish(messageId, buttonElement) {
    const avatar = getCurrentCharAvatar();
    if (!avatar) return;

    const groupId = getConversationGroupIdForAvatar(avatar);
    const thread = getConversationThread(avatar, { groupId });
    const msg = thread.find(m => m.id === messageId);
    if (!msg || !msg.mes) {
        return;
    }

    if (buttonElement instanceof HTMLElement) {
        buttonElement.classList.remove('fa-wand-magic-sparkles');
        buttonElement.classList.add('fa-spinner', 'fa-spin');
    }

    try {
        const charName = getCurrentCharName();
        const systemPrompt = `You are an editor for ${charName}'s messages. Polish ${charName}'s reply in this instant messaging chatroom to make it more expressive, fitting for their personality, and natural. Correct any structural awkwardness while preserving the exact meaning, spelling quirks, and intent of the original text. Output only the polished reply without formatting prefixes or labels.`;
        const prompt = `Polish this message text:\n"${msg.mes}"`;
        const settings = getSettings(avatar);
        const response = await withConversationConnectionProfile(settings, () => generateRaw({
            prompt,
            systemPrompt,
            responseLength: 300,
            trimNames: true,
        }));

        if (response?.trim()) {
            msg.mes = normalizeConversationOutputText(response.trim());
            saveConversationThread(avatar, thread, { groupId });
            updateLastPreviewFromConversation(avatar, { groupId });
            renderConversationTimeline();
            globalThis.toastr?.success?.('Character reply polished successfully!');
        } else {
            globalThis.toastr?.error?.('Polishing failed. No response received.');
        }
    } catch (error) {
        console.error('Character prose polishing error:', error);
        globalThis.toastr?.error?.('Error polishing character reply.');
    } finally {
        if (buttonElement instanceof HTMLElement) {
            buttonElement.classList.remove('fa-spinner', 'fa-spin');
            buttonElement.classList.add('fa-wand-magic-sparkles');
        }
    }
}

function getConversationPendingFiles() {
    const fileInput = document.getElementById(CHROME_IDS.fileInput);
    if (!(fileInput instanceof HTMLInputElement) || !fileInput.files?.length) {
        return [];
    }

    return Array.from(fileInput.files);
}

function getConversationFileExtension(file) {
    const name = String(file?.name || '').toLowerCase();
    const dotIndex = name.lastIndexOf('.');
    return dotIndex >= 0 ? name.slice(dotIndex) : '';
}

function isConversationAttachmentAllowed(file) {
    const mime = String(file?.type || '').toLowerCase();
    if (mime.startsWith('image/') || mime.startsWith('video/') || mime.startsWith('audio/')) {
        return true;
    }

    return CONVERSATION_ATTACHMENT_ALLOWED_EXTENSIONS.includes(getConversationFileExtension(file));
}

function warnConversationAttachment(message) {
    globalThis.toastr?.warning?.(message, '', SAFE_TOAST_OPTIONS);
}

function getValidatedConversationPendingFiles({ notify = false } = {}) {
    const files = getConversationPendingFiles();
    if (!files.length) {
        return files;
    }

    if (files.length > CONVERSATION_ATTACHMENT_MAX_FILES) {
        if (notify) {
            warnConversationAttachment(`Attach up to ${CONVERSATION_ATTACHMENT_MAX_FILES} files per Conversation message.`);
        }
        return null;
    }

    const oversized = files.find(file => Number(file?.size || 0) > CONVERSATION_ATTACHMENT_MAX_BYTES);
    if (oversized) {
        if (notify) {
            warnConversationAttachment(`${oversized.name || 'Attachment'} is over ${formatConversationFileSize(CONVERSATION_ATTACHMENT_MAX_BYTES)}.`);
        }
        return null;
    }

    const blocked = files.find(file => !isConversationAttachmentAllowed(file));
    if (blocked) {
        if (notify) {
            warnConversationAttachment(`${blocked.name || 'Attachment'} is not a supported Conversation attachment type.`);
        }
        return null;
    }

    return files;
}

function updateConversationAttachmentPreview() {
    const preview = document.getElementById(CHROME_IDS.attachmentPreview);
    if (!(preview instanceof HTMLElement)) {
        return;
    }

    const files = getConversationPendingFiles();
    if (!files.length) {
        preview.hidden = true;
        preview.textContent = '';
        return;
    }

    const fileRows = files.slice(0, 4).map((file) => {
        const size = formatConversationFileSize(file.size);
        return `<span class="sb-conversation-attachment-pill"><i class="fa-solid fa-paperclip" aria-hidden="true"></i><span>${escapeHtmlText(file.name)}</span>${size ? `<small>${escapeHtmlText(size)}</small>` : ''}</span>`;
    });
    if (files.length > 4) {
        fileRows.push(`<span class="sb-conversation-attachment-pill">+${files.length - 4} more</span>`);
    }

    preview.innerHTML = `
        <div class="sb-conversation-attachment-list">${fileRows.join('')}</div>
        <button type="button" class="menu_button menu_button_icon" data-sb-conversation-action="clear-attachments" title="Clear attachments" aria-label="Clear attachments">
            <i class="fa-solid fa-xmark" aria-hidden="true"></i>
        </button>
    `;
    preview.hidden = false;
}

function clearConversationAttachmentInput() {
    const fileInput = document.getElementById(CHROME_IDS.fileInput);
    if (fileInput instanceof HTMLInputElement) {
        fileInput.value = '';
    }
    updateConversationAttachmentPreview();
}

async function populateConversationUserAttachments(messageInput) {
    const pendingFiles = getValidatedConversationPendingFiles();
    if (!pendingFiles?.length) {
        return;
    }

    const { populateFileAttachment } = await import('./chats.js');
    await populateFileAttachment(messageInput, CHROME_IDS.fileInput);
    if (getConversationMediaAttachments(messageInput).length) {
        messageInput.extra.media_display = MEDIA_DISPLAY.LIST;
        messageInput.extra.inline_image = true;
    }
}

async function buildConversationAttachmentPromptContext(messageInput, visibleText) {
    const summary = getConversationAttachmentSummary(messageInput);
    if (!summary) {
        return '';
    }

    const parts = [summary];
    if (getConversationFileAttachments(messageInput).length) {
        try {
            const { appendFileContent } = await import('./chats.js');
            const promptMessage = {
                ...messageInput,
                extra: { ...messageInput.extra },
            };
            const filePromptText = await appendFileContent(promptMessage, visibleText || '');
            const cleanPromptText = formatPromptText(filePromptText, 2800);
            const cleanVisibleText = formatPromptText(visibleText || '', 2800);
            if (cleanPromptText && cleanPromptText !== cleanVisibleText) {
                parts.push(`Attached file text: ${cleanPromptText}`);
            }
        } catch (error) {
            console.warn('Conversation Mode: could not read attachment text for prompt context', error);
        }
    }

    return parts.join('\n');
}

function focusConversationInput() {
    const input = document.getElementById(CHROME_IDS.input);
    if (input instanceof HTMLTextAreaElement && !input.disabled) {
        input.focus({ preventScroll: true });
    }
}

async function waitForAutoWorker() {
    const startTime = Date.now();

    while (autoWorkerBusy) {
        if (Date.now() - startTime >= AUTO_WORKER_WAIT_TIMEOUT_MS) {
            console.warn('Conversation Mode auto worker wait timed out; continuing queued reply.');
            break;
        }

        await new Promise(resolve => setTimeout(resolve, 200));
    }
}

async function processQueuedConversationReply(queueItem) {
    const avatar = queueItem?.avatar;
    if (!avatar || is_send_press) {
        return;
    }

    const groupId = queueItem?.groupId ?? getConversationGroupIdForAvatar(avatar);

    await waitForAutoWorker();

    const settings = getSettings(avatar);
    if (!settings.enabled) {
        return;
    }

    if (getConversationActivityContext(settings, avatar).status === 'offline') {
        return;
    }

    if (await handleAvailabilityAutoResponder(settings, avatar, { groupId })) {
        return;
    }

    const status = getConversationActivityContext(settings, avatar).status || 'online';
    if (status === 'idle' || status === 'dnd') {
        const initialDelayMs = status === 'idle'
            ? (Math.random() * 1.5 + 1.5) * 1000
            : (Math.random() * 3 + 3) * 1000;
        await new Promise(resolve => setTimeout(resolve, initialDelayMs));
    }

    conversationReplyBusy = true;
    generationActive = true;
    maybePostDelayedReplyNotice(avatar, settings, { groupId });
    refreshConversationInterface({ syncControls: false });

    try {
        const character = getCharacterForAvatar(avatar);
        const speakerName = character?.name || getCurrentCharName();
        const partnerChimePromise = getConversationPartnerAvatars(avatar, settings, { groupId, includeThreadPartners: true }).length
            ? checkMultiCharacterChime(avatar, settings, Date.now(), { groupId }).catch((error) => {
                console.error('Conversation partner chime error:', error);
                return false;
            })
            : Promise.resolve(false);
        const attachmentContext = formatPromptText(queueItem?.attachmentContext, 3200);
        const response = await generateConversationReply(
            [
                '[System directive: The user sent the latest DM. Reply directly to them in the Conversation Mode thread.]',
                attachmentContext ? `Latest user attachment context:\n${attachmentContext}` : '',
            ].filter(Boolean).join('\n\n'),
            settings,
            { avatar, speakerName, groupId },
        );
        if (response?.trim()) {
            await postCharacterReply(response.trim(), settings, {
                extra: {
                    conversation_mode_reply: true,
                },
                groupId,
            }, avatar);
        }

        const imageKeywords = /\b(send\s*pic|selfie|photo|image|picture|show\s*me)\b/i;
        const wantsImage = settings.image_gen_enabled
            && (settings.spontaneous_selfies || imageKeywords.test(queueItem.text || ''));
        if (wantsImage && getImageCooldownRemainingSeconds(avatar, settings, Date.now(), { groupId }) === 0) {
            const prompt = buildCharacterImagePrompt(
                settings.image_gen_prompt_template || DEFAULT_SETTINGS.image_gen_prompt_template,
                'the current DM conversation',
                avatar,
            );
            const imageUrl = await generateConversationImage(prompt, settings.image_gen_negative || '');
            if (imageUrl) {
                markImageGenerated(avatar, Date.now(), { groupId });
                await appendConversationMessage('Here, I can show you.', {
                    name: speakerName,
                    role: 'character',
                    extra: {
                        conversation_mode_image: true,
                        image_url: imageUrl,
                        image_prompt: prompt,
                    },
                    groupId,
                }, avatar);
            }
        }

        await partnerChimePromise;
    } catch (error) {
        reportConversationGenerationError('reply', error);
    } finally {
        conversationReplyBusy = false;
        generationActive = false;
        refreshConversationInterface({ syncControls: false });
    }
}

async function processSendQueue() {
    if (sendQueueProcessing) {
        return;
    }

    sendQueueProcessing = true;
    try {
        while (sendQueue.length) {
            const queueItem = sendQueue.shift();
            await processQueuedConversationReply(queueItem);
            if (sendQueue.length) {
                await new Promise(resolve => setTimeout(resolve, SEND_QUEUE_BATCH_MS));
            }
        }
    } finally {
        sendQueueProcessing = false;
        focusConversationInput();
    }

    if (sendQueue.length) {
        void processSendQueue();
    }
}

async function submitConversationInput() {
    if (is_send_press || conversationUploadActive) {
        return;
    }

    const input = document.getElementById(CHROME_IDS.input);
    if (!(input instanceof HTMLTextAreaElement)) {
        return;
    }

    const avatar = getCurrentCharAvatar();
    const settings = getSettings(avatar);
    const text = input.value.trim();
    const pendingFiles = getValidatedConversationPendingFiles({ notify: true });
    if (!pendingFiles) {
        return;
    }
    const groupId = getConversationGroupIdForAvatar(avatar);
    if (!avatar || !settings.enabled || (!text && !pendingFiles.length)) {
        return;
    }

    if (text.startsWith('/') && !pendingFiles.length) {
        const handled = await handleConversationSlashAction(text, { avatar, settings, groupId });
        if (handled) {
            input.value = '';
            input.dispatchEvent(new Event('input', { bubbles: true }));
            clearConversationAttachmentInput();
            return;
        }
    }

    conversationUploadActive = true;
    const sendButton = document.getElementById(CHROME_IDS.send);
    if (sendButton instanceof HTMLButtonElement) {
        sendButton.disabled = true;
    }

    try {
        const userName = name1 || 'You';
        const hasAttachments = pendingFiles.length > 0;
        const attachmentContextParts = [];

        if (hasAttachments) {
            const messageInput = {
                role: 'user',
                name: userName,
                mes: text,
                extra: {
                    conversation_mode_user: true,
                },
            };
            await populateConversationUserAttachments(messageInput);
            const attachmentContext = await buildConversationAttachmentPromptContext(messageInput, text);
            if (attachmentContext) {
                attachmentContextParts.push(attachmentContext);
            }
            if (!String(messageInput.mes || '').trim() && !getConversationMediaAttachments(messageInput).length && !getConversationFileAttachments(messageInput).length) {
                toastr.warning('No attachments were added. Try a different file.');
                return;
            }

            appendConversationThreadMessage(avatar, messageInput, { groupId });
        } else {
            for (const messageText of splitChatroomMessages(text)) {
                appendConversationThreadMessage(avatar, {
                    role: 'user',
                    name: userName,
                    mes: messageText,
                    extra: {
                        conversation_mode_user: true,
                    },
                }, { groupId });
            }
        }

        input.value = '';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        clearConversationAttachmentInput();
        updateLastUserActivity(avatar, { groupId });
        refreshConversationInterface({ syncControls: false });

        const queuedText = text || attachmentContextParts.join('\n') || 'Sent an attachment.';
        sendQueue.push({
            avatar,
            groupId,
            text: queuedText,
            attachmentContext: attachmentContextParts.join('\n'),
            createdAt: Date.now(),
        });
        void processSendQueue();
    } finally {
        conversationUploadActive = false;
        if (sendButton instanceof HTMLButtonElement) {
            sendButton.disabled = false;
        }
    }
}

async function appendConversationMessage(messageText, { name = getCurrentCharName(), role = 'character', extra = {}, groupId = undefined } = {}, avatar = getCurrentCharAvatar()) {
    if (!avatar) {
        return null;
    }

    const resolvedGroupId = groupId !== undefined ? groupId : getConversationGroupIdForAvatar(avatar);
    const message = appendConversationThreadMessage(avatar, {
        role,
        name,
        mes: messageText,
        extra,
    }, { groupId: resolvedGroupId });
    const shouldNotify = !['user', 'system'].includes(role) && !isConversationActiveThread(avatar, resolvedGroupId);
    if (shouldNotify) {
        incrementUnreadCount(avatar, { groupId: resolvedGroupId });
    }
    if (!['user', 'system'].includes(role)) {
        markConversationSeen(avatar, Date.now(), { groupId: resolvedGroupId });
    }

    if (isConversationActiveThread(avatar, resolvedGroupId)) {
        refreshConversationInterface({ syncControls: false });
    } else if (conversationWorkspaceOpen) {
        renderPalsRail();
    }

    notifyNewConversationMessage(avatar, message, shouldNotify, { groupId: resolvedGroupId });
    scheduleConversationMemorySummary(avatar, { groupId: resolvedGroupId });

    return message;
}

function buildAutoMessageDirective(directive) {
    return directive;
}

async function maybeGenerateSpontaneousImage(settings, avatar = getCurrentCharAvatar(), { groupId = getConversationGroupIdForAvatar(avatar) } = {}) {
    if (!settings.image_gen_enabled || !settings.spontaneous_selfies || getImageCooldownRemainingSeconds(avatar, settings, Date.now(), { groupId }) > 0) {
        return;
    }

    const character = getCharacterForAvatar(avatar);
    const charName = character?.name || getCurrentCharName();
    const prompt = buildCharacterImagePrompt(
        settings.selfie_prompt || settings.image_gen_prompt_template || DEFAULT_SETTINGS.image_gen_prompt_template,
        'a spontaneous selfie in the current DM conversation',
        avatar,
    );
    const imageUrl = await generateConversationImage(prompt, settings.image_gen_negative || '');
    if (imageUrl) {
        markImageGenerated(avatar, Date.now(), { groupId });
        await appendConversationMessage('Snapped something for you.', {
            name: charName,
            role: 'character',
            extra: {
                conversation_mode_image: true,
                image_url: imageUrl,
                image_prompt: prompt,
            },
            groupId,
        }, avatar);
    }
}

async function triggerAutoMessage(directive, settings, extra = {}, avatar = getCurrentCharAvatar()) {
    const character = getCharacterForAvatar(avatar);
    if (autoWorkerBusy || conversationReplyBusy || is_send_press || !character || !avatar) {
        return false;
    }

    const groupId = extra.groupId || getConversationGroupIdForAvatar(avatar);

    autoWorkerBusy = true;

    try {
        const quietPrompt = buildAutoMessageDirective(directive);
        const response = await generateConversationReply(quietPrompt, settings, {
            speakerName: character.name || 'Character',
            avatar,
            threadAvatar: avatar,
            groupId,
        });

        if (response?.trim()) {
            await withTypingParticipant(character, () => postCharacterReply(response.trim(), settings, {
                extra: {
                    conversation_mode_auto: true,
                    ...extra,
                },
                groupId,
            }, avatar), avatar);
            await maybeGenerateSpontaneousImage(settings, avatar, { groupId });
            return true;
        }
    } catch (error) {
        reportConversationGenerationError('auto-message', error, { level: 'warning' });
    } finally {
        autoWorkerBusy = false;
    }

    return false;
}

function getCurrentMinuteKey(date = new Date()) {
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    return `${hours}:${minutes}`;
}

function getCurrentDayKey(date = new Date()) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

function getLastAutoMessageTime(avatar, { groupId = getConversationGroupIdForAvatar(avatar) } = {}) {
    return parsePositiveInt(getActiveConversationBranch(avatar, { create: false, groupId })?.lastAutoMessageAt, 0, 0);
}

function setLastAutoMessageTime(avatar, timestamp = Date.now(), { groupId = getConversationGroupIdForAvatar(avatar) } = {}) {
    const branch = getActiveConversationBranch(avatar, { groupId });
    if (branch) {
        branch.lastAutoMessageAt = timestamp;
        persistConversationStore();
    }
}

function getScheduleTriggerState(avatar) {
    const state = getActiveConversationBranch(avatar, { create: false })?.scheduleTriggers;
    return state && typeof state === 'object' ? state : {};
}

function setScheduleTriggered(avatar, triggerKey, timestamp) {
    const state = getScheduleTriggerState(avatar);
    state[triggerKey] = timestamp;

    const stateEntries = Object.entries(state).sort((first, second) => first[1] - second[1]);
    while (stateEntries.length > 100) {
        const [oldestKey] = stateEntries.shift();
        delete state[oldestKey];
    }

    const branch = getActiveConversationBranch(avatar);
    if (branch) {
        branch.scheduleTriggers = state;
        persistConversationStore();
    }
}

function hasScheduleTriggered(avatar, triggerKey) {
    return Object.prototype.hasOwnProperty.call(getScheduleTriggerState(avatar), triggerKey);
}

async function checkScheduledAutoMessages(avatar, settings, now) {
    if (!settings.auto_message) {
        return false;
    }

    const hasLegacy = Boolean(settings.ai_schedule);
    const weeklyEntries = safeParseWeeklySchedule(settings.weekly_schedule);
    if (!hasLegacy && !weeklyEntries.length) {
        return false;
    }

    const currentDate = new Date(now);
    const currentMinute = getCurrentMinuteKey(currentDate);
    const currentDay = getCurrentDayKey(currentDate);
    const currentDayOfWeek = currentDate.getDay(); // 0=Sun..6=Sat

    // Weekly scheduler entries (item 3)
    for (const entry of weeklyEntries) {
        if (entry.enabled === false) {
            continue;
        }
        if (!Array.isArray(entry.days) || !entry.days.includes(currentDayOfWeek)) {
            continue;
        }
        if (!entry.time || entry.time !== currentMinute) {
            continue;
        }

        const triggerKey = `weekly:${currentDay}:${entry.time}:${entry.message}`;
        if (hasScheduleTriggered(avatar, triggerKey)) {
            continue;
        }

        const triggered = await triggerAutoMessage(
            `[System directive: Your weekly schedule is due: "${entry.message}". Send a message with this context in mind.]`,
            settings,
            { schedule: `weekly:${entry.time}` },
            avatar,
        );
        if (triggered) {
            setScheduleTriggered(avatar, triggerKey, now);
            setLastAutoMessageTime(avatar, now);
        }

        return triggered;
    }

    // Legacy HH:MM and relative-minute schedule lines
    if (!hasLegacy) {
        return false;
    }

    for (const line of settings.ai_schedule.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) {
            continue;
        }

        const absoluteMatch = trimmed.match(/^(\d{2}):(\d{2})\s*-\s*(.*)$/);
        if (absoluteMatch && `${absoluteMatch[1]}:${absoluteMatch[2]}` === currentMinute) {
            const triggerKey = `absolute:${currentDay}:${currentMinute}:${trimmed}`;
            if (hasScheduleTriggered(avatar, triggerKey)) {
                continue;
            }

            const triggered = await triggerAutoMessage(`[System directive: Your schedule is due: "${absoluteMatch[3]}". Send a message with this context in mind.]`, settings, { schedule: trimmed }, avatar);
            if (triggered) {
                setScheduleTriggered(avatar, triggerKey, now);
                setLastAutoMessageTime(avatar, now);
            }

            return triggered;
        }

        const relativeMatch = trimmed.match(/^(\d+)\s*-\s*(.*)$/);
        if (relativeMatch) {
            const delayMinutes = parsePositiveInt(relativeMatch[1], 0, 0);
            const lastUserActivity = getLastUserActivity(avatar, now);
            const elapsedMinutes = (now - lastUserActivity) / (60 * 1000);

            if (delayMinutes > 0 && elapsedMinutes >= delayMinutes) {
                const triggerKey = `relative:${lastUserActivity}:${trimmed}`;
                if (hasScheduleTriggered(avatar, triggerKey)) {
                    continue;
                }

                const triggered = await triggerAutoMessage(`[System directive: You are sending a check-in due to ${delayMinutes} minutes of silence: "${relativeMatch[2]}".]`, settings, { schedule: trimmed }, avatar);
                if (triggered) {
                    setScheduleTriggered(avatar, triggerKey, now);
                    setLastAutoMessageTime(avatar, now);
                }

                return triggered;
            }
        }
    }

    return false;
}

async function checkIdleAutoMessage(avatar, settings, now) {
    const followupEnabled = Boolean(settings.idle_followup);
    const spontaneousEnabled = Boolean(settings.idle_spontaneous);
    if (!followupEnabled && !spontaneousEnabled) {
        return false;
    }

    const lastUserActivity = getLastUserActivity(avatar, now);
    const idleMinutes = (now - lastUserActivity) / (60 * 1000);

    if (idleMinutes < settings.idle_limit) {
        return false;
    }

    const followupSessionKey = `${LAST_IDLE_SESSION_PREFIX}followup`;
    if (followupEnabled && getConversationSessionMarker(avatar, followupSessionKey) !== String(lastUserActivity)) {
        const triggered = await triggerAutoMessage(
            '[System directive: The user has been quiet for a while. Send a casual auto follow-up checking in or asking what they are up to.]',
            settings,
            { idle_action: 'followup' },
            avatar,
        );
        if (triggered) {
            setConversationSessionMarker(avatar, followupSessionKey, lastUserActivity);
            setLastAutoMessageTime(avatar, now);
        }
        return triggered;
    }

    const spontaneousIdleLimit = followupEnabled ? settings.idle_limit * 2 : settings.idle_limit;
    if (!spontaneousEnabled || idleMinutes < spontaneousIdleLimit) {
        return false;
    }

    const spontaneousSessionKey = `${LAST_IDLE_SESSION_PREFIX}spontaneous`;
    if (getConversationSessionMarker(avatar, spontaneousSessionKey) === String(lastUserActivity)) {
        return false;
    }

    const triggered = await triggerAutoMessage(
        '[System directive: Send a spontaneous ping to the user, starting a new topic or sharing a casual thought.]',
        settings,
        { idle_action: 'spontaneous' },
        avatar,
    );
    if (triggered) {
        setConversationSessionMarker(avatar, spontaneousSessionKey, lastUserActivity);
        setLastAutoMessageTime(avatar, now);
    }

    return triggered;
}

function buildProactiveDirective(activity, status, now = new Date()) {
    const hour = now.getHours();
    let timeOfDay = 'evening';
    if (hour < 5) {
        timeOfDay = 'late night';
    } else if (hour < 12) {
        timeOfDay = 'morning';
    } else if (hour < 17) {
        timeOfDay = 'afternoon';
    } else if (hour < 21) {
        timeOfDay = 'evening';
    } else {
        timeOfDay = 'night';
    }

    const statusNote = status === 'dnd'
        ? 'You are busy and only have a brief moment.'
        : status === 'idle'
            ? 'You have a spare moment between things.'
            : 'You are free and feel like reaching out.';

    return `[System directive: It is ${timeOfDay} and you are currently ${activity} (status: ${status}). ${statusNote} The user has not replied in a while. Reach out to them yourself with a short, natural direct message. Reference your current activity or the time of day if it feels right. Do not wait for them to speak first.]`;
}

async function checkProactiveMessaging(avatar, settings, now) {
    if (!settings.proactive_messaging) {
        return false;
    }

    // The user being on Do Not Disturb fully suppresses proactive messaging.
    if (getUserStatus() === 'dnd') {
        return false;
    }

    const schedule = getStoredSchedule(avatar);
    const current = getCurrentActivityFromSchedule(schedule, avatar, new Date(now));

    // The character never initiates while offline.
    if (current.status === 'offline') {
        return false;
    }

    const thread = getConversationThread(avatar);
    const lastMessage = thread[thread.length - 1];
    const lastUserActivity = getLastUserActivity(avatar, now);
    const idleMinutes = (now - lastUserActivity) / (60 * 1000);
    const maxFollowups = clamp(parsePositiveInt(settings.max_followups, DEFAULT_MAX_FOLLOWUPS, 1), 1, 3);
    const sentCount = getFollowupCount(avatar);

    // Catch-up: the user messaged while the character was unavailable and it is
    // now back online. Respond regardless of the inactivity threshold.
    const isCatchUp = Boolean(lastMessage) && lastMessage.role === 'user' && sentCount === 0;

    if (!isCatchUp) {
        if (sentCount >= maxFollowups) {
            return false;
        }

        let thresholdMinutes = clamp(
            parsePositiveInt(settings.inactivity_threshold, DEFAULT_INACTIVITY_THRESHOLD, MIN_INACTIVITY_THRESHOLD),
            MIN_INACTIVITY_THRESHOLD,
            MAX_INACTIVITY_THRESHOLD,
        );

        // Busy characters wait three times as long before reaching out.
        if (current.status === 'dnd') {
            thresholdMinutes *= 3;
        }

        if (sentCount === 0) {
            // First proactive message is measured from the user's last activity.
            if (idleMinutes < thresholdMinutes) {
                return false;
            }
        } else {
            // Follow-ups use an escalating cooldown measured from the last auto message.
            const elapsedSinceAuto = (now - getLastAutoMessageTime(avatar)) / (60 * 1000);
            const followupThreshold = thresholdMinutes * Math.pow(2, sentCount);
            if (elapsedSinceAuto < followupThreshold) {
                return false;
            }
        }
    }

    const directive = buildProactiveDirective(current.activity, current.status, new Date(now));
    const triggered = await triggerAutoMessage(directive, settings, {
        proactive: true,
        proactive_status: current.status,
    }, avatar);

    if (triggered) {
        setFollowupCount(avatar, sentCount + 1);
        setLastAutoMessageTime(avatar, now);
    }

    return triggered;
}

function getPartnerReplyBusyKey(avatar, partnerAvatar, scope) {
    return `${avatar || 'thread'}:${partnerAvatar || 'partner'}:${scope || 'reply'}`;
}

function getConversationPartnerChimeCandidates(avatar, selectedAvatars, { max = PARALLEL_CHIME_MAX_PARTNERS, groupId = getConversationGroupIdForAvatar(avatar), settings = getSettings(avatar) } = {}) {
    const partners = getAllowedPartnerCharacters(selectedAvatars, avatar, settings, { groupId, includeThreadPartners: true });
    const candidates = [];
    const addCandidate = (partner) => {
        if (partner?.avatar && !candidates.some(candidate => candidate.avatar === partner.avatar)) {
            candidates.push(partner);
        }
    };

    addCandidate(getRecentlySilentMentionedPartner(avatar, selectedAvatars, settings, { groupId }));
    addCandidate(getLeastRecentPartner(avatar, selectedAvatars, settings, { groupId }));

    const shuffled = [...partners].sort(() => Math.random() - 0.5);
    for (const partner of shuffled) {
        if (candidates.length >= max) {
            break;
        }
        addCandidate(partner);
    }

    return candidates.slice(0, max);
}

async function triggerConversationPartnerChime(partner, settings, avatar = getCurrentCharAvatar(), { groupId = getConversationGroupIdForAvatar(avatar) } = {}) {
    if (!partner?.avatar || !avatar) {
        return false;
    }

    const busyKey = getPartnerReplyBusyKey(avatar, partner.avatar, `chime:${groupId || 'solo'}`);
    if (partnerReplyBusyKeys.has(busyKey)) {
        return false;
    }

    partnerReplyBusyKeys.add(busyKey);
    try {
        const partnerName = partner.name || 'A friend';
        const partnerSettings = getConversationPartnerSettings(partner.avatar, settings);
        const partnerContext = getConversationActivityContext(partnerSettings, partner.avatar);
        const character = getCharacterForAvatar(avatar);
        const charName = character?.name || getCurrentCharName();
        const userName = name1 || 'User';
        const directive = `[System directive: You are ${partnerName}, chiming in on a private group DM conversation between ${charName} and ${userName}. You are currently ${partnerContext.activity} (status: ${partnerContext.status}). If you were mentioned recently, answer naturally. Otherwise add one short message only if you have something distinct to contribute. Other people may be typing at the same time; do not wait for them. Output only your message body, without a name prefix.]`;
        const response = await generateConversationReply(directive, partnerSettings, {
            trimNames: false,
            speakerName: partnerName,
            avatar,
            threadAvatar: avatar,
            speakerAvatar: partner.avatar,
            groupId,
        });

        if (response?.trim()) {
            await postPartnerConversationReply(response.trim(), partner, partnerSettings, {
                avatar,
                extra: {
                    conversation_mode_chime: true,
                    partner_avatar: partner.avatar,
                },
                groupId,
            });
            return true;
        }
    } catch (error) {
        reportConversationGenerationError('partner chime', error, { toast: false });
    } finally {
        partnerReplyBusyKeys.delete(busyKey);
    }

    return false;
}

async function triggerMultiCharacterChime(settings, avatar = getCurrentCharAvatar(), { groupId = getConversationGroupIdForAvatar(avatar) } = {}) {
    const partners = getConversationPartnerChimeCandidates(avatar, settings.multi_char_names, { groupId, settings });
    if (!partners.length) {
        return false;
    }

    const results = await Promise.allSettled(partners.map(partner => triggerConversationPartnerChime(partner, settings, avatar, { groupId })));
    return results.some(result => result.status === 'fulfilled' && result.value === true);
}

async function checkMultiCharacterChime(avatar, settings, now, { groupId = getConversationGroupIdForAvatar(avatar) } = {}) {
    const mentionedPartner = getRecentlySilentMentionedPartner(avatar, settings.multi_char_names, settings, { groupId });
    if (!settings.multi_char && !mentionedPartner) {
        return false;
    }

    const lastUserActivity = getLastUserActivity(avatar, now, { groupId });
    const idleMinutes = (now - lastUserActivity) / (60 * 1000);

    if (!mentionedPartner && idleMinutes < Math.max(0.75, settings.idle_limit / 4)) {
        return false;
    }

    const sessionKey = LAST_CHIME_SESSION_PREFIX;
    if (getConversationSessionMarker(avatar, sessionKey, { groupId }) === String(lastUserActivity)) {
        return false;
    }

    const triggered = !settings.multi_char && mentionedPartner
        ? await triggerConversationPartnerChime(mentionedPartner, settings, avatar, { groupId })
        : await triggerMultiCharacterChime(settings, avatar, { groupId });
    if (triggered) {
        setConversationSessionMarker(avatar, sessionKey, lastUserActivity, { groupId });
        setLastAutoMessageTime(avatar, now, { groupId });
    }

    return triggered;
}

async function triggerAutoCharacterChat(avatar, settings, { groupId = getConversationGroupIdForAvatar(avatar) } = {}) {
    const partner = getLeastRecentPartner(avatar, settings.multi_char_names, settings, { groupId })
        || chooseConversationPartner(avatar, settings.multi_char_names, settings, { groupId });
    if (!partner) {
        return false;
    }

    const busyKey = getPartnerReplyBusyKey(avatar, partner.avatar, `auto-chat:${groupId || 'solo'}`);
    if (partnerReplyBusyKeys.has(busyKey)) {
        return false;
    }

    partnerReplyBusyKeys.add(busyKey);
    try {
        const partnerName = partner.name || 'A friend';
        const partnerSettings = getConversationPartnerSettings(partner.avatar, settings);
        const partnerContext = getConversationActivityContext(partnerSettings, partner.avatar);
        if (partnerContext.status === 'offline') {
            return false;
        }

        const character = getCharacterForAvatar(avatar);
        const charName = character?.name || getCurrentCharName();
        const otherMembers = [character, ...getAllowedPartnerCharacters(settings.multi_char_names, avatar, settings, { groupId })]
            .filter(member => member?.avatar && member.avatar !== partner.avatar);
        const target = otherMembers.length ? otherMembers[Math.floor(Math.random() * otherMembers.length)] : character;
        const targetName = target?.name || charName;
        const directive = `[System directive: You are ${partnerName}, speaking autonomously in a private group DM. Aim this message at ${targetName}, not the user, unless the user is directly relevant. You are currently ${partnerContext.activity} (status: ${partnerContext.status}). This is character-to-character ambient chat, so continue the casual conversation or start a friendly new topic with one short, natural message. Other people may reply later. Output only your message body, without a name prefix.]`;
        const response = await generateConversationReply(directive, partnerSettings, {
            trimNames: false,
            speakerName: partnerName,
            avatar,
            threadAvatar: avatar,
            speakerAvatar: partner.avatar,
            groupId,
        });

        if (response?.trim()) {
            await postPartnerConversationReply(response.trim(), partner, partnerSettings, {
                avatar,
                extra: { conversation_mode_auto_chat: true, partner_avatar: partner.avatar },
                groupId,
            });
            return true;
        }
    } catch (error) {
        reportConversationGenerationError('character-to-character chat', error, { toast: false });
    } finally {
        partnerReplyBusyKeys.delete(busyKey);
    }

    return false;
}

async function checkAutoCharacterChat(avatar, settings, now, { groupId = getConversationGroupIdForAvatar(avatar) } = {}) {
    if (!settings.auto_character_chat) {
        return false;
    }

    const lastAutoChatAt = getLastAutoCharacterChatTime(avatar, { groupId });
    const cooldownBaseline = lastAutoChatAt || getConversationBranchActivityTime(avatar, { groupId });
    if (now - cooldownBaseline < getAutoCharacterChatCooldownMs(settings)) {
        return false;
    }

    const triggered = await triggerAutoCharacterChat(avatar, settings, { groupId });
    if (triggered) {
        setLastAutoCharacterChatTime(avatar, now, { groupId });
        setLastAutoMessageTime(avatar, now, { groupId });
    }

    return triggered;
}

async function checkGroupChatMention(messageId) {
    if (!selected_group) {
        return;
    }

    const message = chat[messageId];
    if (!message || message.role !== 'user' || !message.mes) {
        return;
    }

    const members = getCurrentGroupConversationMembers({ requireRoleplayReactions: true });
    const memberCharacters = members.map(item => item.character).filter(Boolean);
    const mentionedMembers = members.filter(({ character }) => isCharacterMentionedInText(character, message.mes, memberCharacters));
    if (!mentionedMembers.length) {
        return;
    }

    setTimeout(() => {
        for (const { character } of mentionedMembers) {
            void triggerGroupAsideDM(character, { reason: 'mention', sourceMessageId: messageId });
        }
    }, 900);
}

async function triggerGroupAsideDM(character, { reason = 'random', sourceMessageId = null } = {}) {
    const group = getSelectedConversationGroup();
    if (!group || !character?.avatar || !group.members?.includes(character.avatar) || group.disabled_members?.includes(character.avatar)) {
        return false;
    }

    const settings = getSettings(character.avatar);
    if (!settings.enabled || !settings.roleplay_reactions) {
        return false;
    }

    const current = getConversationActivityContext(settings, character.avatar);
    if (current.status === 'offline') {
        return false;
    }

    const key = getGroupAsideKey(character.avatar, group.id);
    if (groupAsideBusyKeys.has(key)) {
        return false;
    }

    const now = Date.now();
    const cooldown = reason === 'mention' ? GROUP_ASIDE_MENTION_COOLDOWN_MS : GROUP_ASIDE_COOLDOWN_MS;
    if (now - (groupAsideLastSent.get(key) || 0) < cooldown) {
        return false;
    }

    const groupContext = buildGroupChatContext();
    if (!groupContext) {
        return false;
    }

    groupAsideBusyKeys.add(key);
    try {
        const userName = name1 || 'User';
        const characterName = character.name || 'Character';
        const reasonLine = reason === 'mention'
            ? `${userName} just mentioned or addressed you in the group chat. Send them a private aside DM about it.`
            : 'Send a private aside DM while the group chat is ongoing. React to the group if there is something worth reacting to; otherwise start a natural casual DM topic.';
        const directive = `[System directive: You are ${characterName}, currently present in the active group chat. ${reasonLine} This message goes only to ${userName} in Conversation Mode, not into the group chat. Keep it short, casual, in-character, and suitable as one or two chat bubbles. Output only your DM body, without a name prefix.\n\nRecent group chat context:\n${groupContext}]`;
        const response = await generateConversationReply(directive, settings, {
            speakerName: characterName,
            trimNames: false,
            avatar: character.avatar,
        });

        if (response?.trim()) {
            const extra = {
                conversation_mode_group_aside: true,
                conversation_mode_gossip: true,
                gossip_source_group: true,
                group_aside_reason: reason,
                source_group_id: group.id,
            };
            if (sourceMessageId !== null && typeof sourceMessageId !== 'undefined') {
                extra.source_group_message_id = sourceMessageId;
            }

            await withTypingParticipant(character, () => postCharacterReply(response.trim(), settings, { extra }, character.avatar), character.avatar);
            groupAsideLastSent.set(key, Date.now());
            return true;
        }
    } catch (err) {
        reportConversationGenerationError('group aside DM', err, { toast: false });
    } finally {
        groupAsideBusyKeys.delete(key);
    }

    return false;
}

async function triggerRoleplayDM() {
    const character = getCurrentCharacter();
    const avatar = getCurrentCharAvatar();
    if (!character || !avatar) return;

    const settings = getSettings(avatar);
    const sheld = document.getElementById('sheld');
    if (!settings.enabled || (sheld instanceof HTMLElement && sheld.dataset.sbConversationMode === 'on')) {
        return;
    }

    const snippet = [];
    const startIdx = Math.max(0, chat.length - 6);
    for (let i = startIdx; i < chat.length; i++) {
        const msg = chat[i];
        if (msg && msg.mes) {
            snippet.push(`${msg.name || (msg.is_user ? 'User' : 'Character')}: ${msg.mes}`);
        }
    }

    if (!snippet.length) return;

    const chatText = snippet.join('\n');
    const directive = `[System directive: You are sending a private direct message (DM) to {{user}} to comment on the ongoing roleplay/story scene. Step out of the main scene and send a short, private, personal DM sharing your inner thoughts, a side-comment, or a private reaction to what just happened. Keep it short, casual, and completely in-character. Do not continue the roleplay scene; write a private side-message.\n\nRoleplay context:\n${chatText}]`;

    try {
        console.log(`Generating private roleplay DM from ${character.name}...`);
        const response = await generateConversationReply(directive, settings, {
            speakerName: character.name || 'Character',
            trimNames: true,
            avatar,
        });

        if (response?.trim()) {
            await postCharacterReply(response.trim(), settings, {
                extra: { conversation_mode_gossip: true, gossip_source_roleplay: true },
            }, avatar);
        }
    } catch (err) {
        reportConversationGenerationError('roleplay side DM', err, { toast: false });
    }
}

async function checkConversationReminders(now) {
    const store = getConversationStore();
    if (!Array.isArray(store.reminders) || !store.reminders.length) {
        return false;
    }

    const dueReminders = store.reminders.filter(rem => {
        const retryAfter = parsePositiveInt(rem.retryAfter, 0, 0);
        return now >= rem.triggerAt && !rem.fired && (!retryAfter || now >= retryAfter);
    });
    if (!dueReminders.length) {
        return false;
    }

    const reminder = dueReminders[0];
    const avatar = reminder.avatar;
    const settings = getSettings(avatar);

    if (!settings.enabled) {
        reminder.fired = true;
        reminder.skippedAt = now;
        persistConversationStore();
        return false;
    }

    console.log('Conversation Mode: triggering reminder auto-reply', reminder);

    const deferReminderRetry = () => {
        reminder.lastAttemptAt = now;
        reminder.retryAfter = now + REMINDER_RETRY_DELAY_MS;
        persistConversationStore();
    };

    try {
        const directive = `[System directive: This is a scheduled reminder. Send a DM to the user reminding them about: "${reminder.text}". Do not mention system/bracketed code, just say it naturally in-character as a DM ping.]`;

        const triggered = await triggerAutoMessage(directive, settings, {
            conversation_mode_reminder: true,
            reminder_text: reminder.text,
            reminder_id: reminder.id,
            partner_avatar: reminder.groupId ? avatar : undefined,
            groupId: reminder.groupId || undefined,
        }, avatar);

        if (triggered) {
            reminder.fired = true;
            reminder.firedAt = Date.now();
            delete reminder.retryAfter;
            persistConversationStore();
            return true;
        }

        deferReminderRetry();
        return false;
    } catch (error) {
        reportConversationGenerationError('reminder', error, { level: 'warning' });
        deferReminderRetry();
        return false;
    }
}

async function conversationModeAutoMessageWorker() {
    if (getUserStatus() === 'offline') {
        return;
    }

    if (autoWorkerBusy || conversationReplyBusy || sendQueueProcessing || sendQueue.length || is_send_press) {
        return;
    }

    const now = Date.now();

    if (await checkConversationReminders(now)) {
        return;
    }

    for (const { character, settings } of getConversationPals()) {
        const avatar = character.avatar;
        const elapsedSeconds = (now - getLastAutoMessageTime(avatar)) / 1000;
        if (elapsedSeconds < settings.cooldown) {
            continue;
        }

        if (await checkScheduledAutoMessages(avatar, settings, now)) {
            return;
        }

        // Marinara-style proactive loop takes priority over legacy idle action.
        if (settings.proactive_messaging) {
            if (await checkProactiveMessaging(avatar, settings, now)) {
                return;
            }
        } else if (await checkIdleAutoMessage(avatar, settings, now)) {
            return;
        }

        if (await checkMultiCharacterChime(avatar, settings, now)) {
            return;
        }

        if (await checkAutoCharacterChat(avatar, settings, now)) {
            return;
        }
    }
}

async function handleAvailabilityAutoResponder(settings = getSettings(), avatar = getCurrentCharAvatar(), { groupId = getConversationGroupIdForAvatar(avatar) } = {}) {
    if (!avatar) {
        return false;
    }

    if (!settings.enabled || !['offline', 'dnd'].includes(settings.availability)) {
        return false;
    }

    const character = getCharacterForAvatar(avatar);
    const charName = character?.name || getCurrentCharName();
    const offlineText = (settings.offline_message || DEFAULT_SETTINGS.offline_message).replace('{{char}}', charName);
    await appendConversationMessage(offlineText, {
        extra: {
            conversation_mode_auto_responder: true,
            availability: settings.availability,
        },
        groupId,
    }, avatar);
    return true;
}

function handleChatChanged() {
    loadCurrentPanelSettings();
}

function init() {
    if (initialized) {
        return;
    }

    initialized = true;
    migrateConversationLocalStorage();
    eventSource.on(event_types.USER_MESSAGE_RENDERED, (messageId) => {
        refreshConversationInterface({ syncControls: false });
        if (selected_group) {
            checkGroupChatMention(messageId);
        }
    });
    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, (messageId) => {
        refreshConversationInterface({ syncControls: false });

        // Occasional private asides keep Conversation Mode feeling connected
        // without forcing a public group-chat reply.
        const roll = Math.random();
        if (roll < GROUP_ASIDE_RANDOM_CHANCE) {
            if (selected_group) {
                const members = getCurrentGroupConversationMembers({ requireRoleplayReactions: true });
                const speaker = getCharacterForGroupChatMessage(chat[messageId]);
                const speakerMember = speaker?.avatar ? members.find(item => item.character?.avatar === speaker.avatar) : null;
                const chosenMember = speakerMember && Math.random() < 0.65
                    ? speakerMember
                    : members[Math.floor(Math.random() * members.length)];
                if (chosenMember?.character) {
                    const reason = speakerMember?.character?.avatar === chosenMember.character.avatar ? 'reaction' : 'random';
                    setTimeout(() => void triggerGroupAsideDM(chosenMember.character, { reason, sourceMessageId: messageId }), 2000);
                }
            } else if (getSettings(getCurrentCharAvatar()).roleplay_reactions) {
                setTimeout(() => void triggerRoleplayDM(), 2000);
            }
        }
    });
    eventSource.on(event_types.GENERATION_STARTED, (_type, _params, isDryRun) => {
        if (isDryRun) {
            return;
        }

        generationActive = true;
        refreshConversationInterface({ syncControls: false });
    });
    eventSource.on(event_types.GENERATION_ENDED, () => {
        generationActive = false;
        refreshConversationInterface({ syncControls: false });
    });
    eventSource.on(event_types.GENERATION_STOPPED, () => {
        generationActive = false;
        refreshConversationInterface({ syncControls: false });
    });
    eventSource.on(event_types.CHAT_CHANGED, handleChatChanged);
    eventSource.on(event_types.CHAT_LOADED, handleChatChanged);

    window.addEventListener('sb:open-conversation-workspace', (event) => {
        const detail = event instanceof CustomEvent ? event.detail : null;
        const avatar = detail?.avatar || getDefaultConversationAvatar();
        const groupId = detail?.groupId || (selected_group && avatar && isAvatarInConversationGroup(avatar, selected_group) ? String(selected_group) : null);
        openConversationWorkspaceForAvatar(avatar, { groupId, showToast: detail?.showToast !== false });
    });
    window.addEventListener('sb:close-conversation-workspace', () => disableConversationModeForCurrentCharacter({ focusRoleplay: false }));

    const existingAutoWorkerIntervalId = globalThis[AUTO_WORKER_INTERVAL_GLOBAL_KEY];
    if (existingAutoWorkerIntervalId) {
        window.clearInterval(existingAutoWorkerIntervalId);
    }

    autoWorkerIntervalId = window.setInterval(() => void conversationModeAutoMessageWorker(), AUTO_WORKER_INTERVAL_MS);
    globalThis[AUTO_WORKER_INTERVAL_GLOBAL_KEY] = autoWorkerIntervalId;
    loadCurrentPanelSettings();
    updateConversationNotificationIndicators();
}

eventSource.on(event_types.APP_READY, init);
