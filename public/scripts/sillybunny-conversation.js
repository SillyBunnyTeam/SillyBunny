import { getMessageTimeStamp } from './RossAscends-mods.js';
import { eventSource, event_types } from './events.js';
import { selected_group } from './group-chats.js';
import { world_names } from './world-info.js';
import { power_user } from './power-user.js';
import { user_avatar, setUserAvatar } from './personas.js';
import { executeSlashCommandsWithOptions } from './slash-commands.js';
import { characters, chat, default_user_avatar, generateRaw, getThumbnailUrl, is_send_press, messageFormatting, name1, selectCharacterById, this_chid } from '../script.js';

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
const USER_STATUS_STORAGE_KEY = 'sb_conv_user_status';

const SETTINGS_KEY_PREFIX = 'sb_conv_settings_';
const THREAD_KEY_PREFIX = 'sb_conv_thread_';
const LAST_USER_ACTIVITY_PREFIX = 'sb_conv_last_user_activity_';
const LAST_AUTO_MESSAGE_PREFIX = 'sb_conv_last_auto_msg_';
const LAST_SCHEDULE_TRIGGER_PREFIX = 'sb_conv_last_trigger_';
const LAST_IDLE_SESSION_PREFIX = 'sb_conv_last_idle_session_';
const LAST_CHIME_SESSION_PREFIX = 'sb_conv_last_chime_session_';
const LAST_PREVIEW_PREFIX = 'sb_conv_last_preview_';
const UNREAD_PREFIX = 'sb_conv_unread_';
const LAST_AUTO_CHAT_SESSION_PREFIX = 'sb_conv_last_autochat_session_';
const SCHEDULE_PREFIX = 'sb_conv_schedule_';
const FOLLOWUP_COUNT_PREFIX = 'sb_conv_followup_count_';
const AUTO_WORKER_INTERVAL_MS = 30000;
const MAX_THREAD_MESSAGES = 250;
const TRANSCRIPT_MESSAGE_LIMIT = 32;
const SCHEDULE_STATUSES = Object.freeze(['online', 'idle', 'dnd', 'offline']);
const DEFAULT_INACTIVITY_THRESHOLD = 120;
const MIN_INACTIVITY_THRESHOLD = 15;
const MAX_INACTIVITY_THRESHOLD = 360;
const DEFAULT_TALKATIVENESS = 50;
const DEFAULT_MAX_FOLLOWUPS = 3;
const SELFIE_COMMAND_RE = /\[selfie(?::\s*(?:context=)?"?([^"\]]*)"?)?\]/gi;
const SCHEDULE_UPDATE_RE = /\[schedule_update:\s*([^\]]+)\]/gi;
const CHROME_IDS = Object.freeze({
    header: 'sb_conversation_header',
    palsToggle: 'sb_conversation_pals_toggle',
    palsRail: 'sb_conversation_pals_rail',
    palsList: 'sb_conversation_pals_list',
    stage: 'sb_conversation_stage',
    timeline: 'sb_conversation_timeline',
    form: 'sb_conversation_form',
    input: 'sb_conversation_input',
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
    auto_schedule: '',
    schedule_generated_at: 0,
    selfie_command_enabled: true,
    schedule_command_enabled: true,
    use_geechan_as_system: true,
    geechan_chatroom_prompt: GEECHAN_DEFAULT_PROMPT,
    custom_instructions: '',
    multi_char: false,
    multi_char_names: '',
    auto_character_chat: false,
    lorebook_override: '',
    conversation_persona: '',
    connection_profile: '',
    authors_note: '',
    editable_messages: true,
    prose_polisher: false,
    image_gen_enabled: false,
    image_gen_prompt_template: 'a photo of {{char}}, {{scene}}',
    image_gen_negative: '',
    spontaneous_selfies: false,
    selfie_prompt: 'raw photo, selfie of {{char}}',
});

const SETTINGS_FIELDS = Object.freeze([
    { id: 'sb_conv_enabled', key: 'enabled', prop: 'checked' },
    { id: 'sb_conv_availability', key: 'availability', prop: 'value' },
    { id: 'sb_conv_idle_action', key: 'idle_action', prop: 'value' },
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
    { id: 'sb_conv_auto_schedule', key: 'auto_schedule', prop: 'value' },
    { id: 'sb_conv_selfie_command_enabled', key: 'selfie_command_enabled', prop: 'checked' },
    { id: 'sb_conv_schedule_command_enabled', key: 'schedule_command_enabled', prop: 'checked' },
    { id: 'sb_conv_use_geechan_as_system', key: 'use_geechan_as_system', prop: 'checked' },
    { id: 'sb_conv_geechan_chatroom_prompt', key: 'geechan_chatroom_prompt', prop: 'value' },
    { id: 'sb_conv_custom_instructions', key: 'custom_instructions', prop: 'value' },
    { id: 'sb_conv_multi_char', key: 'multi_char', prop: 'checked' },
    { id: 'sb_conv_multi_char_names', key: 'multi_char_names', prop: 'value' },
    { id: 'sb_conv_auto_character_chat', key: 'auto_character_chat', prop: 'checked' },
    { id: 'sb_conv_lorebook_override', key: 'lorebook_override', prop: 'value' },
    { id: 'sb_conv_conversation_persona', key: 'conversation_persona', prop: 'value' },
    { id: 'sb_conv_connection_profile', key: 'connection_profile', prop: 'value' },
    { id: 'sb_conv_authors_note', key: 'authors_note', prop: 'value' },
    { id: 'sb_conv_editable_messages', key: 'editable_messages', prop: 'checked' },
    { id: 'sb_conv_prose_polisher', key: 'prose_polisher', prop: 'checked' },
    { id: 'sb_conv_image_gen_enabled', key: 'image_gen_enabled', prop: 'checked' },
    { id: 'sb_conv_image_gen_prompt_template', key: 'image_gen_prompt_template', prop: 'value' },
    { id: 'sb_conv_image_gen_negative', key: 'image_gen_negative', prop: 'value' },
    { id: 'sb_conv_spontaneous_selfies', key: 'spontaneous_selfies', prop: 'checked' },
    { id: 'sb_conv_selfie_prompt', key: 'selfie_prompt', prop: 'value' },
]);

let initialized = false;
let autoWorkerBusy = false;
let generationActive = false;
let conversationReplyBusy = false;
let previousConnectionProfile = null;
let previousPersonaAvatar = null;
let activePersonaApplied = false;
let activeProfileApplied = false;
let scheduleGenerationBusy = false;
let scheduleEditingMode = false;
const runtimeStatusOverrides = new Map();

function getCurrentCharacter() {
    if (typeof this_chid === 'undefined' || !Array.isArray(characters)) {
        return null;
    }

    return characters[this_chid] ?? null;
}

function getCurrentCharAvatar() {
    return getCurrentCharacter()?.avatar ?? null;
}

function getCurrentCharName(fallback = 'Character') {
    return getCurrentCharacter()?.name || fallback;
}

function getCharacterStorageKey(prefix, avatar) {
    return `${prefix}${avatar}`;
}

function parsePositiveInt(value, fallback, min = 1) {
    const parsed = Number.parseInt(String(value), 10);
    return Number.isFinite(parsed) && parsed >= min ? parsed : fallback;
}

function safeParseSettings(stored) {
    if (!stored) {
        return { ...DEFAULT_SETTINGS };
    }

    try {
        return { ...DEFAULT_SETTINGS, ...JSON.parse(stored) };
    } catch {
        return { ...DEFAULT_SETTINGS };
    }
}

function getSettings(avatar = getCurrentCharAvatar()) {
    if (!avatar) {
        return { ...DEFAULT_SETTINGS };
    }

    return safeParseSettings(localStorage.getItem(getCharacterStorageKey(SETTINGS_KEY_PREFIX, avatar)));
}

function saveSettings(avatar, settings) {
    if (!avatar) {
        return;
    }

    localStorage.setItem(getCharacterStorageKey(SETTINGS_KEY_PREFIX, avatar), JSON.stringify(settings));
}

function getLastUserActivity(avatar, fallback = Date.now()) {
    return parsePositiveInt(localStorage.getItem(getCharacterStorageKey(LAST_USER_ACTIVITY_PREFIX, avatar)), fallback, 1);
}

function setLastUserActivity(avatar, timestamp = Date.now()) {
    localStorage.setItem(getCharacterStorageKey(LAST_USER_ACTIVITY_PREFIX, avatar), String(timestamp));
}

function getFollowupCount(avatar) {
    return parsePositiveInt(localStorage.getItem(getCharacterStorageKey(FOLLOWUP_COUNT_PREFIX, avatar)), 0, 0);
}

function setFollowupCount(avatar, count) {
    localStorage.setItem(getCharacterStorageKey(FOLLOWUP_COUNT_PREFIX, avatar), String(Math.max(0, count)));
}

function resetFollowupCount(avatar) {
    if (!avatar) {
        return;
    }

    localStorage.removeItem(getCharacterStorageKey(FOLLOWUP_COUNT_PREFIX, avatar));
}

function updateLastUserActivity() {
    const avatar = getCurrentCharAvatar();
    if (!avatar) {
        return;
    }

    setLastUserActivity(avatar);
    // Marinara-style: any user activity resets the escalating follow-up counter.
    resetFollowupCount(avatar);
}

function createConversationMessage({ role = 'character', name = getCurrentCharName(), mes = '', extra = {} } = {}) {
    return {
        id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
        role,
        name,
        mes,
        send_date: getMessageTimeStamp(),
        extra,
    };
}

function safeParseThread(stored) {
    if (!stored) {
        return [];
    }

    try {
        const parsed = JSON.parse(stored);
        return Array.isArray(parsed) ? parsed.filter(message => message?.id && message?.mes) : [];
    } catch {
        return [];
    }
}

