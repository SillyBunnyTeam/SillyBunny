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

export const DEFAULT_GROUNDED_DIALOGUE_RULES = `### Grounded Dialogue Rules

- Replace any banned phrase, cliché, vague emotion, generic body reaction, or abstract metaphor with one concrete observable detail.

## Avoid

### Constructions and tropes
- not X, not X but Y, not quite X, litotes, negative parallelisms
- doesn't just X but Y, doesn't X; Y, they don't X
- say that again, are you sure, that does it, that lands, not a question, really looks at
- like a physical blow, like a stone into still water, predator/prey metaphors
- a promise and/or a threat, either X, Y, or both
- rule of threes, word/number counting emphasis
- A beat, A pause, starts. stops., somewhere, X...
- deletes it, types it, deletes it again
- architectural metaphors outside literal architecture
- flat tone comparisons to weather/groceries
- overexplained tone fragments like Flat. Factual.
- Your face is doing a thing
- no heat behind it, no venom behind it
- excessive em dashes

### Somatic tics
- jaw movement/tightening/working
- mouth open-close cycling
- breath catching
- knuckle whitening/pale knuckles
- burning cheeks

### Scents
- ozone, sandalwood, cedar, cardamom
- something distinctly X
- The room smells like X
- vague scent phrasing like something X, maybe X

### Nicknames
- Gremlin
- Goblin

### Human vocalizations (exception: anthros, furries, animals)
- purring
- chirping
- growling

### Audio formulas
- between an X and a Y
- half X, half Y
- makes a/an X sound
- strangled sound
- teakettle boiling

### Environmental tropes
- dust motes
- metallic tang of X

### Romantic/possessive shorthand
- Mine
- possessive romantic shorthand
- forehead-touching after kisses`;

/**
 * Conversation mode sends no `MESSAGE_SENT` and opens no chat of the app, so it announces itself on `window`.
 * Home listens for these names (Getting Started steps 3 and 4); both sides import them from here.
 */
export const CONVERSATION_MESSAGE_SENT_EVENT = 'sb:conversation-user-message-sent';
export const CONVERSATION_OPENED_EVENT = 'sb:conversation-opened';

export const WEEKDAY_LABELS = Object.freeze(['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']);
export const USER_STATUS_OPTIONS = Object.freeze(['online', 'idle', 'dnd', 'offline']);
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
export const CONVERSATION_KEY_PREFIX = 'sb_conv_thread_';
export const CONVERSATION_STORE_KEY = 'sillybunny_conversation';
export const DEFAULT_CHAT_ID = 'main';
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
export const AUTO_WORKER_WAIT_POLL_MS = 200;
export const AUTO_WORKER_INTERVAL_GLOBAL_KEY = '__sbConversationAutoWorkerIntervalId';
export const TRANSCRIPT_MESSAGE_LIMIT = 32;
export const SCHEDULE_STATUSES = Object.freeze(['online', 'idle', 'dnd', 'offline']);
export const DEFAULT_INACTIVITY_THRESHOLD = 120;
export const MIN_INACTIVITY_THRESHOLD = 15;
export const MAX_INACTIVITY_THRESHOLD = 360;
export const DEFAULT_MAX_FOLLOWUPS = 3;
export const DEFAULT_AUTO_CHAT_COOLDOWN = 10;
export const SEND_QUEUE_BATCH_MS = 900;
// SillyBunny: idle window (ms) waited after the last same-thread user send before a
// conversation reply starts generating. Five seconds gives users room to send a
// few quick follow-up messages before the character starts replying.
export const SEND_QUEUE_COALESCE_MS = 5000;
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
export const MEMBER_FOLLOWUP_RECENT_WINDOW = 6;
export const PARALLEL_CHIME_MAX_MEMBERS = 2;
export const GROUP_MAX_CONCURRENT_SPEAKERS = 2;
export const GROUP_ASIDE_CONTEXT_LIMIT = 8;
export const GROUP_ASIDE_RANDOM_CHANCE = 0.18;
export const GROUP_ASIDE_COOLDOWN_MS = 8 * 60 * 1000;
export const GROUP_ASIDE_MENTION_COOLDOWN_MS = 45 * 1000;
export const AUTO_CHAT_LAST_SENT_MARKER = 'auto_chat_at';
export const MAX_STACKED_PARTICIPANT_AVATARS = 4;
export const MEMORY_SUMMARY_MIN_MESSAGES = 24;
export const MEMORY_SUMMARY_INTERVAL_MESSAGES = 12;
export const MEMORY_SUMMARY_RECENT_MESSAGES = 36;
export const MEMORY_SUMMARY_RESPONSE_TOKENS = 32000;
export const SCHEDULE_GENERATION_RESPONSE_TOKENS = 8000;
export const SELFIE_COMMAND_RE = /\[selfie(?::\s*(?:context=)?"?([^"\]]*)"?)?\]/gi;
export const SCHEDULE_UPDATE_RE = /\[schedule_update:\s*([^\]]+)\]/gi;
export const REMINDER_COMMAND_RE = /\[reminder:\s*([^|\]]+)\s*\|\s*([^\]]+)\]/gi;
export const CHROME_IDS = Object.freeze({
    header: 'sb_conversation_header',
    listToggle: 'sb_conversation_list_toggle',
    conversationList: 'sb_conversation_list',
    listItems: 'sb_conversation_list_items',
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
    replyPreview: 'sb_conversation_reply_preview',
    send: 'sb_conversation_send',
    composerPolish: 'sb_conversation_composer_polish',
    settingsBackdrop: 'sb_conversation_settings_backdrop',
    settingsDrawer: 'sb_conversation_settings_drawer',
    railFooter: 'sb_conversation_rail_footer',
    personaPicker: 'sb_conversation_persona_picker',
    userStatusPicker: 'sb_conversation_user_status_picker',
    pickerBackdrop: 'sb_conversation_picker_backdrop',
});
export const AVAILABILITY_COPY = Object.freeze({
    online: { label: 'Online', detail: 'Available for live DM replies.' },
    idle: { label: 'Idle', detail: 'May follow up after a quiet stretch.' },
    dnd: { label: 'Do Not Disturb', detail: 'Auto-responder answers new messages.' },
    offline: { label: 'Offline', detail: 'Auto-responder answers while away.' },
});

