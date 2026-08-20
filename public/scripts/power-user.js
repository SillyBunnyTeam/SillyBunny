import { Fuse, Handlebars } from '../lib.js';

import {
    saveSettingsDebounced,
    scrollChatToBottom,
    characters,
    reloadMarkdownProcessor,
    reloadCurrentChat,
    getRequestHeaders,
    substituteParams,
    eventSource,
    event_types,
    getCurrentChatId,
    printCharactersDebounced,
    setCharacterId,
    setEditedMessageId,
    chat,
    getFirstDisplayedMessageId,
    showMoreMessages,
    saveSettings,
    saveChatConditional,
    setAnimationDuration,
    ANIMATION_DURATION_DEFAULT,
    setActiveGroup,
    setActiveCharacter,
    entitiesFilter,
    doNewChat,
    online_status,
    activateSendButtons,
    deactivateSendButtons,
    messageFormatting,
    extension_prompt_types,
    extension_prompt_roles,
    deleteMessage,
    settingsReady,
    updateMessageMetaBadges,
    updateMessageTokenAccounting,
    refreshMessageModelIcons,
} from '../script.js';
import { isMobile, initMovingUI, favsToHotswap } from './RossAscends-mods.js';
import { normalizeContextRetentionDepth } from './ooc-blocks.js';
import {
    groups,
    resetSelectedGroup,
} from './group-chats.js';
import {
    instruct_presets,
    loadInstructMode,
    names_behavior_types,
    selectInstructPreset,
    updateBindModelTemplatesState,
} from './instruct-mode.js';

import { getTagsList, tag_import_setting, tag_map, tag_sort_mode, tags } from './tags.js';
import { resetTokenCache, tokenizers } from './tokenizers.js';
import { BIAS_CACHE } from './logit-bias.js';
import { renderTemplateAsync } from './templates.js';

import { countOccurrences, debounce, delay, download, getFileText, getSanitizedFilename, getStringHash, isOdd, isTrueBoolean, onlyUnique, resetScrollHeight, shuffle, sortMoments, stringToRange, timestampToMoment, toggleDrawer } from './utils.js';
import { FILTER_TYPES } from './filters.js';
import { SlashCommand } from './slash-commands/SlashCommand.js';
import { ARGUMENT_TYPE, SlashCommandArgument, SlashCommandNamedArgument } from './slash-commands/SlashCommandArgument.js';
import { PARSER_FLAG } from './slash-commands/SlashCommandParser.js';
import { AUTOCOMPLETE_SELECT_KEY, AUTOCOMPLETE_STATE, AUTOCOMPLETE_WIDTH } from './autocomplete/AutoComplete.js';
import { SlashCommandEnumValue, enumTypes } from './slash-commands/SlashCommandEnumValue.js';
import { commonEnumProviders, enumIcons } from './slash-commands/SlashCommandCommonEnumsProvider.js';
import { POPUP_RESULT, POPUP_TYPE, callGenericPopup, fixToastrForDialogs } from './popup.js';
import { loadSystemPrompts } from './sysprompt.js';
import { fuzzySearchCategories } from './filters.js';
import { accountStorage } from './util/AccountStorage.js';
import { extractDominantColor, generateThemePalette, deriveBackgroundName } from './util/ThemeGenerator.js';
import { DEFAULT_REASONING_TEMPLATE, loadReasoningTemplates } from './reasoning.js';
import { bindModelTemplates } from './chat-templates.js';
import { IMAGE_OVERSWIPE, MEDIA_DISPLAY } from './constants.js';
import { t } from './i18n.js';
import { getBackgroundPath, isCustomBackgroundUrl } from './backgrounds.js';
import { setSlashCommandParserSettingsGetter } from './slash-commands/SlashCommandParserConfig.js';
import { persona_description_positions as _persona_description_positions } from './personas.js';
import { generateCustomCssWithAI, resolveCustomCssAIProfile } from './sillybunny-custom-css-ai.js';
import { populateConnectionProfileSelect } from './extensions/in-chat-agents/profile-utils.js';
import { resolveMovingUIViewportState, scaleMovingUIViewportState } from './moving-ui-viewport.js';
import { ANDROID_STREAMING_SETTING_DEFAULTS, ANDROID_STREAMING_SETTINGS_INITIALIZED_KEY, initializeAndroidStreamingSettings } from './mobile-streaming.js';

export const toastPositionClasses = [
    'toast-top-left',
    'toast-top-center',
    'toast-top-right',
    'toast-bottom-left',
    'toast-bottom-center',
    'toast-bottom-right',
];

export const MAX_CONTEXT_DEFAULT = 8192;
export const MAX_RESPONSE_DEFAULT = 2048;
const MAX_CONTEXT_UNLOCKED = 2000 * 1000;
const MAX_RESPONSE_UNLOCKED = 64 * 1024;
const unlockedMaxContextStep = 1;
const maxContextMin = 512;
const maxContextStep = 64;

const defaultStoryString = '{{#if system}}{{system}}\n{{/if}}{{#if description}}{{description}}\n{{/if}}{{#if personality}}{{char}}\'s personality: {{personality}}\n{{/if}}{{#if scenario}}Scenario: {{scenario}}\n{{/if}}{{#if persona}}{{persona}}\n{{/if}}';
const defaultExampleSeparator = '***';
const defaultChatStart = '***';
const defaultToastPosition = 'toast-top-center';
const SILLYBUNNY_PALETTE_PRESETS = Object.freeze({
    'forest-dusk': {
        label: 'Forest Dusk',
        values: {
            main_text_color: 'rgba(131, 179, 142, 1)',
            italics_text_color: 'rgba(131, 179, 142, 0.5)',
            underline_text_color: 'rgba(161, 209, 172, 1)',
            quote_text_color: 'rgba(114, 192, 144, 1)',
            blur_tint_color: 'rgba(55, 60, 63, 1)',
            chat_tint_color: 'rgba(45, 50, 53, 0.05)',
            user_mes_blur_tint_color: 'rgba(75, 80, 83, 0.9)',
            bot_mes_blur_tint_color: 'rgba(65, 70, 73, 0.9)',
            shadow_color: 'rgba(131, 179, 142, 0.4)',
            border_color: 'rgba(131, 179, 142, 0.3)',
            blur_strength: 8,
            shadow_width: 1,
        },
    },
    'forest-dawn': {
        label: 'Forest Dawn',
        values: {
            main_text_color: 'rgba(141, 161, 1, 1)',
            italics_text_color: 'rgba(141, 161, 1, 0.6)',
            underline_text_color: 'rgba(245, 125, 38, 1)',
            quote_text_color: 'rgba(53, 167, 124, 1)',
            blur_tint_color: 'rgba(253, 246, 227, 1)',
            chat_tint_color: 'rgba(244, 240, 217, 0.05)',
            user_mes_blur_tint_color: 'rgba(233, 227, 206, 0.9)',
            bot_mes_blur_tint_color: 'rgba(244, 240, 217, 0.9)',
            shadow_color: 'rgba(141, 161, 1, 0.3)',
            border_color: 'rgba(141, 161, 1, 0.25)',
            blur_strength: 8,
            shadow_width: 1,
        },
    },
    'rose-glow': {
        label: 'Rose Glow',
        values: {
            main_text_color: 'rgba(235, 188, 186, 1)',
            italics_text_color: 'rgba(235, 188, 186, 0.5)',
            underline_text_color: 'rgba(246, 193, 119, 1)',
            quote_text_color: 'rgba(156, 207, 216, 1)',
            blur_tint_color: 'rgba(25, 23, 36, 1)',
            chat_tint_color: 'rgba(20, 18, 30, 0.05)',
            user_mes_blur_tint_color: 'rgba(38, 35, 53, 0.9)',
            bot_mes_blur_tint_color: 'rgba(33, 32, 46, 0.9)',
            shadow_color: 'rgba(235, 188, 186, 0.4)',
            border_color: 'rgba(235, 188, 186, 0.3)',
            blur_strength: 8,
            shadow_width: 1,
        },
    },
});
const SILLYBUNNY_PALETTE_BINDINGS = Object.freeze([
    ['main_text_color', '#main-text-color-picker', 'main'],
    ['italics_text_color', '#italics-color-picker', 'italics'],
    ['underline_text_color', '#underline-color-picker', 'underline'],
    ['quote_text_color', '#quote-color-picker', 'quote'],
    ['blur_tint_color', '#blur-tint-color-picker', 'blurTint'],
    ['chat_tint_color', '#chat-tint-color-picker', 'chatTint'],
    ['user_mes_blur_tint_color', '#user-mes-blur-tint-color-picker', 'userMesBlurTint'],
    ['bot_mes_blur_tint_color', '#bot-mes-blur-tint-color-picker', 'botMesBlurTint'],
    ['shadow_color', '#shadow-color-picker', 'shadow'],
    ['border_color', '#border-color-picker', 'border'],
]);
const SB_ACCENT_PROFILE_SEED_VERSION = 2;
const SB_ACCENT_PROFILES_DRAWER_KEY = 'SBAccentProfilesDrawerExpanded';
const MAX_SB_ACCENT_PROFILE_NAME_LENGTH = 40;
const SILLYBUNNY_ACCENT_PROFILE_SEEDS = Object.freeze([
    { name: 'Warm Signal', quote_text_color: 'rgba(201, 198, 168, 1)', underline_text_color: 'rgba(166, 164, 147, 1)' },
    { name: 'Story Moss', quote_text_color: 'rgba(114, 192, 144, 1)', underline_text_color: 'rgba(161, 209, 172, 1)' },
    { name: 'Forest Dawn', quote_text_color: 'rgba(53, 167, 124, 1)', underline_text_color: 'rgba(245, 125, 38, 1)' },
    { name: 'Rose Glow', quote_text_color: 'rgba(156, 207, 216, 1)', underline_text_color: 'rgba(246, 193, 119, 1)' },
    { name: 'Moonlit Rose', quote_text_color: 'rgba(244, 114, 182, 1)', underline_text_color: 'rgba(251, 207, 232, 1)' },
    { name: 'Tidepool', quote_text_color: 'rgba(6, 182, 212, 1)', underline_text_color: 'rgba(125, 211, 252, 1)' },
    { name: 'Bluebell', quote_text_color: 'rgba(96, 165, 250, 1)', underline_text_color: 'rgba(191, 219, 254, 1)' },
    { name: 'Lavender Ink', quote_text_color: 'rgba(167, 139, 250, 1)', underline_text_color: 'rgba(196, 181, 253, 1)' },
    { name: 'Foxglove', quote_text_color: 'rgba(217, 70, 239, 1)', underline_text_color: 'rgba(249, 168, 212, 1)' },
    { name: 'Copper Sage', quote_text_color: 'rgba(217, 119, 6, 1)', underline_text_color: 'rgba(132, 204, 22, 1)' },
    { name: 'Ember', quote_text_color: 'rgba(239, 68, 68, 1)', underline_text_color: 'rgba(251, 146, 60, 1)' },
    { name: 'Seafoam', quote_text_color: 'rgba(45, 212, 191, 1)', underline_text_color: 'rgba(134, 239, 172, 1)' },
    { name: 'Orchid Static', quote_text_color: 'rgba(192, 132, 252, 1)', underline_text_color: 'rgba(103, 232, 249, 1)' },
    { name: 'Graphite Glow', quote_text_color: 'rgba(107, 114, 128, 1)', underline_text_color: 'rgba(209, 213, 219, 1)' },
    { name: 'Aurora Veil', quote_text_color: 'rgba(52, 211, 153, 1)', underline_text_color: 'rgba(129, 140, 248, 1)' },
    { name: 'Solar Flare', quote_text_color: 'rgba(249, 115, 22, 1)', underline_text_color: 'rgba(250, 204, 21, 1)' },
    { name: 'Mint Glass', quote_text_color: 'rgba(110, 231, 183, 1)', underline_text_color: 'rgba(167, 243, 208, 1)' },
    { name: 'Berry Stain', quote_text_color: 'rgba(190, 24, 93, 1)', underline_text_color: 'rgba(244, 114, 182, 1)' },
    { name: 'Slate Mist', quote_text_color: 'rgba(148, 163, 184, 1)', underline_text_color: 'rgba(203, 213, 225, 1)' },
    { name: 'Desert Bloom', quote_text_color: 'rgba(234, 88, 12, 1)', underline_text_color: 'rgba(244, 114, 182, 1)' },
    { name: 'Glacier', quote_text_color: 'rgba(14, 165, 233, 1)', underline_text_color: 'rgba(186, 230, 253, 1)' },
    { name: 'Coral Reef', quote_text_color: 'rgba(251, 113, 133, 1)', underline_text_color: 'rgba(45, 212, 191, 1)' },
    { name: 'Plum Wine', quote_text_color: 'rgba(126, 34, 206, 1)', underline_text_color: 'rgba(216, 180, 254, 1)' },
    { name: 'Sage Smoke', quote_text_color: 'rgba(74, 222, 128, 1)', underline_text_color: 'rgba(163, 163, 163, 1)' },
    { name: 'Lichen', quote_text_color: 'rgba(132, 204, 22, 1)', underline_text_color: 'rgba(190, 242, 100, 1)' },
    { name: 'Harvest Gold', quote_text_color: 'rgba(202, 138, 4, 1)', underline_text_color: 'rgba(253, 224, 71, 1)' },
    { name: 'Indigo Dusk', quote_text_color: 'rgba(79, 70, 229, 1)', underline_text_color: 'rgba(165, 180, 252, 1)' },
    { name: 'Pearl', quote_text_color: 'rgba(226, 232, 240, 1)', underline_text_color: 'rgba(148, 163, 184, 1)' },
    { name: 'Mango Tango', quote_text_color: 'rgba(251, 146, 60, 1)', underline_text_color: 'rgba(253, 186, 116, 1)' },
    { name: 'Neptune', quote_text_color: 'rgba(37, 99, 235, 1)', underline_text_color: 'rgba(34, 211, 238, 1)' },
]);
const THEME_COLOR_PROPERTIES = Object.freeze([
    { key: 'main_text_color', selector: '#main-text-color-picker', type: 'main' },
    { key: 'italics_text_color', selector: '#italics-color-picker', type: 'italics' },
    { key: 'underline_text_color', selector: '#underline-color-picker', type: 'underline' },
    { key: 'quote_text_color', selector: '#quote-color-picker', type: 'quote' },
    { key: 'blur_tint_color', selector: '#blur-tint-color-picker', type: 'blurTint' },
    { key: 'chat_tint_color', selector: '#chat-tint-color-picker', type: 'chatTint' },
    { key: 'user_mes_blur_tint_color', selector: '#user-mes-blur-tint-color-picker', type: 'userMesBlurTint' },
    { key: 'bot_mes_blur_tint_color', selector: '#bot-mes-blur-tint-color-picker', type: 'botMesBlurTint' },
    { key: 'shadow_color', selector: '#shadow-color-picker', type: 'shadow' },
    { key: 'border_color', selector: '#border-color-picker', type: 'border' },
]);

const THEME_EFFECT_PROPERTIES = Object.freeze([
    { key: 'customCSS-bg-blur', selector: '#background_blur', counterSelector: '#background_blur_counter', cssVar: '--customCSS-bg-blur', defaultValue: 0, min: 0, max: 10 },
    { key: 'customCSS-bg-opacity', selector: '#background_opacity', counterSelector: '#background_opacity_counter', cssVar: '--customCSS-bg-opacity', defaultValue: 1, min: 0, max: 1 },
    { key: 'sheldBlurStrength', selector: '#sheld_blur_strength', counterSelector: '#sheld_blur_strength_counter', cssVar: '--sheldBlurStrength', linkedCssVars: ['--mobileSheldBlurStrength'], defaultValue: 0, min: 0, max: 10 },
    { key: 'sheldBackgroundColor', cssVar: '--sheldBackgroundColor', defaultValue: 'transparent' },
]);

const avatar_styles = {
    ROUND: 0,
    RECTANGULAR: 1,
    SQUARE: 2,
    ROUNDED: 3,
};

export const chat_styles = Object.freeze({
    DEFAULT: 0,
    BUBBLES: 1,
    DOCUMENT: 2,
    // SillyBunny: native fork-only chat display styles kept compatible with Moonlit Echoes body classes.
    ECHO: 3,
    WHISPER: 4,
    HUSH: 5,
    RIPPLE: 6,
    TIDE: 7,
});

const CHAT_STYLE_BODY_CLASSES = Object.freeze({
    [chat_styles.DEFAULT]: 'flatchat',
    [chat_styles.BUBBLES]: 'bubblechat',
    [chat_styles.DOCUMENT]: 'documentstyle',
    [chat_styles.ECHO]: 'echostyle',
    [chat_styles.WHISPER]: 'whisperstyle',
    [chat_styles.HUSH]: 'hushstyle',
    [chat_styles.RIPPLE]: 'ripplestyle',
    [chat_styles.TIDE]: 'tidestyle',
});

const LEGACY_CHAT_STYLE_BODY_CLASSES = Object.freeze([]);
const NATIVE_CHAT_STYLE_STYLESHEET_ID = 'sillybunny-native-chat-styles';
const NATIVE_CHAT_STYLE_STYLESHEET_HREF = 'css/sillybunny-chat-styles.css?v=20260606a';

function ensureNativeChatStyleStylesheet() {
    if (document.getElementById(NATIVE_CHAT_STYLE_STYLESHEET_ID)) {
        return;
    }

    const link = document.createElement('link');
    link.id = NATIVE_CHAT_STYLE_STYLESHEET_ID;
    link.rel = 'stylesheet';
    link.type = 'text/css';
    link.href = NATIVE_CHAT_STYLE_STYLESHEET_HREF;

    const themeStylesheet = document.querySelector('link[href^="css/sillybunny-theme.css"]');
    if (themeStylesheet) {
        themeStylesheet.after(link);
        return;
    }

    document.head.appendChild(link);
}

function isValidChatDisplayValue(value) {
    return Number.isInteger(value) && Object.hasOwn(CHAT_STYLE_BODY_CLASSES, value);
}

export const send_on_enter_options = {
    DISABLED: -1,
    AUTO: 0,
    ENABLED: 1,
};

export const persona_description_positions = _persona_description_positions;

export const power_user = {
    charListGrid: false,
    tokenizer: tokenizers.BEST_MATCH,
    token_padding: 64,
    collapse_newlines: false,
    pin_examples: false,
    strip_examples: false,
    trim_sentences: false,
    always_force_name2: false,
    user_prompt_bias: '',
    show_user_prompt_bias: true,
    auto_continue: {
        enabled: false,
        allow_chat_completions: false,
        target_length: 400,
    },
    markdown_escape_strings: '',
    chat_truncation: 100,
    ooc_context_depth: -1,
    html_context_depth: -1,
    streaming_fps: 30,
    smooth_streaming: false,
    smooth_streaming_no_think: false,
    smooth_streaming_speed: 50,
    stream_fade_in: false,
    ios_webkit_conservative_streaming: true,
    ios_webkit_reduce_streaming_work: true,
    ios_webkit_disable_smooth_streaming: true,
    ios_webkit_disable_stream_fade_in: true,
    ...ANDROID_STREAMING_SETTING_DEFAULTS,
    [ANDROID_STREAMING_SETTINGS_INITIALIZED_KEY]: true,

    // SillyBunny: aggressive DOM unloading for low-memory devices
    aggressive_dom_unload: false,
    aggressive_dom_window_size: 5,

    fast_ui_mode: true,
    avatar_style: avatar_styles.ROUND,
    chat_display: chat_styles.DEFAULT,
    toastr_position: defaultToastPosition,
    chat_width: 100,
    never_resize_avatars: false,
    show_card_avatar_urls: false,
    play_message_sound: false,
    play_sound_unfocused: true,
    auto_save_msg_edits: false,
    confirm_message_delete: true,

    sort_field: 'name',
    sort_order: 'asc',
    sort_rule: null,
    font_scale: 1,
    line_spacing: 1.2, // SillyBunny: chat message line-spacing slider.
    message_margin_size: 1, // SillyBunny: chat message margin-size slider.
    blur_strength: 10,
    shadow_width: 2,
    'customCSS-bg-blur': 0,
    'customCSS-bg-opacity': 1,
    sheldBlurStrength: 0,
    mobileSheldBlurStrength: 0,
    sheldBackgroundColor: 'transparent',

    main_text_color: `${getComputedStyle(document.documentElement).getPropertyValue('--SmartThemeBodyColor').trim()}`,
    italics_text_color: `${getComputedStyle(document.documentElement).getPropertyValue('--SmartThemeEmColor').trim()}`,
    underline_text_color: `${getComputedStyle(document.documentElement).getPropertyValue('--SmartThemeUnderlineColor').trim()}`,
    quote_text_color: `${getComputedStyle(document.documentElement).getPropertyValue('--SmartThemeQuoteColor').trim()}`,
    sb_accent_profiles: SILLYBUNNY_ACCENT_PROFILE_SEEDS.map(profile => ({ ...profile })),
    sb_accent_profiles_seed_version: SB_ACCENT_PROFILE_SEED_VERSION,
    blur_tint_color: `${getComputedStyle(document.documentElement).getPropertyValue('--SmartThemeBlurTintColor').trim()}`,
    chat_tint_color: `${getComputedStyle(document.documentElement).getPropertyValue('--SmartThemeChatTintColor').trim()}`,
    user_mes_blur_tint_color: `${getComputedStyle(document.documentElement).getPropertyValue('--SmartThemeUserMesBlurTintColor').trim()}`,
    bot_mes_blur_tint_color: `${getComputedStyle(document.documentElement).getPropertyValue('--SmartThemeBotMesBlurTintColor').trim()}`,
    shadow_color: `${getComputedStyle(document.documentElement).getPropertyValue('--SmartThemeShadowColor').trim()}`,
    border_color: `${getComputedStyle(document.documentElement).getPropertyValue('--SmartThemeBorderColor').trim()}`,

    custom_css: '',
    google_font: '',

    waifuMode: false,
    movingUI: false,
    movingUIState: {},
    movingUIPreset: '',
    noShadows: false,
    theme: 'Dark V 1.0',

    gestures: true,
    auto_swipe: false,
    auto_swipe_minimum_length: 0,
    auto_swipe_blacklist: [],
    auto_swipe_blacklist_threshold: 2,
    auto_scroll_chat_to_bottom: true,
    auto_fix_generated_markdown: true,
    auto_clear_cache_on_update: true,
    send_on_enter: send_on_enter_options.AUTO,
    console_log_prompts: false,
    prompt_manager_drag_locked: true,
    request_token_probabilities: false,
    show_group_chat_queue: false,
    allow_name1_display: false,
    allow_name2_display: false,
    hotswap_enabled: true,
    timer_enabled: true,
    timestamps_enabled: true,
    timestamp_model_icon: false,
    timestamp_model_name: false,
    timestamp_reasoning_effort: false,
    mesIDDisplay_enabled: false,
    hideChatAvatars_enabled: false,
    max_context_unlocked: true,
    message_token_count_enabled: false,
    expand_message_actions: false,
    enableZenSliders: false,
    enableLabMode: false,
    prefer_character_prompt: true,
    prefer_character_jailbreak: true,
    quick_continue: false,
    quick_impersonate: false,
    continue_on_send: false,
    trim_spaces: true,
    relaxed_api_urls: false,
    world_import_dialog: true,
    enable_auto_select_input: false,
    enable_md_hotkeys: false,
    tag_import_setting: tag_import_setting.ASK,
    tag_sort_mode: tag_sort_mode.MANUAL,
    disable_group_trimming: false,
    single_line: false,

    instruct: {
        enabled: false,
        preset: 'Alpaca',
        input_sequence: '### Instruction:',
        input_suffix: '',
        output_sequence: '### Response:',
        output_suffix: '',
        system_sequence: '',
        system_suffix: '',
        last_system_sequence: '',
        first_input_sequence: '',
        first_output_sequence: '',
        last_input_sequence: '',
        last_output_sequence: '',
        story_string_prefix: '',
        story_string_suffix: '',
        stop_sequence: '',
        wrap: true,
        macro: true,
        names_behavior: names_behavior_types.FORCE,
        activation_regex: '',
        bind_to_context: false,
        user_alignment_message: '',
        system_same_as_user: false,
        /** @deprecated Use output_suffix instead */
        separator_sequence: '',
        sequences_as_stop_strings: true,
    },

    context: {
        preset: 'Default',
        story_string: defaultStoryString,
        chat_start: defaultChatStart,
        example_separator: defaultExampleSeparator,
        use_stop_strings: true,
        names_as_stop_strings: true,
        story_string_position: extension_prompt_types.IN_PROMPT,
        story_string_role: extension_prompt_roles.SYSTEM,
        story_string_depth: 1,
    },

    instruct_derived: false,
    context_derived: false,
    context_size_derived: false,
    /** User-defined model identifier / chat template hash to instruct/context template mappings */
    model_templates_mappings: {},
    /** The chat template hash of the currently loaded model, if any; used when deriving mappings */
    chat_template_hash: '',

    sysprompt: {
        enabled: true,
        name: 'Neutral - Chat',
        content: 'Write {{char}}\'s next reply in a fictional chat between {{char}} and {{user}}.',
        post_history: '',
    },

    reasoning: {
        name: DEFAULT_REASONING_TEMPLATE,
        auto_parse: false,
        add_to_prompts: false,
        auto_expand: false,
        show_hidden: false,
        prefix: '<think>',
        suffix: '</think>',
        separator: '\n',
        max_additions: 1,
    },

    personas: {},
    default_persona: null,
    persona_descriptions: {},

    persona_description: '',
    persona_description_position: persona_description_positions.IN_PROMPT,
    persona_description_role: 0,
    persona_description_depth: 2,
    persona_description_lorebook: '',
    persona_show_notifications: true,
    persona_sort_order: 'asc',

    custom_stopping_strings: '',
    custom_stopping_strings_macro: true,
    fuzzy_search: false,
    encode_tags: false,
    experimental_macro_engine: true,
    servers: [],
    bogus_folders: false,
    zoomed_avatar_magnification: false,
    show_tag_filters: false,
    aux_field: 'character_version',
    stscript: {
        matching: 'fuzzy',
        autocomplete: {
            state: AUTOCOMPLETE_STATE.ALWAYS,
            autoHide: false,
            style: 'theme',
            font: {
                scale: 0.8,
            },
            width: {
                left: AUTOCOMPLETE_WIDTH.CHAT,
                right: AUTOCOMPLETE_WIDTH.CHAT,
            },
            select: AUTOCOMPLETE_SELECT_KEY.TAB + AUTOCOMPLETE_SELECT_KEY.ENTER,
            /** Whether to show macro autocomplete in all macro-enabled fields (not just expanded editors) */
            showInAllMacroFields: false,
        },
        parser: {
            /**@type {Object.<PARSER_FLAG,boolean>} */
            flags: {},
        },
    },
    restore_user_input: true,
    reduced_motion: false,
    compact_input_area: true,
    show_swipe_num_all_messages: false,
    auto_connect: false,
    auto_load_chat: false,
    forbid_external_media: true,
    allow_card_scripts: false,
    external_media_allowed_overrides: [],
    external_media_forbidden_overrides: [],
    pin_styles: true,
    click_to_edit: false,
    media_display: MEDIA_DISPLAY.LIST,
    image_overswipe: IMAGE_OVERSWIPE.GENERATE,
};