function getConversationThread(avatar = getCurrentCharAvatar()) {
    if (!avatar) {
        return [];
    }

    return safeParseThread(localStorage.getItem(getCharacterStorageKey(THREAD_KEY_PREFIX, avatar)));
}

function saveConversationThread(avatar, messages) {
    if (!avatar) {
        return;
    }

    localStorage.setItem(getCharacterStorageKey(THREAD_KEY_PREFIX, avatar), JSON.stringify(messages.slice(-MAX_THREAD_MESSAGES)));
}

function appendConversationThreadMessage(avatar, messageInput) {
    const messages = getConversationThread(avatar);
    const message = createConversationMessage(messageInput);
    messages.push(message);
    saveConversationThread(avatar, messages);
    setLastConversationPreview(avatar, message.mes);
    renderConversationTimeline();
    return message;
}

function updateConversationThreadMessage(avatar, messageId, messageText) {
    const messages = getConversationThread(avatar);
    const message = messages.find(item => item.id === messageId);
    if (!message) {
        return;
    }

    message.mes = messageText;
    saveConversationThread(avatar, messages);
    updateLastPreviewFromConversation(avatar);
    renderConversationTimeline();
}

function getAvailabilityCopy(status) {
    return AVAILABILITY_COPY[status] ?? AVAILABILITY_COPY.online;
}

function getUserStatus() {
    return localStorage.getItem(USER_STATUS_STORAGE_KEY) || 'online';
}

function setUserStatus(status) {
    if (USER_STATUS_OPTIONS.includes(status)) {
        localStorage.setItem(USER_STATUS_STORAGE_KEY, status);
    }
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
    return globalThis.extension_settings?.connectionManager?.profiles ?? [];
}

function getPersonaOptions() {
    const personas = power_user?.personas;
    if (!personas || typeof personas !== 'object') {
        return [];
    }

    return Object.entries(personas).map(([avatarId, personaName]) => ({ avatarId, personaName: String(personaName) }));
}

async function applyConnectionProfileByName(profileName) {
    if (!profileName) {
        return;
    }

    try {
        await executeSlashCommandsWithOptions(`/profile ${profileName}`, {});
    } catch (error) {
        console.warn('Conversation Mode: could not apply connection profile', profileName, error);
    }
}

async function generateConversationImage(prompt, negative = '') {
    try {
        const qig = await import('./extensions/quick-image-gen/index.js');
        const entry = await qig.withTransientGenerationSettings({}, async () => {
            const settings = qig.getGenerationSettingsForRun();
            const raw = await qig.generateForProvider(prompt, negative, settings, new AbortController().signal, {});
            return raw ? qig.finalizeGeneratedEntry(raw, prompt, negative, settings, {}) : null;
        });

        return entry?.url ?? null;
    } catch (error) {
        console.warn('Conversation Mode: QIG not available or generation failed', error);
        return null;
    }
}

function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

function getScheduleStorageKey(avatar) {
    return `${SCHEDULE_PREFIX}${avatar}`;
}

function getStoredSchedule(avatar = getCurrentCharAvatar()) {
    if (!avatar) {
        return null;
    }

    try {
        const raw = localStorage.getItem(getScheduleStorageKey(avatar));
        if (!raw) {
            return null;
        }

        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
        return null;
    }
}

