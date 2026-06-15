/*
* CODE FOR OPENAI SUPPORT
* By CncAnon (@CncAnon1)
* https://github.com/CncAnon1/TavernAITurbo
*/
import { Fuse, DOMPurify } from '../lib.js';

import {
    abortStatusCheck,
    cancelStatusCheck,
    characters,
    event_types,
    eventSource,
    extension_prompt_roles,
    extension_prompt_types,
    Generate,
    getExtensionPrompt,
    getExtensionPromptMaxDepth,
    getMediaDisplay,
    getMediaIndex,
    getRequestHeaders,
    is_send_press,
    main_api,
    name1,
    name2,
    resultCheckStatus,
    saveSettings,
    saveSettingsDebounced,
    setOnlineStatus,
    startStatusLoading,
    substituteParams,
    substituteParamsExtended,
    refreshMessageModelIcons,
    system_message_types,
    this_chid,
} from '../script.js';
import { getGroupNames, selected_group } from './group-chats.js';

import {
    chatCompletionDefaultPrompts,
    INJECTION_POSITION,
    Prompt,
    PromptManager,
    promptManagerDefaultPromptOrders,
} from './PromptManager.js';

import { forceCharacterEditorTokenize, getCustomStoppingStrings, persona_description_positions, power_user } from './power-user.js';
import { SECRET_KEYS, secret_state, writeSecret } from './secrets.js';

import { getEventSourceStream } from './sse-stream.js';
import {
    createThumbnail,
    delay,
    download,
    getAudioDurationFromDataURL,
    getBase64Async,
    getFileText,
    getImageSizeFromDataURL,
    getSortableDelay,
    getStringHash,
    getVideoDurationFromDataURL,
    isDataURL,
    isFalseBoolean,
    isTrueBoolean,
    isUuid,
    isValidUrl,
    parseJsonFile,
    resetScrollHeight,
    stringFormat,
    textValueMatcher,
    uuidv4,
} from './utils.js';
import { countChatCompletionPayloadTokensOpenAIAsync, countTokensOpenAIAsync, getTokenizerModel } from './tokenizers.js';
import { isMobile } from './RossAscends-mods.js';
import { saveLogprobsForActiveMessage } from './logprobs.js';
import { SlashCommandParser } from './slash-commands/SlashCommandParser.js';
import { SlashCommand } from './slash-commands/SlashCommand.js';
import { ARGUMENT_TYPE, SlashCommandArgument, SlashCommandNamedArgument } from './slash-commands/SlashCommandArgument.js';
import { renderTemplateAsync } from './templates.js';
import { SlashCommandEnumValue } from './slash-commands/SlashCommandEnumValue.js';
import { callGenericPopup, Popup, POPUP_RESULT, POPUP_TYPE } from './popup.js';
import { t } from './i18n.js';
import { ToolManager } from './tool-calling.js';
import { accountStorage } from './util/AccountStorage.js';
import { COMETAPI_IGNORE_PATTERNS, IGNORE_SYMBOL, MEDIA_DISPLAY, MEDIA_TYPE } from './constants.js';
import { syncOpenRouterProvidersForModel, updateOpenRouterProvidersWarning } from './textgen-models.js';
import { hasTextOrArrayPayload, shouldRetainContextAtDepth, stripHtmlTagsFromContext, stripOocBlocksFromContext } from './ooc-blocks.js';
import { checkPostInterceptChatBudget, shouldCheckPostInterceptChatBudget } from './openai-prompt-budget.js';
import {
    buildChatCompletionPresetForSave,
    buildChatCompletionSamplingSettingsSnapshot,
    buildReverseProxyPresetForSave,
    normalizeReverseProxyPreset,
    shouldIncludeSamplingFieldsInPreset,
} from './openai-preset-utils.js';
import { TOOL_CALL_RECURSE_LIMIT_DEFAULT, normalizeToolCallRecurseLimit } from './tool-call-recurse-limit.js';

export {
    openai_messages_count,
    oai_settings,
    loadOpenAISettings,
    setOpenAIMessages,
    setOpenAIMessageExamples,
    setupChatCompletionPromptManager,
    sendOpenAIRequest,
    TokenHandler,
    IdentifierNotFoundError,
    Message,
    MessageCollection,
};

let openai_messages_count = 0;

const default_main_prompt = 'Write {{char}}\'s next reply in a fictional chat between {{charIfNotGroup}} and {{user}}.';
const default_nsfw_prompt = '';
const default_jailbreak_prompt = '';
const default_impersonation_prompt = '[Write your next reply from the point of view of {{user}}, using the chat history so far as a guideline for the writing style of {{user}}. Don\'t write as {{char}} or system. Don\'t describe actions of {{char}}.]';
const default_assistant_impersonation = '{{user}}:';
const default_enhance_definitions_prompt = 'If you have more knowledge of {{char}}, add to the character\'s lore and personality to enhance them but keep the Character Sheet\'s definitions absolute.';
const default_wi_format = '{0}';
const default_new_chat_prompt = '[Start a new Chat]';
const default_new_group_chat_prompt = '[Start a new group chat. Group members: {{group}}]';
const default_new_example_chat_prompt = '[Example Chat]';
const default_continue_nudge_prompt = '[Continue your last message without repeating its original content.]';
const default_bias = 'Default (none)';
const default_personality_format = '{{personality}}';
const default_scenario_format = '{{scenario}}';
const legacy_group_nudge_prompt = '[Write the next reply only as {{char}}.]';
const default_group_nudge_prompt = '[Group chat turn: write the next reply only as {{char}}. The full conversation matters: {{char}} may address, react to, interrupt, answer, agree with, disagree with, or ask questions of any participant, not only {{user}}. Other participants currently present: {{notChar}}. Do not write dialogue or actions for anyone except {{char}}.]';
const default_bias_presets = {
    [default_bias]: [],
    'Anti-bond': [
        { id: '22154f79-dd98-41bc-8e34-87015d6a0eaf', text: ' bond', value: -50 },
        { id: '8ad2d5c4-d8ef-49e4-bc5e-13e7f4690e0f', text: ' future', value: -50 },
        { id: '52a4b280-0956-4940-ac52-4111f83e4046', text: ' bonding', value: -50 },
        { id: 'e63037c7-c9d1-4724-ab2d-7756008b433b', text: ' connection', value: -25 },
    ],
};
const SERVER_CHAT_COMPLETION_CONFIG_DEFAULTS = Object.freeze({
    claude: Object.freeze({
        enableSystemPromptCache: false,
        cachingAtDepth: -1,
        extendedTTL: false,
        enableAdaptiveThinking: true,
    }),
    gemini: Object.freeze({
        apiVersion: 'v1beta',
        thoughtSignatures: true,
        enableSystemPromptCache: false,
    }),
});
const OPENAI_SETTINGS_DRAWER_STATE_KEY_PREFIX = 'OpenAIDrawerState:';

function hasPromptPayload(chatItem) {
    return hasTextOrArrayPayload(chatItem?.content, [
        chatItem?.media,
        chatItem?.invocations,
    ]);
}

const serverChatCompletionConfigState = {
    loaded: false,
    busy: false,
    restarting: false,
    lastModifiedMs: 0,
    originalSettings: null,
};

const max_2k = 2047;
const max_4k = 4095;
const max_8k = 8191;
const max_16k = 16383;
const max_32k = 32767;
const max_64k = 65535;
const max_128k = 128 * 1000;
const max_200k = 200 * 1000;
const max_256k = 256 * 1000;
const max_400k = 400 * 1000;
const max_1mil = 1000 * 1000;
const max_2mil = 2000 * 1000;
const unlocked_max = max_2mil;
const oai_max_temp = 2.0;
const claude_max_temp = 1.0;
const mistral_max_temp = 1.5;
const openrouter_website_model = 'OR_Website';
const openai_max_stop_strings = 4;

const textCompletionModels = [
    'gpt-3.5-turbo-instruct',
    'gpt-3.5-turbo-instruct-0914',
    'text-davinci-003',
    'text-davinci-002',
    'text-davinci-001',
    'text-curie-001',
    'text-babbage-001',
    'text-ada-001',
    'code-davinci-002',
    'code-davinci-001',
    'code-cushman-002',
    'code-cushman-001',
    'text-davinci-edit-001',
    'code-davinci-edit-001',
    'text-embedding-ada-002',
    'text-similarity-davinci-001',
    'text-similarity-curie-001',
    'text-similarity-babbage-001',
    'text-similarity-ada-001',
    'text-search-davinci-doc-001',
    'text-search-curie-doc-001',
    'text-search-babbage-doc-001',
    'text-search-ada-doc-001',
    'code-search-babbage-code-001',
    'code-search-ada-code-001',
];

let biasCache = undefined;
export let model_list = [];
let openAiStaticModelGroups = null;
let hasShownPresetConnectionBindingReminder = false;
let settingsPresetChangeGeneration = 0;

export const chat_completion_sources = {
    OPENAI: 'openai',
    CLAUDE: 'claude',
    OPENROUTER: 'openrouter',
    AI21: 'ai21',
    MAKERSUITE: 'makersuite',
    VERTEXAI: 'vertexai',
    MISTRALAI: 'mistralai',
    CUSTOM: 'custom',
    COHERE: 'cohere',
    PERPLEXITY: 'perplexity',
    GROQ: 'groq',
    ELECTRONHUB: 'electronhub',
    CHUTES: 'chutes',
    NANOGPT: 'nanogpt',
    DEEPSEEK: 'deepseek',
    AIMLAPI: 'aimlapi',
    XAI: 'xai',
    POLLINATIONS: 'pollinations',
    MOONSHOT: 'moonshot',
    FIREWORKS: 'fireworks',
    COMETAPI: 'cometapi',
    AZURE_OPENAI: 'azure_openai',
    OPENAI_RESPONSES: 'openai_responses',
    ZAI: 'zai',
    SILICONFLOW: 'siliconflow',
    MINIMAX: 'minimax',
    WORKERS_AI: 'workers_ai',
};

export const REVERSE_PROXY_SUPPORTED_SOURCES = [
    chat_completion_sources.CLAUDE,
    chat_completion_sources.OPENAI,
    chat_completion_sources.OPENAI_RESPONSES,
    chat_completion_sources.MISTRALAI,
    chat_completion_sources.MAKERSUITE,
    chat_completion_sources.VERTEXAI,
    chat_completion_sources.DEEPSEEK,
    chat_completion_sources.XAI,
    chat_completion_sources.ZAI,
    chat_completion_sources.MOONSHOT,
];

const REVERSE_PROXY_SOURCE_LABELS = {
    [chat_completion_sources.OPENAI]: 'OpenAI',
    [chat_completion_sources.OPENAI_RESPONSES]: 'OpenAI (Responses)',
    [chat_completion_sources.CLAUDE]: 'Claude',
    [chat_completion_sources.MISTRALAI]: 'MistralAI',
    [chat_completion_sources.MAKERSUITE]: 'AI Studio',
    [chat_completion_sources.VERTEXAI]: 'Vertex AI',
    [chat_completion_sources.DEEPSEEK]: 'DeepSeek',
    [chat_completion_sources.XAI]: 'xAI',
    [chat_completion_sources.ZAI]: 'Z.AI',
    [chat_completion_sources.MOONSHOT]: 'Moonshot',
};

const MODEL_ID_SEARCH_CONTROLS = [
    { source: chat_completion_sources.CLAUDE, setting: 'claude_model', input: '#claude_model_id', select: '#model_claude_select', dynamicGroupId: 'claude_other_models' },
    { source: chat_completion_sources.AI21, setting: 'ai21_model', input: '#ai21_model_id', select: '#model_ai21_select', dynamicGroupId: 'ai21_other_models' },
    { source: chat_completion_sources.COHERE, setting: 'cohere_model', input: '#cohere_model_id', select: '#model_cohere_select', dynamicGroupId: 'cohere_other_models' },
    { source: chat_completion_sources.PERPLEXITY, setting: 'perplexity_model', input: '#perplexity_model_id', select: '#model_perplexity_select', dynamicGroupId: 'perplexity_other_models' },
    { source: chat_completion_sources.MAKERSUITE, setting: 'google_model', input: '#makersuite_model_id', select: '#model_google_select', dynamicGroupId: 'google_other_models' },
    { source: chat_completion_sources.VERTEXAI, setting: 'vertexai_model', input: '#vertexai_model_id', select: '#model_vertexai_select', dynamicGroupId: 'vertexai_other_models' },
    { source: chat_completion_sources.CUSTOM, setting: 'custom_model', input: '#custom_model_id', select: '#model_custom_select', datalist: '#model_custom_select_fill', dynamicOnly: true },
    { source: chat_completion_sources.ZAI, setting: 'zai_model', input: '#zai_model_id', select: '#model_zai_select', dynamicGroupId: 'zai_other_models' },
];

const INLINE_SELECT_PICKER_CONTROLS = [
    { source: 'openrouter-model-chat', select: '#model_openrouter_select', label: 'OpenRouter model' },
    { source: 'openrouter-sort-models', select: '#openrouter_sort_models', label: 'OpenRouter model sorting' },
    { source: 'openrouter-providers-chat', select: '#openrouter_providers_chat', label: 'OpenRouter providers', multiple: true },
    { source: 'openrouter-quantizations-chat', select: '#openrouter_quantizations_chat', label: 'OpenRouter quantizations', multiple: true },
    { source: 'openrouter-model-text', select: '#openrouter_model', label: 'OpenRouter model' },
    { source: 'openrouter-middleout', select: '#openrouter_middleout', label: 'OpenRouter middle-out transform' },
    { source: 'openrouter-providers-text', select: '#openrouter_providers_text', label: 'OpenRouter providers', multiple: true },
    { source: 'openrouter-quantizations-text', select: '#openrouter_quantizations_text', label: 'OpenRouter quantizations', multiple: true },
];

// SillyBunny: touch browsers can open Select2 search as a keyboard-only field.
// Keep mobile OpenRouter/API selects backed by native values while rendering an inline list.
const modelIdSearchControlState = new Map();
let modelSelectPickerDocumentListenerBound = false;
let inlineSelectPickerObserverBound = false;

const character_names_behavior = {
    NONE: -1,
    DEFAULT: 0,
    COMPLETION: 1,
    CONTENT: 2,
};

const continue_postfix_types = {
    NONE: '',
    SPACE: ' ',
    NEWLINE: '\n',
    DOUBLE_NEWLINE: '\n\n',
};

export const custom_prompt_post_processing_types = {
    NONE: '',
    /** @deprecated Use MERGE instead. */
    CLAUDE: 'claude',
    MERGE: 'merge',
    MERGE_TOOLS: 'merge_tools',
    SEMI: 'semi',
    SEMI_TOOLS: 'semi_tools',
    STRICT: 'strict',
    STRICT_TOOLS: 'strict_tools',
    SINGLE: 'single',
};

const openrouter_middleout_types = {
    AUTO: 'auto',
    ON: 'on',
    OFF: 'off',
};

export const reasoning_effort_types = {
    none: 'none',
    low: 'low',
    medium: 'medium',
    high: 'high',
    min: 'min',
    max: 'max',
    xhigh: 'xhigh',
};

export const reasoning_tag_styles = {
    think: 'think',
    thinking: 'thinking',
    thought: 'thought',
};

export const custom_reasoning_preset_types = {
    OPENAI: 'openai',
    GLM_5_1: 'glm_5_1',
    KIMI_K2: 'kimi_k2',
    CUSTOM: 'custom',
};

export const custom_reasoning_param_formats = {
    OPENAI: 'openai',
    BOOLEAN: 'boolean',
    STRING: 'string',
    THINKING_OBJECT: 'thinking_object',
};

export const verbosity_levels = {
    auto: 'auto',
    low: 'low',
    medium: 'medium',
    high: 'high',
};

export const tool_reasoning_modes = {
    DISABLED: 'disabled',
    SINCE_LAST_USER: 'since_last_user',
    ACTIVE_CHAIN: 'active_chain',
};

// Providers that support interleaved reasoning forwarding in tool-call chains.
const interleaved_reasoning_providers = [
    chat_completion_sources.OPENROUTER,
];

export const ZAI_ENDPOINT = {
    COMMON: 'common',
    CODING: 'coding',
};

export const SILICONFLOW_ENDPOINT = {
    GLOBAL: 'global',
    CN: 'cn',
};

export const MINIMAX_ENDPOINT = {
    GLOBAL: 'global',
    CN: 'cn',
};

const sensitiveFields = [
    'reverse_proxy',
    'proxy_password',
    'custom_url',
    'custom_include_body',
    'custom_exclude_body',
    'custom_include_headers',
    'vertexai_region',
    'vertexai_express_project_id',
    'azure_base_url',
    'azure_deployment_name',
    'workers_ai_account_id',
];

/**
 * preset_name -> [selector, setting_name, is_checkbox, is_connection, is_sampling]
 * The optional is_sampling flag marks fields for preset sampling binding and model sampling profiles.
 * @type {Record<string, [string, string, boolean, boolean, boolean?]>}
 */
export const settingsToUpdate = {
    chat_completion_source: ['#chat_completion_source', 'chat_completion_source', false, true, false],
    temperature: ['#temp_openai', 'temp_openai', false, false, true],
    frequency_penalty: ['#freq_pen_openai', 'freq_pen_openai', false, false, true],
    presence_penalty: ['#pres_pen_openai', 'pres_pen_openai', false, false, true],
    top_p: ['#top_p_openai', 'top_p_openai', false, false, true],
    claude_disable_temperature: ['#claude_disable_temperature', 'claude_disable_temperature', true, false, true],
    claude_disable_top_p: ['#claude_disable_top_p', 'claude_disable_top_p', true, false, true],
    top_k: ['#top_k_openai', 'top_k_openai', false, false, true],
    top_a: ['#top_a_openai', 'top_a_openai', false, false, true],
    min_p: ['#min_p_openai', 'min_p_openai', false, false, true],
    repetition_penalty: ['#repetition_penalty_openai', 'repetition_penalty_openai', false, false, true],
    max_context_unlocked: ['#oai_max_context_unlocked', 'max_context_unlocked', true, false, false],
    openai_model: ['#model_openai_select', 'openai_model', false, true],
    claude_model: ['#model_claude_select', 'claude_model', false, true],
    openrouter_model: ['#model_openrouter_select', 'openrouter_model', false, true],
    openrouter_use_fallback: ['#openrouter_use_fallback', 'openrouter_use_fallback', true, true],
    openrouter_group_models: ['#openrouter_group_models', 'openrouter_group_models', false, true],
    openrouter_sort_models: ['#openrouter_sort_models', 'openrouter_sort_models', false, true],
    openrouter_providers: ['#openrouter_providers_chat', 'openrouter_providers', false, true],
    openrouter_quantizations: ['#openrouter_quantizations_chat', 'openrouter_quantizations', false, true],
    openrouter_allow_fallbacks: ['#openrouter_allow_fallbacks', 'openrouter_allow_fallbacks', true, true],
    openrouter_middleout: ['#openrouter_middleout', 'openrouter_middleout', false, true],
    tool_reasoning_mode: ['#tool_reasoning_mode', 'tool_reasoning_mode', false, false],
    ai21_model: ['#model_ai21_select', 'ai21_model', false, true],
    mistralai_model: ['#model_mistralai_select', 'mistralai_model', false, true],
    cohere_model: ['#model_cohere_select', 'cohere_model', false, true],
    perplexity_model: ['#model_perplexity_select', 'perplexity_model', false, true],
    groq_model: ['#model_groq_select', 'groq_model', false, true],
    chutes_model: ['#model_chutes_select', 'chutes_model', false, true],
    chutes_sort_models: ['#chutes_sort_models', 'chutes_sort_models', false, true],
    siliconflow_model: ['#model_siliconflow_select', 'siliconflow_model', false, true],
    siliconflow_endpoint: ['#siliconflow_endpoint', 'siliconflow_endpoint', false, true],
    minimax_model: ['#model_minimax_select', 'minimax_model', false, true],
    minimax_endpoint: ['#minimax_endpoint', 'minimax_endpoint', false, true],
    electronhub_model: ['#model_electronhub_select', 'electronhub_model', false, true],
    electronhub_sort_models: ['#electronhub_sort_models', 'electronhub_sort_models', false, true],
    electronhub_group_models: ['#electronhub_group_models', 'electronhub_group_models', false, true],
    nanogpt_model: ['#model_nanogpt_select', 'nanogpt_model', false, true],
    deepseek_model: ['#model_deepseek_select', 'deepseek_model', false, true],
    aimlapi_model: ['#model_aimlapi_select', 'aimlapi_model', false, true],
    xai_model: ['#model_xai_select', 'xai_model', false, true],
    pollinations_model: ['#model_pollinations_select', 'pollinations_model', false, true],
    moonshot_model: ['#model_moonshot_select', 'moonshot_model', false, true],
    fireworks_model: ['#model_fireworks_select', 'fireworks_model', false, true],
    cometapi_model: ['#model_cometapi_select', 'cometapi_model', false, true],
    custom_model: ['#custom_model_id', 'custom_model', false, true],
    custom_model_icon_detection: ['#custom_model_icon_detection', 'custom_model_icon_detection', true, true],
    custom_url: ['#custom_api_url_text', 'custom_url', false, true],
    custom_include_body: ['#custom_include_body', 'custom_include_body', false, true],
    custom_exclude_body: ['#custom_exclude_body', 'custom_exclude_body', false, true],
    custom_include_headers: ['#custom_include_headers', 'custom_include_headers', false, true],
    custom_prompt_post_processing: ['#custom_prompt_post_processing', 'custom_prompt_post_processing', false, true],
    google_model: ['#model_google_select', 'google_model', false, true],
    vertexai_model: ['#model_vertexai_select', 'vertexai_model', false, true],
    zai_model: ['#model_zai_select', 'zai_model', false, true],
    zai_endpoint: ['#zai_endpoint', 'zai_endpoint', false, true],
    workers_ai_model: ['#model_workers_ai_select', 'workers_ai_model', false, true],
    workers_ai_account_id: ['#workers_ai_account_id', 'workers_ai_account_id', false, true],
    openai_max_context: ['#openai_max_context', 'openai_max_context', false, false],
    openai_max_tokens: ['#openai_max_tokens', 'openai_max_tokens', false, false],
    names_behavior: ['#names_behavior', 'names_behavior', false, false],
    send_if_empty: ['#send_if_empty_textarea', 'send_if_empty', false, false],
    impersonation_prompt: ['#impersonation_prompt_textarea', 'impersonation_prompt', false, false],
    new_chat_prompt: ['#newchat_prompt_textarea', 'new_chat_prompt', false, false],
    new_group_chat_prompt: ['#newgroupchat_prompt_textarea', 'new_group_chat_prompt', false, false],
    new_example_chat_prompt: ['#newexamplechat_prompt_textarea', 'new_example_chat_prompt', false, false],
    continue_nudge_prompt: ['#continue_nudge_prompt_textarea', 'continue_nudge_prompt', false, false],
    bias_preset_selected: ['#openai_logit_bias_preset', 'bias_preset_selected', false, false],
    bias_presets: ['', 'bias_presets', false, false],
    reverse_proxy: ['#openai_reverse_proxy', 'reverse_proxy', false, true],
    wi_format: ['#wi_format_textarea', 'wi_format', false, false],
    scenario_format: ['#scenario_format_textarea', 'scenario_format', false, false],
    personality_format: ['#personality_format_textarea', 'personality_format', false, false],
    group_nudge_prompt: ['#group_nudge_prompt_textarea', 'group_nudge_prompt', false, false],
    stream_openai: ['#stream_toggle', 'stream_openai', true, false],
    prompts: ['', 'prompts', false, false],
    prompt_order: ['', 'prompt_order', false, false],
    show_external_models: ['#openai_show_external_models', 'show_external_models', true, true],
    proxy_password: ['#openai_proxy_password', 'proxy_password', false, true],
    assistant_prefill: ['#claude_assistant_prefill', 'assistant_prefill', false, false],
    assistant_impersonation: ['#claude_assistant_impersonation', 'assistant_impersonation', false, false],
    use_sysprompt: ['#use_sysprompt', 'use_sysprompt', true, false],
    vertexai_auth_mode: ['#vertexai_auth_mode', 'vertexai_auth_mode', false, true],
    vertexai_region: ['#vertexai_region', 'vertexai_region', false, true],
    vertexai_express_project_id: ['#vertexai_express_project_id', 'vertexai_express_project_id', false, true],
    squash_system_messages: ['#squash_system_messages', 'squash_system_messages', true, false],
    media_inlining: ['#openai_media_inlining', 'media_inlining', true, false],
    inline_image_quality: ['#openai_inline_image_quality', 'inline_image_quality', false, false],
    continue_prefill: ['#continue_prefill', 'continue_prefill', true, false],
    continue_postfix: ['#continue_postfix', 'continue_postfix', false, false],
    function_calling: ['#openai_function_calling', 'function_calling', true, false],
    tool_call_recurse_limit: ['#tool_call_recurse_limit', 'tool_call_recurse_limit', false, false],
    show_thoughts: ['#openai_show_thoughts', 'show_thoughts', true, false],
    auto_append_reasoning_tags: ['#openai_auto_append_reasoning_tags', 'auto_append_reasoning_tags', true, false],
    auto_append_reasoning_tag_style: ['#openai_reasoning_tag_style', 'auto_append_reasoning_tag_style', false, false],
    reasoning_effort: ['#openai_reasoning_effort', 'reasoning_effort', false, false],
    verbosity: ['#openai_verbosity', 'verbosity', false, false],
    enable_web_search: ['#openai_enable_web_search', 'enable_web_search', true, false],
    seed: ['#seed_openai', 'seed', false, false],
    n: ['#n_openai', 'n', false, false],
    bypass_status_check: ['#openai_bypass_status_check', 'bypass_status_check', true, true],
    request_images: ['#openai_request_images', 'request_images', true, false],
    request_image_aspect_ratio: ['#request_image_aspect_ratio', 'request_image_aspect_ratio', false, false],
    request_image_resolution: ['#request_image_resolution', 'request_image_resolution', false, false],
    azure_base_url: ['#azure_base_url', 'azure_base_url', false, true],
    azure_deployment_name: ['#azure_deployment_name', 'azure_deployment_name', false, true],
    azure_api_version: ['#azure_api_version', 'azure_api_version', false, true],
    azure_openai_model: ['#azure_openai_model', 'azure_openai_model', false, true],
    extensions: ['#NULL_SELECTOR', 'extensions', false, false],
};

const default_settings = {
    preset_settings_openai: 'Default',
    temp_openai: 1.0,
    freq_pen_openai: 0,
    pres_pen_openai: 0,
    top_p_openai: 1.0,
    top_k_openai: 0,
    min_p_openai: 0,
    top_a_openai: 0,
    repetition_penalty_openai: 1,
    stream_openai: false,
    openai_max_context: max_4k,
    openai_max_tokens: 300,
    ...chatCompletionDefaultPrompts,
    ...promptManagerDefaultPromptOrders,
    send_if_empty: '',
    impersonation_prompt: default_impersonation_prompt,
    new_chat_prompt: default_new_chat_prompt,
    new_group_chat_prompt: default_new_group_chat_prompt,
    new_example_chat_prompt: default_new_example_chat_prompt,
    continue_nudge_prompt: default_continue_nudge_prompt,
    bias_preset_selected: default_bias,
    bias_presets: default_bias_presets,
    wi_format: default_wi_format,
    group_nudge_prompt: default_group_nudge_prompt,
    scenario_format: default_scenario_format,
    personality_format: default_personality_format,
    openai_model: 'gpt-4-turbo',
    claude_model: 'claude-sonnet-4-5',
    claude_disable_temperature: false,
    claude_disable_top_p: false,
    google_model: 'gemini-2.5-pro',
    vertexai_model: 'gemini-2.5-pro',
    ai21_model: 'jamba-large',
    mistralai_model: 'mistral-large-latest',
    cohere_model: 'command-r-plus',
    perplexity_model: 'sonar-pro',
    groq_model: 'llama-3.3-70b-versatile',
    chutes_model: 'deepseek-ai/DeepSeek-V3-0324',
    chutes_sort_models: 'alphabetically',
    siliconflow_model: 'deepseek-ai/DeepSeek-V3',
    siliconflow_endpoint: SILICONFLOW_ENDPOINT.GLOBAL,
    minimax_model: 'MiniMax-M2.7',
    minimax_endpoint: MINIMAX_ENDPOINT.GLOBAL,
    electronhub_model: 'gpt-4o-mini',
    electronhub_sort_models: 'alphabetically',
    electronhub_group_models: false,
    nanogpt_model: 'gpt-4o-mini',
    deepseek_model: 'deepseek-chat',
    aimlapi_model: 'chatgpt-4o-latest',
    xai_model: 'grok-3-beta',
    pollinations_model: 'openai',
    cometapi_model: 'gpt-4o',
    moonshot_model: 'kimi-latest',
    fireworks_model: 'accounts/fireworks/models/kimi-k2-instruct',
    zai_model: 'glm-5.1',
    zai_endpoint: ZAI_ENDPOINT.COMMON,
    workers_ai_model: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
    workers_ai_account_id: '',
    azure_base_url: '',
    azure_deployment_name: '',
    azure_api_version: '2024-02-15-preview',
    azure_openai_model: '',
    custom_model: '',
    custom_model_icon_detection: false,
    custom_url: '',
    custom_include_body: '',
    custom_exclude_body: '',
    custom_include_headers: '',
    openrouter_model: openrouter_website_model,
    openrouter_use_fallback: false,
    openrouter_group_models: false,
    openrouter_sort_models: 'alphabetically',
    openrouter_providers: [],
    openrouter_quantizations: [],
    openrouter_allow_fallbacks: true,
    openrouter_middleout: openrouter_middleout_types.ON,
    tool_reasoning_mode: tool_reasoning_modes.DISABLED,
    reverse_proxy: '',
    chat_completion_source: chat_completion_sources.OPENAI,
    max_context_unlocked: true,
    show_external_models: false,
    proxy_password: '',
    assistant_prefill: '',
    assistant_impersonation: default_assistant_impersonation,
    use_sysprompt: false,
    vertexai_auth_mode: 'express',
    vertexai_region: 'us-central1',
    vertexai_express_project_id: '',
    squash_system_messages: false,
    media_inlining: true,
    inline_image_quality: 'auto',
    bypass_status_check: false,
    continue_prefill: false,
    function_calling: false,
    tool_call_recurse_limit: TOOL_CALL_RECURSE_LIMIT_DEFAULT,
    names_behavior: character_names_behavior.DEFAULT,
    continue_postfix: continue_postfix_types.SPACE,
    custom_prompt_post_processing: custom_prompt_post_processing_types.NONE,
    show_thoughts: true,
    auto_append_reasoning_tags: false,
    auto_append_reasoning_tag_style: reasoning_tag_styles.think,
    reasoning_effort: reasoning_effort_types.none,
    verbosity: verbosity_levels.auto,
    custom_reasoning_preset: custom_reasoning_preset_types.OPENAI,
    custom_reasoning_param_name: 'reasoning_effort',
    custom_reasoning_param_format: custom_reasoning_param_formats.OPENAI,
    custom_reasoning_enabled_value: 'enabled',
    custom_reasoning_disabled_value: 'disabled',
    enable_web_search: false,
    request_images: false,
    request_image_aspect_ratio: '',
    request_image_resolution: '',
    seed: -1,
    n: 1,
    bind_preset_to_connection: false,
    // Undefined keeps legacy saved settings linked; use shouldIncludeSamplingFieldsInPreset when reading it.
    bind_preset_to_sampling: true,
    model_sampling_profiles: {},
    model_sampling_profiles_enabled: false,
    extensions: {},
    model_favorites: {},
};

const oai_settings = structuredClone(default_settings);

const CUSTOM_REASONING_PRESETS = {
    [custom_reasoning_preset_types.OPENAI]: {
        paramName: 'reasoning_effort',
        format: custom_reasoning_param_formats.OPENAI,
        enabledValue: 'enabled',
        disabledValue: 'disabled',
    },
    [custom_reasoning_preset_types.GLM_5_1]: {
        paramName: 'thinking',
        format: custom_reasoning_param_formats.THINKING_OBJECT,
        enabledValue: 'enabled',
        disabledValue: 'disabled',
    },
    [custom_reasoning_preset_types.KIMI_K2]: {
        paramName: 'thinking',
        format: custom_reasoning_param_formats.THINKING_OBJECT,
        enabledValue: 'enabled',
        disabledValue: 'disabled',
    },
};

export let proxies = [
    {
        name: 'None',
        url: '',
        password: '',
        source: '',
    },
];
export let selected_proxy = proxies[0];

export let openai_setting_names;
export let openai_settings;

function applyToolCallRecurseLimit(value = oai_settings.tool_call_recurse_limit) {
    const recurseLimit = normalizeToolCallRecurseLimit(value);
    oai_settings.tool_call_recurse_limit = recurseLimit;
    ToolManager.RECURSE_LIMIT = recurseLimit;
    $('#tool_call_recurse_limit').val(recurseLimit);
    $('#tool_call_recurse_limit_counter').val(recurseLimit);
    return recurseLimit;
}

/** @type {import('./PromptManager.js').PromptManager} */
export let promptManager = null;

/**
 * SillyBunny: prompt order reset needs the selected preset's saved order, not the current modified settings.
 * Gets the prompt order from the selected OpenAI preset before user edits are applied.
 * @param {number|string|null} characterId Character/dummy ID to match in the preset prompt order.
 * @returns {Array<Object>} Prompt order from the selected preset, or an empty array.
 */
export function getCurrentOpenAIPresetPromptOrder(characterId) {
    const presetName = oai_settings.preset_settings_openai;
    const presetIndex = openai_setting_names?.[presetName];
    const presetPromptOrder = openai_settings?.[presetIndex]?.prompt_order;

    if (!Array.isArray(presetPromptOrder)) {
        return [];
    }

    const promptOrderEntry = presetPromptOrder.find(entry => String(entry?.character_id) === String(characterId))
        ?? presetPromptOrder.find(entry => Array.isArray(entry?.order));

    return Array.isArray(promptOrderEntry?.order) ? promptOrderEntry.order : [];
}

async function validateReverseProxy() {
    if (!oai_settings.reverse_proxy) {
        return;
    }

    try {
        new URL(oai_settings.reverse_proxy);
    } catch (err) {
        toastr.error(t`Entered reverse proxy address is not a valid URL`);
        setOnlineStatus('no_connection');
        resultCheckStatus();
        throw err;
    }
    const rememberKey = `Proxy_SkipConfirm_${getStringHash(oai_settings.reverse_proxy)}`;
    const skipConfirm = accountStorage.getItem(rememberKey) === 'true';

    const confirmation = skipConfirm || await Popup.show.confirm(t`Connecting To Proxy`, await renderTemplateAsync('proxyConnectionWarning', { proxyURL: DOMPurify.sanitize(oai_settings.reverse_proxy) }));

    if (!confirmation) {
        toastr.error(t`Update or remove your reverse proxy settings.`);
        setOnlineStatus('no_connection');
        resultCheckStatus();
        throw new Error('Proxy connection denied.');
    }

    accountStorage.setItem(rememberKey, String(true));
}

/**
 * Formats chat messages into chat completion messages.
 * @param {ChatMessage[]} chat - Array containing all messages.
 * @returns {object[]} - Array containing all messages formatted for chat completion.
 */
function setOpenAIMessages(chat) {
    let j = 0;
    // clean openai msgs
    const messages = [];
    // Get current API and model for thought signature validation
    const currentApi = oai_settings.chat_completion_source;
    const currentModel = getChatCompletionModel();

    for (let i = chat.length - 1; i >= 0; i--) {
        let role = chat[j].is_user ? 'user' : 'assistant';
        let content = chat[j].mes;

        // If this symbol flag is set, completely ignore the message.
        // This can be used to hide messages without affecting the number of messages in the chat.
        if (chat[j].extra?.[IGNORE_SYMBOL]) {
            j++;
            continue;
        }

        // 100% legal way to send a message as system
        if (chat[j].extra?.type === system_message_types.NARRATOR) {
            role = 'system';
        }

        // for groups or sendas command - prepend a character's name
        switch (oai_settings.names_behavior) {
            case character_names_behavior.NONE:
                break;
            case character_names_behavior.DEFAULT:
                if ((selected_group && chat[j].name !== name1) || (chat[j].force_avatar && chat[j].name !== name1 && chat[j].extra?.type !== system_message_types.NARRATOR)) {
                    content = `${chat[j].name}: ${content}`;
                }
                break;
            case character_names_behavior.CONTENT:
                if (chat[j].extra?.type !== system_message_types.NARRATOR) {
                    content = `${chat[j].name}: ${content}`;
                }
                break;
            case character_names_behavior.COMPLETION:
                break;
            default:
                break;
        }

        // remove caret return (waste of tokens)
        const contextDepth = Math.max(0, chat.length - j - 1);
        content = stripHtmlTagsFromContext(
            stripOocBlocksFromContext(content.replace(/\r/gm, ''), shouldRetainContextAtDepth(contextDepth, power_user.ooc_context_depth)),
            shouldRetainContextAtDepth(contextDepth, power_user.html_context_depth),
        );

        const name = chat[j].name;
        const media = chat[j]?.extra?.media;
        const mediaDisplay = getMediaDisplay(chat[j]);
        const mediaIndex = getMediaIndex(chat[j]);
        const invocations = chat[j]?.extra?.tool_invocations?.slice();

        // Only send thought signatures if they were generated by the same API and model
        const originApi = chat[j]?.extra?.api;
        const originModel = chat[j]?.extra?.model;
        const isSameModel = originApi === currentApi && originModel === currentModel;
        const signature = isSameModel ? chat[j]?.extra?.reasoning_signature : null;
        const reasoning = isSameModel ? String(chat[j]?.extra?.reasoning ?? '') : '';

        // Remove reasoning metadata from invocations if the API/model don't match
        if (Array.isArray(invocations) && invocations.length > 0) {
            invocations.forEach((invocation, index) => {
                if (!isSameModel && (invocation.signature || invocation.reasoning)) {
                    const cloneInvocation = structuredClone(invocation);
                    delete cloneInvocation.signature;
                    delete cloneInvocation.reasoning;
                    invocations[index] = cloneInvocation;
                }
            });
        }

        const message = { 'role': role, 'content': content, name: name, 'media': media, 'mediaDisplay': mediaDisplay, 'mediaIndex': mediaIndex, 'invocations': invocations, 'signature': signature, 'reasoning': reasoning };
        if (hasPromptPayload(message)) {
            messages[i] = message;
        }
        j++;
    }

    return messages.filter(Boolean);
}

/**
 * Formats chat examples into chat completion messages.
 * @param {string[]} mesExamplesArray - Array containing all examples.
 * @returns {object[]} - Array containing all examples formatted for chat completion.
 */
function setOpenAIMessageExamples(mesExamplesArray) {
    // get a nice array of all blocks of all example messages = array of arrays (important!)
    const examples = [];
    for (let item of mesExamplesArray) {
        // remove <START> {Example Dialogue:} and replace \r\n with just \n
        let replaced = item.replace(/<START>/i, '{Example Dialogue:}').replace(/\r/gm, '');
        let parsed = parseExampleIntoIndividual(replaced, true);
        // add to the example message blocks array
        examples.push(parsed);
    }
    return examples;
}

/**
 * One-time setup for prompt manager module.
 *
 * @param openAiSettings
 * @returns {PromptManager|null}
 */
function setupChatCompletionPromptManager(openAiSettings) {
    // Do not set up prompt manager more than once
    if (promptManager) {
        promptManager.render(false);
        return promptManager;
    }

    promptManager = new PromptManager();

    const configuration = {
        prefix: 'completion_',
        containerIdentifier: 'completion_prompt_manager',
        listIdentifier: 'completion_prompt_manager_list',
        toggleDisabled: [],
        sortableDelay: getSortableDelay(),
        defaultPrompts: {
            main: default_main_prompt,
            nsfw: default_nsfw_prompt,
            jailbreak: default_jailbreak_prompt,
            enhanceDefinitions: default_enhance_definitions_prompt,
        },
        promptOrder: {
            strategy: 'global',
            dummyId: 100001,
        },
    };

    promptManager.saveServiceSettings = () => {
        saveSettingsDebounced();
        return new Promise((resolve) => eventSource.once(event_types.SETTINGS_UPDATED, resolve));
    };

    promptManager.tryGenerate = () => {
        if (characters[this_chid]) {
            return Generate('normal', {}, true);
        } else {
            return Promise.resolve();
        }
    };

    promptManager.tokenHandler = tokenHandler;

    promptManager.init(configuration, openAiSettings);
    promptManager.render(false);

    return promptManager;
}

function getEffectiveImpersonationPrompt() {
    const prompt = String(oai_settings.impersonation_prompt ?? '').trim() || default_impersonation_prompt;
    return substituteParams(prompt);
}

function getEffectiveAssistantImpersonationPrefill(settings) {
    const prefill = String(settings?.assistant_impersonation ?? '').trim() || default_assistant_impersonation;
    return substituteParams(prefill);
}

/**
 * Parses the example messages into individual messages.
 * @param {string} messageExampleString - The string containing the example messages
 * @param {boolean} appendNamesForGroup - Whether to append the character name for group chats
 * @returns {Message[]} Array of message objects
 */
export function parseExampleIntoIndividual(messageExampleString, appendNamesForGroup = true) {
    const groupBotNames = getGroupNames().map(name => `${name}:`);

    let result = []; // array of msgs
    let tmp = messageExampleString.split('\n');
    let cur_msg_lines = [];
    let in_user = false;
    let in_bot = false;
    let botName = name2;

    // DRY my cock and balls :)
    function add_msg(name, role, system_name) {
        // join different newlines (we split them by \n and join by \n)
        // remove char name
        // strip to remove extra spaces
        let parsed_msg = cur_msg_lines.join('\n').replace(name + ':', '').trim();

        if (appendNamesForGroup && selected_group && ['example_user', 'example_assistant'].includes(system_name)) {
            parsed_msg = `${name}: ${parsed_msg}`;
        }

        result.push({ 'role': role, 'content': parsed_msg, 'name': system_name });
        cur_msg_lines = [];
    }
    // skip first line as it'll always be "This is how {bot name} should talk"
    for (let i = 1; i < tmp.length; i++) {
        let cur_str = tmp[i];
        // if it's the user message, switch into user mode and out of bot mode
        // yes, repeated code, but I don't care
        if (cur_str.startsWith(name1 + ':')) {
            in_user = true;
            // we were in the bot mode previously, add the message
            if (in_bot) {
                add_msg(botName, 'system', 'example_assistant');
            }
            in_bot = false;
        } else if (cur_str.startsWith(name2 + ':') || groupBotNames.some(n => cur_str.startsWith(n))) {
            if (!cur_str.startsWith(name2 + ':') && groupBotNames.length) {
                botName = cur_str.split(':')[0];
            }

            in_bot = true;
            // we were in the user mode previously, add the message
            if (in_user) {
                add_msg(name1, 'system', 'example_user');
            }
            in_user = false;
        }
        // push the current line into the current message array only after checking for presence of user/bot
        cur_msg_lines.push(cur_str);
    }
    // Special case for last message in a block because we don't have a new message to trigger the switch
    if (in_user) {
        add_msg(name1, 'system', 'example_user');
    } else if (in_bot) {
        add_msg(botName, 'system', 'example_assistant');
    }
    return result;
}

export function formatWorldInfo(value, { wiFormat = null } = {}) {
    if (!value) {
        return '';
    }

    const format = wiFormat ?? oai_settings.wi_format;

    if (!format.trim()) {
        return value;
    }

    return stringFormat(format, value);
}

/**
 * This function populates the injections in the conversation.
 *
 * @param {Prompt[]} prompts - Array containing injection prompts.
 * @param {Object[]} messages - Array containing all messages.
 * @returns {Promise<Object[]>} - Array containing all messages with injections.
 */
async function populationInjectionPrompts(prompts, messages) {
    let totalInsertedMessages = 0;

    const roleTypes = {
        'system': extension_prompt_roles.SYSTEM,
        'user': extension_prompt_roles.USER,
        'assistant': extension_prompt_roles.ASSISTANT,
    };

    const maxDepth = getExtensionPromptMaxDepth();
    for (let i = 0; i <= maxDepth; i++) {
        // Get prompts for current depth
        const depthPrompts = prompts.filter(prompt => prompt.injection_depth === i && prompt.content);

        const roleMessages = [];
        const separator = '\n';
        const wrap = false;

        // Group prompts by priority
        const extensionPromptsOrder = '100';
        const orderGroups = {
            [extensionPromptsOrder]: [],
        };
        for (const prompt of depthPrompts) {
            const order = prompt.injection_order ?? 100;
            if (!orderGroups[order]) {
                orderGroups[order] = [];
            }
            orderGroups[order].push(prompt);
        }

        // Process each order group in order (b - a = low to high ; a - b = high to low)
        const orders = Object.keys(orderGroups).sort((a, b) => +b - +a);
        for (const order of orders) {
            const orderPrompts = orderGroups[order];

            // Order of priority for roles (most important go lower)
            const roles = ['system', 'user', 'assistant'];
            for (const role of roles) {
                const rolePrompts = orderPrompts
                    .filter(prompt => prompt.role === role)
                    .map(x => x.content)
                    .join(separator);

                // Get extension prompt
                const extensionPrompt = order === extensionPromptsOrder
                    ? await getExtensionPrompt(extension_prompt_types.IN_CHAT, i, separator, roleTypes[role], wrap)
                    : '';
                const jointPrompt = [rolePrompts, extensionPrompt].filter(x => x).map(x => x.trim()).join(separator);

                if (jointPrompt && jointPrompt.length) {
                    roleMessages.push({ 'role': role, 'content': jointPrompt, injected: true });
                }
            }
        }

        if (roleMessages.length) {
            const injectIdx = i + totalInsertedMessages;
            messages.splice(injectIdx, 0, ...roleMessages);
            totalInsertedMessages += roleMessages.length;
        }
    }

    messages = messages.reverse();
    return messages;
}

/**
 * Populates the chat history of the conversation.
 * @param {object[]} messages - Array containing all messages.
 * @param {import('./PromptManager').PromptCollection} prompts - Map object containing all prompts where the key is the prompt identifier and the value is the prompt object.
 * @param {ChatCompletion} chatCompletion - An instance of ChatCompletion class that will be populated with the prompts.
 * @param type
 * @param cyclePrompt
 */
async function populateChatHistory(messages, prompts, chatCompletion, type = null, cyclePrompt = null) {
    if (!prompts.has('chatHistory')) {
        return;
    }

    chatCompletion.add(new MessageCollection('chatHistory'), prompts.index('chatHistory'));

    // Reserve budget for new chat message
    const newChat = selected_group ? oai_settings.new_group_chat_prompt : oai_settings.new_chat_prompt;
    const newChatMessage = await Message.createAsync('system', substituteParams(newChat), 'newMainChat');
    chatCompletion.reserveBudget(newChatMessage);

    // Reserve budget for group nudge
    let groupNudgeMessage = null;
    const noGroupNudgeTypes = ['impersonate'];
    if (selected_group && prompts.has('groupNudge') && !noGroupNudgeTypes.includes(type)) {
        groupNudgeMessage = await Message.fromPromptAsync(prompts.get('groupNudge'));
        chatCompletion.reserveBudget(groupNudgeMessage);
    }

    // Reserve budget for continue nudge
    let continueMessageCollection = null;
    if (type === 'continue' && cyclePrompt && !oai_settings.continue_prefill) {
        const promptObject = {
            identifier: 'continueNudge',
            role: 'system',
            content: substituteParamsExtended(oai_settings.continue_nudge_prompt, { lastChatMessage: String(cyclePrompt).trim() }),
            system_prompt: true,
        };
        continueMessageCollection = new MessageCollection('continueNudge');
        const continueMessageIndex = messages.findLastIndex(x => !x.injected);
        if (continueMessageIndex >= 0) {
            const continueMessage = messages.splice(continueMessageIndex, 1)[0];
            const prompt = new Prompt(continueMessage);
            const chatMessage = await Message.fromPromptAsync(promptManager.preparePrompt(prompt));
            continueMessageCollection.add(chatMessage);
        }
        const continueNudgePrompt = new Prompt(promptObject);
        const preparedNudgePrompt = promptManager.preparePrompt(continueNudgePrompt);
        const continueNudgeMessage = await Message.fromPromptAsync(preparedNudgePrompt);
        continueMessageCollection.add(continueNudgeMessage);
        chatCompletion.reserveBudget(continueMessageCollection);
    }

    const lastChatPrompt = messages[messages.length - 1];
    const message = await Message.createAsync('user', oai_settings.send_if_empty, 'emptyUserMessageReplacement');
    if (lastChatPrompt && lastChatPrompt.role === 'assistant' && oai_settings.send_if_empty && chatCompletion.canAfford(message)) {
        chatCompletion.insert(message, 'chatHistory');
    }

    const imageInlining = isImageInliningSupported();
    const videoInlining = isVideoInliningSupported();
    const audioInlining = isAudioInliningSupported();
    const canUseTools = ToolManager.isToolCallingSupported();
    const includeSignature = isReasoningSignatureSupported();
    const isToolReasoningProvider = interleaved_reasoning_providers.includes(oai_settings.chat_completion_source);
    const toolReasoningMode = isToolReasoningProvider
        ? getEffectiveToolReasoningMode()
        : tool_reasoning_modes.DISABLED;
    const includeToolReasoning = toolReasoningMode !== tool_reasoning_modes.DISABLED;
    const lastUserIdx = messages.findLastIndex(x => x.role === 'user');

    // Insert chat messages as long as there is budget available
    const chatPool = [...messages].reverse();
    for (let index = 0; index < chatPool.length; index++) {
        const chatPrompt = chatPool[index];

        // We do not want to mutate the prompt
        const prompt = new Prompt(chatPrompt);
        prompt.identifier = `chatHistory-${messages.length - index}`;
        const chatMessage = await Message.fromPromptAsync(promptManager.preparePrompt(prompt));

        if (promptManager.serviceSettings.names_behavior === character_names_behavior.COMPLETION && prompt.name) {
            const messageName = promptManager.isValidName(prompt.name) ? prompt.name : promptManager.sanitizeName(prompt.name);
            await chatMessage.setName(messageName);
        }

        /**
         * Inline a media attachment into the chat message.
         * @param {MediaAttachment} media - The media attachment to inline.
         */
        const inlineMediaAttachment = async (media) => {
            if (!media || !media.url) {
                return;
            }
            if (!media.type) {
                media.type = MEDIA_TYPE.IMAGE;
            }
            if (imageInlining && media.type === MEDIA_TYPE.IMAGE) {
                await chatMessage.addImage(media.url);
            }
            if (videoInlining && media.type === MEDIA_TYPE.VIDEO) {
                await chatMessage.addVideo(media.url);
            }
            if (audioInlining && media.type === MEDIA_TYPE.AUDIO) {
                await chatMessage.addAudio(media.url);
            }
        };

        if (Array.isArray(chatPrompt.media) && chatPrompt.media.length) {
            if (chatPrompt.mediaDisplay === MEDIA_DISPLAY.LIST) {
                for (const media of chatPrompt.media) {
                    await inlineMediaAttachment(media);
                }
            }
            if (chatPrompt.mediaDisplay === MEDIA_DISPLAY.GALLERY) {
                const media = chatPrompt.media[chatPrompt.mediaIndex];
                await inlineMediaAttachment(media);
            }
        }

        if (canUseTools && Array.isArray(chatPrompt.invocations)) {
            const promptIdx = messages.indexOf(chatPrompt);
            const reasoningIsEligible = toolReasoningMode !== tool_reasoning_modes.DISABLED
                && promptIdx > lastUserIdx;
            let previousAssistantReasoning = '';
            if (reasoningIsEligible) {
                if (toolReasoningMode === tool_reasoning_modes.ACTIVE_CHAIN) {
                    // Strict chain mode: skip tool/tool-call messages, then use only the first assistant text boundary.
                    for (let idx = promptIdx - 1; idx > lastUserIdx; idx--) {
                        const candidate = messages[idx];
                        if (candidate?.role === 'tool') {
                            continue;
                        }
                        if (candidate?.role === 'assistant' && Array.isArray(candidate.invocations)) {
                            continue;
                        }
                        const hasAssistantText = candidate?.role === 'assistant'
                            && !Array.isArray(candidate.invocations)
                            && typeof candidate.content === 'string'
                            && candidate.content.trim().length > 0;
                        if (hasAssistantText) {
                            previousAssistantReasoning = String(candidate.reasoning ?? '');
                        }
                        break;
                    }
                } else if (toolReasoningMode === tool_reasoning_modes.SINCE_LAST_USER) {
                    // Broad mode: use the latest assistant text reasoning anywhere since the last user.
                    for (let idx = promptIdx - 1; idx > lastUserIdx; idx--) {
                        const candidate = messages[idx];
                        const hasAssistantText = candidate?.role === 'assistant'
                            && !Array.isArray(candidate.invocations)
                            && typeof candidate.content === 'string'
                            && candidate.content.trim().length > 0;
                        if (!hasAssistantText) {
                            continue;
                        }
                        const candidateReasoning = String(candidate.reasoning ?? '');
                        if (candidateReasoning) {
                            previousAssistantReasoning = candidateReasoning;
                            break;
                        }
                    }
                }
            }
            /** @type {import('./tool-calling.js').ToolInvocation[]} */
            const invocations = chatPrompt.invocations.map(invocation => {
                const clone = structuredClone(invocation);
                if (!reasoningIsEligible) {
                    delete clone.reasoning;
                } else if (previousAssistantReasoning) {
                    // Prefer currently editable assistant-text reasoning based on forwarding mode over invocation snapshot.
                    clone.reasoning = previousAssistantReasoning;
                }
                return clone;
            });
            const toolCallMessage = await Message.createAsync(chatMessage.role, undefined, 'toolCall-' + chatMessage.identifier);
            const toolResultMessages = await Promise.all(invocations.slice().reverse().map((invocation) => Message.createAsync('tool', invocation.result || '[No content]', invocation.id)));
            await toolCallMessage.setToolCalls(invocations, includeSignature, includeToolReasoning);
            if (chatCompletion.canAffordAll([toolCallMessage, ...toolResultMessages])) {
                for (const resultMessage of toolResultMessages) {
                    chatCompletion.insertAtStart(resultMessage, 'chatHistory');
                }
                chatCompletion.insertAtStart(toolCallMessage, 'chatHistory');
            } else {
                break;
            }

            continue;
        }

        if (includeSignature && chatPrompt.signature) {
            chatMessage.signature = chatPrompt.signature;
        }

        if (chatCompletion.canAfford(chatMessage)) {
            chatCompletion.insertAtStart(chatMessage, 'chatHistory');
        } else {
            break;
        }
    }

    // Insert and free new chat
    chatCompletion.freeBudget(newChatMessage);
    chatCompletion.insertAtStart(newChatMessage, 'chatHistory');

    // Reserve budget for group nudge
    if (selected_group && groupNudgeMessage) {
        chatCompletion.freeBudget(groupNudgeMessage);
        chatCompletion.insertAtEnd(groupNudgeMessage, 'chatHistory');
    }

    // Insert and free continue nudge
    if (type === 'continue' && continueMessageCollection) {
        chatCompletion.freeBudget(continueMessageCollection);
        chatCompletion.add(continueMessageCollection, -1);
    }
}

/**
 * This function populates the dialogue examples in the conversation.
 *
 * @param {import('./PromptManager').PromptCollection} prompts - Map object containing all prompts where the key is the prompt identifier and the value is the prompt object.
 * @param {ChatCompletion} chatCompletion - An instance of ChatCompletion class that will be populated with the prompts.
 * @param {Object[]} messageExamples - Array containing all message examples.
 */
async function populateDialogueExamples(prompts, chatCompletion, messageExamples) {
    if (!prompts.has('dialogueExamples')) {
        return;
    }

    chatCompletion.add(new MessageCollection('dialogueExamples'), prompts.index('dialogueExamples'));
    if (Array.isArray(messageExamples) && messageExamples.length) {
        const newExampleChat = await Message.createAsync('system', substituteParams(oai_settings.new_example_chat_prompt), 'newChat');
        for (const dialogue of [...messageExamples]) {
            const dialogueIndex = messageExamples.indexOf(dialogue);
            const chatMessages = [];

            for (let promptIndex = 0; promptIndex < dialogue.length; promptIndex++) {
                const prompt = dialogue[promptIndex];
                const role = 'system';
                const content = prompt.content || '';
                const identifier = `dialogueExamples ${dialogueIndex}-${promptIndex}`;

                const chatMessage = await Message.createAsync(role, content, identifier);
                await chatMessage.setName(prompt.name);
                chatMessages.push(chatMessage);
            }

            if (!chatCompletion.canAffordAll([newExampleChat, ...chatMessages])) {
                break;
            }

            chatCompletion.insert(newExampleChat, 'dialogueExamples');
            for (const chatMessage of chatMessages) {
                chatCompletion.insert(chatMessage, 'dialogueExamples');
            }
        }
    }
}

/**
 * @param {number} position - Prompt position in the extensions object.
 * @returns {string|false} - The prompt position for prompt collection.
 */
export function getPromptPosition(position) {
    if (position == extension_prompt_types.BEFORE_PROMPT) {
        return 'start';
    }

    if (position == extension_prompt_types.IN_PROMPT) {
        return 'end';
    }

    return false;
}

/**
 * Gets a Chat Completion role based on the prompt role.
 * @param {number} role Role of the prompt.
 * @returns {string} Mapped role.
 */
export function getPromptRole(role) {
    switch (role) {
        case extension_prompt_roles.SYSTEM:
            return 'system';
        case extension_prompt_roles.USER:
            return 'user';
        case extension_prompt_roles.ASSISTANT:
            return 'assistant';
        default:
            return 'system';
    }
}

/**
 * Populate a chat conversation by adding prompts to the conversation and managing system and user prompts.
 *
 * @param {import('./PromptManager.js').PromptCollection} prompts - PromptCollection containing all prompts where the key is the prompt identifier and the value is the prompt object.
 * @param {ChatCompletion} chatCompletion - An instance of ChatCompletion class that will be populated with the prompts.
 * @param {Object} options - An object with optional settings.
 * @param {string} options.bias - A bias to be added in the conversation.
 * @param {string} options.quietPrompt - Instruction prompt for extras
 * @param {string} options.quietImage - Image prompt for extras
 * @param {string} options.type - The type of the chat, can be 'impersonate'.
 * @param {string} options.cyclePrompt - The last prompt in the conversation.
 * @param {object[]} options.messages - Array containing all messages.
 * @param {object[]} options.messageExamples - Array containing all message examples.
 * @returns {Promise<void>}
 */
async function populateChatCompletion(prompts, chatCompletion, { bias, quietPrompt, quietImage, type, cyclePrompt, messages, messageExamples }) {
    // Helper function for preparing a prompt, that already exists within the prompt collection, for completion
    const addToChatCompletion = async (source, target = null) => {
        // We need the prompts array to determine a position for the source.
        if (false === prompts.has(source)) return;

        if (promptManager.isPromptDisabledForActiveCharacter(source) && source !== 'main') {
            promptManager.log(`Skipping prompt ${source} because it is disabled`);
            return;
        }

        const prompt = prompts.get(source);

        if (prompt.injection_position === INJECTION_POSITION.ABSOLUTE) {
            promptManager.log(`Skipping prompt ${source} because it is an absolute prompt`);
            return;
        }

        const index = target ? prompts.index(target) : prompts.index(source);
        const collection = new MessageCollection(source);
        const message = await Message.fromPromptAsync(prompt);
        collection.add(message);
        chatCompletion.add(collection, index);
    };

    chatCompletion.reserveBudget(3); // every reply is primed with <|start|>assistant<|message|>
    // Character and world information
    await addToChatCompletion('worldInfoBefore');
    await addToChatCompletion('main');
    await addToChatCompletion('worldInfoAfter');
    await addToChatCompletion('charDescription');
    await addToChatCompletion('charPersonality');
    await addToChatCompletion('scenario');
    await addToChatCompletion('personaDescription');

    // Collection of control prompts that will always be positioned last
    chatCompletion.setOverriddenPrompts(prompts.overriddenPrompts);
    const controlPrompts = new MessageCollection('controlPrompts');

    const impersonateMessage = await Message.fromPromptAsync(prompts.get('impersonate')) ?? null;
    if (type === 'impersonate' && !promptManager.isPromptDisabledForActiveCharacter('impersonate')) {
        controlPrompts.add(impersonateMessage);
    }

    // Add quiet prompt to control prompts
    // This should always be last, even in control prompts. Add all further control prompts BEFORE this prompt
    const quietPromptMessage = await Message.fromPromptAsync(prompts.get('quietPrompt')) ?? null;
    if (quietPromptMessage && quietPromptMessage.content) {
        if (isImageInliningSupported() && quietImage) {
            await quietPromptMessage.addImage(quietImage);
        }

        controlPrompts.add(quietPromptMessage);
    }

    chatCompletion.reserveBudget(controlPrompts);

    // Add ordered system and user prompts
    const systemPrompts = ['nsfw', 'jailbreak'];
    const userRelativePrompts = prompts.collection
        .filter((prompt) => false === prompt.system_prompt && prompt.injection_position !== INJECTION_POSITION.ABSOLUTE)
        .reduce((acc, prompt) => {
            acc.push(prompt.identifier);
            return acc;
        }, []);
    const absolutePrompts = prompts.collection
        .filter((prompt) => prompt.injection_position === INJECTION_POSITION.ABSOLUTE)
        .reduce((acc, prompt) => {
            acc.push(prompt);
            return acc;
        }, []);

    for (const identifier of [...systemPrompts, ...userRelativePrompts]) {
        await addToChatCompletion(identifier);
    }

    // Add enhance definition instruction
    if (prompts.has('enhanceDefinitions')) await addToChatCompletion('enhanceDefinitions');

    // Bias
    if (bias && bias.trim().length) await addToChatCompletion('bias');

    const injectToMain = async (/** @type {Prompt} */ prompt, /** @type {string|number} */ position) => {
        if (chatCompletion.has('main')) {
            const message = await Message.fromPromptAsync(prompt);
            chatCompletion.insert(message, 'main', position);
        } else {
            // Convert the relative prompt to an injection and place it relative to main prompt
            // Keeping prompts in the same order bucket will squash them together during in-chat injection
            const indexOfMain = absolutePrompts.findIndex(p => p.identifier === 'main');
            if (indexOfMain >= 0) {
                const main = absolutePrompts[indexOfMain];
                const promptCopy = new Prompt(prompt);
                promptCopy.role = main.role;
                promptCopy.injection_position = main.injection_position;
                promptCopy.injection_depth = main.injection_depth;
                promptCopy.injection_order = main.injection_order;
                const newIndex = position === 'end' ? indexOfMain + 1 : indexOfMain;
                absolutePrompts.splice(newIndex, 0, promptCopy);
            }
        }
    };

    const knownPrompts = [
        'summary',
        'authorsNote',
        'vectorsMemory',
        'vectorsDataBank',
        'smartContext',
    ];

    // Known relative extension prompts
    for (const key of knownPrompts) {
        if (prompts.has(key)) {
            const prompt = prompts.get(key);
            if (prompt.position) {
                await injectToMain(prompt, prompt.position);
            }
        }
    }

    // Other relative extension prompts
    for (const prompt of prompts.collection.filter(p => p.extension && p.position)) {
        await injectToMain(prompt, prompt.position);
    }

    // Pre-allocation of tokens for tool data
    if (ToolManager.canPerformToolCalls(type)) {
        const toolData = {};
        await ToolManager.registerFunctionToolsOpenAI(toolData);
        const toolMessage = [{ role: 'user', content: JSON.stringify(toolData) }];
        const toolTokens = await tokenHandler.countAsync(toolMessage);
        chatCompletion.reserveBudget(toolTokens);
    }

    // Displace the message to be continued from its original position before performing in-chat injections
    // In case if it is an assistant message, we want to prepend the users assistant prefill on the message
    if (type === 'continue' && oai_settings.continue_prefill && messages.length) {
        const chatMessage = messages.shift();
        const isAssistantRole = chatMessage.role === 'assistant';
        const supportsAssistantPrefill = oai_settings.chat_completion_source === chat_completion_sources.CLAUDE;
        const namesInCompletion = oai_settings.names_behavior === character_names_behavior.COMPLETION;
        const assistantPrefill = isAssistantRole && supportsAssistantPrefill ? substituteParams(oai_settings.assistant_prefill) : '';
        const messageContent = [assistantPrefill, chatMessage.content].filter(x => x).join('\n\n');
        const continueMessage = await Message.createAsync(chatMessage.role, messageContent, 'continuePrefill');
        chatMessage.name && namesInCompletion && await continueMessage.setName(promptManager.sanitizeName(chatMessage.name));
        controlPrompts.add(continueMessage);
        chatCompletion.reserveBudget(continueMessage);
    }

    // Add in-chat injections
    messages = await populationInjectionPrompts(absolutePrompts, messages);

    // Decide whether dialogue examples should always be added
    if (power_user.pin_examples) {
        await populateDialogueExamples(prompts, chatCompletion, messageExamples);
        await populateChatHistory(messages, prompts, chatCompletion, type, cyclePrompt);
    } else {
        await populateChatHistory(messages, prompts, chatCompletion, type, cyclePrompt);
        await populateDialogueExamples(prompts, chatCompletion, messageExamples);
    }

    chatCompletion.freeBudget(controlPrompts);
    if (controlPrompts.collection.length) chatCompletion.add(controlPrompts);
}

/**
 * Combines system prompts with prompt manager prompts
 *
 * @param {Object} options - An object with optional settings.
 * @param {string} options.scenario - The scenario or context of the dialogue.
 * @param {string} options.charPersonality - Description of the character's personality.
 * @param {string} options.name2 - The second name to be used in the messages.
 * @param {string} options.worldInfoBefore - The world info to be added before the main conversation.
 * @param {string} options.worldInfoAfter - The world info to be added after the main conversation.
 * @param {string} options.charDescription - Description of the character.
 * @param {string} options.quietPrompt - The quiet prompt to be used in the conversation.
 * @param {string} options.bias - The bias to be added in the conversation.
 * @param {Object} options.extensionPrompts - An object containing additional prompts.
 * @param {string} options.systemPromptOverride - Character card override of the main prompt
 * @param {string} options.jailbreakPromptOverride - Character card override of the PHI
 * @param {string} options.type - The type of generation that triggered the prompt
 * @returns {Promise<Object>} prompts - The prepared and merged system and user-defined prompts.
 */
async function preparePromptsForChatCompletion({ scenario, charPersonality, name2, worldInfoBefore, worldInfoAfter, charDescription, quietPrompt, bias, extensionPrompts, systemPromptOverride, jailbreakPromptOverride, type }) {
    const scenarioText = scenario && oai_settings.scenario_format ? substituteParams(oai_settings.scenario_format) : (scenario || '');
    const charPersonalityText = charPersonality && oai_settings.personality_format ? substituteParams(oai_settings.personality_format) : (charPersonality || '');
    const groupNudge = substituteParams(oai_settings.group_nudge_prompt);
    const impersonationPrompt = getEffectiveImpersonationPrompt();

    // Create entries for system prompts
    const systemPrompts = [
        // Ordered prompts for which a marker should exist
        { role: 'system', content: formatWorldInfo(worldInfoBefore), identifier: 'worldInfoBefore' },
        { role: 'system', content: formatWorldInfo(worldInfoAfter), identifier: 'worldInfoAfter' },
        { role: 'system', content: charDescription, identifier: 'charDescription' },
        { role: 'system', content: charPersonalityText, identifier: 'charPersonality' },
        { role: 'system', content: scenarioText, identifier: 'scenario' },
        // Unordered prompts without marker
        { role: 'system', content: impersonationPrompt, identifier: 'impersonate' },
        { role: 'system', content: quietPrompt, identifier: 'quietPrompt' },
        { role: 'system', content: groupNudge, identifier: 'groupNudge' },
        { role: 'assistant', content: bias, identifier: 'bias' },
    ];

    // Tavern Extras - Summary
    const summary = extensionPrompts['1_memory'];
    if (summary && summary.value) systemPrompts.push({
        role: getPromptRole(summary.role),
        content: summary.value,
        identifier: 'summary',
        position: getPromptPosition(summary.position),
    });

    // Authors Note
    const authorsNote = extensionPrompts['2_floating_prompt'];
    if (authorsNote && authorsNote.value) systemPrompts.push({
        role: getPromptRole(authorsNote.role),
        content: authorsNote.value,
        identifier: 'authorsNote',
        position: getPromptPosition(authorsNote.position),
    });

    // Vectors Memory
    const vectorsMemory = extensionPrompts['3_vectors'];
    if (vectorsMemory && vectorsMemory.value) systemPrompts.push({
        role: 'system',
        content: vectorsMemory.value,
        identifier: 'vectorsMemory',
        position: getPromptPosition(vectorsMemory.position),
    });

    const vectorsDataBank = extensionPrompts['4_vectors_data_bank'];
    if (vectorsDataBank && vectorsDataBank.value) systemPrompts.push({
        role: getPromptRole(vectorsDataBank.role),
        content: vectorsDataBank.value,
        identifier: 'vectorsDataBank',
        position: getPromptPosition(vectorsDataBank.position),
    });

    // Smart Context (ChromaDB)
    const smartContext = extensionPrompts.chromadb;
    if (smartContext && smartContext.value) systemPrompts.push({
        role: 'system',
        content: smartContext.value,
        identifier: 'smartContext',
        position: getPromptPosition(smartContext.position),
    });

    // Persona Description
    if (power_user.persona_description && power_user.persona_description_position === persona_description_positions.IN_PROMPT) {
        systemPrompts.push({ role: 'system', content: power_user.persona_description, identifier: 'personaDescription' });
    }

    const knownExtensionPrompts = [
        '1_memory',
        '2_floating_prompt',
        '3_vectors',
        '4_vectors_data_bank',
        'chromadb',
        'PERSONA_DESCRIPTION',
        'QUIET_PROMPT',
        'DEPTH_PROMPT',
    ];

    // Anything that is not a known extension prompt
    for (const key in extensionPrompts) {
        if (Object.hasOwn(extensionPrompts, key)) {
            const prompt = extensionPrompts[key];
            if (knownExtensionPrompts.includes(key)) continue;
            if (!extensionPrompts[key].value) continue;
            if (![extension_prompt_types.BEFORE_PROMPT, extension_prompt_types.IN_PROMPT].includes(prompt.position)) continue;

            const hasFilter = typeof prompt.filter === 'function';
            if (hasFilter && !await prompt.filter()) continue;

            systemPrompts.push({
                identifier: key.replace(/\W/g, '_'),
                position: getPromptPosition(prompt.position),
                role: getPromptRole(prompt.role),
                content: prompt.value,
                extension: true,
            });
        }
    }

    // This is the prompt order defined by the user
    const prompts = promptManager.getPromptCollection(type);

    // Merge system prompts with prompt manager prompts
    systemPrompts.forEach(prompt => {
        const collectionPrompt = prompts.get(prompt.identifier);

        // Apply system prompt role/depth overrides if they set in the prompt manager
        if (collectionPrompt) {
            // In-Chat / Relative
            prompt.injection_position = collectionPrompt.injection_position ?? prompt.injection_position;
            // Depth for In-Chat
            prompt.injection_depth = collectionPrompt.injection_depth ?? prompt.injection_depth;
            // Priority for In-Chat
            prompt.injection_order = collectionPrompt.injection_order ?? prompt.injection_order;
            // Role (system, user, assistant)
            prompt.role = collectionPrompt.role ?? prompt.role;
        }

        const newPrompt = promptManager.preparePrompt(prompt);
        const markerIndex = prompts.index(prompt.identifier);

        if (-1 !== markerIndex) prompts.collection[markerIndex] = newPrompt;
        else prompts.add(newPrompt);
    });

    // Apply character-specific main prompt
    const systemPrompt = prompts.get('main') ?? null;
    const isSystemPromptDisabled = promptManager.isPromptDisabledForActiveCharacter('main');
    if (systemPromptOverride && systemPrompt && systemPrompt.forbid_overrides !== true && !isSystemPromptDisabled) {
        const mainOriginalContent = systemPrompt.content;
        systemPrompt.content = systemPromptOverride;
        const mainReplacement = promptManager.preparePrompt(systemPrompt, mainOriginalContent);
        prompts.override(mainReplacement, prompts.index('main'));
    }

    // Apply character-specific jailbreak
    const jailbreakPrompt = prompts.get('jailbreak') ?? null;
    const isJailbreakPromptDisabled = promptManager.isPromptDisabledForActiveCharacter('jailbreak');
    if (jailbreakPromptOverride && jailbreakPrompt && jailbreakPrompt.forbid_overrides !== true && !isJailbreakPromptDisabled) {
        const jbOriginalContent = jailbreakPrompt.content;
        jailbreakPrompt.content = jailbreakPromptOverride;
        const jbReplacement = promptManager.preparePrompt(jailbreakPrompt, jbOriginalContent);
        prompts.override(jbReplacement, prompts.index('jailbreak'));
    }

    return prompts;
}

/**
 * Take a configuration object and prepares messages for a chat with OpenAI's chat completion API.
 * Handles prompts, prepares chat history, manages token budget, and processes various user settings.
 *
 * @param {Object} content - System prompts provided by SillyTavern
 * @param {string} content.name2 - The second name to be used in the messages.
 * @param {string} content.charDescription - Description of the character.
 * @param {string} content.charPersonality - Description of the character's personality.
 * @param {string} content.scenario - The scenario or context of the dialogue.
 * @param {string} content.worldInfoBefore - The world info to be added before the main conversation.
 * @param {string} content.worldInfoAfter - The world info to be added after the main conversation.
 * @param {string} content.bias - The bias to be added in the conversation.
 * @param {string} content.type - The type of the chat, can be 'impersonate'.
 * @param {string} content.quietPrompt - The quiet prompt to be used in the conversation.
 * @param {string} content.quietImage - Image prompt for extras
 * @param {string} content.cyclePrompt - The last prompt used for chat message continuation.
 * @param {string} content.systemPromptOverride - The system prompt override.
 * @param {string} content.jailbreakPromptOverride - The jailbreak prompt override.
 * @param {object} content.extensionPrompts - An array of additional prompts.
 * @param {object[]} content.messages - An array of messages to be used as chat history.
 * @param {string[]} content.messageExamples - An array of messages to be used as dialogue examples.
 * @param dryRun - Whether this is a live call or not.
 * @returns {Promise<(any[]|boolean)[]>} An array where the first element is the prepared chat and the second element is a boolean flag.
 */
export async function prepareOpenAIMessages({
    name2,
    charDescription,
    charPersonality,
    scenario,
    worldInfoBefore,
    worldInfoAfter,
    bias,
    type,
    quietPrompt,
    quietImage,
    extensionPrompts,
    cyclePrompt,
    systemPromptOverride,
    jailbreakPromptOverride,
    messages,
    messageExamples,
}, dryRun) {
    // Without a character selected, there is no way to accurately calculate tokens
    if (!promptManager.activeCharacter && dryRun) return [null, false];

    const chatCompletion = new ChatCompletion();
    if (power_user.console_log_prompts) chatCompletion.enableLogging();

    const userSettings = promptManager.serviceSettings;
    chatCompletion.setTokenBudget(userSettings.openai_max_context, userSettings.openai_max_tokens);

    try {
        // Merge markers and ordered user prompts with system prompts
        const prompts = await preparePromptsForChatCompletion({
            scenario,
            charPersonality,
            name2,
            worldInfoBefore,
            worldInfoAfter,
            charDescription,
            quietPrompt,
            bias,
            extensionPrompts,
            systemPromptOverride,
            jailbreakPromptOverride,
            type,
        });

        // Fill the chat completion with as much context as the budget allows
        await populateChatCompletion(prompts, chatCompletion, { bias, quietPrompt, quietImage, type, cyclePrompt, messages, messageExamples });
    } catch (error) {
        if (error instanceof TokenBudgetExceededError) {
            toastr.error(t`Mandatory prompts exceed the context size.`);
            chatCompletion.log('Mandatory prompts exceed the context size.');
            promptManager.error = t`Not enough free tokens for mandatory prompts. Raise your token limit or disable custom prompts.`;
        } else if (error instanceof InvalidCharacterNameError) {
            toastr.warning(t`An error occurred while counting tokens: Invalid character name`);
            chatCompletion.log('Invalid character name');
            promptManager.error = t`The name of at least one character contained whitespaces or special characters. Please check your user and character name.`;
        } else {
            toastr.error(t`An unknown error occurred while counting tokens. Further information may be available in console.`);
            chatCompletion.log('----- Unexpected error while preparing prompts -----');
            chatCompletion.log(String(error?.message ?? error));
            chatCompletion.log(error.stack);
            chatCompletion.log('----------------------------------------------------');
        }
    } finally {
        // Pass chat completion to prompt manager for inspection
        promptManager.setChatCompletion(chatCompletion);

        if (oai_settings.squash_system_messages && dryRun == false) {
            await chatCompletion.squashSystemMessages();
        }

        // All information is up-to-date, render.
        if (false === dryRun) promptManager.render(false);
    }

    let chat = chatCompletion.getChat();

    // SillyBunny: only prompt-ready listeners that mutate the finalized chat should
    // trigger the post-mutation budget recount.
    const eventData = { chat, dryRun, chatChanged: false };
    await eventSource.emit(event_types.CHAT_COMPLETION_PROMPT_READY, eventData);
    if (!Array.isArray(eventData.chat)) {
        chatCompletion.log('Pre-generation intercepts produced an invalid chat payload.');
        throw new Error('Pre-generation intercepts produced an invalid chat payload.');
    }

    chat = eventData.chat;

    if (!dryRun && shouldCheckPostInterceptChatBudget(eventData)) {
        const { promptTokens, promptTokenBudget, exceeded } = await checkPostInterceptChatBudget(chat, userSettings, countChatCompletionPayloadTokensOpenAIAsync);
        if (exceeded) {
            toastr.error(t`Pre-generation intercepts exceed the context size.`);
            chatCompletion.log(`Pre-generation intercepts exceed the context size. Tokens: ${promptTokens}. Budget: ${promptTokenBudget}.`);
            promptManager.error = t`Pre-generation intercepts made the prompt too large. Reduce intercept output, raise your token limit, or disable the intercept agent.`;
            promptManager.render(false);
            throw new TokenBudgetExceededError('pre-generation intercepts');
        }
    }

    openai_messages_count = chat.filter(x => !x?.tool_calls && ['user', 'assistant', 'tool'].includes(x?.role)).length || 0;

    return [chat, promptManager.tokenHandler.counts];
}

/**
 * Handles errors during streaming requests.
 * @param {Response} response
 * @param {string} decoded - response text or decoded stream data
 * @param {object} [options]
 * @param {boolean?} [options.quiet=false] Suppress toast messages
 */
export function tryParseStreamingError(response, decoded, { quiet = false } = {}) {
    try {
        const data = JSON.parse(decoded);

        if (!data) {
            return;
        }

        checkQuotaError(data, { quiet });
        checkModerationError(data, { quiet });

        // these do not throw correctly (equiv to Error("[object Object]"))
        // if trying to fix "[object Object]" displayed to users, start here

        if (data.error) {
            !quiet && toastr.error(data.error.message || response.statusText, 'Chat Completion API');
            throw new Error(typeof data === 'string' ? data : JSON.stringify(data));
        }

        if (data.message) {
            !quiet && toastr.error(data.message, 'Chat Completion API');
            throw new Error(typeof data === 'string' ? data : JSON.stringify(data));
        }

        if (data.detail) {
            !quiet && toastr.error(data.detail?.error?.message || response.statusText, 'Chat Completion API');
            throw new Error(typeof data === 'string' ? data : JSON.stringify(data));
        }
    } catch {
        // No JSON. Do nothing.
    }
}

/**
 * Checks if the response contains a quota error and displays a popup if it does.
 * @param data
 * @param {object} [options]
 * @param {boolean?} [options.quiet=false] Suppress toast messages
 * @returns {void}
 * @throws {object} - response JSON
 */
function checkQuotaError(data, { quiet = false } = {}) {
    if (!data) {
        return;
    }

    if (data.quota_error) {
        !quiet && renderTemplateAsync('quotaError').then((html) => Popup.show.text('Quota Error', html));

        throw new Error(typeof data === 'string' ? data : JSON.stringify(data));
    }
}

/**
 * @param {any} data
 * @param {object} [options]
 * @param {boolean?} [options.quiet=false] Suppress toast messages
 */
function checkModerationError(data, { quiet = false } = {}) {
    const moderationError = data?.error?.message?.includes('requires moderation');
    if (moderationError && !quiet) {
        const moderationReason = `Reasons: ${data?.error?.metadata?.reasons?.join(', ') ?? '(N/A)'}`;
        const flaggedText = data?.error?.metadata?.flagged_input ?? '(N/A)';
        toastr.info(flaggedText, moderationReason, { timeOut: 10000 });
    }
}

/**
 * Gets the API model for the selected chat completion source.
 * @param {ChatCompletionSettings} settings Chat completion settings
 * @returns {string} API model
 */
export function getChatCompletionModel(settings = null) {
    settings = settings ?? oai_settings;
    const source = settings.chat_completion_source;
    switch (source) {
        case chat_completion_sources.CLAUDE:
            return settings.claude_model;
        case chat_completion_sources.OPENAI:
        case chat_completion_sources.OPENAI_RESPONSES:
            return settings.openai_model;
        case chat_completion_sources.MAKERSUITE:
            return settings.google_model;
        case chat_completion_sources.VERTEXAI:
            return settings.vertexai_model;
        case chat_completion_sources.OPENROUTER:
            return settings.openrouter_model !== openrouter_website_model ? settings.openrouter_model : null;
        case chat_completion_sources.AI21:
            return settings.ai21_model;
        case chat_completion_sources.MISTRALAI:
            return settings.mistralai_model;
        case chat_completion_sources.CUSTOM:
            return settings.custom_model;
        case chat_completion_sources.COHERE:
            return settings.cohere_model;
        case chat_completion_sources.PERPLEXITY:
            return settings.perplexity_model;
        case chat_completion_sources.GROQ:
            return settings.groq_model;
        case chat_completion_sources.SILICONFLOW:
            return settings.siliconflow_model;
        case chat_completion_sources.MINIMAX:
            return settings.minimax_model;
        case chat_completion_sources.ELECTRONHUB:
            return settings.electronhub_model;
        case chat_completion_sources.CHUTES:
            return settings.chutes_model;
        case chat_completion_sources.NANOGPT:
            return settings.nanogpt_model;
        case chat_completion_sources.DEEPSEEK:
            return settings.deepseek_model;
        case chat_completion_sources.AIMLAPI:
            return settings.aimlapi_model;
        case chat_completion_sources.XAI:
            return settings.xai_model;
        case chat_completion_sources.POLLINATIONS:
            return settings.pollinations_model;
        case chat_completion_sources.COMETAPI:
            return settings.cometapi_model;
        case chat_completion_sources.MOONSHOT:
            return settings.moonshot_model;
        case chat_completion_sources.FIREWORKS:
            return settings.fireworks_model;
        case chat_completion_sources.AZURE_OPENAI:
            return settings.azure_openai_model;
        case chat_completion_sources.ZAI:
            return settings.zai_model;
        case chat_completion_sources.WORKERS_AI:
            return settings.workers_ai_model;
        default:
            console.error(`Unknown chat completion source: ${source}`);
            return '';
    }
}

const configurableContextUnlockSources = new Set([
    chat_completion_sources.OPENROUTER,
    chat_completion_sources.NANOGPT,
]);

function isContextUnlockConfigurable(source = oai_settings.chat_completion_source) {
    return configurableContextUnlockSources.has(source);
}

function isMaxContextUnlockedForSource(settings = oai_settings) {
    // SillyBunny keeps most OpenAI-compatible sources unlocked; expose model limits only where users requested them.
    return !isContextUnlockConfigurable(settings.chat_completion_source) || !!settings.max_context_unlocked;
}

function syncMaxContextUnlockedControl(settings = oai_settings) {
    const isConfigurable = isContextUnlockConfigurable(settings.chat_completion_source);
    const isUnlocked = isMaxContextUnlockedForSource(settings);

    $('#oai_max_context_unlocked').prop('checked', isUnlocked);
    $('#oai_max_context_unlocked_block').toggle(isConfigurable);

    return isUnlocked;
}

function shouldRequestReasoning(settings = oai_settings) {
    return Boolean(settings.show_thoughts || settings.auto_append_reasoning_tags);
}

function getAutoAppendReasoningTagStyle(settings = oai_settings) {
    const style = String(settings.auto_append_reasoning_tag_style ?? '').trim().toLowerCase();
    if (Object.values(reasoning_tag_styles).includes(style)) {
        return style;
    }

    return reasoning_tag_styles.think;
}

function getAutoAppendReasoningTagPair(settings = oai_settings) {
    const tagName = getAutoAppendReasoningTagStyle(settings);
    return {
        openTag: `<${tagName}>`,
        closeTag: `</${tagName}>`,
    };
}

function shouldInjectAutoAppendReasoningInstruction(settings = oai_settings, model = null, type = 'normal') {
    if (!settings.auto_append_reasoning_tags || type === 'quiet') {
        return false;
    }

    const source = settings.chat_completion_source;
    if (source === chat_completion_sources.CUSTOM) {
        return true;
    }

    const normalizedModel = String(model ?? getChatCompletionModel(settings) ?? '').trim().toLowerCase();
    if (!normalizedModel) {
        return false;
    }

    if ([chat_completion_sources.OPENAI, chat_completion_sources.OPENAI_RESPONSES, chat_completion_sources.AZURE_OPENAI].includes(source)) {
        return ['gpt-4.5', 'o1', 'o3'].some(prefix => normalizedModel.startsWith(prefix));
    }

    if ([chat_completion_sources.MAKERSUITE, chat_completion_sources.VERTEXAI].includes(source)) {
        return ['gemini-2.0-flash-thinking-exp', 'gemini-2.0-pro-exp'].some(prefix => normalizedModel.startsWith(prefix));
    }

    return false;
}

function appendAutoAppendReasoningInstruction(messages, settings = oai_settings, model = null, type = 'normal') {
    if (!shouldInjectAutoAppendReasoningInstruction(settings, model, type)) {
        return messages;
    }

    const { openTag, closeTag } = getAutoAppendReasoningTagPair(settings);
    const instruction = `Before your final answer, place any visible reasoning inside ${openTag}...${closeTag}. Put the user-facing reply after ${closeTag}, and always close the tag before the final reply.`;
    const nextMessages = structuredClone(messages);
    const systemMessage = nextMessages.find(message => message?.role === 'system' && typeof message?.content === 'string');

    if (systemMessage) {
        const existingContent = String(systemMessage.content ?? '').trim();
        systemMessage.content = existingContent ? `${existingContent}\n\n${instruction}` : instruction;
        return nextMessages;
    }

    nextMessages.unshift({
        role: 'system',
        content: instruction,
    });
    return nextMessages;
}

function getCustomReasoningPresetConfig(preset = custom_reasoning_preset_types.OPENAI) {
    return CUSTOM_REASONING_PRESETS[preset] ?? CUSTOM_REASONING_PRESETS[custom_reasoning_preset_types.OPENAI];
}

function ensureModelFavoritesStore(settings = oai_settings) {
    if (!settings.model_favorites || typeof settings.model_favorites !== 'object' || Array.isArray(settings.model_favorites)) {
        settings.model_favorites = {};
    }

    return settings.model_favorites;
}

function getModelFavoritesForSource(source = oai_settings.chat_completion_source, settings = oai_settings) {
    const favoritesStore = ensureModelFavoritesStore(settings);

    if (!Array.isArray(favoritesStore[source])) {
        favoritesStore[source] = [];
    }

    favoritesStore[source] = [...new Set(
        favoritesStore[source]
            .filter(model => typeof model === 'string')
            .map(model => model.trim())
            .filter(Boolean),
    )];

    return favoritesStore[source];
}

function setModelFavoritesForSource(source, favorites, settings = oai_settings) {
    const favoritesStore = ensureModelFavoritesStore(settings);
    favoritesStore[source] = [...new Set(
        (Array.isArray(favorites) ? favorites : [])
            .filter(model => typeof model === 'string')
            .map(model => model.trim())
            .filter(Boolean),
    )];
}

function isMessageStyleChatCompletions(settings = oai_settings) {
    const activeMainApi = String($('#main_api').val() || main_api || '');

    if (activeMainApi !== 'openai') {
        return false;
    }

    const model = String(getChatCompletionModel(settings) || '');
    return !textCompletionModels.includes(model);
}

function updateAdvancedFormattingVisibility() {
    $('#AdvancedFormatting').toggleClass('sb-chat-completion-mode', isMessageStyleChatCompletions());
}

function cacheOpenAIStaticModelGroups() {
    if (Array.isArray(openAiStaticModelGroups)) {
        return openAiStaticModelGroups;
    }

    const $modelSelect = $('#model_openai_select');
    if ($modelSelect.length === 0) {
        openAiStaticModelGroups = [];
        return openAiStaticModelGroups;
    }

    openAiStaticModelGroups = $modelSelect.children().not('#openai_external_category, [data-sb-generated="true"]').map((_, element) => {
        if (element.tagName === 'OPTGROUP') {
            return {
                type: 'group',
                label: element.label,
                options: Array.from(element.children).map(option => ({
                    value: option.value,
                    text: option.textContent.trim(),
                })),
            };
        }

        return {
            type: 'option',
            value: element.value,
            text: element.textContent.trim(),
        };
    }).get();

    return openAiStaticModelGroups;
}

function collectOpenAIOptionMap() {
    const optionMap = new Map();
    const externalModels = [chat_completion_sources.OPENAI, chat_completion_sources.OPENAI_RESPONSES].includes(oai_settings.chat_completion_source)
        ? (Array.isArray(model_list) ? model_list : [])
        : [];
    const addOption = (option) => {
        if (!option?.value || optionMap.has(option.value)) {
            return;
        }

        optionMap.set(option.value, {
            value: option.value,
            text: option.text || option.value,
        });
    };

    for (const entry of cacheOpenAIStaticModelGroups()) {
        if (entry.type === 'group') {
            entry.options.forEach(addOption);
        } else {
            addOption(entry);
        }
    }

    for (const model of externalModels) {
        if (typeof model?.id === 'string' && model.id.length > 0) {
            addOption({ value: model.id, text: model.id });
        }
    }

    return optionMap;
}

function createOpenAIModelOption(option, { favorite = false } = {}) {
    return $('<option>', {
        value: option.value,
        text: option.text,
    })
        .attr('data-sb-generated', 'true')
        .attr('data-favorite', favorite ? 'true' : 'false');
}

function syncOpenAIModelIdInput(modelId = oai_settings.openai_model) {
    $('#openai_model_id').val(String(modelId || ''));
}

function ensureOpenAIModelSelectOption(modelId) {
    const value = String(modelId || '');
    const $modelSelect = $('#model_openai_select');

    if (!value || $modelSelect.length === 0 || $modelSelect.find(`option[value="${CSS.escape(value)}"]`).length > 0) {
        return;
    }

    let $currentGroup = $modelSelect.find('optgroup[data-sb-current-model="true"]');
    if ($currentGroup.length === 0) {
        $currentGroup = $('<optgroup>', {
            label: t`Current`,
        })
            .attr('data-sb-generated', 'true')
            .attr('data-sb-current-model', 'true');
        $modelSelect.append($currentGroup);
    } else {
        $currentGroup.empty();
    }

    $currentGroup.append(createOpenAIModelOption({ value, text: value }));
}

function appendOpenAIModelEntry($container, entry, favoriteValues = new Set()) {
    if (entry.type === 'group') {
        const $group = $('<optgroup>', { label: entry.label }).attr('data-sb-generated', 'true');
        entry.options
            .filter(option => !favoriteValues.has(option.value))
            .forEach(option => $group.append(createOpenAIModelOption(option)));

        if ($group.children().length > 0) {
            $container.append($group);
        }
        return;
    }

    if (!favoriteValues.has(entry.value)) {
        $container.append(createOpenAIModelOption(entry));
    }
}

function getApiSelect2DropdownParent() {
    const apiDropdownParent = $('#rm_api_block');
    return apiDropdownParent.length ? apiDropdownParent : $(document.body);
}

function getPromptManagerSelect2DropdownParent() {
    const promptManagerPopup = $('#completion_prompt_manager_popup');
    return promptManagerPopup.length ? promptManagerPopup : getApiSelect2DropdownParent();
}

function closeModelSelectPickerMenus(exceptMenu = null) {
    document.querySelectorAll('.sb-model-id-picker-menu').forEach(menu => {
        if (menu !== exceptMenu) {
            menu.hidden = true;
        }
    });
}

function bindModelSelectPickerDocumentListener() {
    if (modelSelectPickerDocumentListenerBound) {
        return;
    }

    document.addEventListener('click', event => {
        if (event.target instanceof Element && event.target.closest('.sb-model-id-search-row, .sb-model-id-picker-menu, .sb-inline-select-picker-control')) {
            return;
        }

        closeModelSelectPickerMenus();
    });

    document.addEventListener('keydown', event => {
        if (event.key === 'Escape') {
            closeModelSelectPickerMenus();
        }
    });

    modelSelectPickerDocumentListenerBound = true;
}

function getModelSelectPickerOptionEntries(select) {
    const entries = [];

    for (const child of select.children) {
        if (child instanceof HTMLOptGroupElement) {
            const groupLabel = child.label || '';
            for (const option of child.children) {
                if (option instanceof HTMLOptionElement && !option.disabled) {
                    entries.push({ group: groupLabel, text: option.textContent.trim() || option.value, value: option.value });
                }
            }
            continue;
        }

        if (child instanceof HTMLOptionElement && !child.disabled) {
            entries.push({ group: '', text: child.textContent.trim() || child.value, value: child.value });
        }
    }

    return entries.filter(entry => entry.value);
}

function openInlineModelSelectPicker(select, { input = null, source = select.id } = {}) {
    const row = input instanceof HTMLInputElement && input.parentElement instanceof HTMLElement ? input.parentElement : null;
    const menuParent = row?.parentElement;

    if (!row || !menuParent) {
        return false;
    }

    let menu = menuParent.querySelector(`.sb-model-id-picker-menu[data-sb-model-id-picker-menu-source="${CSS.escape(source)}"]`);
    if (!(menu instanceof HTMLElement)) {
        menu = document.createElement('div');
        menu.className = 'sb-model-id-picker-menu';
        menu.dataset.sbModelIdPickerMenuSource = source;
        menu.hidden = true;
        menu.setAttribute('role', 'listbox');
        row.insertAdjacentElement('afterend', menu);
    }

    const entries = getModelSelectPickerOptionEntries(select);
    const currentValue = select.value || input.value || '';
    let currentGroup = null;

    menu.innerHTML = '';
    menu.setAttribute('aria-label', t`Available models`);

    if (entries.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'sb-model-id-picker-empty';
        empty.textContent = t`No models available`;
        menu.appendChild(empty);
    }

    for (const entry of entries) {
        if (entry.group && entry.group !== currentGroup) {
            currentGroup = entry.group;
            const heading = document.createElement('div');
            heading.className = 'sb-model-id-picker-group';
            heading.textContent = entry.group;
            menu.appendChild(heading);
        }

        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'sb-model-id-picker-option';
        button.textContent = entry.text;
        button.dataset.value = entry.value;
        button.setAttribute('role', 'option');
        button.setAttribute('aria-selected', String(entry.value === currentValue));
        button.addEventListener('click', () => {
            select.value = entry.value;
            input.value = entry.value;
            select.dispatchEvent(new Event('change', { bubbles: true }));
            closeModelSelectPickerMenus();
        });
        menu.appendChild(button);
    }

    bindModelSelectPickerDocumentListener();
    const willOpen = menu.hidden;
    closeModelSelectPickerMenus(menu);
    menu.hidden = !willOpen;

    if (!menu.hidden) {
        menu.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }

    return true;
}

function getInlineSelectPickerEntries(select) {
    const entries = [];

    for (const child of select.children) {
        if (child instanceof HTMLOptGroupElement) {
            const groupLabel = child.label || '';
            for (const option of child.children) {
                if (option instanceof HTMLOptionElement && !option.disabled) {
                    entries.push({ group: groupLabel, text: option.textContent.trim() || option.value, value: option.value });
                }
            }
            continue;
        }

        if (child instanceof HTMLOptionElement && !child.disabled) {
            entries.push({ group: '', text: child.textContent.trim() || child.value, value: child.value });
        }
    }

    return entries;
}

function getInlineSelectPickerSelectedValues(select) {
    return new Set(Array.from(select.selectedOptions).map(option => option.value));
}

function dispatchInlineSelectPickerChange(select) {
    select.dispatchEvent(new Event('change', { bubbles: true }));
    select.dispatchEvent(new Event('input', { bubbles: true }));
}

function toggleInlineSelectPickerOption(select, value) {
    if (select.multiple) {
        for (const option of select.options) {
            if (option.value === value) {
                option.selected = !option.selected;
                break;
            }
        }
    } else {
        select.value = value;
    }

    dispatchInlineSelectPickerChange(select);
}

function openInlineSelectPicker(select, { source = select.id, label = select.id, multiple = select.multiple, forceOpen = false } = {}) {
    if (!(select instanceof HTMLSelectElement) || !(select.parentElement instanceof HTMLElement) || select.disabled) {
        return false;
    }

    const menuParent = select.parentElement;
    let menu = menuParent.querySelector(`.sb-model-id-picker-menu[data-sb-model-id-picker-menu-source="${CSS.escape(source)}"]`);
    if (!(menu instanceof HTMLElement)) {
        menu = document.createElement('div');
        menu.className = 'sb-model-id-picker-menu sb-inline-select-picker-menu';
        menu.dataset.sbModelIdPickerMenuSource = source;
        menu.hidden = true;
        menu.setAttribute('role', 'listbox');
        if (multiple) {
            menu.setAttribute('aria-multiselectable', 'true');
        }
        select.insertAdjacentElement('afterend', menu);
    }

    const entries = getInlineSelectPickerEntries(select);
    const selectedValues = getInlineSelectPickerSelectedValues(select);
    let currentGroup = null;

    menu.innerHTML = '';
    menu.setAttribute('aria-label', label);
    menu.toggleAttribute('data-sb-inline-select-multiple', Boolean(multiple));

    if (entries.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'sb-model-id-picker-empty';
        empty.textContent = t`No options available`;
        menu.appendChild(empty);
    }

    for (const entry of entries) {
        if (entry.group && entry.group !== currentGroup) {
            currentGroup = entry.group;
            const heading = document.createElement('div');
            heading.className = 'sb-model-id-picker-group';
            heading.textContent = entry.group;
            menu.appendChild(heading);
        }

        const button = document.createElement('button');
        const selected = selectedValues.has(entry.value);
        button.type = 'button';
        button.className = 'sb-model-id-picker-option sb-inline-select-picker-option';
        button.textContent = entry.text;
        button.dataset.value = entry.value;
        button.setAttribute('role', 'option');
        button.setAttribute('aria-selected', String(selected));
        if (multiple) {
            button.setAttribute('aria-pressed', String(selected));
        }
        button.addEventListener('click', () => {
            toggleInlineSelectPickerOption(select, entry.value);
            if (multiple) {
                openInlineSelectPicker(select, { source, label, multiple, forceOpen: true });
            } else {
                closeModelSelectPickerMenus();
            }
        });
        menu.appendChild(button);
    }

    bindModelSelectPickerDocumentListener();
    const willOpen = forceOpen || menu.hidden;
    closeModelSelectPickerMenus(menu);
    menu.hidden = !willOpen;

    if (!menu.hidden) {
        menu.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }

    return true;
}

function shouldUseInlineModelSelectPicker() {
    return isMobile() || window.matchMedia('(max-width: 768px)').matches;
}

function bindInlineSelectPickerSelect(select, control) {
    if (!(select instanceof HTMLSelectElement) || select.dataset.sbInlineSelectPickerBound === 'true') {
        return;
    }

    select.dataset.sbInlineSelectPickerBound = 'true';
    select.classList.add('sb-inline-select-picker-control');

    const openPicker = event => {
        if (!shouldUseInlineModelSelectPicker()) {
            return;
        }

        event.preventDefault();
        event.stopPropagation();
        openInlineSelectPicker(select, control);
    };

    select.addEventListener('pointerdown', openPicker);
    select.addEventListener('click', event => {
        if (shouldUseInlineModelSelectPicker()) {
            event.preventDefault();
        }
    });
    select.addEventListener('keydown', event => {
        if (!shouldUseInlineModelSelectPicker() || ![' ', 'Enter', 'ArrowDown'].includes(event.key)) {
            return;
        }

        openPicker(event);
    });
}

function bindInlineSelectPickerControl(control) {
    document.querySelectorAll(control.select).forEach(select => bindInlineSelectPickerSelect(select, control));
}

function bindInlineSelectPickerControls() {
    INLINE_SELECT_PICKER_CONTROLS.forEach(bindInlineSelectPickerControl);

    if (!inlineSelectPickerObserverBound && document.body instanceof HTMLElement) {
        const observer = new MutationObserver(() => {
            INLINE_SELECT_PICKER_CONTROLS.forEach(bindInlineSelectPickerControl);
        });
        observer.observe(document.body, { childList: true, subtree: true });
        inlineSelectPickerObserverBound = true;
    }
}

function setModelIdPickerTouchTarget(button) {
    if (!(button instanceof HTMLButtonElement)) {
        return;
    }

    for (const property of ['width', 'min-width', 'max-width', 'height', 'min-height', 'max-height', 'flex-basis']) {
        button.style.setProperty(property, '44px', 'important');
    }
    button.style.setProperty('padding', '0', 'important');
}

function openModelSelectPicker(select, options = {}) {
    if (!(select instanceof HTMLSelectElement) || select.disabled) {
        return;
    }

    select.scrollIntoView({ block: 'nearest', inline: 'nearest' });

    if (shouldUseInlineModelSelectPicker() && openInlineModelSelectPicker(select, options)) {
        return;
    }

    if (select.classList.contains('select2-hidden-accessible') && typeof $ === 'function') {
        try {
            $(select).select2('open');
            return;
        } catch {
            // Fall back to the native picker below when Select2 is not ready.
        }
    }

    select.focus({ preventScroll: true });

    if (typeof select.showPicker === 'function') {
        try {
            select.showPicker();
        } catch {
            select.focus({ preventScroll: true });
        }
    }
}

function ensureOpenAIModelPickerButton() {
    const input = document.querySelector('#openai_model_id');
    const select = document.querySelector('#model_openai_select');

    if (!(input instanceof HTMLInputElement) || !(select instanceof HTMLSelectElement) || !(input.parentElement instanceof HTMLElement)) {
        return;
    }

    const row = input.parentElement;
    row.classList.add('sb-model-id-search-row');
    input.classList.add('sb-model-id-search-input');

    let button = row.querySelector('#model_openai_picker_toggle');
    if (!(button instanceof HTMLButtonElement)) {
        button = document.createElement('button');
        button.id = 'model_openai_picker_toggle';
        button.type = 'button';
        button.className = 'menu_button menu_button_icon sb-model-id-picker-toggle';
        button.innerHTML = '<i class="fa-solid fa-list-ul" aria-hidden="true"></i>';
        button.addEventListener('click', () => openModelSelectPicker(select, { input, source: chat_completion_sources.OPENAI }));
        input.insertAdjacentElement('afterend', button);
    }

    button.title = t`Open model list`;
    button.setAttribute('aria-label', t`Open model list`);
    button.disabled = select.disabled || select.options.length === 0;
    setModelIdPickerTouchTarget(button);
}

function initOpenAIModelSearch() {
    const $modelSelect = $('#model_openai_select');
    ensureOpenAIModelPickerButton();

    if (shouldUseInlineModelSelectPicker() || $modelSelect.length === 0) {
        return;
    }

    if ($modelSelect.hasClass('select2-hidden-accessible')) {
        $modelSelect.select2('destroy');
    }

    $modelSelect.select2({
        dropdownParent: getApiSelect2DropdownParent(),
        placeholder: t`Select a model`,
        searchInputPlaceholder: t`Search models...`,
        searchInputCssClass: 'text_pole',
        width: '100%',
        matcher: textValueMatcher,
    });
}

function updateOpenAIModelFavoriteButton() {
    const $favoriteButton = $('#model_openai_favorite_toggle');
    if ($favoriteButton.length === 0) {
        return;
    }

    const currentModel = String($('#openai_model_id').val() || oai_settings.openai_model || $('#model_openai_select').val() || '');
    const isFavorite = currentModel.length > 0 && getModelFavoritesForSource(chat_completion_sources.OPENAI).includes(currentModel);
    const title = currentModel.length === 0
        ? t`Select a model first`
        : isFavorite
            ? t`Remove current model from favorites`
            : t`Add current model to favorites`;

    $favoriteButton.prop('disabled', currentModel.length === 0);
    $favoriteButton.attr('title', title);
    $favoriteButton.attr('aria-label', title);
    $favoriteButton.attr('aria-pressed', String(isFavorite));
    $favoriteButton.toggleClass('is-favorite', isFavorite);
}

function rebuildOpenAIModelSelect() {
    const $modelSelect = $('#model_openai_select');

    if ($modelSelect.length === 0) {
        return;
    }

    const optionMap = collectOpenAIOptionMap();
    const selectedValue = String(oai_settings.openai_model || $modelSelect.val() || default_settings.openai_model || '');
    const favoriteOptions = getModelFavoritesForSource(chat_completion_sources.OPENAI)
        .filter(Boolean)
        .map(modelId => optionMap.get(modelId) || { value: modelId, text: modelId });
    const favoriteValues = new Set(favoriteOptions.map(option => option.value));
    const externalModels = [chat_completion_sources.OPENAI, chat_completion_sources.OPENAI_RESPONSES].includes(oai_settings.chat_completion_source)
        ? (Array.isArray(model_list) ? model_list : [])
        : [];

    $modelSelect.empty();

    if (favoriteOptions.length > 0) {
        const $favoritesGroup = $('<optgroup>', {
            label: t`Favorites`,
        }).attr('data-sb-generated', 'true');

        favoriteOptions.forEach(option => $favoritesGroup.append(createOpenAIModelOption(option, { favorite: true })));
        $modelSelect.append($favoritesGroup);
    }

    cacheOpenAIStaticModelGroups().forEach(entry => appendOpenAIModelEntry($modelSelect, entry, favoriteValues));

    const $externalGroup = $('<optgroup>', {
        id: 'openai_external_category',
        label: 'External',
    }).attr('data-sb-generated', 'true');

    const externalIds = [...new Set(
        externalModels
            .map(model => typeof model?.id === 'string' ? model.id.trim() : '')
            .filter(Boolean),
    )].sort((left, right) => left.localeCompare(right));

    externalIds
        .filter(modelId => !favoriteValues.has(modelId))
        .forEach(modelId => {
            $externalGroup.append(createOpenAIModelOption({ value: modelId, text: modelId }));
        });

    $modelSelect.append($externalGroup);
    $externalGroup.toggle(oai_settings.show_external_models);

    if (selectedValue && $modelSelect.find(`option[value="${CSS.escape(selectedValue)}"]`).length === 0) {
        const $currentGroup = $('<optgroup>', {
            label: t`Current`,
        })
            .attr('data-sb-generated', 'true')
            .attr('data-sb-current-model', 'true');

        $currentGroup.append(createOpenAIModelOption({ value: selectedValue, text: selectedValue }));
        $modelSelect.append($currentGroup);
    }

    let nextValue = selectedValue;
    if (!nextValue || $modelSelect.find(`option[value="${CSS.escape(nextValue)}"]`).length === 0) {
        nextValue = default_settings.openai_model;
    }
    if (!nextValue || $modelSelect.find(`option[value="${CSS.escape(nextValue)}"]`).length === 0) {
        nextValue = String($modelSelect.find('option').first().val() || '');
    }

    if (nextValue) {
        $modelSelect.val(nextValue);
        oai_settings.openai_model = nextValue;
    }

    syncOpenAIModelIdInput(nextValue);
    initOpenAIModelSearch();
    $modelSelect.trigger('change.select2');
    updateOpenAIModelFavoriteButton();
}

function toggleOpenAIModelFavorite() {
    const modelId = String($('#openai_model_id').val() || oai_settings.openai_model || $('#model_openai_select').val() || '');
    if (!modelId) {
        return;
    }

    const favorites = [...getModelFavoritesForSource(chat_completion_sources.OPENAI)];
    const favoriteIndex = favorites.indexOf(modelId);

    if (favoriteIndex >= 0) {
        favorites.splice(favoriteIndex, 1);
    } else {
        favorites.unshift(modelId);
    }

    setModelFavoritesForSource(chat_completion_sources.OPENAI, favorites);
    rebuildOpenAIModelSelect();
    $('#model_openai_select').val(modelId).trigger('change.select2');
    updateOpenAIModelFavoriteButton();
    saveSettingsDebounced();
}

function normalizeModelIdSearchValue(value) {
    return String(value ?? '').trim();
}

function getModelIdSearchState(source) {
    if (!modelIdSearchControlState.has(source)) {
        modelIdSearchControlState.set(source, {
            staticEntries: null,
            query: '',
        });
    }

    return modelIdSearchControlState.get(source);
}

function readModelIdSearchOption(option) {
    const attrs = {};

    for (const attribute of Array.from(option.attributes)) {
        if (['selected', 'data-sb-model-id-generated', 'data-favorite'].includes(attribute.name)) {
            continue;
        }

        attrs[attribute.name] = attribute.value;
    }

    return {
        value: normalizeModelIdSearchValue(option.value),
        text: option.textContent.trim() || option.value,
        attrs,
    };
}

function readModelIdSearchStaticEntries(control) {
    if (control.dynamicOnly) {
        return [];
    }

    const select = document.querySelector(control.select);
    if (!(select instanceof HTMLSelectElement)) {
        return [];
    }

    return Array.from(select.children).map(child => {
        if (child.getAttribute('data-sb-model-id-generated') === 'true') {
            return null;
        }

        if (child instanceof HTMLOptGroupElement) {
            const attrs = {};
            for (const attribute of Array.from(child.attributes)) {
                if (['label', 'data-sb-model-id-generated'].includes(attribute.name)) {
                    continue;
                }

                attrs[attribute.name] = attribute.value;
            }

            const isDynamicGroup = control.dynamicGroupId && child.id === control.dynamicGroupId;
            return {
                type: 'group',
                label: child.label,
                attrs,
                dynamic: Boolean(isDynamicGroup),
                options: isDynamicGroup
                    ? []
                    : Array.from(child.children)
                        .filter(option => option instanceof HTMLOptionElement)
                        .map(readModelIdSearchOption),
            };
        }

        if (child instanceof HTMLOptionElement) {
            return {
                type: 'option',
                option: readModelIdSearchOption(child),
            };
        }

        return null;
    }).filter(Boolean);
}

function getModelIdSearchStaticEntries(control) {
    const state = getModelIdSearchState(control.source);

    if (!Array.isArray(state.staticEntries)) {
        state.staticEntries = readModelIdSearchStaticEntries(control);
    }

    return state.staticEntries;
}

function addModelIdSearchOption(optionMap, option) {
    const value = normalizeModelIdSearchValue(option?.value);
    if (!value || optionMap.has(value)) {
        return;
    }

    optionMap.set(value, {
        value,
        text: String(option?.text || value),
        attrs: option?.attrs || {},
    });
}

function getModelIdSearchDynamicOptions(control) {
    if (oai_settings.chat_completion_source !== control.source || !Array.isArray(model_list)) {
        return [];
    }

    return model_list
        .map(model => {
            const id = normalizeModelIdSearchValue(model?.id);
            if (!id) {
                return null;
            }

            return {
                value: id,
                text: String(model?.name || model?.display_name || id),
            };
        })
        .filter(Boolean);
}

function createModelIdSearchOptionElement(option, { favorite = false } = {}) {
    const optionElement = new Option(option.text || option.value, option.value);

    for (const [name, value] of Object.entries(option.attrs || {})) {
        if (!['selected', 'data-sb-model-id-generated', 'data-favorite'].includes(name)) {
            optionElement.setAttribute(name, value);
        }
    }

    optionElement.setAttribute('data-sb-model-id-generated', 'true');
    optionElement.setAttribute('data-favorite', favorite ? 'true' : 'false');
    return optionElement;
}

function modelIdSearchOptionMatches(option, query) {
    if (!query) {
        return true;
    }

    const haystack = `${option.value} ${option.text}`.toLowerCase();
    return haystack.includes(query);
}

function appendModelIdSearchOption(parent, option, renderedValues, { favorite = false } = {}) {
    if (renderedValues.has(option.value)) {
        return false;
    }

    parent.appendChild(createModelIdSearchOptionElement(option, { favorite }));
    renderedValues.add(option.value);
    return true;
}

function rebuildModelIdSearchDatalist(control, optionMap, favoriteOptions, query) {
    if (!control.datalist) {
        return;
    }

    const datalist = document.querySelector(control.datalist);
    if (!(datalist instanceof HTMLDataListElement)) {
        return;
    }

    const seen = new Set();
    const options = [...favoriteOptions, ...optionMap.values()];
    datalist.replaceChildren();

    for (const option of options) {
        if (seen.has(option.value) || !modelIdSearchOptionMatches(option, query)) {
            continue;
        }

        const optionElement = document.createElement('option');
        optionElement.value = option.value;
        optionElement.label = option.text;
        datalist.appendChild(optionElement);
        seen.add(option.value);
    }
}

function rebuildModelIdSearchControl(control, { preserveQuery = false } = {}) {
    const input = document.querySelector(control.input);
    const select = document.querySelector(control.select);

    if (!(input instanceof HTMLInputElement) || !(select instanceof HTMLSelectElement)) {
        return;
    }

    const state = getModelIdSearchState(control.source);
    const staticEntries = getModelIdSearchStaticEntries(control);
    const query = preserveQuery ? normalizeModelIdSearchValue(state.query).toLowerCase() : '';
    const selectedValue = normalizeModelIdSearchValue(oai_settings[control.setting] ?? input.value ?? select.value);
    const favorites = getModelFavoritesForSource(control.source);
    const favoriteValues = new Set(favorites);
    const dynamicOptions = getModelIdSearchDynamicOptions(control);
    const optionMap = new Map();

    for (const entry of staticEntries) {
        if (entry.type === 'group') {
            entry.options.forEach(option => addModelIdSearchOption(optionMap, option));
        } else {
            addModelIdSearchOption(optionMap, entry.option);
        }
    }

    dynamicOptions.forEach(option => addModelIdSearchOption(optionMap, option));
    favorites.forEach(modelId => addModelIdSearchOption(optionMap, { value: modelId, text: modelId }));
    addModelIdSearchOption(optionMap, { value: selectedValue, text: selectedValue });

    const favoriteOptions = favorites
        .map(modelId => optionMap.get(modelId))
        .filter(Boolean)
        .filter(option => modelIdSearchOptionMatches(option, query));
    const renderedValues = new Set();

    select.replaceChildren();

    if (favoriteOptions.length > 0) {
        const favoritesGroup = document.createElement('optgroup');
        favoritesGroup.label = t`Favorites`;
        favoritesGroup.setAttribute('data-sb-model-id-generated', 'true');
        favoriteOptions.forEach(option => appendModelIdSearchOption(favoritesGroup, option, renderedValues, { favorite: true }));
        select.appendChild(favoritesGroup);
    }

    for (const entry of staticEntries) {
        if (entry.type === 'option') {
            const option = entry.option;
            if (!favoriteValues.has(option.value) && modelIdSearchOptionMatches(option, query)) {
                appendModelIdSearchOption(select, option, renderedValues);
            }
            continue;
        }

        const group = document.createElement('optgroup');
        group.label = entry.label;
        for (const [name, value] of Object.entries(entry.attrs || {})) {
            group.setAttribute(name, value);
        }
        group.setAttribute('data-sb-model-id-generated', 'true');

        const groupOptions = entry.dynamic ? dynamicOptions : entry.options;
        groupOptions
            .filter(option => !favoriteValues.has(option.value))
            .filter(option => modelIdSearchOptionMatches(option, query))
            .forEach(option => appendModelIdSearchOption(group, option, renderedValues));

        if (group.children.length > 0 || entry.dynamic) {
            select.appendChild(group);
        }
    }

    if (!staticEntries.some(entry => entry.type === 'group' && entry.dynamic) && dynamicOptions.length > 0) {
        const dynamicGroup = document.createElement('optgroup');
        dynamicGroup.label = t`From API`;
        dynamicGroup.setAttribute('data-sb-model-id-generated', 'true');
        dynamicOptions
            .filter(option => !favoriteValues.has(option.value))
            .filter(option => modelIdSearchOptionMatches(option, query))
            .forEach(option => appendModelIdSearchOption(dynamicGroup, option, renderedValues));

        if (dynamicGroup.children.length > 0) {
            select.appendChild(dynamicGroup);
        }
    }

    if (selectedValue && !renderedValues.has(selectedValue)) {
        const currentGroup = document.createElement('optgroup');
        currentGroup.label = t`Current`;
        currentGroup.setAttribute('data-sb-model-id-generated', 'true');
        appendModelIdSearchOption(currentGroup, optionMap.get(selectedValue) || { value: selectedValue, text: selectedValue }, renderedValues);
        select.appendChild(currentGroup);
    }

    if (select.options.length === 0) {
        const emptyOption = new Option(t`No matching models`, '');
        emptyOption.disabled = true;
        emptyOption.setAttribute('data-sb-model-id-generated', 'true');
        select.appendChild(emptyOption);
    }

    if (selectedValue && select.querySelector(`option[value="${CSS.escape(selectedValue)}"]`)) {
        select.value = selectedValue;
    }

    if (!preserveQuery) {
        input.value = selectedValue;
    }

    rebuildModelIdSearchDatalist(control, optionMap, favoriteOptions, query);
    updateModelIdSearchFavoriteButton(control);
}

function getModelIdSearchControlBySource(source) {
    return MODEL_ID_SEARCH_CONTROLS.find(control => control.source === source);
}

function refreshModelIdSearchControlsForSource(source = oai_settings.chat_completion_source) {
    const control = getModelIdSearchControlBySource(source);
    if (control) {
        rebuildModelIdSearchControl(control);
    }
}

function updateModelIdSearchFavoriteButton(control) {
    const input = document.querySelector(control.input);
    const select = document.querySelector(control.select);
    const button = document.querySelector(`[data-sb-model-id-favorite-source="${CSS.escape(control.source)}"]`);

    if (!(input instanceof HTMLInputElement) || !(select instanceof HTMLSelectElement) || !(button instanceof HTMLButtonElement)) {
        return;
    }

    const modelId = normalizeModelIdSearchValue(input.value || oai_settings[control.setting] || '');
    const isFavorite = modelId.length > 0 && getModelFavoritesForSource(control.source).includes(modelId);
    const title = modelId.length === 0
        ? t`Enter a model first`
        : isFavorite
            ? t`Remove current model from favorites`
            : t`Add current model to favorites`;

    button.disabled = modelId.length === 0;
    button.title = title;
    button.setAttribute('aria-label', title);
    button.setAttribute('aria-pressed', String(isFavorite));
    button.classList.toggle('is-favorite', isFavorite);
}

function updateModelIdSearchFavoriteButtons() {
    MODEL_ID_SEARCH_CONTROLS.forEach(updateModelIdSearchFavoriteButton);
}

function toggleModelIdSearchFavorite(control) {
    const input = document.querySelector(control.input);
    const select = document.querySelector(control.select);

    if (!(input instanceof HTMLInputElement) || !(select instanceof HTMLSelectElement)) {
        return;
    }

    const modelId = normalizeModelIdSearchValue(input.value || oai_settings[control.setting] || '');
    if (!modelId) {
        return;
    }

    const favorites = [...getModelFavoritesForSource(control.source)];
    const favoriteIndex = favorites.indexOf(modelId);

    if (favoriteIndex >= 0) {
        favorites.splice(favoriteIndex, 1);
    } else {
        favorites.unshift(modelId);
    }

    oai_settings[control.setting] = modelId;
    input.value = modelId;
    setModelFavoritesForSource(control.source, favorites);
    getModelIdSearchState(control.source).query = '';
    rebuildModelIdSearchControl(control);
    saveSettingsDebounced();
}

function ensureModelIdSearchFavoriteButton(control) {
    const input = document.querySelector(control.input);
    if (!(input instanceof HTMLInputElement) || !(input.parentElement instanceof HTMLElement)) {
        return;
    }

    const row = input.parentElement;
    row.classList.add('sb-model-id-search-row');
    input.classList.add('sb-model-id-search-input');

    let button = row.querySelector(`[data-sb-model-id-favorite-source="${CSS.escape(control.source)}"]`);
    if (button instanceof HTMLButtonElement) {
        setModelIdPickerTouchTarget(button);
        return;
    }

    button = document.createElement('button');
    button.type = 'button';
    button.className = 'menu_button menu_button_icon sb-model-id-favorite-toggle';
    button.dataset.sbModelIdFavoriteSource = control.source;
    button.innerHTML = '<i class="fa-solid fa-star" aria-hidden="true"></i>';
    button.addEventListener('click', () => toggleModelIdSearchFavorite(control));

    const pickerButton = row.querySelector(`[data-sb-model-id-picker-source="${CSS.escape(control.source)}"]`);
    if (pickerButton instanceof HTMLButtonElement) {
        pickerButton.insertAdjacentElement('afterend', button);
    } else {
        input.insertAdjacentElement('afterend', button);
    }
    setModelIdPickerTouchTarget(button);
}

function openModelIdSearchSelect(control) {
    const input = document.querySelector(control.input);
    const select = document.querySelector(control.select);

    if (!(input instanceof HTMLInputElement) || !(select instanceof HTMLSelectElement)) {
        return;
    }

    getModelIdSearchState(control.source).query = '';
    rebuildModelIdSearchControl(control);
    openModelSelectPicker(select, { input, source: control.source });
}

function ensureModelIdSearchPickerButton(control) {
    const input = document.querySelector(control.input);
    const select = document.querySelector(control.select);

    if (!(input instanceof HTMLInputElement) || !(select instanceof HTMLSelectElement) || !(input.parentElement instanceof HTMLElement)) {
        return;
    }

    const row = input.parentElement;
    row.classList.add('sb-model-id-search-row');
    input.classList.add('sb-model-id-search-input');

    let button = row.querySelector(`[data-sb-model-id-picker-source="${CSS.escape(control.source)}"]`);
    if (!(button instanceof HTMLButtonElement)) {
        button = document.createElement('button');
        button.type = 'button';
        button.className = 'menu_button menu_button_icon sb-model-id-picker-toggle';
        button.dataset.sbModelIdPickerSource = control.source;
        button.innerHTML = '<i class="fa-solid fa-list-ul" aria-hidden="true"></i>';
        button.addEventListener('click', () => openModelIdSearchSelect(control));
        input.insertAdjacentElement('afterend', button);
    }

    button.title = t`Open model list`;
    button.setAttribute('aria-label', t`Open model list`);
    button.disabled = select.disabled || select.options.length === 0;
    setModelIdPickerTouchTarget(button);
}

function initModelIdSearchControl(control) {
    const input = document.querySelector(control.input);
    const select = document.querySelector(control.select);

    if (!(input instanceof HTMLInputElement) || !(select instanceof HTMLSelectElement)) {
        return;
    }

    getModelIdSearchStaticEntries(control);
    ensureModelIdSearchPickerButton(control);
    ensureModelIdSearchFavoriteButton(control);

    if (input.dataset.sbModelIdSearchBound !== 'true') {
        input.addEventListener('input', () => {
            const state = getModelIdSearchState(control.source);
            state.query = input.value;
            rebuildModelIdSearchControl(control, { preserveQuery: true });
        });
        input.addEventListener('focus', () => {
            const state = getModelIdSearchState(control.source);
            state.query = input.value;
            rebuildModelIdSearchControl(control, { preserveQuery: true });
        });
        input.addEventListener('blur', () => {
            window.setTimeout(() => {
                if (document.activeElement !== input && document.activeElement !== select) {
                    getModelIdSearchState(control.source).query = '';
                    rebuildModelIdSearchControl(control);
                }
            }, 160);
        });
        input.dataset.sbModelIdSearchBound = 'true';
    }

    if (select.dataset.sbModelIdSearchBound !== 'true') {
        select.addEventListener('change', () => {
            window.setTimeout(() => {
                getModelIdSearchState(control.source).query = '';
                rebuildModelIdSearchControl(control);
            }, 0);
        });
        select.dataset.sbModelIdSearchBound = 'true';
    }

    rebuildModelIdSearchControl(control);
}

function initModelIdSearchControls() {
    MODEL_ID_SEARCH_CONTROLS.forEach(initModelIdSearchControl);
}

function getOpenAISettingsDrawerStateKey(drawerId) {
    return `${OPENAI_SETTINGS_DRAWER_STATE_KEY_PREFIX}${drawerId}`;
}

function getStoredOpenAISettingsDrawerExpanded(drawerId) {
    if (!drawerId) {
        return null;
    }

    const storedValue = accountStorage.getItem(getOpenAISettingsDrawerStateKey(drawerId));
    if (storedValue === null) {
        return null;
    }

    return storedValue === 'true';
}

function setStoredOpenAISettingsDrawerExpanded(drawerId, expanded) {
    if (!drawerId) {
        return;
    }

    accountStorage.setItem(getOpenAISettingsDrawerStateKey(drawerId), String(Boolean(expanded)));
}

function applyOpenAISettingsDrawerExpandedState($drawer, expanded) {
    const drawer = $drawer.get(0);
    if (!(drawer instanceof HTMLElement)) {
        return;
    }

    const icon = drawer.querySelector(':scope > .inline-drawer-header .inline-drawer-icon');
    const content = drawer.querySelector(':scope > .inline-drawer-content');
    if (!(icon instanceof HTMLElement) || !(content instanceof HTMLElement)) {
        return;
    }

    if (expanded) {
        icon.classList.remove('down', 'fa-circle-chevron-down');
        icon.classList.add('up', 'fa-circle-chevron-up');
        content.style.display = 'block';

        if (!CSS.supports('field-sizing', 'content')) {
            content.querySelectorAll('textarea.autoSetHeight').forEach(resetScrollHeight);
        }
    } else {
        icon.classList.remove('up', 'fa-circle-chevron-up');
        icon.classList.add('down', 'fa-circle-chevron-down');
        content.style.display = 'none';
    }
}

function bindOpenAISettingsDrawerPersistence($drawer) {
    const drawerId = String($drawer.attr('id') || '').trim();
    if (!drawerId || $drawer.data('sbDrawerPersistenceBound')) {
        return;
    }

    $drawer.data('sbDrawerPersistenceBound', true);

    const expanded = getStoredOpenAISettingsDrawerExpanded(drawerId);
    if (expanded !== null) {
        applyOpenAISettingsDrawerExpandedState($drawer, expanded);
    }

    $drawer.on('inline-drawer-toggle', function () {
        const icon = this.querySelector(':scope > .inline-drawer-header .inline-drawer-icon');
        if (!(icon instanceof HTMLElement)) {
            return;
        }

        setStoredOpenAISettingsDrawerExpanded(drawerId, icon.classList.contains('up'));
    });
}

function createOpenAISettingsDrawer(id, title, description) {
    const $drawer = $('<div>', {
        id,
        class: 'inline-drawer wide100p flexFlowColumn sb-openai-settings-drawer',
    });
    const $header = $('<div>', { class: 'inline-drawer-toggle inline-drawer-header' });
    const $title = $('<b>').text(title);
    const $label = $('<div>', { class: 'flex-container flexFlowColumn' })
        .append($title);

    if (id === 'sb-openai-sampling') {
        const $helpLink = $('<a>', {
            class: 'notes-link sb-sampling-docs-link',
            href: 'https://docs.sillytavern.app/usage/common-settings/',
            target: '_blank',
            title: 'Documentation on sampling parameters.',
            'data-i18n': '[title]Documentation on sampling parameters',
        }).append($('<span>', {
            name: 'samplerHelpButton',
            class: 'note-link-span fa-solid fa-circle-question',
        }));

        $helpLink.on('click', event => event.stopPropagation());
        $label.empty().append($('<div>', { class: 'sb-sampling-title-row' }).append($title, $helpLink));
    }

    if (description) {
        $label.append($('<small>', { class: 'sb-group-meta' }).text(description));
    }

    $header.append($label);
    $header.append($('<div>', { class: 'fa-solid fa-circle-chevron-down inline-drawer-icon down' }));
    $drawer.append($header);
    $drawer.append($('<div>', { class: 'inline-drawer-content', style: 'display:none' }));
    bindOpenAISettingsDrawerPersistence($drawer);

    return $drawer;
}

function groupOpenAISettingsIntoDrawers() {
    const $rangeBlock = $('#range_block_openai');

    if ($rangeBlock.length === 0 || $rangeBlock.data('sb-grouped')) {
        return;
    }

    const groupConfigs = [
        {
            id: 'sb-openai-budget',
            title: 'Token Budget',
            description: 'Context, response limits, swipes, and costs',
            selectors: [
                '#range_block_openai > .range-block:has(#openai_max_context)',
                '#range_block_openai > .range-block:has(#openai_max_tokens)',
                '#range_block_openai > .range-block:has(#n_openai)',
                '#range_block_openai > .range-block:has(#openrouter_middleout)',
                '#range_block_openai > div:has(#openrouter_max_prompt_cost)',
                '#range_block_openai > div:has(#electronhub_max_prompt_cost)',
                '#range_block_openai > div:has(#chutes_max_prompt_cost)',
            ],
        },
        {
            id: 'sb-openai-sampling',
            title: 'Sampling',
            description: 'Temperature, penalties, probability controls, seed, and logit bias',
            selectors: [
                '#range_block_openai > .flex-container.gap10h5v.justifyCenter:has([data-tg-samplers])',
                '#range_block_openai > .range-block:has(#temp_openai)',
                '#range_block_openai > .range-block:has(#claude_disable_temperature)',
                '#range_block_openai > .range-block:has(#freq_pen_openai)',
                '#range_block_openai > .range-block:has(#pres_pen_openai)',
                '#range_block_openai > .range-block:has(#top_k_openai)',
                '#range_block_openai > .range-block:has(#top_p_openai)',
                '#range_block_openai > .range-block:has(#claude_disable_top_p)',
                '#range_block_openai > .range-block:has(#repetition_penalty_openai)',
                '#range_block_openai > .range-block:has(#min_p_openai)',
                '#range_block_openai > .range-block:has(#top_a_openai)',
                '#range_block_openai > .range-block:has(#seed_openai)',
                '#openai_settings > .range-block:has(#openai_logit_bias_preset)',
            ],
        },
        {
            id: 'sb-openai-output',
            title: 'Output',
            description: 'Streaming, prompt templates, names, and continue behavior',
            selectors: [
                '#range_block_openai > .range-block:has(#stream_toggle)',
                '#range_block_openai > .inline-drawer:has(#main_prompt_quick_edit_textarea)',
                '#range_block_openai > .inline-drawer:has(#impersonation_prompt_textarea)',
                '#openai_settings > div > .inline-drawer:has(#character_names_none)',
                '#openai_settings > div > .inline-drawer:has(#continue_postfix_none)',
                '#openai_settings > div > .range-block:has(#continue_prefill)',
                '#openai_settings > div > .range-block:has(#squash_system_messages)',
                '#openai_settings > div > .range-block:has(#use_sysprompt)',
            ],
        },
        {
            id: 'sb-openai-advanced',
            title: 'Advanced & Reasoning',
            description: 'Tools, media, reasoning, and server config',
            selectors: [
                '#openai_settings > div > .range-block:has(#openai_enable_web_search)',
                '#openai_settings > div > .range-block:has(#openai_function_calling)',
                '#openai_settings > div > .range-block:has(#tool_reasoning_mode)',
                '#openai_settings > div > .range-block:has(#openai_media_inlining)',
                '#openai_settings > div > #request_images_block',
                '#openai_settings > div > .range-block:has(#openai_show_thoughts)',
                '#openai_settings > div > .range-block:has(#openai_auto_append_reasoning_tags)',
                '#openai_settings > div > .flex-container:has(#openai_reasoning_effort)',
                '#openai_settings > div > .range-block:has(#openai_reasoning_tag_style)',
                '#openai_settings > div > .flex-container:has(#openai_verbosity)',
                '#openai_settings > div > .range-block:has(#claude_assistant_prefill)',
            ],
        },
        {
            id: 'sb-openai-prompt-manager',
            title: 'Prompt Manager',
            description: 'Inspect, reorder, toggle, and edit injected prompts',
            selectors: [
                '#openai_settings > div > .range-block:has(#completion_prompt_manager)',
            ],
        },
    ];

    const groupedBlocks = groupConfigs.map(config => ({
        ...config,
        blocks: config.selectors
            .map(selector => {
                const $block = $(selector).first();

                if ($block.length > 0) {
                    // Preserve direct event bindings while moving the settings blocks into drawers.
                    $block.detach();
                }

                return $block;
            })
            .filter($block => $block.length > 0),
    }));

    $rangeBlock.empty();

    groupedBlocks.forEach(group => {
        const $drawer = createOpenAISettingsDrawer(group.id, group.title, group.description);
        const $content = $drawer.children('.inline-drawer-content');

        group.blocks.forEach($block => $content.append($block));
        $rangeBlock.append($drawer);
    });

    $rangeBlock.data('sb-grouped', true);
    updateOpenAISettingsGroupVisibility();
}

function updateOpenAISettingsGroupVisibility() {
    $('#range_block_openai .sb-openai-settings-drawer').each(function () {
        const blocks = $(this).children('.inline-drawer-content').children().toArray();
        const hasVisibleContent = blocks.some(block => {
            if (!(block instanceof HTMLElement) || getComputedStyle(block).display === 'none') {
                return false;
            }

            if (block.hasAttribute('data-source')) {
                return true;
            }

            const sourceChildren = Array.from(block.querySelectorAll('[data-source]'));
            if (sourceChildren.length > 0) {
                return sourceChildren.some(child => child instanceof HTMLElement && getComputedStyle(child).display !== 'none');
            }

            return true;
        });
        $(this).toggle(hasVisibleContent);
    });
}

function updateServerChatCompletionConfigSourceVisibility() {
    const currentSource = oai_settings.chat_completion_source;

    $('#sb-chat-completion-server-config-drawer, #sb-chat-completion-server-config, #sb-chat-completion-server-config-drawer [data-source], #sb-chat-completion-server-config [data-source]').each(function () {
        const mode = $(this).data('source-mode');
        const sourceValue = $(this).data('source');

        if (!sourceValue) {
            return;
        }

        const validSources = String(sourceValue).split(',');
        const matchesSource = validSources.includes(currentSource);
        $(this).toggle(mode !== 'except' ? matchesSource : !matchesSource);
    });
}

function cloneServerChatCompletionConfig(settings) {
    return JSON.parse(JSON.stringify(settings));
}

function normalizeServerChatCompletionConfig(settings) {
    const normalizedClaudeCachingDepth = Number.parseInt(String(settings?.claude?.cachingAtDepth ?? SERVER_CHAT_COMPLETION_CONFIG_DEFAULTS.claude.cachingAtDepth), 10);

    return {
        claude: {
            enableSystemPromptCache: Boolean(settings?.claude?.enableSystemPromptCache ?? SERVER_CHAT_COMPLETION_CONFIG_DEFAULTS.claude.enableSystemPromptCache),
            cachingAtDepth: Number.isFinite(normalizedClaudeCachingDepth) ? normalizedClaudeCachingDepth : SERVER_CHAT_COMPLETION_CONFIG_DEFAULTS.claude.cachingAtDepth,
            extendedTTL: Boolean(settings?.claude?.extendedTTL ?? SERVER_CHAT_COMPLETION_CONFIG_DEFAULTS.claude.extendedTTL),
            enableAdaptiveThinking: Boolean(settings?.claude?.enableAdaptiveThinking ?? SERVER_CHAT_COMPLETION_CONFIG_DEFAULTS.claude.enableAdaptiveThinking),
        },
        gemini: {
            apiVersion: String(settings?.gemini?.apiVersion || SERVER_CHAT_COMPLETION_CONFIG_DEFAULTS.gemini.apiVersion).trim() || SERVER_CHAT_COMPLETION_CONFIG_DEFAULTS.gemini.apiVersion,
            thoughtSignatures: Boolean(settings?.gemini?.thoughtSignatures ?? SERVER_CHAT_COMPLETION_CONFIG_DEFAULTS.gemini.thoughtSignatures),
            enableSystemPromptCache: Boolean(settings?.gemini?.enableSystemPromptCache ?? SERVER_CHAT_COMPLETION_CONFIG_DEFAULTS.gemini.enableSystemPromptCache),
        },
    };
}

function getServerChatCompletionConfigRefs() {
    return {
        root: document.getElementById('sb-chat-completion-server-config'),
        state: document.getElementById('sb-chat-completion-config-state'),
        status: document.getElementById('sb-chat-completion-config-status'),
        reloadButton: document.getElementById('sb-chat-completion-config-reload'),
        saveButton: document.getElementById('sb-chat-completion-config-save'),
        saveRestartButton: document.getElementById('sb-chat-completion-config-save-restart'),
        claudeSystemPromptCache: document.getElementById('sb-config-claude-system-prompt-cache'),
        claudeCachingDepth: document.getElementById('sb-config-claude-caching-depth'),
        claudeExtendedTtl: document.getElementById('sb-config-claude-extended-ttl'),
        claudeAdaptiveThinking: document.getElementById('sb-config-claude-adaptive-thinking'),
        geminiApiVersion: document.getElementById('sb-config-gemini-api-version'),
        geminiThoughtSignatures: document.getElementById('sb-config-gemini-thought-signatures'),
        geminiSystemPromptCache: document.getElementById('sb-config-gemini-system-prompt-cache'),
    };
}

async function requestServerChatCompletionConfig(endpoint, body = {}) {
    const response = await fetch(endpoint, {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify(body),
    });

    const text = await response.text();
    let data = {};

    try {
        data = text ? JSON.parse(text) : {};
    } catch {
        data = { message: text };
    }

    if (!response.ok) {
        throw new Error(data?.error || data?.message || text || `Request failed with status ${response.status}.`);
    }

    return data;
}

function setServerChatCompletionConfigMessage(message = '') {
    const refs = getServerChatCompletionConfigRefs();

    if (!(refs.status instanceof HTMLElement)) {
        return;
    }

    refs.status.textContent = String(message ?? '').trim();
    refs.status.hidden = !refs.status.textContent;
}

function collectServerChatCompletionConfigForm() {
    const refs = getServerChatCompletionConfigRefs();

    return normalizeServerChatCompletionConfig({
        claude: {
            enableSystemPromptCache: refs.claudeSystemPromptCache instanceof HTMLInputElement ? refs.claudeSystemPromptCache.checked : false,
            cachingAtDepth: refs.claudeCachingDepth instanceof HTMLInputElement ? refs.claudeCachingDepth.value : SERVER_CHAT_COMPLETION_CONFIG_DEFAULTS.claude.cachingAtDepth,
            extendedTTL: refs.claudeExtendedTtl instanceof HTMLInputElement ? refs.claudeExtendedTtl.checked : false,
            enableAdaptiveThinking: refs.claudeAdaptiveThinking instanceof HTMLInputElement ? refs.claudeAdaptiveThinking.checked : SERVER_CHAT_COMPLETION_CONFIG_DEFAULTS.claude.enableAdaptiveThinking,
        },
        gemini: {
            apiVersion: refs.geminiApiVersion instanceof HTMLInputElement ? refs.geminiApiVersion.value : SERVER_CHAT_COMPLETION_CONFIG_DEFAULTS.gemini.apiVersion,
            thoughtSignatures: refs.geminiThoughtSignatures instanceof HTMLInputElement ? refs.geminiThoughtSignatures.checked : SERVER_CHAT_COMPLETION_CONFIG_DEFAULTS.gemini.thoughtSignatures,
            enableSystemPromptCache: refs.geminiSystemPromptCache instanceof HTMLInputElement ? refs.geminiSystemPromptCache.checked : SERVER_CHAT_COMPLETION_CONFIG_DEFAULTS.gemini.enableSystemPromptCache,
        },
    });
}

function fillServerChatCompletionConfigForm(settings) {
    const refs = getServerChatCompletionConfigRefs();
    const normalizedSettings = normalizeServerChatCompletionConfig(settings);

    if (refs.claudeSystemPromptCache instanceof HTMLInputElement) {
        refs.claudeSystemPromptCache.checked = normalizedSettings.claude.enableSystemPromptCache;
    }

    if (refs.claudeCachingDepth instanceof HTMLInputElement) {
        refs.claudeCachingDepth.value = String(normalizedSettings.claude.cachingAtDepth);
    }

    if (refs.claudeExtendedTtl instanceof HTMLInputElement) {
        refs.claudeExtendedTtl.checked = normalizedSettings.claude.extendedTTL;
    }

    if (refs.claudeAdaptiveThinking instanceof HTMLInputElement) {
        refs.claudeAdaptiveThinking.checked = normalizedSettings.claude.enableAdaptiveThinking;
    }

    if (refs.geminiApiVersion instanceof HTMLInputElement) {
        refs.geminiApiVersion.value = normalizedSettings.gemini.apiVersion;
    }

    if (refs.geminiThoughtSignatures instanceof HTMLInputElement) {
        refs.geminiThoughtSignatures.checked = normalizedSettings.gemini.thoughtSignatures;
    }

    if (refs.geminiSystemPromptCache instanceof HTMLInputElement) {
        refs.geminiSystemPromptCache.checked = normalizedSettings.gemini.enableSystemPromptCache;
    }

    serverChatCompletionConfigState.originalSettings = cloneServerChatCompletionConfig(normalizedSettings);
    updateServerChatCompletionConfigDirtyState();
}

function updateServerChatCompletionConfigDirtyState() {
    const refs = getServerChatCompletionConfigRefs();

    if (!(refs.state instanceof HTMLElement)) {
        return false;
    }

    const isDirty = JSON.stringify(collectServerChatCompletionConfigForm()) !== JSON.stringify(serverChatCompletionConfigState.originalSettings);
    refs.state.textContent = isDirty ? 'Unsaved changes' : 'Saved';
    refs.state.dataset.state = isDirty ? 'dirty' : 'saved';
    return isDirty;
}

function updateServerChatCompletionConfigInteractivity() {
    const refs = getServerChatCompletionConfigRefs();
    const locked = serverChatCompletionConfigState.busy || serverChatCompletionConfigState.restarting;

    [
        refs.claudeSystemPromptCache,
        refs.claudeCachingDepth,
        refs.claudeExtendedTtl,
        refs.claudeAdaptiveThinking,
        refs.geminiApiVersion,
        refs.geminiThoughtSignatures,
        refs.geminiSystemPromptCache,
        refs.reloadButton,
        refs.saveButton,
        refs.saveRestartButton,
    ].forEach(element => {
        if (element instanceof HTMLInputElement || element instanceof HTMLButtonElement) {
            element.disabled = locked;
        }
    });
}

async function waitForServerChatCompletionConfigRestart() {
    let sawOffline = false;
    const timeoutAt = Date.now() + 180000;

    while (Date.now() < timeoutAt) {
        try {
            const response = await fetch('/version', { cache: 'no-store' });

            if (!response.ok) {
                throw new Error('Server is not ready yet.');
            }

            if (sawOffline) {
                location.reload();
                return true;
            }
        } catch {
            sawOffline = true;
        }

        await delay(1500);
    }

    return false;
}

async function loadServerChatCompletionConfig({ force = false } = {}) {
    const refs = getServerChatCompletionConfigRefs();

    if (!(refs.root instanceof HTMLElement) || serverChatCompletionConfigState.busy || serverChatCompletionConfigState.restarting) {
        return;
    }

    serverChatCompletionConfigState.busy = true;
    updateServerChatCompletionConfigInteractivity();
    setServerChatCompletionConfigMessage('Loading server config values…');

    try {
        const result = await requestServerChatCompletionConfig('/api/server-admin/config/chat-completions/get');
        const nextSettings = normalizeServerChatCompletionConfig(result?.settings);
        const hasDraft = serverChatCompletionConfigState.loaded && updateServerChatCompletionConfigDirtyState();

        if (!hasDraft || force) {
            fillServerChatCompletionConfigForm(nextSettings);
            setServerChatCompletionConfigMessage('Restart required after saving these server-side settings.');
        } else {
            serverChatCompletionConfigState.lastModifiedMs = Number(result?.lastModifiedMs ?? serverChatCompletionConfigState.lastModifiedMs) || 0;
            setServerChatCompletionConfigMessage('config.yaml changed on disk, but your unsaved Presets draft was kept.');
        }

        serverChatCompletionConfigState.lastModifiedMs = Number(result?.lastModifiedMs ?? 0) || 0;
        serverChatCompletionConfigState.loaded = true;
    } catch (error) {
        console.error('Failed to load chat completion server config.', error);
        setServerChatCompletionConfigMessage(error.message || 'Failed to load chat completion server config.');
    } finally {
        serverChatCompletionConfigState.busy = false;
        updateServerChatCompletionConfigInteractivity();
    }
}

async function saveServerChatCompletionConfig({ restart = false } = {}) {
    if (serverChatCompletionConfigState.busy || serverChatCompletionConfigState.restarting) {
        return;
    }

    serverChatCompletionConfigState.busy = true;
    updateServerChatCompletionConfigInteractivity();
    setServerChatCompletionConfigMessage(restart ? 'Saving server config and preparing restart…' : 'Saving server config…');

    try {
        const result = await requestServerChatCompletionConfig('/api/server-admin/config/chat-completions/save', {
            expectedLastModifiedMs: serverChatCompletionConfigState.lastModifiedMs,
            restart,
            settings: collectServerChatCompletionConfigForm(),
        });

        fillServerChatCompletionConfigForm(result?.settings);
        serverChatCompletionConfigState.lastModifiedMs = Number(result?.lastModifiedMs ?? 0) || serverChatCompletionConfigState.lastModifiedMs;
        setServerChatCompletionConfigMessage(result?.message || 'Chat completion server config saved.');
        toastr.success(result?.message || 'Chat completion server config saved.', 'Server config');

        if (restart) {
            serverChatCompletionConfigState.busy = false;
            serverChatCompletionConfigState.restarting = true;
            updateServerChatCompletionConfigInteractivity();

            const restarted = await waitForServerChatCompletionConfigRestart();
            if (!restarted) {
                serverChatCompletionConfigState.restarting = false;
                setServerChatCompletionConfigMessage('Restart is taking longer than expected. Refresh the page once the server is back.');
                toastr.warning('Restart is taking longer than expected. Refresh manually once the server is back.', 'Restart pending');
            }
        }
    } catch (error) {
        console.error('Failed to save chat completion server config.', error);
        setServerChatCompletionConfigMessage(error.message || 'Failed to save chat completion server config.');
        toastr.error(error.message || 'Failed to save chat completion server config.', 'Server config');
    } finally {
        if (!serverChatCompletionConfigState.restarting) {
            serverChatCompletionConfigState.busy = false;
            updateServerChatCompletionConfigInteractivity();
        }
    }
}

function buildServerChatCompletionConfigCard({ nested = false } = {}) {
    const headerLead = nested
        ? `
            <div class="sb-chat-completion-config-inline-copy">
                <strong>Claude & Gemini flags</strong>
                <small>These values are saved into <code>config.yaml</code> and need a restart after saving.</small>
            </div>
        `
        : '<div class="range-block-title">Server Config (config.yaml)</div>';

    return $(`
        <div id="sb-chat-completion-server-config" class="range-block sb-chat-completion-server-config${nested ? ' is-nested' : ''}" data-source="claude,makersuite,vertexai">
            <div class="sb-chat-completion-config-header">
                ${headerLead}
                <span id="sb-chat-completion-config-state" class="sb-chat-completion-config-state">Loading…</span>
            </div>
            <div class="toggle-description justifyLeft">
                Mirror the Claude and Gemini <code>config.yaml</code> flags here so you can tweak them from Presets. These are server-side settings, so a restart is required after saving.
            </div>
            <div class="sb-chat-completion-config-grid">
                <section class="sb-chat-completion-config-section" data-source="claude">
                    <strong class="sb-chat-completion-config-title">Claude</strong>
                    <label class="checkbox_label widthFreeExpand" for="sb-config-claude-system-prompt-cache">
                        <input id="sb-config-claude-system-prompt-cache" type="checkbox">
                        <span>System prompt cache</span>
                    </label>
                    <label class="checkbox_label widthFreeExpand" for="sb-config-claude-extended-ttl">
                        <input id="sb-config-claude-extended-ttl" type="checkbox">
                        <span>Extended cache TTL</span>
                    </label>
                    <label class="checkbox_label widthFreeExpand" for="sb-config-claude-adaptive-thinking">
                        <input id="sb-config-claude-adaptive-thinking" type="checkbox">
                        <span>Adaptive thinking</span>
                    </label>
                    <label class="sb-chat-completion-config-field" for="sb-config-claude-caching-depth">
                        <span>Caching at depth</span>
                        <input id="sb-config-claude-caching-depth" class="text_pole" type="number" step="1" min="-1">
                    </label>
                    <div class="toggle-description justifyLeft">
                        Use <code>-1</code> to disable depth-based cache insertion.
                    </div>
                </section>
                <section class="sb-chat-completion-config-section" data-source="makersuite,vertexai">
                    <strong class="sb-chat-completion-config-title">Gemini</strong>
                    <label class="sb-chat-completion-config-field" for="sb-config-gemini-api-version">
                        <span>API version</span>
                        <input id="sb-config-gemini-api-version" class="text_pole" type="text" placeholder="v1beta">
                    </label>
                    <label class="checkbox_label widthFreeExpand" for="sb-config-gemini-thought-signatures">
                        <input id="sb-config-gemini-thought-signatures" type="checkbox">
                        <span>Thought signatures</span>
                    </label>
                    <label class="checkbox_label widthFreeExpand" for="sb-config-gemini-system-prompt-cache">
                        <input id="sb-config-gemini-system-prompt-cache" type="checkbox">
                        <span>System prompt cache</span>
                    </label>
                </section>
            </div>
            <div class="sb-chat-completion-config-actions">
                <button id="sb-chat-completion-config-reload" class="menu_button menu_button_icon" type="button">
                    <i class="fa-solid fa-rotate-right"></i>
                    <span>Reload</span>
                </button>
                <button id="sb-chat-completion-config-save" class="menu_button menu_button_icon" type="button">
                    <i class="fa-solid fa-floppy-disk"></i>
                    <span>Save server config</span>
                </button>
                <button id="sb-chat-completion-config-save-restart" class="menu_button menu_button_icon menu_button_primary" type="button">
                    <i class="fa-solid fa-power-off"></i>
                    <span>Save & Restart</span>
                </button>
            </div>
            <div id="sb-chat-completion-config-status" class="toggle-description justifyLeft sb-chat-completion-config-status">
                Restart required after saving these server-side settings.
            </div>
        </div>
    `);
}

function buildServerChatCompletionConfigDrawer() {
    const $drawer = createOpenAISettingsDrawer(
        'sb-chat-completion-server-config-drawer',
        'Server Config (config.yaml)',
        'Claude and Gemini server-side flags mirrored from config.yaml.',
    );

    $drawer
        .attr('data-source', 'claude,makersuite,vertexai')
        .addClass('sb-settings-subdrawer sb-openai-settings-subdrawer');

    $drawer.children('.inline-drawer-content')
        .addClass('sb-settings-subdrawer-body')
        .append(buildServerChatCompletionConfigCard({ nested: true }));

    return $drawer;
}

function injectServerChatCompletionConfigCard() {
    const $advancedDrawerContent = $('#sb-openai-advanced > .inline-drawer-content');

    if ($advancedDrawerContent.length === 0 || $('#sb-chat-completion-server-config, #sb-chat-completion-server-config-drawer').length) {
        return;
    }

    $advancedDrawerContent.append(buildServerChatCompletionConfigDrawer());

    document.getElementById('sb-chat-completion-config-reload')?.addEventListener('click', async () => {
        if (serverChatCompletionConfigState.loaded && updateServerChatCompletionConfigDirtyState()
            && !window.confirm('Discard your unsaved server config edits and reload from config.yaml?')) {
            return;
        }

        await loadServerChatCompletionConfig({ force: true });
    });
    document.getElementById('sb-chat-completion-config-save')?.addEventListener('click', () => void saveServerChatCompletionConfig({ restart: false }));
    document.getElementById('sb-chat-completion-config-save-restart')?.addEventListener('click', () => void saveServerChatCompletionConfig({ restart: true }));

    [
        'sb-config-claude-system-prompt-cache',
        'sb-config-claude-caching-depth',
        'sb-config-claude-extended-ttl',
        'sb-config-claude-adaptive-thinking',
        'sb-config-gemini-api-version',
        'sb-config-gemini-thought-signatures',
        'sb-config-gemini-system-prompt-cache',
    ].forEach(id => {
        document.getElementById(id)?.addEventListener('input', () => {
            updateServerChatCompletionConfigDirtyState();
        });
    });

    updateServerChatCompletionConfigInteractivity();
    updateServerChatCompletionConfigSourceVisibility();
    void loadServerChatCompletionConfig({ force: true });
}

function scheduleOpenAIUiRefresh() {
    window.requestAnimationFrame(() => {
        updateAdvancedFormattingVisibility();
        updateServerChatCompletionConfigSourceVisibility();
        updateOpenAISettingsGroupVisibility();
        updateOpenAIModelFavoriteButton();
        bindInlineSelectPickerControls();
    });

    window.setTimeout(() => {
        updateAdvancedFormattingVisibility();
        updateServerChatCompletionConfigSourceVisibility();
        updateOpenAISettingsGroupVisibility();
        updateOpenAIModelFavoriteButton();
        bindInlineSelectPickerControls();
    }, 200);
}

function getOpenRouterModelTemplate(option) {
    const model = model_list.find(x => x.id === option?.element?.value);

    if (!option.id || !model) {
        return option.text;
    }

    let tokens_dollar = Number(1 / (1000 * model.pricing?.prompt));
    let tokens_rounded = (Math.round(tokens_dollar * 1000) / 1000).toFixed(0);

    const price = 0 === Number(model.pricing?.prompt) ? 'Free' : `${tokens_rounded}k t/$ `;

    return $((`
        <div class="flex-container flexFlowColumn" title="${DOMPurify.sanitize(model.id)}">
            <div><strong>${DOMPurify.sanitize(model.name)}</strong> | ${model.context_length} ctx | <small>${price}</small></div>
        </div>
    `));
}

function calculateOpenRouterCost() {
    if (oai_settings.chat_completion_source !== chat_completion_sources.OPENROUTER) {
        return;
    }

    let cost = 'Unknown';
    const model = model_list.find(x => x.id === oai_settings.openrouter_model);

    if (model?.pricing) {
        const completionCost = Number(model.pricing.completion);
        const promptCost = Number(model.pricing.prompt);
        const completionTokens = oai_settings.openai_max_tokens;
        const promptTokens = (oai_settings.openai_max_context - completionTokens);
        const totalCost = (completionCost * completionTokens) + (promptCost * promptTokens);
        if (!isNaN(totalCost)) {
            cost = '$' + totalCost.toFixed(3);
        }
    }

    if (oai_settings.enable_web_search) {
        const webSearchCost = (0.02).toFixed(2);
        cost = t`${cost} + $${webSearchCost}`;
    }

    $('#openrouter_max_prompt_cost').text(cost);
}

function getElectronHubModelTemplate(option) {
    const model = model_list.find(x => x.id === option?.element?.value);

    if (!option.id || !model) {
        return option.text;
    }

    const inputPrice = model.pricing?.input;
    const outputPrice = model.pricing?.output;
    const price = inputPrice && outputPrice ? `$${inputPrice}/$${outputPrice} in/out Mtoken` : 'Unknown';

    const visionIcon = model.metadata?.vision ? '<i class="fa-solid fa-eye fa-sm" title="This model supports vision"></i>' : '';
    const reasoningIcon = model.metadata?.reasoning ? '<i class="fa-solid fa-brain fa-sm" title="This model supports reasoning"></i>' : '';
    const toolCallsIcon = model.metadata?.function_call ? '<i class="fa-solid fa-wrench fa-sm" title="This model supports function tools"></i>' : '';
    const premiumIcon = model?.premium_model ? '<i class="fa-solid fa-crown fa-sm" title="This model requires a subscription"></i>' : '';

    const iconsContainer = document.createElement('span');
    iconsContainer.insertAdjacentHTML('beforeend', visionIcon);
    iconsContainer.insertAdjacentHTML('beforeend', reasoningIcon);
    iconsContainer.insertAdjacentHTML('beforeend', toolCallsIcon);
    iconsContainer.insertAdjacentHTML('beforeend', premiumIcon);

    const capabilities = (iconsContainer.children.length) ? ` | ${iconsContainer.innerHTML}` : '';

    return $((`
        <div class="flex-container alignItemsBaseline" title="${DOMPurify.sanitize(model.id)}">
            <strong>${DOMPurify.sanitize(model.name)}</strong> | ${model.tokens} ctx | <small>${price}</small>${capabilities}
        </div>
    `));
}

function calculateElectronHubCost() {
    if (oai_settings.chat_completion_source !== chat_completion_sources.ELECTRONHUB) {
        return;
    }

    let cost = 'Unknown';
    const model = model_list.find(x => x.id === oai_settings.electronhub_model);

    if (model?.pricing) {
        const outputCost = Number(model.pricing.output / 1000000);
        const inputCost = Number(model.pricing.input / 1000000);
        const outputTokens = oai_settings.openai_max_tokens;
        const inputTokens = (oai_settings.openai_max_context - outputTokens);
        const totalCost = (outputCost * outputTokens) + (inputCost * inputTokens);
        if (!isNaN(totalCost)) {
            cost = '$' + totalCost.toFixed(4);
        }
    }

    $('#electronhub_max_prompt_cost').text(cost);
}

function getChutesModelTemplate(option) {
    const model = model_list.find(x => x.id === option?.element?.value);

    if (!option.id || !model) {
        return option.text;
    }

    const inputPrice = model.pricing?.input;
    const outputPrice = model.pricing?.output;

    let price = 'Unknown';
    if (inputPrice !== undefined && outputPrice !== undefined) {
        // Check if both prices are 0 (free model)
        if (inputPrice === 0 && outputPrice === 0) {
            price = 'Free';
        } else {
            price = `$${inputPrice}/$${outputPrice} in/out Mtoken`;
        }
    }

    const contextLength = model.context_length || model.max_model_len || 'Unknown';
    const visionIcon = model.input_modalities?.includes('image') ? '<i class="fa-solid fa-eye fa-sm" title="This model supports vision"></i>' : '';
    const reasoningIcon = model.supported_features?.includes('reasoning') ? '<i class="fa-solid fa-brain fa-sm" title="This model supports reasoning"></i>' : '';
    const toolCallsIcon = model.supported_features?.includes('structured_outputs') ? '<i class="fa-solid fa-wrench fa-sm" title="This model supports function tools"></i>' : '';

    const iconsContainer = document.createElement('span');
    iconsContainer.insertAdjacentHTML('beforeend', visionIcon);
    iconsContainer.insertAdjacentHTML('beforeend', reasoningIcon);
    iconsContainer.insertAdjacentHTML('beforeend', toolCallsIcon);

    const capabilities = (iconsContainer.children.length) ? ` | ${iconsContainer.innerHTML}` : '';

    return $((`
        <div class="flex-container alignItemsBaseline" title="${DOMPurify.sanitize(model.id)}">
            <strong>${DOMPurify.sanitize(model.id)}</strong> | ${contextLength} ctx | <small>${price}</small>${capabilities}
        </div>
    `));
}

function getNanoGptModelTemplate(option) {
    const model = model_list.find(x => x.id === option?.element?.value);

    if (!option.id || !model) {
        return option.text;
    }

    const inputPrice = model.pricing?.prompt;
    const outputPrice = model.pricing?.completion;

    let price = 'Unknown';
    if (inputPrice !== undefined && outputPrice !== undefined) {
        // Check if both prices are 0 (free model)
        if (inputPrice === 0 && outputPrice === 0) {
            price = 'Free';
        } else {
            price = `$${Math.round(inputPrice * 100) / 100}/$${Math.round(outputPrice * 100) / 100} in/out Mtoken`;
        }
    }

    const contextLength = model.context_length || 'Unknown';

    return $((`
        <div class="flex-container alignItemsBaseline" title="${DOMPurify.sanitize(model.id)}">
            <strong>${DOMPurify.sanitize(model.id)}</strong> | ${contextLength} ctx | <small>${price}</small>
        </div>
    `));
}

function calculateChutesCost() {
    if (oai_settings.chat_completion_source !== chat_completion_sources.CHUTES) {
        return;
    }

    let cost = 'Unknown';
    const model = model_list.find(x => x.id === oai_settings.chutes_model);

    if (model?.pricing) {
        const outputPrice = model.pricing?.output;
        const inputPrice = model.pricing?.input;

        if (outputPrice !== undefined && inputPrice !== undefined) {
            const outputCost = Number(outputPrice / 1000000);
            const inputCost = Number(inputPrice / 1000000);
            const outputTokens = oai_settings.openai_max_tokens;
            const inputTokens = (oai_settings.openai_max_context - outputTokens);
            const totalCost = (outputCost * outputTokens) + (inputCost * inputTokens);
            if (!isNaN(totalCost)) {
                cost = '$' + totalCost.toFixed(4);
            }
        }
    }

    $('#chutes_max_prompt_cost').text(cost);
}

function saveModelList(data) {
    model_list = data.map((model) => ({ ...model }));
    model_list.sort((a, b) => a?.id && b?.id && a.id.localeCompare(b.id));

    if (oai_settings.chat_completion_source == chat_completion_sources.OPENROUTER) {
        model_list = openRouterSortBy(model_list, oai_settings.openrouter_sort_models);

        $('#model_openrouter_select').empty();

        if (true === oai_settings.openrouter_group_models) {
            appendOpenRouterOptions(openRouterGroupByVendor(model_list), oai_settings.openrouter_group_models);
        } else {
            appendOpenRouterOptions(model_list);
        }

        $('#model_openrouter_select').val(oai_settings.openrouter_model).trigger('change');
    }

    if ([chat_completion_sources.OPENAI, chat_completion_sources.OPENAI_RESPONSES].includes(oai_settings.chat_completion_source)) {
        rebuildOpenAIModelSelect();
        const selectedModel = $('#model_openai_select').find(`option[value="${CSS.escape(oai_settings.openai_model)}"]`).length > 0
            ? oai_settings.openai_model
            : String($('#model_openai_select').val() || default_settings.openai_model);

        if (selectedModel) {
            $('#model_openai_select').val(selectedModel).trigger('change');
        }
    }

    if (oai_settings.chat_completion_source == chat_completion_sources.CUSTOM) {
        $('.model_custom_select').empty();
        $('.model_custom_select').append('<option value="">None</option>');
        model_list.forEach((model) => {
            $('.model_custom_select').append(
                $('<option>', {
                    value: model.id,
                    text: model.id,
                    selected: model.id == oai_settings.custom_model,
                }));
        });

        if (!oai_settings.custom_model && model_list.length > 0) {
            $('#model_custom_select').val(model_list[0].id).trigger('change');
        }
    }

    if (oai_settings.chat_completion_source == chat_completion_sources.AIMLAPI) {
        $('#model_aimlapi_select').empty();
        const chatModels = model_list.filter(m => m.type === 'chat-completion');

        appendAimlapiOptions(aimlapiGroupByVendor(chatModels));

        if (!oai_settings.aimlapi_model && chatModels.length > 0) {
            oai_settings.aimlapi_model = chatModels[0].id;
        }

        $('#model_aimlapi_select').val(oai_settings.aimlapi_model).trigger('change');
    }

    if (oai_settings.chat_completion_source == chat_completion_sources.MISTRALAI) {
        $('#model_mistralai_select').empty();

        for (const model of model_list.filter(model => model?.capabilities?.completion_chat)) {
            $('#model_mistralai_select').append(new Option(model.id, model.id));
        }

        const selectedModel = model_list.find(model => model.id === oai_settings.mistralai_model);
        if (!selectedModel) {
            oai_settings.mistralai_model = model_list.find(model => model?.capabilities?.completion_chat)?.id;
        }

        $('#model_mistralai_select').val(oai_settings.mistralai_model).trigger('change');
    }

    if (oai_settings.chat_completion_source == chat_completion_sources.ELECTRONHUB) {
        model_list = model_list.filter(model => model?.endpoints?.includes('/v1/chat/completions'));

        model_list = electronHubSortBy(model_list, oai_settings.electronhub_sort_models);

        $('#model_electronhub_select').empty();

        const groupedList = oai_settings.electronhub_group_models ? electronHubGroupByVendor(model_list) : model_list;
        appendElectronHubOptions(groupedList, oai_settings.electronhub_group_models);

        const selectedModel = model_list.find(model => model.id === oai_settings.electronhub_model);
        if (model_list.length > 0 && (!selectedModel || !oai_settings.electronhub_model)) {
            oai_settings.electronhub_model = model_list[0].id;
        }

        $('#model_electronhub_select').val(oai_settings.electronhub_model).trigger('change');
    }

    if (oai_settings.chat_completion_source == chat_completion_sources.CHUTES) {
        model_list = model_list.filter(model => typeof model.id === 'string' && !model.id.toLowerCase().includes('affine'));

        model_list = chutesSortBy(model_list, oai_settings.chutes_sort_models);

        $('#model_chutes_select').empty();

        for (const model of model_list) {
            const option = $('<option>').val(model.id).text(model.id);
            option.attr('data-model', JSON.stringify(model));
            $('#model_chutes_select').append(option);
        }

        const selectedModel = model_list.find(model => model.id === oai_settings.chutes_model);
        if (model_list.length > 0 && (!selectedModel || !oai_settings.chutes_model)) {
            oai_settings.chutes_model = model_list[0].id;
        }

        $('#model_chutes_select').val(oai_settings.chutes_model).trigger('change');
    }

    if (oai_settings.chat_completion_source == chat_completion_sources.NANOGPT) {
        $('#model_nanogpt_select').empty();
        model_list.forEach((model) => {
            $('#model_nanogpt_select').append(
                $('<option>', {
                    value: model.id,
                    text: model.id,
                }));
        });

        const selectedModel = model_list.find(model => model.id === oai_settings.nanogpt_model);
        if (model_list.length > 0 && (!selectedModel || !oai_settings.nanogpt_model)) {
            oai_settings.nanogpt_model = model_list[0].id;
        }

        $('#model_nanogpt_select').val(oai_settings.nanogpt_model).trigger('change');
    }

    if (oai_settings.chat_completion_source === chat_completion_sources.WORKERS_AI) {
        $('#model_workers_ai_select').empty();
        model_list.forEach((model) => {
            $('#model_workers_ai_select').append(
                $('<option>', {
                    value: model.id,
                    text: model.id,
                }));
        });

        const selectedModel = model_list.find(model => model.id === oai_settings.workers_ai_model);
        if (model_list.length > 0 && (!selectedModel || !oai_settings.workers_ai_model)) {
            oai_settings.workers_ai_model = model_list[0].id;
        }

        $('#model_workers_ai_select').val(oai_settings.workers_ai_model).trigger('change');
    }

    if (oai_settings.chat_completion_source == chat_completion_sources.DEEPSEEK) {
        $('#model_deepseek_select').empty();
        model_list.forEach((model) => {
            $('#model_deepseek_select').append(
                $('<option>', {
                    value: model.id,
                    text: model.id,
                }));
        });

        const selectedModel = model_list.find(model => model.id === oai_settings.deepseek_model);
        if (model_list.length > 0 && (!selectedModel || !oai_settings.deepseek_model)) {
            oai_settings.deepseek_model = model_list[0].id;
        }

        $('#model_deepseek_select').val(oai_settings.deepseek_model).trigger('change');
    }

    if (oai_settings.chat_completion_source === chat_completion_sources.POLLINATIONS) {
        $('#model_pollinations_select').empty();
        model_list.forEach((model) => {
            $('#model_pollinations_select').append(
                $('<option>', {
                    value: model.id,
                    text: model.id,
                }));
        });

        const selectedModel = model_list.find(model => model.id === oai_settings.pollinations_model);
        if (model_list.length > 0 && (!selectedModel || !oai_settings.pollinations_model)) {
            oai_settings.pollinations_model = model_list[0].id;
        }

        $('#model_pollinations_select').val(oai_settings.pollinations_model).trigger('change');
    }

    if (oai_settings.chat_completion_source === chat_completion_sources.MAKERSUITE) {
        // Clear only the "Other" optgroup for dynamic models
        $('#google_other_models').empty();

        // Get static model options that are already in the HTML
        const staticModels = [];
        $('#model_google_select option').each(function () {
            staticModels.push($(this).val());
        });

        // Add dynamic models to the "Other" group
        model_list.forEach((model) => {
            // Only add if not already in static list
            if (!staticModels.includes(model.id)) {
                $('#google_other_models').append(
                    $('<option>', {
                        value: model.id,
                        text: model.id,
                    }));
            }
        });

        // Merge static models into model_list
        staticModels.forEach(modelId => {
            if (!model_list.some(model => model.id === modelId)) {
                model_list.push({ id: modelId });
            }
        });

        if (model_list.length > 0 && !oai_settings.google_model) {
            oai_settings.google_model = model_list[0].id;
        }

        if (oai_settings.google_model && $('#model_google_select').find(`option[value="${CSS.escape(oai_settings.google_model)}"]`).length === 0) {
            $('#google_other_models').append(
                $('<option>', {
                    value: oai_settings.google_model,
                    text: oai_settings.google_model,
                }),
            );
        }

        $('#model_google_select').val(oai_settings.google_model).trigger('change');
        $('#makersuite_model_id').val(oai_settings.google_model);
    }

    if (oai_settings.chat_completion_source === chat_completion_sources.GROQ) {
        $('#model_groq_select').empty();
        model_list.forEach((model) => {
            $('#model_groq_select').append(
                $('<option>', {
                    value: model.id,
                    text: model.id,
                }));
        });

        const selectedModel = model_list.find(model => model.id === oai_settings.groq_model);
        if (model_list.length > 0 && (!selectedModel || !oai_settings.groq_model)) {
            oai_settings.groq_model = model_list[0].id;
        }

        $('#model_groq_select').val(oai_settings.groq_model).trigger('change');
    }

    if (oai_settings.chat_completion_source === chat_completion_sources.SILICONFLOW) {
        $('#model_siliconflow_select').empty();
        model_list.forEach((model) => {
            $('#model_siliconflow_select').append(
                $('<option>', {
                    value: model.id,
                    text: model.id,
                }));
        });

        const selectedModel = model_list.find(model => model.id === oai_settings.siliconflow_model);
        if (model_list.length > 0 && (!selectedModel || !oai_settings.siliconflow_model)) {
            oai_settings.siliconflow_model = model_list[0].id;
        }

        $('#model_siliconflow_select').val(oai_settings.siliconflow_model).trigger('change');
    }

    if (oai_settings.chat_completion_source === chat_completion_sources.FIREWORKS) {
        $('#model_fireworks_select').empty();
        model_list.forEach((model) => {
            if (!model?.supports_chat) {
                return;
            }
            $('#model_fireworks_select').append(
                $('<option>', {
                    value: model.id,
                    text: model.id,
                }));
        });

        const selectedModel = model_list.find(model => model.id === oai_settings.fireworks_model);
        if (model_list.length > 0 && (!selectedModel || !oai_settings.fireworks_model)) {
            oai_settings.fireworks_model = model_list[0].id;
        }

        $('#model_fireworks_select').val(oai_settings.fireworks_model).trigger('change');
    }

    if (oai_settings.chat_completion_source === chat_completion_sources.COMETAPI) {
        $('#model_cometapi_select').empty();

        model_list.forEach((model) => {
            const modelId = model.id.toLowerCase();
            const isIgnoredModel = COMETAPI_IGNORE_PATTERNS.some(pattern => modelId.includes(pattern));

            if (isIgnoredModel) {
                return;
            }

            $('#model_cometapi_select').append(new Option(model.id, model.id));
        });

        const selectedModel = model_list.find(model => model.id === oai_settings.cometapi_model);
        if (model_list.length > 0 && (!selectedModel || !oai_settings.cometapi_model)) {
            oai_settings.cometapi_model = model_list[0].id;
            saveSettingsDebounced();
        }

        $('#model_cometapi_select').val(oai_settings.cometapi_model).trigger('change');
    }

    if (oai_settings.chat_completion_source == chat_completion_sources.AZURE_OPENAI) {
        const modelId = model_list?.[0]?.id || '';
        oai_settings.azure_openai_model = modelId;

        $('#azure_openai_model')
            .empty()
            .append(new Option(modelId || 'None', modelId || '', true, true))
            .trigger('change');
    }

    if (oai_settings.chat_completion_source == chat_completion_sources.XAI) {
        $('#model_xai_select').empty();
        model_list.forEach((model) => {
            $('#model_xai_select').append(
                $('<option>', {
                    value: model.id,
                    text: model.id,
                }));
        });

        const selectedModel = model_list.find(model => model.id === oai_settings.xai_model);
        if (model_list.length > 0 && (!selectedModel || !oai_settings.xai_model)) {
            oai_settings.xai_model = model_list[0].id;
        }

        $('#model_xai_select').val(oai_settings.xai_model).trigger('change');
    }

    if (oai_settings.chat_completion_source == chat_completion_sources.MOONSHOT) {
        $('#model_moonshot_select').empty();
        model_list.forEach((model) => {
            $('#model_moonshot_select').append(new Option(model.id, model.id));
        });

        const selectedModel = model_list.find(model => model.id === oai_settings.moonshot_model);
        if (model_list.length > 0 && (!selectedModel || !oai_settings.moonshot_model)) {
            oai_settings.moonshot_model = model_list[0].id;
        }

        $('#model_moonshot_select').val(oai_settings.moonshot_model).trigger('change');
    }

    // Claude - hybrid approach: keep static optgroups, add dynamic to "Other" optgroup
    if (oai_settings.chat_completion_source == chat_completion_sources.CLAUDE) {
        // Clear only dynamic models from "Other" optgroup
        $('#claude_other_models').empty();

        // Get static model option values to avoid duplicates
        const staticClaudeModels = [];
        $('#model_claude_select option').each(function () {
            staticClaudeModels.push($(this).val());
        });

        // Add dynamic models not already in static list
        model_list.forEach((model) => {
            if (!staticClaudeModels.includes(model.id)) {
                $('#claude_other_models').append(
                    $('<option>', { value: model.id, text: model.id }),
                );
            }
        });

        // If no models loaded, static list remains as fallback
        if (model_list.length > 0) {
            const selectedModel = [...staticClaudeModels, ...model_list.map(m => m.id)].includes(oai_settings.claude_model)
                ? oai_settings.claude_model
                : model_list[0]?.id || oai_settings.claude_model;
            $('#model_claude_select').val(selectedModel).trigger('change');
            $('#claude_model_id').val(selectedModel);
        }
    }

    // AI21 - hybrid approach
    if (oai_settings.chat_completion_source == chat_completion_sources.AI21) {
        $('#ai21_other_models').empty();
        const staticAI21Models = [];
        $('#model_ai21_select option').each(function () {
            staticAI21Models.push($(this).val());
        });
        model_list.forEach((model) => {
            if (!staticAI21Models.includes(model.id)) {
                $('#ai21_other_models').append(
                    $('<option>', { value: model.id, text: model.id }),
                );
            }
        });
        if (model_list.length > 0) {
            const selectedModel = [...staticAI21Models, ...model_list.map(m => m.id)].includes(oai_settings.ai21_model)
                ? oai_settings.ai21_model
                : model_list[0]?.id || oai_settings.ai21_model;
            $('#model_ai21_select').val(selectedModel).trigger('change');
            $('#ai21_model_id').val(selectedModel);
        }
    }

    // Cohere - hybrid approach
    if (oai_settings.chat_completion_source == chat_completion_sources.COHERE) {
        $('#cohere_other_models').empty();
        const staticCohereModels = [];
        $('#model_cohere_select option').each(function () {
            staticCohereModels.push($(this).val());
        });
        model_list.forEach((model) => {
            if (!staticCohereModels.includes(model.id)) {
                $('#cohere_other_models').append(
                    $('<option>', { value: model.id, text: model.id }),
                );
            }
        });
        if (model_list.length > 0) {
            const selectedModel = [...staticCohereModels, ...model_list.map(m => m.id)].includes(oai_settings.cohere_model)
                ? oai_settings.cohere_model
                : model_list[0]?.id || oai_settings.cohere_model;
            $('#model_cohere_select').val(selectedModel).trigger('change');
            $('#cohere_model_id').val(selectedModel);
        }
    }

    // Perplexity - hybrid approach
    if (oai_settings.chat_completion_source == chat_completion_sources.PERPLEXITY) {
        $('#perplexity_other_models').empty();
        const staticPerplexityModels = [];
        $('#model_perplexity_select option').each(function () {
            staticPerplexityModels.push($(this).val());
        });
        model_list.forEach((model) => {
            if (!staticPerplexityModels.includes(model.id)) {
                $('#perplexity_other_models').append(
                    $('<option>', { value: model.id, text: model.id }),
                );
            }
        });
        if (model_list.length > 0) {
            const selectedModel = [...staticPerplexityModels, ...model_list.map(m => m.id)].includes(oai_settings.perplexity_model)
                ? oai_settings.perplexity_model
                : model_list[0]?.id || oai_settings.perplexity_model;
            $('#model_perplexity_select').val(selectedModel).trigger('change');
            $('#perplexity_model_id').val(selectedModel);
        }
    }

    // ZAI - hybrid approach
    if (oai_settings.chat_completion_source == chat_completion_sources.ZAI) {
        $('#zai_other_models').empty();
        const staticZAIModels = [];
        $('#model_zai_select option').each(function () {
            staticZAIModels.push($(this).val());
        });
        model_list.forEach((model) => {
            if (!staticZAIModels.includes(model.id)) {
                $('#zai_other_models').append(
                    $('<option>', { value: model.id, text: model.id }),
                );
            }
        });
        if (model_list.length > 0) {
            const selectedModel = [...staticZAIModels, ...model_list.map(m => m.id)].includes(oai_settings.zai_model)
                ? oai_settings.zai_model
                : model_list[0]?.id || oai_settings.zai_model;
            $('#model_zai_select').val(selectedModel).trigger('change');
            $('#zai_model_id').val(selectedModel);
        }
    }

    // VertexAI - hybrid approach: keep static optgroups, add dynamic to "From API" optgroup
    if (oai_settings.chat_completion_source === chat_completion_sources.VERTEXAI) {
        // Clear only dynamic models from "From API" optgroup
        $('#vertexai_other_models').empty();

        // Get static model option values to avoid duplicates
        const staticVertexAIModels = [];
        $('#model_vertexai_select option').each(function () {
            staticVertexAIModels.push($(this).val());
        });

        // Add dynamic models not already in static list
        model_list.forEach((model) => {
            if (!staticVertexAIModels.includes(model.id)) {
                $('#vertexai_other_models').append(
                    $('<option>', { value: model.id, text: model.id }),
                );
            }
        });

        // Merge static models into model_list for selection
        staticVertexAIModels.forEach(modelId => {
            if (!model_list.some(model => model.id === modelId)) {
                model_list.push({ id: modelId });
            }
        });

        if (model_list.length > 0) {
            const selectedModel = [...staticVertexAIModels, ...model_list.map(m => m.id)].includes(oai_settings.vertexai_model)
                ? oai_settings.vertexai_model
                : model_list[0]?.id || oai_settings.vertexai_model;
            $('#model_vertexai_select').val(selectedModel).trigger('change');
            $('#vertexai_model_id').val(selectedModel);
        }
    }

    refreshModelIdSearchControlsForSource(oai_settings.chat_completion_source);
}

function appendOpenRouterOptions(model_list, groupModels = false, sort = false) {
    $('#model_openrouter_select').append($('<option>', { value: openrouter_website_model, text: t`Use OpenRouter website setting` }));

    const appendOption = (model, parent = null) => {
        (parent || $('#model_openrouter_select')).append(
            $('<option>', {
                value: model.id,
                text: model.name,
            }));
    };

    if (groupModels) {
        model_list.forEach((models, vendor) => {
            const optgroup = $(`<optgroup label="${vendor}">`);

            models.forEach((model) => {
                appendOption(model, optgroup);
            });

            $('#model_openrouter_select').append(optgroup);
        });
    } else {
        model_list.forEach((model) => {
            appendOption(model);
        });
    }
}

const openRouterSortBy = (data, property = 'alphabetically') => {
    return data.sort((a, b) => {
        if (property === 'context_length') {
            return b.context_length - a.context_length;
        } else if (property === 'pricing.prompt') {
            return parseFloat(a.pricing.prompt) - parseFloat(b.pricing.prompt);
        } else {
            // Alphabetically
            return a?.name && b?.name && a.name.localeCompare(b.name);
        }
    });
};

function openRouterGroupByVendor(array) {
    return array.reduce((acc, curr) => {
        const vendor = curr.id.split('/')[0];

        if (!acc.has(vendor)) {
            acc.set(vendor, []);
        }

        acc.get(vendor).push(curr);

        return acc;
    }, new Map());
}

function chutesSortBy(data, property = 'alphabetically') {
    return data.sort((a, b) => {
        if (property === 'context_length') {
            return b.context_length - a.context_length;
        } else if (property === 'pricing.input') {
            const aPrice = parseFloat(a.pricing?.input || 0);
            const bPrice = parseFloat(b.pricing?.input || 0);
            return aPrice - bPrice;
        } else if (property === 'pricing.output') {
            const aPrice = parseFloat(a.pricing?.output || 0);
            const bPrice = parseFloat(b.pricing?.output || 0);
            return aPrice - bPrice;
        } else {
            return a?.id && b?.id && a.id.localeCompare(b.id);
        }
    });
}

function appendElectronHubOptions(model_list, groupModels = false) {
    const appendOption = (model, parent = null) => {
        (parent || $('#model_electronhub_select')).append(
            $('<option>', {
                value: model.id,
                text: model.name,
            }));
    };

    if (groupModels) {
        model_list.forEach((models, vendor) => {
            const optgroup = $('<optgroup>').attr('label', vendor);

            models.forEach((model) => {
                appendOption(model, optgroup);
            });

            $('#model_electronhub_select').append(optgroup);
        });
    } else {
        model_list.forEach((model) => {
            appendOption(model);
        });
    }
}

function electronHubSortBy(data, property = 'alphabetically') {
    return data.sort((a, b) => {
        if (property === 'context_length') {
            return b.tokens - a.tokens;
        } else if (property === 'pricing.input') {
            return parseFloat(a.pricing.input) - parseFloat(b.pricing.input);
        } else if (property === 'pricing.output') {
            return parseFloat(a.pricing.output) - parseFloat(b.pricing.output);
        } else {
            return a?.name && b?.name && a.name.localeCompare(b.name);
        }
    });
}

function electronHubGroupByVendor(array) {
    return array.reduce((acc, curr) => {
        const vendor = String(curr?.name || curr?.id || 'Other').split(':')[0].trim() || 'Other';

        if (!acc.has(vendor)) {
            acc.set(vendor, []);
        }

        acc.get(vendor).push(curr);

        return acc;
    }, new Map());
}

function aimlapiGroupByVendor(array) {
    return array.reduce((acc, curr) => {
        const vendor = curr.info.developer;

        if (!acc.has(vendor)) {
            acc.set(vendor, []);
        }

        acc.get(vendor).push(curr);

        return acc;
    }, new Map());
}

function appendAimlapiOptions(model_list) {
    const appendOption = (model, parent = null) => {
        (parent || $('#model_aimlapi_select')).append(
            $('<option>', {
                value: model.id,
                text: model.info?.name || model.name || model.id,
            }));
    };

    model_list.forEach((models, vendor) => {
        const optgroup = $(`<optgroup label="${vendor}">`);

        models.forEach((model) => {
            appendOption(model, optgroup);
        });

        $('#model_aimlapi_select').append(optgroup);
    });
}

function getAimlapiModelTemplate(option) {
    const model = model_list.find(x => x.id === option?.element?.value);

    if (!option.id || !model) {
        return option.text;
    }

    const vendor = model.id.split('/')[0];

    return $((`
        <div class="flex-container flexFlowColumn" title="${DOMPurify.sanitize(model.id)}">
            <div><strong>${DOMPurify.sanitize(model.info?.name || model.name || model.id)}</strong> | ${vendor}</div>
        </div>
    `));
}

/**
 * Get the reasoning effort from chat completion settings
 * @param {ChatCompletionSettings} settings Chat completion settings
 * @param {string} model Model name (optional, used for ElectronHub)
 * @returns {string} Reasoning effort, if present
 */
function getReasoningEffort(settings = null, model = null) {
    settings = settings ?? oai_settings;
    model = model ?? getChatCompletionModel(settings);

    // These sources expect the effort as string.
    const reasoningEffortSources = [
        chat_completion_sources.OPENAI,
        chat_completion_sources.OPENAI_RESPONSES,
        chat_completion_sources.AZURE_OPENAI,
        chat_completion_sources.CUSTOM,
        chat_completion_sources.XAI,
        chat_completion_sources.AIMLAPI,
        chat_completion_sources.OPENROUTER,
        chat_completion_sources.POLLINATIONS,
        chat_completion_sources.PERPLEXITY,
        chat_completion_sources.COMETAPI,
        chat_completion_sources.ELECTRONHUB,
        chat_completion_sources.CHUTES,
    ];

    if (!reasoningEffortSources.includes(settings.chat_completion_source)) {
        return settings.reasoning_effort;
    }

    function resolveReasoningEffort() {
        switch (settings.reasoning_effort) {
            case reasoning_effort_types.none:
                return undefined;
            case reasoning_effort_types.min:
                if (chat_completion_sources.OPENROUTER === settings.chat_completion_source && !shouldRequestReasoning(settings)) {
                    return 'none';
                }

                return [chat_completion_sources.OPENAI, chat_completion_sources.OPENAI_RESPONSES, chat_completion_sources.AZURE_OPENAI].includes(settings.chat_completion_source) && /^gpt-5/.test(model)
                    ? reasoning_effort_types.min
                    : reasoning_effort_types.low;
            case reasoning_effort_types.max: {
                // xhigh is supported on OpenAI models after gpt-5.1-codex-max and on xAI grok-4.20-multi-agent
                const xhighOpenAI = [chat_completion_sources.OPENAI, chat_completion_sources.OPENAI_RESPONSES, chat_completion_sources.AZURE_OPENAI].includes(settings.chat_completion_source)
                    && /^gpt-5\.([2-9]|\d{2,})/.test(model);
                const xhighXAI = settings.chat_completion_source === chat_completion_sources.XAI
                    && model.includes('grok-4.20-multi-agent');
                return (xhighOpenAI || xhighXAI) ? reasoning_effort_types.xhigh : reasoning_effort_types.high;
            }
            default:
                return settings.reasoning_effort;
        }
    }

    const reasoningEffort = resolveReasoningEffort();

    // Check if the resolved effort supported by the model
    if (settings.chat_completion_source === chat_completion_sources.ELECTRONHUB) {
        if (Array.isArray(model_list) && reasoningEffort) {
            const currentModel = model_list.find(m => m.id === model);
            const supportedEfforts = currentModel?.metadata?.supported_reasoning_efforts;
            if (Array.isArray(supportedEfforts) && supportedEfforts.includes(reasoningEffort)) {
                return reasoningEffort;
            }
            return undefined;
        }
    }

    return reasoningEffort;
}

/**
 * Get the verbosity from chat completion settings
 * @param {ChatCompletionSettings} settings Chat completion settings
 * @returns {string} Verbosity level, if present
 */
function getVerbosity(settings = null) {
    settings = settings ?? oai_settings;

    if (settings.verbosity === verbosity_levels.auto) {
        return undefined;
    }

    // TODO: Adjust verbosity based on model capabilities
    return settings.verbosity;
}

/**
 * Build the generation parameter object for an OAI request.
 * @param {ChatCompletionSettings} settings Initial chat completion settings
 * @param {string} model Model name
 * @param {string} type Request type (impersonate, quiet, continue, etc)
 * @param {ChatCompletionMessage[]} messages Array of chat completion messages
 * @param {import('../script.js').AdditionalRequestOptions} options Additional request options
 * @returns {Promise<object>} Final generation parameters object appropriate for the chat completion source
 */
export async function createGenerationParameters(settings, model, type, messages, { jsonSchema = null, cacheScope = null } = {}) {
    // HACK: Filter out null and non-object messages
    if (!Array.isArray(messages)) {
        throw new Error('messages must be an array');
    }
    messages = messages.filter(msg => msg && typeof msg === 'object');
    messages = appendAutoAppendReasoningInstruction(messages, settings, model, type);

    // "OpenAI-like" sources
    const gptSources = [
        chat_completion_sources.OPENAI,
        chat_completion_sources.OPENAI_RESPONSES,
        chat_completion_sources.AZURE_OPENAI,
        chat_completion_sources.OPENROUTER,
    ];

    // Sources that support the "seed" parameter
    const seedSupportedSources = [
        chat_completion_sources.OPENAI,
        chat_completion_sources.OPENAI_RESPONSES,
        chat_completion_sources.AZURE_OPENAI,
        chat_completion_sources.OPENROUTER,
        chat_completion_sources.MISTRALAI,
        chat_completion_sources.CUSTOM,
        chat_completion_sources.COHERE,
        chat_completion_sources.GROQ,
        chat_completion_sources.ELECTRONHUB,
        chat_completion_sources.NANOGPT,
        chat_completion_sources.XAI,
        chat_completion_sources.POLLINATIONS,
        chat_completion_sources.AIMLAPI,
        chat_completion_sources.VERTEXAI,
        chat_completion_sources.MAKERSUITE,
        chat_completion_sources.CHUTES,
    ];

    // Sources that support logprobs
    const logprobsSupportedSources = [
        chat_completion_sources.OPENAI,
        chat_completion_sources.AZURE_OPENAI,
        chat_completion_sources.CUSTOM,
        chat_completion_sources.DEEPSEEK,
        chat_completion_sources.XAI,
        chat_completion_sources.AIMLAPI,
        chat_completion_sources.CHUTES,
    ];

    // Sources that support logit bias
    const logitBiasSources = [
        chat_completion_sources.OPENAI,
        chat_completion_sources.AZURE_OPENAI,
        chat_completion_sources.OPENROUTER,
        chat_completion_sources.ELECTRONHUB,
        chat_completion_sources.CHUTES,
        chat_completion_sources.CUSTOM,
    ];

    // Sources that support "n" parameter for multi-swipe
    const multiswipeSources = [
        chat_completion_sources.OPENAI,
        chat_completion_sources.AZURE_OPENAI,
        chat_completion_sources.CUSTOM,
        chat_completion_sources.XAI,
        chat_completion_sources.AIMLAPI,
        chat_completion_sources.MOONSHOT,
    ];

    const isO1 = gptSources.includes(settings.chat_completion_source) && ['o1-2024-12-17', 'o1'].includes(model);
    const isWorkersAIJsonMode = settings.chat_completion_source === chat_completion_sources.WORKERS_AI && jsonSchema;
    const stream = settings.stream_openai && type !== 'quiet' && !isO1 && !isWorkersAIJsonMode;

    const noMultiSwipeTypes = ['quiet', 'impersonate', 'continue'];
    const canMultiSwipe = settings.n > 1 && !noMultiSwipeTypes.includes(type) && multiswipeSources.includes(settings.chat_completion_source);

    let logit_bias = {};
    if (settings.bias_preset_selected
        && logitBiasSources.includes(settings.chat_completion_source)
        && Array.isArray(settings.bias_presets[settings.bias_preset_selected])
        && settings.bias_presets[settings.bias_preset_selected].length) {
        logit_bias = biasCache || await calculateLogitBias();
        biasCache = logit_bias;
    }

    if (Object.keys(logit_bias).length === 0) {
        logit_bias = undefined;
    }

    const generate_data = {
        'type': type,
        'messages': messages,
        'log_prompts': Boolean(power_user.console_log_prompts),
        'model': model,
        'temperature': Number(settings.temp_openai),
        'frequency_penalty': Number(settings.freq_pen_openai),
        'presence_penalty': Number(settings.pres_pen_openai),
        'top_p': Number(settings.top_p_openai),
        'max_tokens': settings.openai_max_tokens,
        'stream': stream,
        'logit_bias': logit_bias,
        'stop': getCustomStoppingStrings(openai_max_stop_strings),
        'chat_completion_source': settings.chat_completion_source,
        'n': canMultiSwipe ? settings.n : undefined,
        'user_name': name1,
        'char_name': name2,
        'group_names': getGroupNames(),
        'include_reasoning': shouldRequestReasoning(settings),
        'reasoning_effort': getReasoningEffort(settings, model),
        'enable_web_search': Boolean(settings.enable_web_search),
        'request_images': Boolean(settings.request_images),
        'request_image_resolution': String(settings.request_image_resolution),
        'request_image_aspect_ratio': String(settings.request_image_aspect_ratio),
        'custom_prompt_post_processing': settings.custom_prompt_post_processing,
        'verbosity': getVerbosity(settings),
        'cacheScope': cacheScope ?? (type === 'quiet' ? 'auxiliary' : 'main'),
    };

    if (settings.chat_completion_source === chat_completion_sources.AZURE_OPENAI) {
        generate_data.azure_base_url = settings.azure_base_url;
        generate_data.azure_deployment_name = settings.azure_deployment_name;
        generate_data.azure_api_version = settings.azure_api_version;
        // Reasoning effort is not supported on some Azure models (e.g. GPT-3.x, GPT-4.x)
        if (/^gpt-[34]/.test(model)) {
            delete generate_data.reasoning_effort;
        }
    }

    if (!canMultiSwipe && ToolManager.canPerformToolCalls(type, settings, model)) {
        await ToolManager.registerFunctionToolsOpenAI(generate_data);
    }

    // Empty array will produce a validation error
    if (!Array.isArray(generate_data.stop) || !generate_data.stop.length) {
        delete generate_data.stop;
    }

    if (settings.reverse_proxy && REVERSE_PROXY_SUPPORTED_SOURCES.includes(settings.chat_completion_source)) {
        await validateReverseProxy();
        generate_data.reverse_proxy = settings.reverse_proxy;
        generate_data.proxy_password = settings.proxy_password;
    }

    // Add logprobs request (max 5 per OpenAI docs)
    const useLogprobs = !!power_user.request_token_probabilities;
    if (useLogprobs && logprobsSupportedSources.includes(settings.chat_completion_source)) {
        generate_data.logprobs = 5;
    }

    // Remove logit bias/logprobs/stop-strings if not supported by the model
    const isVision = (m) => ['gpt', 'vision'].every(x => typeof m === 'string' && m.includes(x));
    if (gptSources.includes(settings.chat_completion_source) && isVision(model)) {
        delete generate_data.logit_bias;
        delete generate_data.stop;
        delete generate_data.logprobs;
    }
    if (gptSources.includes(settings.chat_completion_source) && /gpt-4.5/.test(model)) {
        delete generate_data.logprobs;
    }

    if (settings.chat_completion_source === chat_completion_sources.CLAUDE) {
        generate_data.top_k = settings.top_k_openai > 0 ? Number(settings.top_k_openai) : undefined;
        generate_data.use_sysprompt = settings.use_sysprompt;
        generate_data.stop = getCustomStoppingStrings(); // Claude shouldn't have limits on stop strings.
        // Don't add a prefill on quiet gens (summarization) and when using continue prefill.
        if (type !== 'quiet' && !(type === 'continue' && settings.continue_prefill)) {
            generate_data.assistant_prefill = type === 'impersonate'
                ? getEffectiveAssistantImpersonationPrefill(settings)
                : substituteParams(settings.assistant_prefill);
        }
    }

    if (settings.chat_completion_source === chat_completion_sources.OPENROUTER) {
        generate_data.top_k = settings.top_k_openai > 0 ? Number(settings.top_k_openai) : undefined;
        generate_data.min_p = Number(settings.min_p_openai);
        generate_data.repetition_penalty = Number(settings.repetition_penalty_openai);
        generate_data.top_a = Number(settings.top_a_openai);
        generate_data.use_fallback = settings.openrouter_use_fallback;
        generate_data.provider = settings.openrouter_providers;
        generate_data.quantizations = settings.openrouter_quantizations;
        generate_data.allow_fallbacks = settings.openrouter_allow_fallbacks;
        generate_data.middleout = settings.openrouter_middleout;
    }

    if ([chat_completion_sources.MAKERSUITE, chat_completion_sources.VERTEXAI].includes(settings.chat_completion_source)) {
        const stopStringsLimit = 5;
        generate_data.top_k = settings.top_k_openai > 0 ? Number(settings.top_k_openai) : undefined;
        generate_data.stop = getCustomStoppingStrings(stopStringsLimit).slice(0, stopStringsLimit).filter(x => x.length >= 1 && x.length <= 16);
        generate_data.use_sysprompt = settings.use_sysprompt;
        if (settings.chat_completion_source === chat_completion_sources.VERTEXAI) {
            generate_data.vertexai_auth_mode = settings.vertexai_auth_mode;
            generate_data.vertexai_region = settings.vertexai_region;
            generate_data.vertexai_express_project_id = settings.vertexai_express_project_id;
        }
    }

    if (settings.chat_completion_source === chat_completion_sources.MISTRALAI) {
        generate_data.safe_prompt = false; // already defaults to false, but just incase they change that in the future.
        generate_data.stop = getCustomStoppingStrings(); // Mistral shouldn't have limits on stop strings.
    }

    if (settings.chat_completion_source === chat_completion_sources.CUSTOM) {
        generate_data.custom_url = settings.custom_url;
        generate_data.custom_include_body = settings.custom_include_body;
        generate_data.custom_exclude_body = settings.custom_exclude_body;
        generate_data.custom_include_headers = settings.custom_include_headers;
        generate_data.custom_reasoning_preset = settings.custom_reasoning_preset;
        generate_data.custom_reasoning_param_name = settings.custom_reasoning_param_name;
        generate_data.custom_reasoning_param_format = settings.custom_reasoning_param_format;
        generate_data.custom_reasoning_enabled_value = settings.custom_reasoning_enabled_value;
        generate_data.custom_reasoning_disabled_value = settings.custom_reasoning_disabled_value;
    }

    if (settings.chat_completion_source === chat_completion_sources.COHERE) {
        // Clamp to 0.01 -> 0.99
        generate_data.top_p = Math.min(Math.max(Number(settings.top_p_openai), 0.01), 0.99);
        generate_data.top_k = settings.top_k_openai > 0 ? Number(settings.top_k_openai) : undefined;
        // Clamp to 0 -> 1
        generate_data.frequency_penalty = Math.min(Math.max(Number(settings.freq_pen_openai), 0), 1);
        generate_data.presence_penalty = Math.min(Math.max(Number(settings.pres_pen_openai), 0), 1);
        generate_data.stop = getCustomStoppingStrings(5);
    }

    if (settings.chat_completion_source === chat_completion_sources.PERPLEXITY) {
        generate_data.top_k = settings.top_k_openai > 0 ? Number(settings.top_k_openai) : undefined;
        generate_data.frequency_penalty = Number(settings.freq_pen_openai);
        generate_data.presence_penalty = Number(settings.pres_pen_openai);
        delete generate_data.stop;
    }

    // https://console.groq.com/docs/openai
    if (settings.chat_completion_source === chat_completion_sources.GROQ) {
        delete generate_data.logprobs;
        delete generate_data.logit_bias;
        delete generate_data.top_logprobs;
        delete generate_data.n;
    }

    // https://api-docs.deepseek.com/api/create-chat-completion
    if (settings.chat_completion_source === chat_completion_sources.DEEPSEEK) {
        generate_data.top_p = generate_data.top_p || Number.EPSILON;
    }

    if (settings.chat_completion_source === chat_completion_sources.CLAUDE) {
        generate_data.claude_disable_temperature = Boolean(settings.claude_disable_temperature);
        generate_data.claude_disable_top_p = Boolean(settings.claude_disable_top_p);
    }

    if (settings.chat_completion_source === chat_completion_sources.XAI) {
        const xaiReasoningModels = ['grok-3-mini', 'grok-4.20-multi-agent'];
        if (!xaiReasoningModels.some(m => model.includes(m))) {
            delete generate_data.reasoning_effort;
        }

        if (model.includes('grok-3-mini')) {
            delete generate_data.presence_penalty;
            delete generate_data.frequency_penalty;
            delete generate_data.stop;
        }

        if (model.includes('grok-4') || model.includes('grok-code')) {
            delete generate_data.presence_penalty;
            delete generate_data.frequency_penalty;

            // grok-4-fast-non-reasoning accepts stop
            if (!model.includes('grok-4-fast-non-reasoning')) {
                delete generate_data.stop;
            }
        }
    }

    // https://docs.electronhub.ai/api-reference/chat/completions
    if (settings.chat_completion_source === chat_completion_sources.ELECTRONHUB) {
        generate_data.top_k = settings.top_k_openai > 0 ? Number(settings.top_k_openai) : undefined;
    }

    if (settings.chat_completion_source === chat_completion_sources.CHUTES) {
        generate_data.min_p = Number(settings.min_p_openai);
        generate_data.top_k = settings.top_k_openai > 0 ? Number(settings.top_k_openai) : undefined;
        generate_data.repetition_penalty = Number(settings.repetition_penalty_openai);
        generate_data.stop = getCustomStoppingStrings();
    }

    // https://docs.z.ai/api-reference/llm/chat-completion
    if (settings.chat_completion_source === chat_completion_sources.ZAI) {
        generate_data.top_p = generate_data.top_p || 0.01;
        generate_data.stop = getCustomStoppingStrings(1);
        generate_data.zai_endpoint = settings.zai_endpoint || ZAI_ENDPOINT.COMMON;
        delete generate_data.presence_penalty;
        delete generate_data.frequency_penalty;
    }

    if (settings.chat_completion_source === chat_completion_sources.SILICONFLOW) {
        generate_data.siliconflow_endpoint = settings.siliconflow_endpoint || SILICONFLOW_ENDPOINT.GLOBAL;
    }

    if (settings.chat_completion_source === chat_completion_sources.MINIMAX) {
        generate_data.minimax_endpoint = settings.minimax_endpoint || MINIMAX_ENDPOINT.GLOBAL;
        // MiniMax rejects zero temperature.
        if (Number.isFinite(generate_data.temperature)) {
            generate_data.temperature = Math.min(Math.max(generate_data.temperature, Number.EPSILON), 1.0);
        }
    }

    if (settings.chat_completion_source === chat_completion_sources.WORKERS_AI) {
        generate_data.workers_ai_account_id = settings.workers_ai_account_id;
        generate_data.top_k = settings.top_k_openai > 0 ? Math.min(Number(settings.top_k_openai), 50) : undefined;
        generate_data.repetition_penalty = Number(settings.repetition_penalty_openai);
        generate_data.seed = settings.seed >= 1 ? Number(settings.seed) : undefined;
        generate_data.top_p = Math.max(Number(settings.top_p_openai), 0.001);
        delete generate_data.n;
        delete generate_data.logit_bias;
    }

    // https://docs.nano-gpt.com/api-reference/endpoint/chat-completion#temperature-&-nucleus
    if (settings.chat_completion_source === chat_completion_sources.NANOGPT) {
        generate_data.top_k = settings.top_k_openai > 0 ? Number(settings.top_k_openai) : undefined;
        generate_data.min_p = Number(settings.min_p_openai);
        generate_data.repetition_penalty = Number(settings.repetition_penalty_openai);
        generate_data.top_a = Number(settings.top_a_openai);
    }

    // https://platform.moonshot.ai/docs/api/chat#public-service-address
    if (settings.chat_completion_source === chat_completion_sources.MOONSHOT) {
        // >Kimi API is fully compatible with OpenAI's API format
        if (/kimi-k2.5/.test(model)) {
            delete generate_data.temperature;
            delete generate_data.top_p;
            delete generate_data.frequency_penalty;
            delete generate_data.presence_penalty;
        }
    }

    if (seedSupportedSources.includes(settings.chat_completion_source) && settings.seed >= 0) {
        generate_data.seed = settings.seed;
    }

    if ([chat_completion_sources.OPENAI, chat_completion_sources.OPENAI_RESPONSES, chat_completion_sources.AZURE_OPENAI].includes(settings.chat_completion_source) && /^(o1|o3|o4)/.test(model) ||
        (chat_completion_sources.OPENROUTER === settings.chat_completion_source && /^openai\/(o1|o3|o4)/.test(model))) {
        generate_data.max_completion_tokens = generate_data.max_tokens;
        delete generate_data.max_tokens;
        delete generate_data.logprobs;
        delete generate_data.top_logprobs;
        delete generate_data.stop;
        delete generate_data.logit_bias;
        delete generate_data.temperature;
        delete generate_data.top_p;
        delete generate_data.frequency_penalty;
        delete generate_data.presence_penalty;
        if (/^(openai\/)?(o1)/.test(model)) {
            generate_data.messages.forEach((msg) => {
                if (msg.role === 'system') {
                    msg.role = 'user';
                }
            });
            delete generate_data.n;
            delete generate_data.tools;
            delete generate_data.tool_choice;
        }
    }

    if (gptSources.includes(settings.chat_completion_source) && /gpt-5/.test(model)) {
        generate_data.max_completion_tokens = generate_data.max_tokens;
        delete generate_data.max_tokens;
        delete generate_data.logprobs;
        delete generate_data.top_logprobs;
        if (/gpt-5-chat-latest/.test(model)) {
            delete generate_data.tools;
            delete generate_data.tool_choice;
        } else if (/gpt-5\.\d/.test(model) && !/chat-latest/.test(model)) {
            delete generate_data.frequency_penalty;
            delete generate_data.presence_penalty;
            delete generate_data.logit_bias;
            delete generate_data.stop;
        } else {
            delete generate_data.temperature;
            delete generate_data.top_p;
            delete generate_data.frequency_penalty;
            delete generate_data.presence_penalty;
            delete generate_data.logit_bias;
            delete generate_data.stop;
        }
    }

    // SillyBunny: Claude Fable models reject sampling parameters with HTTP 400, including via OpenAI-compatible proxies.
    // Substring match to also catch router ids like 'anthropic/claude-fable-5'.
    if (/claude-fable/.test(model)) {
        delete generate_data.temperature;
        delete generate_data.top_p;
        delete generate_data.top_k;
        delete generate_data.frequency_penalty;
        delete generate_data.presence_penalty;
        // Keep reasoning_effort for the native Claude source (the backend maps it to adaptive thinking);
        // strip it for proxies, which may translate it into a thinking budget that fable rejects.
        if (settings.chat_completion_source !== chat_completion_sources.CLAUDE) {
            delete generate_data.reasoning_effort;
            delete generate_data.custom_reasoning_param_name;
        }
    }

    if (jsonSchema) {
        generate_data.json_schema = jsonSchema;
    }

    return { generate_data, stream, canMultiSwipe };
}

/**
 * Send a chat completion request to backend
 * @param {string} type Request type (impersonate, quiet, continue, etc)
 * @param {ChatCompletionMessage[]} messages Array of chat completion messages
 * @param {AbortSignal?} signal Abort signal for request cancellation
 * @param {import('../script.js').AdditionalRequestOptions} options Additional request options
 * @returns {Promise<unknown>}
 * @throws {Error}
 */
async function sendOpenAIRequest(type, messages, signal, { jsonSchema = null, cacheScope = null } = {}) {
    // Provide default abort signal
    if (!signal) {
        signal = new AbortController().signal;
    }

    const model = getChatCompletionModel(oai_settings);
    const { generate_data, stream, canMultiSwipe } = await createGenerationParameters(oai_settings, model, type, messages, { jsonSchema, cacheScope });
    await eventSource.emit(event_types.CHAT_COMPLETION_SETTINGS_READY, generate_data);

    console.log(`[OpenAI frontend] sendOpenAIRequest: type=${type} source=${generate_data.chat_completion_source} model=${generate_data.model} stream=${generate_data.stream}`);

    const generate_url = '/api/backends/chat-completions/generate';
    const response = await fetch(generate_url, {
        method: 'POST',
        body: JSON.stringify(generate_data),
        headers: getRequestHeaders(),
        signal: signal,
    });

    if (!response.ok) {
        tryParseStreamingError(response, await response.text());
        throw new Error(`Got response status ${response.status}`);
    }
    if (stream) {
        const eventStream = getEventSourceStream();
        response.body.pipeThrough(eventStream);
        const reader = eventStream.readable.getReader();
        return async function* streamData() {
            let text = '';
            const swipes = [];
            const toolCalls = [];
            const state = { reasoning: '', reasoning_tokens: 0, images: [], signature: '', toolSignatures: {} };
            while (true) {
                const { done, value } = await reader.read();
                if (done) return;
                const rawData = value.data;
                if (rawData === '[DONE]') return;
                tryParseStreamingError(response, rawData);
                const parsed = JSON.parse(rawData);

                if (parsed.usage?.completion_tokens_details?.reasoning_tokens) {
                    state.reasoning_tokens = parsed.usage.completion_tokens_details.reasoning_tokens;
                }

                if (canMultiSwipe && Array.isArray(parsed?.choices) && parsed?.choices?.[0]?.index > 0) {
                    const swipeIndex = parsed.choices[0].index - 1;
                    // FIXME: state.reasoning should be an array to support multi-swipe
                    swipes[swipeIndex] = (swipes[swipeIndex] || '') + getStreamingReply(parsed, state, { overrideShowThoughts: false });
                } else {
                    text += getStreamingReply(parsed, state);
                }

                ToolManager.parseToolCalls(toolCalls, parsed, state.toolSignatures);

                yield { text, swipes: swipes, logprobs: parseChatCompletionLogprobs(parsed), toolCalls: toolCalls, state: state };
            }
        };
    } else {
        const data = await response.json();

        checkQuotaError(data);
        checkModerationError(data);

        if (data.error) {
            const message = data.error.message || response.statusText || t`Unknown error`;
            toastr.error(message, t`API returned an error`);
            throw new Error(message);
        }

        if (type !== 'quiet') {
            const logprobs = parseChatCompletionLogprobs(data);
            // Delay is required to allow the active message to be updated to
            // the one we are generating (happens right after sendOpenAIRequest)
            delay(1).then(() => saveLogprobsForActiveMessage(logprobs, null));
        }

        if (data.usage?.completion_tokens_details?.reasoning_tokens) {
            data.reasoningTokens = data.usage.completion_tokens_details.reasoning_tokens;
        }

        return data;
    }
}

/**
 * Extracts the reply from the response data from a chat completions-like source
 * @param {object} data Response data from the chat completions-like source
 * @param {object} state Additional state to keep track of
 * @param {object} [options] Additional options
 * @param {string?} [options.chatCompletionSource] Chat completion source
 * @param {boolean?} [options.overrideShowThoughts] Override show thoughts
 * @returns {string} The reply extracted from the response data
 */
export function getStreamingReply(data, state, { chatCompletionSource = null, overrideShowThoughts = null } = {}) {
    const chat_completion_source = chatCompletionSource ?? oai_settings.chat_completion_source;
    const show_thoughts = overrideShowThoughts ?? shouldRequestReasoning(oai_settings);

    if (chat_completion_source === chat_completion_sources.CLAUDE) {
        if (show_thoughts) {
            state.reasoning += data?.delta?.thinking || '';
        }
        return data?.delta?.text || '';
    } else if ([chat_completion_sources.MAKERSUITE, chat_completion_sources.VERTEXAI].includes(chat_completion_source)) {
        const inlineData = data?.candidates?.[0]?.content?.parts?.filter(x => x.inlineData && !x.thought)?.map(x => x.inlineData) || [];
        if (Array.isArray(inlineData) && inlineData.length > 0) {
            state.images.push(...inlineData.map(x => `data:${x.mimeType};base64,${x.data}`).filter(isDataURL));
        }
        if (show_thoughts) {
            state.reasoning += (data?.candidates?.[0]?.content?.parts?.filter(x => x.thought)?.map(x => x.text)?.[0] || '');
        }
        // Extract thought signatures from streaming chunks (typically in final chunk)
        const parts = data?.candidates?.[0]?.content?.parts || [];
        parts.forEach((part) => {
            if (part.thoughtSignature && typeof part.text === 'string') {
                state.signature = part.thoughtSignature;
            }
        });
        return data?.candidates?.[0]?.content?.parts?.filter(x => !x.thought)?.map(x => x.text)?.[0] || '';
    } else if (chat_completion_source === chat_completion_sources.COHERE) {
        return data?.delta?.message?.content?.text || data?.delta?.message?.tool_plan || '';
    } else if (chat_completion_source === chat_completion_sources.DEEPSEEK) {
        if (show_thoughts) {
            state.reasoning += (data.choices?.filter(x => x?.delta?.reasoning_content)?.[0]?.delta?.reasoning_content || '');
        }
        return data.choices?.[0]?.delta?.content || '';
    } else if (chat_completion_source === chat_completion_sources.XAI) {
        if (show_thoughts) {
            state.reasoning += (data.choices?.filter(x => x?.delta?.reasoning_content)?.[0]?.delta?.reasoning_content || '');
        }
        return data.choices?.[0]?.delta?.content || '';
    } else if (chat_completion_source === chat_completion_sources.OPENROUTER) {
        const imageUrls = data?.choices?.[0]?.delta?.images?.filter(x => x.type === 'image_url')?.map(x => x?.image_url?.url) || [];
        if (Array.isArray(imageUrls) && imageUrls.length > 0) {
            state.images.push(...imageUrls.filter(isDataURL));
        }
        if (show_thoughts) {
            state.reasoning +=
                data.choices?.filter(x => x?.delta?.reasoning)?.[0]?.delta?.reasoning ??
                data.choices?.filter(x => x?.delta?.reasoning_content)?.[0]?.delta?.reasoning_content ??
                data.choices?.filter(x => x?.message?.reasoning)?.[0]?.message?.reasoning ??
                data.choices?.filter(x => x?.message?.reasoning_content)?.[0]?.message?.reasoning_content ??
                '';
        }
        // Extract thought signatures from OpenRouter streaming.
        const reasoningDetails = [
            ...(data?.choices?.[0]?.delta?.reasoning_details || []),
            ...(data?.choices?.[0]?.message?.reasoning_details || []),
        ];
        reasoningDetails.forEach((detail) => {
            if (detail.type === 'reasoning.encrypted' && detail.data) {
                const isToolLikeId = typeof detail.id === 'string' && /^(tool_|call_)/.test(detail.id);
                if (typeof detail.id === 'string' && detail.id.length > 0) {
                    state.toolSignatures[detail.id] = detail.data;
                }
                if (!isToolLikeId) {
                    state.signature = detail.data;
                }
            }
        });
        return data.choices?.[0]?.delta?.content ?? data.choices?.[0]?.message?.content ?? data.choices?.[0]?.text ?? '';
    } else if ([chat_completion_sources.CUSTOM, chat_completion_sources.POLLINATIONS, chat_completion_sources.AIMLAPI, chat_completion_sources.MOONSHOT, chat_completion_sources.COMETAPI, chat_completion_sources.ELECTRONHUB, chat_completion_sources.NANOGPT, chat_completion_sources.ZAI, chat_completion_sources.SILICONFLOW, chat_completion_sources.CHUTES, chat_completion_sources.MINIMAX, chat_completion_sources.WORKERS_AI].includes(chat_completion_source)) {
        if (show_thoughts) {
            state.reasoning +=
                data.choices?.filter(x => x?.delta?.reasoning_content)?.[0]?.delta?.reasoning_content ??
                data.choices?.filter(x => x?.delta?.reasoning)?.[0]?.delta?.reasoning ??
                '';
        }
        return data.choices?.[0]?.delta?.content ?? data.choices?.[0]?.message?.content ?? data.choices?.[0]?.text ?? '';
    } else if (chat_completion_source === chat_completion_sources.MISTRALAI) {
        if (show_thoughts) {
            state.reasoning += (data.choices?.filter(x => x?.delta?.content?.[0]?.thinking)?.[0]?.delta?.content?.[0]?.thinking?.[0]?.text || '');
        }
        const content = data.choices?.[0]?.delta?.content ?? data.choices?.[0]?.message?.content ?? data.choices?.[0]?.text ?? '';
        return Array.isArray(content) ? content.map(x => x.text).filter(x => x).join('') : content;
    } else {
        return data.choices?.[0]?.delta?.content ?? data.choices?.[0]?.message?.content ?? data.choices?.[0]?.text ?? '';
    }
}

/**
 * parseChatCompletionLogprobs converts the response data returned from a chat
 * completions-like source into an array of TokenLogprobs found in the response.
 * @param {Object} data - response data from a chat completions-like source
 * @returns {import('./logprobs.js').TokenLogprobs[] | null} converted logprobs
 */
function parseChatCompletionLogprobs(data) {
    if (!data) {
        return null;
    }

    switch (oai_settings.chat_completion_source) {
        case chat_completion_sources.AIMLAPI:
            return Object.keys(data?.choices?.[0]?.logprobs ?? {}).includes('content')
                ? parseOpenAIChatLogprobs(data.choices[0]?.logprobs)
                : parseOpenAITextLogprobs(data.choices[0]?.logprobs);
        case chat_completion_sources.OPENAI:
        case chat_completion_sources.OPENAI_RESPONSES:
        case chat_completion_sources.AZURE_OPENAI:
        case chat_completion_sources.DEEPSEEK:
        case chat_completion_sources.XAI:
        case chat_completion_sources.CUSTOM:
        case chat_completion_sources.CHUTES:
            if (!data.choices?.length) {
                return null;
            }
            // OpenAI Text Completion API is treated as a chat completion source
            // by SillyTavern, hence its presence in this function.
            return textCompletionModels.includes(getChatCompletionModel())
                ? parseOpenAITextLogprobs(data.choices[0]?.logprobs)
                : parseOpenAIChatLogprobs(data.choices[0]?.logprobs);
        default:
        // implement other chat completion sources here
    }
    return null;
}

/**
 * parseOpenAIChatLogprobs receives a `logprobs` response from OpenAI's chat
 * completion API and converts into the structure used by the Token Probabilities
 * view.
 * @param {{content: { token: string, logprob: number, top_logprobs: { token: string, logprob: number }[] }[]}} logprobs
 * @returns {import('./logprobs.js').TokenLogprobs[] | null} converted logprobs
 */
function parseOpenAIChatLogprobs(logprobs) {
    const { content } = logprobs ?? {};

    if (!Array.isArray(content)) {
        return null;
    }

    /** @type {(x: { token: string, logprob: number }) => [string, number]} */
    const toTuple = (x) => [x.token, x.logprob];

    return content.map(({ token, logprob, top_logprobs = [] }) => {
        // Add the chosen token to top_logprobs if it's not already there, then
        // convert to a list of [token, logprob] pairs
        const chosenTopToken = top_logprobs.some((top) => token === top.token);
        /** @type {import('./logprobs.js').Candidate[]} */
        const topLogprobs = chosenTopToken
            ? top_logprobs.map(toTuple)
            : [...top_logprobs.map(toTuple), [token, logprob]];
        return { token, topLogprobs };
    });
}

/**
 * parseOpenAITextLogprobs receives a `logprobs` response from OpenAI's text
 * completion API and converts into the structure used by the Token Probabilities
 * view.
 * @param {{tokens: string[], token_logprobs: number[], top_logprobs: { token: string, logprob: number }[][]}} logprobs
 * @returns {import('./logprobs.js').TokenLogprobs[] | null} converted logprobs
 */
function parseOpenAITextLogprobs(logprobs) {
    const { tokens, token_logprobs, top_logprobs } = logprobs ?? {};

    if (!Array.isArray(tokens)) {
        return null;
    }

    return tokens.map((token, i) => {
        // Add the chosen token to top_logprobs if it's not already there, then
        // convert to a list of [token, logprob] pairs
        /** @type {any[]} */
        const topLogprobs = top_logprobs[i] ? Object.entries(top_logprobs[i]) : [];
        const chosenTopToken = topLogprobs.some(([topToken]) => token === topToken);
        if (!chosenTopToken) {
            topLogprobs.push([token, token_logprobs[i]]);
        }
        return { token, topLogprobs };
    });
}

async function calculateLogitBias() {
    const body = JSON.stringify(oai_settings.bias_presets[oai_settings.bias_preset_selected]);
    let result = {};

    try {
        const reply = await fetch(`/api/backends/chat-completions/bias?model=${getTokenizerModel()}`, {
            method: 'POST',
            headers: getRequestHeaders(),
            body,
        });

        result = await reply.json();
    } catch (err) {
        result = {};
        console.error(err);
    }
    return result;
}

class TokenHandler {
    /**
     * @param {(messages: object[] | object, full?: boolean) => Promise<number>} countTokenAsyncFn Function to count tokens
     */
    constructor(countTokenAsyncFn) {
        this.countTokenAsyncFn = countTokenAsyncFn;
        this.counts = {
            'start_chat': 0,
            'prompt': 0,
            'bias': 0,
            'nudge': 0,
            'jailbreak': 0,
            'impersonate': 0,
            'examples': 0,
            'conversation': 0,
        };
    }

    getCounts() {
        return this.counts;
    }

    resetCounts() {
        Object.keys(this.counts).forEach((key) => this.counts[key] = 0);
    }

    setCounts(counts) {
        this.counts = counts;
    }

    uncount(value, type) {
        this.counts[type] -= value;
    }

    /**
     * Count tokens for a message or messages.
     * @param {object|any[]} messages Messages to count tokens for
     * @param {boolean} [full] Count full tokens
     * @param {string} [type] Identifier for the token count
     * @returns {Promise<number>} The token count
     */
    async countAsync(messages, full, type) {
        const token_count = await this.countTokenAsyncFn(messages, full);
        this.counts[type] += token_count;

        return token_count;
    }

    async countUntrackedAsync(messages, full) {
        return this.countTokenAsyncFn(messages, full);
    }

    getTokensForIdentifier(identifier) {
        return this.counts[identifier] ?? 0;
    }

    getTotal() {
        return Object.values(this.counts).reduce((a, b) => a + (isNaN(b) ? 0 : b), 0);
    }

    log() {
        console.table({ ...this.counts, 'total': this.getTotal() });
    }
}


const tokenHandler = new TokenHandler(countTokensOpenAIAsync);

// Thrown by ChatCompletion when a requested prompt couldn't be found.
class IdentifierNotFoundError extends Error {
    constructor(identifier) {
        super(`Identifier ${identifier} not found.`);
        this.name = 'IdentifierNotFoundError';
    }
}

// Thrown by ChatCompletion when the token budget is unexpectedly exceeded
class TokenBudgetExceededError extends Error {
    constructor(identifier = '') {
        super(`Token budged exceeded. Message: ${identifier}`);
        this.name = 'TokenBudgetExceeded';
    }
}

// Thrown when a character name is invalid
class InvalidCharacterNameError extends Error {
    constructor(identifier = '') {
        super(`Invalid character name. Message: ${identifier}`);
        this.name = 'InvalidCharacterName';
    }
}

/**
 * Used for creating, managing, and interacting with a specific message object.
 */
class Message {
    static tokensPerImage = 85;

    /** @type {number} */
    tokens;
    /** @type {string} */
    identifier;
    /** @type {string} */
    role;
    /** @type {string|any[]} */
    content;
    /** @type {string} */
    name;
    /** @type {object} */
    tool_call = null;
    /** @type {string?} */
    signature = null;
    /** @type {string?} */
    reasoning = null;

    /**
     * @constructor
     * @param {string} role - The role of the entity creating the message.
     * @param {string} content - The actual content of the message.
     * @param {string} identifier - A unique identifier for the message.
     * @private Don't use this constructor directly. Use createAsync instead.
     */
    constructor(role, content, identifier) {
        this.identifier = identifier;
        this.role = role;
        this.content = content;

        if (!this.role) {
            console.log(`Message role not set, defaulting to 'system' for identifier '${this.identifier}'`);
            this.role = 'system';
        }

        this.tokens = 0;
    }

    /**
     * Create a new Message instance.
     * @param {string} role
     * @param {string} content
     * @param {string} identifier
     * @returns {Promise<Message>} Message instance
     */
    static async createAsync(role, content, identifier) {
        const message = new Message(role, content, identifier);

        if (typeof message.content === 'string' && message.content.length > 0) {
            message.tokens = await tokenHandler.countAsync({ role: message.role, content: message.content });
        }

        return message;
    }

    /**
     * Reconstruct the message from a tool invocation.
     * @param {import('./tool-calling.js').ToolInvocation[]} invocations - The tool invocations to reconstruct the message from.
     * @param {boolean} includeSignature Whether to include the signature in the tool calls.
     * @param {boolean} includeReasoning Whether to include plaintext reasoning fallback.
     * @returns {Promise<void>}
     */
    async setToolCalls(invocations, includeSignature, includeReasoning = false) {
        this.tool_calls = invocations.map(i => ({
            id: i.id,
            type: 'function',
            function: {
                arguments: i.parameters,
                name: i.name,
            },
            ...(includeSignature && i.signature ? { signature: i.signature } : {}),
        }));
        const fallbackReasoning = invocations.find(i => typeof i.reasoning === 'string' && i.reasoning.length > 0)?.reasoning || null;
        this.reasoning = includeReasoning ? fallbackReasoning : null;
        this.tokens = await tokenHandler.countAsync({
            role: this.role,
            tool_calls: JSON.stringify(this.tool_calls),
            ...(this.reasoning ? { reasoning: this.reasoning } : {}),
        });
    }

    /**
     * Add a name to the message.
     * @param {string} name Name to set for the message.
     * @returns {Promise<void>}
     */
    async setName(name) {
        this.name = name;
        this.tokens = await tokenHandler.countAsync({ role: this.role, content: this.content, name: this.name });
    }

    /**
     * Ensures the content is an array. If it's a string, converts it to an array with a single text object.
     * @returns {any[]} Content as an array
     */
    ensureContentIsArray() {
        const textContent = this.content;
        if (!Array.isArray(this.content)) {
            this.content = [];
            if (typeof textContent === 'string') {
                this.content.push({ type: 'text', text: textContent });
            }
        }
        return this.content;
    }

    /**
     * Adds an image to the message.
     * @param {string} image Image URL or Data URL.
     * @returns {Promise<void>}
     */
    async addImage(image) {
        this.content = this.ensureContentIsArray();
        const isDataUrl = isDataURL(image);
        if (!isDataUrl) {
            try {
                const response = await fetch(image, { method: 'GET', cache: 'force-cache' });
                if (!response.ok) throw new Error('Failed to fetch image');
                const blob = await response.blob();
                image = await getBase64Async(blob);
            } catch (error) {
                console.error('Image adding skipped', error);
                return;
            }
        }

        image = await this.compressImage(image);

        const quality = oai_settings.inline_image_quality || default_settings.inline_image_quality;
        this.content.push({ type: 'image_url', image_url: { 'url': image, 'detail': quality } });

        try {
            const tokens = await this.getImageTokenCost(image, quality);
            this.tokens += tokens;
        } catch (error) {
            this.tokens += Message.tokensPerImage;
            console.error('Failed to get image token cost', error);
        }
    }

    /**
     * Adds a video to the message.
     * @param {string} video Video URL or Data URL.
     * @returns {Promise<void>}
     */
    async addVideo(video) {
        this.content = this.ensureContentIsArray();
        const isDataUrl = isDataURL(video);
        if (!isDataUrl) {
            try {
                const response = await fetch(video, { method: 'GET', cache: 'force-cache' });
                if (!response.ok) throw new Error('Failed to fetch video');
                const blob = await response.blob();
                video = await getBase64Async(blob);
            } catch (error) {
                console.error('Video adding skipped', error);
                return;
            }
        }

        // Note: No compression for videos (unlike images)
        const quality = oai_settings.inline_image_quality || default_settings.inline_image_quality;
        this.content.push({ type: 'video_url', video_url: { 'url': video, 'detail': quality } });

        try {
            // Using Gemini calculation (263 tokens per second)
            const duration = await getVideoDurationFromDataURL(video);
            this.tokens += 263 * Math.ceil(duration);
        } catch (error) {
            // Convservative estimate for video token cost without knowing duration
            this.tokens += 263 * 40; // ~40 second video (60 seconds max)
            console.error('Failed to get video token cost', error);
        }
    }

    /**
     * Adds a audio to the message.
     * @param {string} audio Audio URL or Data URL.
     * @returns {Promise<void>}
     */
    async addAudio(audio) {
        this.content = this.ensureContentIsArray();
        const isDataUrl = isDataURL(audio);
        if (!isDataUrl) {
            try {
                const response = await fetch(audio, { method: 'GET', cache: 'force-cache' });
                if (!response.ok) throw new Error('Failed to fetch audio');
                const blob = await response.blob();
                audio = await getBase64Async(blob);
            } catch (error) {
                console.error('Audio adding skipped', error);
                return;
            }
        }

        this.content.push({ type: 'audio_url', audio_url: { 'url': audio } });

        try {
            // Using Gemini calculation (32 tokens per second)
            const duration = await getAudioDurationFromDataURL(audio);
            this.tokens += 32 * Math.ceil(duration);
        } catch (error) {
            // Estimate for audio token cost without knowing duration
            const tokens = 32 * 300; // ~5 minute audio
            this.tokens += tokens;
            console.error('Failed to get audio token cost', error);
        }
    }

    /**
     * Compress an image if it exceeds the size threshold for the current chat completion source.
     * @param {string} image Data URL of the image.
     * @returns {Promise<string>} Compressed image as a Data URL.
     */
    async compressImage(image) {
        const compressImageSources = [
            chat_completion_sources.OPENROUTER,
            chat_completion_sources.MAKERSUITE,
            chat_completion_sources.MISTRALAI,
            chat_completion_sources.VERTEXAI,
        ];
        const sizeThreshold = 2 * 1024 * 1024;
        const dataSize = image.length * 0.75;
        const safeMimeTypes = ['image/jpeg', 'image/png', 'image/webp'];
        const mimeType = image?.split(';')?.[0]?.split(':')?.[1];
        if (compressImageSources.includes(oai_settings.chat_completion_source) && dataSize > sizeThreshold) {
            const maxSide = 2048;
            image = await createThumbnail(image, maxSide, maxSide);
        } else if (!safeMimeTypes.includes(mimeType)) {
            image = await createThumbnail(image, null, null);
        }
        return image;
    }

    /**
     * Get the token cost of an image.
     * @param {string} dataUrl Data URL of the image.
     * @param {string} quality String representing the quality of the image. Can be 'low', 'auto', or 'high'.
     * @returns {Promise<number>} The token cost of the image.
     */
    async getImageTokenCost(dataUrl, quality) {
        if (quality === 'low') {
            return Message.tokensPerImage;
        }

        const size = await getImageSizeFromDataURL(dataUrl);

        // If the image is small enough, we can use the low quality token cost
        if (quality === 'auto' && size.width <= 512 && size.height <= 512) {
            return Message.tokensPerImage;
        }

        /*
        * Images are first scaled to fit within a 2048 x 2048 square, maintaining their aspect ratio.
        * Then, they are scaled such that the shortest side of the image is 768px long.
        * Finally, we count how many 512px squares the image consists of.
        * Each of those squares costs 170 tokens. Another 85 tokens are always added to the final total.
        * https://platform.openai.com/docs/guides/vision/calculating-costs
        */

        const scale = 2048 / Math.min(size.width, size.height);
        const scaledWidth = Math.round(size.width * scale);
        const scaledHeight = Math.round(size.height * scale);

        const finalScale = 768 / Math.min(scaledWidth, scaledHeight);
        const finalWidth = Math.round(scaledWidth * finalScale);
        const finalHeight = Math.round(scaledHeight * finalScale);

        const squares = Math.ceil(finalWidth / 512) * Math.ceil(finalHeight / 512);
        const tokens = squares * 170 + 85;
        return tokens;
    }

    /**
     * Create a new Message instance from a prompt asynchronously.
     * @static
     * @param {Object} prompt - The prompt object.
     * @returns {Promise<Message>} A new instance of Message.
     */
    static fromPromptAsync(prompt) {
        return Message.createAsync(prompt.role, prompt.content, prompt.identifier);
    }

    /**
     * Returns the number of tokens in the message.
     * @returns {number} Number of tokens in the message.
     */
    getTokens() { return this.tokens; }
}

/**
 * Used for creating, managing, and interacting with a collection of Message instances.
 *
 * @class MessageCollection
 */
class MessageCollection {
    collection = [];
    identifier;

    /**
     * @constructor
     * @param {string} identifier - A unique identifier for the MessageCollection.
     * @param {...Object} items - An array of Message or MessageCollection instances to be added to the collection.
     */
    constructor(identifier, ...items) {
        for (let item of items) {
            if (!(item instanceof Message || item instanceof MessageCollection)) {
                throw new Error('Only Message and MessageCollection instances can be added to MessageCollection');
            }
        }

        this.collection.push(...items);
        this.identifier = identifier;
    }

    /**
     * Get chat in the format of {role, name, content, tool_calls}.
     * @returns {Array} Array of objects with role, name, and content properties.
     */
    getChat() {
        return this.collection.reduce((acc, message) => {
            if (message.content || message.tool_calls) {
                acc.push({
                    role: message.role,
                    content: message.content,
                    ...(message.name && { name: message.name }),
                    ...(message.tool_calls && { tool_calls: message.tool_calls }),
                    ...(message.role === 'tool' && { tool_call_id: message.identifier }),
                    ...(message.signature && { signature: message.signature }),
                    ...(message.reasoning && { reasoning: message.reasoning }),
                });
            }
            return acc;
        }, []);
    }

    /**
     * Method to get the collection of messages.
     * @returns {Array} The collection of Message instances.
     */
    getCollection() {
        return this.collection;
    }

    /**
     * Add a new item to the collection.
     * @param {Object} item - The Message or MessageCollection instance to be added.
     */
    add(item) {
        this.collection.push(item);
    }

    /**
     * Get an item from the collection by its identifier.
     * @param {string} identifier - The identifier of the item to be found.
     * @returns {Object} The found item, or undefined if no item was found.
     */
    getItemByIdentifier(identifier) {
        return this.collection.find(item => item?.identifier === identifier);
    }

    /**
     * Check if an item with the given identifier exists in the collection.
     * @param {string} identifier - The identifier to check.
     * @returns {boolean} True if an item with the given identifier exists, false otherwise.
     */
    hasItemWithIdentifier(identifier) {
        return this.collection.some(message => message.identifier === identifier);
    }

    /**
     * Get the total number of tokens in the collection.
     * @returns {number} The total number of tokens.
     */
    getTokens() {
        return this.collection.reduce((tokens, message) => tokens + message.getTokens(), 0);
    }

    /**
     * Combines message collections into a single collection.
     * @returns {Message[]} The collection of messages flattened into a single array.
     */
    flatten() {
        return this.collection.reduce((acc, message) => {
            if (message instanceof MessageCollection) {
                acc.push(...message.flatten());
            } else {
                acc.push(message);
            }
            return acc;
        }, []);
    }
}

/**
 * OpenAI API chat completion representation
 * const map = [{identifier: 'example', message: {role: 'system', content: 'exampleContent'}}, ...];
 *
 * This class creates a chat context that can be sent to Open AI's api
 * Includes message management and token budgeting.
 *
 * @see https://platform.openai.com/docs/guides/gpt/chat-completions-api
 *
 */
export class ChatCompletion {
    /**
     * Combines consecutive system messages into one if they have no name attached.
     * @returns {Promise<void>}
     */
    async squashSystemMessages() {
        const excludeList = ['newMainChat', 'newChat', 'groupNudge'];
        this.messages.collection = this.messages.flatten();

        let lastMessage = null;
        let squashedMessages = [];

        for (let message of this.messages.collection) {
            // Force exclude empty messages
            if (message.role === 'system' && !message.content) {
                continue;
            }

            const shouldSquash = (message) => {
                return !excludeList.includes(message.identifier) && message.role === 'system' && !message.name;
            };

            if (shouldSquash(message)) {
                if (lastMessage && shouldSquash(lastMessage)) {
                    lastMessage.content += '\n' + message.content;
                    lastMessage.tokens = await tokenHandler.countAsync({ role: lastMessage.role, content: lastMessage.content });
                } else {
                    squashedMessages.push(message);
                    lastMessage = message;
                }
            } else {
                squashedMessages.push(message);
                lastMessage = message;
            }
        }

        this.messages.collection = squashedMessages;
    }

    /**
     * Initializes a new instance of ChatCompletion.
     * Sets up the initial token budget and a new message collection.
     */
    constructor() {
        this.tokenBudget = 0;
        this.messages = new MessageCollection('root');
        this.loggingEnabled = false;
        this.overriddenPrompts = [];
    }

    /**
     * Retrieves all messages.
     *
     * @returns {MessageCollection} The MessageCollection instance holding all messages.
     */
    getMessages() {
        return this.messages;
    }

    /**
     * Calculates and sets the token budget based on context and response.
     *
     * @param {number} context - Number of tokens in the context.
     * @param {number} response - Number of tokens in the response.
     */
    setTokenBudget(context, response) {
        this.log(`Prompt tokens: ${context}`);
        this.log(`Completion tokens: ${response}`);

        this.tokenBudget = context - response;

        this.log(`Token budget: ${this.tokenBudget}`);
    }

    /**
     * Adds a message or message collection to the collection.
     *
     * @param {Message|MessageCollection} collection - The message or message collection to add.
     * @param {number|null} position - The position at which to add the collection.
     * @returns {ChatCompletion} The current instance for chaining.
     */
    add(collection, position = null) {
        this.validateMessageCollection(collection);
        this.checkTokenBudget(collection, collection.identifier);

        if (null !== position && -1 !== position) {
            this.messages.collection[position] = collection;
        } else {
            this.messages.collection.push(collection);
        }

        this.decreaseTokenBudgetBy(collection.getTokens());

        this.log(`Added ${collection.identifier}. Remaining tokens: ${this.tokenBudget}`);

        return this;
    }

    /**
     * Inserts a message at the start of the specified collection.
     *
     * @param {Message} message - The message to insert.
     * @param {string} identifier - The identifier of the collection where to insert the message.
     */
    insertAtStart(message, identifier) {
        this.insert(message, identifier, 'start');
    }

    /**
     * Inserts a message at the end of the specified collection.
     *
     * @param {Message} message - The message to insert.
     * @param {string} identifier - The identifier of the collection where to insert the message.
     */
    insertAtEnd(message, identifier) {
        this.insert(message, identifier, 'end');
    }

    /**
     * Inserts a message at the specified position in the specified collection.
     *
     * @param {Message} message - The message to insert.
     * @param {string} identifier - The identifier of the collection where to insert the message.
     * @param {string|number} position - The position at which to insert the message ('start' or 'end').
     */
    insert(message, identifier, position = 'end') {
        this.validateMessage(message);
        this.checkTokenBudget(message, message.identifier);

        const index = this.findMessageIndex(identifier);
        if (message.content || message.tool_calls) {
            if ('start' === position) this.messages.collection[index].collection.unshift(message);
            else if ('end' === position) this.messages.collection[index].collection.push(message);
            else if (typeof position === 'number') this.messages.collection[index].collection.splice(position, 0, message);

            this.decreaseTokenBudgetBy(message.getTokens());

            this.log(`Inserted ${message.identifier} into ${identifier}. Remaining tokens: ${this.tokenBudget}`);
        }
    }

    /**
     * Remove the last item of the collection
     *
     * @param identifier
     */
    removeLastFrom(identifier) {
        const index = this.findMessageIndex(identifier);
        const message = this.messages.collection[index].collection.pop();

        if (!message) {
            this.log(`No message to remove from ${identifier}`);
            return;
        }

        this.increaseTokenBudgetBy(message.getTokens());

        this.log(`Removed ${message.identifier} from ${identifier}. Remaining tokens: ${this.tokenBudget}`);
    }

    /**
     * Checks if the token budget can afford the tokens of the specified message.
     *
     * @param {Message|MessageCollection} message - The message to check for affordability.
     * @returns {boolean} True if the budget can afford the message, false otherwise.
     */
    canAfford(message) {
        return 0 <= this.tokenBudget - message.getTokens();
    }

    /**
     * Checks if the token budget can afford the tokens of all the specified messages.
     * @param {Message[]} messages - The messages to check for affordability.
     * @returns {boolean} True if the budget can afford all the messages, false otherwise.
     */
    canAffordAll(messages) {
        return 0 <= this.tokenBudget - messages.reduce((total, message) => total + message.getTokens(), 0);
    }

    /**
     * Checks if a message with the specified identifier exists in the collection.
     *
     * @param {string} identifier - The identifier to check for existence.
     * @returns {boolean} True if a message with the specified identifier exists, false otherwise.
     */
    has(identifier) {
        return this.messages.hasItemWithIdentifier(identifier);
    }

    /**
     * Retrieves the total number of tokens in the collection.
     *
     * @returns {number} The total number of tokens.
     */
    getTotalTokenCount() {
        return this.messages.getTokens();
    }

    /**
     * Retrieves the chat as a flattened array of messages.
     *
     * @returns {Array} The chat messages.
     */
    getChat() {
        const chat = [];
        for (let item of this.messages.collection) {
            if (item instanceof MessageCollection) {
                chat.push(...item.getChat());
            } else if (item instanceof Message && (item.content || item.tool_calls)) {
                const message = {
                    role: item.role,
                    content: item.content,
                    ...(item.name ? { name: item.name } : {}),
                    ...(item.tool_calls ? { tool_calls: item.tool_calls } : {}),
                    ...(item.role === 'tool' ? { tool_call_id: item.identifier } : {}),
                    ...(item.signature ? { signature: item.signature } : {}),
                    ...(item.reasoning ? { reasoning: item.reasoning } : {}),
                };
                chat.push(message);
            } else {
                this.log(`Skipping invalid or empty message in collection: ${JSON.stringify(item)}`);
            }
        }
        return chat;
    }

    /**
     * Logs an output message to the console if logging is enabled.
     *
     * @param {string} output - The output message to log.
     */
    log(output) {
        if (this.loggingEnabled) console.log('[ChatCompletion] ' + output);
    }

    /**
     * Enables logging of output messages to the console.
     */
    enableLogging() {
        this.loggingEnabled = true;
    }

    /**
     * Disables logging of output messages to the console.
     */
    disableLogging() {
        this.loggingEnabled = false;
    }

    /**
     * Validates if the given argument is an instance of MessageCollection.
     * Throws an error if the validation fails.
     *
     * @param {MessageCollection|Message} collection - The collection to validate.
     */
    validateMessageCollection(collection) {
        if (!(collection instanceof MessageCollection)) {
            console.log(JSON.stringify(collection));
            throw new Error('Argument must be an instance of MessageCollection');
        }
    }

    /**
     * Validates if the given argument is an instance of Message.
     * Throws an error if the validation fails.
     *
     * @param {Message} message - The message to validate.
     */
    validateMessage(message) {
        if (!(message instanceof Message)) {
            console.log(JSON.stringify(message));
            throw new Error('Argument must be an instance of Message');
        }
    }

    /**
     * Checks if the token budget can afford the tokens of the given message.
     * Throws an error if the budget can't afford the message.
     *
     * @param {Message|MessageCollection} message - The message to check.
     * @param {string} identifier - The identifier of the message.
     */
    checkTokenBudget(message, identifier) {
        if (!this.canAfford(message)) {
            throw new TokenBudgetExceededError(identifier);
        }
    }

    /**
     * Reserves the tokens required by the given message from the token budget.
     *
     * @param {Message|MessageCollection|number} message - The message whose tokens to reserve.
     */
    reserveBudget(message) {
        const tokens = typeof message === 'number' ? message : message.getTokens();
        this.decreaseTokenBudgetBy(tokens);
    }

    /**
     * Frees up the tokens used by the given message from the token budget.
     *
     * @param {Message|MessageCollection} message - The message whose tokens to free.
     */
    freeBudget(message) { this.increaseTokenBudgetBy(message.getTokens()); }

    /**
     * Increases the token budget by the given number of tokens.
     * This function should be used sparingly, per design the completion should be able to work with its initial budget.
     *
     * @param {number} tokens - The number of tokens to increase the budget by.
     */
    increaseTokenBudgetBy(tokens) {
        this.tokenBudget += tokens;
    }

    /**
     * Decreases the token budget by the given number of tokens.
     * This function should be used sparingly, per design the completion should be able to work with its initial budget.
     *
     * @param {number} tokens - The number of tokens to decrease the budget by.
     */
    decreaseTokenBudgetBy(tokens) {
        this.tokenBudget -= tokens;
    }

    /**
     * Finds the index of a message in the collection by its identifier.
     * Throws an error if a message with the given identifier is not found.
     *
     * @param {string} identifier - The identifier of the message to find.
     * @returns {number} The index of the message in the collection.
     */
    findMessageIndex(identifier) {
        const index = this.messages.collection.findIndex(item => item?.identifier === identifier);
        if (index < 0) {
            throw new IdentifierNotFoundError(identifier);
        }
        return index;
    }

    /**
     * Sets the list of overridden prompts.
     * @param {string[]} list A list of prompts that were overridden.
     */
    setOverriddenPrompts(list) {
        this.overriddenPrompts = list;
    }

    getOverriddenPrompts() {
        return this.overriddenPrompts ?? [];
    }
}

/**
 * Migrate old Chat Completion settings to new format.
 * @param {ChatCompletionSettings} settings Settings to migrate
 */
function migrateChatCompletionSettings(settings) {
    const migrateMap = [
        { oldKey: 'group_nudge_prompt', oldValue: legacy_group_nudge_prompt, newKey: 'group_nudge_prompt', newValue: default_group_nudge_prompt },
        { oldKey: 'names_in_completion', oldValue: true, newKey: 'names_behavior', newValue: character_names_behavior.COMPLETION },
        { oldKey: 'chat_completion_source', oldValue: 'palm', newKey: 'chat_completion_source', newValue: chat_completion_sources.MAKERSUITE },
        { oldKey: 'custom_prompt_post_processing', oldValue: custom_prompt_post_processing_types.CLAUDE, newKey: 'custom_prompt_post_processing', newValue: custom_prompt_post_processing_types.MERGE },
        { oldKey: 'ai21_model', oldValue: /^j2-/, newKey: 'ai21_model', newValue: 'jamba-large' },
        { oldKey: 'image_inlining', oldValue: false, newKey: 'media_inlining', newValue: false },
        { oldKey: 'image_inlining', oldValue: true, newKey: 'media_inlining', newValue: true },
        { oldKey: 'video_inlining', oldValue: true, newKey: 'media_inlining', newValue: true },
        { oldKey: 'audio_inlining', oldValue: true, newKey: 'media_inlining', newValue: true },
        { oldKey: 'claude_use_sysprompt', oldValue: true, newKey: 'use_sysprompt', newValue: true },
        { oldKey: 'use_makersuite_sysprompt', oldValue: true, newKey: 'use_sysprompt', newValue: true },
        { oldKey: 'mistralai_model', oldValue: /^(mistral-medium|mistral-small)$/, newKey: 'mistralai_model', newValue: (settings.mistralai_model + '-latest') },
        { oldKey: 'reasoning_effort', oldValue: 'auto', newKey: 'reasoning_effort', newValue: reasoning_effort_types.none },
    ];

    for (const migration of migrateMap) {
        if (Object.hasOwn(settings, migration.oldKey)) {
            const shouldMigrate = migration.oldValue instanceof RegExp
                ? migration.oldValue.test(settings[migration.oldKey])
                : settings[migration.oldKey] === migration.oldValue;
            if (shouldMigrate) {
                settings[migration.newKey] = migration.newValue;
            }
            if (migration.oldKey !== migration.newKey) {
                delete settings[migration.oldKey];
            }
        }
    }
}

/**
 * Load OpenAI settings from backend data
 * @param {any} data Settings data from backend
 * @param {ChatCompletionSettings} settings Saved settings from backend
 */
function loadOpenAISettings(data, settings) {
    openai_setting_names = data.openai_setting_names;
    openai_settings = data.openai_settings;
    openai_settings.forEach(function (item, i) {
        openai_settings[i] = JSON.parse(item);
    });

    $('#settings_preset_openai').empty();
    const settingNames = {};
    openai_setting_names.forEach(function (item, i) {
        settingNames[item] = i;
        const option = document.createElement('option');
        option.value = i;
        option.text = item;
        $('#settings_preset_openai').append(option);
    });
    openai_setting_names = settingNames;

    migrateChatCompletionSettings(settings);
    ensureModelFavoritesStore(settings);

    for (const key of Object.keys(default_settings)) {
        oai_settings[key] = settings[key] ?? default_settings[key];
        const settingToUpdate = Object.values(settingsToUpdate).find(([_, k]) => k === key);
        if (settingToUpdate) {
            const [selector] = settingToUpdate;
            const $element = $(selector);

            if ($element.length === 0) {
                continue;
            }

            if ($element.is('input[type="checkbox"]')) {
                $element.prop('checked', oai_settings[key]);
            } else if ($element.is('select')) {
                $element.val(oai_settings[key]);
                $element.find(`option[value="${CSS.escape(oai_settings[key])}"]`).prop('selected', true);
            } else {
                $element.val(oai_settings[key]);
                if ($element.is('input[type="range"]')) {
                    const id = $element.attr('id');
                    const $counter = $(`input[type="number"][data-for="${id}"]`);
                    if ($counter.length > 0) {
                        $counter.val(Number(oai_settings[key]));
                    }
                }
            }
        }
    }

    applyToolCallRecurseLimit(oai_settings.tool_call_recurse_limit);
    syncMaxContextUnlockedControl(oai_settings);

    restoreOpenAIPresetSelection();
    $('#bind_preset_to_connection').prop('checked', oai_settings.bind_preset_to_connection);
    $('#bind_preset_to_sampling').prop('checked', shouldIncludeSamplingFieldsInPreset(oai_settings));
    updateBindPresetToConnectionHelp();
    updateBindPresetToSamplingHelp();
    syncModelSamplingProfilesUI();
    $('#openai_external_category').toggle(oai_settings.show_external_models);
    $('.reverse_proxy_warning').toggle(oai_settings.reverse_proxy !== '');

    // Don't display Service Account JSON in textarea - it's stored in backend secrets
    $('#vertexai_service_account_json').val('');
    updateVertexAIServiceAccountStatus();

    normalizeLogitBiasState();
    refreshLogitBiasPresetOptions();
    $('#openai_logit_bias_preset').trigger('change');

    setNamesBehaviorControls();
    setContinuePostfixControls();
    setToolReasoningControls();
    setAutoAppendReasoningTagControls();

    $('#openrouter_providers_chat').trigger('change');
    $('#openrouter_quantizations_chat').trigger('change');
    rebuildOpenAIModelSelect();
    updateOpenAIModelFavoriteButton();
    updateAdvancedFormattingVisibility();
    updateOpenAISettingsGroupVisibility();
    $('#chat_completion_source').trigger('change');
    scheduleOpenAIUiRefresh();
}

function updateBindPresetToConnectionHelp() {
    const copy = document.getElementById('bind_preset_to_connection_copy');
    const tip = document.getElementById('bind_preset_to_connection_tip');

    if (!(copy instanceof HTMLElement) || !(tip instanceof HTMLElement)) {
        return;
    }

    if (oai_settings.bind_preset_to_connection) {
        copy.textContent = t`Linked mode: choosing a preset can also switch the provider, model, and other connection-specific options saved inside that preset.`;
        tip.textContent = t`Use this when each preset is meant for one exact API setup.`;
        return;
    }

    copy.textContent = t`Independent mode: choosing a preset keeps your current provider and model, so one preset can be reused across multiple connections.`;
    tip.textContent = t`Recommended for most setups and especially for shared preset libraries.`;
}

function updateBindPresetToSamplingHelp() {
    const copy = document.getElementById('bind_preset_to_sampling_copy');
    const tip = document.getElementById('bind_preset_to_sampling_tip');

    if (!(copy instanceof HTMLElement) || !(tip instanceof HTMLElement)) {
        return;
    }

    if (shouldIncludeSamplingFieldsInPreset(oai_settings)) {
        copy.textContent = t`Linked mode: choosing a preset also updates temperature, penalties, and other sampling sliders to values saved inside that preset.`;
        tip.textContent = t`Use this when each preset stores its own sampling values.`;
        return;
    }

    copy.textContent = t`Independent mode: choosing a preset leaves your current sampling sliders unchanged, so one set of sampling values can be reused across multiple presets.`;
    tip.textContent = t`Recommended when different models need different sampling settings.`;
}

function syncModelSamplingProfilesUI() {
    const $toggle = $('#model_sampling_profiles_enabled');

    if (!$toggle.length) {
        return;
    }

    const enabled = Boolean(oai_settings.model_sampling_profiles_enabled);
    $toggle.prop('checked', enabled);
}

function getModelSamplingProfileKey() {
    const source = oai_settings.chat_completion_source;
    const model = getChatCompletionModel();
    if (!source || !model) {
        return null;
    }
    return `${source}:${model}`;
}

function getSamplingSettingsSnapshot() {
    return buildChatCompletionSamplingSettingsSnapshot(oai_settings, settingsToUpdate);
}

function applySamplingSettings(profile) {
    if (!profile) {
        return false;
    }

    const updateInput = (selector, value) => $(selector).val(value).trigger('input');
    const updateCheckbox = (selector, value) => $(selector).prop('checked', value).trigger('input');
    let changed = false;

    for (const [selector, setting, isCheckbox, , isSampling] of Object.values(settingsToUpdate)) {
        if (!isSampling || profile[setting] === undefined || profile[setting] === oai_settings[setting]) {
            continue;
        }

        const value = profile[setting];
        if (selector) {
            if (isCheckbox) {
                updateCheckbox(selector, value);
            } else {
                updateInput(selector, value);
            }
        }

        oai_settings[setting] = value;
        changed = true;
    }

    return changed;
}

function saveSamplingProfileForCurrentModel() {
    const profileKey = getModelSamplingProfileKey();
    if (!profileKey) {
        toastr.warning(t`No model is currently selected.`, t`Cannot save sampling profile`);
        return;
    }
    oai_settings.model_sampling_profiles[profileKey] = getSamplingSettingsSnapshot();
    saveSettingsDebounced();
    const modelLabel = getChatCompletionModel();
    toastr.success(t`Saved sampling settings for ${modelLabel}.`, t`Model sampling profile saved`);
}

function clearSamplingProfileForCurrentModel() {
    const profileKey = getModelSamplingProfileKey();
    if (!profileKey) {
        toastr.warning(t`No model is currently selected.`, t`Cannot clear sampling profile`);
        return;
    }
    if (oai_settings.model_sampling_profiles?.[profileKey]) {
        delete oai_settings.model_sampling_profiles[profileKey];
        saveSettingsDebounced();
        const modelLabel = getChatCompletionModel();
        toastr.info(t`Cleared sampling profile for ${modelLabel}.`, t`Model sampling profile removed`);
    } else {
        const modelLabel = getChatCompletionModel();
        toastr.info(t`No saved sampling profile exists for ${modelLabel}.`, t`No sampling profile to clear`);
    }
}

function maybeApplyModelSamplingProfile() {
    if (!oai_settings.model_sampling_profiles_enabled) {
        return;
    }
    const profileKey = getModelSamplingProfileKey();
    if (!profileKey) {
        return;
    }
    const profile = oai_settings.model_sampling_profiles?.[profileKey];
    if (!profile) {
        return;
    }
    applySamplingSettings(profile);
    // SillyBunny: Removed constant "Model sampling profile loaded" toast to reduce UI noise
}

function maybeShowPresetConnectionBindingReminder(previousPresetName, nextPresetName) {
    if (hasShownPresetConnectionBindingReminder || !oai_settings.bind_preset_to_connection) {
        return;
    }

    if (!previousPresetName || previousPresetName === nextPresetName) {
        return;
    }

    hasShownPresetConnectionBindingReminder = true;
    toastr.info(
        t`This preset is linked to your API and model settings. Turn off "Keep API/model linked to preset" if you want one preset to stay reusable across multiple connections.`,
        t`Preset switch also changes the connection setup`,
        { timeOut: 9000 },
    );
}

function setNamesBehaviorControls() {
    switch (oai_settings.names_behavior) {
        case character_names_behavior.NONE:
            $('#character_names_none').prop('checked', true);
            break;
        case character_names_behavior.DEFAULT:
            $('#character_names_default').prop('checked', true);
            break;
        case character_names_behavior.COMPLETION:
            $('#character_names_completion').prop('checked', true);
            break;
        case character_names_behavior.CONTENT:
            $('#character_names_content').prop('checked', true);
            break;
    }

    const checkedItemText = $('input[name="character_names"]:checked ~ span').text().trim();
    $('#character_names_display').text(checkedItemText);
}

function setContinuePostfixControls() {
    switch (oai_settings.continue_postfix) {
        case continue_postfix_types.NONE:
            $('#continue_postfix_none').prop('checked', true);
            break;
        case continue_postfix_types.SPACE:
            $('#continue_postfix_space').prop('checked', true);
            break;
        case continue_postfix_types.NEWLINE:
            $('#continue_postfix_newline').prop('checked', true);
            break;
        case continue_postfix_types.DOUBLE_NEWLINE:
            $('#continue_postfix_double_newline').prop('checked', true);
            break;
        default:
            // Prevent preset value abuse
            oai_settings.continue_postfix = continue_postfix_types.SPACE;
            $('#continue_postfix_space').prop('checked', true);
            break;
    }

    $('#continue_postfix').val(oai_settings.continue_postfix);
    const checkedItemText = $('input[name="continue_postfix"]:checked ~ span').text().trim();
    $('#continue_postfix_display').text(checkedItemText);
}

function setToolReasoningControls() {
    const isEnabled = shouldRequestReasoning(oai_settings);
    $('#tool_reasoning_mode').prop('disabled', !isEnabled);
    $('#openrouter_interleaved_thinking_disabled_hint').toggle(!isEnabled);
}

function setAutoAppendReasoningTagControls() {
    $('#openai_reasoning_tag_style').prop('disabled', !oai_settings.auto_append_reasoning_tags);
}

async function getStatusOpen() {
    const noValidateSources = [
        chat_completion_sources.AI21,
        chat_completion_sources.PERPLEXITY,
        chat_completion_sources.ZAI,
        chat_completion_sources.MINIMAX,
    ];
    if (noValidateSources.includes(oai_settings.chat_completion_source)) {
        let status = t`Key saved; press \"Test Message\" to verify.`;
        setOnlineStatus(status);
        updateFeatureSupportFlags();
        return resultCheckStatus();
    }

    if (oai_settings.chat_completion_source === chat_completion_sources.CUSTOM && !isValidUrl(oai_settings.custom_url)) {
        console.debug('Invalid endpoint URL of Custom OpenAI API:', oai_settings.custom_url);
        setOnlineStatus(t`Invalid endpoint URL. Requests may fail.`);
        return resultCheckStatus();
    }

    if (oai_settings.chat_completion_source === chat_completion_sources.AZURE_OPENAI && !isValidUrl(oai_settings.azure_base_url)) {
        console.debug('Invalid endpoint URL of Azure OpenAI API:', oai_settings.azure_base_url);
        setOnlineStatus(t`Invalid Azure endpoint URL. Requests may fail.`);
        return resultCheckStatus();
    }

    let data = {
        reverse_proxy: oai_settings.reverse_proxy,
        proxy_password: oai_settings.proxy_password,
        chat_completion_source: oai_settings.chat_completion_source,
    };

    if (oai_settings.reverse_proxy && REVERSE_PROXY_SUPPORTED_SOURCES.includes(oai_settings.chat_completion_source)) {
        await validateReverseProxy();
    }

    if (oai_settings.chat_completion_source === chat_completion_sources.CUSTOM) {
        $('.model_custom_select').empty();
        data.custom_url = oai_settings.custom_url;
        data.custom_include_headers = oai_settings.custom_include_headers;
    }

    if (oai_settings.chat_completion_source === chat_completion_sources.AZURE_OPENAI) {
        data.azure_base_url = oai_settings.azure_base_url;
        data.azure_deployment_name = oai_settings.azure_deployment_name;
        data.azure_api_version = oai_settings.azure_api_version;
    }

    if (oai_settings.chat_completion_source === chat_completion_sources.SILICONFLOW) {
        data.siliconflow_endpoint = oai_settings.siliconflow_endpoint;
    }

    if (oai_settings.chat_completion_source === chat_completion_sources.MINIMAX) {
        data.minimax_endpoint = oai_settings.minimax_endpoint;
    }

    if (oai_settings.chat_completion_source === chat_completion_sources.VERTEXAI) {
        data.vertexai_auth_mode = oai_settings.vertexai_auth_mode;
        data.vertexai_region = oai_settings.vertexai_region;
        data.vertexai_express_project_id = oai_settings.vertexai_express_project_id;
    }

    if (oai_settings.chat_completion_source === chat_completion_sources.WORKERS_AI) {
        data.workers_ai_account_id = oai_settings.workers_ai_account_id;
    }

    const canBypass = ([chat_completion_sources.OPENAI, chat_completion_sources.OPENAI_RESPONSES].includes(oai_settings.chat_completion_source) && oai_settings.bypass_status_check)
        || oai_settings.chat_completion_source === chat_completion_sources.CUSTOM;
    if (canBypass) {
        setOnlineStatus(t`Status check bypassed`);
    }

    try {
        const response = await fetch('/api/backends/chat-completions/status', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify(data),
            signal: abortStatusCheck.signal,
            cache: 'no-cache',
        });

        if (!response.ok) {
            throw new Error(response.statusText);
        }

        const responseData = await response.json();

        if ('data' in responseData && Array.isArray(responseData.data)) {
            saveModelList(responseData.data);
        }
        if (!('error' in responseData)) {
            setOnlineStatus(t`Valid`);
        }
        if (responseData.bypass) {
            setOnlineStatus(t`Status check bypassed`);
        }
    } catch (error) {
        console.error(error);

        if (!canBypass) {
            setOnlineStatus('no_connection');
        }
    }

    updateFeatureSupportFlags();
    return resultCheckStatus();
}

/**
 * Get OpenAI preset body from settings
 * @param {ChatCompletionSettings} settings The settings object
 * @returns {Object} The preset body object
 */
export function getChatCompletionPreset(settings = oai_settings) {
    return buildChatCompletionPresetForSave(settings, settingsToUpdate);
}

function normalizeLogitBiasEntry(entry) {
    if (typeof entry !== 'object' || entry === null || !Object.hasOwn(entry, 'text') || !Object.hasOwn(entry, 'value')) {
        return null;
    }

    const value = Number(entry.value);

    return {
        ...entry,
        id: entry.id || uuidv4(),
        text: String(entry.text ?? ''),
        value: Number.isFinite(value) ? value : 0,
    };
}

function normalizeLogitBiasPresets(source, { includeDefaults = false } = {}) {
    const presets = includeDefaults ? structuredClone(default_bias_presets) : {};

    if (source && typeof source === 'object' && !Array.isArray(source)) {
        for (const [name, entries] of Object.entries(source)) {
            if (!Array.isArray(entries)) {
                continue;
            }

            presets[name] = entries.map(normalizeLogitBiasEntry).filter(Boolean);
        }
    }

    return presets;
}

function normalizeLogitBiasState(selectedPreset = oai_settings.bias_preset_selected) {
    oai_settings.bias_presets = normalizeLogitBiasPresets(oai_settings.bias_presets, { includeDefaults: true });

    let selected = typeof selectedPreset === 'string' && selectedPreset.trim()
        ? selectedPreset
        : oai_settings.bias_preset_selected;

    if (!selected || !Array.isArray(oai_settings.bias_presets[selected])) {
        selected = Object.keys(oai_settings.bias_presets).find(name => Array.isArray(oai_settings.bias_presets[name])) || default_bias;
    }

    if (!Array.isArray(oai_settings.bias_presets[selected])) {
        oai_settings.bias_presets[selected] = [];
    }

    oai_settings.bias_preset_selected = selected;
    return oai_settings.bias_presets[selected];
}

function applyLogitBiasPresetSettings(preset) {
    const hasBiasPresets = preset && typeof preset === 'object' && Object.hasOwn(preset, 'bias_presets');

    if (hasBiasPresets) {
        oai_settings.bias_presets = normalizeLogitBiasPresets(preset.bias_presets, { includeDefaults: true });
    }

    normalizeLogitBiasState(hasBiasPresets ? preset.bias_preset_selected : oai_settings.bias_preset_selected);
}

function refreshLogitBiasPresetOptions() {
    const selectedPreset = oai_settings.bias_preset_selected;
    const select = $('#openai_logit_bias_preset');

    select.empty();
    for (const preset of Object.keys(oai_settings.bias_presets)) {
        const option = document.createElement('option');
        option.innerText = preset;
        option.value = preset;
        option.selected = preset === selectedPreset;
        select.append(option);
    }

    select.val(oai_settings.bias_preset_selected);
}

/**
 * Persist a settings preset with the given name
 *
 * @param {string} name - Name of the preset
 * @param {ChatCompletionSettings} settings The settings object
 * @param {boolean} triggerUi Whether the change event of preset UI element should be emitted
 * @returns {Promise<void>}
 */
async function saveOpenAIPreset(name, settings, triggerUi = true) {
    const presetBody = getChatCompletionPreset(settings);
    const savePresetSettings = await fetch('/api/presets/save', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({
            apiId: 'openai',
            name: name,
            preset: presetBody,
        }),
    });

    if (savePresetSettings.ok) {
        const data = await savePresetSettings.json();

        if (Object.keys(openai_setting_names).includes(data.name)) {
            oai_settings.preset_settings_openai = data.name;
            const value = openai_setting_names[data.name];
            openai_settings[value] = presetBody;
            $(`#settings_preset_openai option[value="${value}"]`).prop('selected', true);
            if (triggerUi) $('#settings_preset_openai').trigger('change');
        } else {
            openai_settings.push(presetBody);
            openai_setting_names[data.name] = openai_settings.length - 1;
            const option = document.createElement('option');
            option.selected = true;
            option.value = String(openai_settings.length - 1);
            option.innerText = data.name;
            if (triggerUi) $('#settings_preset_openai').append(option).trigger('change');
        }

        if (!triggerUi) {
            await eventSource.emit(event_types.PRESET_CHANGED, { apiId: 'openai', name: data.name });
        }
    } else {
        toastr.error(t`Failed to save preset`);
        throw new Error('Failed to save preset');
    }
}

function onLogitBiasPresetChange() {
    const value = String($('#openai_logit_bias_preset').find(':selected').val() ?? oai_settings.bias_preset_selected ?? default_bias);
    const preset = normalizeLogitBiasState(value);
    refreshLogitBiasPresetOptions();

    const list = $('.openai_logit_bias_list');
    list.empty();

    for (const entry of preset) {
        if (entry) {
            createLogitBiasListItem(entry);
        }
    }

    // Check if a sortable instance exists
    if (list.sortable('instance') !== undefined) {
        // Destroy the instance
        list.sortable('destroy');
    }

    // Make the list sortable
    list.sortable({
        delay: getSortableDelay(),
        handle: '.drag-handle',
        stop: function () {
            const order = [];
            list.children().each(function () {
                order.unshift($(this).data('id'));
            });
            preset.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
            console.log('Logit bias reordered:', JSON.stringify(preset));
            saveSettingsDebounced();
        },
    });

    biasCache = undefined;
    saveSettingsDebounced();
}

function createNewLogitBiasEntry() {
    const entry = { id: uuidv4(), text: '', value: 0 };
    normalizeLogitBiasState().push(entry);
    biasCache = undefined;
    createLogitBiasListItem(entry);
    saveSettingsDebounced();
}

function createLogitBiasListItem(entry) {
    if (!entry.id) {
        entry.id = uuidv4();
    }
    const id = entry.id;
    const template = $('#openai_logit_bias_template .openai_logit_bias_form').clone();
    template.data('id', id);
    template.find('.openai_logit_bias_text').val(entry.text).on('input', function () {
        entry.text = String($(this).val());
        biasCache = undefined;
        saveSettingsDebounced();
    });
    template.find('.openai_logit_bias_value').val(entry.value).on('input', function () {
        const min = Number($(this).attr('min'));
        const max = Number($(this).attr('max'));
        let value = Number($(this).val());

        if (value < min) {
            $(this).val(min);
            value = min;
        }

        if (value > max) {
            $(this).val(max);
            value = max;
        }

        entry.value = value;
        biasCache = undefined;
        saveSettingsDebounced();
    });
    template.find('.openai_logit_bias_remove').on('click', function () {
        $(this).closest('.openai_logit_bias_form').remove();
        const preset = normalizeLogitBiasState();
        const index = preset.findIndex(item => item.id === id);
        if (index >= 0) {
            preset.splice(index, 1);
        }
        onLogitBiasPresetChange();
    });
    $('.openai_logit_bias_list').prepend(template);
}

async function createNewLogitBiasPreset() {
    const name = await Popup.show.input(t`Preset name:`, null);

    if (!name) {
        return;
    }

    if (name in oai_settings.bias_presets) {
        toastr.error(t`Preset name should be unique.`);
        return;
    }

    oai_settings.bias_preset_selected = name;
    oai_settings.bias_presets[name] = [];

    addLogitBiasPresetOption(name);
    saveSettingsDebounced();
}

function addLogitBiasPresetOption(name) {
    normalizeLogitBiasState(name);
    refreshLogitBiasPresetOptions();
    $('#openai_logit_bias_preset').trigger('change');
}

function onImportPresetClick() {
    $('#openai_preset_import_file').trigger('click');
}

function onLogitBiasPresetImportClick() {
    $('#openai_logit_bias_import_file').trigger('click');
}

async function onPresetImportFileChange(e) {
    const file = e.target.files[0];

    if (!file) {
        return;
    }

    const name = file.name.replace(/\.[^/.]+$/, '');
    const importedFile = await getFileText(file);
    let presetBody;
    e.target.value = '';

    try {
        presetBody = JSON.parse(importedFile);
    } catch (err) {
        toastr.error(t`Invalid file`);
        return;
    }

    const fields = sensitiveFields.filter(field => presetBody[field]).map(field => `<b>${field}</b>`);
    const shouldConfirm = fields.length > 0;

    if (shouldConfirm) {
        const textHeader = 'The imported preset contains proxy and/or custom endpoint settings.';
        const textMessage = fields.join('<br>');
        const cancelButton = { text: 'Cancel import', result: POPUP_RESULT.CANCELLED, appendAtEnd: true };
        const popupOptions = { customButtons: [cancelButton], okButton: 'Remove them', cancelButton: 'Import as-is' };
        const popupResult = await Popup.show.confirm(textHeader, textMessage, popupOptions);

        if (popupResult === POPUP_RESULT.CANCELLED) {
            console.log('Import cancelled by user');
            return;
        }

        if (popupResult === POPUP_RESULT.AFFIRMATIVE) {
            sensitiveFields.forEach(field => delete presetBody[field]);
        }
    }

    if (name in openai_setting_names) {
        const confirm = await callGenericPopup('Preset name already exists. Overwrite?', POPUP_TYPE.CONFIRM);

        if (!confirm) {
            return;
        }
    }

    await eventSource.emit(event_types.OAI_PRESET_IMPORT_READY, { data: presetBody, presetName: name });

    const savePresetSettings = await fetch('/api/presets/save', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({
            apiId: 'openai',
            name: name,
            preset: presetBody,
        }),
    });

    if (!savePresetSettings.ok) {
        toastr.error(t`Failed to save preset`);
        return;
    }

    const data = await savePresetSettings.json();

    if (Object.keys(openai_setting_names).includes(data.name)) {
        oai_settings.preset_settings_openai = data.name;
        const value = openai_setting_names[data.name];
        Object.assign(openai_settings[value], presetBody);
        $(`#settings_preset_openai option[value="${value}"]`).prop('selected', true);
        $('#settings_preset_openai').trigger('change');
    } else {
        openai_settings.push(presetBody);
        openai_setting_names[data.name] = openai_settings.length - 1;
        const option = document.createElement('option');
        option.selected = true;
        option.value = String(openai_settings.length - 1);
        option.innerText = data.name;
        $('#settings_preset_openai').append(option).trigger('change');
    }
}

async function onExportPresetClick() {
    if (!oai_settings.preset_settings_openai) {
        toastr.error(t`No preset selected`);
        return;
    }

    const preset = structuredClone(openai_settings[openai_setting_names[oai_settings.preset_settings_openai]]);

    const fieldValues = sensitiveFields.filter(field => preset[field]).map(field => `<b>${field}</b>: <code>${preset[field]}</code>`);
    if (fieldValues.length > 0) {
        const textHeader = t`Your preset contains proxy and/or custom endpoint settings.`;
        const textMessage = '<div>' + t`Do you want to remove these fields before exporting?` + `</div><br>${DOMPurify.sanitize(fieldValues.join('<br>'))}`;
        const cancelButton = { text: 'Cancel', result: POPUP_RESULT.CANCELLED, appendAtEnd: true };
        const popupOptions = { customButtons: [cancelButton] };
        const popupResult = await Popup.show.confirm(textHeader, textMessage, popupOptions);

        if (popupResult === POPUP_RESULT.CANCELLED) {
            console.log('Export cancelled by user');
            return;
        }

        if (popupResult === POPUP_RESULT.AFFIRMATIVE) {
            sensitiveFields.forEach(field => delete preset[field]);
        }
    }

    const exportConnectionTemplate = $(await renderTemplateAsync('exportPreset'));
    await new Popup(exportConnectionTemplate, POPUP_TYPE.TEXT).show();

    const removeConnectionData = exportConnectionTemplate.find('input[name="export_connection_data"]:checked').val() === 'false';
    if (removeConnectionData) {
        for (const [, [, settingName, , isConnection]] of Object.entries(settingsToUpdate)) {
            if (isConnection) {
                delete preset[settingName];
            }
        }
    }

    await eventSource.emit(event_types.OAI_PRESET_EXPORT_READY, preset);
    const presetJsonString = JSON.stringify(preset, null, 4);
    const presetFileName = `${oai_settings.preset_settings_openai}.json`;
    download(presetJsonString, presetFileName, 'application/json');
}

async function onLogitBiasPresetImportFileChange(e) {
    const file = e.target.files[0];

    if (!file || file.type !== 'application/json') {
        return;
    }

    const name = file.name.replace(/\.[^/.]+$/, '');
    const importedFile = await parseJsonFile(file);
    e.target.value = '';

    if (name in oai_settings.bias_presets) {
        toastr.error(t`Preset name should be unique.`);
        return;
    }

    if (!Array.isArray(importedFile)) {
        toastr.error(t`Invalid logit bias preset file.`);
        return;
    }

    const validEntries = [];

    for (const entry of importedFile) {
        if (typeof entry == 'object' && entry !== null) {
            if (Object.hasOwn(entry, 'text') &&
                Object.hasOwn(entry, 'value')) {
                if (!entry.id) {
                    entry.id = uuidv4();
                }
                validEntries.push(entry);
            }
        }
    }

    oai_settings.bias_presets[name] = validEntries.map(normalizeLogitBiasEntry).filter(Boolean);
    oai_settings.bias_preset_selected = name;

    addLogitBiasPresetOption(name);
    saveSettingsDebounced();
}

function onLogitBiasPresetExportClick() {
    if (!oai_settings.bias_preset_selected || Object.keys(oai_settings.bias_presets).length === 0) {
        return;
    }

    const presetJsonString = JSON.stringify(oai_settings.bias_presets[oai_settings.bias_preset_selected], null, 4);
    const presetFileName = `${oai_settings.bias_preset_selected}.json`;
    download(presetJsonString, presetFileName, 'application/json');
}

async function onDeletePresetClick() {
    const confirm = await callGenericPopup(t`Delete the preset? This action is irreversible and your current settings will be overwritten.`, POPUP_TYPE.CONFIRM);

    if (!confirm) {
        return;
    }

    const nameToDelete = oai_settings.preset_settings_openai;
    const value = openai_setting_names[oai_settings.preset_settings_openai];
    $(`#settings_preset_openai option[value="${value}"]`).remove();
    delete openai_setting_names[oai_settings.preset_settings_openai];
    oai_settings.preset_settings_openai = null;

    if (Object.keys(openai_setting_names).length) {
        oai_settings.preset_settings_openai = Object.keys(openai_setting_names)[0];
        const newValue = openai_setting_names[oai_settings.preset_settings_openai];
        $(`#settings_preset_openai option[value="${newValue}"]`).prop('selected', true);
        $('#settings_preset_openai').trigger('change');
    }

    const response = await fetch('/api/presets/delete', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ apiId: 'openai', name: nameToDelete }),
    });

    if (!response.ok) {
        toastr.warning(t`Preset was not deleted from server`);
    } else {
        toastr.success(t`Preset deleted`);
        await eventSource.emit(event_types.PRESET_DELETED, { apiId: 'openai', name: nameToDelete });
    }

    saveSettingsDebounced();
}

async function onLogitBiasPresetDeleteClick() {
    const value = await callGenericPopup(t`Delete the preset?`, POPUP_TYPE.CONFIRM);

    if (!value) {
        return;
    }

    $(`#openai_logit_bias_preset option[value="${oai_settings.bias_preset_selected}"]`).remove();
    delete oai_settings.bias_presets[oai_settings.bias_preset_selected];
    oai_settings.bias_preset_selected = null;

    if (Object.keys(oai_settings.bias_presets).length) {
        oai_settings.bias_preset_selected = Object.keys(oai_settings.bias_presets)[0];
        $(`#openai_logit_bias_preset option[value="${oai_settings.bias_preset_selected}"]`).prop('selected', true);
        $('#openai_logit_bias_preset').trigger('change');
    }

    biasCache = undefined;
    saveSettingsDebounced();
}

function restoreOpenAIPresetSelection(presetName = oai_settings.preset_settings_openai) {
    const presetValue = openai_setting_names?.[presetName];

    if (presetValue === undefined) {
        return;
    }

    oai_settings.preset_settings_openai = presetName;
    $('#settings_preset_openai').val(String(presetValue));
}

// Load OpenAI preset settings
function onSettingsPresetChange() {
    const changeGeneration = ++settingsPresetChangeGeneration;
    const presetNameBefore = oai_settings.preset_settings_openai;

    const presetName = $('#settings_preset_openai').find(':selected').text();
    oai_settings.preset_settings_openai = presetName;

    const preset = structuredClone(openai_settings[openai_setting_names[oai_settings.preset_settings_openai]]);

    migrateChatCompletionSettings(preset);
    maybeShowPresetConnectionBindingReminder(presetNameBefore, presetName);

    const updateInput = (selector, value) => $(selector).val(value).trigger('input', { source: 'preset' });
    const updateCheckbox = (selector, value) => $(selector).prop('checked', value).trigger('input', { source: 'preset' });

    // Allow subscribers to alter the preset before applying deltas
    return eventSource.emit(event_types.OAI_PRESET_CHANGED_BEFORE, {
        preset: preset,
        presetName: presetName,
        settingsToUpdate: settingsToUpdate,
        settings: oai_settings,
        savePreset: saveOpenAIPreset,
        presetNameBefore: presetNameBefore,
    }).finally(async () => {
        if (changeGeneration !== settingsPresetChangeGeneration) {
            return;
        }

        if (oai_settings.bind_preset_to_connection) {
            $('.model_custom_select').empty();
        }

        for (const [key, [selector, setting, isCheckbox, isConnection, isSampling]] of Object.entries(settingsToUpdate)) {
            if (isConnection && !oai_settings.bind_preset_to_connection) {
                continue;
            }

            if (isSampling && !shouldIncludeSamplingFieldsInPreset(oai_settings)) {
                continue;
            }

            // Extensions don't need UI updates and shouldn't fallback to current settings
            if (key === 'extensions') {
                oai_settings.extensions = preset.extensions || {};
                continue;
            }

            if (key === 'bias_preset_selected') {
                continue;
            }

            if (key === 'bias_presets') {
                applyLogitBiasPresetSettings(preset);
                continue;
            }

            if (preset[key] !== undefined) {
                if (isCheckbox) {
                    updateCheckbox(selector, preset[key]);
                } else {
                    updateInput(selector, preset[key]);
                }
                oai_settings[setting] = preset[key];
            }
        }

        syncMaxContextUnlockedControl(oai_settings);

        // These cannot be changed via preset if unbound to connection
        if (oai_settings.bind_preset_to_connection) {
            $('#chat_completion_source').trigger('change');
            $('#openrouter_providers_chat').trigger('change');
            $('#openrouter_quantizations_chat').trigger('change');
        }

        rebuildOpenAIModelSelect();
        updateOpenAIModelFavoriteButton();
        updateAdvancedFormattingVisibility();
        updateOpenAISettingsGroupVisibility();
        scheduleOpenAIUiRefresh();
        $('#openai_logit_bias_preset').trigger('change');

        await saveSettings();
        await eventSource.emit(event_types.OAI_PRESET_CHANGED_AFTER);
        await eventSource.emit(event_types.PRESET_CHANGED, { apiId: 'openai', name: presetName });
    });
}

function getMaxContextOpenAI(value) {
    if (isMaxContextUnlockedForSource()) {
        return unlocked_max;
    } else if (value.startsWith('gpt-5.4')) {
        return max_1mil;
    } else if (value.startsWith('gpt-5')) {
        return max_400k;
    } else if (value.includes('gpt-4.1')) {
        return max_1mil;
    } else if (value.includes('gpt-audio')) {
        return max_128k;
    } else if (value.startsWith('o1')) {
        return max_128k;
    } else if (value.startsWith('o4') || value.startsWith('o3')) {
        return max_200k;
    } else if (value.includes('chatgpt-4o-latest') || value.includes('gpt-4-turbo') || value.includes('gpt-4o') || value.includes('gpt-4-1106') || value.includes('gpt-4-0125') || value.includes('gpt-4-vision')) {
        return max_128k;
    } else if (value.includes('gpt-3.5-turbo-1106')) {
        return max_16k;
    } else if (['gpt-4', 'gpt-4-0314', 'gpt-4-0613'].includes(value)) {
        return max_8k;
    } else if (['gpt-4-32k', 'gpt-4-32k-0314', 'gpt-4-32k-0613'].includes(value)) {
        return max_32k;
    } else if (value.includes('gpt-realtime')) {
        return max_32k;
    } else if (['gpt-3.5-turbo-16k', 'gpt-3.5-turbo-16k-0613'].includes(value)) {
        return max_16k;
    } else if (value == 'code-davinci-002') {
        return max_8k;
    } else if (['text-curie-001', 'text-babbage-001', 'text-ada-001'].includes(value)) {
        return max_2k;
    } else {
        // default to gpt-3 (4095 tokens)
        return max_4k;
    }
}

/**
 * Get the maximum context size for the Mistral model
 * @param {string} model Model identifier
 * @param {boolean} isUnlocked Whether context limits are unlocked
 * @returns {number} Maximum context size in tokens
 */
function getMistralMaxContext(model, isUnlocked) {
    if (isUnlocked) {
        return unlocked_max;
    }

    if (Array.isArray(model_list) && model_list.length > 0) {
        const contextLength = model_list.find((record) => record.id === model)?.max_context_length;
        if (contextLength) {
            return contextLength;
        }
    }

    // Return context size if model found, otherwise default to 32k
    return max_32k;
}

/**
 * Get the maximum context size for the Groq model
 * @param {string} model Model identifier
 * @param {boolean} isUnlocked Whether context limits are unlocked
 * @returns {number} Maximum context size in tokens
 */
function getGroqMaxContext(model, isUnlocked) {
    if (isUnlocked) {
        return unlocked_max;
    }

    if (Array.isArray(model_list) && model_list.length > 0) {
        const contextLength = model_list.find((record) => record.id === model)?.context_window;
        if (contextLength) {
            return contextLength;
        }
    }

    const contextMap = {
        'gemma2-9b-it': max_8k,
        'llama-3.3-70b-versatile': max_128k,
        'llama-3.1-8b-instant': max_128k,
        'llama3-70b-8192': max_8k,
        'llama3-8b-8192': max_8k,
        'llama-guard-3-8b': max_8k,
        'mixtral-8x7b-32768': max_32k,
        'deepseek-r1-distill-llama-70b': max_128k,
        'llama-3.3-70b-specdec': max_8k,
        'llama-3.2-1b-preview': max_128k,
        'llama-3.2-3b-preview': max_128k,
        'llama-3.2-11b-vision-preview': max_128k,
        'llama-3.2-90b-vision-preview': max_128k,
        'qwen-2.5-32b': max_128k,
        'deepseek-r1-distill-qwen-32b': max_128k,
        'deepseek-r1-distill-llama-70b-specdec': max_128k,
        'mistral-saba-24b': max_32k,
        'meta-llama/llama-4-scout-17b-16e-instruct': max_128k,
        'meta-llama/llama-4-maverick-17b-128e-instruct': max_128k,
        'compound-beta': max_128k,
        'compound-beta-mini': max_128k,
        'qwen/qwen3-32b': max_128k,
    };

    // Return context size if model found, otherwise default to 128k
    return Object.entries(contextMap).find(([key]) => model.includes(key))?.[1] || max_128k;
}

/**
 * Get the maximum context size for the Z.AI model
 * @param {string} model Model identifier
 * @param {boolean} isUnlocked If context limits are unlocked
 * @returns {number} Maximum context size in tokens
 */
function getZaiMaxContext(model, isUnlocked) {
    if (isUnlocked) {
        return unlocked_max;
    }

    const contextMap = {
        'glm-5.1': max_200k,
        'glm-5-turbo': max_200k,
        'glm-5v-turbo': max_200k,
        'glm-5': max_200k,
        'glm-4.7': max_200k,
        'glm-4.7-flash': max_200k,
        'glm-4.7-flashx': max_200k,
        'glm-4.6v': max_128k,
        'glm-4.6v-flash': max_128k,
        'glm-4.6v-flashx': max_128k,
        'glm-4.6': max_200k,
        'glm-4.5': max_128k,
        'glm-4-32b-0414-128k': max_128k,
        'glm-4.5-air': max_128k,
        'glm-4.5v': max_64k,
        'autoglm-phone-multilingual': max_64k,
    };

    // Return context size if model found, otherwise default to 128k
    return Object.entries(contextMap).find(([key]) => model.includes(key))?.[1] || max_128k;
}

/**
 * Get the maximum context size for the SiliconFlow model
 * @param {string} model Model identifier
 * @param {boolean} isUnlocked Whether context limits are unlocked
 * @returns {number} Maximum context size in tokens
 */
function getSiliconflowMaxContext(model, isUnlocked) {
    if (isUnlocked) {
        return unlocked_max;
    }

    const contextMap = {
        'baidu/ERNIE-4.5-300B-A47B': max_128k,
        'ByteDance-Seed/Seed-OSS-36B-Instruct': max_256k,
        'deepseek-ai/DeepSeek-R1': max_128k,
        'deepseek-ai/DeepSeek-V3': max_128k,
        'deepseek-ai/DeepSeek-V3.1': max_128k,
        'deepseek-ai/DeepSeek-V3.1-Terminus': max_128k,
        'deepseek-ai/DeepSeek-V3.2-Exp': max_128k,
        'deepseek-ai/deepseek-vl2': max_4k,
        'inclusionAI/Ling-1T': max_128k,
        'inclusionAI/Ling-flash-2.0': max_128k,
        'inclusionAI/Ling-mini-2.0': max_128k,
        'inclusionAI/Ring-1T': max_128k,
        'inclusionAI/Ring-flash-2.0': max_128k,
        'meta-llama/Llama-3.3-70B-Instruct': max_32k,
        'meta-llama/Meta-Llama-3.1-8B-Instruct': max_32k,
        'MiniMaxAI/MiniMax-M1-80k': max_128k,
        'MiniMaxAI/MiniMax-M2': max_128k,
        'moonshotai/Kimi-K2-Instruct': max_128k,
        'moonshotai/Kimi-K2-Instruct-0905': max_256k,
        'moonshotai/Kimi-K2-Thinking': max_256k,
        'openai/gpt-oss-120b': max_128k,
        'openai/gpt-oss-20b': max_128k,
        'Qwen/Qwen3-235B-A22B-Instruct-2507': max_256k,
        'Qwen/Qwen3-235B-A22B-Thinking-2507': max_256k,
        'Qwen/Qwen3-30B-A3B-Instruct-2507': max_256k,
        'Qwen/Qwen3-30B-A3B-Thinking-2507': max_256k,
        'Qwen/Qwen3-VL-235B-A22B-Instruct': max_256k,
        'Qwen/Qwen3-VL-235B-A22B-Thinking': max_256k,
        'Qwen/Qwen3-VL-30B-A3B-Instruct': max_256k,
        'Qwen/Qwen3-VL-30B-A3B-Thinking': max_256k,
        'Qwen/Qwen3-VL-32B-Instruct': max_256k,
        'Qwen/Qwen3-VL-32B-Thinking': max_256k,
        'Qwen/Qwen3-VL-8B-Instruct': max_256k,
        'Qwen/Qwen3-VL-8B-Thinking': max_256k,
        'stepfun-ai/step3': max_64k,
        'tencent/Hunyuan-A13B-Instruct': max_128k,
        'zai-org/GLM-4.5': max_128k,
        'zai-org/GLM-4.5-Air': max_128k,
        'zai-org/GLM-4.5V': max_64k,
        'zai-org/GLM-4.6': max_200k,
    };

    // Return context size if model found, otherwise default to 32k
    return Object.entries(contextMap).find(([key]) => model.includes(key))?.[1] || max_32k;
}

/**
 * Get the maximum context size for the Moonshot model
 * @param {string} model Model identifier
 * @param {boolean} isUnlocked If context limits are unlocked
 * @returns {number} Maximum context size in tokens
 */
function getMoonshotMaxContext(model, isUnlocked) {
    if (isUnlocked) {
        return unlocked_max;
    }

    if (Array.isArray(model_list) && model_list.length > 0) {
        const modelInfo = model_list.find((record) => record.id === model);
        if (modelInfo?.context_length) {
            return modelInfo.context_length;
        }
    }

    const contextMap = {
        'moonshot-v1-8k': max_8k,
        'moonshot-v1-32k': max_32k,
        'moonshot-v1-128k': max_128k,
        'moonshot-v1-auto': max_128k,
        'moonshot-v1-8k-vision-preview': max_8k,
        'moonshot-v1-32k-vision-preview': max_32k,
        'moonshot-v1-128k-vision-preview': max_128k,
        'kimi-k2-0711-preview': max_32k,
        'kimi-latest': max_256k,
        'kimi-thinking-preview': max_32k,
        'kimi-k2.5': max_256k,
        'kimi-k2-0905-preview': max_256k,
        'kimi-k2-turbo-preview': max_256k,
        'kimi-k2-thinking': max_256k,
        'kimi-k2-thinking-turbo': max_256k,
    };

    // Return context size if model found, otherwise default to 32k
    return Object.entries(contextMap).find(([key]) => model.includes(key))?.[1] || max_32k;
}

/**
 * Get the maximum context size for the Fireworks model
 * @param {string} model Model identifier
 * @param {boolean} isUnlocked Whether context limits are unlocked
 * @returns {number} Maximum context size in tokens
 */
function getFireworksMaxContext(model, isUnlocked) {
    if (isUnlocked) {
        return unlocked_max;
    }

    // First check if model info is available from model_list
    if (Array.isArray(model_list) && model_list.length > 0) {
        const modelInfo = model_list.find((record) => record.id === model);
        if (modelInfo?.context_length) {
            return modelInfo.context_length;
        }
        if (modelInfo?.context_window) {
            return modelInfo.context_window;
        }
    }

    return max_32k;
}

/**
 * Get the maximum context size for the Chutes model
 * @param {string} model Model identifier
 * @param {boolean} isUnlocked Whether context limits are unlocked
 * @returns {number} Maximum context size in tokens
 */
function getChutesMaxContext(model, isUnlocked) {
    if (isUnlocked) {
        return unlocked_max;
    }

    if (Array.isArray(model_list)) {
        const modelInfo = model_list.find(m => m.id === model);
        if (modelInfo?.context_length) {
            return modelInfo.context_length;
        }
    }
    return max_8k;
}

/**
 * Get the maximum context size for the ElectronHub model
 * @param {string} model Model identifier
 * @param {boolean} isUnlocked Whether context limits are unlocked
 * @returns {number} Maximum context size in tokens
 */
function getElectronHubMaxContext(model, isUnlocked) {
    if (isUnlocked) {
        return unlocked_max;
    }

    if (Array.isArray(model_list)) {
        const modelInfo = model_list.find(m => m.id === model);
        if (modelInfo?.tokens) {
            return modelInfo.tokens;
        }
    }
    return max_128k;
}

/**
 * Get the maximum context size for the NanoGPT model
 * @param {string} model Model identifier
 * @param {boolean} isUnlocked Whether context limits are unlocked
 * @returns {number} Maximum context size in tokens
 */
function getNanoGptMaxContext(model, isUnlocked) {
    if (isUnlocked) {
        return unlocked_max;
    }

    if (Array.isArray(model_list)) {
        const modelInfo = model_list.find(m => m.id === model);
        if (modelInfo?.context_length) {
            return modelInfo.context_length;
        }
    }

    return max_128k;
}

function applyOpenAIContextMax(maxContext) {
    const normalizedMaxContext = Number(maxContext) || max_128k;

    $('#openai_max_context').attr('max', normalizedMaxContext);
    oai_settings.openai_max_context = Math.min(normalizedMaxContext, oai_settings.openai_max_context);
    $('#openai_max_context').val(oai_settings.openai_max_context).trigger('input');
    $('#openai_max_context_counter').attr('max', normalizedMaxContext);
}

function applyConfigurableContextLimit() {
    const maxContextUnlocked = isMaxContextUnlockedForSource(oai_settings);

    if (oai_settings.chat_completion_source === chat_completion_sources.OPENROUTER) {
        if (maxContextUnlocked) {
            applyOpenAIContextMax(unlocked_max);
        } else {
            const model = model_list.find(m => m.id == oai_settings.openrouter_model);
            applyOpenAIContextMax(model?.context_length || max_128k);
        }
        calculateOpenRouterCost();
        return true;
    }

    if (oai_settings.chat_completion_source === chat_completion_sources.NANOGPT) {
        applyOpenAIContextMax(getNanoGptMaxContext(oai_settings.nanogpt_model, maxContextUnlocked));
        return true;
    }

    return false;
}

async function onModelChange() {
    biasCache = undefined;
    let value = String($(this).val() || '');

    // Skip setting the context size for sources that get it from external APIs
    const hasModelsLoaded = Array.isArray(model_list) && model_list.length > 0;
    const maxContextUnlocked = syncMaxContextUnlockedControl(oai_settings);

    if ($(this).is('#claude_model_id')) {
        if (value) {
            oai_settings.claude_model = value;
            $('#model_claude_select').val(value);
        }
    }
    if ($(this).is('#ai21_model_id')) {
        if (value) {
            oai_settings.ai21_model = value;
            $('#model_ai21_select').val(value);
        }
    }
    if ($(this).is('#cohere_model_id')) {
        if (value) {
            oai_settings.cohere_model = value;
            $('#model_cohere_select').val(value);
        }
    }
    if ($(this).is('#perplexity_model_id')) {
        if (value) {
            oai_settings.perplexity_model = value;
            $('#model_perplexity_select').val(value);
        }
    }
    if ($(this).is('#zai_model_id')) {
        if (value) {
            oai_settings.zai_model = value;
            $('#model_zai_select').val(value);
        }
    }
    if ($(this).is('#vertexai_model_id')) {
        if (value) {
            oai_settings.vertexai_model = value;
            $('#model_vertexai_select').val(value);
        }
    }

    if ($(this).is('#model_claude_select')) {
        if (value.includes('-v')) {
            value = value.replace('-v', '-');
        } else if (value === '' || value === 'claude-2') {
            value = default_settings.claude_model;
        }
        console.log('Claude model changed to', value);
        oai_settings.claude_model = value;
        $('#model_claude_select').val(oai_settings.claude_model);
        $('#claude_model_id').val(value);
    }

    if ($(this).is('#model_openai_select')) {
        console.log('OpenAI model changed to', value);
        oai_settings.openai_model = value;
        syncOpenAIModelIdInput(value);
    }

    if ($(this).is('#model_openrouter_select')) {
        if (!value || !hasModelsLoaded) {
            console.debug('Null OR model selected. Ignoring.');
            return;
        }

        console.log('OpenRouter model changed to', value);
        oai_settings.openrouter_model = value;
        syncOpenRouterProvidersForModel(value, '#openrouter_providers_chat');
    }

    if ($(this).is('#model_ai21_select')) {
        if (value === '' || value.startsWith('j2-')) {
            value = 'jamba-large';
            $('#model_ai21_select').val(value);
        }

        console.log('AI21 model changed to', value);
        oai_settings.ai21_model = value;
        $('#ai21_model_id').val(value);
    }

    if ($(this).is('#model_google_select')) {
        if (!value) {
            console.debug('Null Google model selected. Ignoring.');
            return;
        }

        console.log('Google model changed to', value);
        oai_settings.google_model = value;
        $('#makersuite_model_id').val(value);
    }

    if ($(this).is('#model_vertexai_select')) {
        console.log('Vertex AI model changed to', value);
        oai_settings.vertexai_model = value;
        $('#vertexai_model_id').val(value);
    }

    if ($(this).is('#model_mistralai_select')) {
        if (!value || !hasModelsLoaded) {
            console.debug('Null MistralAI model selected. Ignoring.');
            return;
        }
        console.log('MistralAI model changed to', value);
        oai_settings.mistralai_model = value;
        $('#model_mistralai_select').val(oai_settings.mistralai_model);
    }

    if ($(this).is('#model_cohere_select')) {
        console.log('Cohere model changed to', value);
        oai_settings.cohere_model = value;
        $('#cohere_model_id').val(value);
    }

    if ($(this).is('#model_perplexity_select')) {
        console.log('Perplexity model changed to', value);
        oai_settings.perplexity_model = value;
        $('#perplexity_model_id').val(value);
    }

    if ($(this).is('#model_groq_select')) {
        if (!value || !hasModelsLoaded) {
            console.debug('Null Groq model selected. Ignoring.');
            return;
        }
        console.log('Groq model changed to', value);
        oai_settings.groq_model = value;
    }

    if ($(this).is('#model_siliconflow_select')) {
        if (!value) {
            console.debug('Null SiliconFlow model selected. Ignoring.');
            return;
        }
        console.log('SiliconFlow model changed to', value);
        oai_settings.siliconflow_model = value;
    }

    if ($(this).is('#model_minimax_select')) {
        if (!value) {
            console.debug('Null MiniMax model selected. Ignoring.');
            return;
        }
        console.log('MiniMax model changed to', value);
        oai_settings.minimax_model = value;
    }

    if ($(this).is('#model_electronhub_select')) {
        if (!value || !hasModelsLoaded) {
            console.debug('Null ElectronHub model selected. Ignoring.');
            return;
        }
        console.log('ElectronHub model changed to', value);
        oai_settings.electronhub_model = value;
    }

    if ($(this).is('#model_chutes_select')) {
        if (!value || !hasModelsLoaded) {
            console.debug('Null Chutes model selected. Ignoring.');
            return;
        }
        console.log('Chutes model changed to', value);
        oai_settings.chutes_model = value;
    }

    if ($(this).is('#model_nanogpt_select')) {
        if (!value || !hasModelsLoaded) {
            console.debug('Null NanoGPT model selected. Ignoring.');
            return;
        }

        console.log('NanoGPT model changed to', value);
        oai_settings.nanogpt_model = value;
    }

    if ($(this).is('#model_workers_ai_select')) {
        if (!value || !hasModelsLoaded) {
            console.debug('Null Workers AI model selected. Ignoring.');
            return;
        }
        console.log('Workers AI model changed to', value);
        oai_settings.workers_ai_model = value;
    }

    if ($(this).is('#model_deepseek_select')) {
        if (!value) {
            console.debug('Null DeepSeek model selected. Ignoring.');
            return;
        }

        console.log('DeepSeek model changed to', value);
        oai_settings.deepseek_model = value;
    }

    if (value && $(this).is('#model_custom_select')) {
        console.log('Custom model changed to', value);
        oai_settings.custom_model = value;
        $('#custom_model_id').val(value).trigger('input');
    }

    if (value && $(this).is('#model_pollinations_select')) {
        console.log('Pollinations model changed to', value);
        oai_settings.pollinations_model = value;
    }

    if ($(this).is('#model_aimlapi_select')) {
        if (!value || !hasModelsLoaded) {
            console.debug('Null AI/ML model selected. Ignoring.');
            return;
        }
        console.log('AI/ML model changed to', value);
        oai_settings.aimlapi_model = value;
    }

    if ($(this).is('#model_xai_select')) {
        if (!value) {
            console.debug('Null XAI model selected. Ignoring.');
            return;
        }
        console.log('XAI model changed to', value);
        oai_settings.xai_model = value;
    }

    if ($(this).is('#model_moonshot_select')) {
        if (!value || !hasModelsLoaded) {
            console.debug('Null Moonshot model selected. Ignoring.');
            return;
        }
        console.log('Moonshot model changed to', value);
        oai_settings.moonshot_model = value;
    }

    if ($(this).is('#model_fireworks_select')) {
        if (!value || !hasModelsLoaded) {
            console.debug('Null Fireworks model selected. Ignoring.');
            return;
        }
        console.log('Fireworks model changed to', value);
        oai_settings.fireworks_model = value;
    }

    if ($(this).is('#model_cometapi_select')) {
        if (!value) {
            console.debug('Null CometAPI model selected. Ignoring.');
            return;
        }
        console.log('CometAPI model changed to', value);
        oai_settings.cometapi_model = value;
    }

    if ($(this).is('#azure_openai_model')) {
        if (!value) {
            console.debug('Null Azure OpenAI model selected. Ignoring.');
            return;
        }
        oai_settings.azure_openai_model = value;
    }

    if ($(this).is('#model_zai_select')) {
        console.log('ZAI model changed to', value);
        oai_settings.zai_model = value;
        $('#zai_model_id').val(value);
    }

    if ([chat_completion_sources.MAKERSUITE, chat_completion_sources.VERTEXAI].includes(oai_settings.chat_completion_source)) {
        if (maxContextUnlocked) {
            $('#openai_max_context').attr('max', max_2mil);
        } else if (value.includes('gemini-2.5-flash-image')) {
            $('#openai_max_context').attr('max', max_32k);
        } else if (value.includes('gemini-3-pro-image')) {
            $('#openai_max_context').attr('max', max_64k);
        } else if (/gemini-3[.\d]*-(pro|flash)/.test(value) || /gemini-2.5-(pro|flash)/.test(value) || /gemini-2.0-(pro|flash)/.test(value)) {
            $('#openai_max_context').attr('max', max_1mil);
        } else if (value.includes('gemini-exp') || value.includes('learnlm-2.0-flash') || value.includes('gemini-robotics')) {
            $('#openai_max_context').attr('max', max_1mil);
        } else if (value.includes('gemma-3-27b-it')) {
            $('#openai_max_context').attr('max', max_128k);
        } else if (value.includes('gemma-3n-e4b-it')) {
            $('#openai_max_context').attr('max', max_8k);
        } else if (value.includes('gemma-3')) {
            $('#openai_max_context').attr('max', max_32k);
        } else {
            $('#openai_max_context').attr('max', max_32k);
        }
        let makersuite_max_temp = (value.includes('vision') || value.includes('ultra') || value.includes('gemma')) ? 1.0 : 2.0;
        oai_settings.temp_openai = Math.min(makersuite_max_temp, oai_settings.temp_openai);
        $('#temp_openai').attr('max', makersuite_max_temp).val(oai_settings.temp_openai).trigger('input');
        oai_settings.openai_max_context = Math.min(Number($('#openai_max_context').attr('max')), oai_settings.openai_max_context);
        $('#openai_max_context').val(oai_settings.openai_max_context).trigger('input');
    }

    if (oai_settings.chat_completion_source == chat_completion_sources.OPENROUTER) {
        applyConfigurableContextLimit();

        if (value && (value.includes('claude') || value.includes('palm-2'))) {
            oai_settings.temp_openai = Math.min(claude_max_temp, oai_settings.temp_openai);
            $('#temp_openai').attr('max', claude_max_temp).val(oai_settings.temp_openai).trigger('input');
        } else {
            oai_settings.temp_openai = Math.min(oai_max_temp, oai_settings.temp_openai);
            $('#temp_openai').attr('max', oai_max_temp).val(oai_settings.temp_openai).trigger('input');
        }
    }

    if (oai_settings.chat_completion_source == chat_completion_sources.CLAUDE) {
        if (maxContextUnlocked) {
            $('#openai_max_context').attr('max', unlocked_max);
        } else if (/^claude-(sonnet-4-(?:[5-9]|\d{2,})|opus-4-(?:[6-9]|\d{2,})|fable)/.test(value)) { // SillyBunny: |fable — claude-fable-5 has a 1M context window
            $('#openai_max_context').attr('max', max_1mil);
        } else if (/^claude-(3|opus|haiku|sonnet)/.test(value)) {
            $('#openai_max_context').attr('max', max_200k);
        } else {
            $('#openai_max_context').attr('max', max_200k);
        }

        oai_settings.openai_max_context = Math.min(oai_settings.openai_max_context, Number($('#openai_max_context').attr('max')));
        $('#openai_max_context').val(oai_settings.openai_max_context).trigger('input');

        $('#openai_reverse_proxy').attr('placeholder', 'https://api.anthropic.com/v1');

        oai_settings.temp_openai = Math.min(claude_max_temp, oai_settings.temp_openai);
        $('#temp_openai').attr('max', claude_max_temp).val(oai_settings.temp_openai).trigger('input');
    }

    if ([chat_completion_sources.AZURE_OPENAI, chat_completion_sources.OPENAI, chat_completion_sources.OPENAI_RESPONSES].includes(oai_settings.chat_completion_source)) {
        $('#openai_max_context').attr('max', getMaxContextOpenAI(value));
        oai_settings.openai_max_context = Math.min(oai_settings.openai_max_context, Number($('#openai_max_context').attr('max')));
        $('#openai_max_context').val(oai_settings.openai_max_context).trigger('input');

        $('#openai_reverse_proxy').attr('placeholder', 'https://api.openai.com/v1');

        oai_settings.temp_openai = Math.min(oai_max_temp, oai_settings.temp_openai);
        $('#temp_openai').attr('max', oai_max_temp).val(oai_settings.temp_openai).trigger('input');
    }

    if (oai_settings.chat_completion_source === chat_completion_sources.MISTRALAI) {
        const maxContext = getMistralMaxContext(oai_settings.mistralai_model, maxContextUnlocked);
        $('#openai_max_context').attr('max', maxContext);
        oai_settings.openai_max_context = Math.min(oai_settings.openai_max_context, Number($('#openai_max_context').attr('max')));
        $('#openai_max_context').val(oai_settings.openai_max_context).trigger('input');
        oai_settings.temp_openai = Math.min(mistral_max_temp, oai_settings.temp_openai);
        $('#temp_openai').attr('max', mistral_max_temp).val(oai_settings.temp_openai).trigger('input');
    }

    if (oai_settings.chat_completion_source === chat_completion_sources.COHERE) {
        if (maxContextUnlocked) {
            $('#openai_max_context').attr('max', unlocked_max);
        } else if (['command-light-nightly', 'command-light', 'command'].includes(oai_settings.cohere_model)) {
            $('#openai_max_context').attr('max', max_4k);
        } else if (oai_settings.cohere_model.includes('command-r') || ['c4ai-aya-23', 'c4ai-aya-expanse-32b', 'command-nightly', 'command-a-vision-07-2025'].includes(oai_settings.cohere_model)) {
            $('#openai_max_context').attr('max', max_128k);
        } else if (['command-a-03-2025'].includes(oai_settings.cohere_model)) {
            $('#openai_max_context').attr('max', max_256k);
        } else if (['c4ai-aya-23-8b', 'c4ai-aya-expanse-8b'].includes(oai_settings.cohere_model)) {
            $('#openai_max_context').attr('max', max_8k);
        } else if (['c4ai-aya-vision-8b', 'c4ai-aya-vision-32b'].includes(oai_settings.cohere_model)) {
            $('#openai_max_context').attr('max', max_16k);
        } else {
            $('#openai_max_context').attr('max', max_4k);
        }
        oai_settings.openai_max_context = Math.min(Number($('#openai_max_context').attr('max')), oai_settings.openai_max_context);
        $('#openai_max_context').val(oai_settings.openai_max_context).trigger('input');
        $('#temp_openai').attr('max', claude_max_temp).val(oai_settings.temp_openai).trigger('input');
    }

    if (oai_settings.chat_completion_source === chat_completion_sources.PERPLEXITY) {
        if (maxContextUnlocked) {
            $('#openai_max_context').attr('max', unlocked_max);
        } else if (['sonar', 'sonar-reasoning', 'sonar-reasoning-pro', 'r1-1776'].includes(oai_settings.perplexity_model)) {
            $('#openai_max_context').attr('max', 127000);
        } else if (['sonar-pro'].includes(oai_settings.perplexity_model)) {
            $('#openai_max_context').attr('max', 200000);
        } else if (oai_settings.perplexity_model.includes('llama-3.1')) {
            const isOnline = oai_settings.perplexity_model.includes('online');
            const contextSize = isOnline ? 128 * 1024 - 4000 : 128 * 1024;
            $('#openai_max_context').attr('max', contextSize);
        } else {
            $('#openai_max_context').attr('max', max_128k);
        }
        oai_settings.openai_max_context = Math.min(Number($('#openai_max_context').attr('max')), oai_settings.openai_max_context);
        $('#openai_max_context').val(oai_settings.openai_max_context).trigger('input');
        oai_settings.temp_openai = Math.min(oai_max_temp, oai_settings.temp_openai);
        $('#temp_openai').attr('max', oai_max_temp).val(oai_settings.temp_openai).trigger('input');
    }

    if (oai_settings.chat_completion_source == chat_completion_sources.GROQ) {
        const maxContext = getGroqMaxContext(oai_settings.groq_model, maxContextUnlocked);
        $('#openai_max_context').attr('max', maxContext);
        oai_settings.openai_max_context = Math.min(Number($('#openai_max_context').attr('max')), oai_settings.openai_max_context);
        $('#openai_max_context').val(oai_settings.openai_max_context).trigger('input');
        oai_settings.temp_openai = Math.min(oai_max_temp, oai_settings.temp_openai);
        $('#temp_openai').attr('max', oai_max_temp).val(oai_settings.temp_openai).trigger('input');
    }

    if (oai_settings.chat_completion_source == chat_completion_sources.AI21) {
        if (maxContextUnlocked) {
            $('#openai_max_context').attr('max', unlocked_max);
        } else if (oai_settings.ai21_model.startsWith('jamba-')) {
            $('#openai_max_context').attr('max', max_256k);
        }

        oai_settings.openai_max_context = Math.min(Number($('#openai_max_context').attr('max')), oai_settings.openai_max_context);
        $('#openai_max_context').val(oai_settings.openai_max_context).trigger('input');
        $('#temp_openai').attr('max', oai_max_temp).val(oai_settings.temp_openai).trigger('input');
    }

    if (oai_settings.chat_completion_source == chat_completion_sources.CUSTOM) {
        $('#openai_max_context').attr('max', unlocked_max);
        oai_settings.openai_max_context = Math.min(Number($('#openai_max_context').attr('max')), oai_settings.openai_max_context);
        $('#openai_max_context').val(oai_settings.openai_max_context).trigger('input');
        $('#temp_openai').attr('max', oai_max_temp).val(oai_settings.temp_openai).trigger('input');
    }

    if (oai_settings.chat_completion_source == chat_completion_sources.CHUTES) {
        const maxContext = getChutesMaxContext(oai_settings.chutes_model, maxContextUnlocked);
        $('#openai_max_context').attr('max', maxContext);
        oai_settings.openai_max_context = Math.min(Number($('#openai_max_context').attr('max')), oai_settings.openai_max_context);
        $('#openai_max_context').val(oai_settings.openai_max_context).trigger('input');
        oai_settings.temp_openai = Math.min(oai_max_temp, oai_settings.temp_openai);
        $('#temp_openai').attr('max', oai_max_temp).val(oai_settings.temp_openai).trigger('input');

        calculateChutesCost();
    }

    if (oai_settings.chat_completion_source == chat_completion_sources.ELECTRONHUB) {
        const maxContext = getElectronHubMaxContext(oai_settings.electronhub_model, maxContextUnlocked);
        $('#openai_max_context').attr('max', maxContext);
        oai_settings.openai_max_context = Math.min(Number($('#openai_max_context').attr('max')), oai_settings.openai_max_context);
        $('#openai_max_context').val(oai_settings.openai_max_context).trigger('input');
        oai_settings.temp_openai = Math.min(oai_max_temp, oai_settings.temp_openai);
        $('#temp_openai').attr('max', oai_max_temp).val(oai_settings.temp_openai).trigger('input');

        calculateElectronHubCost();
    }

    if (oai_settings.chat_completion_source === chat_completion_sources.NANOGPT) {
        applyConfigurableContextLimit();
        oai_settings.temp_openai = Math.min(oai_max_temp, oai_settings.temp_openai);
        $('#temp_openai').attr('max', oai_max_temp).val(oai_settings.temp_openai).trigger('input');
    }

    if (oai_settings.chat_completion_source === chat_completion_sources.WORKERS_AI) {
        if (maxContextUnlocked) {
            $('#openai_max_context').attr('max', unlocked_max);
        } else {
            const model = model_list.find(m => m.id === oai_settings.workers_ai_model);
            const ctxProp = Array.isArray(model?.properties) && model.properties.find(p => p.property_id === 'context_window');
            const contextLength = ctxProp ? Number(ctxProp.value) : max_8k;
            $('#openai_max_context').attr('max', contextLength || max_8k);
        }

        oai_settings.openai_max_context = Math.min(Number($('#openai_max_context').attr('max')), oai_settings.openai_max_context);
        $('#openai_max_context').val(oai_settings.openai_max_context).trigger('input');
        $('#temp_openai').attr('max', oai_max_temp).val(oai_settings.temp_openai).trigger('input');
    }

    if (oai_settings.chat_completion_source === chat_completion_sources.MINIMAX) {
        const maxContext = oai_settings.minimax_model === 'M2-her' ? 65536 : 204800;
        $('#openai_max_context').attr('max', maxContext);
        oai_settings.openai_max_context = Math.min(Number($('#openai_max_context').attr('max')), oai_settings.openai_max_context);
        $('#openai_max_context').val(oai_settings.openai_max_context).trigger('input');
        oai_settings.temp_openai = Math.min(claude_max_temp, oai_settings.temp_openai);
        $('#temp_openai').attr('max', claude_max_temp).val(oai_settings.temp_openai).trigger('input');
    }

    if (oai_settings.chat_completion_source === chat_completion_sources.POLLINATIONS) {
        if (maxContextUnlocked) {
            $('#openai_max_context').attr('max', unlocked_max);
        } else {
            $('#openai_max_context').attr('max', max_128k);
        }

        oai_settings.openai_max_context = Math.min(Number($('#openai_max_context').attr('max')), oai_settings.openai_max_context);
        $('#openai_max_context').val(oai_settings.openai_max_context).trigger('input');
        $('#temp_openai').attr('max', oai_max_temp).val(oai_settings.temp_openai).trigger('input');
    }

    if (oai_settings.chat_completion_source === chat_completion_sources.DEEPSEEK) {
        if (maxContextUnlocked) {
            $('#openai_max_context').attr('max', unlocked_max);
        } else if (['deepseek-reasoner', 'deepseek-chat', 'deepseek-v4'].includes(oai_settings.deepseek_model)) {
            $('#openai_max_context').attr('max', max_128k);
        } else if (oai_settings.deepseek_model == 'deepseek-coder') {
            $('#openai_max_context').attr('max', max_16k);
        } else {
            $('#openai_max_context').attr('max', max_64k);
        }

        oai_settings.openai_max_context = Math.min(Number($('#openai_max_context').attr('max')), oai_settings.openai_max_context);
        $('#openai_max_context').val(oai_settings.openai_max_context).trigger('input');
        $('#temp_openai').attr('max', oai_max_temp).val(oai_settings.temp_openai).trigger('input');
    }

    if (oai_settings.chat_completion_source === chat_completion_sources.COMETAPI) {
        $('#openai_max_context').attr('max', maxContextUnlocked ? unlocked_max : max_128k);
        oai_settings.openai_max_context = Math.min(Number($('#openai_max_context').attr('max')), oai_settings.openai_max_context);
        $('#openai_max_context').val(oai_settings.openai_max_context).trigger('input');
        $('#temp_openai').attr('max', oai_max_temp).val(oai_settings.temp_openai).trigger('input');
    }

    if (oai_settings.chat_completion_source === chat_completion_sources.XAI) {
        if (maxContextUnlocked) {
            $('#openai_max_context').attr('max', unlocked_max);
        } else if (oai_settings.xai_model.includes('grok-2-vision')) {
            $('#openai_max_context').attr('max', max_32k);
        } else if (oai_settings.xai_model.includes('grok-4-fast')) {
            $('#openai_max_context').attr('max', max_2mil);
        } else if (oai_settings.xai_model.includes('grok-4')) {
            $('#openai_max_context').attr('max', max_256k);
        } else if (oai_settings.xai_model.includes('grok-code')) {
            $('#openai_max_context').attr('max', max_256k);
        } else {
            // grok 2 and grok 3
            $('#openai_max_context').attr('max', max_128k);
        }

        oai_settings.openai_max_context = Math.min(Number($('#openai_max_context').attr('max')), oai_settings.openai_max_context);
        $('#openai_max_context').val(oai_settings.openai_max_context).trigger('input');
        $('#temp_openai').attr('max', oai_max_temp).val(oai_settings.temp_openai).trigger('input');
    }

    if (oai_settings.chat_completion_source === chat_completion_sources.AIMLAPI) {
        let maxContext;
        if (maxContextUnlocked) {
            maxContext = unlocked_max;
        } else {
            const model = model_list.find(m => m.id === oai_settings.aimlapi_model);
            maxContext = (model?.info?.contextLength ?? model?.context_length) || max_32k;
            console.log('[AI/ML API] Model CTX:', model?.info?.contextLength);
        }

        $('#openai_max_context')
            .prop('max', maxContext)
            .val(Math.min(Number(oai_settings.openai_max_context), maxContext))
            .trigger('input');

        $('#temp_openai')
            .prop('max', oai_max_temp)
            .val(Number(oai_settings.temp_openai))
            .trigger('input');

        oai_settings.openai_max_context = Number($('#openai_max_context').val());
        oai_settings.temp_openai = Number($('#temp_openai').val());
    }

    if (oai_settings.chat_completion_source === chat_completion_sources.COHERE) {
        oai_settings.pres_pen_openai = Math.min(Math.max(0, oai_settings.pres_pen_openai), 1);
        $('#pres_pen_openai').attr('max', 1).attr('min', 0).val(oai_settings.pres_pen_openai).trigger('input');
        oai_settings.freq_pen_openai = Math.min(Math.max(0, oai_settings.freq_pen_openai), 1);
        $('#freq_pen_openai').attr('max', 1).attr('min', 0).val(oai_settings.freq_pen_openai).trigger('input');
    } else {
        $('#pres_pen_openai').attr('max', 2).attr('min', -2).val(oai_settings.pres_pen_openai).trigger('input');
        $('#freq_pen_openai').attr('max', 2).attr('min', -2).val(oai_settings.freq_pen_openai).trigger('input');
    }

    if (oai_settings.chat_completion_source === chat_completion_sources.MOONSHOT) {
        const maxContext = getMoonshotMaxContext(oai_settings.moonshot_model, maxContextUnlocked);
        $('#openai_max_context').attr('max', maxContext);
        oai_settings.openai_max_context = Math.min(Number($('#openai_max_context').attr('max')), oai_settings.openai_max_context);
        $('#openai_max_context').val(oai_settings.openai_max_context).trigger('input');
        oai_settings.temp_openai = Math.min(claude_max_temp, oai_settings.temp_openai);
        $('#temp_openai').attr('max', claude_max_temp).val(oai_settings.temp_openai).trigger('input');
    }

    if (oai_settings.chat_completion_source === chat_completion_sources.FIREWORKS) {
        const maxContext = getFireworksMaxContext(oai_settings.fireworks_model, maxContextUnlocked);
        $('#openai_max_context').attr('max', maxContext);
        oai_settings.openai_max_context = Math.min(Number($('#openai_max_context').attr('max')), oai_settings.openai_max_context);
        $('#openai_max_context').val(oai_settings.openai_max_context).trigger('input');
        oai_settings.temp_openai = Math.min(oai_max_temp, oai_settings.temp_openai);
        $('#temp_openai').attr('max', oai_max_temp).val(oai_settings.temp_openai).trigger('input');
    }

    if (oai_settings.chat_completion_source === chat_completion_sources.SILICONFLOW) {
        const maxContext = getSiliconflowMaxContext(oai_settings.siliconflow_model, maxContextUnlocked);
        $('#openai_max_context').attr('max', maxContext);
        oai_settings.openai_max_context = Math.min(Number($('#openai_max_context').attr('max')), oai_settings.openai_max_context);
        $('#openai_max_context').val(oai_settings.openai_max_context).trigger('input');
        oai_settings.temp_openai = Math.min(oai_max_temp, oai_settings.temp_openai);
        $('#temp_openai').attr('max', oai_max_temp).val(oai_settings.temp_openai).trigger('input');
    }

    if (oai_settings.chat_completion_source == chat_completion_sources.ZAI) {
        const maxContext = getZaiMaxContext(oai_settings.zai_model, maxContextUnlocked);
        $('#openai_max_context').attr('max', maxContext);
        oai_settings.openai_max_context = Math.min(Number($('#openai_max_context').attr('max')), oai_settings.openai_max_context);
        $('#openai_max_context').val(oai_settings.openai_max_context).trigger('input');
        oai_settings.temp_openai = Math.min(claude_max_temp, oai_settings.temp_openai);
        $('#temp_openai').attr('max', claude_max_temp).val(oai_settings.temp_openai).trigger('input');
    }

    $('#openai_max_context_counter').attr('max', Number($('#openai_max_context').attr('max')));

    saveSettingsDebounced();
    updateFeatureSupportFlags();
    updateAdvancedFormattingVisibility();
    updateOpenAIModelFavoriteButton();
    refreshModelIdSearchControlsForSource(oai_settings.chat_completion_source);
    updateModelIdSearchFavoriteButtons();
    maybeApplyModelSamplingProfile();
    eventSource.emit(event_types.CHATCOMPLETION_MODEL_CHANGED, value);
}

async function onOpenrouterModelSortChange() {
    await getStatusOpen();
}

async function onChutesModelSortChange() {
    await getStatusOpen();
}

async function onElectronHubModelSortChange() {
    await getStatusOpen();
}

async function onNewPresetClick() {
    const name = await Popup.show.input(t`Preset name:`, t`Hint: Use a character/group name to bind preset to a specific chat.`, oai_settings.preset_settings_openai);

    if (!name) {
        return;
    }

    await saveOpenAIPreset(name, oai_settings);
}

function onReverseProxyInput() {
    oai_settings.reverse_proxy = String($(this).val());
    $('.reverse_proxy_warning').toggle(oai_settings.reverse_proxy != '');
    saveSettingsDebounced();
}

async function onConnectButtonClick(e) {
    e.stopPropagation();

    /** @type {Object.<string, {key: string, selector: string, proxy?: boolean, keyless?: boolean}>} */
    const apiSourceConfig = {
        [chat_completion_sources.OPENROUTER]: { key: SECRET_KEYS.OPENROUTER, selector: '#api_key_openrouter', proxy: false },
        [chat_completion_sources.MAKERSUITE]: { key: SECRET_KEYS.MAKERSUITE, selector: '#api_key_makersuite', proxy: true },
        [chat_completion_sources.CLAUDE]: { key: SECRET_KEYS.CLAUDE, selector: '#api_key_claude', proxy: true },
        [chat_completion_sources.OPENAI]: { key: SECRET_KEYS.OPENAI, selector: '#api_key_openai', proxy: true },
        [chat_completion_sources.OPENAI_RESPONSES]: { key: SECRET_KEYS.OPENAI, selector: '#api_key_openai', proxy: true },
        [chat_completion_sources.AI21]: { key: SECRET_KEYS.AI21, selector: '#api_key_ai21', proxy: false },
        [chat_completion_sources.MISTRALAI]: { key: SECRET_KEYS.MISTRALAI, selector: '#api_key_mistralai', proxy: true },
        [chat_completion_sources.CUSTOM]: { key: SECRET_KEYS.CUSTOM, selector: '#api_key_custom', proxy: false, keyless: true },
        [chat_completion_sources.COHERE]: { key: SECRET_KEYS.COHERE, selector: '#api_key_cohere', proxy: false },
        [chat_completion_sources.PERPLEXITY]: { key: SECRET_KEYS.PERPLEXITY, selector: '#api_key_perplexity', proxy: false },
        [chat_completion_sources.GROQ]: { key: SECRET_KEYS.GROQ, selector: '#api_key_groq', proxy: false },
        [chat_completion_sources.SILICONFLOW]: { key: SECRET_KEYS.SILICONFLOW, selector: '#api_key_siliconflow', proxy: false },
        [chat_completion_sources.ELECTRONHUB]: { key: SECRET_KEYS.ELECTRONHUB, selector: '#api_key_electronhub', proxy: false },
        [chat_completion_sources.NANOGPT]: { key: SECRET_KEYS.NANOGPT, selector: '#api_key_nanogpt', proxy: false },
        [chat_completion_sources.DEEPSEEK]: { key: SECRET_KEYS.DEEPSEEK, selector: '#api_key_deepseek', proxy: true },
        [chat_completion_sources.XAI]: { key: SECRET_KEYS.XAI, selector: '#api_key_xai', proxy: true },
        [chat_completion_sources.AIMLAPI]: { key: SECRET_KEYS.AIMLAPI, selector: '#api_key_aimlapi', proxy: false },
        [chat_completion_sources.MOONSHOT]: { key: SECRET_KEYS.MOONSHOT, selector: '#api_key_moonshot', proxy: true },
        [chat_completion_sources.FIREWORKS]: { key: SECRET_KEYS.FIREWORKS, selector: '#api_key_fireworks', proxy: false },
        [chat_completion_sources.COMETAPI]: { key: SECRET_KEYS.COMETAPI, selector: '#api_key_cometapi', proxy: false },
        [chat_completion_sources.AZURE_OPENAI]: { key: SECRET_KEYS.AZURE_OPENAI, selector: '#api_key_azure_openai', proxy: false },
        [chat_completion_sources.ZAI]: { key: SECRET_KEYS.ZAI, selector: '#api_key_zai', proxy: true },
        [chat_completion_sources.CHUTES]: { key: SECRET_KEYS.CHUTES, selector: '#api_key_chutes', proxy: false },
        [chat_completion_sources.POLLINATIONS]: { key: SECRET_KEYS.POLLINATIONS, selector: '#api_key_pollinations', proxy: false },
        [chat_completion_sources.WORKERS_AI]: { key: SECRET_KEYS.WORKERS_AI, selector: '#api_key_workers_ai', proxy: false },
        [chat_completion_sources.MINIMAX]: { key: SECRET_KEYS.MINIMAX, selector: '#api_key_minimax', proxy: false },
    };

    // Vertex AI Express version - use API key
    if (oai_settings.vertexai_auth_mode === 'express') {
        apiSourceConfig[chat_completion_sources.VERTEXAI] = { key: SECRET_KEYS.VERTEXAI, selector: '#api_key_vertexai', proxy: true };
    }

    // Vertex AI Full version - use service account
    if (oai_settings.chat_completion_source === chat_completion_sources.VERTEXAI && oai_settings.vertexai_auth_mode === 'full') {
        if (!secret_state[SECRET_KEYS.VERTEXAI_SERVICE_ACCOUNT]) {
            toastr.error(t`Service Account JSON is required for Vertex AI full version. Please validate and save your Service Account JSON.`);
            return;
        }
    }

    // Other generic configs
    const config = apiSourceConfig[oai_settings.chat_completion_source];
    if (config) {
        const apiKey = String($(config.selector).val()).trim();
        if (apiKey.length) {
            await writeSecret(config.key, apiKey);
        }

        if (!secret_state[config.key] && (!config.proxy || !oai_settings.reverse_proxy) && !config.keyless) {
            console.log(`No secret key saved for ${oai_settings.chat_completion_source}`);
            return;
        }
    }

    startStatusLoading();
    saveSettingsDebounced();
    await getStatusOpen();
}

function toggleChatCompletionForms() {
    if (oai_settings.chat_completion_source == chat_completion_sources.CLAUDE) {
        $('#model_claude_select').trigger('change');
    } else if (oai_settings.chat_completion_source == chat_completion_sources.OPENAI || oai_settings.chat_completion_source == chat_completion_sources.OPENAI_RESPONSES) {
        rebuildOpenAIModelSelect();
        if (oai_settings.show_external_models && (!Array.isArray(model_list) || model_list.length == 0)) {
            const hasSelectedModel = $('#model_openai_select').find(`option[value="${CSS.escape(oai_settings.openai_model)}"]`).length > 0;
            if (hasSelectedModel) {
                $('#model_openai_select').trigger('change');
            }
        } else {
            $('#model_openai_select').trigger('change');
        }
    } else if (oai_settings.chat_completion_source == chat_completion_sources.MAKERSUITE) {
        refreshModelIdSearchControlsForSource(chat_completion_sources.MAKERSUITE);
        $('#model_google_select').val(oai_settings.google_model).trigger('change');
    } else if (oai_settings.chat_completion_source == chat_completion_sources.VERTEXAI) {
        $('#model_vertexai_select').trigger('change');
        // Update UI based on authentication mode
        onVertexAIAuthModeChange.call($('#vertexai_auth_mode')[0]);
    } else if (oai_settings.chat_completion_source == chat_completion_sources.OPENROUTER) {
        $('#model_openrouter_select').trigger('change');
    } else if (oai_settings.chat_completion_source == chat_completion_sources.AI21) {
        $('#model_ai21_select').trigger('change');
    } else if (oai_settings.chat_completion_source == chat_completion_sources.MISTRALAI) {
        $('#model_mistralai_select').trigger('change');
    } else if (oai_settings.chat_completion_source == chat_completion_sources.COHERE) {
        $('#model_cohere_select').trigger('change');
    } else if (oai_settings.chat_completion_source == chat_completion_sources.PERPLEXITY) {
        $('#model_perplexity_select').trigger('change');
    } else if (oai_settings.chat_completion_source == chat_completion_sources.GROQ) {
        $('#model_groq_select').trigger('change');
    } else if (oai_settings.chat_completion_source == chat_completion_sources.CHUTES) {
        $('#model_chutes_select').trigger('change');
    } else if (oai_settings.chat_completion_source == chat_completion_sources.SILICONFLOW) {
        $('#model_siliconflow_select').trigger('change');
    } else if (oai_settings.chat_completion_source == chat_completion_sources.MINIMAX) {
        $('#model_minimax_select').trigger('change');
    } else if (oai_settings.chat_completion_source == chat_completion_sources.ELECTRONHUB) {
        $('#model_electronhub_select').trigger('change');
    } else if (oai_settings.chat_completion_source == chat_completion_sources.NANOGPT) {
        $('#model_nanogpt_select').trigger('change');
    } else if (oai_settings.chat_completion_source == chat_completion_sources.CUSTOM) {
        $('#model_custom_select').trigger('change');
    } else if (oai_settings.chat_completion_source == chat_completion_sources.DEEPSEEK) {
        $('#model_deepseek_select').trigger('change');
    } else if (oai_settings.chat_completion_source == chat_completion_sources.AIMLAPI) {
        $('#model_aimlapi_select').trigger('change');
    } else if (oai_settings.chat_completion_source == chat_completion_sources.XAI) {
        $('#model_xai_select').trigger('change');
    } else if (oai_settings.chat_completion_source == chat_completion_sources.POLLINATIONS) {
        $('#model_pollinations_select').trigger('change');
    } else if (oai_settings.chat_completion_source == chat_completion_sources.MOONSHOT) {
        $('#model_moonshot_select').trigger('change');
    } else if (oai_settings.chat_completion_source == chat_completion_sources.FIREWORKS) {
        $('#model_fireworks_select').trigger('change');
    } else if (oai_settings.chat_completion_source == chat_completion_sources.COMETAPI) {
        $('#model_cometapi_select').trigger('change');
    } else if (oai_settings.chat_completion_source == chat_completion_sources.AZURE_OPENAI) {
        $('#azure_openai_model').trigger('change');
    } else if (oai_settings.chat_completion_source == chat_completion_sources.ZAI) {
        $('#model_zai_select').trigger('change');
    } else if (oai_settings.chat_completion_source == chat_completion_sources.WORKERS_AI) {
        $('#model_workers_ai_select').trigger('change');
    }

    $('[data-source]').each(function () {
        const mode = $(this).data('source-mode');
        const validSources = $(this).data('source').split(',');
        const effectiveSource = oai_settings.chat_completion_source === chat_completion_sources.OPENAI_RESPONSES ? chat_completion_sources.OPENAI : oai_settings.chat_completion_source;
        const matchesSource = validSources.includes(oai_settings.chat_completion_source) || validSources.includes(effectiveSource);
        $(this).toggle(mode !== 'except' ? matchesSource : !matchesSource);
    });

    setToolReasoningControls();
    updateAdvancedFormattingVisibility();
    updateOpenAISettingsGroupVisibility();
    updateOpenAIModelFavoriteButton();
}

async function testApiConnection() {
    // Check if the previous request is still in progress
    if (is_send_press) {
        toastr.info(t`Please wait for the previous request to complete.`);
        return;
    }

    try {
        const reply = await sendOpenAIRequest('quiet', [{ 'role': 'user', 'content': 'Hi' }], new AbortController().signal);
        console.log(reply);
        toastr.success(t`API connection successful!`);
    } catch (err) {
        toastr.error(t`Could not get a reply from API. Check your connection settings / API key and try again.`);
    }
}

export function reconnectOpenAi() {
    if (main_api == 'openai') {
        setOnlineStatus('no_connection');
        resultCheckStatus();
        $('#api_button_openai').trigger('click');
    }
}

function onProxyPasswordShowClick() {
    const $input = $('#openai_proxy_password');
    const type = $input.attr('type') === 'password' ? 'text' : 'password';
    $input.attr('type', type);
    $(this).toggleClass('fa-eye-slash fa-eye');
}

async function onCustomizeParametersClick() {
    const template = $(await renderTemplateAsync('customEndpointAdditionalParameters'));

    template.find('#custom_include_body').val(oai_settings.custom_include_body).on('input', function () {
        oai_settings.custom_include_body = String($(this).val());
        saveSettingsDebounced();
    });

    template.find('#custom_exclude_body').val(oai_settings.custom_exclude_body).on('input', function () {
        oai_settings.custom_exclude_body = String($(this).val());
        saveSettingsDebounced();
    });

    template.find('#custom_include_headers').val(oai_settings.custom_include_headers).on('input', function () {
        oai_settings.custom_include_headers = String($(this).val());
        saveSettingsDebounced();
    });

    const syncCustomReasoningPopup = () => {
        template.find('#custom_reasoning_preset').val(oai_settings.custom_reasoning_preset);
        template.find('#custom_reasoning_param_name').val(oai_settings.custom_reasoning_param_name);
        template.find('#custom_reasoning_param_format').val(oai_settings.custom_reasoning_param_format);
        template.find('#custom_reasoning_enabled_value').val(oai_settings.custom_reasoning_enabled_value);
        template.find('#custom_reasoning_disabled_value').val(oai_settings.custom_reasoning_disabled_value);

        const format = String(oai_settings.custom_reasoning_param_format ?? custom_reasoning_param_formats.OPENAI);
        const showToggleValues = [custom_reasoning_param_formats.STRING, custom_reasoning_param_formats.THINKING_OBJECT].includes(format);
        template.find('.sb-custom-reasoning-toggle-values').toggle(showToggleValues);
    };

    const applyCustomReasoningPreset = (preset, { preserveValues = false } = {}) => {
        setCustomReasoningPreset(preset, { preserveValues });
        syncCustomReasoningPopup();
        saveSettingsDebounced();
    };

    template.find('#custom_reasoning_preset').on('input', function () {
        applyCustomReasoningPreset(String($(this).val()));
    });

    template.find('#custom_reasoning_param_name').on('input', function () {
        oai_settings.custom_reasoning_preset = custom_reasoning_preset_types.CUSTOM;
        oai_settings.custom_reasoning_param_name = String($(this).val()).trim();
        syncCustomReasoningPopup();
        saveSettingsDebounced();
    });

    template.find('#custom_reasoning_param_format').on('input', function () {
        oai_settings.custom_reasoning_preset = custom_reasoning_preset_types.CUSTOM;
        oai_settings.custom_reasoning_param_format = String($(this).val());
        syncCustomReasoningPopup();
        saveSettingsDebounced();
    });

    template.find('#custom_reasoning_enabled_value').on('input', function () {
        oai_settings.custom_reasoning_preset = custom_reasoning_preset_types.CUSTOM;
        oai_settings.custom_reasoning_enabled_value = String($(this).val()).trim();
        syncCustomReasoningPopup();
        saveSettingsDebounced();
    });

    template.find('#custom_reasoning_disabled_value').on('input', function () {
        oai_settings.custom_reasoning_preset = custom_reasoning_preset_types.CUSTOM;
        oai_settings.custom_reasoning_disabled_value = String($(this).val()).trim();
        syncCustomReasoningPopup();
        saveSettingsDebounced();
    });

    syncCustomReasoningPopup();

    await callGenericPopup(template, POPUP_TYPE.TEXT, '', { wide: true, large: true });
}

/**
 * Check if the model supports image inlining
 * @returns {boolean} True if the model supports image inlining
 */
export function isImageInliningSupported() {
    if (main_api !== 'openai') {
        return false;
    }

    if (!oai_settings.media_inlining) {
        return false;
    }

    // gultra just isn't being offered as multimodal, thanks google.
    const visionSupportedModels = [
        // OpenAI
        'chatgpt-4o-latest',
        'gpt-4-turbo',
        'gpt-4-vision',
        'gpt-4.1',
        'gpt-4.5-preview',
        'gpt-4o',
        'gpt-5',
        'o1',
        'o3',
        'o4-mini',
        // Claude
        'claude-3',
        'claude-fable', // SillyBunny: claude-fable-5 vision support
        'claude-opus-4',
        'claude-sonnet-4',
        'claude-haiku-4',
        // Cohere
        'c4ai-aya-vision',
        'command-a-vision',
        // Google AI Studio
        'gemini-2.0',
        'gemini-2.5',
        'gemini-3',
        'gemini-exp-1206',
        'learnlm',
        'gemini-robotics',
        // MistralAI
        'mistral-small-2503',
        'mistral-small-2506',
        'mistral-small-latest',
        'mistral-medium-latest',
        'mistral-medium-2505',
        'mistral-medium-2508',
        'pixtral',
        // xAI (Grok)
        'grok-4',
        'grok-2-vision',
        // Moonshot
        'moonshot-v1-8k-vision-preview',
        'moonshot-v1-32k-vision-preview',
        'moonshot-v1-128k-vision-preview',
        'kimi-k2.5',
        'kimi-latest',
        // Z.AI (GLM)
        'glm-5v-turbo',
        'glm-4.5v',
        'glm-4.6v',
        'autoglm-phone',
        // SiliconFlow
        'Qwen/Qwen3-VL-32B-Instruct',
        'Qwen/Qwen3-VL-8B-Instruct',
        'Qwen/Qwen3-VL-235B-A22B-Instruct',
        'Qwen/Qwen3-VL-30B-A3B-Instruct',
        'zai-org/GLM-4.5V',
    ];

    switch (oai_settings.chat_completion_source) {
        case chat_completion_sources.OPENAI:
        case chat_completion_sources.OPENAI_RESPONSES:
        case chat_completion_sources.AZURE_OPENAI: {
            const modelToCheck = oai_settings.chat_completion_source === chat_completion_sources.AZURE_OPENAI
                ? oai_settings.azure_openai_model
                : oai_settings.openai_model;
            return visionSupportedModels.some(model =>
                modelToCheck.includes(model)
                && ['gpt-4-turbo-preview', 'o1-mini', 'o3-mini'].some(x => !modelToCheck.includes(x)),
            );
        }
        case chat_completion_sources.MAKERSUITE:
            return visionSupportedModels.some(model => oai_settings.google_model.includes(model));
        case chat_completion_sources.VERTEXAI:
            return visionSupportedModels.some(model => oai_settings.vertexai_model.includes(model));
        case chat_completion_sources.CLAUDE:
            return visionSupportedModels.some(model => oai_settings.claude_model.includes(model));
        case chat_completion_sources.OPENROUTER:
            return (Array.isArray(model_list) && model_list.find(m => m.id === oai_settings.openrouter_model)?.architecture?.input_modalities?.includes('image'));
        case chat_completion_sources.CUSTOM:
            return true;
        case chat_completion_sources.MISTRALAI:
            return (Array.isArray(model_list) && model_list.find(m => m.id === oai_settings.mistralai_model)?.capabilities?.vision);
        case chat_completion_sources.COHERE:
            return visionSupportedModels.some(model => oai_settings.cohere_model.includes(model));
        case chat_completion_sources.XAI:
            // TODO: xAI's /models endpoint doesn't return modality info
            return visionSupportedModels.some(model => oai_settings.xai_model.includes(model));
        case chat_completion_sources.AIMLAPI:
            return (Array.isArray(model_list) && model_list.find(m => m.id === oai_settings.aimlapi_model)?.features?.includes('openai/chat-completion.vision'));
        case chat_completion_sources.CHUTES:
            return (Array.isArray(model_list) && model_list.find(m => m.id === oai_settings.chutes_model)?.input_modalities?.includes('image'));
        case chat_completion_sources.ELECTRONHUB:
            return (Array.isArray(model_list) && model_list.find(m => m.id === oai_settings.electronhub_model)?.metadata?.vision);
        case chat_completion_sources.POLLINATIONS:
            return (Array.isArray(model_list) && model_list.find(m => m.id === oai_settings.pollinations_model)?.input_modalities?.includes('image'));
        case chat_completion_sources.COMETAPI:
            return true;
        case chat_completion_sources.MOONSHOT:
            return (Array.isArray(model_list) && model_list.find(m => m.id === oai_settings.moonshot_model)?.supports_image_in);
        case chat_completion_sources.NANOGPT:
            return (Array.isArray(model_list) && model_list.find(m => m.id === oai_settings.nanogpt_model)?.capabilities?.vision);
        case chat_completion_sources.ZAI:
            return visionSupportedModels.some(model => oai_settings.zai_model.includes(model));
        case chat_completion_sources.SILICONFLOW:
            return visionSupportedModels.some(model => oai_settings.siliconflow_model.includes(model));
        case chat_completion_sources.WORKERS_AI: {
            const waiModel = Array.isArray(model_list) && model_list.find(m => m.id === oai_settings.workers_ai_model);
            return Boolean(waiModel && Array.isArray(waiModel.properties) && waiModel.properties.some(p => p.property_id === 'vision' && p.value === 'true'));
        }
        default:
            return false;
    }
}

/**
 * Check if the model supports video inlining
 * @returns {boolean} True if the model supports video inlining
 */
export function isVideoInliningSupported() {
    if (main_api !== 'openai') {
        return false;
    }

    if (!oai_settings.media_inlining) {
        return false;
    }

    const videoSupportedModels = [
        // Gemini
        'gemini-2.0',
        'gemini-2.5',
        'gemini-exp-1206',
        'gemini-3',
        // Z.AI (GLM)
        'glm-5v-turbo',
        'glm-4.5v',
        'glm-4.6v',
    ];

    switch (oai_settings.chat_completion_source) {
        case chat_completion_sources.MAKERSUITE:
            return videoSupportedModels.some(model => oai_settings.google_model.includes(model));
        case chat_completion_sources.VERTEXAI:
            return videoSupportedModels.some(model => oai_settings.vertexai_model.includes(model));
        case chat_completion_sources.OPENROUTER:
            return (Array.isArray(model_list) && model_list.find(m => m.id === oai_settings.openrouter_model)?.architecture?.input_modalities?.includes('video'));
        case chat_completion_sources.ZAI:
            return videoSupportedModels.some(model => oai_settings.zai_model.includes(model));
        default:
            return false;
    }
}

/**
 * Check if the model supports video inlining
 * @returns {boolean} True if the model supports audio inlining
 */
export function isAudioInliningSupported() {
    if (main_api !== 'openai') {
        return false;
    }

    if (!oai_settings.media_inlining) {
        return false;
    }

    const audioSupportedModels = [
        'gemini-2.0',
        'gemini-2.5',
        'gemini-3',
        'gemini-exp-1206',
        'gpt-4o-audio',
        'gpt-4o-realtime',
        'gpt-4o-mini-audio',
        'gpt-4o-mini-realtime',
        'gpt-audio',
        'gpt-realtime',
    ];

    switch (oai_settings.chat_completion_source) {
        case chat_completion_sources.OPENAI:
        case chat_completion_sources.OPENAI_RESPONSES:
            return audioSupportedModels.some(model => oai_settings.openai_model.includes(model));
        case chat_completion_sources.MAKERSUITE:
            return audioSupportedModels.some(model => oai_settings.google_model.includes(model));
        case chat_completion_sources.VERTEXAI:
            return audioSupportedModels.some(model => oai_settings.vertexai_model.includes(model));
        case chat_completion_sources.OPENROUTER:
            return (Array.isArray(model_list) && model_list.find(m => m.id === oai_settings.openrouter_model)?.architecture?.input_modalities?.includes('audio'));
        case chat_completion_sources.CUSTOM:
            return true;
        default:
            return false;
    }
}

/**
 * Gets the tool-call reasoning forwarding mode.
 * @param {ChatCompletionSettings} settings Settings object to use
 * @returns {string} Reasoning forwarding mode
 */
function getToolReasoningMode(settings = oai_settings) {
    const mode = String(settings.tool_reasoning_mode ?? '');
    if (Object.values(tool_reasoning_modes).includes(mode)) {
        return mode;
    }
    return tool_reasoning_modes.DISABLED;
}

/**
 * Gets the effective tool-call reasoning forwarding mode.
 * Interleaved thinking requires explicit reasoning requests.
 * @param {ChatCompletionSettings} settings Settings object to use
 * @returns {string} Effective reasoning forwarding mode
 */
function getEffectiveToolReasoningMode(settings = oai_settings) {
    if (!shouldRequestReasoning(settings)) {
        return tool_reasoning_modes.DISABLED;
    }

    return getToolReasoningMode(settings);
}

/**
 * Check if the model supports encrypted reasoning signatures.
 * @param {ChatCompletionSettings} settings Settings object to use
 * @returns {boolean} True if reasoning signatures should be included in the request
 */
export function isReasoningSignatureSupported(settings = oai_settings) {
    // If it's Vertex AI or Makersuite, that's OK - convertGooglePrompt() will handle it later
    const isGoogle = [chat_completion_sources.VERTEXAI, chat_completion_sources.MAKERSUITE].includes(settings.chat_completion_source);
    // Need a more crunchy check for OpenRouter: look for Gemini models
    const isOpenRouterGemini = settings.chat_completion_source === chat_completion_sources.OPENROUTER && /google\/gemini/i.test(settings.openrouter_model);
    return isGoogle || isOpenRouterGemini;
}

/**
 * Proxy stuff
 */
export function loadProxyPresets(settings) {
    let proxyPresets = settings.proxies;
    if (!Array.isArray(proxyPresets) || proxyPresets.length === 0) {
        proxyPresets = proxies.map(preset => normalizeProxyPreset(preset));
    } else {
        proxyPresets = proxyPresets.map(preset => normalizeProxyPreset(preset));
    }

    proxies = proxyPresets;
    selected_proxy = normalizeProxyPreset(settings.selected_proxy || selected_proxy);
    if (!proxies.some(preset => preset.name === selected_proxy.name)) {
        proxies.push(selected_proxy);
    }

    $('#openai_proxy_preset').empty();

    for (const preset of proxies) {
        appendProxyPresetOption(preset);
    }
    $('#openai_proxy_preset').val(selected_proxy.name);
    setProxyPreset(selected_proxy.name, selected_proxy.url, selected_proxy.password, selected_proxy.source, { applySource: false, silent: true });
}

function normalizeProxyPreset(preset) {
    return normalizeReverseProxyPreset(preset, { supportedSources: REVERSE_PROXY_SUPPORTED_SOURCES });
}

function getReverseProxySourceLabel(source) {
    return REVERSE_PROXY_SOURCE_LABELS[source] || '';
}

function getReverseProxyPresetOptionText(preset) {
    const normalizedPreset = normalizeProxyPreset(preset);
    const sourceLabel = getReverseProxySourceLabel(normalizedPreset.source);

    return sourceLabel ? `${normalizedPreset.name} [${sourceLabel}]` : normalizedPreset.name;
}

function getProxyPresetOption(name) {
    return $('#openai_proxy_preset option').filter((_, option) => option.value === name);
}

function appendProxyPresetOption(preset) {
    const normalizedPreset = normalizeProxyPreset(preset);
    const option = document.createElement('option');
    option.innerText = getReverseProxyPresetOptionText(normalizedPreset);
    option.value = normalizedPreset.name;
    option.selected = normalizedPreset.name === 'None';
    $('#openai_proxy_preset').append(option);
}

function updateProxyPresetOption(preset) {
    const option = getProxyPresetOption(preset.name);

    if (option.length > 0) {
        option.text(getReverseProxyPresetOptionText(preset));
    } else {
        appendProxyPresetOption(preset);
    }
}

function setProxyPreset(name, url, password, source = '', { applySource = true, silent = false } = {}) {
    const normalizedPreset = normalizeProxyPreset({ name, url, password, source });
    const preset = proxies.find(p => p.name === normalizedPreset.name);
    if (preset) {
        preset.url = normalizedPreset.url;
        preset.password = normalizedPreset.password;
        preset.source = normalizedPreset.source;
        selected_proxy = preset;
    } else {
        let new_proxy = normalizedPreset;
        proxies.push(new_proxy);
        selected_proxy = new_proxy;
    }

    $('#openai_reverse_proxy_name').val(normalizedPreset.name);
    oai_settings.reverse_proxy = normalizedPreset.url;
    $('#openai_reverse_proxy').val(oai_settings.reverse_proxy);
    oai_settings.proxy_password = normalizedPreset.password;
    $('#openai_proxy_password').val(oai_settings.proxy_password);
    $('#openai_proxy_source').val(normalizedPreset.source || '');

    const shouldSwitchSource = applySource && normalizedPreset.source && normalizedPreset.source !== oai_settings.chat_completion_source;

    // SillyBunny: when applying a bound preset during settings load (silent), switch the backend
    // and refresh source-dependent UI without triggering a reconnect or the proxy confirmation modal,
    // which would otherwise block the startup loader and freeze the settings panel. See #304 regression.
    if (silent) {
        if (shouldSwitchSource) {
            oai_settings.chat_completion_source = normalizedPreset.source;
            $('#chat_completion_source').val(normalizedPreset.source);
            toggleChatCompletionForms();
        }
        return;
    }

    if (shouldSwitchSource) {
        $('#chat_completion_source').val(normalizedPreset.source).trigger('change');
    } else {
        reconnectOpenAi();
    }
}

function onProxyPresetChange() {
    const value = String($('#openai_proxy_preset').find(':selected').val());
    const selectedPreset = proxies.find(preset => preset.name === value);

    if (selectedPreset) {
        setProxyPreset(selectedPreset.name, selectedPreset.url, selectedPreset.password, selectedPreset.source);
    } else {
        console.error(t`Proxy preset '${value}' not found in proxies array.`);
    }
    saveSettingsDebounced();
}

// SillyBunny: reverse direction of the reverse-proxy backend binding. Selecting a bound preset already
// switches the backend (forward); this keeps the binding two-way by selecting a preset bound to the
// newly chosen backend. Guarded against re-entrancy so it can't feed back into the source change handler.
let isSyncingProxyBinding = false;

/**
 * Selects the reverse proxy preset bound to the given Chat Completion source, when one exists.
 * @param {string} source Chat Completion source value
 */
function syncProxyPresetToBoundSource(source) {
    if (isSyncingProxyBinding) {
        return;
    }
    if (!source || !REVERSE_PROXY_SUPPORTED_SOURCES.includes(source)) {
        return;
    }
    // Already on a preset bound to this source; nothing to switch.
    if (selected_proxy && selected_proxy.name !== 'None' && selected_proxy.source === source) {
        return;
    }
    const boundPreset = proxies.find(preset => preset.name !== 'None' && preset.source === source);
    if (!boundPreset || boundPreset.name === selected_proxy?.name) {
        return;
    }

    isSyncingProxyBinding = true;
    try {
        $('#openai_proxy_preset').val(boundPreset.name);
        // applySource: false avoids re-triggering the source change we are already handling;
        // silent: true applies the proxy URL/password without a redundant reconnect.
        setProxyPreset(boundPreset.name, boundPreset.url, boundPreset.password, boundPreset.source, { applySource: false, silent: true });
        saveSettingsDebounced();
    } finally {
        isSyncingProxyBinding = false;
    }
}

$('#save_proxy').on('click', async function () {
    const presetName = $('#openai_reverse_proxy_name').val();
    const reverseProxy = $('#openai_reverse_proxy').val();
    const proxyPassword = $('#openai_proxy_password').val();
    const preset = buildReverseProxyPresetForSave({
        name: presetName,
        url: reverseProxy,
        password: proxyPassword,
        source: $('#openai_proxy_source').val() || '',
    }, { supportedSources: REVERSE_PROXY_SUPPORTED_SOURCES });

    setProxyPreset(preset.name, preset.url, preset.password, preset.source);
    saveSettingsDebounced();
    toastr.success(t`Proxy Saved`);
    updateProxyPresetOption(preset);
    $('#openai_proxy_preset').val(preset.name);
});

$('#delete_proxy').on('click', async function () {
    const presetName = $('#openai_reverse_proxy_name').val();
    const index = proxies.findIndex(preset => preset.name === presetName);

    if (index !== -1) {
        proxies.splice(index, 1);
        getProxyPresetOption(presetName).remove();

        if (proxies.length > 0) {
            const newIndex = Math.max(0, index - 1);
            selected_proxy = proxies[newIndex];
        } else {
            selected_proxy = normalizeProxyPreset({ name: 'None', url: '', password: '', source: '' });
        }

        setProxyPreset(selected_proxy.name, selected_proxy.url, selected_proxy.password, selected_proxy.source);

        saveSettingsDebounced();
        $('#openai_proxy_preset').val(selected_proxy.name);
        toastr.success(t`Proxy Deleted`);
    } else {
        toastr.error(t`Could not find proxy with name '${presetName}'`);
    }
});

function runProxyCallback(_, value) {
    if (!value) {
        return selected_proxy?.name || '';
    }

    const proxyNames = proxies.map(preset => preset.name);
    const fuse = new Fuse(proxyNames);
    const result = fuse.search(value);

    if (result.length === 0) {
        toastr.warning(t`Proxy preset '${value}' not found`);
        return '';
    }

    const foundName = result[0].item;
    $('#openai_proxy_preset').val(foundName).trigger('change');
    return foundName;
}

function getSlashCommandStringValue(value) {
    return String(value ?? '');
}

function getSlashCommandBooleanValue(value, commandName) {
    if (isTrueBoolean(value)) {
        return true;
    }

    if (isFalseBoolean(value)) {
        return false;
    }

    throw new Error(t`Invalid value "${value}" for /${commandName}. Use true or false.`);
}

function getSlashCommandEnumValue(value, validValues, commandName) {
    if (!validValues.includes(value)) {
        throw new Error(t`Invalid value "${value}" for /${commandName}. Valid values are: ${validValues.join(', ')}`);
    }

    return value;
}

function hasSlashCommandValue(args, value) {
    return isTrueBoolean(String(args?.force ?? 'false'))
        || args?._hasUnnamedArgument
        || String(value ?? '').trim().length > 0;
}

function syncCustomReasoningSettingControls() {
    $('#custom_reasoning_preset').val(oai_settings.custom_reasoning_preset);
    $('#custom_reasoning_param_name').val(oai_settings.custom_reasoning_param_name);
    $('#custom_reasoning_param_format').val(oai_settings.custom_reasoning_param_format);
    $('#custom_reasoning_enabled_value').val(oai_settings.custom_reasoning_enabled_value);
    $('#custom_reasoning_disabled_value').val(oai_settings.custom_reasoning_disabled_value);

    const format = String(oai_settings.custom_reasoning_param_format ?? custom_reasoning_param_formats.OPENAI);
    const showToggleValues = [custom_reasoning_param_formats.STRING, custom_reasoning_param_formats.THINKING_OBJECT].includes(format);
    $('.sb-custom-reasoning-toggle-values').toggle(showToggleValues);
}

function setCustomReasoningPreset(preset, { preserveValues = false } = {}) {
    oai_settings.custom_reasoning_preset = preset;

    if (preset !== custom_reasoning_preset_types.CUSTOM) {
        const presetConfig = getCustomReasoningPresetConfig(preset);
        oai_settings.custom_reasoning_param_name = presetConfig.paramName;
        oai_settings.custom_reasoning_param_format = presetConfig.format;
        if (!preserveValues) {
            oai_settings.custom_reasoning_enabled_value = presetConfig.enabledValue;
            oai_settings.custom_reasoning_disabled_value = presetConfig.disabledValue;
        }
    }

    syncCustomReasoningSettingControls();
}

function markCustomReasoningPreset() {
    oai_settings.custom_reasoning_preset = custom_reasoning_preset_types.CUSTOM;
    syncCustomReasoningSettingControls();
}

function markCustomReasoningPresetForManualCommand(args) {
    if (!isTrueBoolean(String(args?.quiet ?? 'false'))) {
        markCustomReasoningPreset();
    }
}

function runBooleanChatCompletionSettingCallback(commandName, settingName, selector, onChange = null) {
    return (args, value) => {
        const stringValue = getSlashCommandStringValue(value).trim();
        if (!hasSlashCommandValue(args, value)) {
            return String(Boolean(oai_settings[settingName]));
        }

        oai_settings[settingName] = getSlashCommandBooleanValue(stringValue, commandName);
        $(selector).prop('checked', oai_settings[settingName]);
        onChange?.();
        saveSettingsDebounced();
        return String(oai_settings[settingName]);
    };
}

function runEnumChatCompletionSettingCallback(commandName, settingName, selector, validValues, onChange = null) {
    return (args, value) => {
        const stringValue = getSlashCommandStringValue(value).trim();
        if (!hasSlashCommandValue(args, value)) {
            return getSlashCommandStringValue(oai_settings[settingName]);
        }

        oai_settings[settingName] = getSlashCommandEnumValue(stringValue, validValues, commandName);
        $(selector).val(oai_settings[settingName]);
        onChange?.(args);
        saveSettingsDebounced();
        return getSlashCommandStringValue(oai_settings[settingName]);
    };
}

function runStringChatCompletionSettingCallback(commandName, settingName, selector, onChange = null, validValues = null, normalizeValue = value => value) {
    return (args, value) => {
        if (!hasSlashCommandValue(args, value)) {
            return getSlashCommandStringValue(oai_settings[settingName]);
        }

        const stringValue = normalizeValue(getSlashCommandStringValue(value).trim());
        if (Array.isArray(validValues) && stringValue) {
            getSlashCommandEnumValue(stringValue, validValues, commandName);
        }

        oai_settings[settingName] = stringValue;
        $(selector).val(oai_settings[settingName]);
        onChange?.(args);
        saveSettingsDebounced();
        return getSlashCommandStringValue(oai_settings[settingName]);
    };
}

const REQUEST_IMAGE_RESOLUTION_VALUES = ['', '1K', '2K', '4K'];
const REQUEST_IMAGE_ASPECT_RATIO_VALUES = ['', '1:1', '9:16', '16:9', '3:4', '4:3', '3:2', '2:3', '5:4', '4:5', '21:9'];

function registerChatCompletionProfileSlashCommand({ name, callback, description, typeList = [ARGUMENT_TYPE.STRING], enumList = [], forceEnum = false }) {
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name,
        callback,
        returns: t`current value`,
        namedArgumentList: [
            SlashCommandNamedArgument.fromProps({
                name: 'quiet',
                description: t`suppress UI side effects where supported`,
                typeList: [ARGUMENT_TYPE.BOOLEAN],
                defaultValue: 'false',
            }),
        ],
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description,
                typeList,
                enumList,
                forceEnum,
            }),
        ],
        helpString: `Sets the Chat Completion ${description}. Gets the current value if no argument is provided.`,
    }));
}

function registerChatCompletionProfileSlashCommands() {
    registerChatCompletionProfileSlashCommand({
        name: 'request-reasoning',
        callback: runBooleanChatCompletionSettingCallback('request-reasoning', 'show_thoughts', '#openai_show_thoughts', setToolReasoningControls),
        description: 'request model reasoning setting',
        typeList: [ARGUMENT_TYPE.BOOLEAN],
    });
    registerChatCompletionProfileSlashCommand({
        name: 'reasoning-effort',
        callback: runEnumChatCompletionSettingCallback('reasoning-effort', 'reasoning_effort', '#openai_reasoning_effort', Object.values(reasoning_effort_types)),
        description: 'reasoning effort',
        enumList: Object.values(reasoning_effort_types),
        forceEnum: true,
    });
    registerChatCompletionProfileSlashCommand({
        name: 'verbosity',
        callback: runEnumChatCompletionSettingCallback('verbosity', 'verbosity', '#openai_verbosity', Object.values(verbosity_levels)),
        description: 'verbosity',
        enumList: Object.values(verbosity_levels),
        forceEnum: true,
    });
    registerChatCompletionProfileSlashCommand({
        name: 'enable-web-search',
        callback: runBooleanChatCompletionSettingCallback('enable-web-search', 'enable_web_search', '#openai_enable_web_search', calculateOpenRouterCost),
        description: 'web search request setting',
        typeList: [ARGUMENT_TYPE.BOOLEAN],
    });
    registerChatCompletionProfileSlashCommand({
        name: 'request-images',
        callback: runBooleanChatCompletionSettingCallback('request-images', 'request_images', '#openai_request_images'),
        description: 'inline image request setting',
        typeList: [ARGUMENT_TYPE.BOOLEAN],
    });
    registerChatCompletionProfileSlashCommand({
        name: 'request-image-resolution',
        callback: runStringChatCompletionSettingCallback('request-image-resolution', 'request_image_resolution', '#request_image_resolution', null, REQUEST_IMAGE_RESOLUTION_VALUES, value => value.toLowerCase() === 'auto' ? '' : value),
        description: 'requested image resolution',
        enumList: ['auto', ...REQUEST_IMAGE_RESOLUTION_VALUES.filter(Boolean)],
        forceEnum: true,
    });
    registerChatCompletionProfileSlashCommand({
        name: 'request-image-aspect-ratio',
        callback: runStringChatCompletionSettingCallback('request-image-aspect-ratio', 'request_image_aspect_ratio', '#request_image_aspect_ratio', null, REQUEST_IMAGE_ASPECT_RATIO_VALUES, value => value.toLowerCase() === 'auto' ? '' : value),
        description: 'requested image aspect ratio',
        enumList: ['auto', ...REQUEST_IMAGE_ASPECT_RATIO_VALUES.filter(Boolean)],
        forceEnum: true,
    });
    registerChatCompletionProfileSlashCommand({
        name: 'custom-reasoning-preset',
        callback: runEnumChatCompletionSettingCallback('custom-reasoning-preset', 'custom_reasoning_preset', '#custom_reasoning_preset', Object.values(custom_reasoning_preset_types), () => setCustomReasoningPreset(oai_settings.custom_reasoning_preset)),
        description: 'custom reasoning preset',
        enumList: Object.values(custom_reasoning_preset_types),
        forceEnum: true,
    });
    registerChatCompletionProfileSlashCommand({
        name: 'custom-reasoning-param-format',
        callback: runEnumChatCompletionSettingCallback('custom-reasoning-param-format', 'custom_reasoning_param_format', '#custom_reasoning_param_format', Object.values(custom_reasoning_param_formats), markCustomReasoningPresetForManualCommand),
        description: 'custom reasoning parameter format',
        enumList: Object.values(custom_reasoning_param_formats),
        forceEnum: true,
    });
    registerChatCompletionProfileSlashCommand({
        name: 'custom-reasoning-param-name',
        callback: runStringChatCompletionSettingCallback('custom-reasoning-param-name', 'custom_reasoning_param_name', '#custom_reasoning_param_name', markCustomReasoningPresetForManualCommand),
        description: 'custom reasoning parameter name',
    });
    registerChatCompletionProfileSlashCommand({
        name: 'custom-reasoning-enabled-value',
        callback: runStringChatCompletionSettingCallback('custom-reasoning-enabled-value', 'custom_reasoning_enabled_value', '#custom_reasoning_enabled_value', markCustomReasoningPresetForManualCommand),
        description: 'custom reasoning enabled value',
    });
    registerChatCompletionProfileSlashCommand({
        name: 'custom-reasoning-disabled-value',
        callback: runStringChatCompletionSettingCallback('custom-reasoning-disabled-value', 'custom_reasoning_disabled_value', '#custom_reasoning_disabled_value', markCustomReasoningPresetForManualCommand),
        description: 'custom reasoning disabled value',
    });
}

/**
 * Handle Vertex AI authentication mode change
 */
function onVertexAIAuthModeChange() {
    const authMode = String($(this).val());
    oai_settings.vertexai_auth_mode = authMode;

    $('#vertexai_form [data-mode]').each(function () {
        const mode = $(this).data('mode');
        $(this).toggle(mode === authMode);
        $(this).find('option').toggle(mode === authMode);
    });

    saveSettingsDebounced();
}

/**
 * Validate Vertex AI service account JSON
 */
async function onVertexAIValidateServiceAccount() {
    const jsonContent = String($('#vertexai_service_account_json').val()).trim();

    if (!jsonContent) {
        toastr.error(t`Please enter Service Account JSON content`);
        return;
    }

    try {
        const serviceAccount = JSON.parse(jsonContent);
        const requiredFields = ['type', 'project_id', 'private_key', 'client_email', 'client_id'];
        const missingFields = requiredFields.filter(field => !serviceAccount[field]);

        if (missingFields.length > 0) {
            toastr.error(t`Missing required fields: ${missingFields.join(', ')}`);
            updateVertexAIServiceAccountStatus(false, t`Missing fields: ${missingFields.join(', ')}`);
            return;
        }

        if (serviceAccount.type !== 'service_account') {
            toastr.error(t`Invalid service account type. Expected "service_account"`);
            updateVertexAIServiceAccountStatus(false, t`Invalid service account type`);
            return;
        }

        // Save to backend secret storage
        const keyLabel = serviceAccount.client_email || '';
        await writeSecret(SECRET_KEYS.VERTEXAI_SERVICE_ACCOUNT, jsonContent, keyLabel);

        // Show success status
        updateVertexAIServiceAccountStatus(true, `Project: ${serviceAccount.project_id}, Email: ${serviceAccount.client_email}`);

        toastr.success(t`Service Account JSON is valid and saved securely`);
        saveSettingsDebounced();
    } catch (error) {
        console.error('JSON validation error:', error);
        toastr.error(t`Invalid JSON format`);
        updateVertexAIServiceAccountStatus(false, t`Invalid JSON format`);
    }
}

/**
 * Clear Vertex AI service account JSON
 */
async function onVertexAIClearServiceAccount() {
    $('#vertexai_service_account_json').val('');

    // Clear from backend secret storage
    await writeSecret(SECRET_KEYS.VERTEXAI_SERVICE_ACCOUNT, '');

    updateVertexAIServiceAccountStatus(false);
    toastr.info(t`Service Account JSON cleared`);
    saveSettingsDebounced();
}

/**
 * Handle Vertex AI service account JSON input change
 */
function onVertexAIServiceAccountJsonChange() {
    const jsonContent = String($(this).val()).trim();

    // Autocomplete has been triggered, don't validate if the input is a UUID
    if (isUuid(jsonContent)) {
        return;
    }

    if (jsonContent) {
        // Auto-validate when content is pasted
        try {
            const serviceAccount = JSON.parse(jsonContent);
            const requiredFields = ['type', 'project_id', 'private_key', 'client_email'];
            const hasAllFields = requiredFields.every(field => serviceAccount[field]);

            if (hasAllFields && serviceAccount.type === 'service_account') {
                updateVertexAIServiceAccountStatus(false, t`JSON appears valid - click "Validate JSON" to save`);
            } else {
                updateVertexAIServiceAccountStatus(false, t`Incomplete or invalid JSON`);
            }
        } catch (error) {
            updateVertexAIServiceAccountStatus(false, t`Invalid JSON format`);
        }
    } else {
        updateVertexAIServiceAccountStatus(false);
    }

    // Don't save settings automatically
    // saveSettingsDebounced();
}

/**
 * Update the Vertex AI service account status display
 * @param {boolean} isValid - Whether the service account is valid
 * @param {string} message - Status message to display
 */
function updateVertexAIServiceAccountStatus(isValid = false, message = '') {
    const statusDiv = $('#vertexai_service_account_status');
    const infoSpan = $('#vertexai_service_account_info');

    // If no explicit message provided, check if we have a saved service account
    if (!message && secret_state[SECRET_KEYS.VERTEXAI_SERVICE_ACCOUNT]) {
        isValid = true;
        message = t`Service Account JSON is saved and ready to use`;
    }

    if (isValid && message) {
        infoSpan.html(`<i class="fa-solid fa-check-circle" style="color: var(--color-primary, var(--sb-accent, var(--SmartThemeQuoteColor)));"></i> ${message}`);
        statusDiv.show();
    } else if (!isValid && message) {
        infoSpan.html(`<i class="fa-solid fa-exclamation-triangle" style="color: var(--warning, #ffb46b);"></i> ${message}`);
        statusDiv.show();
    } else {
        statusDiv.hide();
    }
}

function updateFeatureSupportFlags() {
    const featureFlags = {
        openai_function_calling_supported: ToolManager.isToolCallingSupported(),
        openai_image_inlining_supported: isImageInliningSupported(),
        openai_video_inlining_supported: isVideoInliningSupported(),
        openai_audio_inlining_supported: isAudioInliningSupported(),
    };

    for (const [key, value] of Object.entries(featureFlags)) {
        const element = document.getElementById(key);
        if (element) {
            element.dataset.ccToggle = String(value ?? false);
        }
    }
}

export function initOpenAI() {
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'proxy',
        callback: runProxyCallback,
        returns: 'current proxy',
        namedArgumentList: [],
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: 'name',
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: true,
                enumProvider: () => proxies.map(preset => new SlashCommandEnumValue(preset.name, preset.url)),
            }),
        ],
        helpString: 'Sets a proxy preset by name.',
    }));
    // SillyBunny: Connection Manager snapshots Chat Completion request behavior via slash commands.
    registerChatCompletionProfileSlashCommands();

    $('#test_api_button').on('click', testApiConnection);

    $('#temp_openai').on('input', function () {
        oai_settings.temp_openai = Number($(this).val());
        $('#temp_counter_openai').val(Number($(this).val()).toFixed(2));
        saveSettingsDebounced();
    });

    $('#freq_pen_openai').on('input', function () {
        oai_settings.freq_pen_openai = Number($(this).val());
        $('#freq_pen_counter_openai').val(Number($(this).val()).toFixed(2));
        saveSettingsDebounced();
    });

    $('#pres_pen_openai').on('input', function () {
        oai_settings.pres_pen_openai = Number($(this).val());
        $('#pres_pen_counter_openai').val(Number($(this).val()).toFixed(2));
        saveSettingsDebounced();
    });

    $('#top_p_openai').on('input', function () {
        oai_settings.top_p_openai = Number($(this).val());
        $('#top_p_counter_openai').val(Number($(this).val()).toFixed(2));
        saveSettingsDebounced();
    });

    $('#claude_disable_temperature').on('input', function () {
        oai_settings.claude_disable_temperature = !!$(this).prop('checked');
        saveSettingsDebounced();
    });

    $('#claude_disable_top_p').on('input', function () {
        oai_settings.claude_disable_top_p = !!$(this).prop('checked');
        saveSettingsDebounced();
    });

    $('#top_k_openai').on('input', function () {
        oai_settings.top_k_openai = Number($(this).val());
        $('#top_k_counter_openai').val(Number($(this).val()).toFixed(0));
        saveSettingsDebounced();
    });

    $('#top_a_openai').on('input', function () {
        oai_settings.top_a_openai = Number($(this).val());
        $('#top_a_counter_openai').val(Number($(this).val()));
        saveSettingsDebounced();
    });

    $('#min_p_openai').on('input', function () {
        oai_settings.min_p_openai = Number($(this).val());
        $('#min_p_counter_openai').val(Number($(this).val()));
        saveSettingsDebounced();
    });

    $('#repetition_penalty_openai').on('input', function () {
        oai_settings.repetition_penalty_openai = Number($(this).val());
        $('#repetition_penalty_counter_openai').val(Number($(this).val()));
        saveSettingsDebounced();
    });

    $('#openai_max_context').on('input', function () {
        oai_settings.openai_max_context = Number($(this).val());
        $('#openai_max_context_counter').val(`${$(this).val()}`);
        calculateOpenRouterCost();
        calculateElectronHubCost();
        calculateChutesCost();
        saveSettingsDebounced();
    });

    $('#openai_max_tokens').on('input', function () {
        oai_settings.openai_max_tokens = Number($(this).val());
        calculateOpenRouterCost();
        calculateElectronHubCost();
        calculateChutesCost();
        saveSettingsDebounced();
    });

    $('#stream_toggle').on('change', function () {
        oai_settings.stream_openai = !!$('#stream_toggle').prop('checked');
        saveSettingsDebounced();
    });

    $('#use_sysprompt').on('change', function () {
        oai_settings.use_sysprompt = !!$('#use_sysprompt').prop('checked');
        saveSettingsDebounced();
    });

    $('#send_if_empty_textarea').on('input', function () {
        oai_settings.send_if_empty = String($('#send_if_empty_textarea').val());
        saveSettingsDebounced();
    });

    $('#impersonation_prompt_textarea').on('input', function () {
        oai_settings.impersonation_prompt = String($('#impersonation_prompt_textarea').val());
        saveSettingsDebounced();
    });

    $('#newchat_prompt_textarea').on('input', function () {
        oai_settings.new_chat_prompt = String($('#newchat_prompt_textarea').val());
        saveSettingsDebounced();
    });

    $('#newgroupchat_prompt_textarea').on('input', function () {
        oai_settings.new_group_chat_prompt = String($('#newgroupchat_prompt_textarea').val());
        saveSettingsDebounced();
    });

    $('#newexamplechat_prompt_textarea').on('input', function () {
        oai_settings.new_example_chat_prompt = String($('#newexamplechat_prompt_textarea').val());
        saveSettingsDebounced();
    });

    $('#continue_nudge_prompt_textarea').on('input', function () {
        oai_settings.continue_nudge_prompt = String($('#continue_nudge_prompt_textarea').val());
        saveSettingsDebounced();
    });

    $('#wi_format_textarea').on('input', function () {
        oai_settings.wi_format = String($('#wi_format_textarea').val());
        saveSettingsDebounced();
    });

    $('#scenario_format_textarea').on('input', function () {
        oai_settings.scenario_format = String($('#scenario_format_textarea').val());
        saveSettingsDebounced();
    });

    $('#personality_format_textarea').on('input', function () {
        oai_settings.personality_format = String($('#personality_format_textarea').val());
        saveSettingsDebounced();
    });

    $('#group_nudge_prompt_textarea').on('input', function () {
        oai_settings.group_nudge_prompt = String($('#group_nudge_prompt_textarea').val());
        saveSettingsDebounced();
    });

    $('#update_oai_preset').on('click', async function () {
        const name = oai_settings.preset_settings_openai;
        await saveOpenAIPreset(name, oai_settings, false);
        toastr.success(t`Preset updated`);
    });

    $('#impersonation_prompt_restore').on('click', function () {
        oai_settings.impersonation_prompt = default_impersonation_prompt;
        $('#impersonation_prompt_textarea').val(oai_settings.impersonation_prompt);
        saveSettingsDebounced();
    });

    $('#newchat_prompt_restore').on('click', function () {
        oai_settings.new_chat_prompt = default_new_chat_prompt;
        $('#newchat_prompt_textarea').val(oai_settings.new_chat_prompt);
        saveSettingsDebounced();
    });

    $('#newgroupchat_prompt_restore').on('click', function () {
        oai_settings.new_group_chat_prompt = default_new_group_chat_prompt;
        $('#newgroupchat_prompt_textarea').val(oai_settings.new_group_chat_prompt);
        saveSettingsDebounced();
    });

    $('#newexamplechat_prompt_restore').on('click', function () {
        oai_settings.new_example_chat_prompt = default_new_example_chat_prompt;
        $('#newexamplechat_prompt_textarea').val(oai_settings.new_example_chat_prompt);
        saveSettingsDebounced();
    });

    $('#continue_nudge_prompt_restore').on('click', function () {
        oai_settings.continue_nudge_prompt = default_continue_nudge_prompt;
        $('#continue_nudge_prompt_textarea').val(oai_settings.continue_nudge_prompt);
        saveSettingsDebounced();
    });

    $('#wi_format_restore').on('click', function () {
        oai_settings.wi_format = default_wi_format;
        $('#wi_format_textarea').val(oai_settings.wi_format);
        saveSettingsDebounced();
    });

    $('#scenario_format_restore').on('click', function () {
        oai_settings.scenario_format = default_scenario_format;
        $('#scenario_format_textarea').val(oai_settings.scenario_format);
        saveSettingsDebounced();
    });

    $('#personality_format_restore').on('click', function () {
        oai_settings.personality_format = default_personality_format;
        $('#personality_format_textarea').val(oai_settings.personality_format);
        saveSettingsDebounced();
    });

    $('#group_nudge_prompt_restore').on('click', function () {
        oai_settings.group_nudge_prompt = default_group_nudge_prompt;
        $('#group_nudge_prompt_textarea').val(oai_settings.group_nudge_prompt);
        saveSettingsDebounced();
    });

    $('#openai_bypass_status_check').on('input', function () {
        oai_settings.bypass_status_check = !!$(this).prop('checked');
        getStatusOpen();
        saveSettingsDebounced();
    });

    $('#chat_completion_source').on('change', function () {
        const presetName = oai_settings.preset_settings_openai;
        cancelStatusCheck('Chat Completion source changed');
        model_list = [];
        oai_settings.chat_completion_source = String($(this).find(':selected').val());
        syncMaxContextUnlockedControl(oai_settings);
        toggleChatCompletionForms();
        applyConfigurableContextLimit();
        syncProxyPresetToBoundSource(oai_settings.chat_completion_source);
        // SillyBunny: source switches should not reset the selected settings preset.
        restoreOpenAIPresetSelection(presetName);
        saveSettingsDebounced();
        reconnectOpenAi();
        forceCharacterEditorTokenize();
        updateFeatureSupportFlags();
        eventSource.emit(event_types.CHATCOMPLETION_SOURCE_CHANGED, oai_settings.chat_completion_source);
    });

    $('#oai_max_context_unlocked').on('input', function (_e, data) {
        if (isContextUnlockConfigurable()) {
            oai_settings.max_context_unlocked = !!$(this).prop('checked');
        }
        syncMaxContextUnlockedControl(oai_settings);
        if (data?.source !== 'preset') {
            $('#chat_completion_source').trigger('change');
        } else {
            applyConfigurableContextLimit();
        }
        saveSettingsDebounced();
    });

    $('#openai_show_external_models').on('input', function () {
        oai_settings.show_external_models = !!$(this).prop('checked');
        rebuildOpenAIModelSelect();
        saveSettingsDebounced();
    });

    $('#openai_proxy_password').on('input', function () {
        oai_settings.proxy_password = String($(this).val());
        saveSettingsDebounced();
    });

    $('#claude_assistant_prefill').on('input', function () {
        oai_settings.assistant_prefill = String($(this).val());
        saveSettingsDebounced();
    });

    $('#claude_assistant_impersonation').on('input', function () {
        oai_settings.assistant_impersonation = String($(this).val());
        saveSettingsDebounced();
    });

    $('#openrouter_use_fallback').on('input', function () {
        oai_settings.openrouter_use_fallback = !!$(this).prop('checked');
        saveSettingsDebounced();
    });

    $('#openrouter_group_models').on('input', function () {
        oai_settings.openrouter_group_models = !!$(this).prop('checked');
        saveSettingsDebounced();
    });

    $('#openrouter_sort_models').on('input', function () {
        oai_settings.openrouter_sort_models = String($(this).val());
        saveSettingsDebounced();
    });

    $('#openrouter_allow_fallbacks').on('input', function () {
        oai_settings.openrouter_allow_fallbacks = !!$(this).prop('checked');
        updateOpenRouterProvidersWarning('#openrouter_providers_chat');
        saveSettingsDebounced();
    });

    $('#openrouter_middleout').on('input', function () {
        oai_settings.openrouter_middleout = String($(this).val());
        saveSettingsDebounced();
    });

    $('#electronhub_sort_models').on('input', function () {
        oai_settings.electronhub_sort_models = String($(this).val());
        saveSettingsDebounced();
    });

    $('#chutes_sort_models').on('input', function () {
        oai_settings.chutes_sort_models = String($(this).val());
        saveSettingsDebounced();
    });

    $('#electronhub_group_models').on('input', function () {
        oai_settings.electronhub_group_models = !!$(this).prop('checked');
        saveSettingsDebounced();
    });

    $('#squash_system_messages').on('input', function () {
        oai_settings.squash_system_messages = !!$(this).prop('checked');
        saveSettingsDebounced();
    });

    $('#openai_media_inlining').on('input', function () {
        oai_settings.media_inlining = !!$(this).prop('checked');
        updateFeatureSupportFlags();
        saveSettingsDebounced();
    });

    $('#openai_inline_image_quality').on('input', function () {
        oai_settings.inline_image_quality = String($(this).val());
        saveSettingsDebounced();
    });

    $('#continue_prefill').on('input', function () {
        oai_settings.continue_prefill = !!$(this).prop('checked');
        saveSettingsDebounced();
    });

    $('#openai_function_calling').on('input', function () {
        oai_settings.function_calling = !!$(this).prop('checked');
        updateFeatureSupportFlags();
        saveSettingsDebounced();
    });

    $('#tool_call_recurse_limit').on('input', function () {
        applyToolCallRecurseLimit($(this).val());
        saveSettingsDebounced();
    });

    $('#tool_reasoning_mode').on('input', function () {
        oai_settings.tool_reasoning_mode = getToolReasoningMode({
            ...oai_settings,
            tool_reasoning_mode: String($(this).val()),
        });
        saveSettingsDebounced();
    });

    $('#seed_openai').on('input', function () {
        oai_settings.seed = Number($(this).val());
        saveSettingsDebounced();
    });

    $('#n_openai').on('input', function () {
        oai_settings.n = Number($(this).val());
        saveSettingsDebounced();
    });

    $('#custom_api_url_text').on('input', function () {
        oai_settings.custom_url = String($(this).val());
        saveSettingsDebounced();
    });

    $('#custom_model_id').on('input', function () {
        oai_settings.custom_model = String($(this).val());
        saveSettingsDebounced();
    });

    $('#openai_model_id').on('input', function () {
        const value = String($(this).val());
        oai_settings.openai_model = value;

        if (value) {
            ensureOpenAIModelSelectOption(value);
            $('#model_openai_select').val(value).trigger('change');
        } else {
            updateOpenAIModelFavoriteButton();
            saveSettingsDebounced();
        }
    });

    $('#claude_model_id').on('input', function () {
        oai_settings.claude_model = String($(this).val());
        saveSettingsDebounced();
    });
    $('#ai21_model_id').on('input', function () {
        oai_settings.ai21_model = String($(this).val());
        saveSettingsDebounced();
    });
    $('#cohere_model_id').on('input', function () {
        oai_settings.cohere_model = String($(this).val());
        saveSettingsDebounced();
    });
    $('#perplexity_model_id').on('input', function () {
        oai_settings.perplexity_model = String($(this).val());
        saveSettingsDebounced();
    });
    $('#makersuite_model_id').on('input', function () {
        const value = String($(this).val());
        oai_settings.google_model = value;

        if (value) {
            refreshModelIdSearchControlsForSource(chat_completion_sources.MAKERSUITE);
            $('#model_google_select').val(value).trigger('change');
        } else {
            updateModelIdSearchFavoriteButtons();
            saveSettingsDebounced();
        }
    });
    $('#zai_model_id').on('input', function () {
        oai_settings.zai_model = String($(this).val());
        saveSettingsDebounced();
    });
    $('#vertexai_model_id').on('input', function () {
        oai_settings.vertexai_model = String($(this).val());
        saveSettingsDebounced();
    });

    $('#custom_model_icon_detection').on('input', function () {
        oai_settings.custom_model_icon_detection = !!$(this).prop('checked');
        refreshMessageModelIcons();
        saveSettingsDebounced();
    });

    $('#custom_prompt_post_processing').on('change', function () {
        oai_settings.custom_prompt_post_processing = String($(this).val());
        updateFeatureSupportFlags();
        saveSettingsDebounced();
    });

    $('#names_behavior').on('input', function () {
        oai_settings.names_behavior = Number($(this).val());
        setNamesBehaviorControls();
        saveSettingsDebounced();
    });

    $('#azure_base_url').on('input', function () {
        oai_settings.azure_base_url = String($(this).val());
        saveSettingsDebounced();
    });

    $('#azure_deployment_name').on('input', function () {
        oai_settings.azure_deployment_name = String($(this).val());
        saveSettingsDebounced();
    });

    $('#azure_api_version').on('input change', function () {
        oai_settings.azure_api_version = String($(this).val());
        saveSettingsDebounced();
    });

    $('#character_names_none').on('input', function () {
        oai_settings.names_behavior = character_names_behavior.NONE;
        setNamesBehaviorControls();
        saveSettingsDebounced();
    });

    $('#character_names_default').on('input', function () {
        oai_settings.names_behavior = character_names_behavior.DEFAULT;
        setNamesBehaviorControls();
        saveSettingsDebounced();
    });

    $('#character_names_completion').on('input', function () {
        oai_settings.names_behavior = character_names_behavior.COMPLETION;
        setNamesBehaviorControls();
        saveSettingsDebounced();
    });

    $('#character_names_content').on('input', function () {
        oai_settings.names_behavior = character_names_behavior.CONTENT;
        setNamesBehaviorControls();
        saveSettingsDebounced();
    });

    $('#continue_postifx').on('input', function () {
        oai_settings.continue_postfix = String($(this).val());
        setContinuePostfixControls();
        saveSettingsDebounced();
    });

    $('#continue_postfix_none').on('input', function () {
        oai_settings.continue_postfix = continue_postfix_types.NONE;
        setContinuePostfixControls();
        saveSettingsDebounced();
    });

    $('#continue_postfix_space').on('input', function () {
        oai_settings.continue_postfix = continue_postfix_types.SPACE;
        setContinuePostfixControls();
        saveSettingsDebounced();
    });

    $('#continue_postfix_newline').on('input', function () {
        oai_settings.continue_postfix = continue_postfix_types.NEWLINE;
        setContinuePostfixControls();
        saveSettingsDebounced();
    });

    $('#continue_postfix_double_newline').on('input', function () {
        oai_settings.continue_postfix = continue_postfix_types.DOUBLE_NEWLINE;
        setContinuePostfixControls();
        saveSettingsDebounced();
    });

    $('#openai_show_thoughts').on('input', function () {
        oai_settings.show_thoughts = !!$(this).prop('checked');
        setToolReasoningControls();
        saveSettingsDebounced();
    });

    $('#openai_auto_append_reasoning_tags').on('input', function () {
        oai_settings.auto_append_reasoning_tags = !!$(this).prop('checked');
        setToolReasoningControls();
        setAutoAppendReasoningTagControls();
        saveSettingsDebounced();
    });

    $('#openai_reasoning_tag_style').on('input', function () {
        oai_settings.auto_append_reasoning_tag_style = String($(this).val());
        saveSettingsDebounced();
    });

    $('#openai_reasoning_effort').on('input', function () {
        oai_settings.reasoning_effort = String($(this).val());
        saveSettingsDebounced();
    });

    $('#openai_verbosity').on('input', function () {
        oai_settings.verbosity = String($(this).val());
        saveSettingsDebounced();
    });

    $('#openai_enable_web_search').on('input', function () {
        oai_settings.enable_web_search = !!$(this).prop('checked');
        calculateOpenRouterCost();
        saveSettingsDebounced();
    });

    $('#openai_request_images').on('input', function () {
        oai_settings.request_images = !!$(this).prop('checked');
        saveSettingsDebounced();
    });

    $('#request_image_resolution').on('input', function () {
        oai_settings.request_image_resolution = String($(this).val());
        saveSettingsDebounced();
    });

    $('#request_image_aspect_ratio').on('input', function () {
        oai_settings.request_image_aspect_ratio = String($(this).val());
        saveSettingsDebounced();
    });

    if (!CSS.supports('field-sizing', 'content')) {
        $(document).on('input', '#openai_settings .autoSetHeight', function () {
            resetScrollHeight($(this));
        });
    }

    if (!shouldUseInlineModelSelectPicker()) {
        $('#model_openai_select').select2({
            dropdownParent: getApiSelect2DropdownParent(),
            placeholder: t`Select a model`,
            searchInputPlaceholder: t`Search models...`,
            searchInputCssClass: 'text_pole',
            width: '100%',
            matcher: textValueMatcher,
        });
        $('#model_openrouter_select').select2({
            dropdownParent: getApiSelect2DropdownParent(),
            placeholder: t`Select a model`,
            searchInputPlaceholder: t`Search models...`,
            searchInputCssClass: 'text_pole',
            width: '100%',
            templateResult: getOpenRouterModelTemplate,
            matcher: textValueMatcher,
        });
        $('#model_aimlapi_select').select2({
            dropdownParent: getApiSelect2DropdownParent(),
            placeholder: t`Select a model`,
            searchInputPlaceholder: t`Search models...`,
            searchInputCssClass: 'text_pole',
            width: '100%',
            templateResult: getAimlapiModelTemplate,
        });
        $('#model_electronhub_select').select2({
            dropdownParent: getApiSelect2DropdownParent(),
            placeholder: t`Select a model`,
            searchInputPlaceholder: t`Search models...`,
            searchInputCssClass: 'text_pole',
            width: '100%',
            templateResult: getElectronHubModelTemplate,
            matcher: textValueMatcher,
        });
        $('#model_chutes_select').select2({
            dropdownParent: getApiSelect2DropdownParent(),
            placeholder: t`Select a model`,
            searchInputPlaceholder: t`Search models...`,
            searchInputCssClass: 'text_pole',
            width: '100%',
            templateResult: getChutesModelTemplate,
            matcher: textValueMatcher,
        });
        $('#model_nanogpt_select').select2({
            dropdownParent: getApiSelect2DropdownParent(),
            placeholder: t`Select a model`,
            searchInputPlaceholder: t`Search models...`,
            searchInputCssClass: 'text_pole',
            width: '100%',
            templateResult: getNanoGptModelTemplate,
            matcher: textValueMatcher,
        });
        $('#model_workers_ai_select').select2({
            dropdownParent: getApiSelect2DropdownParent(),
            placeholder: t`Select a model`,
            searchInputPlaceholder: t`Search models...`,
            searchInputCssClass: 'text_pole',
            width: '100%',
            matcher: textValueMatcher,
        });
        $('#completion_prompt_manager_popup_entry_form_injection_trigger').select2({
            dropdownParent: getPromptManagerSelect2DropdownParent(),
            placeholder: t`All types (default)`,
            width: '100%',
            closeOnSelect: false,
        });
    }

    $('#openrouter_providers_chat').on('change', function () {
        const selectedProviders = $(this).val();

        // Not a multiple select?
        if (!Array.isArray(selectedProviders)) {
            return;
        }

        oai_settings.openrouter_providers = selectedProviders;

        updateOpenRouterProvidersWarning('#openrouter_providers_chat');
        saveSettingsDebounced();
    });

    $('#openrouter_quantizations_chat').on('change', function () {
        const selectedQuantizations = $(this).val();

        // Not a multiple select?
        if (!Array.isArray(selectedQuantizations)) {
            return;
        }

        oai_settings.openrouter_quantizations = selectedQuantizations;

        saveSettingsDebounced();
    });

    $('#bind_preset_to_connection').on('input', function () {
        oai_settings.bind_preset_to_connection = !!$(this).prop('checked');
        updateBindPresetToConnectionHelp();
        saveSettingsDebounced();
    });

    $('#bind_preset_to_sampling').on('input', function () {
        oai_settings.bind_preset_to_sampling = !!$(this).prop('checked');
        updateBindPresetToSamplingHelp();
        saveSettingsDebounced();
    });

    $('#model_sampling_profiles_enabled').on('input', function () {
        oai_settings.model_sampling_profiles_enabled = !!$(this).prop('checked');
        syncModelSamplingProfilesUI();
        if (oai_settings.model_sampling_profiles_enabled) {
            maybeApplyModelSamplingProfile();
        }
        saveSettingsDebounced();
    });

    $('#model_sampling_profile_save').on('click', function () {
        saveSamplingProfileForCurrentModel();
    });

    $('#model_sampling_profile_clear').on('click', function () {
        clearSamplingProfileForCurrentModel();
    });

    groupOpenAISettingsIntoDrawers();
    injectServerChatCompletionConfigCard();
    cacheOpenAIStaticModelGroups();
    bindInlineSelectPickerControls();
    rebuildOpenAIModelSelect();
    initModelIdSearchControls();
    updateAdvancedFormattingVisibility();
    updateOpenAISettingsGroupVisibility();
    scheduleOpenAIUiRefresh();

    $('#api_button_openai').on('click', onConnectButtonClick);
    $('#main_api').on('change', updateAdvancedFormattingVisibility);
    $('#openai_reverse_proxy').on('input', onReverseProxyInput);
    $('#model_openai_favorite_toggle').on('click', toggleOpenAIModelFavorite);
    $('#model_openai_select').on('change', onModelChange);
    $('#model_claude_select').on('change', onModelChange);
    $('#model_google_select').on('change', onModelChange);
    $('#model_vertexai_select').on('change', onModelChange);
    $('#vertexai_auth_mode').on('change', onVertexAIAuthModeChange);
    $('#vertexai_region').on('input', function () {
        oai_settings.vertexai_region = String($(this).val());
        saveSettingsDebounced();
    });
    $('#vertexai_express_project_id').on('input', function () {
        oai_settings.vertexai_express_project_id = String($(this).val());
        saveSettingsDebounced();
    });
    $('#zai_endpoint').on('input', function () {
        oai_settings.zai_endpoint = String($(this).val());
        saveSettingsDebounced();
    });
    $('#siliconflow_endpoint').on('input', function () {
        oai_settings.siliconflow_endpoint = String($(this).val());
        saveSettingsDebounced();
    });
    $('#minimax_endpoint').on('input', function () {
        oai_settings.minimax_endpoint = String($(this).val());
        saveSettingsDebounced();
    });
    $('#workers_ai_account_id').on('input', function () {
        oai_settings.workers_ai_account_id = String($(this).val());
        saveSettingsDebounced();
    });
    $('#vertexai_service_account_json').on('input', onVertexAIServiceAccountJsonChange);
    $('#vertexai_validate_service_account').on('click', onVertexAIValidateServiceAccount);
    $('#vertexai_clear_service_account').on('click', onVertexAIClearServiceAccount);
    $('#model_openrouter_select').on('change', onModelChange);
    $('#openrouter_group_models').on('change', onOpenrouterModelSortChange);
    $('#openrouter_sort_models').on('change', onOpenrouterModelSortChange);
    $('#chutes_sort_models').on('change', onChutesModelSortChange);
    $('#electronhub_group_models').on('change', onElectronHubModelSortChange);
    $('#electronhub_sort_models').on('change', onElectronHubModelSortChange);
    $('#model_ai21_select').on('change', onModelChange);
    $('#model_mistralai_select').on('change', onModelChange);
    $('#model_cohere_select').on('change', onModelChange);
    $('#model_perplexity_select').on('change', onModelChange);
    $('#model_groq_select').on('change', onModelChange);
    $('#model_chutes_select').on('change', onModelChange);
    $('#model_siliconflow_select').on('change', onModelChange);
    $('#model_minimax_select').on('change', onModelChange);
    $('#model_electronhub_select').on('change', onModelChange);
    $('#model_nanogpt_select').on('change', onModelChange);
    $('#model_deepseek_select').on('change', onModelChange);
    $('#model_aimlapi_select').on('change', onModelChange);
    $('#model_custom_select').on('change', onModelChange);
    $('#model_xai_select').on('change', onModelChange);
    $('#model_pollinations_select').on('change', onModelChange);
    $('#model_cometapi_select').on('change', onModelChange);
    $('#model_moonshot_select').on('change', onModelChange);
    $('#model_fireworks_select').on('change', onModelChange);
    $('#azure_openai_model').on('change', onModelChange);
    $('#model_zai_select').on('change', onModelChange);
    $('#model_workers_ai_select').on('change', onModelChange);
    $('#settings_preset_openai').on('change', onSettingsPresetChange);
    $('#new_oai_preset').on('click', onNewPresetClick);
    $('#delete_oai_preset').on('click', onDeletePresetClick);
    $('#openai_logit_bias_preset').on('change', onLogitBiasPresetChange);
    $('#openai_logit_bias_new_preset').on('click', createNewLogitBiasPreset);
    $('#openai_logit_bias_new_entry').on('click', createNewLogitBiasEntry);
    $('#openai_logit_bias_import_file').on('input', onLogitBiasPresetImportFileChange);
    $('#openai_preset_import_file').on('input', onPresetImportFileChange);
    $('#export_oai_preset').on('click', onExportPresetClick);
    $('#openai_logit_bias_import_preset').on('click', onLogitBiasPresetImportClick);
    $('#openai_logit_bias_export_preset').on('click', onLogitBiasPresetExportClick);
    $('#openai_logit_bias_delete_preset').on('click', onLogitBiasPresetDeleteClick);
    $('#import_oai_preset').on('click', onImportPresetClick);
    $('#openai_proxy_password_show').on('click', onProxyPasswordShowClick);
    $('#customize_additional_parameters').on('click', onCustomizeParametersClick);
    $('#openai_proxy_preset').on('change', onProxyPresetChange);
}