setSlashCommandParserSettingsGetter(() => ({
    experimentalMacroEngine: power_user.experimental_macro_engine,
    flags: power_user.stscript?.parser?.flags ?? {},
}));

let themes = [];
let movingUIPresets = [];
/** @type {ContextSettings[]} */
export let context_presets = [];
let customThemeStyleEntries = {};

const storage_keys = {
    storyStringValidationCache: 'StoryStringValidationCache',
};

const contextControls = [
    // Power user context scoped settings
    { id: 'context_story_string', property: 'story_string', isCheckbox: false, isGlobalSetting: false },
    { id: 'context_example_separator', property: 'example_separator', isCheckbox: false, isGlobalSetting: false },
    { id: 'context_chat_start', property: 'chat_start', isCheckbox: false, isGlobalSetting: false },
    { id: 'context_use_stop_strings', property: 'use_stop_strings', isCheckbox: true, isGlobalSetting: false, defaultValue: false },
    { id: 'context_names_as_stop_strings', property: 'names_as_stop_strings', isCheckbox: true, isGlobalSetting: false, defaultValue: true },
    { id: 'context_story_string_position', property: 'story_string_position', isCheckbox: false, isGlobalSetting: false, defaultValue: extension_prompt_types.IN_PROMPT, trigger: true },
    { id: 'context_story_string_depth', property: 'story_string_depth', isCheckbox: false, isGlobalSetting: false, defaultValue: 1 },
    { id: 'context_story_string_role', property: 'story_string_role', isCheckbox: false, isGlobalSetting: false, defaultValue: extension_prompt_roles.SYSTEM },

    // Existing power user settings
    { id: 'always-force-name2-checkbox', property: 'always_force_name2', isCheckbox: true, isGlobalSetting: true, defaultValue: true },
    { id: 'trim_sentences_checkbox', property: 'trim_sentences', isCheckbox: true, isGlobalSetting: true, defaultValue: false },
    { id: 'single_line', property: 'single_line', isCheckbox: true, isGlobalSetting: true, defaultValue: false },
];

let browser_has_focus = true;
const debug_functions = [];

const setHotswapsDebounced = debounce(favsToHotswap);

/**
 * Plays the message sound if enabled in power user settings.
 * Passes through the `force` parameter to override settings.
 * @param {object} [param] Arguments object.
 * @param {boolean} [param.force] Whether to force play the sound.
 * @returns {void}
 */
export function playMessageSound({ force } = {}) {
    if (!power_user.play_message_sound && !force) {
        return;
    }

    if (power_user.play_sound_unfocused && browser_has_focus && !force) {
        return;
    }

    const audio = document.getElementById('audio_message_sound');
    if (audio instanceof HTMLAudioElement) {
        audio.volume = 0.8;
        audio.pause();
        audio.currentTime = 0;
        audio.play();
    }
}

/**
 * Replaces consecutive newlines with a single newline.
 * @param {string} x String to be processed.
 * @returns {string} Processed string.
 * @example
 * collapseNewlines("\n\n\n"); // "\n"
 */
export function collapseNewlines(x) {
    return x.replaceAll(/\n+/g, '\n');
}

/**
 * Fix formatting problems in markdown.
 * @param {string} text Text to be processed.
 * @param {boolean} forDisplay Whether the text is being processed for display.
 * @returns {string} Processed text.
 * @example
 * "^example * text*\n" // "^example *text*\n"
 *  "^*example * text\n"// "^*example* text\n"
 * "^example *text *\n" // "^example *text*\n"
 * "^* example * text\n" // "^*example* text\n"
 * // take note that the side you move the asterisk depends on where its pairing is
 * // i.e. both of the following strings have the same broken asterisk ' * ',
 * // but you move the first to the left and the second to the right, to match the non-broken asterisk
 * "^example * text*\n" // "^*example * text\n"
 * // and you HAVE to handle the cases where multiple pairs of asterisks exist in the same line
 * "^example * text* * harder problem *\n" // "^example *text* *harder problem*\n"
 */
export function fixMarkdown(text, forDisplay) {
    // Find pairs of formatting characters and capture the text in between them
    const format = /([*_]{1,2})([\s\S]*?)\1/gm;
    let matches = [];
    let match;
    while ((match = format.exec(text)) !== null) {
        matches.push(match);
    }

    // Iterate through the matches and replace adjacent spaces immediately beside formatting characters
    let newText = text;
    for (let i = matches.length - 1; i >= 0; i--) {
        let matchText = matches[i][0];
        let replacementText = matchText.replace(/(\*|_)([\t \u00a0\u1680\u2000-\u200a\u202f\u205f\u3000\ufeff]+)|([\t \u00a0\u1680\u2000-\u200a\u202f\u205f\u3000\ufeff]+)(\*|_)/g, '$1$4');
        newText = newText.slice(0, matches[i].index) + replacementText + newText.slice(matches[i].index + matchText.length);
    }

    // Don't auto-fix asterisks if this is a message clean-up procedure.
    // It botches the continue function. Apply this to display only.
    if (!forDisplay) {
        return newText;
    }

    const splitText = newText.split('\n');

    // Fix asterisks, and quotes that are not paired
    for (let index = 0; index < splitText.length; index++) {
        const line = splitText[index];
        const charsToCheck = ['*', '"'];
        for (const char of charsToCheck) {
            if (line.includes(char) && isOdd(countOccurrences(line, char))) {
                splitText[index] = line.trimEnd() + char;
            }
        }
    }

    newText = splitText.join('\n');

    return newText;
}

function switchHotswap() {
    $('body').toggleClass('no-hotswap', !power_user.hotswap_enabled);
    $('#hotswapEnabled').prop('checked', power_user.hotswap_enabled);
}

function switchTimer() {
    $('body').toggleClass('no-timer', !power_user.timer_enabled);
    $('#messageTimerEnabled').prop('checked', power_user.timer_enabled);
}

function switchTimestamps() {
    $('body').toggleClass('no-timestamps', !power_user.timestamps_enabled);
    $('#messageTimestampsEnabled').prop('checked', power_user.timestamps_enabled);
}

function switchIcons() {
    $('body').toggleClass('no-modelIcons', !power_user.timestamp_model_icon);
    $('#messageModelIconEnabled').prop('checked', power_user.timestamp_model_icon);
}

function switchTokenCount() {
    $('body').toggleClass('no-tokenCount', !power_user.message_token_count_enabled);
    $('#messageTokensEnabled').prop('checked', power_user.message_token_count_enabled);
}

let tokenizationCacheRefreshId = 0;

async function refreshTokenizationCachesForSettingsChange() {
    const refreshId = ++tokenizationCacheRefreshId;

    await resetTokenCache({ toast: false });

    let hasChatTokenCounts = false;
    for (const message of chat) {
        if (!message || typeof message !== 'object') {
            continue;
        }

        if (message.extra && Object.hasOwn(message.extra, 'token_count')) {
            delete message.extra.token_count;
            hasChatTokenCounts = true;
        }

        if (!Array.isArray(message.swipe_info)) {
            continue;
        }

        for (const swipeInfo of message.swipe_info) {
            if (swipeInfo?.extra && Object.hasOwn(swipeInfo.extra, 'token_count')) {
                delete swipeInfo.extra.token_count;
                hasChatTokenCounts = true;
            }
        }
    }

    if (refreshId !== tokenizationCacheRefreshId) {
        return;
    }

    if (power_user.message_token_count_enabled) {
        for (const [messageId, message] of chat.entries()) {
            if (!message || typeof message !== 'object') {
                continue;
            }

            await updateMessageTokenAccounting(message, { countOutput: true });
            if (refreshId !== tokenizationCacheRefreshId) {
                return;
            }

            updateMessageMetaBadges($(`#chat .mes[mesid="${messageId}"]`), message);
        }
        hasChatTokenCounts = true;
    } else {
        $('#chat .tokenCounterDisplay').text('');
    }

    if (hasChatTokenCounts) {
        await saveChatConditional();
    }
}

function resetTokenizationCachesForSettingsChange() {
    void refreshTokenizationCachesForSettingsChange().catch(error => {
        console.error('Failed to refresh token counts after tokenizer settings changed', error);
    });
}

function switchMesIDDisplay() {
    $('body').toggleClass('no-mesIDDisplay', !power_user.mesIDDisplay_enabled);
    $('#mesIDDisplayEnabled').prop('checked', power_user.mesIDDisplay_enabled);
}

function switchHideChatAvatars() {
    $('body').toggleClass('hideChatAvatars', power_user.hideChatAvatars_enabled);
    $('#hideChatAvatarsEnabled').prop('checked', power_user.hideChatAvatars_enabled);
}

function switchMessageActions() {
    $('body').toggleClass('expandMessageActions', power_user.expand_message_actions);
    $('#expandMessageActions').prop('checked', power_user.expand_message_actions);
    $('.extraMesButtons, .extraMesButtonsHint').removeAttr('style');
}

function switchReducedMotion() {
    const osReduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (osReduced) {
        power_user.reduced_motion = true;
    }
    jQuery.fx.off = power_user.reduced_motion;
    const overrideDuration = power_user.reduced_motion ? 0 : ANIMATION_DURATION_DEFAULT;
    setAnimationDuration(overrideDuration);
    $('#reduced_motion').prop('checked', power_user.reduced_motion);
    $('#reduced_motion').prop('disabled', osReduced);
    $('#reduced_motion').closest('label').attr('title',
        osReduced
            ? t`Controlled by your operating system's reduced motion setting`
            : t`Disable animations and transitions`,
    );
    $('body').toggleClass('reduced-motion', power_user.reduced_motion);
}

function switchCompactInputArea() {
    $('#send_form').toggleClass('compact', power_user.compact_input_area);
    $('#compact_input_area').prop('checked', power_user.compact_input_area);
}

function switchSwipeNumAllMessages() {
    $('#show_swipe_num_all_messages').prop('checked', power_user.show_swipe_num_all_messages);
    $('body').toggleClass('swipeAllMessages', !!power_user.show_swipe_num_all_messages);
}

var originalSliderValues = [];

async function switchLabMode({ noReset = false } = {}) {
    /*     if (power_user.enableZenSliders && power_user.enableLabMode) {
            toastr.warning("Can't start Lab Mode while Zen Sliders are active")
            return
            //$("#enableZenSliders").trigger('click')
        }
     */
    await delay(100);
    $('body').toggleClass('enableLabMode', power_user.enableLabMode);
    $('#enableLabMode').prop('checked', power_user.enableLabMode);

    if (power_user.enableLabMode) {
        //save all original slider values into an array
        $('#advanced-ai-config-block input').each(function () {
            let id = $(this).attr('id');
            let min = $(this).attr('min');
            let max = $(this).attr('max');
            let step = $(this).attr('step');
            originalSliderValues.push({ id, min, max, step });
        });
        //console.log(originalSliderValues)
        //remove limits on all inputs and hide sliders
        $('#advanced-ai-config-block input')
            .attr('min', '-99999')
            .attr('max', '99999')
            .attr('step', '0.001');
        $('#labModeWarning').removeClass('displayNone');
        //$("#advanced-ai-config-block input[type='range']").hide()

        $('#amount_gen_counter').attr('min', '1')
            .attr('max', '99999')
            .attr('step', '1');
        $('#amount_gen').attr('min', '1')
            .attr('max', '99999')
            .attr('step', '1');
    } else if (!noReset) {
        //re apply the original sliders values to each input
        originalSliderValues.forEach(function (slider) {
            $('#' + slider.id)
                .attr('min', slider.min)
                .attr('max', slider.max)
                .attr('step', slider.step)
                .trigger('input');
        });
        $('#advanced-ai-config-block input[type=\'range\']').show();
        $('#labModeWarning').addClass('displayNone');

        // To set the correct amount_gen back, we just call the function calculating it correctly
        switchMaxContextSize();
    }
}

async function switchZenSliders() {
    await delay(100);
    $('body').toggleClass('enableZenSliders', power_user.enableZenSliders);
    $('#enableZenSliders').prop('checked', power_user.enableZenSliders);

    if (power_user.enableZenSliders) {
        $('#clickSlidersTips').hide();
        $('#pro-settings-block input[type=\'number\']').hide();
        //hide number inputs that are not 'seed' inputs
        $(`#textgenerationwebui_api-settings :input[type='number']:not([id^='seed']):not([id^='n_']),
            #kobold_api-settings :input[type='number']:not([id^='seed'])`).hide();
        //hide original sliders
        $(`#textgenerationwebui_api-settings input[type='range'],
            #kobold_api-settings input[type='range'],
            #pro-settings-block input[type='range']:not(#max_context)`) //exclude max context because its creation is handled by switchMaxContext()
            .hide()
            .each(function () {
                //make a zen slider for each original slider
                CreateZenSliders($(this));
            });
        //this is for when zensliders is toggled after pageload
        switchMaxContextSize();
    } else {
        $('#clickSlidersTips').show();
        revertOriginalSliders();
    }

    function revertOriginalSliders() {
        $('#pro-settings-block input[type=\'number\']').show();
        $(`#textgenerationwebui_api-settings input[type='number'],
            #kobold_api-settings input[type='number']`).show();
        $(`#textgenerationwebui_api-settings input[type='range'],
            #kobold_api-settings input[type='range'],
            #pro-settings-block input[type='range']`).each(function () {
            $(this).show();
        });
        $('div[id$="_zenslider"]').remove();
    }
}
async function CreateZenSliders(elmnt) {
    var originalSlider = elmnt;
    var sliderID = originalSlider.attr('id');
    var sliderMin = Number(originalSlider.attr('min'));
    var sliderMax = Number(originalSlider.attr('max'));
    var sliderValue = originalSlider.val();
    var sliderRange = sliderMax - sliderMin;
    var numSteps = 20;
    var decimals = 2;
    var offVal, allVal;
    var stepScale;
    var steps;
    if (sliderID == 'amount_gen') {
        decimals = 0;
        steps = [16, 50, 100, 150, 200, 256, 300, 400, 512, 1024];
        sliderMin = 0;
        sliderMax = steps.length - 1;
        stepScale = 1;
        numSteps = 10;
        sliderValue = steps.indexOf(Number(sliderValue));
        if (sliderValue === -1) { sliderValue = 4; } // default to '200' if origSlider has value we can't use
    }
    if (sliderID == 'rep_pen_range_textgenerationwebui') {
        if (power_user.max_context_unlocked) {
            steps = [0, 256, 512, 768, 1024, 2048, 4096, 8192, 16355, 24576, 32768, 49152, 65536, -1];
            numSteps = 13;
            allVal = 13;
        } else {
            steps = [0, 256, 512, 768, 1024, 2048, 4096, 8192, -1];
            numSteps = 8;
            allVal = 8;
        }
        decimals = 0;
        offVal = 0;
        sliderMin = 0;
        sliderMax = steps.length - 1;
        stepScale = 1;
        sliderValue = steps.indexOf(Number(sliderValue));
        if (sliderValue === -1) { sliderValue = allVal; } // default to allValue if origSlider has value we can't use
    }
    //customize decimals
    if (sliderID == 'max_context' ||
        sliderID == 'mirostat_mode_textgenerationwebui' ||
        sliderID == 'mirostat_tau_textgenerationwebui' ||
        sliderID == 'top_k_textgenerationwebui' ||
        sliderID == 'num_beams_textgenerationwebui' ||
        sliderID == 'no_repeat_ngram_size_textgenerationwebui' ||
        sliderID == 'min_length_textgenerationwebui' ||
        sliderID == 'top_k' ||
        sliderID == 'mirostat_mode_kobold' ||
        sliderID == 'rep_pen_range' ||
        sliderID == 'dry_allowed_length_textgenerationwebui' ||
        sliderID == 'rep_pen_decay_textgenerationwebui' ||
        sliderID == 'dry_penalty_last_n_textgenerationwebui' ||
        sliderID == 'max_tokens_second_textgenerationwebui') {
        decimals = 0;
    }
    if (sliderID == 'min_temp_textgenerationwebui' ||
        sliderID == 'max_temp_textgenerationwebui' ||
        sliderID == 'smoothing_curve_textgenerationwebui' ||
        sliderID == 'smoothing_factor_textgenerationwebui' ||
        sliderID == 'dry_multiplier_textgenerationwebui' ||
        sliderID == 'dry_base_textgenerationwebui') {
        decimals = 2;
    }
    if (sliderID == 'eta_cutoff_textgenerationwebui' ||
        sliderID == 'epsilon_cutoff_textgenerationwebui') {
        numSteps = 50;
        decimals = 1;
    }
    if (sliderID == 'nsigma') {
        numSteps = 50;
        decimals = 1;
    }
    //customize steps
    if (sliderID == 'mirostat_mode_textgenerationwebui' ||
        sliderID == 'mirostat_mode_kobold') {
        numSteps = 2;
    }
    if (sliderID == 'encoder_rep_pen_textgenerationwebui') {
        numSteps = 14;
    }
    if (sliderID == 'max_context') {
        numSteps = 15;
    }
    if (sliderID == 'mirostat_tau_textgenerationwebui' ||
        sliderID == 'top_k_textgenerationwebui' ||
        sliderID == 'num_beams_textgenerationwebui' ||
        sliderID == 'no_repeat_ngram_size_textgenerationwebui' ||
        sliderID == 'epsilon_cutoff_textgenerationwebui' ||
        sliderID == 'tfs_textgenerationwebui' ||
        sliderID == 'min_p_textgenerationwebui' ||
        sliderID == 'temp_textgenerationwebui' ||
        sliderID == 'temp') {
        numSteps = 20;
    }
    if (sliderID == 'mirostat_eta_textgenerationwebui' ||
        sliderID == 'penalty_alpha_textgenerationwebui' ||
        sliderID == 'length_penalty_textgenerationwebui' ||
        sliderID == 'min_temp_textgenerationwebui' ||
        sliderID == 'max_temp_textgenerationwebui') {
        numSteps = 50;
    }
    //customize off values
    if (sliderID == 'presence_pen_textgenerationwebui' ||
        sliderID == 'freq_pen_textgenerationwebui' ||
        sliderID == 'mirostat_mode_textgenerationwebui' ||
        sliderID == 'mirostat_mode_kobold' ||
        sliderID == 'mirostat_tau_textgenerationwebui' ||
        sliderID == 'mirostat_tau_kobold' ||
        sliderID == 'mirostat_eta_textgenerationwebui' ||
        sliderID == 'mirostat_eta_kobold' ||
        sliderID == 'min_p_textgenerationwebui' ||
        sliderID == 'min_p' ||
        sliderID == 'no_repeat_ngram_size_textgenerationwebui' ||
        sliderID == 'penalty_alpha_textgenerationwebui' ||
        sliderID == 'length_penalty_textgenerationwebui' ||
        sliderID == 'epsilon_cutoff_textgenerationwebui' ||
        sliderID == 'nsigma' ||
        sliderID == 'rep_pen_range' ||
        sliderID == 'eta_cutoff_textgenerationwebui' ||
        sliderID == 'top_a_textgenerationwebui' ||
        sliderID == 'top_a' ||
        sliderID == 'top_k_textgenerationwebui' ||
        sliderID == 'top_k' ||
        sliderID == 'rep_pen_slope' ||
        sliderID == 'smoothing_factor_textgenerationwebui' ||
        sliderID == 'smoothing_curve_textgenerationwebui' ||
        sliderID == 'skew_textgenerationwebui' ||
        sliderID == 'dry_multiplier_textgenerationwebui' ||
        sliderID == 'min_length_textgenerationwebui') {
        offVal = 0;
    }
    if (sliderID == 'rep_pen_textgenerationwebui' ||
        sliderID == 'rep_pen' ||
        sliderID == 'tfs_textgenerationwebui' ||
        sliderID == 'tfs' ||
        sliderID == 'top_p_textgenerationwebui' ||
        sliderID == 'top_p' ||
        sliderID == 'typical_p_textgenerationwebui' ||
        sliderID == 'typical_p' ||
        sliderID == 'encoder_rep_pen_textgenerationwebui' ||
        sliderID == 'temp_textgenerationwebui' ||
        sliderID == 'temp' ||
        sliderID == 'min_temp_textgenerationwebui' ||
        sliderID == 'max_temp_textgenerationwebui' ||
        sliderID == 'dynatemp_exponent_textgenerationwebui' ||
        sliderID == 'guidance_scale_textgenerationwebui' ||
        sliderID == 'rep_pen_slope_textgenerationwebui' ||
        sliderID == 'guidance_scale') {
        offVal = 1;
    }
    if (sliderID == 'guidance_scale_textgenerationwebui') {
        numSteps = 78;
    }
    if (sliderID == 'top_k_textgenerationwebui') {
        sliderMin = 0;
    }
    //customize amt gen steps
    if (sliderID !== 'amount_gen' && sliderID !== 'rep_pen_range_textgenerationwebui') {
        stepScale = sliderRange / numSteps;
    }
    var newSlider = $('<div>')
        .attr('id', `${sliderID}_zenslider`)
        .css('width', '100%')
        .insertBefore(originalSlider);
    newSlider.slider({
        value: sliderValue,
        step: stepScale,
        min: sliderMin,
        max: sliderMax,
        create: async function () {
            await delay(100);
            var handle = $(this).find('.ui-slider-handle');
            var handleText, stepNumber, leftMargin;

            //handling creation of amt_gen
            if (newSlider.attr('id') == 'amount_gen_zenslider') {
                handleText = steps[sliderValue];
                stepNumber = sliderValue;
                leftMargin = ((stepNumber) / numSteps) * 50 * -1;
                handle.text(handleText)
                    .css('margin-left', `${leftMargin}px`);
                //console.log(`${newSlider.attr('id')} initial value:${handleText}, stepNum:${stepNumber}, numSteps:${numSteps}, left-margin:${leftMargin}`)
            } else if (newSlider.attr('id') == 'rep_pen_range_textgenerationwebui_zenslider') {
                //handling creation of rep_pen_range for ooba
                if ($('#rep_pen_range_textgenerationwebui_zensliders').length !== 0) {
                    $('#rep_pen_range_textgenerationwebui_zensliders').remove();
                }
                handleText = steps[sliderValue];
                stepNumber = sliderValue;
                leftMargin = ((stepNumber) / numSteps) * 50 * -1;
                if (sliderValue === offVal) {
                    handleText = 'Off';
                    handle.css('color', 'rgba(128,128,128,0.5)');
                } else if (sliderValue === allVal) { handleText = 'All'; } else { handle.css('color', ''); }
                handle.text(handleText)
                    .css('margin-left', `${leftMargin}px`);
                //console.log(sliderValue, handleText, offVal, allVal)
                //console.log(`${newSlider.attr('id')} sliderValue = ${sliderValue}, handleText:${handleText}, stepNum:${stepNumber}, numSteps:${numSteps}, left-margin:${leftMargin}`)
                originalSlider.val(steps[sliderValue]);
            } else {
                //create all other sliders
                var numVal = Number(sliderValue).toFixed(decimals);
                offVal = Number(offVal).toFixed(decimals);
                if (numVal === offVal) {
                    handle.text('Off').css('color', 'rgba(128,128,128,0.5)');
                } else {
                    handle.text(numVal).css('color', '');
                }
                stepNumber = ((sliderValue - sliderMin) / stepScale);
                leftMargin = (stepNumber / numSteps) * 50 * -1;
                originalSlider.val(numVal)
                    .data('newSlider', newSlider);
                //console.log(`${newSlider.attr('id')} sliderValue = ${sliderValue}, handleText:${handleText, numVal}, stepNum:${stepNumber}, numSteps:${numSteps}, left-margin:${leftMargin}`)
                var isManualInput = false;
                var valueBeforeManualInput;
                handle.css('margin-left', `${leftMargin}px`)

                    .attr('contenteditable', 'true')
                    //these sliders need listeners for manual inputs
                    .on('click', function () {
                        //this just selects all the text in the handle so user can overwrite easily
                        //needed because JQUery UI uses left/right arrow keys as well as home/end to move the slider..
                        valueBeforeManualInput = newSlider.val();
                        console.log(valueBeforeManualInput);
                        let handleElement = handle.get(0);
                        let range = document.createRange();
                        range.selectNodeContents(handleElement);
                        let selection = window.getSelection();
                        selection.removeAllRanges();
                        selection.addRange(range);
                    })
                    .on('keyup', function (e) {
                        valueBeforeManualInput = numVal;
                        //console.log(valueBeforeManualInput, numVal, handleText);
                        isManualInput = true;
                        //allow enter to trigger slider update
                        if (e.key === 'Enter') {
                            e.preventDefault();
                            handle.trigger('blur');
                        }
                    })
                    //trigger slider changes when user clicks away
                    .on('mouseup blur', function () {
                        let manualInput = parseFloat(parseFloat(handle.text()).toFixed(decimals));
                        if (isManualInput) {
                            //disallow manual inputs outside acceptable range
                            if (manualInput >= sliderMin && manualInput <= sliderMax) {
                                //if value is ok, assign to slider and update handle text and position
                                newSlider.val(manualInput);
                                handleSlideEvent.call(newSlider, null, { value: manualInput }, 'manual');
                                valueBeforeManualInput = manualInput;
                            } else {
                                //if value not ok, warn and reset to last known valid value
                                toastr.warning(`Invalid value. Must be between ${sliderMin} and ${sliderMax}`);
                                console.log(valueBeforeManualInput);
                                newSlider.val(valueBeforeManualInput);
                                handle.text(valueBeforeManualInput);
                                handleSlideEvent.call(newSlider, null, { value: parseFloat(valueBeforeManualInput) }, 'manual');
                            }
                        }
                        isManualInput = false;
                    });
            }
            //zenSlider creation done, hide the original
            originalSlider.hide();
        },
        slide: handleSlideEvent,
    });

    function handleSlideEvent(event, ui, type) {
        var handle = $(this).find('.ui-slider-handle');
        var numVal = parseFloat(Number(ui.value).toFixed(decimals));
        offVal = parseFloat(Number(offVal).toFixed(decimals));
        allVal = parseFloat(Number(allVal).toFixed(decimals));
        console.log(numVal, sliderMin, sliderMax, numVal > sliderMax, numVal < sliderMin);
        if (numVal > sliderMax) { numVal = sliderMax; }
        if (numVal < sliderMin) { numVal = sliderMin; }
        var stepNumber = parseFloat(((ui.value - sliderMin) / stepScale).toFixed(0));
        var handleText = (ui.value);
        var leftMargin = (stepNumber / numSteps) * 50 * -1;
        var perStepPercent = 1 / numSteps; //how far in % each step should be on the slider
        var leftPos = newSlider.width() * (stepNumber * perStepPercent); //how big of a left margin to give the slider for manual inputs
        /*         console.log(`
                numVal: ${numVal},
                sliderMax: ${sliderMax}
                sliderMin: ${sliderMin}
                sliderValRange: ${sliderValRange}
                stepScale: ${stepScale}
                Step: ${stepNumber} of ${numSteps}
                offVal: ${offVal}
                allVal = ${allVal}
                initial value: ${handleText}
                left-margin: ${leftMargin}
                width: ${newSlider.width()}
                percent of max: ${percentOfMax}
                left: ${leftPos}`) */
        if (newSlider.attr('id') == 'amount_gen_zenslider') {
            //special handling for response length slider, pulls text aliases for step values from an array
            handleText = steps[stepNumber];
            handle.text(handleText);
            newSlider.val(stepNumber);
            numVal = steps[stepNumber];
        } else if (newSlider.attr('id') == 'rep_pen_range_textgenerationwebui_zenslider') {
            //special handling for TextCompletion rep pen range slider, pulls text aliases for step values from an array
            handleText = steps[stepNumber];
            handle.text(handleText);
            newSlider.val(stepNumber);
            if (numVal === offVal) { handle.text('Off').css('color', 'rgba(128,128,128,0.5)'); } else if (numVal === allVal) { handle.text('All'); } else { handle.css('color', ''); }
            numVal = steps[stepNumber];
        } else {
            //everything else uses the flat slider value
            //also note: the above sliders are not custom inputtable due to the array aliasing
            //show 'off' if disabled value is set
            if (numVal === offVal) { handle.text('Off').css('color', 'rgba(128,128,128,0.5)'); } else { handle.text(ui.value.toFixed(decimals)).css('color', ''); }
            newSlider.val(handleText);
        }
        //for manually typed-in values we must adjust left position because JQUI doesn't do it for us
        handle.css('left', leftPos);
        //adjust a negative left margin to avoid overflowing right side of slider body
        handle.css('margin-left', `${leftMargin}px`);
        originalSlider.val(numVal);
        originalSlider.trigger('input');
        originalSlider.trigger('change');
    }
}
function switchUiMode() {
    $('body').toggleClass('no-blur', power_user.fast_ui_mode);
    $('#fast_ui_mode').prop('checked', power_user.fast_ui_mode);
    if (power_user.fast_ui_mode) {
        $('#blur-strength-block').css('opacity', '0.2');
        $('#blur_strength').prop('disabled', true).attr('title', 'Disabled — Fast UI Mode is on');
    } else {
        $('#blur-strength-block').css('opacity', '1');
        $('#blur_strength').prop('disabled', false).attr('title', '');
    }
}