function saveStoredSchedule(avatar, schedule) {
    if (!avatar) {
        return;
    }

    localStorage.setItem(getScheduleStorageKey(avatar), JSON.stringify(schedule));
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

    const response = await generateRaw({
        prompt: promptParts.join('\n\n'),
        systemPrompt,
        responseLength: 1400,
        trimNames: false,
        cacheScope: 'conversation-mode-schedule',
    });

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

function getUnreadCount(avatar) {
    return parsePositiveInt(localStorage.getItem(getCharacterStorageKey(UNREAD_PREFIX, avatar)), 0, 0);
}

function setUnreadCount(avatar, count) {
    localStorage.setItem(getCharacterStorageKey(UNREAD_PREFIX, avatar), String(Math.max(0, count)));
}

function clearUnreadCount(avatar) {
    setUnreadCount(avatar, 0);
}

function stripPreviewText(messageText) {
    return String(messageText || '')
        .replace(/<[^>]*>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 130);
}

function setLastConversationPreview(avatar, messageText) {
    const preview = stripPreviewText(messageText);
    if (!avatar || !preview) {
        return;
    }

    localStorage.setItem(getCharacterStorageKey(LAST_PREVIEW_PREFIX, avatar), preview);
}

function getLastConversationPreview(avatar) {
    return localStorage.getItem(getCharacterStorageKey(LAST_PREVIEW_PREFIX, avatar)) || 'Conversation ready';
}

function updateLastPreviewFromConversation(avatar = getCurrentCharAvatar()) {
    if (!avatar) {
        return;
    }

    const messages = getConversationThread(avatar);
    const message = [...messages].reverse().find(item => item?.mes);
    if (message) {
        setLastConversationPreview(avatar, message.mes);
    }

    clearUnreadCount(avatar);
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

function getConversationMessageAvatar(message, avatar = getCurrentCharAvatar()) {
    if (message.role === 'user') {
        return default_user_avatar;
    }

    if (avatar) {
        return getThumbnailUrl('avatar', avatar);
    }

    return default_user_avatar;
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
        .map(message => `${message.name || 'Speaker'}: ${formatPromptText(message.mes, 1800)}`)
        .filter(Boolean)
        .join('\n');
}

function buildConversationSystemPrompt(settings) {
    const character = getCurrentCharacter();
    const charName = getCurrentCharName();
    const userName = name1 || 'User';
    const useGeechan = settings.use_geechan_as_system && (settings.geechan_chatroom_prompt || GEECHAN_DEFAULT_PROMPT);
    const fields = [
        `You are ${charName} in a private direct-message conversation with ${userName}.`,
        'This Conversation Mode transcript is separate from the roleplay/story chat. Do not continue roleplay scenes unless the user explicitly asks about them.',
    ];

    if (useGeechan) {
        let compiledPrompt = settings.geechan_chatroom_prompt || GEECHAN_DEFAULT_PROMPT;
        // Strip template comments {{// ... }}
        compiledPrompt = compiledPrompt.replace(/\{\{\/\/[\s\S]*?\}\}/g, '');
        // Strip {{trim}} tags
        compiledPrompt = compiledPrompt.replace(/\{\{trim\}\}/g, '');
        // Compile {{#if .player-instructions}} ... {{/if}}
        if (settings.custom_instructions && settings.custom_instructions.trim()) {
            compiledPrompt = compiledPrompt.replace(/\{\{#if \.player-instructions\}\}([\s\S]*?)\{\{\/if\}\}/gi, (match, p1) => {
                return p1.replace(/\{\{getvar::player-instructions\}\}/gi, settings.custom_instructions);
            });
        } else {
            compiledPrompt = compiledPrompt.replace(/\{\{#if \.player-instructions\}\}([\s\S]*?)\{\{\/if\}\}/gi, '');
        }
        // Substitute basic templates
        compiledPrompt = compiledPrompt
            .replace(/\{\{char\}\}/g, charName)
            .replace(/\{\{user\}\}/g, userName);
        fields.push(compiledPrompt.trim());
    } else {
        fields.push('Reply like a live DM: concise, present-tense, conversational, and grounded in the character. Avoid long prose narration.');
    }

    if (character?.description) {
        fields.push(`Character description:\n${formatPromptText(character.description, 2400)}`);
    }
    if (character?.personality) {
        fields.push(`Personality:\n${formatPromptText(character.personality, 1600)}`);
    }
    if (character?.scenario) {
        fields.push(`Background context:\n${formatPromptText(character.scenario, 1200)}`);
    }
    if (settings.authors_note) {
        fields.push(`Conversation author's note:\n${settings.authors_note.replace('{{char}}', charName).replace('{{user}}', userName)}`);
    }
    if (settings.lorebook_override) {
        fields.push(`Conversation lorebook focus: ${settings.lorebook_override}. Prefer this lore/context over roleplay scene continuity.`);
    }

    const schedule = getStoredSchedule(getCurrentCharAvatar());
    if (schedule) {
        const current = getCurrentActivityFromSchedule(schedule);
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
    if (commandHints.length) {
        fields.push(`Available commands (use sparingly and only when natural):\n${commandHints.join('\n')}`);
    }

    return fields.join('\n\n');
}

async function generateConversationReply(directive, settings, { responseLength = 220, speakerName = getCurrentCharName(), trimNames = true } = {}) {
    const avatar = getCurrentCharAvatar();
    const messages = getConversationThread(avatar);
    const transcript = formatConversationTranscript(messages) || '(No prior DM messages.)';
    const prompt = [
        'Conversation transcript:',
        transcript,
        directive,
        `${speakerName}:`,
    ].join('\n\n');

    return generateRaw({
        prompt,
        systemPrompt: buildConversationSystemPrompt(settings),
        responseLength,
        trimNames,
        cacheScope: 'conversation-mode',
    });
}

function editConversationMessage(messageId) {
    const avatar = getCurrentCharAvatar();
    const message = getConversationThread(avatar).find(item => item.id === messageId);
    if (!avatar || !message) {
        return;
    }

    const edited = globalThis.prompt?.('Edit Conversation message', message.mes);
    if (typeof edited !== 'string' || !edited.trim() || edited === message.mes) {
        return;
    }

    updateConversationThreadMessage(avatar, messageId, edited.trim());
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
function extractCharacterReplyCommands(rawText, settings, avatar = getCurrentCharAvatar()) {
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

    text = text.replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
    return { text, selfieRequests };
}

// Turns a free-form selfie context into a real image via QIG. Uses a meta-prompt
// so the LLM writes a focused image prompt, then appends an image message.
async function generateSelfieFromContext(context, settings, avatar = getCurrentCharAvatar()) {
    const character = (Array.isArray(characters) ? characters : []).find(c => c?.avatar === avatar) || getCurrentCharacter();
    const charName = character?.name || 'Character';
    const appearance = formatPromptText(character?.description || character?.personality || '', 600);
    const metaPrompt = [
        'You are an image prompt generator. Write a concise, detailed image generation prompt for a selfie photo.',
        `Character name: ${charName}.`,
        appearance ? `Appearance: ${appearance}` : '',
        context ? `Photo context: ${context}` : 'Photo context: a casual selfie in the current moment.',
        'Include appearance, clothing, expression and selfie pose, setting/background, and lighting. Output ONLY the prompt text, nothing else.',
    ].filter(Boolean).join('\n');

    let imagePrompt = '';
    try {
        imagePrompt = await generateRaw({
            prompt: metaPrompt,
            systemPrompt: 'You output only a raw image generation prompt with no preamble.',
            responseLength: 200,
            trimNames: false,
            cacheScope: 'conversation-mode-selfie',
        });
    } catch (error) {
        console.warn('Conversation Mode: selfie prompt generation failed', error);
    }

    imagePrompt = formatPromptText(imagePrompt, 600)
        || (settings.selfie_prompt || 'raw photo, selfie of {{char}}').replace(/\{\{char\}\}/g, charName);

    const imageUrl = await generateConversationImage(imagePrompt, settings.image_gen_negative || '');
    if (imageUrl) {
        appendConversationMessage('[Selfie]', {
            role: 'character',
            extra: { conversation_mode_image: true, image_url: imageUrl, image_prompt: imagePrompt },
        }, avatar);
    }
}

// Handles a freshly generated character reply: strips commands, posts the visible
// message, applies status overrides, and fires any requested selfies.
async function postCharacterReply(rawText, settings, { extra = {} } = {}, avatar = getCurrentCharAvatar()) {
    if (!avatar) {
        return '';
    }
    const { text, selfieRequests } = extractCharacterReplyCommands(rawText, settings, avatar);

    if (text) {
        const character = (Array.isArray(characters) ? characters : []).find(c => c?.avatar === avatar);
        const speakerName = settings.multi_char
            ? settings.multi_char_names.split(',')[0]
            : (character?.name || getCurrentCharName());

        appendConversationMessage(text, {
            name: speakerName,
            role: 'character',
            extra,
        }, avatar);
    }

    for (const context of selfieRequests) {
        await generateSelfieFromContext(context, settings, avatar);
    }

    return text;
}

function renderConversationTimeline() {
    const timeline = document.getElementById(CHROME_IDS.timeline);
    const avatar = getCurrentCharAvatar();
    if (!(timeline instanceof HTMLElement) || !avatar) {
        return;
    }

    const settings = getSettings(avatar);
    const messages = getConversationThread(avatar);
    timeline.textContent = '';

    if (!messages.length) {
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
        return;
    }

    messages.forEach((message, index) => {
        const item = document.createElement('article');
        item.className = 'sb-conversation-message';
        item.dataset.role = message.role || 'character';
        item.dataset.messageId = message.id;

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

        if (settings.editable_messages) {
            const editButton = document.createElement('button');
            editButton.type = 'button';
            editButton.className = 'sb-conversation-message-edit fa-solid fa-pencil';
            editButton.title = 'Edit Conversation message';
            editButton.setAttribute('aria-label', 'Edit Conversation message');
            editButton.dataset.sbConversationAction = 'edit-message';
            editButton.dataset.messageId = message.id;
            meta.appendChild(editButton);
        }

        if (settings.prose_polisher && message.role !== 'user') {
            const polishButton = document.createElement('button');
            polishButton.type = 'button';
            polishButton.className = 'sb-conversation-message-polish fa-solid fa-wand-magic-sparkles';
            polishButton.title = 'Polish character message';
            polishButton.setAttribute('aria-label', 'Polish character message');
            polishButton.dataset.sbConversationAction = 'polish-character-message';
            polishButton.dataset.messageId = message.id;
            meta.appendChild(polishButton);
        }

        const text = document.createElement('div');
        text.className = 'sb-conversation-message-text';
        if (message.mes) {
            text.innerHTML = messageFormatting(message.mes, message.name, false, message.role === 'user', index, {}, false);
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

        bubble.append(meta, text);
        item.append(avatarWrap, bubble);
        timeline.appendChild(item);
    });

    if (generationActive) {
        const charName = getCurrentCharName();
        const typingItem = document.createElement('div');
        typingItem.className = 'sb-conversation-message sb-conversation-typing-indicator';
        typingItem.dataset.role = 'character';

        const typingAvatarWrap = document.createElement('div');
        typingAvatarWrap.className = 'sb-conversation-message-avatar';
        const typingImage = document.createElement('img');
        typingImage.alt = '';
        typingImage.src = getThumbnailUrl('avatar', getCurrentCharAvatar()) || default_user_avatar;
        typingAvatarWrap.appendChild(typingImage);

        const typingBubble = document.createElement('div');
        typingBubble.className = 'sb-conversation-message-bubble';
        typingBubble.innerHTML = `
            <div class="sb-conversation-message-meta">
                <span class="sb-conversation-message-name">${escapeHtmlText(charName)}</span>
            </div>
            <div class="sb-conversation-message-text sb-conversation-typing-dots">
                <span></span><span></span><span></span>
            </div>
        `;
        typingItem.append(typingAvatarWrap, typingBubble);
        timeline.appendChild(typingItem);
    }

    timeline.scrollTop = timeline.scrollHeight;
}

function buildLorebookOptions(selected) {
    const options = ['<option value="">Character default (no override)</option>'];
    for (const worldName of (Array.isArray(world_names) ? world_names : [])) {
        const safe = escapeHtmlAttribute(worldName);
        options.push(`<option value="${safe}"${worldName === selected ? ' selected' : ''}>${escapeHtmlText(worldName)}</option>`);
    }
    return options.join('');
}

function buildPersonaOptions(selected) {
    const options = ['<option value="">Use active persona</option>'];
    for (const { avatarId, personaName } of getPersonaOptions()) {
        const safe = escapeHtmlAttribute(avatarId);
        options.push(`<option value="${safe}"${avatarId === selected ? ' selected' : ''}>${escapeHtmlText(personaName)}</option>`);
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

function buildChimingPartnerOptions(selectedNames) {
    const selectedSet = new Set(String(selectedNames || '').split(',').map(part => part.trim()).filter(Boolean));
    const currentAvatar = getCurrentCharAvatar();
    const rows = [];
    (Array.isArray(characters) ? characters : []).forEach((character) => {
        if (!character?.avatar || character.avatar === currentAvatar) {
            return;
        }
        const charName = character.name || 'Character';
        const checked = selectedSet.has(charName) ? ' checked' : '';
        const thumbUrl = getThumbnailUrl('avatar', character.avatar);
        rows.push(`
            <label class="sb-conversation-partner-option" data-char-name="${escapeHtmlAttribute(charName.toLowerCase())}">
                <input type="checkbox" class="sb-conversation-partner-checkbox" value="${escapeHtmlAttribute(charName)}"${checked} />
                <img class="sb-conversation-partner-avatar" src="${escapeHtmlAttribute(thumbUrl)}" alt="${escapeHtmlAttribute(charName)}" loading="lazy" />
                <span class="sb-conversation-partner-name">${escapeHtmlText(charName)}</span>
            </label>
        `);
    });
    if (!rows.length) {
        return '<div class="sb-conversation-empty">Enable more characters to pick chiming partners.</div>';
    }
    return rows.join('');
}

function escapeHtmlAttribute(value) {
    return String(value ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeHtmlText(value) {
    return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function buildSettingsDrawerHtml() {
    const settings = getSettings();
    return `
        <div class="sb-conversation-settings-header">
            <div>
                <div class="sb-conversation-settings-kicker">Conversation Mode</div>
                <div class="sb-conversation-settings-title">DM controls</div>
                <div class="sb-conversation-settings-subtitle">Presence, schedules, context, and message helpers for this character.</div>
            </div>
            <button type="button" class="menu_button menu_button_icon" data-sb-conversation-action="close-settings" title="Close Conversation settings" aria-label="Close Conversation settings">
                <i class="fa-solid fa-xmark"></i>
            </button>
        </div>
        <div class="sb-conversation-settings-body">
            <div class="sb-settings-group">
                <h4 class="sb-settings-group-title"><i class="fa-solid fa-power-off" aria-hidden="true"></i><span>Conversation Interface</span></h4>
                <label class="checkbox_label" title="Auto-activate the DM interface for this character">
                    <input id="sb_conv_enabled" type="checkbox" />
                    <span>Auto-activate Conversation Mode for this character</span>
                </label>
            </div>
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
                    <label for="sb_conv_idle_action">User Idle Action</label>
                    <select id="sb_conv_idle_action" class="text_pole textarea_compact wide100p">
                        <option value="disabled">Disabled</option>
                        <option value="followup">Send Auto Follow-up</option>
                        <option value="spontaneous">Spontaneous Ping</option>
                    </select>
                </div>
                <div class="sb-conversation-field-stack">
                    <label for="sb_conv_idle_limit">Idle Limit (minutes)</label>
                    <input id="sb_conv_idle_limit" class="text_pole textarea_compact wide100p" type="number" min="1" max="1440" step="1" value="15" />
                </div>
                <div class="sb-conversation-field-stack">
                    <label for="sb_conv_offline_message">Offline/DND Auto-responder</label>
                    <textarea id="sb_conv_offline_message" class="text_pole textarea_compact autoSetHeight wide100p" rows="2" placeholder="[Character is currently away. Leave a message!]"></textarea>
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
                </div>
                <div class="sb-conversation-field-row">
                    <label class="checkbox_label" title="Allow the character to send selfies through [selfie] commands">
                        <input id="sb_conv_selfie_command_enabled" type="checkbox" />
                        <span>Allow [selfie] commands</span>
                    </label>
                    <label class="checkbox_label" title="Allow the character to change its own status through [schedule_update] commands">
                        <input id="sb_conv_schedule_command_enabled" type="checkbox" />
                        <span>Allow [schedule_update] commands</span>
                    </label>
                </div>
            </div>
            <div class="sb-settings-group">
                <h4 class="sb-settings-group-title"><i class="fa-solid fa-clock" aria-hidden="true"></i><span>Manual Scheduling (optional)</span></h4>
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
                <div class="sb-conversation-field-stack">
                    <label for="sb_conv_ai_schedule">Extra Schedule Lines</label>
                    <textarea id="sb_conv_ai_schedule" class="text_pole textarea_compact autoSetHeight wide100p" rows="3" placeholder="08:00 - Good morning selfie!&#10;30 - Casual check-in 30 min after you go quiet"></textarea>
                </div>
            </div>
            <div class="sb-settings-group">
                <h4 class="sb-settings-group-title"><i class="fa-solid fa-scroll" aria-hidden="true"></i><span>Prompts & Formats</span></h4>
                <div class="sb-conversation-field-stack">
                    <label class="checkbox_label" title="Use Geechan Chatroom Prompt as the base system prompt">
                        <input id="sb_conv_use_geechan_as_system" type="checkbox" />
                        <span>Use Geechan Chatroom Prompt as system base</span>
                    </label>
                    <textarea id="sb_conv_geechan_chatroom_prompt" class="text_pole textarea_compact autoSetHeight wide100p" rows="3" placeholder="Type the chatroom system prompt here..."></textarea>
                </div>
                <div class="sb-conversation-field-stack">
                    <label for="sb_conv_custom_instructions">Custom Instructions</label>
                    <textarea id="sb_conv_custom_instructions" class="text_pole textarea_compact autoSetHeight wide100p" rows="3" placeholder="Type any custom instructions or guidelines here..."></textarea>
                </div>
                <label class="checkbox_label" title="Enable dynamic character-to-character chiming when idle">
                    <input id="sb_conv_multi_char" type="checkbox" />
                    <span>Multi-Character Chiming</span>
                </label>
                <div class="sb-conversation-field-stack">
                    <label>Chiming Partners</label>
                    <input type="text" id="sb_conv_multi_char_search" class="text_pole textarea_compact wide100p" placeholder="Search partners..." style="margin-bottom: 8px;" />
                    <div class="sb-conversation-partner-list" id="sb_conv_chiming_partner_list">${buildChimingPartnerOptions(settings.multi_char_names)}</div>
                    <input id="sb_conv_multi_char_names" type="hidden" value="${escapeHtmlAttribute(settings.multi_char_names)}" />
                </div>
                <label class="checkbox_label" title="Allow enabled characters to chat with each other autonomously in this thread">
                    <input id="sb_conv_auto_character_chat" type="checkbox" />
                    <span>Allow characters to talk to each other</span>
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
                    <label for="sb_conv_conversation_persona">Conversation Persona</label>
                    <select id="sb_conv_conversation_persona" class="text_pole textarea_compact wide100p">
                        ${buildPersonaOptions(settings.conversation_persona)}
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
                <label class="checkbox_label" title="Enable the Prose Polisher magic wand button to style your input before sending">
                    <input id="sb_conv_prose_polisher" type="checkbox" />
                    <span>Prose Polisher Send Assistant</span>
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
        header.hidden = true;
        header.innerHTML = `
            <button id="${CHROME_IDS.palsToggle}" type="button" class="menu_button menu_button_icon" data-sb-conversation-action="toggle-pals" title="Open Conversation pals" aria-label="Open Conversation pals">
                <i class="fa-solid fa-address-book"></i>
            </button>
            <div class="sb-conversation-header-avatar">
                <img data-sb-conversation-avatar alt="" loading="lazy">
                <span class="sb-conversation-status-dot" data-sb-conversation-status-dot data-status="online" aria-hidden="true"></span>
            </div>
            <div class="sb-conversation-header-copy">
                <div class="sb-conversation-header-kicker">Conversation Workspace</div>
                <div class="sb-conversation-header-name" data-sb-conversation-name>Conversation</div>
                <div class="sb-conversation-header-status" data-sb-conversation-status>Available for live DM replies.</div>
            </div>
            <div class="sb-conversation-header-actions">
                <button type="button" class="menu_button menu_button_icon" data-sb-conversation-action="new-chat" title="Clear DM History (New Chat)" aria-label="Clear DM History (New Chat)">
                    <i class="fa-solid fa-trash-can" aria-hidden="true"></i>
                    <span>New Chat</span>
                </button>
                <button type="button" class="menu_button menu_button_icon" data-sb-conversation-action="return-roleplay" title="Return to roleplay chat" aria-label="Return to roleplay chat">
                    <i class="fa-solid fa-masks-theater" aria-hidden="true"></i>
                    <span>Roleplay</span>
                </button>
                <button type="button" class="menu_button menu_button_icon" data-sb-conversation-action="open-settings" title="Conversation settings" aria-label="Conversation settings">
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
            <form id="${CHROME_IDS.form}" class="sb-conversation-composer">
                <label class="sr-only" for="${CHROME_IDS.input}">Conversation message</label>
                <textarea id="${CHROME_IDS.input}" class="text_pole" rows="2" placeholder="Message this character outside roleplay..."></textarea>
                <div class="sb-conversation-composer-actions">
                    <button id="${CHROME_IDS.composerPolish}" type="button" class="menu_button menu_button_icon" data-sb-conversation-action="polish-input" title="Polish message" aria-label="Polish message" hidden>
                        <i class="fa-solid fa-wand-magic-sparkles"></i>
                    </button>
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
                <div style="display: flex; gap: 8px;">
                    <button type="button" class="menu_button menu_button_icon" data-sb-conversation-action="open-add-dm" title="Start a new DM" aria-label="Start a new DM">
                        <i class="fa-solid fa-plus"></i>
                    </button>
                    <button type="button" class="menu_button menu_button_icon sb-conversation-rail-close" data-sb-conversation-action="close-pals" title="Close Conversation pals" aria-label="Close Conversation pals">
                        <i class="fa-solid fa-xmark"></i>
                    </button>
                </div>
                <div id="sb_conversation_add_dm_picker" class="sb-conversation-add-dm-picker" style="position: absolute; inset-block-start: calc(100% + 4px); inset-inline-start: 12px; inset-inline-end: 12px; z-index: 95; padding: 10px; border-radius: var(--sb-radius-md); border: 1px solid var(--sb-shell-border); background-color: var(--SmartThemeBlurTintColor); backdrop-filter: blur(12px); box-shadow: 0 4px 20px var(--black50a);" hidden></div>
            </div>
            <div id="${CHROME_IDS.palsList}" class="sb-conversation-pals-list"></div>
            <div id="${CHROME_IDS.railFooter}" class="sb-conversation-rail-footer">
                <div class="sb-conversation-rail-footer-avatar">
                    <img id="sb_conv_footer_persona_avatar" alt="" loading="lazy" />
                    <span class="sb-conversation-status-dot sb-conversation-rail-footer-dot" data-status="online" aria-hidden="true"></span>
                </div>
                <div class="sb-conversation-rail-footer-copy">
                    <span id="sb_conv_footer_persona_name" class="sb-conversation-rail-footer-name"></span>
                    <span id="sb_conv_footer_user_status" class="sb-conversation-rail-footer-status"></span>
                </div>
                <div class="sb-conversation-rail-footer-actions">
                    <button type="button" class="menu_button menu_button_icon" data-sb-conversation-action="open-persona-picker" title="Switch persona" aria-label="Switch persona" aria-haspopup="listbox">
                        <i class="fa-solid fa-user-pen" aria-hidden="true"></i>
                    </button>
                    <div id="${CHROME_IDS.personaPicker}" class="sb-conversation-persona-picker" role="listbox" aria-label="Choose persona" hidden></div>
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

function renderScheduleDisplay() {
    const display = document.getElementById('sb_conv_schedule_display');
    if (!(display instanceof HTMLElement)) {
        return;
    }

    const avatar = getCurrentCharAvatar();
    const schedule = avatar ? getStoredSchedule(avatar) : null;

    if (scheduleEditingMode) {
        display.dataset.empty = 'false';
        const jsonText = schedule ? JSON.stringify(schedule, null, 4) : '';
        display.innerHTML = `
            <div class="sb-conversation-field-stack" style="gap: 8px;">
                <textarea id="sb_conv_schedule_editor_area" class="text_pole textarea_compact wide100p" rows="12" style="font-family: monospace; font-size: var(--sb-type-caption); white-space: pre; overflow-wrap: normal; overflow-x: auto;">${escapeHtmlText(jsonText)}</textarea>
                <div class="sb-conversation-field-row" style="gap: 8px; justify-content: flex-end;">
                    <button type="button" class="menu_button" data-sb-conversation-action="schedule-edit-save" style="padding: 4px 10px; font-size: var(--sb-type-meta);">Save</button>
                    <button type="button" class="menu_button" data-sb-conversation-action="schedule-edit-cancel" style="padding: 4px 10px; font-size: var(--sb-type-meta);">Cancel</button>
                </div>
            </div>
        `;
        return;
    }

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

function openConversationSettings() {
    const chrome = ensureConversationChrome();
    if (!chrome) {
        return;
    }

    closePalsRail();
    scheduleEditingMode = false;
    const settings = getSettings();

    // Refresh live-data dropdowns before showing the drawer.
    const lorebookSelect = document.getElementById('sb_conv_lorebook_override');
    if (lorebookSelect instanceof HTMLSelectElement) {
        lorebookSelect.innerHTML = buildLorebookOptions(settings.lorebook_override);
    }
    const personaSelect = document.getElementById('sb_conv_conversation_persona');
    if (personaSelect instanceof HTMLSelectElement) {
        personaSelect.innerHTML = buildPersonaOptions(settings.conversation_persona);
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
    bindChimingPartnerList();
    renderScheduleDisplay();
    updateUserFooter();
    chrome.drawer.hidden = false;
    setConversationBackdropVisible();
    chrome.drawer.querySelector('input, select, textarea, button')?.focus?.({ preventScroll: true });
}

function closeConversationSettings() {
    const drawer = document.getElementById(CHROME_IDS.settingsDrawer);
    if (drawer instanceof HTMLElement) {
        drawer.hidden = true;
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

function readChimingPartnersFromList() {
    const list = document.getElementById('sb_conv_chiming_partner_list');
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

function updateUserFooter() {
    const footer = document.getElementById(CHROME_IDS.railFooter);
    if (!(footer instanceof HTMLElement)) {
        return;
    }

    const personaName = name1 || 'You';
    const status = getUserStatus();
    const statusCopy = AVAILABILITY_COPY[status] ?? AVAILABILITY_COPY.online;

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
        statusEl.textContent = statusCopy.label;
        statusEl.dataset.status = status;
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

function togglePersonaPicker() {
    const picker = document.getElementById(CHROME_IDS.personaPicker);
    if (!(picker instanceof HTMLElement)) {
        return;
    }

    const isHidden = picker.hidden;
    document.getElementById(CHROME_IDS.userStatusPicker)?.setAttribute('hidden', '');

    if (isHidden) {
        picker.innerHTML = '';
        const personas = getPersonaOptions();
        if (!personas.length) {
            picker.innerHTML = '<div class="sb-conversation-empty">No personas configured.</div>';
        } else {
            for (const { avatarId, personaName } of personas) {
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.className = 'sb-conversation-persona-option';
                btn.dataset.sbConversationAction = 'pick-persona';
                btn.dataset.personaAvatar = avatarId;
                btn.setAttribute('role', 'option');
                const img = document.createElement('img');
                img.src = getThumbnailUrl('persona', avatarId);
                img.alt = '';
                img.loading = 'lazy';
                btn.appendChild(img);
                btn.appendChild(document.createTextNode(personaName));
                picker.appendChild(btn);
            }
        }
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
        editor.addEventListener('input', saveCurrentPanelSettings);
    }
}

function bindChimingPartnerList() {
    const list = document.getElementById('sb_conv_chiming_partner_list');
    if (!(list instanceof HTMLElement) || list.dataset.sbConversationBound === 'true') {
        return;
    }

    list.dataset.sbConversationBound = 'true';
    list.addEventListener('change', saveCurrentPanelSettings);

    const searchInput = document.getElementById('sb_conv_multi_char_search');
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

    if (!picker.hasAttribute('hidden')) {
        picker.setAttribute('hidden', '');
        return;
    }

    picker.removeAttribute('hidden');
    picker.innerHTML = `
        <div class="sb-conversation-add-dm-header">
            <span style="font-weight: var(--sb-weight-title); font-size: var(--sb-type-meta);">Start a new DM</span>
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

function bindConversationChromeControls(sheld) {
    if (sheld.dataset.sbConversationChromeBound === 'true') {
        return;
    }

    sheld.dataset.sbConversationChromeBound = 'true';
    sheld.addEventListener('click', async (event) => {
        const target = event.target instanceof Element ? event.target.closest('[data-sb-conversation-action], .sb-conversation-pal') : null;
        if (!(target instanceof HTMLElement)) {
            return;
        }

        if (target.classList.contains('sb-conversation-pal')) {
            const index = parsePositiveInt(target.dataset.characterIndex, -1, 0);
            if (index >= 0) {
                closePalsRail();
                await selectCharacterById(index, { switchMenu: false });
            }
            return;
        }

        switch (target.dataset.sbConversationAction) {
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
            case 'polish-input':
                await handleProsePolish();
                break;
            case 'polish-character-message':
                await handleCharacterMessagePolish(target.dataset.messageId, target);
                break;
            case 'open-add-dm':
                toggleAddDmPicker();
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
                        await selectCharacterById(index, { switchMenu: false });
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
            case 'new-chat': {
                const avatar = getCurrentCharAvatar();
                if (avatar && confirm(`Are you sure you want to clear your DM history with ${getCurrentCharName()}? This cannot be undone.`)) {
                    saveConversationThread(avatar, []);
                    resetFollowupCount(avatar);
                    updateLastUserActivity();
                    refreshConversationInterface({ syncControls: false });
                    toastr.success('Chat history cleared.');
                }
                break;
            }
            case 'edit-message':
                editConversationMessage(target.dataset.messageId);
                break;
            case 'weekly-add':
                addWeeklyScheduleRow();
                break;
            case 'edit-schedule':
                scheduleEditingMode = !scheduleEditingMode;
                renderScheduleDisplay();
                break;
            case 'schedule-edit-save': {
                const area = document.getElementById('sb_conv_schedule_editor_area');
                if (area instanceof HTMLTextAreaElement) {
                    try {
                        const parsed = parseScheduleResponse(area.value);
                        if (parsed) {
                            const editAvatar = getCurrentCharAvatar();
                            saveStoredSchedule(editAvatar, parsed);
                            const editSettings = getSettings(editAvatar);
                            editSettings.auto_schedule = JSON.stringify(parsed);
                            if (parsed.talkativeness !== undefined) {
                                editSettings.talkativeness = parsed.talkativeness;
                            }
                            if (parsed.inactivityThresholdMinutes !== undefined) {
                                editSettings.inactivity_threshold = parsed.inactivityThresholdMinutes;
                            }
                            saveSettings(editAvatar, editSettings);
                            applySettingsToPanel(editSettings);
                            scheduleEditingMode = false;
                            renderScheduleDisplay();
                            updateConversationChrome(editSettings);
                            toastr.success('Schedule saved successfully.');
                        } else {
                            toastr.warning('Invalid schedule JSON structure.');
                        }
                    } catch (err) {
                        toastr.error('Failed to parse schedule JSON: ' + err.message);
                    }
                }
                break;
            }
            case 'schedule-edit-cancel':
                scheduleEditingMode = false;
                renderScheduleDisplay();
                break;
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
            case 'open-persona-picker':
                togglePersonaPicker();
                break;
            case 'pick-persona': {
                const avatarId = target.dataset.personaAvatar;
                if (avatarId) {
                    await setUserAvatar(avatarId, { toastPersonaNameChange: false });
                    updateUserFooter();
                    saveCurrentPanelSettings();
                }
                document.getElementById(CHROME_IDS.personaPicker)?.setAttribute('hidden', '');
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
            if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                void submitConversationInput();
            }
        });
    }

    const drawer = document.getElementById(CHROME_IDS.settingsDrawer);
    if (drawer instanceof HTMLElement && drawer.dataset.sbConversationBound !== 'true') {
        drawer.dataset.sbConversationBound = 'true';
        drawer.addEventListener('change', saveCurrentPanelSettings);
        drawer.addEventListener('input', saveCurrentPanelSettings);
    }

    const backdrop = document.getElementById(CHROME_IDS.settingsBackdrop);
    if (backdrop instanceof HTMLElement && backdrop.dataset.sbConversationBound !== 'true') {
        backdrop.dataset.sbConversationBound = 'true';
        backdrop.addEventListener('click', () => {
            closeConversationSettings();
            closePalsRail();
        });
    }
}

function syncEntryPanel(settings = getSettings()) {
    const character = getCurrentCharacter();
    const nameElement = document.getElementById('sb_conv_entry_name');
    const summaryElement = document.getElementById('sb_conv_entry_summary');
    const toggle = document.getElementById('sb_conv_entry_enabled');
    const openButton = document.getElementById('sb_conv_open_dm');

    if (nameElement instanceof HTMLElement) {
        nameElement.textContent = character?.name || 'No character selected';
    }

    if (summaryElement instanceof HTMLElement) {
        summaryElement.textContent = character
            ? settings.enabled
                ? 'This character has a separate DM workspace. Roleplay chat remains untouched.'
                : 'Enable Conversation Mode to open a separate DM workspace. Settings live inside the Conversation gear menu.'
            : 'Select a character before enabling Conversation Mode.';
    }

    if (toggle instanceof HTMLInputElement) {
        toggle.checked = Boolean(character && settings.enabled);
        toggle.disabled = !character;
    }

    if (openButton instanceof HTMLButtonElement) {
        openButton.disabled = !character;
    }
}

function enableConversationModeForCurrentCharacter() {
    const avatar = getCurrentCharAvatar();
    if (!avatar) {
        return;
    }

    const settings = getSettings(avatar);
    settings.enabled = true;
    saveSettings(avatar, settings);
    applySettingsToPanel(settings);
    refreshConversationInterface({ syncControls: false });
    document.getElementById(CHROME_IDS.input)?.focus?.({ preventScroll: false });
}

function disableConversationModeForCurrentCharacter() {
    const avatar = getCurrentCharAvatar();
    if (!avatar) {
        return;
    }

    const settings = getSettings(avatar);
    settings.enabled = false;
    saveSettings(avatar, settings);
    applySettingsToPanel(settings);
    refreshConversationInterface({ syncControls: false });
    document.getElementById('send_textarea')?.focus?.({ preventScroll: false });
}

function bindEntryPanel() {
    const panel = document.getElementById('sb_character_conversation_panel');
    if (!(panel instanceof HTMLElement) || panel.dataset.sbConversationEntryBound === 'true') {
        return;
    }

    panel.dataset.sbConversationEntryBound = 'true';
    panel.addEventListener('change', (event) => {
        if (!(event.target instanceof HTMLInputElement) || event.target.id !== 'sb_conv_entry_enabled') {
            return;
        }

        const avatar = getCurrentCharAvatar();
        if (!avatar) {
            return;
        }

        const settings = getSettings(avatar);
        settings.enabled = event.target.checked;
        saveSettings(avatar, settings);
        applySettingsToPanel(settings);
        refreshConversationInterface({ syncControls: false });
    });

    const openButton = document.getElementById('sb_conv_open_dm');
    if (openButton instanceof HTMLButtonElement) {
        openButton.addEventListener('click', enableConversationModeForCurrentCharacter);
    }
}

function getSelectedConnectionProfileName() {
    const manager = globalThis.extension_settings?.connectionManager;
    if (!manager || !Array.isArray(manager.profiles)) {
        return '';
    }
    const selected = manager.profiles.find((profile) => profile?.id === manager.selectedProfile);
    return selected?.name ?? '';
}

function applyConversationContext(settings) {
    if (settings.conversation_persona && !activePersonaApplied) {
        if (typeof user_avatar === 'string' && user_avatar !== settings.conversation_persona) {
            previousPersonaAvatar = user_avatar;
            activePersonaApplied = true;
            void setUserAvatar(settings.conversation_persona, { toastPersonaNameChange: false });
        }
    }

    if (settings.connection_profile && !activeProfileApplied) {
        const current = getSelectedConnectionProfileName();
        if (current !== settings.connection_profile) {
            previousConnectionProfile = current;
            activeProfileApplied = true;
            void applyConnectionProfileByName(settings.connection_profile);
        }
    }
}

function restoreConversationContext() {
    if (activePersonaApplied && previousPersonaAvatar) {
        void setUserAvatar(previousPersonaAvatar, { toastPersonaNameChange: false });
    }
    previousPersonaAvatar = null;
    activePersonaApplied = false;

    if (activeProfileApplied && previousConnectionProfile) {
        void applyConnectionProfileByName(previousConnectionProfile);
    }
    previousConnectionProfile = null;
    activeProfileApplied = false;
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
    applyConversationContext(getSettings());
    updateUserFooter();
}

function renderPalsRail() {
    const list = document.getElementById(CHROME_IDS.palsList);
    if (!(list instanceof HTMLElement)) {
        return;
    }

    const pals = getConversationPals();
    list.textContent = '';

    if (!pals.length) {
        const empty = document.createElement('div');
        empty.className = 'sb-conversation-empty';
        empty.textContent = 'Enable Conversation Mode on characters to build your DM cast.';
        list.appendChild(empty);
        return;
    }

    for (const { character, index, settings } of pals) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'sb-conversation-pal';
        button.dataset.characterIndex = String(index);
        button.dataset.unread = String(getUnreadCount(character.avatar) > 0);
        button.setAttribute('aria-current', String(!selected_group && Number(this_chid) === index));
        button.innerHTML = `
            <span class="sb-conversation-pal-avatar">
                <img alt="" loading="lazy">
                <span class="sb-conversation-status-dot" aria-hidden="true"></span>
            </span>
            <span class="sb-conversation-pal-copy">
                <span class="sb-conversation-pal-name"></span>
                <span class="sb-conversation-pal-preview"></span>
            </span>
            <span class="sb-conversation-pal-unread" aria-hidden="true"></span>
        `;

        const image = button.querySelector('img');
        const statusDot = button.querySelector('.sb-conversation-status-dot');
        const name = button.querySelector('.sb-conversation-pal-name');
        const preview = button.querySelector('.sb-conversation-pal-preview');

        if (image instanceof HTMLImageElement) {
            image.src = getThumbnailUrl('avatar', character.avatar);
        }
        if (statusDot instanceof HTMLElement) {
            statusDot.dataset.status = settings.availability;
        }
        if (name instanceof HTMLElement) {
            name.textContent = character.name || 'Character';
        }
        if (preview instanceof HTMLElement) {
            preview.textContent = getLastConversationPreview(character.avatar);
        }

        list.appendChild(button);
    }
}

function updateConversationHeader(settings = getSettings()) {
    const character = getCurrentCharacter();
    const avatar = getCurrentCharAvatar();
    const image = document.querySelector(`#${CHROME_IDS.header} [data-sb-conversation-avatar]`);
    const name = document.querySelector(`#${CHROME_IDS.header} [data-sb-conversation-name]`);
    const status = document.querySelector(`#${CHROME_IDS.header} [data-sb-conversation-status]`);
    const statusDot = document.querySelector(`#${CHROME_IDS.header} [data-sb-conversation-status-dot]`);
    const statusCopy = getAvailabilityCopy(settings.availability);
    const schedule = avatar ? getStoredSchedule(avatar) : null;
    const current = schedule ? getCurrentActivityFromSchedule(schedule, avatar) : null;
    const effectiveStatus = current ? current.status : settings.availability;

    if (image instanceof HTMLImageElement && character?.avatar) {
        image.src = getThumbnailUrl('avatar', character.avatar);
    }
    if (name instanceof HTMLElement) {
        name.textContent = character?.name || 'Conversation';
    }
    if (status instanceof HTMLElement) {
        if (generationActive && character) {
            status.textContent = `${character.name || 'Character'} is writing...`;
        } else if (current) {
            const currentCopy = getAvailabilityCopy(current.status);
            status.textContent = `${currentCopy.label} · ${current.activity}`;
        } else {
            status.textContent = `${statusCopy.label}: ${statusCopy.detail}`;
        }
    }
    if (statusDot instanceof HTMLElement) {
        statusDot.dataset.status = effectiveStatus;
    }
}

function updateConversationChrome(settings = getSettings()) {
    updateConversationHeader(settings);
    renderPalsRail();
}

function refreshConversationInterface({ syncControls = false } = {}) {
    const avatar = getCurrentCharAvatar();
    const settings = getSettings(avatar);
    const active = Boolean(!selected_group && avatar && settings.enabled);

    syncEntryPanel(settings);
    setConversationInterfaceActive(active);

    if (syncControls) {
        applySettingsToPanel(settings);
    }

    if (active) {
        clearUnreadCount(avatar);
        updateLastPreviewFromConversation(avatar);
        renderConversationTimeline();
        updateConversationChrome(settings);
        updateUserFooter();
    }

    updateProsePolisherButtonVisibility();
    updateEditableMessageButtons();
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
            settings[field.key] = parsePositiveInt(element.value, field.fallback, field.min);
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
    saveSettings(avatar, settings);
    refreshConversationInterface({ syncControls: false });
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
}

function loadCurrentPanelSettings() {
    const avatar = getCurrentCharAvatar();

    if (!avatar) {
        applySettingsToPanel(DEFAULT_SETTINGS);
        syncEntryPanel(DEFAULT_SETTINGS);
        refreshConversationInterface({ syncControls: false });
        return;
    }

    const settings = getSettings(avatar);
    applySettingsToPanel(settings);
    refreshConversationInterface({ syncControls: false });
}

function updateProsePolisherButtonVisibility() {
    const button = document.getElementById('sb_prose_polisher_but');
    const composerButton = document.getElementById(CHROME_IDS.composerPolish);

    const avatar = getCurrentCharAvatar();
    const settings = getSettings(avatar);
    const conversationActive = Boolean(!selected_group && avatar && settings.enabled);
    const shouldShowComposerPolish = Boolean(conversationActive && settings.prose_polisher);

    if (button instanceof HTMLElement) {
        button.classList.add('displayNone');
        button.hidden = true;
    }

    if (composerButton instanceof HTMLElement) {
        composerButton.hidden = !shouldShowComposerPolish;
    }
}

function updateEditableMessageButtons() {
    const avatar = getCurrentCharAvatar();
    const settings = getSettings(avatar);
    if (selected_group || !avatar || !settings.enabled) {
        return;
    }

    renderConversationTimeline();
}

async function handleProsePolish() {
    const conversationInput = document.getElementById(CHROME_IDS.input);
    const textElement = conversationInput instanceof HTMLTextAreaElement
        ? conversationInput
        : document.getElementById('send_textarea');
    if (!(textElement instanceof HTMLTextAreaElement)) {
        return;
    }

    const originalText = textElement.value.trim();
    if (!originalText) {
        return;
    }

    const wand = document.getElementById(CHROME_IDS.composerPolish) || document.getElementById('sb_prose_polisher_but');
    if (wand instanceof HTMLElement) {
        wand.classList.remove('fa-wand-magic-sparkles');
        wand.classList.add('fa-spinner', 'fa-spin');
    }

    try {
        const systemPrompt = 'You are a professional message editor. Polish the user\'s direct message by correcting typos, spelling, punctuation, and style while keeping the meaning and intent identical. Output only the polished message text.';
        const prompt = `Polish this message text:\n"${originalText}"`;
        const response = await generateRaw({
            prompt,
            systemPrompt,
            responseLength: 200,
            trimNames: true,
        });

        if (response?.trim()) {
            textElement.value = response.trim();
            textElement.dispatchEvent(new Event('input', { bubbles: true }));
            globalThis.toastr?.success?.('Prose polished successfully!');
        } else {
            globalThis.toastr?.error?.('Polishing failed. No response received.');
        }
    } catch (error) {
        console.error('Prose polishing error:', error);
        globalThis.toastr?.error?.('Error polishing message.');
    } finally {
        if (wand instanceof HTMLElement) {
            wand.classList.remove('fa-spinner', 'fa-spin');
            wand.classList.add('fa-wand-magic-sparkles');
        }
    }
}

async function handleCharacterMessagePolish(messageId, buttonElement) {
    const avatar = getCurrentCharAvatar();
    if (!avatar) return;

    const thread = getConversationThread(avatar);
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
        const response = await generateRaw({
            prompt,
            systemPrompt,
            responseLength: 300,
            trimNames: true,
        });

        if (response?.trim()) {
            msg.mes = response.trim();
            saveConversationThread(avatar, thread);
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

async function submitConversationInput() {
    if (conversationReplyBusy || autoWorkerBusy || selected_group || is_send_press) {
        return;
    }

    const input = document.getElementById(CHROME_IDS.input);
    if (!(input instanceof HTMLTextAreaElement)) {
        return;
    }

    const avatar = getCurrentCharAvatar();
    const settings = getSettings(avatar);
    const text = input.value.trim();
    if (!avatar || !settings.enabled || !text) {
        return;
    }

    input.value = '';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    appendConversationThreadMessage(avatar, {
        role: 'user',
        name: name1 || 'You',
        mes: text,
        extra: {
            conversation_mode_user: true,
        },
    });
    updateLastUserActivity();
    refreshConversationInterface({ syncControls: false });

    if (await handleAvailabilityAutoResponder(settings)) {
        input.focus({ preventScroll: true });
        return;
    }

    conversationReplyBusy = true;
    generationActive = true;
    refreshConversationInterface({ syncControls: false });

    try {
        const response = await generateConversationReply('[System directive: The user sent the latest DM. Reply directly to them in the Conversation Mode thread.]', settings);
        if (response?.trim()) {
            await postCharacterReply(response.trim(), settings, {
                extra: {
                    conversation_mode_reply: true,
                },
            });
        }

        // Item 8: QIG image gen — trigger when user asked for an image or image_gen is enabled + spontaneous_selfies
        const imageKeywords = /\b(send\s*pic|selfie|photo|image|picture|show\s*me)\b/i;
        const wantsImage = settings.image_gen_enabled
            && (settings.spontaneous_selfies || imageKeywords.test(text));
        if (wantsImage) {
            const charName = getCurrentCharName();
            const prompt = (settings.image_gen_prompt_template || DEFAULT_SETTINGS.image_gen_prompt_template)
                .replace(/\{\{char\}\}/g, charName)
                .replace(/\{\{scene\}\}/g, 'the current DM conversation');
            const imageUrl = await generateConversationImage(prompt, settings.image_gen_negative || '');
            if (imageUrl) {
                await appendConversationMessage('[Image attached]', {
                    name: charName,
                    role: 'character',
                    extra: {
                        conversation_mode_image: true,
                        image_url: imageUrl,
                    },
                });
            }
        }
    } catch (error) {
        console.error('Conversation reply error:', error);
        globalThis.toastr?.error?.('Conversation reply failed.');
    } finally {
        conversationReplyBusy = false;
        generationActive = false;
        refreshConversationInterface({ syncControls: false });
        input.focus({ preventScroll: true });
    }
}

async function appendConversationMessage(messageText, { name = getCurrentCharName(), role = 'character', extra = {} } = {}, avatar = getCurrentCharAvatar()) {
    if (!avatar) {
        return null;
    }

    const message = appendConversationThreadMessage(avatar, {
        role,
        name,
        mes: messageText,
        extra,
    });

    refreshConversationInterface({ syncControls: false });
    return message;
}

function buildAutoMessageDirective(directive) {
    return directive;
}

async function maybeGenerateSpontaneousImage(settings) {
    if (!settings.image_gen_enabled || !settings.spontaneous_selfies) {
        return;
    }

    const charName = getCurrentCharName();
    const prompt = (settings.selfie_prompt || settings.image_gen_prompt_template || DEFAULT_SETTINGS.image_gen_prompt_template)
        .replace(/\{\{char\}\}/g, charName)
        .replace(/\{\{scene\}\}/g, 'the current DM conversation');
    const imageUrl = await generateConversationImage(prompt, settings.image_gen_negative || '');
    if (imageUrl) {
        await appendConversationMessage('[Image attached]', {
            name: charName,
            role: 'character',
            extra: {
                conversation_mode_image: true,
                image_url: imageUrl,
            },
        });
    }
}

async function triggerAutoMessage(directive, settings, extra = {}) {
    if (autoWorkerBusy || conversationReplyBusy || selected_group || is_send_press || !getCurrentCharacter()) {
        return false;
    }

    autoWorkerBusy = true;

    try {
        const quietPrompt = buildAutoMessageDirective(directive);
        const response = await generateConversationReply(quietPrompt, settings, { responseLength: 220 });

        if (response?.trim()) {
            await postCharacterReply(response.trim(), settings, {
                extra: {
                    conversation_mode_auto: true,
                    ...extra,
                },
            });
            autoWorkerBusy = false;
            await maybeGenerateSpontaneousImage(settings);
            return true;
        }
    } catch (error) {
        console.error('Conversation auto-message error:', error);
        globalThis.toastr?.warning?.('Conversation Mode auto-message failed.');
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

function getLastAutoMessageTime(avatar) {
    return parsePositiveInt(localStorage.getItem(getCharacterStorageKey(LAST_AUTO_MESSAGE_PREFIX, avatar)), 0, 0);
}

function setLastAutoMessageTime(avatar, timestamp = Date.now()) {
    localStorage.setItem(getCharacterStorageKey(LAST_AUTO_MESSAGE_PREFIX, avatar), String(timestamp));
}

function getScheduleTriggerState(avatar) {
    try {
        return JSON.parse(localStorage.getItem(getCharacterStorageKey(LAST_SCHEDULE_TRIGGER_PREFIX, avatar))) || {};
    } catch {
        return {};
    }
}

function setScheduleTriggered(avatar, triggerKey, timestamp) {
    const state = getScheduleTriggerState(avatar);
    state[triggerKey] = timestamp;

    const stateEntries = Object.entries(state).sort((first, second) => first[1] - second[1]);
    while (stateEntries.length > 100) {
        const [oldestKey] = stateEntries.shift();
        delete state[oldestKey];
    }

    localStorage.setItem(getCharacterStorageKey(LAST_SCHEDULE_TRIGGER_PREFIX, avatar), JSON.stringify(state));
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

            const triggered = await triggerAutoMessage(`[System directive: Your schedule is due: "${absoluteMatch[3]}". Send a message with this context in mind.]`, settings, { schedule: trimmed });
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

                const triggered = await triggerAutoMessage(`[System directive: You are sending a check-in due to ${delayMinutes} minutes of silence: "${relativeMatch[2]}".]`, settings, { schedule: trimmed });
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
    if (settings.idle_action === 'disabled') {
        return false;
    }

    const lastUserActivity = getLastUserActivity(avatar, now);
    const idleMinutes = (now - lastUserActivity) / (60 * 1000);

    if (idleMinutes < settings.idle_limit) {
        return false;
    }

    const sessionKey = getCharacterStorageKey(LAST_IDLE_SESSION_PREFIX, avatar);
    if (localStorage.getItem(sessionKey) === String(lastUserActivity)) {
        return false;
    }

    const directive = settings.idle_action === 'followup'
        ? '[System directive: The user has been quiet for a while. Send a casual auto follow-up checking in or asking what they are up to.]'
        : '[System directive: Send a spontaneous ping to the user, starting a new topic or sharing a casual thought.]';

    const triggered = await triggerAutoMessage(directive, settings, { idle_action: settings.idle_action });
    if (triggered) {
        localStorage.setItem(sessionKey, String(lastUserActivity));
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
    });

    if (triggered) {
        setFollowupCount(avatar, sentCount + 1);
        setLastAutoMessageTime(avatar, now);
    }

    return triggered;
}

async function triggerMultiCharacterChime(settings) {
    const partners = settings.multi_char_names.split(',').map(name => name.trim()).filter(Boolean);
    if (!partners.length || autoWorkerBusy) {
        return false;
    }

    autoWorkerBusy = true;

    try {
        const partnerName = partners[Math.floor(Math.random() * partners.length)];
        const charName = getCurrentCharName();
        const userName = name1 || 'User';
        const transcript = formatConversationTranscript(getConversationThread()) || '(No prior DM messages.)';
        const systemPrompt = `You are ${partnerName}, chiming in on a private DM conversation between ${charName} and ${userName}. This is separate from the roleplay/story chat. Write one short, casual message that fits the latest DM context. Format your message exactly beginning with **${partnerName}:** followed by your message body.`;
        const prompt = `Conversation transcript:\n${transcript}\n\nWrite a short, engaging DM chime from ${partnerName}'s perspective.`;
        const response = await generateRaw({
            prompt,
            systemPrompt,
            responseLength: 150,
            trimNames: false,
        });

        if (response?.trim()) {
            await appendConversationMessage(response.trim(), {
                name: partnerName,
                role: 'partner',
                extra: {
                    conversation_mode_chime: true,
                },
            });
            return true;
        }
    } catch (error) {
        console.error('Multi-character chime error:', error);
    } finally {
        autoWorkerBusy = false;
    }

    return false;
}

async function checkMultiCharacterChime(avatar, settings, now) {
    if (!settings.multi_char || !settings.multi_char_names) {
        return false;
    }

    const lastUserActivity = getLastUserActivity(avatar, now);
    const idleMinutes = (now - lastUserActivity) / (60 * 1000);

    if (idleMinutes < settings.idle_limit / 2) {
        return false;
    }

    const sessionKey = getCharacterStorageKey(LAST_CHIME_SESSION_PREFIX, avatar);
    if (localStorage.getItem(sessionKey) === String(lastUserActivity)) {
        return false;
    }

    const triggered = await triggerMultiCharacterChime(settings);
    if (triggered) {
        localStorage.setItem(sessionKey, String(lastUserActivity));
        setLastAutoMessageTime(avatar, now);
    }

    return triggered;
}

async function triggerAutoCharacterChat(avatar, settings) {
    if (autoWorkerBusy) {
        return false;
    }

    // Pick another enabled pal to speak to the current character.
    const others = getConversationPals().filter((pal) => pal.character?.avatar && pal.character.avatar !== avatar);
    if (!others.length) {
        return false;
    }

    autoWorkerBusy = true;
    try {
        const partner = others[Math.floor(Math.random() * others.length)];
        const partnerName = partner.character.name || 'A friend';
        const charName = getCurrentCharName();
        const transcript = formatConversationTranscript(getConversationThread(avatar)) || '(No prior DM messages.)';
        const systemPrompt = `You are ${partnerName}, messaging ${charName} in a private group DM. This is separate from any roleplay/story chat. Write one short, natural message from ${partnerName} that continues the casual conversation or starts a friendly new topic. Begin your message exactly with **${partnerName}:** followed by the message body.`;
        const prompt = `Conversation transcript:\n${transcript}\n\nWrite a short DM from ${partnerName} talking to ${charName}.`;
        const response = await generateRaw({
            prompt,
            systemPrompt,
            responseLength: 150,
            trimNames: false,
        });

        if (response?.trim()) {
            await appendConversationMessage(response.trim(), {
                name: partnerName,
                role: 'partner',
                extra: { conversation_mode_auto_chat: true },
            });
            return true;
        }
    } catch (error) {
        console.error('Auto character chat error:', error);
    } finally {
        autoWorkerBusy = false;
    }

    return false;
}

async function checkAutoCharacterChat(avatar, settings, now) {
    if (!settings.auto_character_chat) {
        return false;
    }

    const lastUserActivity = getLastUserActivity(avatar, now);
    const idleMinutes = (now - lastUserActivity) / (60 * 1000);

    if (idleMinutes < settings.idle_limit) {
        return false;
    }

    const sessionKey = getCharacterStorageKey(LAST_AUTO_CHAT_SESSION_PREFIX, avatar);
    if (localStorage.getItem(sessionKey) === String(lastUserActivity)) {
        return false;
    }

    const triggered = await triggerAutoCharacterChat(avatar, settings);
    if (triggered) {
        localStorage.setItem(sessionKey, String(lastUserActivity));
        setLastAutoMessageTime(avatar, now);
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

    const messageText = message.mes.toLowerCase();

    for (let i = 0; i < characters.length; i++) {
        const character = characters[i];
        if (!character?.avatar) {
            continue;
        }

        const settings = getSettings(character.avatar);
        if (!settings.enabled) {
            continue;
        }

        const charName = (character.name || '').toLowerCase();
        const nameParts = charName.split(/[\s_-]+/).filter(p => p.length > 2);

        let isMentioned = false;
        if (charName && messageText.includes(charName)) {
            isMentioned = true;
        } else {
            for (const part of nameParts) {
                if (messageText.includes(part)) {
                    isMentioned = true;
                    break;
                }
            }
        }

        if (isMentioned) {
            console.log(`Conversation Mode: character ${character.name} mentioned in group chat. Triggering response...`);
            setTimeout(() => {
                // @ts-ignore
                globalThis.Generate?.('normal', { force_chid: i });
            }, 1000);
            break;
        }
    }
}

async function triggerGossipDM(characterIndex) {
    const character = characters[characterIndex];
    if (!character?.avatar) return;

    const settings = getSettings(character.avatar);
    if (!settings.enabled) return;

    const snippet = [];
    const startIdx = Math.max(0, chat.length - 6);
    for (let i = startIdx; i < chat.length; i++) {
        const msg = chat[i];
        if (msg && msg.mes && !msg.extra?.conversation_mode_auto) {
            snippet.push(`${msg.name || (msg.is_user ? 'User' : 'Character')}: ${msg.mes}`);
        }
    }

    if (!snippet.length) return;

    const chatText = snippet.join('\n');
    const directive = `[System directive: You are secretly DM'ing {{user}} to gossip or comment on the ongoing group chat. Share a juicy secret, reaction, or personal thought about what is happening in the group chat. Keep it concise, casual, and in-character. Do not send this in the group chat; this is a private DM.\n\nGroup chat context:\n${chatText}]`;

    try {
        console.log(`Generating private gossip DM from ${character.name}...`);
        const response = await generateConversationReply(directive, settings, {
            responseLength: 150,
            speakerName: character.name || 'Character',
            trimNames: true,
        });

        if (response?.trim()) {
            await postCharacterReply(response.trim(), settings, {
                extra: { conversation_mode_gossip: true, gossip_source_group: true },
            }, character.avatar);

            const count = getUnreadCount(character.avatar);
            setUnreadCount(character.avatar, count + 1);

            updateLastPreviewFromConversation(character.avatar);
            renderPalsRail();
        }
    } catch (err) {
        console.error('Error generating gossip DM:', err);
    }
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
            responseLength: 150,
            speakerName: character.name || 'Character',
            trimNames: true,
        });

        if (response?.trim()) {
            await postCharacterReply(response.trim(), settings, {
                extra: { conversation_mode_gossip: true, gossip_source_roleplay: true },
            }, avatar);

            const count = getUnreadCount(avatar);
            setUnreadCount(avatar, count + 1);

            updateLastPreviewFromConversation(avatar);
            renderPalsRail();
        }
    } catch (err) {
        console.error('Error generating roleplay DM:', err);
    }
}

async function conversationModeAutoMessageWorker() {
    if (autoWorkerBusy || conversationReplyBusy || selected_group || is_send_press) {
        return;
    }

    const avatar = getCurrentCharAvatar();
    if (!avatar) {
        return;
    }

    const settings = getSettings(avatar);
    if (!settings.enabled) {
        return;
    }

    const now = Date.now();
    const elapsedSeconds = (now - getLastAutoMessageTime(avatar)) / 1000;
    if (elapsedSeconds < settings.cooldown) {
        return;
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

    await checkAutoCharacterChat(avatar, settings, now);
}

async function handleAvailabilityAutoResponder(settings = getSettings()) {
    if (selected_group) {
        return false;
    }

    const avatar = getCurrentCharAvatar();
    if (!avatar) {
        return false;
    }

    if (!settings.enabled || !['offline', 'dnd'].includes(settings.availability)) {
        return false;
    }

    const offlineText = (settings.offline_message || DEFAULT_SETTINGS.offline_message).replace('{{char}}', getCurrentCharName());
    await appendConversationMessage(offlineText, {
        extra: {
            conversation_mode_auto_responder: true,
            availability: settings.availability,
        },
    });
    return true;
}

function handleChatChanged() {
    loadCurrentPanelSettings();
}

function bindPanelInputs() {
    bindEntryPanel();
}

function bindProsePolisher() {
    const polishButton = document.getElementById('sb_prose_polisher_but');
    if (polishButton instanceof HTMLElement && polishButton.dataset.sbConversationBound !== 'true') {
        polishButton.dataset.sbConversationBound = 'true';
        polishButton.addEventListener('click', handleProsePolish);
    }
}

function init() {
    if (initialized) {
        return;
    }

    initialized = true;
    eventSource.on(event_types.USER_MESSAGE_RENDERED, (messageId) => {
        refreshConversationInterface({ syncControls: false });
        if (selected_group) {
            checkGroupChatMention(messageId);
        }
    });
    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, () => {
        refreshConversationInterface({ syncControls: false });

        // 15% chance to trigger secret gossip DMs or roleplay side-DMs
        const roll = Math.random();
        if (roll < 0.15) {
            if (selected_group) {
                // Find group members with Conversation Mode enabled
                const enabledMembers = [];
                for (let i = 0; i < characters.length; i++) {
                    const char = characters[i];
                    if (char?.avatar) {
                        const settings = getSettings(char.avatar);
                        if (settings.enabled) {
                            enabledMembers.push(i);
                        }
                    }
                }
                if (enabledMembers.length > 0) {
                    const randomMemberIdx = enabledMembers[Math.floor(Math.random() * enabledMembers.length)];
                    setTimeout(() => void triggerGossipDM(randomMemberIdx), 2000);
                }
            } else {
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

    bindPanelInputs();
    bindProsePolisher();

    const iconBtn = document.getElementById('sbConversationWorkspaceIcon');
    if (iconBtn instanceof HTMLElement) {
        iconBtn.addEventListener('click', () => {
            const avatar = getCurrentCharAvatar();
            if (!avatar) {
                toastr.warning('Please select a character first.');
                return;
            }

            const settings = getSettings(avatar);
            if (!settings.enabled) {
                settings.enabled = true;
                saveSettings(avatar, settings);
                toastr.info(`Conversation Mode activated for ${getCurrentCharName()}.`);
            } else {
                // If already enabled, clicking the workspace icon toggles it off back to roleplay!
                settings.enabled = false;
                saveSettings(avatar, settings);
                toastr.info('Returned to Roleplay Chat.');
            }

            refreshConversationInterface({ syncControls: true });

            setTimeout(() => {
                const input = document.getElementById(settings.enabled ? CHROME_IDS.input : 'send_textarea');
                if (input instanceof HTMLTextAreaElement) {
                    input.focus();
                }
            }, 100);
        });
    }

    window.setInterval(() => void conversationModeAutoMessageWorker(), AUTO_WORKER_INTERVAL_MS);
    loadCurrentPanelSettings();
}

eventSource.on(event_types.APP_READY, init);
