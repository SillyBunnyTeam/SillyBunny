export const GEECHAN_DEFAULT_PROMPT = `{{// The main system prompt, designed for an output reminiscent of an instant messaging interface.

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

export const WEEKDAY_LABELS = Object.freeze(['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']);
export const USER_STATUS_OPTIONS = Object.freeze(['online', 'idle', 'dnd', 'offline']);
export const CONVERSATION_NOTIFICATION_PRIORITIES = Object.freeze(['normal', 'silent', 'priority']);
export const CONVERSATION_TIMELINE_CHANNELS = Object.freeze(['main', 'pinned', 'selfies', 'media', 'ooc', 'memories']);
export const CONVERSATION_REACTION_LABELS = Object.freeze({
    heart: '❤️',
    spark: '✨',
    laugh: '😂',
});
export const USER_STATUS_STORAGE_KEY = 'sb_conv_user_status';
export const PERSONA_APPENDICES_SELECTIONS_KEY = 'activeAppendices';
export const PERSONA_APPENDICES_DEFAULT_SCOPE_KEY = '__default__';

export const SETTINGS_KEY_PREFIX = 'sb_conv_settings_';
export const THREAD_KEY_PREFIX = 'sb_conv_thread_';
export const CONVERSATION_STORE_KEY = 'sillybunny_conversation';
export const GROUP_CONVERSATION_STORE_PREFIX = 'group:';
export const DEFAULT_BRANCH_ID = 'main';
export const LAST_USER_ACTIVITY_PREFIX = 'sb_conv_last_user_activity_';
export const LAST_AUTO_MESSAGE_PREFIX = 'sb_conv_last_auto_msg_';
export const LAST_SCHEDULE_TRIGGER_PREFIX = 'sb_conv_last_trigger_';
export const LAST_IDLE_SESSION_PREFIX = 'sb_conv_last_idle_session_';
export const LAST_CHIME_SESSION_PREFIX = 'sb_conv_last_chime_session_';
export const LAST_PREVIEW_PREFIX = 'sb_conv_last_preview_';
export const UNREAD_PREFIX = 'sb_conv_unread_';
export const SCHEDULE_PREFIX = 'sb_conv_schedule_';
export const FOLLOWUP_COUNT_PREFIX = 'sb_conv_followup_count_';
export const AUTO_WORKER_INTERVAL_MS = 30000;
export const AUTO_WORKER_WAIT_TIMEOUT_MS = 45000;
export const AUTO_WORKER_INTERVAL_GLOBAL_KEY = '__sbConversationAutoWorkerIntervalId';
export const MAX_THREAD_MESSAGES = 250;
export const TRANSCRIPT_MESSAGE_LIMIT = 32;
export const SCHEDULE_STATUSES = Object.freeze(['online', 'idle', 'dnd', 'offline']);
export const DEFAULT_INACTIVITY_THRESHOLD = 120;
export const MIN_INACTIVITY_THRESHOLD = 15;
export const MAX_INACTIVITY_THRESHOLD = 360;
export const DEFAULT_TALKATIVENESS = 50;
export const DEFAULT_MAX_FOLLOWUPS = 3;
export const DEFAULT_REPLY_DELAY_MULTIPLIER = 100;
export const DEFAULT_AUTO_CHAT_COOLDOWN = 10;
export const SEND_QUEUE_BATCH_MS = 900;
export const MIN_CONVERSATION_REPLY_MAX_TOKENS = 64;
export const DEFAULT_CONVERSATION_REPLY_MAX_TOKENS = 16000;
export const MAX_CONVERSATION_REPLY_MAX_TOKENS = 64000;
export const CONVERSATION_ERROR_DETAIL_MAX_LENGTH = 180;
export const STATUS_NOTICE_COOLDOWN_MS = 30 * 60 * 1000;
export const REMINDER_RETRY_DELAY_MS = 60 * 1000;
export const CONVERSATION_ATTACHMENT_MAX_FILES = 4;
export const CONVERSATION_ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024;
export const CONVERSATION_ATTACHMENT_ALLOWED_EXTENSIONS = Object.freeze([
    '.png', '.jpg', '.jpeg', '.webp', '.gif', '.avif', '.bmp',
    '.mp3', '.wav', '.ogg', '.m4a', '.flac', '.mp4', '.webm', '.mov',
    '.txt', '.md', '.markdown', '.pdf', '.epub', '.docx', '.xlsx', '.pptx',
    '.odt', '.ods', '.odp', '.json', '.csv',
]);
export const CONVERSATION_ATTACHMENT_ACCEPT = [
    'image/*', 'video/*', 'audio/*',
    ...CONVERSATION_ATTACHMENT_ALLOWED_EXTENSIONS,
].join(',');
export const PARTNER_FOLLOWUP_RECENT_WINDOW = 6;
export const PARALLEL_CHIME_MAX_PARTNERS = 2;
export const GROUP_ASIDE_CONTEXT_LIMIT = 8;
export const GROUP_ASIDE_RANDOM_CHANCE = 0.18;
export const GROUP_ASIDE_COOLDOWN_MS = 8 * 60 * 1000;
export const GROUP_ASIDE_MENTION_COOLDOWN_MS = 45 * 1000;
export const AUTO_CHAT_LAST_SENT_MARKER = 'auto_chat_at';
export const MAX_STACKED_PARTICIPANT_AVATARS = 4;
export const MEMORY_SUMMARY_MIN_MESSAGES = 24;
export const MEMORY_SUMMARY_INTERVAL_MESSAGES = 12;
export const MEMORY_SUMMARY_RECENT_MESSAGES = 36;
export const SELFIE_COMMAND_RE = /\[selfie(?::\s*(?:context=)?"?([^"\]]*)"?)?\]/gi;
export const SCHEDULE_UPDATE_RE = /\[schedule_update:\s*([^\]]+)\]/gi;
export const REMINDER_COMMAND_RE = /\[reminder:\s*([^|\]]+)\s*\|\s*([^\]]+)\]/gi;
export const CHROME_IDS = Object.freeze({
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
export const AVAILABILITY_COPY = Object.freeze({
    online: { label: 'Online', detail: 'Available for live DM replies.' },
    idle: { label: 'Idle', detail: 'May follow up after a quiet stretch.' },
    dnd: { label: 'Do Not Disturb', detail: 'Auto-responder answers new messages.' },
    offline: { label: 'Offline', detail: 'Auto-responder answers while away.' },
});

export const DEFAULT_SETTINGS = Object.freeze({
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
    include_related_memory: false,
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

export const SETTINGS_FIELDS = Object.freeze([
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
    { id: 'sb_conv_include_related_memory', key: 'include_related_memory', prop: 'checked' },
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

export const GROUP_CONVERSATION_SETTINGS_KEYS = Object.freeze([
    'proactive_messaging',
    'inactivity_threshold',
    'max_followups',
    'talkativeness',
    'reply_delay_multiplier',
    'reply_max_tokens',
    'selfie_command_enabled',
    'schedule_command_enabled',
]);
export const GROUP_CONVERSATION_SETTINGS_KEY_SET = new Set(GROUP_CONVERSATION_SETTINGS_KEYS);
export const CHARACTER_CONVERSATION_SETTINGS_KEYS = Object.freeze(
    Object.keys(DEFAULT_SETTINGS).filter(key => !GROUP_CONVERSATION_SETTINGS_KEY_SET.has(key)),
);
export const SAFE_TOAST_OPTIONS = Object.freeze({ escapeHtml: true });