function toggleWaifu() {
    $('#waifuMode').trigger('click');
    return '';
}

function switchWaifuMode() {
    $('body').toggleClass('waifuMode', power_user.waifuMode);
    $('#waifuMode').prop('checked', power_user.waifuMode);
    scrollChatToBottom();
}

const characterSpoilerFreePanelSelector = '#form_create [data-sb-character-editor-panel]:not([data-sb-character-editor-panel="char-info"]):not([data-sb-character-editor-panel="metadata"])';

function showCharacterEditorMetadataPanel() {
    const metadataTab = document.querySelector('#sb_character_editor_subtabs [data-sb-character-editor-tab="metadata"]');

    if (metadataTab instanceof HTMLElement) {
        metadataTab.click();
    }
}

function syncActiveCharacterEditorPanel() {
    const activeTab = document.querySelector('#sb_character_editor_subtabs [data-sb-character-editor-tab][aria-selected="true"]');

    if (activeTab instanceof HTMLElement) {
        activeTab.click();
    }
}

function setCharacterSpoilerFreeFieldsHidden(hidden) {
    const form = document.getElementById('form_create');
    const activePanel = form?.querySelector('[data-sb-character-editor-panel]:not([hidden])');
    const activePanelCanRemainVisible = activePanel instanceof HTMLElement
        && ['char-info', 'metadata'].includes(activePanel.dataset.sbCharacterEditorPanel ?? '');

    if (form instanceof HTMLElement) {
        form.dataset.sbSpoilerFreeFieldsHidden = String(hidden);
    }

    if (hidden) {
        document.querySelectorAll(characterSpoilerFreePanelSelector).forEach(panel => {
            if (!(panel instanceof HTMLElement)) {
                return;
            }

            panel.hidden = true;
            panel.setAttribute('aria-hidden', 'true');
        });
    } else {
        syncActiveCharacterEditorPanel();
    }

    $('#spoiler_free_desc').toggleClass('flex1', hidden);
    $('#creators_note_desc_hidden').toggle(hidden);

    if (hidden && !activePanelCanRemainVisible) {
        showCharacterEditorMetadataPanel();
    }
}

function switchSpoilerMode() {
    setCharacterSpoilerFreeFieldsHidden(power_user.spoiler_free_mode);
}

function peekSpoilerMode() {
    const form = document.getElementById('form_create');
    const isHidden = form instanceof HTMLElement && form.dataset.sbSpoilerFreeFieldsHidden === 'true';
    setCharacterSpoilerFreeFieldsHidden(!isHidden);
}

function switchMovingUI() {
    $('.drawer-content.maximized').each(function () {
        $(this).find('.inline-drawer-maximize').trigger('click');
    });
    $('body').toggleClass('movingUI', power_user.movingUI);
    if (power_user.movingUI === true) {
        initMovingUI();
        if (power_user.movingUIState) {
            loadMovingUIState();
        }
    } else {
        if (Object.keys(power_user.movingUIState).length !== 0) {
            power_user.movingUIState = {};
            resetMovablePanels();
            saveSettingsDebounced();
        }
    }
}

function applyNoShadows() {
    $('body').toggleClass('noShadows', power_user.noShadows);
    $('#noShadowsmode').prop('checked', power_user.noShadows);
    if (power_user.noShadows) {
        $('#shadow-width-block').css('opacity', '0.2');
        $('#shadow_width').prop('disabled', true).attr('title', 'Disabled — No Shadows mode is on');
    } else {
        $('#shadow-width-block').css('opacity', '1');
        $('#shadow_width').prop('disabled', false).attr('title', '');
    }
    scrollChatToBottom();
}

function applyAvatarStyle() {
    $('body').toggleClass('big-avatars', power_user.avatar_style === avatar_styles.RECTANGULAR);
    $('body').toggleClass('square-avatars', power_user.avatar_style === avatar_styles.SQUARE);
    $('body').toggleClass('rounded-avatars', power_user.avatar_style === avatar_styles.ROUNDED);
    $('#avatar_style').val(power_user.avatar_style).prop('selected', true);
}

function applyChatDisplay() {
    if ([null, undefined].includes(power_user.chat_display)) {
        console.debug('applyChatDisplay: saw no chat display type defined');
        power_user.chat_display = chat_styles.DEFAULT;
    }

    if (!isValidChatDisplayValue(power_user.chat_display)) {
        console.debug('applyChatDisplay: saw invalid chat display type, resetting to default');
        power_user.chat_display = chat_styles.DEFAULT;
    }

    console.debug(`poweruser.chat_display ${power_user.chat_display}`);
    const select = document.getElementById('chat_display');
    const styleValue = String(power_user.chat_display);

    if (select instanceof HTMLSelectElement) {
        select.dataset.sbCurrentValue = styleValue;

        if (Array.from(select.options).some(option => option.value === styleValue)) {
            select.value = styleValue;
        }
    }

    const nextClass = CHAT_STYLE_BODY_CLASSES[power_user.chat_display] ?? CHAT_STYLE_BODY_CLASSES[chat_styles.DEFAULT];
    const allClasses = [...Object.values(CHAT_STYLE_BODY_CLASSES), ...LEGACY_CHAT_STYLE_BODY_CLASSES].join(' ');

    ensureNativeChatStyleStylesheet();

    console.debug(`applying ${nextClass}`);
    $('body').removeClass(allClasses);

    if (nextClass) {
        $('body').addClass(nextClass);
    }

    document.dispatchEvent(new CustomEvent('sb:chat-style-updated', {
        detail: {
            value: power_user.chat_display,
            className: nextClass,
        },
    }));
}

function applyToastrPosition() {
    if (!toastPositionClasses.includes(power_user.toastr_position)) {
        power_user.toastr_position = defaultToastPosition;
        console.warn(`applyToastrPosition: invalid toastr position, defaulting to ${defaultToastPosition}`);
    }

    toastr.options.positionClass = power_user.toastr_position;
    fixToastrForDialogs();
    $('#toastr_position').val(power_user.toastr_position);
    $(`#toastr_position option[value="${power_user.toastr_position}"]`).prop('selected', true);
}

function applyChatWidth(type) {
    if (type === 'forced') {
        let r = document.documentElement;
        r.style.setProperty('--sheldWidth', `${power_user.chat_width}vw`);
        $('#chat_width_slider').val(power_user.chat_width);
        //document.documentElement.style.setProperty('--sheldWidth', power_user.chat_width);
    } else {
        //this is to prevent the slider from updating page in real time
        $('#chat_width_slider').off('mouseup touchend').on('mouseup touchend', async () => {
            // This is a hack for Firefox to let it render before applying the block width.
            // Otherwise it takes the incorrect slider position with the new value AFTER the resizing.
            await delay(1);
            document.documentElement.style.setProperty('--sheldWidth', `${power_user.chat_width}vw`);
            await delay(1);
        });
    }

    $('#chat_width_slider_counter').val(power_user.chat_width);
}

function parseColorChannels(value) {
    const channels = String(value ?? '').match(/[\d.]+/g)?.map(Number);
    return Array.isArray(channels) && channels.length >= 3 ? channels : null;
}

function getRelativeLuminance(channel) {
    const normalized = channel / 255;
    return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
}

function getRelativeLuminanceFromChannels(channels) {
    const [red, green, blue] = channels;
    return (0.2126 * getRelativeLuminance(red))
        + (0.7152 * getRelativeLuminance(green))
        + (0.0722 * getRelativeLuminance(blue));
}

function getContrastRatioFromLuminance(firstLuminance, secondLuminance) {
    const lighter = Math.max(firstLuminance, secondLuminance);
    const darker = Math.min(firstLuminance, secondLuminance);
    return (lighter + 0.05) / (darker + 0.05);
}

function mixColorChannels(firstChannels, secondChannels, firstWeight = 1) {
    const secondWeight = 1 - firstWeight;
    return [0, 1, 2].map(index => Math.round(
        (firstChannels[index] * firstWeight) + (secondChannels[index] * secondWeight),
    ));
}

function getContrastAwareInk(backgroundChannelsList) {
    const darkInkChannels = [0, 0, 0];
    const lightInkChannels = [255, 255, 255];
    const darkInkLuminance = getRelativeLuminanceFromChannels(darkInkChannels);
    const lightInkLuminance = getRelativeLuminanceFromChannels(lightInkChannels);
    const darkMinimumContrast = Math.min(...backgroundChannelsList.map(channels => (
        getContrastRatioFromLuminance(darkInkLuminance, getRelativeLuminanceFromChannels(channels))
    )));
    const lightMinimumContrast = Math.min(...backgroundChannelsList.map(channels => (
        getContrastRatioFromLuminance(lightInkLuminance, getRelativeLuminanceFromChannels(channels))
    )));

    return darkMinimumContrast >= lightMinimumContrast ? 'rgb(0, 0, 0)' : 'rgb(255, 255, 255)';
}

function applyAccentContrastPalette() {
    const quoteChannels = parseColorChannels(power_user.quote_text_color);
    const bodyChannels = parseColorChannels(power_user.main_text_color);
    if (!quoteChannels || !bodyChannels) {
        return;
    }

    const accentChannels = mixColorChannels(quoteChannels, bodyChannels, 0.62);
    const primaryButtonTextColor = getContrastAwareInk([
        mixColorChannels(accentChannels, [255, 255, 255], 0.88),
        mixColorChannels(accentChannels, [255, 255, 255], 0.82),
    ]);
    const solidAccentTextColor = getContrastAwareInk([accentChannels]);

    document.documentElement.style.setProperty('--sb-on-accent', primaryButtonTextColor);
    document.documentElement.style.setProperty('--sb-on-solid-accent', solidAccentTextColor);
}

function applyLandingContrastPalette() {
    const blurChannels = parseColorChannels(power_user.blur_tint_color);
    if (!blurChannels) {
        return;
    }

    const luminance = getRelativeLuminanceFromChannels(blurChannels);
    const isLightSurface = luminance > 0.36;
    const landingStrong = isLightSurface ? 'rgba(52, 31, 25, 0.96)' : 'rgba(249, 242, 236, 0.96)';
    const landingMuted = isLightSurface ? 'rgba(96, 70, 61, 0.84)' : 'rgba(228, 216, 208, 0.84)';

    document.documentElement.dataset.sbSurfaceTone = isLightSurface ? 'light' : 'dark';
    document.documentElement.style.setProperty('--sb-landing-strong', landingStrong);
    document.documentElement.style.setProperty('--sb-landing-muted', landingMuted);
    document.documentElement.style.setProperty('--sb-contrast-strong', landingStrong);
    document.documentElement.style.setProperty('--sb-contrast-muted', landingMuted);
}

function applyThemeColor(type) {
    if (type === 'main') {
        document.documentElement.style.setProperty('--SmartThemeBodyColor', power_user.main_text_color);
        const color = power_user.main_text_color.split('(')[1].split(')')[0].split(',');
        document.documentElement.style.setProperty('--SmartThemeCheckboxBgColorR', color[0]);
        document.documentElement.style.setProperty('--SmartThemeCheckboxBgColorG', color[1]);
        document.documentElement.style.setProperty('--SmartThemeCheckboxBgColorB', color[2]);
        document.documentElement.style.setProperty('--SmartThemeCheckboxBgColorA', color[3]);
    }
    if (type === 'italics') {
        document.documentElement.style.setProperty('--SmartThemeEmColor', power_user.italics_text_color);
    }
    if (type === 'underline') {
        document.documentElement.style.setProperty('--SmartThemeUnderlineColor', power_user.underline_text_color);
    }
    if (type === 'quote') {
        document.documentElement.style.setProperty('--SmartThemeQuoteColor', power_user.quote_text_color);
    }
    /*     if (type === 'fastUIBG') {
            document.documentElement.style.setProperty('--SmartThemeFastUIBGColor', power_user.fastui_bg_color);
        } */
    if (type === 'blurTint') {
        let metaThemeColor = document.querySelector('meta[name=theme-color]');
        document.documentElement.style.setProperty('--SmartThemeBlurTintColor', power_user.blur_tint_color);
        metaThemeColor.setAttribute('content', power_user.blur_tint_color);
    }
    if (type === 'chatTint') {
        document.documentElement.style.setProperty('--SmartThemeChatTintColor', power_user.chat_tint_color);
    }
    if (type === 'userMesBlurTint') {
        document.documentElement.style.setProperty('--SmartThemeUserMesBlurTintColor', power_user.user_mes_blur_tint_color);
    }
    if (type === 'botMesBlurTint') {
        document.documentElement.style.setProperty('--SmartThemeBotMesBlurTintColor', power_user.bot_mes_blur_tint_color);
    }
    if (type === 'shadow') {
        document.documentElement.style.setProperty('--SmartThemeShadowColor', power_user.shadow_color);
    }
    if (type === 'border') {
        document.documentElement.style.setProperty('--SmartThemeBorderColor', power_user.border_color);
    }

    if (!type || type === 'main' || type === 'blurTint') {
        applyLandingContrastPalette();
    }
    applyAccentContrastPalette();
}

function syncThemeColorPickersFromState() {
    for (const [key, selector] of SILLYBUNNY_PALETTE_BINDINGS) {
        $(selector).attr('color', power_user[key]);
    }

    syncCustomAccentPickersFromState();
    renderAccentProfiles();
}

function syncCustomAccentPickersFromState() {
    $('#sb-accent-primary-picker').attr('color', power_user.quote_text_color);
    $('#sb-accent-secondary-picker').attr('color', power_user.underline_text_color);
}

function getSeedAccentProfiles() {
    return SILLYBUNNY_ACCENT_PROFILE_SEEDS.map(profile => ({ ...profile }));
}

function normalizeAccentProfile(profile) {
    if (!profile || typeof profile !== 'object') {
        return null;
    }

    const name = typeof profile.name === 'string'
        ? profile.name.trim().replace(/\s+/g, ' ').slice(0, MAX_SB_ACCENT_PROFILE_NAME_LENGTH)
        : '';
    const quoteColor = typeof profile.quote_text_color === 'string' ? profile.quote_text_color.trim() : '';
    const underlineColor = typeof profile.underline_text_color === 'string' ? profile.underline_text_color.trim() : '';

    if (!name || !quoteColor || !underlineColor) {
        return null;
    }

    return {
        name,
        quote_text_color: quoteColor,
        underline_text_color: underlineColor,
    };
}

function getAccentProfileKey(profile) {
    return profile.name.toLocaleLowerCase();
}

function normalizeAccentProfiles() {
    const sourceProfiles = Array.isArray(power_user.sb_accent_profiles) ? power_user.sb_accent_profiles : [];
    const normalizedProfiles = sourceProfiles.map(normalizeAccentProfile).filter(Boolean);
    const previousSeedVersion = Number.isInteger(power_user.sb_accent_profiles_seed_version)
        ? power_user.sb_accent_profiles_seed_version
        : 0;
    let changed = normalizedProfiles.length !== sourceProfiles.length || !Array.isArray(power_user.sb_accent_profiles);

    if (previousSeedVersion < SB_ACCENT_PROFILE_SEED_VERSION) {
        const profileKeys = new Set(normalizedProfiles.map(getAccentProfileKey));
        for (const seedProfile of getSeedAccentProfiles()) {
            const profileKey = getAccentProfileKey(seedProfile);
            if (!profileKeys.has(profileKey)) {
                normalizedProfiles.push(seedProfile);
                profileKeys.add(profileKey);
                changed = true;
            }
        }
    }

    if (power_user.sb_accent_profiles_seed_version !== SB_ACCENT_PROFILE_SEED_VERSION) {
        power_user.sb_accent_profiles_seed_version = SB_ACCENT_PROFILE_SEED_VERSION;
        changed = true;
    }

    power_user.sb_accent_profiles = normalizedProfiles;
    return changed;
}

function getAccentProfile(index) {
    normalizeAccentProfiles();
    return power_user.sb_accent_profiles[index] || null;
}

function renderAccentProfiles() {
    const list = $('#sb-accent-profiles-list');
    const emptyState = $('#sb-accent-profiles-empty');

    if (!list.length) {
        return;
    }

    normalizeAccentProfiles();
    list.empty();
    emptyState.toggle(power_user.sb_accent_profiles.length === 0);

    power_user.sb_accent_profiles.forEach((profile, index) => {
        const isSelected = profile.quote_text_color === power_user.quote_text_color && profile.underline_text_color === power_user.underline_text_color;
        const item = $('<div></div>', { class: 'sb-accent-profile-item', role: 'listitem' });
        const applyButton = $('<button></button>', {
            type: 'button',
            class: 'menu_button sb-accent-profile-apply',
            title: `Apply ${profile.name}`,
            'aria-label': `Apply ${profile.name} accent profile`,
            'aria-pressed': String(isSelected),
        })
            .attr('data-accent-profile-index', String(index))
            .toggleClass('is-selected', isSelected)
            .css('--sb-accent-profile-primary', profile.quote_text_color)
            .css('--sb-accent-profile-secondary', profile.underline_text_color);
        const swatches = $('<span></span>', { class: 'sb-accent-profile-swatches', 'aria-hidden': 'true' })
            .append($('<span></span>', { class: 'sb-accent-profile-swatch sb-accent-profile-swatch-primary' }))
            .append($('<span></span>', { class: 'sb-accent-profile-swatch sb-accent-profile-swatch-secondary' }));
        const name = $('<span></span>', { class: 'sb-accent-profile-name' }).text(profile.name);
        const deleteButton = $('<button></button>', {
            type: 'button',
            class: 'menu_button menu_button_icon sb-accent-profile-delete',
            title: `Delete ${profile.name}`,
            'aria-label': `Delete ${profile.name} accent profile`,
        })
            .attr('data-accent-profile-index', String(index))
            .append($('<i></i>', { class: 'fa-solid fa-trash-can' }));

        applyButton.append(swatches, name);
        item.append(applyButton, deleteButton);
        list.append(item);
    });
}

function getStoredSbAccentProfilesDrawerExpanded() {
    const storedValue = accountStorage.getItem(SB_ACCENT_PROFILES_DRAWER_KEY);
    if (storedValue === null) {
        return null;
    }

    return storedValue === 'true';
}

function setStoredSbAccentProfilesDrawerExpanded(expanded) {
    accountStorage.setItem(SB_ACCENT_PROFILES_DRAWER_KEY, String(Boolean(expanded)));
}

function syncSbAccentProfilesDrawerExpandedState(drawer, expanded) {
    const toggle = drawer.querySelector(':scope > .inline-drawer-header .sb-accent-profiles-toggle');
    if (toggle instanceof HTMLElement) {
        toggle.setAttribute('aria-expanded', String(Boolean(expanded)));
    }
}

function bindSbAccentProfilesDrawerPersistence() {
    const drawer = document.getElementById('sb-accent-profiles-panel');
    if (!(drawer instanceof HTMLElement) || drawer.dataset.sbAccentProfilesDrawerBound === 'true') {
        return;
    }

    drawer.dataset.sbAccentProfilesDrawerBound = 'true';

    const storedExpanded = getStoredSbAccentProfilesDrawerExpanded();
    toggleDrawer(drawer, storedExpanded ?? false);
    syncSbAccentProfilesDrawerExpandedState(drawer, storedExpanded ?? false);

    drawer.addEventListener('inline-drawer-toggle', () => {
        const icon = drawer.querySelector(':scope > .inline-drawer-header .inline-drawer-icon');
        if (!(icon instanceof HTMLElement)) {
            return;
        }

        const expanded = icon.classList.contains('up');
        syncSbAccentProfilesDrawerExpandedState(drawer, expanded);
        setStoredSbAccentProfilesDrawerExpanded(expanded);
    });
}

function applyAccentColors(quoteColor, underlineColor) {
    power_user.quote_text_color = quoteColor;
    power_user.underline_text_color = underlineColor;
    applyThemeColor('quote');
    applyThemeColor('underline');
    syncCustomAccentPickersFromState();
    renderAccentProfiles();
    saveSettingsDebounced();
}

function applyAccentProfile(index) {
    const profile = getAccentProfile(index);

    if (!profile) {
        return;
    }

    applyAccentColors(profile.quote_text_color, profile.underline_text_color);
    toastr.info(`${profile.name} applied.`, 'Accent profile');
}

async function saveAccentProfile() {
    const newName = await callGenericPopup('Save current accent colors as:', POPUP_TYPE.INPUT, 'My Accent', {
        okButton: 'Save',
        cancelButton: 'Cancel',
    });

    if (!newName) {
        return;
    }

    const newProfile = normalizeAccentProfile({
        name: String(newName),
        quote_text_color: power_user.quote_text_color,
        underline_text_color: power_user.underline_text_color,
    });

    if (!newProfile) {
        toastr.warning('Accent profile name is required.', 'Accent profile');
        return;
    }

    normalizeAccentProfiles();
    const existingIndex = power_user.sb_accent_profiles.findIndex(profile => profile.name.toLocaleLowerCase() === newProfile.name.toLocaleLowerCase());

    if (existingIndex !== -1) {
        const confirm = await callGenericPopup(`Replace the "${newProfile.name}" accent profile?`, POPUP_TYPE.CONFIRM, '', {
            okButton: 'Replace',
            cancelButton: 'Cancel',
        });

        if (!confirm) {
            return;
        }

        power_user.sb_accent_profiles[existingIndex] = newProfile;
    } else {
        power_user.sb_accent_profiles.push(newProfile);
    }

    renderAccentProfiles();
    saveSettingsDebounced();
    toastr.success(`${newProfile.name} saved.`, 'Accent profile');
}

async function deleteAccentProfile(index) {
    const profile = getAccentProfile(index);

    if (!profile) {
        return;
    }

    const confirm = await callGenericPopup(`Delete the "${profile.name}" accent profile?`, POPUP_TYPE.CONFIRM, '', {
        okButton: 'Delete',
        cancelButton: 'Cancel',
    });

    if (!confirm) {
        return;
    }

    power_user.sb_accent_profiles.splice(index, 1);
    renderAccentProfiles();
    saveSettingsDebounced();
    toastr.success(`${profile.name} deleted.`, 'Accent profile');
}