export const DEFAULT_SETTINGS = Object.freeze({
    availability: 'online',
    offline_message: '[{{user}} is currently offline. Leave a message!]',
    proactive_messaging: false,
    inactivity_threshold: DEFAULT_INACTIVITY_THRESHOLD,
    max_followups: DEFAULT_MAX_FOLLOWUPS,
    include_related_memory: false,
    selfie_command_enabled: true,
    schedule_command_enabled: true,
    geechan_chatroom_prompt: GEECHAN_DEFAULT_PROMPT,
    custom_instructions: '',
    grounded_dialogue_rules_enabled: false,
    grounded_dialogue_rules: DEFAULT_GROUNDED_DIALOGUE_RULES,
    multi_char_names: '',
    roleplay_reactions: false,
    lorebooks_enabled: true,
    lorebook_override: '',
    connection_profile: '',
    authors_note: '',
    notifications_muted: false,
    quiet_hours_start: '',
    quiet_hours_end: '',
    simulate_reply_delay: true,
    prose_polisher: false,
    image_gen_enabled: false,
    image_gen_prompt_template: 'a photo of {{char}}, {{scene}}',
    image_gen_negative: '',
    image_gen_cooldown: 10,
    spontaneous_selfies: false,
});

export const SETTINGS_FIELDS = Object.freeze([
    { id: 'sb_conv_availability', key: 'availability', prop: 'value' },
    { id: 'sb_conv_offline_message', key: 'offline_message', prop: 'value' },
    { id: 'sb_conv_proactive_messaging', key: 'proactive_messaging', prop: 'checked' },
    { id: 'sb_conv_inactivity_threshold', key: 'inactivity_threshold', prop: 'value', type: 'number', fallback: DEFAULT_INACTIVITY_THRESHOLD, min: MIN_INACTIVITY_THRESHOLD },
    { id: 'sb_conv_max_followups', key: 'max_followups', prop: 'value', type: 'number', fallback: DEFAULT_MAX_FOLLOWUPS, min: 1 },
    { id: 'sb_conv_include_related_memory', key: 'include_related_memory', prop: 'checked' },
    { id: 'sb_conv_selfie_command_enabled', key: 'selfie_command_enabled', prop: 'checked' },
    { id: 'sb_conv_schedule_command_enabled', key: 'schedule_command_enabled', prop: 'checked' },
    { id: 'sb_conv_geechan_chatroom_prompt', key: 'geechan_chatroom_prompt', prop: 'value' },
    { id: 'sb_conv_custom_instructions', key: 'custom_instructions', prop: 'value' },
    { id: 'sb_conv_grounded_dialogue_rules_enabled', key: 'grounded_dialogue_rules_enabled', prop: 'checked' },
    { id: 'sb_conv_grounded_dialogue_rules', key: 'grounded_dialogue_rules', prop: 'value' },
    { id: 'sb_conv_multi_char_names', key: 'multi_char_names', prop: 'value' },
    { id: 'sb_conv_roleplay_reactions', key: 'roleplay_reactions', prop: 'checked' },
    { id: 'sb_conv_lorebooks_enabled', key: 'lorebooks_enabled', prop: 'checked' },
    { id: 'sb_conv_lorebook_override', key: 'lorebook_override', prop: 'value' },
    { id: 'sb_conv_connection_profile', key: 'connection_profile', prop: 'value' },
    { id: 'sb_conv_authors_note', key: 'authors_note', prop: 'value' },
    { id: 'sb_conv_notifications_muted', key: 'notifications_muted', prop: 'checked' },
    { id: 'sb_conv_prose_polisher', key: 'prose_polisher', prop: 'checked' },
    { id: 'sb_conv_image_gen_enabled', key: 'image_gen_enabled', prop: 'checked' },
    { id: 'sb_conv_image_gen_prompt_template', key: 'image_gen_prompt_template', prop: 'value' },
    { id: 'sb_conv_image_gen_negative', key: 'image_gen_negative', prop: 'value' },
    { id: 'sb_conv_image_gen_cooldown', key: 'image_gen_cooldown', prop: 'value', type: 'number', fallback: 10, min: 0 },
    { id: 'sb_conv_spontaneous_selfies', key: 'spontaneous_selfies', prop: 'checked' },
]);

/** Settings of the mode, not of a conversation: they are kept in `settings.json`, and every conversation reads the same value. */
export const GLOBAL_CONVERSATION_SETTINGS_KEYS = Object.freeze([
    'custom_instructions',
    'grounded_dialogue_rules_enabled',
    'grounded_dialogue_rules',
    'connection_profile',
    'lorebooks_enabled',
    'quiet_hours_start',
    'quiet_hours_end',
    'simulate_reply_delay',
]);
export const GLOBAL_CONVERSATION_SETTINGS_KEY_SET = new Set(GLOBAL_CONVERSATION_SETTINGS_KEYS);
export const CONVERSATION_SETTINGS_KEYS = Object.freeze(
    Object.keys(DEFAULT_SETTINGS).filter(key => !GLOBAL_CONVERSATION_SETTINGS_KEY_SET.has(key)),
);
export const SAFE_TOAST_OPTIONS = Object.freeze({ escapeHtml: true });