function applySillyBunnyPalettePreset(presetId) {
    const preset = SILLYBUNNY_PALETTE_PRESETS[presetId];

    if (!preset) {
        return;
    }

    Object.assign(power_user, preset.values);
    syncThemeColorPickersFromState();

    for (const [, , type] of SILLYBUNNY_PALETTE_BINDINGS) {
        applyThemeColor(type);
    }

    applyBlurStrength();
    applyShadowWidth();
    saveSettingsDebounced();
    toastr.success(`${preset.label} applied.`, 'SillyBunny palette');

    if (power_user.fast_ui_mode && preset.values.blur_strength !== undefined) {
        toastr.warning('Blur effects are disabled while Fast UI Mode is on.', 'SillyBunny palette', { timeOut: 4000 });
    }
    if (power_user.noShadows && preset.values.shadow_width !== undefined) {
        toastr.warning('Text shadows are disabled while No Shadows mode is on.', 'SillyBunny palette', { timeOut: 4000 });
    }
}

function applyCustomCSS() {
    $('#customCSS').val(power_user.custom_css);
    var styleId = 'custom-style';
    var style = document.getElementById(styleId);
    if (!style) {
        style = document.createElement('style');
        style.setAttribute('type', 'text/css');
        style.setAttribute('id', styleId);
        document.head.appendChild(style);
    }
    style.innerHTML = power_user.custom_css;
    applyCustomThemeStyleEntries();
}

function buildCustomCssAiPopup(currentCss) {
    const content = $(`
        <div class="flex-container flexFlowColumn flexGap5">
            <h3>Generate Custom CSS</h3>
            <label for="custom_css_ai_instruction"><small>Describe what you want the CSS to change</small></label>
            <textarea id="custom_css_ai_instruction" class="text_pole textarea_compact monospace" rows="6" placeholder="Example: Make message cards softer, with rounded corners and subtle accent borders."></textarea>
            <label for="custom_css_ai_profile"><small>Connection profile</small></label>
            <select id="custom_css_ai_profile" class="text_pole margin0 wide100p"></select>
            <div class="flex-container flexFlowColumn flexGap5">
                <label class="checkbox_label"><input type="radio" name="custom_css_ai_apply_mode" value="replace" checked><span>Replace current CSS</span></label>
                <label class="checkbox_label"><input type="radio" name="custom_css_ai_apply_mode" value="append"><span>Append below current CSS</span></label>
            </div>
            <small>The AI sees your current Custom CSS and the active SillyBunny theme variables. It should return raw CSS only.</small>
            <small>Current Custom CSS length: ${String(currentCss ?? '').length.toLocaleString()} characters.</small>
        </div>
    `);

    const activeProfileId = resolveCustomCssAIProfile('');
    populateConnectionProfileSelect(content.find('#custom_css_ai_profile').get(0), {
        emptyLabel: 'Use active connection profile',
        selectedValue: activeProfileId,
    });

    return content;
}

function setCustomCssAiWandBusy(isBusy) {
    const button = $('#custom_css_ai_wand');
    const icon = button.find('i').first();

    button.toggleClass('is-busy disabled', isBusy)
        .attr('aria-busy', String(isBusy))
        .attr('aria-disabled', String(isBusy));
    icon.toggleClass('fa-wand-magic-sparkles', !isBusy)
        .toggleClass('fa-spinner fa-spin', isBusy);
}

async function handleCustomCssAiWandClick() {
    const button = $('#custom_css_ai_wand');
    if (button.hasClass('is-busy')) {
        return;
    }

    const currentCss = String($('#customCSS').val() ?? '');
    const content = buildCustomCssAiPopup(currentCss);
    const result = await callGenericPopup(content, POPUP_TYPE.CONFIRM, '', {
        okButton: 'Generate CSS',
        cancelButton: 'Cancel',
        wide: true,
        leftAlign: true,
        allowVerticalScrolling: true,
        onOpen: () => content.find('#custom_css_ai_instruction').trigger('focus'),
        onClosing: popup => {
            if (popup.result !== POPUP_RESULT.AFFIRMATIVE) {
                return true;
            }

            if (!String(content.find('#custom_css_ai_instruction').val() ?? '').trim()) {
                globalThis.toastr?.warning?.('Describe the CSS change first.');
                return false;
            }

            return true;
        },
    });

    if (result !== POPUP_RESULT.AFFIRMATIVE) {
        return;
    }

    const instruction = String(content.find('#custom_css_ai_instruction').val() ?? '').trim();
    const selectedProfileId = String(content.find('#custom_css_ai_profile').val() ?? '').trim();
    const effectiveProfileId = resolveCustomCssAIProfile(selectedProfileId);
    const applyMode = String(content.find('input[name="custom_css_ai_apply_mode"]:checked').val() ?? 'replace');

    if (!effectiveProfileId && online_status === 'no_connection') {
        globalThis.toastr?.warning?.('Connect to an API or select a usable connection profile first.');
        return;
    }

    setCustomCssAiWandBusy(true);
    globalThis.toastr?.info?.('Generating custom CSS...', '', { timeOut: 0, extendedTimeOut: 0 });
    deactivateSendButtons({ markBodyGenerating: false });

    try {
        const generatedCss = await generateCustomCssWithAI({
            instruction,
            currentCss,
            profileId: effectiveProfileId,
        });

        if (!generatedCss.trim()) {
            globalThis.toastr?.clear?.();
            globalThis.toastr?.error?.('AI returned an empty CSS response.');
            return;
        }

        const nextCss = applyMode === 'append' && currentCss.trim()
            ? `${currentCss.trimEnd()}\n\n${generatedCss}`
            : generatedCss;

        $('#customCSS').val(nextCss);
        power_user.custom_css = nextCss;
        applyCustomCSS();
        saveSettingsDebounced();
        globalThis.toastr?.clear?.();
        globalThis.toastr?.success?.('Generated custom CSS.');
    } catch (error) {
        globalThis.toastr?.clear?.();
        if (!String(error?.message ?? error ?? '').match(/abort|cancel/i)) {
            globalThis.toastr?.error?.(`Custom CSS generation failed: ${error?.message ?? error}`);
        }
    } finally {
        activateSendButtons();
        setCustomCssAiWandBusy(false);
    }
}

function getGoogleFontStylesheetId() {
    return 'google-font-style';
}

function buildGoogleFontHref(fontName) {
    const family = String(fontName ?? '').trim();

    if (!family) {
        return '';
    }

    const encodedFamily = family.split(/\s+/).filter(Boolean).join(' ');
    return `https://fonts.googleapis.com/css2?family=${encodeURIComponent(encodedFamily)}:wght@400;500;600;700&display=swap`;
}

function applyGoogleFont(fontName = power_user.google_font) {
    const normalizedFontName = String(fontName ?? '').trim();
    const styleId = getGoogleFontStylesheetId();
    let link = document.getElementById(styleId);
    const presetSelect = $('#google_font_preset');
    const hasPresetMatch = normalizedFontName && presetSelect.find(`option[value="${CSS.escape(normalizedFontName)}"]`).length > 0;

    if (!normalizedFontName) {
        if (link) {
            link.remove();
        }

        if (customThemeStyleEntries?.mainFont) {
            document.documentElement.style.setProperty('--mainFontFamily', customThemeStyleEntries.mainFont);
        } else {
            document.documentElement.style.removeProperty('--mainFontFamily');
        }

        presetSelect.val('');
        $('#google_font_custom').val('');
        return;
    }

    if (!link) {
        link = document.createElement('link');
        link.id = styleId;
        link.rel = 'stylesheet';
        document.head.appendChild(link);
    }

    link.href = buildGoogleFontHref(normalizedFontName);
    document.documentElement.style.setProperty('--mainFontFamily', `'${normalizedFontName}', sans-serif`);

    presetSelect.val(hasPresetMatch ? normalizedFontName : '');
    $('#google_font_custom').val(normalizedFontName);
}

function applyCustomThemeStyleEntries() {
    const customThemeEntries = customThemeStyleEntries;
    if (!customThemeEntries || typeof customThemeEntries !== 'object') {
        return;
    }

    const rootStyle = document.documentElement.style;
    for (const [varId, rawValue] of Object.entries(customThemeEntries)) {
        const value = String(rawValue ?? '').trim();
        if (!varId || !value) {
            continue;
        }

        rootStyle.setProperty(`--${varId}`, value);

        if (varId === 'mainFont') {
            rootStyle.setProperty('--mainFontFamily', value);
        }
    }
}

function applyBlurStrength() {
    document.documentElement.style.setProperty('--blurStrength', String(power_user.blur_strength));
    $('#blur_strength_counter').val(power_user.blur_strength);
    $('#blur_strength').val(power_user.blur_strength);
}

function applyShadowWidth() {
    document.documentElement.style.setProperty('--shadowWidth', String(power_user.shadow_width));
    $('#shadow_width_counter').val(power_user.shadow_width);
    $('#shadow_width').val(power_user.shadow_width);
}

function normalizeThemeEffectValue(property) {
    const value = power_user[property.key] ?? property.defaultValue;

    if (typeof property.min === 'number' && typeof property.max === 'number') {
        const numericValue = Number(value);
        if (!Number.isFinite(numericValue)) {
            return property.defaultValue;
        }
        return Math.min(property.max, Math.max(property.min, numericValue));
    }

    const stringValue = String(value ?? '').trim();
    return stringValue || property.defaultValue;
}

function applyThemeEffects() {
    for (const property of THEME_EFFECT_PROPERTIES) {
        const value = normalizeThemeEffectValue(property);
        power_user[property.key] = value;
        document.documentElement.style.setProperty(property.cssVar, String(value));
        for (const cssVar of property.linkedCssVars || []) {
            document.documentElement.style.setProperty(cssVar, String(value));
        }

        if (property.selector) {
            $(property.selector).val(value);
        }

        if (property.counterSelector) {
            $(property.counterSelector).val(value);
        }
    }
}

function applyFontScale(type) {
    //this is to allow forced setting on page load, theme swap, etc
    if (type === 'forced') {
        document.documentElement.style.setProperty('--fontScale', String(power_user.font_scale));
    } else {
        //this is to prevent the slider from updating page in real time
        $('#font_scale').off('mouseup touchend').on('mouseup touchend', () => {
            document.documentElement.style.setProperty('--fontScale', String(power_user.font_scale));
        });
    }

    $('#font_scale_counter').val(power_user.font_scale);
    $('#font_scale').val(power_user.font_scale);
}

function applyLineSpacing(type) {
    const setLineSpacing = () => {
        const lineSpacing = Number(power_user.line_spacing);
        const spacingScale = Number.isFinite(lineSpacing) ? lineSpacing : 1.2;

        document.documentElement.style.setProperty('--lineSpacingDesktopLeading', `${spacingScale * 0.5}rem`);
        document.documentElement.style.setProperty('--lineSpacingMobileLeading', `${spacingScale * 0.42}rem`);
    };

    if (type === 'forced') {
        setLineSpacing();
    } else {
        $('#line_spacing').off('mouseup touchend').on('mouseup touchend', setLineSpacing);
    }

    $('#line_spacing_counter').val(power_user.line_spacing);
    $('#line_spacing').val(power_user.line_spacing);
}

function applyMessageMarginSize(type) {
    const setMessageMarginSize = () => {
        const marginSize = Number(power_user.message_margin_size);
        const marginScale = Number.isFinite(marginSize) ? marginSize : 1;

        document.documentElement.style.setProperty('--messageMarginScale', String(marginScale));
    };

    if (type === 'forced') {
        setMessageMarginSize();
    } else {
        $('#message_margin_size').off('mouseup touchend').on('mouseup touchend', setMessageMarginSize);
    }

    $('#message_margin_size_counter').val(power_user.message_margin_size);
    $('#message_margin_size').val(power_user.message_margin_size);
}

/**
 * Checks if the chat needs to be reloaded to apply media display settings.
 * @returns {boolean} True if the chat needs reload to apply media display settings
 */
function isMediaDisplayReloadNeeded() {
    // A user is not currently in a chat.
    const chatId = getCurrentChatId();
    if (!chatId) {
        return false;
    }

    const firstDisplayedIndex = getFirstDisplayedMessageId();
    const hasUnprocessedMediaMessages = chat.some((message, index) => {
        // Skip messages that are not currently displayed
        if (index < firstDisplayedIndex) {
            return false;
        }
        const hasMediaAttachments = Array.isArray(message?.extra?.media) && message.extra.media.length > 0;
        const lacksMediaDisplay = !message?.extra?.media_display;
        return hasMediaAttachments && lacksMediaDisplay;
    });

    return hasUnprocessedMediaMessages;
}

function applyTheme(name) {
    const theme = themes.find(x => x.name == name);

    if (!theme) {
        return;
    }

    for (const { key, selector, type } of THEME_COLOR_PROPERTIES) {
        if (theme[key] !== undefined) {
            const newValue = theme[key];
            power_user[key] = newValue;
            if (selector) $(selector).attr('color', newValue);
            if (type) applyThemeColor(type);
        } else {
            console.debug(`Empty theme key: ${key}`);
        }
    }

    for (const { key } of THEME_EFFECT_PROPERTIES) {
        if (theme[key] !== undefined) {
            power_user[key] = theme[key];
        }
    }
    applyThemeEffects();

    if (typeof theme.custom_css === 'string') {
        power_user.custom_css = theme.custom_css;
        applyCustomCSS();
    }

    console.log('theme applied: ' + name);
}

async function applyMovingUIPreset(name) {
    await resetMovablePanels('quiet');
    const movingUIPreset = movingUIPresets.find(x => x.name == name);

    if (!movingUIPreset) {
        return;
    }

    power_user.movingUIState = movingUIPreset.movingUIState;


    console.log('MovingUI Preset applied: ' + name);
    loadMovingUIState();
    saveSettingsDebounced();
}

/**
 * Register a function to be executed when the debug menu is opened.
 * @param {string} functionId Unique ID for the function.
 * @param {string} name Name of the function.
 * @param {string} description Description of the function.
 * @param {function} func Function to be executed.
 */
export function registerDebugFunction(functionId, name, description, func) {
    debug_functions.push({ functionId, name, description, func });
}

async function showDebugMenu() {
    const template = await renderTemplateAsync('debug', { functions: debug_functions });
    callGenericPopup(template, POPUP_TYPE.TEXT, '', { wide: true, large: true, allowVerticalScrolling: true });
}

export function applyPowerUserSettings() {
    switchUiMode();
    applyFontScale('forced');
    applyLineSpacing('forced');
    applyMessageMarginSize('forced');
    applyThemeColor();
    applyChatWidth('forced');
    applyAvatarStyle();
    applyBlurStrength();
    applyThemeEffects();
    applyLandingContrastPalette();
    applyShadowWidth();
    applyCustomCSS();
    applyGoogleFont();
    switchMovingUI();
    applyNoShadows();
    switchHotswap();
    switchTimer();
    switchTimestamps();
    switchIcons();
    switchMesIDDisplay();
    switchHideChatAvatars();
    switchTokenCount();
    switchMessageActions();
    switchSwipeNumAllMessages();
}

export function applyStylePins() {
    try {
        const existingPins = document.querySelector('#chat > .style-pins');
        if (existingPins) {
            existingPins.remove();
        }

        if (!power_user.pin_styles) {
            return;
        }

        const firstDisplayed = getFirstDisplayedMessageId();
        if (firstDisplayed === 0 || !isFinite(firstDisplayed)) {
            return;
        }

        const chatElement = document.getElementById('chat');
        if (!chatElement) {
            return;
        }

        const firstMessage = chat[0];
        if (!firstMessage) {
            return;
        }

        const formattedMessage = messageFormatting(firstMessage.mes, firstMessage.name, firstMessage.is_system, firstMessage.is_user, 0, {}, false);
        const htmlElement = document.createElement('div');
        htmlElement.innerHTML = formattedMessage;

        const styleTags = htmlElement.querySelectorAll('style');
        if (styleTags.length === 0) {
            return;
        }

        const pinsElement = document.createElement('div');
        pinsElement.classList.add('style-pins');
        pinsElement.append(...Array.from(styleTags));
        chatElement.prepend(pinsElement);
    } catch (error) {
        console.error('Error applying style pins:', error);
    }
}

function getExampleMessagesBehavior() {
    if (power_user.strip_examples) {
        return 'strip';
    }

    if (power_user.pin_examples) {
        return 'keep';
    }

    return 'normal';
}

//MARK: loadPowerUser
export async function loadPowerUserSettings(settings, data) {
    const defaultStscript = JSON.parse(JSON.stringify(power_user.stscript));
    const hasAccentProfileSeedVersion = settings.power_user !== undefined && Object.hasOwn(settings.power_user, 'sb_accent_profiles_seed_version');
    const savedPowerUserSettings = settings.power_user && typeof settings.power_user === 'object' ? settings.power_user : {};
    customThemeStyleEntries = settings.extension_settings?.CTSI?.entries && typeof settings.extension_settings.CTSI.entries === 'object'
        ? { ...settings.extension_settings.CTSI.entries }
        : {};
    // Load from settings.json
    if (settings.power_user !== undefined) {
        // Migrate old preference to a new setting
        if (settings.power_user.click_to_edit === undefined && settings.power_user.chat_display === chat_styles.DOCUMENT) {
            settings.power_user.click_to_edit = true;
        }
        if (Object.hasOwn(settings.power_user, 'auto_sort_tags') && !Object.hasOwn(settings.power_user, 'tag_sort_mode')) {
            settings.power_user.tag_sort_mode = settings.power_user.auto_sort_tags ? tag_sort_mode.ALPHABETICAL : tag_sort_mode.MANUAL;
            delete settings.power_user.auto_sort_tags;
        }
        Object.assign(power_user, settings.power_user);
    }

    if (!hasAccentProfileSeedVersion) {
        power_user.sb_accent_profiles_seed_version = 0;
    }

    if (normalizeAccentProfiles()) {
        saveSettingsDebounced();
    }

    if (initializeAndroidStreamingSettings(power_user, savedPowerUserSettings)) {
        saveSettingsDebounced();
    }

    if (power_user.stscript === undefined) {
        power_user.stscript = defaultStscript;
    } else {
        if (power_user.stscript.autocomplete === undefined) {
            power_user.stscript.autocomplete = defaultStscript.autocomplete;
        } else {
            if (power_user.stscript.autocomplete.state === undefined) {
                power_user.stscript.autocomplete.state = defaultStscript.autocomplete.state;
            }
            if (power_user.stscript.autocomplete.width === undefined) {
                power_user.stscript.autocomplete.width = defaultStscript.autocomplete.width;
            }
            if (power_user.stscript.autocomplete.font === undefined) {
                power_user.stscript.autocomplete.font = defaultStscript.autocomplete.font;
            }
            if (power_user.stscript.autocomplete.style === undefined) {
                power_user.stscript.autocomplete.style = power_user.stscript.autocomplete_style || defaultStscript.autocomplete.style;
            }
            if (power_user.stscript.autocomplete.select === undefined) {
                power_user.stscript.autocomplete.select = defaultStscript.autocomplete.select;
            }
            if (power_user.stscript.autocomplete.showInAllMacroFields === undefined) {
                power_user.stscript.autocomplete.showInAllMacroFields = defaultStscript.autocomplete.showInAllMacroFields;
            }
        }
        if (power_user.stscript.parser === undefined) {
            power_user.stscript.parser = defaultStscript.parser;
        } else if (power_user.stscript.parser.flags === undefined) {
            power_user.stscript.parser.flags = defaultStscript.parser.flags;
        }

        // Cleanup old flags
        delete power_user.stscript.autocomplete_style;
    }

    if (data.themes !== undefined) {
        themes = data.themes;
    }

    if (data.movingUIPresets !== undefined) {
        movingUIPresets = data.movingUIPresets;
    }


    if (data.context !== undefined) {
        context_presets = data.context;
    }

    if (!isValidChatDisplayValue(power_user.chat_display)) {
        power_user.chat_display = chat_styles.DEFAULT;
    }

    if (typeof power_user.waifuMode !== 'boolean') {
        power_user.waifuMode = false;
    }

    if (typeof power_user.chat_width !== 'number') {
        power_user.chat_width = 100;
    }

    if (power_user.tokenizer === tokenizers.LEGACY) {
        power_user.tokenizer = tokenizers.GPT2;
    }

    // Clean up old/legacy settings
    if (power_user.import_card_tags !== undefined) {
        power_user.tag_import_setting = power_user.import_card_tags ? tag_import_setting.ASK : tag_import_setting.NONE;
        delete power_user.import_card_tags;
    }

    if (power_user.vertical_chat_layout !== undefined) {
        delete power_user.vertical_chat_layout;
    }

    if (power_user?.instruct?.derived === true) {
        power_user.instruct_derived = true;
        delete power_user.instruct.derived;
    }

    // Reset the saved chat template hash
    power_user.chat_template_hash = '';

    $('#single_line').prop('checked', power_user.single_line);
    $('#relaxed_api_urls').prop('checked', power_user.relaxed_api_urls);
    $('#world_import_dialog').prop('checked', power_user.world_import_dialog);
    $('#enable_auto_select_input').prop('checked', power_user.enable_auto_select_input);
    $('#enable_md_hotkeys').prop('checked', power_user.enable_md_hotkeys);
    $('#trim_spaces').prop('checked', power_user.trim_spaces);
    $('#continue_on_send').prop('checked', power_user.continue_on_send);
    $('#quick_continue').prop('checked', power_user.quick_continue);
    $('#quick_impersonate').prop('checked', power_user.quick_continue);
    $('#mes_continue').css('display', power_user.quick_continue ? '' : 'none');
    $('#mes_impersonate').css('display', power_user.quick_impersonate ? '' : 'none');
    $('#gestures-checkbox').prop('checked', power_user.gestures);
    $('#auto_swipe').prop('checked', power_user.auto_swipe);
    $('#auto_swipe_minimum_length').val(power_user.auto_swipe_minimum_length);
    $('#auto_swipe_blacklist').val(power_user.auto_swipe_blacklist.join(', '));
    $('#auto_swipe_blacklist_threshold').val(power_user.auto_swipe_blacklist_threshold);
    $('#custom_stopping_strings').text(power_user.custom_stopping_strings);
    $('#custom_stopping_strings_macro').prop('checked', power_user.custom_stopping_strings_macro);
    $('#fuzzy_search_checkbox').prop('checked', power_user.fuzzy_search);
    $('#persona_show_notifications').prop('checked', power_user.persona_show_notifications);
    $('#persona_allow_multi_connections').prop('checked', power_user.persona_allow_multi_connections);
    $('#persona_auto_lock').prop('checked', power_user.persona_auto_lock);
    $('#encode_tags').prop('checked', power_user.encode_tags);
    $('#experimental_macro_engine').prop('checked', power_user.experimental_macro_engine);
    $('#example_messages_behavior').val(getExampleMessagesBehavior());
    $(`#example_messages_behavior option[value="${getExampleMessagesBehavior()}"]`).prop('selected', true);
    $('#instruct_derived').parent().find('i').toggleClass('toggleEnabled', !!power_user.instruct_derived);
    $('#context_derived').parent().find('i').toggleClass('toggleEnabled', !!power_user.context_derived);
    $('#context_size_derived').prop('checked', !!power_user.context_size_derived);

    $('#console_log_prompts').prop('checked', power_user.console_log_prompts);
    $('#request_token_probabilities').prop('checked', power_user.request_token_probabilities);
    $('#show_group_chat_queue').prop('checked', power_user.show_group_chat_queue);
    $('#auto_fix_generated_markdown').prop('checked', power_user.auto_fix_generated_markdown);
    $('#auto_clear_cache_on_update').prop('checked', power_user.auto_clear_cache_on_update);
    $('#auto_scroll_chat_to_bottom').prop('checked', power_user.auto_scroll_chat_to_bottom);
    $('#bogus_folders').prop('checked', power_user.bogus_folders);
    $('#zoomed_avatar_magnification').prop('checked', power_user.zoomed_avatar_magnification);
    $(`#tokenizer option[value="${power_user.tokenizer}"]`).prop('selected', true);
    $(`#send_on_enter option[value=${power_user.send_on_enter}]`).prop('selected', true);
    $('#confirm_message_delete').prop('checked', power_user.confirm_message_delete !== undefined ? !!power_user.confirm_message_delete : true);
    $('#spoiler_free_mode').prop('checked', power_user.spoiler_free_mode);
    $('#collapse-newlines-checkbox').prop('checked', power_user.collapse_newlines);
    $('#always-force-name2-checkbox').prop('checked', power_user.always_force_name2);
    $('#trim_sentences_checkbox').prop('checked', power_user.trim_sentences);
    $('#disable_group_trimming').prop('checked', power_user.disable_group_trimming);
    $('#markdown_escape_strings').val(power_user.markdown_escape_strings);
    $('#fast_ui_mode').prop('checked', power_user.fast_ui_mode);
    $('#waifuMode').prop('checked', power_user.waifuMode);
    $('#movingUImode').prop('checked', power_user.movingUI);
    $('#noShadowsmode').prop('checked', power_user.noShadows);
    $('#google_font_preset').val(power_user.google_font);
    $('#google_font_custom').val(power_user.google_font);
    $('.start-reply-with-input').val(power_user.user_prompt_bias);
    $('#chat-show-reply-prefix-checkbox').prop('checked', power_user.show_user_prompt_bias);
    $('#auto_continue_enabled').prop('checked', power_user.auto_continue.enabled);
    $('#auto_continue_allow_chat_completions').prop('checked', power_user.auto_continue.allow_chat_completions);
    $('#auto_continue_target_length').val(power_user.auto_continue.target_length);
    $('#play_message_sound').prop('checked', power_user.play_message_sound);
    $('#play_sound_unfocused').prop('checked', power_user.play_sound_unfocused);
    $('#never_resize_avatars').prop('checked', power_user.never_resize_avatars);
    $('#show_card_avatar_urls').prop('checked', power_user.show_card_avatar_urls);
    $('#auto_save_msg_edits').prop('checked', power_user.auto_save_msg_edits);
    $('#allow_name1_display').prop('checked', power_user.allow_name1_display);
    $('#allow_name2_display').prop('checked', power_user.allow_name2_display);
    //$("#removeXML").prop("checked", power_user.removeXML);
    $('#hotswapEnabled').prop('checked', power_user.hotswap_enabled);
    $('#messageTimerEnabled').prop('checked', power_user.timer_enabled);
    $('#messageTimestampsEnabled').prop('checked', power_user.timestamps_enabled);
    $('#messageModelIconEnabled').prop('checked', power_user.timestamp_model_icon);
    $('#messageModelNameEnabled').prop('checked', power_user.timestamp_model_name);
    $('#messageReasoningEffortEnabled').prop('checked', power_user.timestamp_reasoning_effort);
    $('#mesIDDisplayEnabled').prop('checked', power_user.mesIDDisplay_enabled);
    $('#hideChatAvatarsEnabled').prop('checked', power_user.hideChatAvatars_enabled);
    $('#prefer_character_prompt').prop('checked', power_user.prefer_character_prompt);
    $('#prefer_character_jailbreak').prop('checked', power_user.prefer_character_jailbreak);
    $('#enableZenSliders').prop('checked', power_user.enableZenSliders).trigger('input');
    $('#enableLabMode').prop('checked', power_user.enableLabMode).trigger('input', { fromInit: true });
    $(`input[name="avatar_style"][value="${power_user.avatar_style}"]`).prop('checked', true);
    const chatDisplaySelect = $('#chat_display');
    const hasChatDisplayOption = chatDisplaySelect.find(`option[value="${power_user.chat_display}"]`).length > 0;

    if (hasChatDisplayOption) {
        chatDisplaySelect.val(String(power_user.chat_display)).trigger('change');
    } else {
        applyChatDisplay();
    }

    $(`#toastr_position option[value=${power_user.toastr_position}]`).prop('selected', true).trigger('change');
    $('#chat_width_slider').val(power_user.chat_width);
    $('#token_padding').val(power_user.token_padding);
    $('#aux_field').val(power_user.aux_field);
    $('#tag_import_setting').val(power_user.tag_import_setting);

    $('#stscript_autocomplete_state').val(power_user.stscript.autocomplete.state).trigger('input');
    $('#stscript_autocomplete_autoHide').prop('checked', power_user.stscript.autocomplete.autoHide ?? false).trigger('input');
    $('#stscript_autocomplete_showInAllMacroFields').prop('checked', power_user.stscript.autocomplete.showInAllMacroFields ?? false).trigger('input');
    $('#stscript_matching').val(power_user.stscript.matching ?? 'fuzzy');
    $('#stscript_autocomplete_style').val(power_user.stscript.autocomplete.style ?? 'theme');
    document.body.setAttribute('data-stscript-style', power_user.stscript.autocomplete.style);
    $('#stscript_autocomplete_select').val(power_user.stscript.autocomplete.select ?? (AUTOCOMPLETE_SELECT_KEY.TAB + AUTOCOMPLETE_SELECT_KEY.ENTER));
    $('#stscript_parser_flag_strict_escaping').prop('checked', power_user.stscript.parser.flags[PARSER_FLAG.STRICT_ESCAPING] ?? false);
    $('#stscript_parser_flag_replace_getvar').prop('checked', power_user.stscript.parser.flags[PARSER_FLAG.REPLACE_GETVAR] ?? false);
    $('#stscript_autocomplete_font_scale').val(power_user.stscript.autocomplete.font.scale ?? defaultStscript.autocomplete.font.scale);
    $('#stscript_autocomplete_font_scale_counter').val(power_user.stscript.autocomplete.font.scale ?? defaultStscript.autocomplete.font.scale);
    document.body.style.setProperty('--ac-font-scale', power_user.stscript.autocomplete.font.scale ?? defaultStscript.autocomplete.font.scale.toString());
    $('#stscript_autocomplete_width_left').val(power_user.stscript.autocomplete.width.left ?? AUTOCOMPLETE_WIDTH.CHAT);
    document.querySelector('#stscript_autocomplete_width_left')?.dispatchEvent(new Event('input', { bubbles: true }));
    $('#stscript_autocomplete_width_right').val(power_user.stscript.autocomplete.width.right ?? AUTOCOMPLETE_WIDTH.CHAT);
    document.querySelector('#stscript_autocomplete_width_right')?.dispatchEvent(new Event('input', { bubbles: true }));

    $('#restore_user_input').prop('checked', power_user.restore_user_input);

    $('#chat_truncation').val(power_user.chat_truncation);
    $('#chat_truncation_counter').val(power_user.chat_truncation);
    $('#ooc_context_depth').val(power_user.ooc_context_depth);
    $('#html_context_depth').val(power_user.html_context_depth);

    $('#streaming_fps').val(power_user.streaming_fps);
    $('#streaming_fps_counter').val(power_user.streaming_fps);

    $('#smooth_streaming').prop('checked', power_user.smooth_streaming);
    $('#smooth_streaming_no_think').prop('checked', power_user.smooth_streaming_no_think);
    $('#smooth_streaming_speed').val(power_user.smooth_streaming_speed);

    $('#stream_fade_in').prop('checked', power_user.stream_fade_in);
    $('#ios_webkit_conservative_streaming').prop('checked', power_user.ios_webkit_conservative_streaming);
    $('#ios_webkit_reduce_streaming_work').prop('checked', power_user.ios_webkit_reduce_streaming_work);
    $('#ios_webkit_disable_smooth_streaming').prop('checked', power_user.ios_webkit_disable_smooth_streaming);
    $('#ios_webkit_disable_stream_fade_in').prop('checked', power_user.ios_webkit_disable_stream_fade_in);
    $('#android_conservative_streaming').prop('checked', power_user.android_conservative_streaming);
    $('#android_reduce_streaming_work').prop('checked', power_user.android_reduce_streaming_work);
    $('#android_streaming_basic_markdown').prop('checked', power_user.android_streaming_basic_markdown);
    $('#android_disable_smooth_streaming').prop('checked', power_user.android_disable_smooth_streaming);
    $('#android_disable_stream_fade_in').prop('checked', power_user.android_disable_stream_fade_in);
    $('#aggressive_dom_unload').prop('checked', power_user.aggressive_dom_unload);
    $('#aggressive_dom_window_size').val(power_user.aggressive_dom_window_size);
    $('#aggressive_dom_window_size_counter').val(power_user.aggressive_dom_window_size);

    $('#font_scale').val(power_user.font_scale);
    $('#font_scale_counter').val(power_user.font_scale);

    $('#line_spacing').val(power_user.line_spacing);
    $('#line_spacing_counter').val(power_user.line_spacing);

    $('#message_margin_size').val(power_user.message_margin_size);
    $('#message_margin_size_counter').val(power_user.message_margin_size);

    $('#blur_strength').val(power_user.blur_strength);
    $('#blur_strength_counter').val(power_user.blur_strength);

    $('#shadow_width').val(power_user.shadow_width);
    $('#shadow_width_counter').val(power_user.shadow_width);
    applyThemeEffects();

    syncThemeColorPickersFromState();
    $('#reduced_motion').prop('checked', power_user.reduced_motion);
    $('#auto-connect-checkbox').prop('checked', power_user.auto_connect);
    $('#auto-load-chat-checkbox').prop('checked', power_user.auto_load_chat);
    $('#forbid_external_media').prop('checked', power_user.forbid_external_media);
    $('#allow_card_scripts').prop('checked', !!power_user.allow_card_scripts);
    $('#pin_styles').prop('checked', power_user.pin_styles);
    $('#click_to_edit').prop('checked', power_user.click_to_edit);
    $('#media_display').val(power_user.media_display);
    $('#image_overswipe').val(power_user.image_overswipe);

    for (const theme of themes) {
        const option = document.createElement('option');
        option.value = theme.name;
        option.innerText = theme.name;
        option.selected = theme.name == power_user.theme;
        $('#themes').append(option);
    }

    for (const movingUIPreset of movingUIPresets) {
        const option = document.createElement('option');
        option.value = movingUIPreset.name;
        option.innerText = movingUIPreset.name;
        option.selected = movingUIPreset.name == power_user.movingUIPreset;
        $('#movingUIPresets').append(option);
    }


    $(`#character_sort_order option[data-order="${power_user.sort_order}"][data-field="${power_user.sort_field}"]`).prop('selected', true);
    switchReducedMotion();
    switchCompactInputArea();
    reloadMarkdownProcessor();
    await loadInstructMode(data);
    await loadContextSettings();
    await loadSystemPrompts(data);
    await loadReasoningTemplates(data);
    loadMaxContextUnlocked();
    switchWaifuMode();
    switchSpoilerMode();
    applyGoogleFont();
    loadMovingUIState();
    loadCharListState();
    toggleMDHotkeyIconDisplay();
    applyToastrPosition();
}

function toggleMDHotkeyIconDisplay() {
    if (power_user.enable_md_hotkeys) {
        $('.mdhotkey_location').each(function () {
            $(this).parent().append('<i class="fa-brands fa-markdown mdhotkey_icon"></i>');
        });
    } else {
        $('.mdhotkey_icon').remove();
    }
}

function loadCharListState() {
    document.body.classList.toggle('charListGrid', power_user.charListGrid);
}

const movingUIPixelStyles = new Set(['width', 'height', 'top', 'right', 'bottom', 'left']);
const movingUIBoundsTolerance = 1;

function normalizeMovingUIStateStyle(property, value) {
    if (value === null || value === undefined || value === '') {
        return '';
    }

    if (typeof value === 'number' && Number.isFinite(value) && movingUIPixelStyles.has(property)) {
        return `${value}px`;
    }

    if (typeof value === 'string' && movingUIPixelStyles.has(property) && /^-?\d+(?:\.\d+)?$/.test(value.trim())) {
        return `${value.trim()}px`;
    }

    return String(value);
}

function applyMovingUIStateStyle(element, property, value) {
    const normalizedValue = normalizeMovingUIStateStyle(property, value);
    if (!normalizedValue) {
        return;
    }

    element.style.setProperty(property, normalizedValue, 'important');
}

function applyMovingUIStateStyles(element, state) {
    for (const [property, value] of Object.entries(state)) {
        applyMovingUIStateStyle(element, property, value);
    }
}

function getMovingUIViewportSize() {
    return {
        width: window.innerWidth || document.documentElement.clientWidth || 0,
        height: window.innerHeight || document.documentElement.clientHeight || 0,
    };
}

function getMovingUIElementBounds(element) {
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
        return null;
    }

    return {
        left: rect.left,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
        width: rect.width,
        height: rect.height,
    };
}

function isMovingUIBoundsOutOfViewport(bounds) {
    const { width: viewportWidth, height: viewportHeight } = getMovingUIViewportSize();
    if (!bounds || viewportWidth <= 0 || viewportHeight <= 0 || bounds.width <= 0 || bounds.height <= 0) {
        return false;
    }

    return bounds.left < -movingUIBoundsTolerance
        || bounds.top < -movingUIBoundsTolerance
        || bounds.right > viewportWidth + movingUIBoundsTolerance
        || bounds.bottom > viewportHeight + movingUIBoundsTolerance;
}

function isMovingUIStateOutOfViewport(element, state) {
    const elementBounds = getMovingUIElementBounds(element);

    if (elementBounds) {
        return isMovingUIBoundsOutOfViewport(elementBounds);
    }

    const { width: viewportWidth, height: viewportHeight } = getMovingUIViewportSize();
    const resolution = resolveMovingUIViewportState(state, { viewportWidth, viewportHeight });
    return resolution.canContain && resolution.changed;
}

function containMovingUIElement(element, state) {
    const { width: viewportWidth, height: viewportHeight } = getMovingUIViewportSize();
    const resolution = resolveMovingUIViewportState(state, {
        viewportWidth,
        viewportHeight,
        elementBounds: getMovingUIElementBounds(element),
    });

    if (resolution.changed) {
        Object.assign(state, resolution.state);
        for (const property of Object.keys(resolution.updates)) {
            applyMovingUIStateStyle(element, property, resolution.state[property]);
        }
    }

    return resolution.changed;
}

function syncMovingUIOffscreenWarning(showWarning) {
    const warning = document.getElementById('movingUIOffscreenWarning');
    if (warning) {
        warning.classList.toggle('displayNone', !showWarning);
    }
}

export function loadMovingUIState() {
    if (!isMobile()
        && power_user.movingUIState
        && power_user.movingUI === true) {
        console.debug('loading movingUI state');
        let hasOffscreenPanel = false;
        let didContainPanel = false;
        for (var elmntName of Object.keys(power_user.movingUIState)) {
            var elmntState = power_user.movingUIState[elmntName];
            try {
                const targetNames = elmntName === 'nav-panel-shared-size' ? ['left-nav-panel', 'right-nav-panel'] : [elmntName];
                const targetElements = [];
                let sharedStateChanged = false;
                let applied = false;
                for (const targetName of targetNames) {
                    var elmnt = $('#' + $.escapeSelector(targetName));
                    if (elmnt.length) {
                        console.debug(`loading state for ${targetName} from ${elmntName}`);
                        applyMovingUIStateStyles(elmnt[0], elmntState);
                        // Persisted geometry must never enlarge the document or
                        // leave a panel unreachable after a viewport/monitor change.
                        const didContainTarget = containMovingUIElement(elmnt[0], elmntState);
                        didContainPanel = didContainTarget || didContainPanel;
                        sharedStateChanged = didContainTarget || sharedStateChanged;
                        targetElements.push(elmnt[0]);
                        applied = true;
                    }
                }
                if (sharedStateChanged && targetElements.length > 1) {
                    targetElements.forEach(element => applyMovingUIStateStyles(element, elmntState));
                }
                targetElements.forEach(element => {
                    hasOffscreenPanel = isMovingUIStateOutOfViewport(element, elmntState) || hasOffscreenPanel;
                });
                if (!applied) {
                    console.debug(`skipping ${elmntName} because it doesn't exist in the DOM`);
                }
            } catch (err) {
                console.debug(`error occurred while processing ${elmntName}: ${err}`);
            }
        }
        syncMovingUIOffscreenWarning(hasOffscreenPanel);
        if (didContainPanel) {
            saveSettingsDebounced();
        }
    } else {
        console.debug('skipping movingUI state load');
        syncMovingUIOffscreenWarning(false);
        return;
    }
}

function loadMaxContextUnlocked() {
    power_user.max_context_unlocked = true;
    $('#max_context_unlocked').prop('checked', true).off('change');
    $('#max_context_unlocked_block').remove();
    switchMaxContextSize();
}

function switchMaxContextSize() {
    const elements = [
        $('#max_context'),
        $('#max_context_counter'),
        $('#rep_pen_range'),
        $('#rep_pen_range_counter'),
        $('#rep_pen_range_textgenerationwebui'),
        $('#rep_pen_range_counter_textgenerationwebui'),
        $('#dry_penalty_last_n_textgenerationwebui'),
        $('#dry_penalty_last_n_counter_textgenerationwebui'),
        $('#rep_pen_decay_textgenerationwebui'),
        $('#rep_pen_decay_counter_textgenerationwebui'),
    ];
    const maxValue = power_user.max_context_unlocked ? MAX_CONTEXT_UNLOCKED : MAX_CONTEXT_DEFAULT;
    const minValue = power_user.max_context_unlocked ? maxContextMin : maxContextMin;
    const steps = power_user.max_context_unlocked ? unlockedMaxContextStep : maxContextStep;
    $('#rep_pen_range_textgenerationwebui_zenslider').remove(); //unsure why, but this is necessary.
    $('#dry_penalty_last_n_textgenerationwebui_zenslider').remove();
    $('#rep_pen_decay_textgenerationwebui_zenslider').remove();
    for (const element of elements) {
        const id = element.attr('id');
        element.attr('max', maxValue);

        if (typeof id === 'string' && id?.indexOf('max_context') !== -1) {
            element.attr('min', minValue);
            element.attr('step', steps); //only change setps for max context, because rep pen range needs step of 1 due to important values of -1 and 0
        }
        const value = Number(element.val());

        if (value >= maxValue) {
            element.val(maxValue).trigger('input');
        }
    }

    const maxAmountGen = power_user.max_context_unlocked ? MAX_RESPONSE_UNLOCKED : MAX_RESPONSE_DEFAULT;
    $('#amount_gen').attr('max', maxAmountGen);
    $('#amount_gen_counter').attr('max', maxAmountGen);

    if (Number($('#amount_gen').val()) >= maxAmountGen) {
        $('#amount_gen').val(maxAmountGen).trigger('input');
    }

    if (power_user.enableZenSliders) {
        $('#max_context_zenslider').remove();
        CreateZenSliders($('#max_context'));
        $('#rep_pen_range_textgenerationwebui_zenslider').remove();
        CreateZenSliders($('#rep_pen_range_textgenerationwebui'));
        $('#dry_penalty_last_n_textgenerationwebui_zenslider').remove();
        CreateZenSliders($('#dry_penalty_last_n_textgenerationwebui'));
        $('#rep_pen_decay_textgenerationwebui_zenslider').remove();
        CreateZenSliders($('#rep_pen_decay_textgenerationwebui'));
    }
}

// Fetch a compiled object of all preset settings
export function getContextSettings() {
    let compiledSettings = {};

    contextControls.forEach((control) => {
        let value = control.isGlobalSetting ? power_user[control.property] : power_user.context[control.property];

        // Force to a boolean if the setting is a checkbox
        if (control.isCheckbox) {
            value = !!value;
        }

        compiledSettings[control.property] = value;
    });

    return compiledSettings;
}

// TODO: Maybe add a refresh button to reset settings to preset
// TODO: Add "global state" if a preset doesn't set the power_user checkboxes
async function loadContextSettings() {
    /**
     * Auto-fix missing fields in the story string
     * @param {ContextSettings} contextSettings Context settings instance
     */
    function autoFixStoryString(contextSettings) {
        // Already migrated, no need to fix
        if (!contextSettings || Object.hasOwn(contextSettings, 'story_string_position')) {
            return;
        }

        let storyString = contextSettings.story_string || '';

        /**
         * @param {string} field Missing field name
         * @param {'start'|'end'} position Position of auto-fix
         */
        function autoFixMissingField(field, position) {
            if (storyString.includes(`{{${field}}}`)) {
                return;
            }

            console.warn(`[Story String Validation] Story String is missing a field: ${field}. Adding it at the ${position}.`);
            const fieldTemplate = `{{#if ${field}}}{{${field}}}\n{{/if}}`;
            const firstCurlyPosition = storyString.includes('{{') ? storyString.indexOf('{{') : 0;
            const lastCurlyPosition = storyString.includes('}}') ? storyString.lastIndexOf('}}') + '}}'.length : storyString.length;
            const lastTrimPosition = storyString.includes('{{trim}}') ? storyString.lastIndexOf('{{trim}}') : storyString.length;
            const endPosition = Math.min(lastTrimPosition, lastCurlyPosition);
            storyString = position === 'start'
                ? storyString.substring(0, firstCurlyPosition) + fieldTemplate + storyString.substring(firstCurlyPosition)
                : storyString.substring(0, endPosition) + fieldTemplate + storyString.substring(endPosition);
        }

        autoFixMissingField('anchorBefore', 'start');
        autoFixMissingField('anchorAfter', 'end');

        contextSettings.story_string = storyString;
    }

    // Migrate story string to add missing fields
    autoFixStoryString(power_user.context);

    contextControls.forEach(control => {
        const $element = $(`#${control.id}`);

        if (control.isGlobalSetting) {
            return;
        }

        if (control.defaultValue !== undefined && power_user.context[control.property] === undefined) {
            power_user.context[control.property] = control.defaultValue;
        }

        if (control.isCheckbox) {
            $element.prop('checked', power_user.context[control.property]);
        } else {
            $element.val(power_user.context[control.property]);
        }
        console.debug(`Setting ${$element.prop('id')} to ${power_user.context[control.property]}`);

        // If the setting already exists, no need to duplicate it
        // TODO: Maybe check the power_user object for the setting instead of a flag?
        $element.on('input', async function () {
            let value = control.isCheckbox ? !!$(this).prop('checked') : $(this).val();
            if (typeof control.defaultValue === 'number') {
                value = Number(value);
            }
            if (control.isGlobalSetting) {
                power_user[control.property] = value;
            } else {
                power_user.context[control.property] = value;
            }
            console.debug(`Setting ${$element.prop('id')} to ${value}`);
            if (!CSS.supports('field-sizing', 'content') && $(this).is('textarea')) {
                await resetScrollHeight($(this));
            }
            saveSettingsDebounced();
        });

        if (control.trigger) {
            $element.trigger('input');
        }
    });

    context_presets.forEach((preset) => {
        const name = preset.name;
        const option = document.createElement('option');
        option.value = name;
        option.innerText = name;
        option.selected = name === power_user.context.preset;
        $('#context_presets').append(option);
    });

    $('#context_presets').on('change', function () {
        const name = String($(this).find(':selected').text());
        const preset = context_presets.find(x => x.name === name);

        if (!preset) {
            return;
        }

        // Migrate story string to add missing fields
        autoFixStoryString(preset);

        power_user.context.preset = name;

        contextControls.forEach(control => {
            const presetValue = preset[control.property] ?? control.defaultValue;

            if (presetValue !== undefined) {
                if (control.isGlobalSetting) {
                    power_user[control.property] = presetValue;
                } else {
                    power_user.context[control.property] = presetValue;
                }

                const $element = $(`#${control.id}`);

                if (control.isCheckbox) {
                    $element
                        .prop('checked', control.isGlobalSetting ? power_user[control.property] : power_user.context[control.property])
                        .trigger('input');
                } else {
                    $element.val(control.isGlobalSetting ? power_user[control.property] : power_user.context[control.property]);
                    $element.trigger('input');
                }
            }
        });

        if (power_user.instruct.bind_to_context) {
            // Select matching instruct preset
            for (const instruct_preset of instruct_presets) {
                // If instruct preset matches the context template
                if (instruct_preset.name === name) {
                    selectInstructPreset(instruct_preset.name, { isAuto: true });
                    break;
                }
            }
        }

        updateBindModelTemplatesState();

        saveSettingsDebounced();
    });
}


/**
 * Common function to perform fuzzy search with optional caching
 * @template T
 * @param {string} type - Type of search from fuzzySearchCategories
 * @param {T[]} data - Data array to search in
 * @param {Array<{name: string, weight: number, getFn?: (obj: T) => string}>} keys - Fuse.js keys configuration
 * @param {string} searchValue - The search term
 * @param {Object.<string, { resultMap: Map<string, any> }>} [fuzzySearchCaches=null] - Optional fuzzy search caches
 * @returns {import('fuse.js').FuseResult<T>[]} Results as items with their score
 */
export function performFuzzySearch(type, data, keys, searchValue, fuzzySearchCaches = null) {
    // Check cache if provided
    if (fuzzySearchCaches) {
        const cache = fuzzySearchCaches[type];
        if (cache?.resultMap.has(searchValue)) {
            return cache.resultMap.get(searchValue);
        }
    }

    const fuse = new Fuse(data, {
        keys: keys,
        includeScore: true,
        ignoreLocation: true,
        useExtendedSearch: true,
        threshold: 0.2,
    });

    const results = fuse.search(searchValue);

    // Store in cache if provided
    if (fuzzySearchCaches) {
        fuzzySearchCaches[type].resultMap.set(searchValue, results);
    }
    return results;
}

/**
 * Fuzzy search characters by a search term
 * @param {string} searchValue - The search term
 * @param {Object.<string, { resultMap: Map<string, any> }>} [fuzzySearchCaches=null] - Optional fuzzy search caches
 * @returns {import('fuse.js').FuseResult<any>[]} Results as items with their score
 */
export function fuzzySearchCharacters(searchValue, fuzzySearchCaches = null) {
    const keys = [
        { name: 'data.name', weight: 20 },
        { name: '#tags', weight: 10, getFn: (character) => getTagsList(character.avatar).map(x => x.name).join('||') },
        { name: 'data.description', weight: 3 },
        { name: 'data.mes_example', weight: 3 },
        { name: 'data.scenario', weight: 2 },
        { name: 'data.personality', weight: 2 },
        { name: 'data.first_mes', weight: 2 },
        { name: 'data.creator_notes', weight: 2 },
        { name: 'data.creator', weight: 1 },
        { name: 'data.tags', weight: 1 },
        { name: 'data.alternate_greetings', weight: 1 },
    ];

    return performFuzzySearch(fuzzySearchCategories.characters, characters, keys, searchValue, fuzzySearchCaches);
}

/**
 * Fuzzy search world info entries by a search term
 * @param {*[]} data - WI items data array
 * @param {string} searchValue - The search term
 * @param {Object.<string, { resultMap: Map<string, any> }>} [fuzzySearchCaches=null] - Optional fuzzy search caches
 * @returns {import('fuse.js').FuseResult<any>[]} Results as items with their score
 */
export function fuzzySearchWorldInfo(data, searchValue, fuzzySearchCaches = null) {
    const keys = [
        { name: 'key', weight: 20 },
        { name: 'group', weight: 15 },
        { name: 'comment', weight: 10 },
        { name: 'keysecondary', weight: 10 },
        { name: 'content', weight: 3 },
        { name: 'uid', weight: 1 },
        { name: 'automationId', weight: 1 },
    ];

    return performFuzzySearch(fuzzySearchCategories.worldInfo, data, keys, searchValue, fuzzySearchCaches);
}

/**
 * Fuzzy search persona entries by a search term
 * @param {*[]} data - persona data array
 * @param {string} searchValue - The search term
 * @param {Object.<string, { resultMap: Map<string, any> }>} [fuzzySearchCaches=null] - Optional fuzzy search caches
 * @returns {import('fuse.js').FuseResult<any>[]} Results as items with their score
 */
export function fuzzySearchPersonas(data, searchValue, fuzzySearchCaches = null) {
    const mappedData = data.map(x => ({
        key: x,
        name: power_user.personas[x] ?? '',
        description: power_user.persona_descriptions[x]?.description ?? '',
    }));

    const keys = [
        { name: 'name', weight: 20 },
        { name: 'description', weight: 3 },
    ];

    return performFuzzySearch(fuzzySearchCategories.personas, mappedData, keys, searchValue, fuzzySearchCaches);
}

/**
 * Fuzzy search tags by a search term
 * @param {string} searchValue - The search term
 * @param {Object.<string, { resultMap: Map<string, any> }>} [fuzzySearchCaches=null] - Optional fuzzy search caches
 * @returns {import('fuse.js').FuseResult<any>[]} Results as items with their score
 */
export function fuzzySearchTags(searchValue, fuzzySearchCaches = null) {
    const keys = [
        { name: 'name', weight: 1 },
    ];

    return performFuzzySearch(fuzzySearchCategories.tags, tags, keys, searchValue, fuzzySearchCaches);
}

/**
 * Fuzzy search groups by a search term
 * @param {string} searchValue - The search term
 * @param {Object.<string, { resultMap: Map<string, any> }>} [fuzzySearchCaches=null] - Optional fuzzy search caches
 * @returns {import('fuse.js').FuseResult<any>[]} Results as items with their score
 */
export function fuzzySearchGroups(searchValue, fuzzySearchCaches = null) {
    const keys = [
        { name: 'name', weight: 20 },
        { name: 'members', weight: 15 },
        { name: '#tags', weight: 10, getFn: (group) => getTagsList(group.id).map(x => x.name).join('||') },
        { name: 'id', weight: 1 },
    ];

    return performFuzzySearch(fuzzySearchCategories.groups, groups, keys, searchValue, fuzzySearchCaches);
}

/**
 * Renders a story string template with the given parameters.
 * @param {object} params Template parameters.
 * @param {object} [options] Additional options.
 * @param {string} [options.customStoryString] Custom story string template.
 * @param {InstructSettings} [options.customInstructSettings] Custom instruct settings.
 * @param {ContextSettings} [options.customContextSettings] Custom context settings.
 * @returns {string} The rendered story string.
 */
export function renderStoryString(params, { customStoryString = null, customInstructSettings = null, customContextSettings = null } = {}) {
    try {
        const instructSettings = structuredClone(customInstructSettings ?? power_user.instruct);
        const contextSettings = structuredClone(customContextSettings ?? power_user.context);
        const storyString = customStoryString ?? contextSettings.story_string;
        const storyStringPosition = contextSettings.story_string_position ?? extension_prompt_types.IN_PROMPT;

        // Validate and log possible warnings/errors
        validateStoryString(storyString, params);

        // compile the story string template into a function, with no HTML escaping
        const compiledTemplate = Handlebars.compile(storyString, { noEscape: true });

        // render the story string template with the given params
        let output = compiledTemplate(params);

        // substitute {{macro}} params that are not defined in the story string
        output = substituteParams(output, params.user, params.char);

        // remove leading newlines
        output = output.replace(/^\n+/, '');

        // add a newline to the end of the story string if it doesn't have one
        if (output.length > 0 && !output.endsWith('\n') && storyStringPosition !== extension_prompt_types.IN_CHAT) {
            if (!instructSettings.enabled || (instructSettings.wrap && !instructSettings.story_string_suffix)) {
                output += '\n';
            }
        }

        return output;
    } catch (e) {
        toastr.error('Check the story string template for validity', 'Error rendering story string');
        console.error('Error rendering story string', e);
        throw e; // rethrow the error
    }
}

/**
 * Validate the story string for possible warnings or issues
 *
 * @param {string} storyString - The story string
 * @param {Object} params - The story string parameters
 */
function validateStoryString(storyString, params) {
    /** @type {{hashCache: {[hash: string]: {fieldsWarned: {[key: string]: boolean}}}}} */
    const cache = JSON.parse(accountStorage.getItem(storage_keys.storyStringValidationCache)) ?? { hashCache: {} };

    const hash = getStringHash(storyString);

    // Initialize the cache for the current hash if it doesn't exist
    if (!cache.hashCache[hash]) {
        cache.hashCache[hash] = { fieldsWarned: {} };
    }

    const currentCache = cache.hashCache[hash];
    const fieldsToWarn = [];

    function validateMissingField(field, fallbackLegacyField = null) {
        const contains = storyString.includes(`{{${field}}}`) || (!!fallbackLegacyField && storyString.includes(`{{${fallbackLegacyField}}}`));
        if (!contains && params[field]) {
            const wasLogged = currentCache.fieldsWarned[field];
            if (!wasLogged) {
                fieldsToWarn.push(field);
                currentCache.fieldsWarned[field] = true;
            }
            console.warn(`The story string does not contain {{${field}}}, but it would contain content:\n`, params[field]);
        }
    }

    validateMissingField('description');
    validateMissingField('personality');
    validateMissingField('persona');
    validateMissingField('scenario');
    // validateMissingField('system');
    validateMissingField('wiBefore', 'loreBefore');
    validateMissingField('wiAfter', 'loreAfter');

    if (fieldsToWarn.length > 0) {
        const fieldsList = fieldsToWarn.map(field => `{{${field}}}`).join(', ');
        toastr.warning(`The story string does not contain the following fields, but they would contain content: ${fieldsList}`, 'Story String Validation');
    }

    accountStorage.setItem(storage_keys.storyStringValidationCache, JSON.stringify(cache));
}


const sortFunc = (a, b) => power_user.sort_order == 'asc' ? compareFunc(a, b) : compareFunc(b, a);
const compareFunc = (first, second) => {
    const a = first[power_user.sort_field];
    const b = second[power_user.sort_field];

    if (power_user.sort_field === 'create_date') {
        return sortMoments(timestampToMoment(b), timestampToMoment(a));
    }

    switch (power_user.sort_rule) {
        case 'boolean':
            if (a === true || a === 'true') return 1;  // Prioritize 'true' or true
            if (b === true || b === 'true') return -1; // Prioritize 'true' or true
            if (a && !b) return -1;        // Move truthy values to the end
            if (!a && b) return 1;         // Move falsy values to the beginning
            if (a === b) return 0;         // Sort equal values normally
            return a < b ? -1 : 1;         // Sort non-boolean values normally
        default:
            return typeof a == 'string'
                ? a.localeCompare(b)
                : a - b;
    }
};

/**
 * Sorts an array of entities based on the current sort settings
 * @param {any[]} entities An array of objects with an `item` property
 * @param {boolean} forceSearch Whether to force search sorting
 * @param {import('./filters.js').FilterHelper} [filterHelper=null] Filter helper to use
 */
export function sortEntitiesList(entities, forceSearch, filterHelper = null) {
    filterHelper = filterHelper ?? entitiesFilter;
    if (power_user.sort_field == undefined || entities.length === 0) {
        return;
    }

    const isSearch = forceSearch || $('#character_sort_order option[data-field="search"]').is(':selected');

    if (!isSearch && power_user.sort_order === 'random') {
        shuffle(entities);
        return;
    }

    entities.sort((a, b) => {
        // Sort tags/folders will always be at the top. Their original sorting will be kept, to respect manual tag sorting.
        if (a.type === 'tag' || b.type === 'tag') {
            // The one that is a tag will be at the top
            return (a.type === 'tag' ? -1 : 1) - (b.type === 'tag' ? -1 : 1);
        }

        // If we have search sorting, we take scores and use those
        if (isSearch) {
            const aScore = filterHelper.getScore(FILTER_TYPES.SEARCH, `${a.type}.${a.id}`);
            const bScore = filterHelper.getScore(FILTER_TYPES.SEARCH, `${b.type}.${b.id}`);
            return (aScore - bScore);
        }

        return sortFunc(a.item, b.item);
    });
}

/**
 * Updates the current UI theme file.
 */
async function updateTheme() {
    await saveTheme(power_user.theme);
    toastr.success('Theme saved.');
}

async function deleteTheme() {
    const themeName = power_user.theme;

    if (!themeName) {
        toastr.info('No theme selected.');
        return;
    }

    const template = $(await renderTemplateAsync('themeDelete', { themeName }));
    const confirm = await callGenericPopup(template, POPUP_TYPE.CONFIRM);

    if (!confirm) {
        return;
    }

    const response = await fetch('/api/themes/delete', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ name: themeName }),
    });

    if (!response.ok) {
        toastr.error('Failed to delete theme. Check the console for more information.');
        return;
    }

    const themeIndex = themes.findIndex(x => x.name == themeName);

    if (themeIndex !== -1) {
        themes.splice(themeIndex, 1);
        $(`#themes option[value="${themeName}"]`).remove();
        power_user.theme = themes[0]?.name;
        saveSettingsDebounced();
        if (power_user.theme) {
            applyTheme(power_user.theme);
        }
        toastr.success('Theme deleted.');
    }
}

/**
 * Exports the current theme to a file.
 */
async function exportTheme() {
    const themeFile = await saveTheme(power_user.theme);
    const fileName = `${themeFile.name}.json`;
    download(JSON.stringify(themeFile, null, 4), fileName, 'application/json');
}

/**
 * Imports a theme from a file.
 * @param {File} file File to import.
 * @returns {Promise<void>} A promise that resolves when the theme is imported.
 */
async function importTheme(file) {
    if (!file) {
        return;
    }

    const fileText = await getFileText(file);
    const parsed = JSON.parse(fileText);

    if (!parsed.name) {
        throw new Error('Missing name');
    }

    if (themes.some(t => t.name === parsed.name)) {
        throw new Error('Theme with that name already exists');
    }

    if (typeof parsed.custom_css === 'string' && parsed.custom_css.includes('@import')) {
        const template = $(await renderTemplateAsync('themeImportWarning'));
        const confirm = await callGenericPopup(template, POPUP_TYPE.CONFIRM);
        if (!confirm) {
            throw new Error('Theme contains @import lines');
        }
    }

    const theme = getNewTheme(parsed);
    await saveTheme(parsed.name, theme);
    applyTheme(parsed.name);
    if (typeof theme.custom_css === 'string') {
        power_user.custom_css = theme.custom_css;
        applyCustomCSS();
    }
    saveSettingsDebounced();
    toastr.success(parsed.name, 'Theme imported');
}

/**
 * Saves the current theme to the server.
 * @param {string|undefined} name Theme name. If undefined, a popup will be shown to enter a name.
 * @param {object|undefined} theme Theme object. If undefined, the current theme will be saved.
 * @returns {Promise<object>} A promise that resolves when the theme is saved.
 */
async function saveTheme(name = undefined, theme = undefined) {
    if (typeof name !== 'string') {
        const newName = await callGenericPopup('Enter a theme preset name:', POPUP_TYPE.INPUT, power_user.theme);

        if (!newName) {
            return;
        }

        name = await getSanitizedFilename(String(newName));
    }

    if (typeof theme !== 'object') {
        theme = getThemeObject(name);
    }

    const response = await fetch('/api/themes/save', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify(theme),
    });

    if (!response.ok) {
        toastr.error('Check the server connection and reload the page to prevent data loss.', 'Theme could not be saved');
        console.error('Theme could not be saved', response);
        throw new Error('Theme could not be saved');
    }

    const themeIndex = themes.findIndex(x => x.name == name);

    if (themeIndex == -1) {
        themes.push(theme);
        const option = document.createElement('option');
        option.selected = true;
        option.value = name;
        option.innerText = name;
        $('#themes').append(option);
    } else {
        themes[themeIndex] = theme;
        $(`#themes option[value="${name}"]`).prop('selected', true);
    }

    power_user.theme = name;
    saveSettingsDebounced();

    return theme;
}

/**
 * Gets a snapshot of the current theme settings.
 * @param {string} name Name of the theme
 */
export function getThemeObject(name) {
    const theme = { name };

    for (const { key } of THEME_COLOR_PROPERTIES) {
        theme[key] = power_user[key];
    }

    for (const { key } of THEME_EFFECT_PROPERTIES) {
        theme[key] = power_user[key];
    }

    return theme;
}

/**
 * Applies imported theme properties to the theme object.
 * @param {object} parsed Parsed object to get the theme from.
 * @returns {Theme} Theme assigned to the parsed object.
 */
function getNewTheme(parsed) {
    const theme = getThemeObject(parsed.name);
    for (const key in parsed) {
        if (Object.hasOwn(theme, key)) {
            theme[key] = parsed[key];
        }
    }
    if (typeof parsed.custom_css === 'string') {
        theme.custom_css = parsed.custom_css;
    }
    return theme;
}

async function saveMovingUI() {
    const popupResult = await callGenericPopup('Enter a name for the MovingUI Preset:', POPUP_TYPE.INPUT);

    if (!popupResult) {
        return;
    }

    const name = await getSanitizedFilename(String(popupResult));

    const movingUIPreset = {
        name,
        movingUIState: power_user.movingUIState,
    };
    console.log(movingUIPreset);

    const response = await fetch('/api/moving-ui/save', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify(movingUIPreset),
    });

    if (response.ok) {
        const movingUIPresetIndex = movingUIPresets.findIndex(x => x.name == name);

        if (movingUIPresetIndex == -1) {
            movingUIPresets.push(movingUIPreset);
            const option = document.createElement('option');
            option.selected = true;
            option.value = name;
            option.innerText = name;
            $('#movingUIPresets').append(option);
        } else {
            movingUIPresets[movingUIPresetIndex] = movingUIPreset;
            $(`#movingUIPresets option[value="${name}"]`).prop('selected', true);
        }

        power_user.movingUIPreset = name;
        saveSettingsDebounced();
    } else {
        toastr.error('Failed to save MovingUI state.');
        console.error('MovingUI could not be saved', response);
    }
}

/**
 * Resets the movable styles of the given element to their unset values.
 * @param {string} id Element ID
 */
export function resetMovableStyles(id) {
    const panelStyles = ['top', 'left', 'right', 'bottom', 'height', 'width', 'margin'];

    const panel = document.getElementById(id);

    if (panel) {
        panelStyles.forEach((style) => {
            panel.style[style] = '';
        });
    }
}

async function resetMovablePanels(type) {
    const panelIds = [
        'sheld',
        'left-nav-panel',
        'right-nav-panel',
        'floatingPrompt',
        'expression-holder',
        'groupMemberListPopout',
        'summaryExtensionPopout',
        'gallery',
        'logprobsViewer',
        'cfgConfig',
    ];

    /**
     * @type {HTMLElement[]} Generic panels that don't have a known ID
     */
    const draggedElements = Array.from(document.querySelectorAll('[data-dragged]'));
    const allDraggable = panelIds.map(id => document.getElementById(id)).concat(draggedElements).filter(onlyUnique);

    const panelStyles = ['top', 'left', 'right', 'bottom', 'height', 'width', 'margin'];
    allDraggable.forEach((panel) => {
        if (panel) {
            $(panel).addClass('resizing');
            panelStyles.forEach((style) => {
                panel.style[style] = '';
            });
        }
    });

    /**
     * @type {HTMLElement[]} Zoomed avatars that are currently being resized
     */
    const zoomedAvatars = Array.from(document.querySelectorAll('.zoomed_avatar'));
    if (zoomedAvatars.length > 0) {
        zoomedAvatars.forEach((avatar) => {
            avatar.classList.add('resizing');
            panelStyles.forEach((style) => {
                avatar.style[style] = '';
            });
        });
    }

    $('[data-dragged="true"]').removeAttr('data-dragged');
    await delay(50);

    power_user.movingUIState = {};
    syncMovingUIOffscreenWarning(false);

    //if user manually resets panels, deselect the current preset
    if (type !== 'quiet' && type !== 'resize') {
        power_user.movingUIPreset = 'Default';
        $('#movingUIPresets option[value="Default"]').prop('selected', true);
    }

    saveSettingsDebounced();
    await eventSource.emit(event_types.MOVABLE_PANELS_RESET);

    eventSource.once(event_types.SETTINGS_UPDATED, () => {
        $('.resizing').removeClass('resizing');
        //if happening as part of preset application, do it quietly.
        if (type === 'quiet') {
            return;
            //if happening due to resize, tell user.
        } else if (type === 'resize') {
            toastr.warning('Panel positions reset due to zoom/resize');
            //if happening due to manual button press
        } else {
            toastr.success('Panel positions reset');
        }
    });
}

/**
 * Finds the ID of the tag with the given name.
 * @param {string} name
 * @returns {string} The ID of the tag with the given name.
 */
function findTagIdByName(name) {
    const matchTypes = [
        (a, b) => a === b,
        (a, b) => a.startsWith(b),
        (a, b) => a.includes(b),
    ];

    // Only get tags that contain at least one record in the tag_map
    const liveTagIds = new Set(Object.values(tag_map).flat());
    const liveTags = tags.filter(x => liveTagIds.has(x.id));

    const exactNameMatchIndex = liveTags.map(x => x.name.toLowerCase()).indexOf(name.toLowerCase());

    if (exactNameMatchIndex !== -1) {
        return liveTags[exactNameMatchIndex].id;
    }

    for (const matchType of matchTypes) {
        const index = liveTags.findIndex(x => matchType(x.name.toLowerCase(), name.toLowerCase()));
        if (index !== -1) {
            return liveTags[index].id;
        }
    }
}

async function doRandomChat(_, tagName) {
    /**
     * Gets the ID of a random character.
     * @returns {string} The order index of the randomly selected character.
     */
    function getRandomCharacterId() {
        if (!tagName) {
            return Math.floor(Math.random() * characters.length).toString();
        }

        const tagId = findTagIdByName(tagName);
        const taggedCharacters = Object.entries(tag_map)
            .filter(x => x[1].includes(tagId)) // Get only records that include the tag
            .map(x => x[0]) // Map the character avatar
            .filter(x => characters.find(y => y.avatar === x)); // Filter out characters that don't exist
        const randomCharacter = taggedCharacters[Math.floor(Math.random() * taggedCharacters.length)];
        const randomIndex = characters.findIndex(x => x.avatar === randomCharacter);
        if (randomIndex === -1) {
            return;
        }
        return randomIndex.toString();
    }

    resetSelectedGroup();
    const characterId = getRandomCharacterId();
    if (!characterId) {
        toastr.error('No characters found');
        return;
    }
    setCharacterId(characterId);
    setActiveCharacter(characters[characterId]?.avatar);
    setActiveGroup(null);
    await delay(1);
    await reloadCurrentChat();
    return characters[characterId]?.name;
}

/**
 * Loads the chat until the given message ID is displayed.
 * @param {number} mesId
 * @returns JQuery<HTMLElement>
 */
async function loadUntilMesId(mesId) {
    let target;

    while (getFirstDisplayedMessageId() > mesId && getFirstDisplayedMessageId() !== 0) {
        await showMoreMessages();
        await delay(1);
        target = $('#chat').find(`.mes[mesid="${mesId}"]`);

        if (target.length) {
            break;
        }
    }

    if (!target.length) {
        toastr.error(`Could not find message with ID: ${mesId}`);
        return target;
    }

    return target;
}

async function doMesCut(_, text) {
    console.debug(`was asked to cut message id #${text}`);
    const range = stringToRange(text, 0, chat.length - 1);

    //reject invalid args or no args
    if (!range) {
        toastr.warning('Must provide a Message ID or a range to cut.');
        return;
    }

    let totalMesToCut = (range.end - range.start) + 1;
    let mesIDToCut = range.start;
    let cutText = '';

    for (let i = 0; i < totalMesToCut; i++) {
        cutText += (chat[mesIDToCut]?.mes || '') + '\n';
        let mesToCut = $('#chat').find(`.mes[mesid=${mesIDToCut}]`);

        if (!mesToCut.length) {
            mesToCut = await loadUntilMesId(mesIDToCut);

            if (!mesToCut || !mesToCut.length) {
                return;
            }
        }

        setEditedMessageId(mesIDToCut);
        await deleteMessage(mesIDToCut, null, false);
    }

    await saveChatConditional();

    return cutText;
}

async function doDelMode(_, text) {
    //reject invalid args
    if (text && isNaN(text)) {
        toastr.warning('Must enter a number or nothing.');
        return '';
    }

    // Just enter the delete mode.
    if (!text) {
        $('#option_delete_mes').trigger('click', { fromSlashCommand: true });
        return '';
    }

    const count = Number(text);

    // Nothing to delete.
    if (count < 1) {
        return '';
    }

    if (count > chat.length) {
        toastr.warning(`Cannot delete more than ${chat.length} messages.`);
        return '';
    }

    const range = `${chat.length - count}-${chat.length - 1}`;
    return doMesCut(_, range);
}

function doResetPanels() {
    $('#movingUIreset').trigger('click');
    return '';
}

async function setAvgBG(args) {
    const nameOverride = args?.name ? String(args.name).trim() : '';
    const bgOverride = args?.bg ? String(args.bg).trim() : '';
    const force = isTrueBoolean(args?.force?.toString());

    let bgUrl;

    if (bgOverride) {
        // Use the specified background file
        const isCustom = isCustomBackgroundUrl(bgOverride);
        bgUrl = isCustom ? bgOverride : getBackgroundPath(bgOverride);
    } else {
        // Use the currently active background
        bgUrl = $('#bg1')
            .css('background-image')
            .replace(/^url\(['"]?/, '')
            .replace(/['"]?\)$/, '');
    }

    if (!bgUrl || bgUrl === 'none') {
        toastr.warning('No background image set.');
        return '';
    }

    // Build theme name from background filename or use override
    const bgName = deriveBackgroundName(bgUrl);
    const themeName = nameOverride || `bgcol - ${bgName}`;

    // Check if a theme with the same name already exists
    if (themes.some(t => t.name === themeName) && !force) {
        toastr.warning('Pass "force=true" to overwrite.', `A theme named "${themeName}" already exists.`);
        return '';
    }

    const bgimg = new Image();
    bgimg.crossOrigin = 'anonymous';
    bgimg.src = bgUrl;

    await new Promise((resolve, reject) => {
        bgimg.onload = resolve;
        bgimg.onerror = () => reject(new Error('Failed to load background image'));
    });

    // Extract dominant vivid color using Oklch-weighted sampling
    const dominantRgb = extractDominantColor(bgimg);

    // Generate a full theme palette from the dominant color
    const palette = generateThemePalette(dominantRgb);

    // Create theme object from current settings, then override colors
    const theme = getThemeObject(themeName);
    Object.assign(theme, palette);

    // Save as a new theme
    await saveTheme(themeName, theme);
    applyTheme(themeName);

    toastr.success(`Theme "${themeName}" generated and applied.`);
    return '';
}

async function setThemeCallback(_, themeName) {
    if (!themeName) {
        // allow reporting of the theme name if called without args
        // for use in ST Scripts via pipe
        return power_user.theme;
    }

    // @ts-ignore
    const fuse = new Fuse(themes, {
        keys: [
            { name: 'name', weight: 1 },
        ],
    });

    const results = fuse.search(themeName);
    console.debug('Theme fuzzy search results for ' + themeName, results);
    const theme = results[0]?.item;

    if (!theme) {
        toastr.warning(`Could not find theme with name: ${themeName}`);
        return;
    }

    power_user.theme = theme.name;
    applyTheme(theme.name);
    $('#themes').val(theme.name);
    saveSettingsDebounced();
    return '';
}

async function setmovingUIPreset(_, text) {
    // @ts-ignore
    const fuse = new Fuse(movingUIPresets, {
        keys: [
            { name: 'name', weight: 1 },
        ],
    });

    const results = fuse.search(text);
    console.debug('movingUI preset fuzzy search results for ' + text, results);
    const preset = results[0]?.item;

    if (!preset) {
        toastr.warning(`Could not find preset with name: ${text}`);
        return;
    }

    power_user.movingUIPreset = preset.name;
    applyMovingUIPreset(preset.name);
    $('#movingUIPresets').val(preset.name);
    saveSettingsDebounced();
    return '';
}

const EPHEMERAL_STOPPING_STRINGS = [];

/**
 * Adds a stopping string to the list of stopping strings that are only used for the next generation.
 * @param {string} value The stopping string to add
 */
export function addEphemeralStoppingString(value) {
    if (!EPHEMERAL_STOPPING_STRINGS.includes(value)) {
        console.debug('Adding ephemeral stopping string:', value);
        EPHEMERAL_STOPPING_STRINGS.push(value);
    }
}

export function flushEphemeralStoppingStrings() {
    if (EPHEMERAL_STOPPING_STRINGS.length === 0) {
        return;
    }

    console.debug('Flushing ephemeral stopping strings:', EPHEMERAL_STOPPING_STRINGS);
    EPHEMERAL_STOPPING_STRINGS.splice(0, EPHEMERAL_STOPPING_STRINGS.length);
}

/**
 * Checks if the generated text should be filtered based on the auto-swipe settings.
 * @param {string} text The text to check
 * @returns {boolean} If the generated text should be filtered
 */
export function generatedTextFiltered(text) {
    /**
     * Checks if the given text contains any of the blacklisted words.
     * @param {string} text The text to check
     * @param {string[]} blacklist The list of blacklisted words
     * @param {number} threshold The number of blacklisted words that need to be present to trigger the check
     * @returns {boolean} Whether the text contains blacklisted words
     */
    function containsBlacklistedWords(text, blacklist, threshold) {
        const regex = new RegExp(`\\b(${blacklist.join('|')})\\b`, 'gi');
        const matches = text.match(regex) || [];
        return matches.length >= threshold;
    }

    // Make sure a generated text is non-empty
    // Otherwise we might get in a loop with a broken API
    text = text.trim();
    if (text.length > 0) {
        if (power_user.auto_swipe_minimum_length) {
            if (text.length < power_user.auto_swipe_minimum_length) {
                console.log('Generated text size too small');
                return true;
            }
        }
        if (power_user.auto_swipe_blacklist.length && power_user.auto_swipe_blacklist_threshold) {
            if (containsBlacklistedWords(text, power_user.auto_swipe_blacklist, power_user.auto_swipe_blacklist_threshold)) {
                console.log('Generated text has blacklisted words');
                return true;
            }
        }
    }

    return false;
}

/**
 * Gets the custom stopping strings from the power user settings.
 * @param {number | undefined} limit Number of strings to return. If 0 or undefined, returns all strings.
 * @returns {string[]} An array of custom stopping strings
 */
export function getCustomStoppingStrings(limit = undefined) {
    function getPermanent() {
        try {
            // If there's no custom stopping strings, return an empty array
            if (!power_user.custom_stopping_strings) {
                return [];
            }

            // Parse the JSON string
            let strings = JSON.parse(power_user.custom_stopping_strings);

            // Make sure it's an array
            if (!Array.isArray(strings)) {
                return [];
            }

            // Make sure all the elements are strings and non-empty.
            strings = strings.filter(s => typeof s === 'string' && s.length > 0);

            // Substitute params if necessary
            if (power_user.custom_stopping_strings_macro) {
                strings = strings.map(x => substituteParams(x));
            }

            return strings;
        } catch (error) {
            // If there's an error, return an empty array
            console.warn('Error parsing custom stopping strings:', error);
            return [];
        }
    }

    const permanent = getPermanent();
    const ephemeral = EPHEMERAL_STOPPING_STRINGS;
    const strings = [...permanent, ...ephemeral];

    // Apply the limit. If limit is 0, return all strings.
    if (limit > 0) {
        return strings.slice(0, limit);
    }

    return strings;
}

export function forceCharacterEditorTokenize() {
    $('[data-token-counter]').each(function () {
        $(document.getElementById($(this).data('token-counter'))).data('last-value-hash', '');
    });
    $('#rm_ch_create_block').trigger('input');
}

jQuery(async () => {
    const adjustAutocompleteDebounced = debounce(() => {
        $('.ui-autocomplete-input').each(function () {
            const isOpen = $(this).autocomplete('widget')[0].style.display !== 'none';
            if (isOpen) {
                $(this).autocomplete('search');
            }
        });
    });

    const reportZoomLevelDebounced = debounce(() => {
        const zoomLevel = parseFloat(Number(window.devicePixelRatio).toFixed(2)) || 1;
        const winWidth = window.innerWidth;
        const winHeight = window.innerHeight;
        const originalWidth = winWidth * zoomLevel;
        const originalHeight = winHeight * zoomLevel;
        console.debug(`Window resize: ${coreTruthWinWidth}x${coreTruthWinHeight} -> ${window.innerWidth}x${window.innerHeight}`);
        console.debug(`Zoom: ${zoomLevel}, X:${winWidth}, Y:${winHeight}, original: ${originalWidth}x${originalHeight} `);
        return zoomLevel;
    });

    var coreTruthWinWidth = window.innerWidth;
    var coreTruthWinHeight = window.innerHeight;

    $(window).on('resize', async () => {
        adjustAutocompleteDebounced();
        setHotswapsDebounced();

        if (isMobile()) {
            return;
        }

        reportZoomLevelDebounced();

        //attempt to scale movingUI elements naturally across window resizing/zooms
        //this will still break if the zoom level causes mobile styles to come into play.
        const scaleY = parseFloat(Number(window.innerHeight / coreTruthWinHeight).toFixed(4));
        const scaleX = parseFloat(Number(window.innerWidth / coreTruthWinWidth).toFixed(4));

        if (Object.keys(power_user.movingUIState).length > 0) {
            let hasOffscreenPanel = false;
            for (var elmntName of Object.keys(power_user.movingUIState)) {
                var elmntState = power_user.movingUIState[elmntName];
                try {
                    const targetNames = elmntName === 'nav-panel-shared-size' ? ['left-nav-panel', 'right-nav-panel'] : [elmntName];
                    const targetElements = [];
                    let sharedStateChanged = false;
                    let applied = false;
                    Object.assign(elmntState, scaleMovingUIViewportState(elmntState, { scaleX, scaleY }));

                    for (const targetName of targetNames) {
                        const elmnt = $('#' + $.escapeSelector(targetName));
                        if (!elmnt.length) {
                            continue;
                        }

                        console.log(`scaling ${targetName} by ${scaleX}x${scaleY} to ${elmntState.width}x${elmntState.height}`);
                        const element = elmnt[0];
                        applyMovingUIStateStyles(element, elmntState);
                        const didContainTarget = containMovingUIElement(element, elmntState);
                        sharedStateChanged = didContainTarget || sharedStateChanged;
                        targetElements.push(element);
                        applied = true;
                    }

                    if (sharedStateChanged && targetElements.length > 1) {
                        targetElements.forEach(element => applyMovingUIStateStyles(element, elmntState));
                    }
                    targetElements.forEach(element => {
                        hasOffscreenPanel = isMovingUIStateOutOfViewport(element, elmntState) || hasOffscreenPanel;
                    });

                    if (!applied) {
                        console.log(`skipping ${elmntName} because it doesn't exist in the DOM`);
                    }
                } catch (err) {
                    console.log(`error occurred while processing ${elmntName}: ${err}`);
                }
            }
            syncMovingUIOffscreenWarning(hasOffscreenPanel);
        } else {
            console.debug('aborting MUI reset', Object.keys(power_user.movingUIState).length);
        }
        saveSettingsDebounced();
        coreTruthWinWidth = window.innerWidth;
        coreTruthWinHeight = window.innerHeight;
    });

    // Settings that go to settings.json
    $('#collapse-newlines-checkbox').on('change', function () {
        power_user.collapse_newlines = !!$(this).prop('checked');
        saveSettingsDebounced();
    });

    // include newline is the child of trim sentences
    // if include newline is checked, trim sentences must be checked
    // if trim sentences is unchecked, include newline must be unchecked
    $('#trim_sentences_checkbox').on('change', function () {
        power_user.trim_sentences = !!$(this).prop('checked');
        saveSettingsDebounced();
    });

    $('#single_line').on('input', function () {
        const value = !!$(this).prop('checked');
        power_user.single_line = value;
        saveSettingsDebounced();
    });

    $('#context_derived').on('input', function () {
        const value = !!$(this).prop('checked');
        power_user.context_derived = value;
        saveSettingsDebounced();
    });

    $('#context_derived').on('change', function () {
        $('#context_derived').parent().find('i').toggleClass('toggleEnabled', !!power_user.context_derived);
    });

    $('#instruct_derived').on('input', function () {
        const value = !!$(this).prop('checked');
        power_user.instruct_derived = value;
        saveSettingsDebounced();
    });

    $('#instruct_derived').on('change', function () {
        $('#instruct_derived').parent().find('i').toggleClass('toggleEnabled', !!power_user.instruct_derived);
    });

    $('#context_size_derived').on('input', function () {
        const value = !!$(this).prop('checked');
        power_user.context_size_derived = value;
        saveSettingsDebounced();
    });

    $('#context_size_derived').on('change', function () {
        $('#context_size_derived').prop('checked', !!power_user.context_size_derived);
    });

    $('#context_story_string_position').on('input', function () {
        const value = Number($(this).val());
        $('#context_story_string_inject_settings').toggle(value === extension_prompt_types.IN_CHAT);
    });

    $('#bind_model_templates').on('input', function () {
        if (bindModelTemplates(power_user, online_status)) {
            saveSettingsDebounced();
        }
    });

    $('#bind_model_templates').on('change', updateBindModelTemplatesState);

    $('#always-force-name2-checkbox').on('change', function () {
        power_user.always_force_name2 = !!$(this).prop('checked');
        saveSettingsDebounced();
    });

    $('#markdown_escape_strings').on('input', function () {
        power_user.markdown_escape_strings = String($(this).val());
        saveSettingsDebounced();
        reloadMarkdownProcessor();
    });

    $('.start-reply-with-input').on('input', function () {
        power_user.user_prompt_bias = String($(this).val());
        saveSettingsDebounced();
    });

    $('#chat-show-reply-prefix-checkbox').on('change', function () {
        power_user.show_user_prompt_bias = !!$(this).prop('checked');
        reloadCurrentChat();
        saveSettingsDebounced();
    });

    $('#auto_continue_enabled').on('change', function () {
        power_user.auto_continue.enabled = $(this).prop('checked');
        saveSettingsDebounced();
    });

    $('#auto_continue_allow_chat_completions').on('change', function () {
        power_user.auto_continue.allow_chat_completions = !!$(this).prop('checked');
        saveSettingsDebounced();
    });

    $('#auto_continue_target_length').on('input', function () {
        power_user.auto_continue.target_length = Number($(this).val());
        saveSettingsDebounced();
    });

    $('#example_messages_behavior').on('change', function () {
        const selectedOption = String($(this).find(':selected').val());
        console.log('Setting example messages behavior to', selectedOption);

        switch (selectedOption) {
            case 'normal':
                power_user.pin_examples = false;
                power_user.strip_examples = false;
                break;
            case 'keep':
                power_user.pin_examples = true;
                power_user.strip_examples = false;
                break;
            case 'strip':
                power_user.pin_examples = false;
                power_user.strip_examples = true;
                break;
        }

        console.debug('power_user.pin_examples', power_user.pin_examples);
        console.debug('power_user.strip_examples', power_user.strip_examples);

        saveSettingsDebounced();
    });

    $('#fast_ui_mode').on('change', function () {
        power_user.fast_ui_mode = $(this).prop('checked');
        switchUiMode();
        saveSettingsDebounced();
    });

    $('#waifuMode').on('change', () => {
        power_user.waifuMode = !!$('#waifuMode').prop('checked');
        switchWaifuMode();
        saveSettingsDebounced();
    });

    $('#customCSS').on('input', () => {
        power_user.custom_css = String($('#customCSS').val());
        saveSettingsDebounced();
        applyCustomCSS();
    });

    // SillyBunny: Custom CSS AI wand uses the active Connection Manager profile without swapping global state.
    $('#custom_css_ai_wand').on('click', () => { void handleCustomCssAiWandClick(); });
    $('#custom_css_ai_wand').on('keydown', event => {
        if (event.key !== 'Enter' && event.key !== ' ') {
            return;
        }
        event.preventDefault();
        $('#custom_css_ai_wand').trigger('click');
    });

    $('#google_font_preset').on('change', function () {
        const selectedFont = String($(this).val() ?? '').trim();
        $('#google_font_custom').val(selectedFont);
        power_user.google_font = selectedFont;
        applyGoogleFont(selectedFont);
        saveSettingsDebounced();
    });

    $('#apply_google_font').on('click', function () {
        const customFont = String($('#google_font_custom').val() ?? '').trim();
        power_user.google_font = customFont;
        applyGoogleFont(customFont);
        saveSettingsDebounced();
    });

    $('#movingUImode').on('change', function () {
        power_user.movingUI = $(this).prop('checked');
        switchMovingUI();
        saveSettingsDebounced();
    });

    $('#noShadowsmode').on('change', function () {
        power_user.noShadows = $(this).prop('checked');
        applyNoShadows();
        saveSettingsDebounced();
    });

    $('#movingUIreset, #movingUIOffscreenReset').on('click', () => resetMovablePanels());

    $('#avatar_style').on('change', function () {
        const value = $(this).find(':selected').val();
        power_user.avatar_style = Number(value);
        applyAvatarStyle();
        saveSettingsDebounced();
    });

    $('#chat_display').on('change', function () {
        const selectedValue = $(this).find(':selected').val() ?? this.value;
        power_user.chat_display = Number(selectedValue);

        if (!isValidChatDisplayValue(power_user.chat_display)) {
            power_user.chat_display = chat_styles.DEFAULT;
        }

        applyChatDisplay();
        saveSettingsDebounced();
    });

    $('#toastr_position').on('change', function () {
        const value = $(this).find(':selected').val();
        power_user.toastr_position = String(value);
        applyToastrPosition();
        saveSettingsDebounced();
    });

    $('#chat_width_slider').on('input', function (e, data) {
        const applyMode = data?.forced ? 'forced' : 'normal';
        power_user.chat_width = Number($(this).val());
        applyChatWidth(applyMode);
        saveSettingsDebounced();
        setHotswapsDebounced();
    });

    $('#chat_truncation').on('input', function () {
        power_user.chat_truncation = Number($('#chat_truncation').val());
        $('#chat_truncation_counter').val(power_user.chat_truncation);
        saveSettingsDebounced();
    });

    $('#ooc_context_depth').on('input', function () {
        power_user.ooc_context_depth = normalizeContextRetentionDepth($(this).val());
        $(this).val(power_user.ooc_context_depth);
        saveSettingsDebounced();
    });

    $('#html_context_depth').on('input', function () {
        power_user.html_context_depth = normalizeContextRetentionDepth($(this).val());
        $(this).val(power_user.html_context_depth);
        saveSettingsDebounced();
    });

    $('#streaming_fps').on('input', function () {
        power_user.streaming_fps = Number($('#streaming_fps').val());
        $('#streaming_fps_counter').val(power_user.streaming_fps);
        saveSettingsDebounced();
    });

    $('#smooth_streaming').on('input', function () {
        power_user.smooth_streaming = !!$(this).prop('checked');
        saveSettingsDebounced();
    });

    $('#smooth_streaming_no_think').on('input', function () {
        power_user.smooth_streaming_no_think = !!$(this).prop('checked');
        saveSettingsDebounced();
    });

    $('#smooth_streaming_speed').on('input', function () {
        power_user.smooth_streaming_speed = Number($('#smooth_streaming_speed').val());
        saveSettingsDebounced();
    });

    $('#stream_fade_in').on('input', function () {
        power_user.stream_fade_in = !!$(this).prop('checked');
        saveSettingsDebounced();
    });

    $('#ios_webkit_conservative_streaming').on('input', function () {
        power_user.ios_webkit_conservative_streaming = !!$(this).prop('checked');
        saveSettingsDebounced();
    });

    $('#ios_webkit_reduce_streaming_work').on('input', function () {
        power_user.ios_webkit_reduce_streaming_work = !!$(this).prop('checked');
        saveSettingsDebounced();
    });

    $('#ios_webkit_disable_smooth_streaming').on('input', function () {
        power_user.ios_webkit_disable_smooth_streaming = !!$(this).prop('checked');
        saveSettingsDebounced();
    });

    $('#ios_webkit_disable_stream_fade_in').on('input', function () {
        power_user.ios_webkit_disable_stream_fade_in = !!$(this).prop('checked');
        saveSettingsDebounced();
    });

    $('#android_conservative_streaming').on('input', function () {
        power_user.android_conservative_streaming = !!$(this).prop('checked');
        saveSettingsDebounced();
    });

    $('#android_reduce_streaming_work').on('input', function () {
        power_user.android_reduce_streaming_work = !!$(this).prop('checked');
        saveSettingsDebounced();
    });

    $('#android_streaming_basic_markdown').on('input', function () {
        power_user.android_streaming_basic_markdown = !!$(this).prop('checked');
        saveSettingsDebounced();
    });

    $('#android_disable_smooth_streaming').on('input', function () {
        power_user.android_disable_smooth_streaming = !!$(this).prop('checked');
        saveSettingsDebounced();
    });

    $('#android_disable_stream_fade_in').on('input', function () {
        power_user.android_disable_stream_fade_in = !!$(this).prop('checked');
        saveSettingsDebounced();
    });

    // SillyBunny: aggressive DOM unloading for low-memory devices
    $('#aggressive_dom_unload').on('input', function () {
        power_user.aggressive_dom_unload = !!$(this).prop('checked');
        saveSettingsDebounced();
    });

    $('#aggressive_dom_window_size').on('input', function () {
        power_user.aggressive_dom_window_size = Number($(this).val());
        $('#aggressive_dom_window_size_counter').val(power_user.aggressive_dom_window_size);
        saveSettingsDebounced();
    });

    $('input[name="font_scale"]').on('input', async function (e, data) {
        const applyMode = data?.forced ? 'forced' : 'normal';
        power_user.font_scale = Number($(this).val());
        $('#font_scale_counter').val(power_user.font_scale);
        applyFontScale(applyMode);
        saveSettingsDebounced();
    });

    $('input[name="line_spacing"]').on('input', async function (e, data) {
        const applyMode = data?.forced ? 'forced' : 'normal';
        power_user.line_spacing = Number($(this).val());
        $('#line_spacing_counter').val(power_user.line_spacing);
        applyLineSpacing(applyMode);
        saveSettingsDebounced();
    });

    $('input[name="message_margin_size"]').on('input', async function (e, data) {
        const applyMode = data?.forced ? 'forced' : 'normal';
        power_user.message_margin_size = Number($(this).val());
        $('#message_margin_size_counter').val(power_user.message_margin_size);
        applyMessageMarginSize(applyMode);
        saveSettingsDebounced();
    });

    $('input[name="blur_strength"]').on('input', async function (e) {
        power_user.blur_strength = Number($(this).val());
        $('#blur_strength_counter').val(power_user.blur_strength);
        applyBlurStrength();
        saveSettingsDebounced();
    });

    $('input[name="shadow_width"]').on('input', async function (e) {
        power_user.shadow_width = Number($(this).val());
        $('#shadow_width_counter').val(power_user.shadow_width);
        applyShadowWidth();
        saveSettingsDebounced();
    });

    for (const property of THEME_EFFECT_PROPERTIES.filter(property => property.selector)) {
        $(property.selector).on('input', function () {
            power_user[property.key] = Number($(this).val());
            applyThemeEffects();
            saveSettingsDebounced();
        });
    }

    $('#main-text-color-picker').on('change', (/** @type {ColorPickerEvent} */ evt) => {
        power_user.main_text_color = evt.detail.rgba;
        applyThemeColor('main');
        saveSettingsDebounced();
    });

    $('#italics-color-picker').on('change', (/** @type {ColorPickerEvent} */ evt) => {
        power_user.italics_text_color = evt.detail.rgba;
        applyThemeColor('italics');
        saveSettingsDebounced();
    });

    $('#underline-color-picker').on('change', (/** @type {ColorPickerEvent} */ evt) => {
        power_user.underline_text_color = evt.detail.rgba;
        applyThemeColor('underline');
        saveSettingsDebounced();
    });

    $('#quote-color-picker').on('change', (/** @type {ColorPickerEvent} */ evt) => {
        power_user.quote_text_color = evt.detail.rgba;
        applyThemeColor('quote');
        saveSettingsDebounced();
    });

    $('#blur-tint-color-picker').on('change', (/** @type {ColorPickerEvent} */ evt) => {
        power_user.blur_tint_color = evt.detail.rgba;
        applyThemeColor('blurTint');
        saveSettingsDebounced();
    });

    $('#chat-tint-color-picker').on('change', (/** @type {ColorPickerEvent} */ evt) => {
        power_user.chat_tint_color = evt.detail.rgba;
        applyThemeColor('chatTint');
        saveSettingsDebounced();
    });

    $('#user-mes-blur-tint-color-picker').on('change', (/** @type {ColorPickerEvent} */ evt) => {
        power_user.user_mes_blur_tint_color = evt.detail.rgba;
        applyThemeColor('userMesBlurTint');
        saveSettingsDebounced();
    });

    $('#bot-mes-blur-tint-color-picker').on('change', (/** @type {ColorPickerEvent} */ evt) => {
        power_user.bot_mes_blur_tint_color = evt.detail.rgba;
        applyThemeColor('botMesBlurTint');
        saveSettingsDebounced();
    });

    $('#shadow-color-picker').on('change', (/** @type {ColorPickerEvent} */ evt) => {
        power_user.shadow_color = evt.detail.rgba;
        applyThemeColor('shadow');
        saveSettingsDebounced();
    });

    $('#border-color-picker').on('change', (/** @type {ColorPickerEvent} */ evt) => {
        power_user.border_color = evt.detail.rgba;
        applyThemeColor('border');
        saveSettingsDebounced();
    });

    $('#themes').on('change', function () {
        const themeSelected = String($(this).find(':selected').val());
        power_user.theme = themeSelected;
        applyTheme(themeSelected);
        saveSettingsDebounced();
    });

    $('#movingUIPresets').on('change', async function () {
        console.log('saw MUI preset change');
        const movingUIPresetSelected = String($(this).find(':selected').val());
        power_user.movingUIPreset = movingUIPresetSelected;
        applyMovingUIPreset(movingUIPresetSelected);
        saveSettingsDebounced();
    });

    $('#ui-preset-save-button').on('click', () => saveTheme());
    $('#ui-preset-update-button').on('click', () => updateTheme());
    $('#ui-preset-delete-button').on('click', () => deleteTheme());
    $('#movingui-preset-save-button').on('click', saveMovingUI);

    $('#never_resize_avatars').on('input', function () {
        power_user.never_resize_avatars = !!$(this).prop('checked');
        saveSettingsDebounced();
    });

    $('#show_card_avatar_urls').on('input', function () {
        power_user.show_card_avatar_urls = !!$(this).prop('checked');
        printCharactersDebounced();
        saveSettingsDebounced();
    });

    $('#play_message_sound').on('input', function () {
        power_user.play_message_sound = !!$(this).prop('checked');
        saveSettingsDebounced();
    });

    $('#play_sound_unfocused').on('input', function () {
        power_user.play_sound_unfocused = !!$(this).prop('checked');
        saveSettingsDebounced();
    });

    $('#auto_save_msg_edits').on('input', function () {
        power_user.auto_save_msg_edits = !!$(this).prop('checked');
        saveSettingsDebounced();
    });

    $('#character_sort_order').on('change', function () {
        const field = String($(this).find(':selected').data('field'));
        // Save sort order, but do not save search sorting, as this is a temporary sorting option
        if (field !== 'search') {
            power_user.sort_field = field;
            power_user.sort_order = $(this).find(':selected').data('order');
            power_user.sort_rule = $(this).find(':selected').data('rule');
        }
        printCharactersDebounced();
        saveSettingsDebounced();
    });

    $('#gestures-checkbox').on('change', function () {
        power_user.gestures = !!$('#gestures-checkbox').prop('checked');
        saveSettingsDebounced();
    });

    $('#auto_swipe').on('input', function () {
        power_user.auto_swipe = !!$(this).prop('checked');
        saveSettingsDebounced();
    });

    $('#auto_swipe_blacklist').on('input', function () {
        power_user.auto_swipe_blacklist = String($(this).val())
            .split(',')
            .map(str => str.trim())
            .filter(str => str);
        console.log('power_user.auto_swipe_blacklist', power_user.auto_swipe_blacklist);
        saveSettingsDebounced();
    });

    $('#auto_swipe_minimum_length').on('input', function () {
        const number = Number($(this).val());
        if (!isNaN(number)) {
            power_user.auto_swipe_minimum_length = number;
            saveSettingsDebounced();
        }
    });

    $('#auto_swipe_blacklist_threshold').on('input', function () {
        const number = Number($(this).val());
        if (!isNaN(number)) {
            power_user.auto_swipe_blacklist_threshold = number;
            saveSettingsDebounced();
        }
    });

    $('#auto_fix_generated_markdown').on('input', function () {
        power_user.auto_fix_generated_markdown = !!$(this).prop('checked');
        reloadCurrentChat();
        saveSettingsDebounced();
    });

    $('#console_log_prompts').on('input', function () {
        power_user.console_log_prompts = !!$(this).prop('checked');
        saveSettingsDebounced();
    });

    $('#request_token_probabilities').on('input', function () {
        power_user.request_token_probabilities = !!$(this).prop('checked');
        saveSettingsDebounced();
    });

    $('#show_group_chat_queue').on('input', function () {
        power_user.show_group_chat_queue = !!$(this).prop('checked');
        saveSettingsDebounced();
    });

    $('#auto_scroll_chat_to_bottom').on('input', function () {
        power_user.auto_scroll_chat_to_bottom = !!$(this).prop('checked');
        saveSettingsDebounced();
    });

    $('#tokenizer').on('change', function () {
        const value = $(this).find(':selected').val();
        power_user.tokenizer = Number(value);
        BIAS_CACHE.clear();
        resetTokenizationCachesForSettingsChange();
        saveSettingsDebounced();

        // Trigger character editor re-tokenize
        forceCharacterEditorTokenize();
    });

    $('#send_on_enter').on('change', function () {
        const value = $(this).find(':selected').val();
        power_user.send_on_enter = Number(value);
        saveSettingsDebounced();
    });

    $('#confirm_message_delete').on('input', function () {
        power_user.confirm_message_delete = !!$(this).prop('checked');
        saveSettingsDebounced();
    });

    $('#reload_chat').on('click', async function () {
        const currentChatId = getCurrentChatId();
        if (currentChatId !== undefined && currentChatId !== null) {
            await saveSettings();
            await saveChatConditional();
            await reloadCurrentChat();
        }
    });

    $('#allow_name1_display').on('input', function () {
        power_user.allow_name1_display = !!$(this).prop('checked');
        reloadCurrentChat();
        saveSettingsDebounced();
    });

    $('#allow_name2_display').on('input', function () {
        power_user.allow_name2_display = !!$(this).prop('checked');
        reloadCurrentChat();
        saveSettingsDebounced();
    });

    $('#token_padding').on('input', function () {
        power_user.token_padding = Number($(this).val());
        resetTokenizationCachesForSettingsChange();
        saveSettingsDebounced();
    });

    $('#messageTimerEnabled').on('input', function () {
        const value = !!$(this).prop('checked');
        power_user.timer_enabled = value;
        switchTimer();
        saveSettingsDebounced();
    });

    $('#messageTimestampsEnabled').on('input', function () {
        const value = !!$(this).prop('checked');
        power_user.timestamps_enabled = value;
        switchTimestamps();
        saveSettingsDebounced();
    });

    $('#messageModelIconEnabled').on('input', function () {
        const value = !!$(this).prop('checked');
        power_user.timestamp_model_icon = value;
        switchIcons();
        saveSettingsDebounced();
    });

    $('#messageModelNameEnabled').on('input', function () {
        power_user.timestamp_model_name = !!$(this).prop('checked');
        refreshMessageModelIcons();
        saveSettingsDebounced();
    });

    $('#messageReasoningEffortEnabled').on('input', function () {
        power_user.timestamp_reasoning_effort = !!$(this).prop('checked');
        refreshMessageModelIcons();
        saveSettingsDebounced();
    });

    $('#messageTokensEnabled').on('input', function () {
        const value = !!$(this).prop('checked');
        power_user.message_token_count_enabled = value;
        switchTokenCount();
        saveSettingsDebounced();
    });

    $('#expandMessageActions').on('input', function () {
        const value = !!$(this).prop('checked');
        power_user.expand_message_actions = value;
        switchMessageActions();
        saveSettingsDebounced();
    });

    $('#enableZenSliders').on('input', function () {
        const value = !!$(this).prop('checked');
        if (power_user.enableLabMode === true && value === true) {
            //disallow zenSliders while Lab Mode is active
            toastr.warning('Disable Mad Lab Mode before enabling Zen Sliders');
            $(this).prop('checked', false).trigger('input');
            return;
        }
        power_user.enableZenSliders = value;
        switchZenSliders();
        saveSettingsDebounced();
    });

    $('#enableLabMode').on('input', function (event, { fromInit = false } = {}) {
        const value = !!$(this).prop('checked');
        if (power_user.enableZenSliders === true && value === true) {
            //disallow Lab Mode if ZenSliders are active
            toastr.warning('Disable Zen Sliders before enabling Mad Lab Mode');
            $(this).prop('checked', false).trigger('input');
            return;
        }

        power_user.enableLabMode = value;
        switchLabMode({ noReset: fromInit });
        saveSettingsDebounced();
    });

    $('#mesIDDisplayEnabled').on('input', function () {
        const value = !!$(this).prop('checked');
        power_user.mesIDDisplay_enabled = value;
        switchMesIDDisplay();
        saveSettingsDebounced();
    });

    $('#hideChatAvatarsEnabled').on('input', function () {
        const value = !!$(this).prop('checked');
        power_user.hideChatAvatars_enabled = value;
        switchHideChatAvatars();
        saveSettingsDebounced();
    });

    $('#hotswapEnabled').on('input', function () {
        const value = !!$(this).prop('checked');
        power_user.hotswap_enabled = value;
        switchHotswap();
        saveSettingsDebounced();
    });

    $('#prefer_character_prompt').on('input', function () {
        const value = !!$(this).prop('checked');
        power_user.prefer_character_prompt = value;
        saveSettingsDebounced();
    });

    $('#prefer_character_jailbreak').on('input', function () {
        const value = !!$(this).prop('checked');
        power_user.prefer_character_jailbreak = value;
        saveSettingsDebounced();
    });

    $('#continue_on_send').on('input', function () {
        const value = !!$(this).prop('checked');
        power_user.continue_on_send = value;
        saveSettingsDebounced();
    });

    $('#quick_continue').on('input', function () {
        const value = !!$(this).prop('checked');
        power_user.quick_continue = value;
        $('#mes_continue').css('display', value ? '' : 'none');
        saveSettingsDebounced();
    });

    $('#quick_impersonate').on('input', function () {
        const value = !!$(this).prop('checked');
        power_user.quick_impersonate = value;
        $('#mes_impersonate').css('display', value ? '' : 'none');
        saveSettingsDebounced();
    });

    $('#trim_spaces').on('input', function () {
        const value = !!$(this).prop('checked');
        power_user.trim_spaces = value;
        saveSettingsDebounced();
    });

    $('#relaxed_api_urls').on('input', function () {
        const value = !!$(this).prop('checked');
        power_user.relaxed_api_urls = value;
        saveSettingsDebounced();
    });

    $('#world_import_dialog').on('input', function () {
        const value = !!$(this).prop('checked');
        power_user.world_import_dialog = value;
        saveSettingsDebounced();
    });

    $('#enable_auto_select_input').on('input', function () {
        const value = !!$(this).prop('checked');
        power_user.enable_auto_select_input = value;
        saveSettingsDebounced();
    });

    $('#enable_md_hotkeys').on('input', function () {
        const value = !!$(this).prop('checked');
        power_user.enable_md_hotkeys = value;
        toggleMDHotkeyIconDisplay();
        saveSettingsDebounced();
    });

    $('#spoiler_free_mode').on('input', function () {
        power_user.spoiler_free_mode = !!$(this).prop('checked');
        switchSpoilerMode();
        saveSettingsDebounced();
    });

    $('#spoiler_free_desc_button').on('click', function (e) {
        e.stopPropagation();
        peekSpoilerMode();
        $(this).toggleClass('fa-eye fa-eye-slash');
    });

    $('#custom_stopping_strings').on('input', function () {
        power_user.custom_stopping_strings = String($(this).val()).trim();
        saveSettingsDebounced();
    });

    $('#custom_stopping_strings_macro').on('change', function () {
        power_user.custom_stopping_strings_macro = !!$(this).prop('checked');
        saveSettingsDebounced();
    });

    $('#fuzzy_search_checkbox').on('input', function () {
        power_user.fuzzy_search = !!$(this).prop('checked');
        saveSettingsDebounced();
    });

    $('#persona_show_notifications').on('input', function () {
        power_user.persona_show_notifications = !!$(this).prop('checked');
        saveSettingsDebounced();
    });

    $('#persona_allow_multi_connections').on('input', function () {
        power_user.persona_allow_multi_connections = !!$(this).prop('checked');
        saveSettingsDebounced();
    });

    $('#persona_auto_lock').on('input', function () {
        power_user.persona_auto_lock = !!$(this).prop('checked');
        saveSettingsDebounced();
    });

    $('#encode_tags').on('input', async function () {
        power_user.encode_tags = !!$(this).prop('checked');
        await reloadCurrentChat();
        saveSettingsDebounced();
    });

    $('#experimental_macro_engine').on('input', function () {
        power_user.experimental_macro_engine = !!$(this).prop('checked');
        saveSettingsDebounced();

        // Check if the app is ready before showing the toast
        if (!settingsReady) {
            return;
        }

        eventSource.once(event_types.SETTINGS_UPDATED, function () {
            toastr.warning(
                t`Click here to reload.`,
                t`Toggling the Experimental Macro Engine requires a reload.`,
                {
                    onclick: () => window.location.reload(),
                    timeOut: 10000,
                    preventDuplicates: true,
                },
            );
        });
    });

    $('#disable_group_trimming').on('input', function () {
        power_user.disable_group_trimming = !!$(this).prop('checked');
        saveSettingsDebounced();
    });

    $('#debug_menu').on('click', function () {
        showDebugMenu();
    });

    $('#bogus_folders').on('input', function () {
        power_user.bogus_folders = !!$(this).prop('checked');
        printCharactersDebounced();
        saveSettingsDebounced();
    });

    $('#zoomed_avatar_magnification').on('input', function () {
        power_user.zoomed_avatar_magnification = !!$(this).prop('checked');
        printCharactersDebounced();
        saveSettingsDebounced();
    });

    $('#aux_field').on('change', function () {
        const value = $(this).find(':selected').val();
        power_user.aux_field = String(value);
        printCharactersDebounced();
        saveSettingsDebounced();
    });

    $('#tag_import_setting').on('change', function () {
        const value = $(this).find(':selected').val();
        power_user.tag_import_setting = Number(value);
        saveSettingsDebounced();
    });

    $('#stscript_autocomplete_state').on('input', function () {
        power_user.stscript.autocomplete.state = Number($(this).val());
        saveSettingsDebounced();
    });

    $('#stscript_autocomplete_autoHide').on('input', function () {
        power_user.stscript.autocomplete.autoHide = !!$(this).prop('checked');
        saveSettingsDebounced();
    });

    $('#stscript_autocomplete_showInAllMacroFields').on('input', function () {
        power_user.stscript.autocomplete.showInAllMacroFields = !!$(this).prop('checked');
        saveSettingsDebounced();
    });

    $('#stscript_matching').on('change', function () {
        const value = $(this).find(':selected').val();
        power_user.stscript.matching = String(value);
        saveSettingsDebounced();
    });

    $('#stscript_autocomplete_style').on('change', function () {
        const value = $(this).find(':selected').val();
        power_user.stscript.autocomplete.style = String(value);
        document.body.setAttribute('data-stscript-style', power_user.stscript.autocomplete.style);
        saveSettingsDebounced();
    });

    $('#stscript_autocomplete_select').on('change', function () {
        const value = $(this).find(':selected').val();
        power_user.stscript.autocomplete.select = parseInt(String(value));
        saveSettingsDebounced();
    });

    $('#stscript_autocomplete_font_scale').on('input', function () {
        const value = $(this).val();
        $('#stscript_autocomplete_font_scale_counter').val(value);
        power_user.stscript.autocomplete.font.scale = Number(value);
        document.body.style.setProperty('--ac-font-scale', value.toString());
        window.dispatchEvent(new Event('resize', { bubbles: true }));
        saveSettingsDebounced();
    });
    $('#stscript_autocomplete_font_scale_counter').on('input', function () {
        const value = $(this).val();
        $('#stscript_autocomplete_font_scale').val(value);
        power_user.stscript.autocomplete.font.scale = Number(value);
        document.body.style.setProperty('--ac-font-scale', value.toString());
        window.dispatchEvent(new Event('resize', { bubbles: true }));
        saveSettingsDebounced();
    });

    $('#stscript_autocomplete_width_left').on('input', function () {
        const value = $(this).val();
        power_user.stscript.autocomplete.width.left = Number(value);
        /**@type {HTMLElement}*/(this.closest('.doubleRangeInputContainer')).style.setProperty('--value', value.toString());
        window.dispatchEvent(new Event('resize', { bubbles: true }));
        saveSettingsDebounced();
    });

    $('#stscript_autocomplete_width_right').on('input', function () {
        const value = $(this).val();
        power_user.stscript.autocomplete.width.right = Number(value);
        /**@type {HTMLElement}*/(this.closest('.doubleRangeInputContainer')).style.setProperty('--value', value.toString());
        window.dispatchEvent(new Event('resize', { bubbles: true }));
        saveSettingsDebounced();
    });

    $('#stscript_parser_flag_strict_escaping').on('click', function () {
        const value = $(this).prop('checked');
        power_user.stscript.parser.flags[PARSER_FLAG.STRICT_ESCAPING] = value;
        saveSettingsDebounced();
    });

    $('#stscript_parser_flag_replace_getvar').on('click', function () {
        const value = $(this).prop('checked');
        power_user.stscript.parser.flags[PARSER_FLAG.REPLACE_GETVAR] = value;
        saveSettingsDebounced();
    });

    $('#restore_user_input').on('input', function () {
        power_user.restore_user_input = !!$(this).prop('checked');
        saveSettingsDebounced();
    });

    $('#reduced_motion').on('input', function () {
        power_user.reduced_motion = !!$(this).prop('checked');
        switchReducedMotion();
        saveSettingsDebounced();
    });

    $('#compact_input_area').on('input', function () {
        power_user.compact_input_area = !!$(this).prop('checked');
        switchCompactInputArea();
        saveSettingsDebounced();
    });

    $('#show_swipe_num_all_messages').on('input', function () {
        power_user.show_swipe_num_all_messages = !!$(this).prop('checked');
        switchSwipeNumAllMessages();
        saveSettingsDebounced();
    });

    $('#auto-connect-checkbox').on('input', function () {
        power_user.auto_connect = !!$(this).prop('checked');
        saveSettingsDebounced();
    });

    $('#auto-load-chat-checkbox').on('input', function () {
        power_user.auto_load_chat = !!$(this).prop('checked');
        saveSettingsDebounced();
    });

    $('#forbid_external_media').on('input', function () {
        power_user.forbid_external_media = !!$(this).prop('checked');
        saveSettingsDebounced();
        reloadCurrentChat();
    });

    $('#allow_card_scripts').on('input', function () {
        power_user.allow_card_scripts = !!$(this).prop('checked');
        saveSettingsDebounced();
    });

    $('#pin_styles').on('input', function () {
        power_user.pin_styles = !!$(this).prop('checked');
        saveSettingsDebounced();
        applyStylePins();
    });

    $('#click_to_edit').on('input', function () {
        power_user.click_to_edit = !!$(this).prop('checked');
        saveSettingsDebounced();
    });

    $('#ui_preset_import_button').on('click', function () {
        $('#ui_preset_import_file').trigger('click');
    });

    $('#ui_preset_import_file').on('change', async function () {
        const inputElement = this instanceof HTMLInputElement && this;

        try {
            const file = inputElement?.files?.[0];
            await importTheme(file);
        } catch (error) {
            console.error('Error importing UI theme', error);
            toastr.error(String(error), 'Failed to import UI theme');
        } finally {
            if (inputElement) {
                inputElement.value = null;
            }
        }
    });

    $('#ui_preset_export_button').on('click', async function () {
        await exportTheme();
    });

    $(document).on('click', '.sb-theme-preset-button', function () {
        applySillyBunnyPalettePreset(String($(this).data('sb-palette')));
    });

    $(document).on('click', '.sb-theme-preset-reset', function () {
        applyTheme('Dark V 1.0');
        saveSettingsDebounced();
        toastr.info('Theme colors reset to Dark V 1.0.', 'SillyBunny palette');
    });

    // Accent color presets
    $(document).on('click', '.sb-accent-preset', function () {
        const accent = $(this).data('accent');
        let quoteColor, underlineColor;

        switch (accent) {
            case 'blue':
                quoteColor = 'rgba(59, 130, 246, 1)';
                underlineColor = 'rgba(96, 165, 250, 1)';
                break;
            case 'cyan':
                quoteColor = 'rgba(6, 182, 212, 1)';
                underlineColor = 'rgba(34, 211, 238, 1)';
                break;
            case 'green':
                quoteColor = 'rgba(16, 185, 129, 1)';
                underlineColor = 'rgba(52, 211, 153, 1)';
                break;
            case 'yellow':
                quoteColor = 'rgba(245, 158, 11, 1)';
                underlineColor = 'rgba(251, 191, 36, 1)';
                break;
            case 'orange':
                quoteColor = 'rgba(255, 191, 0, 1)';
                underlineColor = 'rgba(255, 191, 0, 1)';
                break;
            case 'red':
                quoteColor = 'rgba(239, 68, 68, 1)';
                underlineColor = 'rgba(248, 113, 113, 1)';
                break;
            case 'pink':
                quoteColor = 'rgba(236, 72, 153, 1)';
                underlineColor = 'rgba(244, 114, 182, 1)';
                break;
            case 'purple':
                quoteColor = 'rgba(168, 85, 247, 1)';
                underlineColor = 'rgba(192, 132, 252, 1)';
                break;
            case 'gray':
                quoteColor = 'rgba(107, 114, 128, 1)';
                underlineColor = 'rgba(156, 163, 175, 1)';
                break;
        }

        if (quoteColor && underlineColor) {
            applyAccentColors(quoteColor, underlineColor);
            toastr.info('Accent colors applied.', 'SillyBunny palette');
        }
    });

    bindSbAccentProfilesDrawerPersistence();

    $(document).on('click', '#sb-accent-profile-save', async function () {
        await saveAccentProfile();
    });

    $(document).on('click', '.sb-accent-profile-apply', function () {
        applyAccentProfile(Number($(this).attr('data-accent-profile-index')));
    });

    $(document).on('click', '.sb-accent-profile-delete', async function () {
        await deleteAccentProfile(Number($(this).attr('data-accent-profile-index')));
    });

    // Custom RGB accent toggle
    $('#sb-custom-accent-mode').on('change', function () {
        const customPickers = $('#sb-custom-accent-pickers');
        if ($(this).is(':checked')) {
            customPickers.show();
        } else {
            customPickers.hide();
        }
    });

    // Custom accent color pickers
    $('#sb-accent-primary-picker').on('change', (/** @type {ColorPickerEvent} */ evt) => {
        power_user.quote_text_color = evt.detail.rgba;
        applyThemeColor('quote');
        renderAccentProfiles();
        saveSettingsDebounced();
    });

    $('#sb-accent-secondary-picker').on('change', (/** @type {ColorPickerEvent} */ evt) => {
        power_user.underline_text_color = evt.detail.rgba;
        applyThemeColor('underline');
        renderAccentProfiles();
        saveSettingsDebounced();
    });

    $('#media_display').on('input', async function () {
        power_user.media_display = $(this).val().toString();
        saveSettingsDebounced();
        if (isMediaDisplayReloadNeeded()) {
            await reloadCurrentChat();
        }
    });

    $('#image_overswipe').on('input', function () {
        power_user.image_overswipe = $(this).val().toString();
        saveSettingsDebounced();
    });

    $(document).on('click', '#debug_table [data-debug-function]', function () {
        const functionId = $(this).data('debug-function');
        const functionRecord = debug_functions.find(f => f.functionId === functionId);

        if (functionRecord) {
            functionRecord.func();
        } else {
            console.warn(`Debug function ${functionId} not found`);
        }
    });

    $(window).on('focus', function () {
        browser_has_focus = true;
    });

    $(window).on('blur', function () {
        browser_has_focus = false;
    });

    const { SlashCommandParser } = await import('./slash-commands/SlashCommandParser.js');

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'vn',
        callback: toggleWaifu,
        helpString: 'Swaps Visual Novel Mode On/Off',
    }));
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'newchat',
        /** @type {(args: { delete: string?}, string) => Promise<''>} */
        callback: async (args, _) => {
            await doNewChat({ deleteCurrentChat: isTrueBoolean(args.delete) });
            return '';
        },
        namedArgumentList: [
            SlashCommandNamedArgument.fromProps({
                name: 'delete',
                description: 'delete the current chat',
                typeList: [ARGUMENT_TYPE.BOOLEAN],
                defaultValue: 'false',
                enumList: commonEnumProviders.boolean('trueFalse')(),
            }),
        ],
        helpString: 'Start a new chat with the current character',
    }));
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'random',
        callback: doRandomChat,
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: 'optional tag name',
                typeList: [ARGUMENT_TYPE.STRING],
                enumProvider: () => tags.filter(tag => Object.values(tag_map).some(x => x.includes(tag.id))).map(tag => new SlashCommandEnumValue(tag.name, null, enumTypes.enum, enumIcons.tag)),
            }),
        ],
        helpString: 'Start a new chat with a random character. If an argument is provided, only considers characters that have the specified tag.',
    }));
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'del',
        callback: doDelMode,
        aliases: ['delete', 'delmode'],
        unnamedArgumentList: [
            new SlashCommandArgument(
                'optional number', [ARGUMENT_TYPE.NUMBER], false,
            ),
        ],
        helpString: 'Enter message deletion mode, and auto-deletes last N messages if numeric argument is provided.',
        returns: 'The text of the deleted messages.',
    }));
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'cut',
        callback: doMesCut,
        returns: 'the text of cut messages separated by a newline',
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: 'number or range',
                typeList: [ARGUMENT_TYPE.NUMBER, ARGUMENT_TYPE.RANGE],
                isRequired: true,
                acceptsMultiple: true,
                enumProvider: commonEnumProviders.messages(),
            }),
        ],
        helpString: `
            <div>
                Cuts the specified message or continuous chunk from the chat.
            </div>
            <div>
                Ranges are inclusive!
            </div>
            <div>
                <strong>Example:</strong>
                <ul>
                    <li>
                        <pre><code>/cut 0-10</code></pre>
                    </li>
                </ul>
            </div>
        `,
        aliases: [],
    }));
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'resetpanels',
        callback: doResetPanels,
        helpString: 'resets UI panels to original state',
        aliases: ['resetui'],
    }));
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'bgcol',
        callback: setAvgBG,
        namedArgumentList: [
            SlashCommandNamedArgument.fromProps({
                name: 'force',
                description: 'force generation even if a theme with the same name already exists',
                typeList: [ARGUMENT_TYPE.BOOLEAN],
                defaultValue: 'false',
                enumList: commonEnumProviders.boolean('trueFalse')(),
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'name',
                description: 'override the generated theme name',
                typeList: [ARGUMENT_TYPE.STRING],
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'bg',
                description: 'background image filename to use instead of the current one',
                typeList: [ARGUMENT_TYPE.STRING],
                enumProvider: commonEnumProviders.backgrounds,
            }),
        ],
        helpString: 'Generates a new theme based on a dominant color of the specified background image. Saves as "bgcol - background name".',
    }));
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'theme',
        callback: setThemeCallback,
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: 'theme name',
                typeList: [ARGUMENT_TYPE.STRING],
                enumProvider: () => themes.map(theme => new SlashCommandEnumValue(theme.name)),
            }),
        ],
        helpString: `
        <div>
            Sets a UI theme by name.
        </div>
        <div>
            If no theme name is is provided, this will return the currently active theme.
        </div>
        <div>
            <strong>Example:</strong>
            <ul>
                <li>
                    <pre><code>/theme Cappuccino</code></pre>
                </li>
                <li>
                    <pre><code>/theme</code></pre>
                </li>
            </ul>
        </div>
    `,
    }));
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'css-var',
        /** @param {{to: string, varname: string }} args @param {string} value @returns {string} */
        callback: (args, value) => {
            // Map enum to target selector
            const targetSelector = {
                chat: '#chat',
                background: '#bg1',
                gallery: '#gallery',
                zoomedAvatar: 'div.zoomed_avatar',
            }[args.to || 'chat'];

            if (!targetSelector) {
                toastr.error(`Invalid target: ${args.to}`);
                return;
            }

            if (!args.varname) {
                toastr.error('CSS variable name is required');
                return;
            }
            if (!args.varname.startsWith('--')) {
                toastr.error('CSS variable names must start with "--"');
                return;
            }

            const elements = document.querySelectorAll(targetSelector);
            if (elements.length === 0) {
                toastr.error(`No elements found for ${args.to ?? 'chat'} with selector "${targetSelector}"`);
                return;
            }

            elements.forEach(element => {
                element.style.setProperty(args.varname, value);
            });

            console.info(`Set CSS variable "${args.varname}" to "${value}" on "${targetSelector}"`);
        },
        namedArgumentList: [
            SlashCommandNamedArgument.fromProps({
                name: 'varname',
                description: 'CSS variable name (starting with double dashes)',
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: true,
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'to',
                description: 'The target element to which the CSS variable will be applied',
                typeList: [ARGUMENT_TYPE.STRING],
                enumList: [
                    new SlashCommandEnumValue('chat', null, enumTypes.enum, enumIcons.message),
                    new SlashCommandEnumValue('background', null, enumTypes.enum, enumIcons.image),
                    new SlashCommandEnumValue('zoomedAvatar', null, enumTypes.enum, enumIcons.character),
                    new SlashCommandEnumValue('gallery', null, enumTypes.enum, enumIcons.image),
                ],
                defaultValue: 'chat',
            }),
        ],
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: 'CSS variable value',
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: true,
            }),
        ],
        helpString: `
            <div>
                Sets a CSS variable to a specified value on a target element.
                <br />
                Only setting of variable names is supported. They have to be prefixed with double dashes ("--exampleVar").
                Setting actual CSS properties is not supported. Custom CSS in the theme settings can be used for that.
                <br /><br />
                <b>This value will be gone after a page reload!</b>
            </div>
            <div>
                <strong>Example:</strong>
                <ul>
                    <li>
                        <pre><code>/css-var varname="--SmartThemeBodyColor" #ff0000</code></pre>
                        Sets the text color of the chat to red
                    </li>
                    <li>
                        <pre><code>/css-var to=zoomedAvatar varname="--SmartThemeBlurStrength" 0</code></pre>
                        Remove the blur from the zoomed avatar
                    </li>
                </ul>
            </div>
        `,
    }));
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'movingui',
        callback: setmovingUIPreset,
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: 'name',
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: true,
                enumProvider: () => movingUIPresets.map(preset => new SlashCommandEnumValue(preset.name)),
            }),
        ],
        helpString: 'activates a movingUI preset by name',
    }));
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'stop-strings',
        aliases: ['stopping-strings', 'custom-stopping-strings', 'custom-stop-strings'],
        helpString: `
            <div>
                Sets a list of custom stopping strings. Gets the list if no value is provided.
                Use a "force" argument to force set an empty value.
            </div>
            <div>
                <strong>Examples:</strong>
            </div>
            <ul>
                <li>Force set an empty value: <pre><code class="language-stscript">/stop-strings force="true" {{noop}}</code></pre></li>
                <li>Value must be a JSON-serialized array: <pre><code class="language-stscript">/stop-strings ["goodbye", "farewell"]</code></pre></li>
                <li>Pipe characters must be escaped with a backslash: <pre><code class="language-stscript">/stop-strings ["left\\|right"]</code></pre></li>
            </ul>
        `,
        returns: ARGUMENT_TYPE.LIST,
        namedArgumentList: [
            SlashCommandNamedArgument.fromProps({
                name: 'force',
                description: 'force set a value if empty',
                typeList: [ARGUMENT_TYPE.BOOLEAN],
                defaultValue: 'false',
                enumList: commonEnumProviders.boolean('trueFalse')(),
            }),
        ],
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: 'list of strings',
                typeList: [ARGUMENT_TYPE.LIST],
                acceptsMultiple: false,
                isRequired: false,
            }),
        ],
        callback: (args, value) => {
            const force = isTrueBoolean(String(args?.force ?? false));
            value = String(value ?? '').trim();

            // Skip processing if no value and not forced
            if (!force && !value) {
                return power_user.custom_stopping_strings;
            }

            // Use empty array for forced empty value
            if (force && !value) {
                value = JSON.stringify([]);
            }

            const parsedValue = ((x) => { try { return JSON.parse(x.toString()); } catch { return null; } })(value);
            if (!parsedValue || !Array.isArray(parsedValue)) {
                throw new Error('Invalid list format. The value must be a JSON-serialized array of strings.');
            }
            parsedValue.forEach((item, index) => {
                parsedValue[index] = String(item);
            });
            power_user.custom_stopping_strings = JSON.stringify(parsedValue);
            $('#custom_stopping_strings').val(power_user.custom_stopping_strings);
            saveSettingsDebounced();

            return power_user.custom_stopping_strings;
        },
    }));
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'start-reply-with',
        helpString: `
            <div>
                Sets a "Start Reply With". Gets the current value if no value is provided.
                Use a "force" argument to force set an empty value.
            </div>
            <div>
                <strong>Examples:</strong>
            </div>
            <ul>
                <li>Set the field value: <pre><code class="language-stscript">/start-reply-with Sure!</code></pre></li>
                <li>Force set an empty value: <pre><code class="language-stscript">/start-reply-with force="true" {{noop}}</code></pre></li>
            </ul>
        `,
        namedArgumentList: [
            SlashCommandNamedArgument.fromProps({
                name: 'force',
                description: 'force set a value if empty',
                typeList: [ARGUMENT_TYPE.BOOLEAN],
                defaultValue: 'false',
                enumList: commonEnumProviders.boolean('trueFalse')(),
            }),
        ],
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: 'value',
                typeList: [ARGUMENT_TYPE.STRING],
                acceptsMultiple: false,
                isRequired: false,
            }),
        ],
        callback: (args, value) => {
            const force = isTrueBoolean(String(args?.force ?? false));

            // Skip processing if no value and not forced
            if (!force && !value) {
                return power_user.user_prompt_bias;
            }

            power_user.user_prompt_bias = String(value ?? '');
            $('.start-reply-with-input').val(power_user.user_prompt_bias);
            saveSettingsDebounced();

            return power_user.user_prompt_bias;
        },
    }));
});
