import { DiffMatchPatch } from '../../../lib.js';
import { extension_settings, renderExtensionTemplateAsync, getContext } from '../../extensions.js';
import { Popup, POPUP_TYPE, POPUP_RESULT } from '../../popup.js';
import { download, escapeHtml, escapeRegex, getSortableDelay, uuidv4 } from '../../utils.js';
import { activateSendButtons, CLIENT_VERSION, chat, deactivateSendButtons, getRequestHeaders, generateQuietPrompt, is_send_press, normalizeContentText, saveSettingsDebounced, substituteParams } from '../../../script.js';
import { eventSource, event_types } from '../../events.js';
import { is_group_generating } from '../../group-chats.js';
import {
    areAgentsGloballyEnabled,
    getAgents,
    getEnabledAgents,
    getAgentById,
    getAgentRegexScripts,
    loadAgents,
    saveAgent,
    deleteAgent,
    createDefaultAgent,
    importAgents,
    exportAllAgents,
    exportAgent,
    AGENT_CATEGORIES,
    AGENT_SUBCATEGORIES,
    DEFAULT_AGENT_MAX_TOKENS,
    getGlobalSettings,
    initializeScopedAgentEnableState,
    isAgentEnabledForCurrentScope,
    LEGACY_AGENT_MAX_TOKENS,
    normalizeAgentCategory,
    getAgentChatScopeLabel,
    getPromptTransformMode,
    isTrackerFixAgent,
    isPathfinderSubmoduleEnabled,
    findTemplateForAgentSnapshot,
    getRedundantBundledAgentDuplicateIds,
    reconcileScopedEnabledAgentIdsFromLegacyFlags,
    resolveConnectionProfile,
    setAgentEnabledForCurrentScope,
    setGlobalSettings,
    setPathfinderSubmoduleEnabled,
    getGroups,
    getCustomGroups,
    getCompanionConfig,
    loadBuiltinGroups,
    loadCustomGroups,
    agentMatchesListTab,
    applyCompanionContextAccessDefaults,
    applyCompanionPanelDisplayDefault,
    applyTrackerCompanionAutoLoopDefaults,
    convertAgentExecution,
    isCompanionAgent,
    isToolAgent,
    saveGroup,
    deleteGroup,
    createDefaultGroup,
} from './agent-store.js';
import {
    cancelAgentGeneration,
    buildPromptDynamicMacros,
    deactivatePathfinderRuntime,
    initAgentRunner,
    isAgentGenerationActive,
    onAgentGenerationStateChanged,
    getPreGenerationInterceptHistoryForMessage,
    getPromptTransformHistoryForMessage,
    refreshRegexSnapshotsForAgent,
    runAgentOnMessage,
    runTrackerFixOnMessage,
    syncToolAgentRegistrations,
    undoPromptTransform,
    redoPromptTransform,
} from './agent-runner.js';
import {
    AGENT_REGEX_PLACEMENT,
    AGENT_REGEX_SUBSTITUTE,
    createDefaultRegexScript,
    normalizeRegexScript,
} from './regex-scripts.js';
import { initPathfinder, teardownPathfinder } from './pathfinder-init.js';
import { openPathfinderSettings, isPathfinderAgent } from './pathfinder-settings-ui.js';
import { getPathfinderToolDefinitions } from './pathfinder/tool-definitions.js';
import { buildFallbackPromptText, extractProfileResponseText } from './llm-utils.js';
import { appendHelperPrefillMessages } from '../helper-prefill.js';
import {
    buildConnectionProfileNameMap,
    getConnectionManagerRequestService,
    populateConnectionProfileSelect,
} from './profile-utils.js';
import { collectRecentCompanionResults, initCompanionRunner } from './companion/companion-runner.js';
import { initCompanionCardUi, updateCompanionButtonVisibility } from './companion/companion-ui.js';
import { configureCompanionDashboard, initCompanionWandMenuItem, openCompanionDashboard } from './companion/companion-dashboard.js';
import { configureCompanionPanel, initCompanionPanel, updateCompanionPanelHandleVisibility } from './companion/companion-panel.js';

const MODULE_NAME = 'in-chat-agents';
const PATHFINDER_EXTENSIONS_HOST_ID = 'extension_settings_in_chat_agents_pathfinder';

let collapsedCategories = new Set();
let templateBrowserSearchValue = '';

/** Built-in templates loaded from JSON files. */
let templates = [];
let templateRegexBundles = {};
let autoSeededTemplateIds = new Set();

const DEFAULT_BUNDLED_TEMPLATE_IDS = new Set([
    'tpl-prose-polisher',
]);

// Internal bundled templates stay available for migrations/settings even when
// their agent card is hidden from the In-Chat Agents management UI.
const INTERNAL_BUNDLED_TEMPLATE_IDS = new Set([
    'tpl-pathfinder',
]);

const HIDDEN_TEMPLATE_BROWSER_IDS = new Set([
    'tpl-pathfinder',
]);

/** Whether the agent list is in multi-select mode. */
let selectModeActive = false;
/** Set of agent IDs currently selected in select mode. */
const selectedAgentIds = new Set();
let suppressCardClickUntil = 0;
let pathfinderExtensionsMountPromise = null;
let fixTrackersRunning = false;

const REMOVED_BUNDLED_TEMPLATE_IDS = new Set([
    'tpl-anti-slop-regex',
    'tpl-director-core',
    'tpl-nsfw-mode',
]);

const REMOVED_BUNDLED_AGENT_NAMES = new Set([
    'anti-slop regex',
    'director core',
    'nsfw mode',
]);

const REMOVED_BUNDLED_GROUP_IDS = new Set([
    'grp-pura-director',
]);

const CHATROOM_TEMPLATE_ID = 'tpl-chatroom-companion';
const DIRECTORS_COMMENTARY_TEMPLATE_ID = 'tpl-directors-commentary-companion';
const PLOT_COMPASS_TEMPLATE_ID = 'tpl-plot-compass-companion';
const CHATROOM_CUSTOM_STYLE_VALUE = 'custom';
const CHATROOM_CUSTOM_STYLES_MAX_CHARS = 6000;
const CHATROOM_CUSTOM_STYLE_NAME_MAX_CHARS = 80;
const CHATROOM_CUSTOM_STYLE_PROMPT_MAX_CHARS = 2000;
const CHATROOM_EXTRA_CHARACTER_LIMIT = 12;
const CHATROOM_EXTRA_CHARACTER_AVATAR_MAX_CHARS = 256;
const DIRECTOR_COMMENTARY_CUSTOM_VOICE_VALUE = 'custom';
const DIRECTOR_COMMENTARY_CUSTOM_VOICES_MAX_CHARS = 6000;
const DIRECTOR_COMMENTARY_CUSTOM_VOICE_NAME_MAX_CHARS = 80;
const DIRECTOR_COMMENTARY_CUSTOM_VOICE_PROMPT_MAX_CHARS = 2000;
const CHATROOM_STYLE_VALUES = Object.freeze([
    'mixed',
    'in-world',
    'discord/twitch',
    'twitter/x',
    'reddit',
    'ao3/wattpad',
    'newsroom',
    'thread-board/4chan',
    CHATROOM_CUSTOM_STYLE_VALUE,
]);
const DIRECTOR_COMMENTARY_VOICE_VALUES = Object.freeze([
    'active',
    'conspiratorial-absurdity',
    'bureaucratic-irony',
    'cosmic-playbook',
    'beige-undercurrents',
    'gossipy-voyeurism',
    'cruel-realism',
    'solemn-witness',
    'grand-satirical-stage',
    'randomised',
    DIRECTOR_COMMENTARY_CUSTOM_VOICE_VALUE,
]);
const BUNDLED_REGEX_POST_DEFAULT_EXCLUDED_TEMPLATE_IDS = new Set([
    CHATROOM_TEMPLATE_ID,
]);
const BUNDLED_PROMPT_TRANSFORM_IMPERSONATE_TEMPLATE_IDS = new Set([
    'tpl-prose-polisher',
]);
const CYOA_CHOICES_TEMPLATE_ID = 'tpl-cyoa-choices';
const CYOA_CHOICES_EMPTY_ROW_CLEANUP_SCRIPT_ID = '9fa2958c-215f-4fef-9a3e-804c0846f4fb';

function normalizeChatroomStyle(value = '') {
    const normalized = String(value ?? '').trim().toLowerCase();
    return CHATROOM_STYLE_VALUES.includes(normalized) ? normalized : 'mixed';
}

function normalizeChatroomCustomStyles(value = '') {
    return String(value ?? '')
        .replace(/\r\n?/g, '\n')
        .split('\n')
        .map(line => line.trim())
        .filter(Boolean)
        .join('\n')
        .slice(0, CHATROOM_CUSTOM_STYLES_MAX_CHARS);
}

function normalizeChatroomCustomStyleName(value = '') {
    return String(value ?? '').trim().slice(0, CHATROOM_CUSTOM_STYLE_NAME_MAX_CHARS);
}

function parseChatroomCustomStyles(value = '') {
    const seenNames = new Set();
    return normalizeChatroomCustomStyles(value)
        .split('\n')
        .map(line => {
            const separatorIndex = line.indexOf(':');
            if (separatorIndex <= 0) return null;

            const name = normalizeChatroomCustomStyleName(line.slice(0, separatorIndex));
            const prompt = line.slice(separatorIndex + 1).trim().slice(0, CHATROOM_CUSTOM_STYLE_PROMPT_MAX_CHARS);
            const normalizedName = name.toLowerCase();

            if (!name || !prompt || seenNames.has(normalizedName)) return null;
            seenNames.add(normalizedName);
            return { name, prompt };
        })
        .filter(Boolean);
}

function getChatroomCustomStylesSetting(settings = {}) {
    const customStyles = normalizeChatroomCustomStyles(settings?.chatroomCustomStyles);
    if (customStyles) return customStyles;

    const legacyCustomStyle = String(settings?.chatroomCustomStyle ?? '').trim();
    return legacyCustomStyle ? normalizeChatroomCustomStyles(`Custom: ${legacyCustomStyle}`) : '';
}

function normalizeChatroomExtraCharacterAvatars(value = []) {
    const rawValues = Array.isArray(value)
        ? value
        : String(value ?? '').split(/[\n,]/);
    const seenAvatars = new Set();
    const avatars = [];

    for (const rawValue of rawValues) {
        const avatar = String(rawValue ?? '').trim().slice(0, CHATROOM_EXTRA_CHARACTER_AVATAR_MAX_CHARS);
        const key = avatar.toLowerCase();
        if (!avatar || seenAvatars.has(key)) continue;

        seenAvatars.add(key);
        avatars.push(avatar);
        if (avatars.length >= CHATROOM_EXTRA_CHARACTER_LIMIT) break;
    }

    return avatars;
}

function getActiveChatroomCharacterAvatars(context = getContext()) {
    const activeAvatars = new Set();
    const characters = Array.isArray(context?.characters) ? context.characters : [];

    if (context?.groupId) {
        const activeGroup = Array.isArray(context?.groups)
            ? context.groups.find(group => String(group?.id ?? '') === String(context.groupId ?? ''))
            : null;
        const members = Array.isArray(activeGroup?.members) ? activeGroup.members : [];
        for (const avatar of members) {
            const value = String(avatar ?? '').trim();
            if (value) activeAvatars.add(value.toLowerCase());
        }
        return activeAvatars;
    }

    const characterIndex = Number(context?.characterId);
    if (Number.isInteger(characterIndex) && characters[characterIndex]?.avatar) {
        activeAvatars.add(String(characters[characterIndex].avatar).trim().toLowerCase());
    }

    return activeAvatars;
}

function getChatroomCharacterOptionLabel(character = {}, index = 0) {
    const name = String(character?.name || character?.data?.name || '').trim();
    const avatar = String(character?.avatar ?? '').trim();
    const fallbackName = avatar.replace(/\.[^.]+$/, '') || `Character ${index + 1}`;

    return name && avatar ? `${name} (${avatar})` : (name || fallbackName);
}

function getChatroomSelectableCharacters() {
    const context = getContext();
    const characters = Array.isArray(context?.characters) ? context.characters : [];
    const activeAvatars = getActiveChatroomCharacterAvatars(context);
    const seenAvatars = new Set();

    return characters
        .map((character, index) => {
            const avatar = String(character?.avatar ?? '').trim();
            const key = avatar.toLowerCase();
            if (!avatar || activeAvatars.has(key) || seenAvatars.has(key)) return null;

            seenAvatars.add(key);
            return {
                avatar,
                label: getChatroomCharacterOptionLabel(character, index),
            };
        })
        .filter(Boolean)
        .sort((a, b) => a.label.localeCompare(b.label));
}

function normalizeDirectorCommentaryVoice(value = '') {
    const normalized = String(value ?? '').trim().toLowerCase();
    return DIRECTOR_COMMENTARY_VOICE_VALUES.includes(normalized) ? normalized : 'active';
}

function normalizeDirectorCustomVoices(value = '') {
    return String(value ?? '')
        .replace(/\r\n?/g, '\n')
        .split('\n')
        .map(line => line.trim())
        .filter(Boolean)
        .join('\n')
        .slice(0, DIRECTOR_COMMENTARY_CUSTOM_VOICES_MAX_CHARS);
}

function normalizeDirectorCustomVoiceName(value = '') {
    return String(value ?? '').trim().slice(0, DIRECTOR_COMMENTARY_CUSTOM_VOICE_NAME_MAX_CHARS);
}

function parseDirectorCustomVoices(value = '') {
    const seenNames = new Set();
    return normalizeDirectorCustomVoices(value)
        .split('\n')
        .map(line => {
            const separatorIndex = line.indexOf(':');
            if (separatorIndex <= 0) return null;

            const name = normalizeDirectorCustomVoiceName(line.slice(0, separatorIndex));
            const prompt = line.slice(separatorIndex + 1).trim().slice(0, DIRECTOR_COMMENTARY_CUSTOM_VOICE_PROMPT_MAX_CHARS);
            const normalizedName = name.toLowerCase();

            if (!name || !prompt || seenNames.has(normalizedName)) return null;
            seenNames.add(normalizedName);
            return { name, prompt };
        })
        .filter(Boolean);
}

function getDirectorCustomVoicesSetting(settings = {}) {
    const customVoices = normalizeDirectorCustomVoices(settings?.directorCommentaryCustomVoices);
    if (customVoices) return customVoices;

    const legacyCustomVoice = String(settings?.directorCommentaryCustomVoice ?? '').trim();
    return legacyCustomVoice ? normalizeDirectorCustomVoices(`Custom: ${legacyCustomVoice}`) : '';
}

const REGEX_PLACEMENT_LABELS = {
    [AGENT_REGEX_PLACEMENT.AI_OUTPUT]: 'AI Output',
    [AGENT_REGEX_PLACEMENT.USER_INPUT]: 'User Input',
    [AGENT_REGEX_PLACEMENT.SLASH_COMMAND]: 'Slash Command',
    [AGENT_REGEX_PLACEMENT.WORLD_INFO]: 'World Info',
    [AGENT_REGEX_PLACEMENT.REASONING]: 'Reasoning',
};

const AGENT_PHASE_LABELS = {
    pre: 'pre',
    post: 'post',
    both: 'pre + post',
};
const DEFAULT_PRE_PROCESS = {
    mode: 'inject',
    interceptTiming: 'pre-generation',
    applyMode: 'replace',
    wrapPosition: 'after',
    wrapPrefix: '',
    wrapSuffix: '',
    patchStartTag: '<context_patch>',
    patchEndTag: '</context_patch>',
    maxTokens: DEFAULT_AGENT_MAX_TOKENS,
};

function getTemplateAssetUrl(filename) {
    return `/scripts/extensions/${MODULE_NAME}/templates/${filename}?v=${encodeURIComponent(CLIENT_VERSION || 'dev')}`;
}

function persistExtensionState() {
    extension_settings.inChatAgents = {
        ...(extension_settings.inChatAgents ?? {}),
        globalSettings: structuredClone(getGlobalSettings()),
        autoSeededTemplateIds: [...autoSeededTemplateIds],
    };
    delete extension_settings.inChatAgents.groups;
    saveSettingsDebounced();
}

function restoreAutoSeededTemplateIds(savedState) {
    const rawIds = Array.isArray(savedState?.autoSeededTemplateIds) ? savedState.autoSeededTemplateIds : [];
    autoSeededTemplateIds = new Set(
        rawIds
            .map(id => String(id ?? '').trim())
            .filter(Boolean),
    );
}

function stopEvent(event) {
    event.preventDefault();
    event.stopPropagation();
}

function getLastAssistantMessageIndex() {
    return chat.findLastIndex(message => message && !message.is_user && !message.is_system);
}

function hasTrackerFixAgents() {
    return getAgents().some(isTrackerFixAgent);
}

function hasRunnableTrackerAgents() {
    if (!areAgentsGloballyEnabled()) return false;
    return getEnabledAgents().some(isTrackerFixAgent);
}

function getFixTrackersUnavailableMessage() {
    if (!areAgentsGloballyEnabled()) {
        return 'In-Chat Agents are disabled.';
    }
    if (!hasTrackerFixAgents()) {
        return 'No tracker agents are installed. Add one from Templates first.';
    }
    if (!hasRunnableTrackerAgents()) {
        return `No tracker agents are enabled for ${getAgentChatScopeLabel().toLowerCase()}.`;
    }
    return '';
}

function showFixTrackersUnavailableToast() {
    const message = getFixTrackersUnavailableMessage();
    if (!message) return false;

    if (!areAgentsGloballyEnabled()) {
        toastr.warning(message);
    } else {
        toastr.info(message);
    }

    return true;
}

function updateCancelGenerationButton() {
    $('#ica--cancelGeneration').toggle(isAgentGenerationActive());
}

function updateAgentGenerationSendControls(active = isAgentGenerationActive()) {
    if (active) {
        // Agent post-processing should lock send controls without hiding the visible message actions.
        deactivateSendButtons({ markBodyGenerating: false });
        return;
    }

    if (!is_send_press && !is_group_generating) {
        activateSendButtons();
    }
}

function refreshGenerationUi(active = isAgentGenerationActive()) {
    updateCancelGenerationButton();
    updateAgentGenerationSendControls(active);
}

function updateGlobalAgentToggle() {
    const enabled = areAgentsGloballyEnabled();
    const button = $('#ica--globalEnabled');
    button.toggleClass('active', enabled);
    button.attr('aria-pressed', String(enabled));
    button.attr('title', enabled
        ? 'Agents are enabled. Click to disable all In-Chat Agents.'
        : 'Agents are disabled. Click to re-enable In-Chat Agents.');
    button.find('span').text(enabled ? 'Agents On' : 'Agents Off');
}

function populateSeparateRecentChatsToggle() {
    $('#ica--separateRecentChats').prop('checked', Boolean(getGlobalSettings().separateRecentChats));
}

function sortAgentsByOrder(agentList = []) {
    return [...agentList].sort((a, b) => Number(a?.injection?.order ?? 0) - Number(b?.injection?.order ?? 0));
}

async function toggleAgentEnabled(agent) {
    setAgentEnabledForCurrentScope(agent, !isAgentEnabledForCurrentScope(agent));
    await saveAgent(agent);
    refreshRegexSnapshotsForAgent(agent.id);
    persistExtensionState();
    syncToolAgentRegistrations();
    renderAgentList();
    updateCompanionButtonVisibility();
}

async function toggleAgentFavorite(agent) {
    agent.favorite = !agent.favorite;
    await saveAgent(agent);
    renderAgentList();
}

const TRACKER_COMPANION_AUTO_LOOP_VERSION = 4;

async function migrateTrackerCompanionsToAutoLoop() {
    const settings = getGlobalSettings();
    const appliedVersion = Number(settings.trackerCompanionAutoLoopVersion ?? (settings.trackerCompanionAutoLoopApplied ? 1 : 0)) || 0;
    if (appliedVersion >= TRACKER_COMPANION_AUTO_LOOP_VERSION) {
        return 0;
    }

    let migrated = 0;
    for (const agent of getAgents()) {
        const contextChanged = applyCompanionContextAccessDefaults(agent);
        const displayChanged = applyCompanionPanelDisplayDefault(agent);
        const loopChanged = applyTrackerCompanionAutoLoopDefaults(agent);
        if (contextChanged || displayChanged || loopChanged) {
            await saveAgent(agent);
            migrated++;
        }
    }

    setGlobalSettings({
        trackerCompanionAutoLoopApplied: true,
        trackerCompanionAutoLoopVersion: TRACKER_COMPANION_AUTO_LOOP_VERSION,
    });
    persistExtensionState();
    return migrated;
}

async function applyAgentExecutionConversion(agent, targetExecution) {
    const movesToCustom = targetExecution === 'inline' && agent.category === 'companion';
    if (!convertAgentExecution(agent, targetExecution)) {
        return false;
    }

    lockBundledAgentCustomization(agent);
    await saveAgent(agent);
    refreshRegexSnapshotsForAgent(agent.id);
    syncToolAgentRegistrations();
    renderAgentList();
    const companionDestination = getCompanionConfig(agent).displayMode === 'panel'
        ? 'its state now appears in the slide-out Tracker panel'
        : 'it now runs as a note card under assistant replies';
    toastr.success(targetExecution === 'companion'
        ? `"${agent.name}" converted to companion — ${companionDestination}.`
        : `"${agent.name}" now runs inline again${movesToCustom ? ' (moved to the Custom category)' : ''}.`);
    return true;
}

function findTemplateById(templateId) {
    return templates.find(template => template.id === templateId);
}

function findTemplateForAgent(agent) {
    return findTemplateForAgentSnapshot(agent, templates);
}

function findSourceTemplateForAgent(agent) {
    const sourceTemplateId = String(agent?.sourceTemplateId ?? '').trim();
    return sourceTemplateId ? findTemplateById(sourceTemplateId) : null;
}

function getAgentOrderValue(agent) {
    const order = Number(agent?.injection?.order ?? 0);
    return Number.isFinite(order) ? order : 0;
}

function getAgentVersionValue(agent) {
    const version = Number(agent?.version ?? 1);
    return Number.isFinite(version) ? version : 1;
}

function getTemplateVersionValue(template) {
    const version = Number(template?.version ?? 1);
    return Number.isFinite(version) ? version : 1;
}

function buildAgentOrderPill(agent) {
    return `<span class="ica--card-pill ica--card-pill--order" title="Lower numbers run earlier when Append Agents Execution is set to Sequential."><i class="fa-solid fa-sort-numeric-down fa-xs"></i> Order ${escapeHtml(getAgentOrderValue(agent))}</span>`;
}

function buildAgentVersionPill(agent) {
    const sourceTemplate = findSourceTemplateForAgent(agent);
    const agentVersion = getAgentVersionValue(agent);
    const templateVersion = getTemplateVersionValue(sourceTemplate);

    if (sourceTemplate && templateVersion > agentVersion) {
        return `<button type="button" class="ica--card-pill ica--card-pill--version ica--card-pill--version-update" title="A newer template is available.">v${escapeHtml(agentVersion)} &rarr; v${escapeHtml(templateVersion)}</button>`;
    }

    return `<span class="ica--card-pill ica--card-pill--version">v${escapeHtml(agentVersion)}</span>`;
}

function getBundledRegexScriptsForTemplate(templateId) {
    const bundledScripts = templateRegexBundles[String(templateId ?? '').trim()];
    return Array.isArray(bundledScripts)
        ? bundledScripts.map(script => normalizeRegexScript(script ?? {}))
        : [];
}

function shouldUseTrackerPromptPassDefaults(template) {
    return String(template?.category ?? '') === 'tracker';
}

function applyBundledTrackerPromptPass(template) {
    if (!shouldUseTrackerPromptPassDefaults(template)) {
        return template;
    }

    const postProcess = template?.postProcess && typeof template.postProcess === 'object'
        ? template.postProcess
        : {};

    return {
        ...template,
        phase: 'pre',
        postProcess: {
            ...postProcess,
            promptTransformEnabled: false,
            promptTransformShowNotifications: Object.hasOwn(postProcess, 'promptTransformShowNotifications')
                ? Boolean(postProcess.promptTransformShowNotifications)
                : true,
            promptTransformMode: 'append',
            promptTransformMaxTokens: Number.isFinite(Number(postProcess.promptTransformMaxTokens))
                ? Number(postProcess.promptTransformMaxTokens)
                : DEFAULT_AGENT_MAX_TOKENS,
        },
    };
}

function isBundledRegexPostDefaultTemplate(template, bundledScripts = null) {
    const templateId = String(template?.id ?? '').trim();
    if (!template
        || shouldUseTrackerPromptPassDefaults(template)
        || BUNDLED_REGEX_POST_DEFAULT_EXCLUDED_TEMPLATE_IDS.has(templateId)) {
        return false;
    }

    const resolvedScripts = Array.isArray(bundledScripts)
        ? bundledScripts
        : (Array.isArray(template?.regexScripts) ? template.regexScripts : getBundledRegexScriptsForTemplate(templateId));

    return Array.isArray(resolvedScripts) && resolvedScripts.length > 0;
}

function getBundledRegexPromptTransformMode(template) {
    return shouldUseTrackerPromptPassDefaults(template) ? 'append' : 'rewrite';
}

function applyBundledRegexPostDefaults(template, bundledScripts = null) {
    if (!isBundledRegexPostDefaultTemplate(template, bundledScripts)) {
        return template;
    }

    const postProcess = template?.postProcess && typeof template.postProcess === 'object'
        ? template.postProcess
        : {};
    const hasPrompt = Boolean(String(template?.prompt ?? '').trim());

    return {
        ...template,
        phase: 'post',
        postProcess: {
            ...postProcess,
            promptTransformEnabled: hasPrompt ? true : Boolean(postProcess.promptTransformEnabled),
            promptTransformShowNotifications: Object.hasOwn(postProcess, 'promptTransformShowNotifications')
                ? Boolean(postProcess.promptTransformShowNotifications)
                : true,
            promptTransformMode: hasPrompt
                ? getBundledRegexPromptTransformMode(template)
                : (postProcess.promptTransformMode === 'append' ? 'append' : 'rewrite'),
            promptTransformMaxTokens: Number.isFinite(Number(postProcess.promptTransformMaxTokens))
                ? Number(postProcess.promptTransformMaxTokens)
                : DEFAULT_AGENT_MAX_TOKENS,
        },
    };
}

function mergeTemplateDefaults(template) {
    const normalizedTemplate = {
        ...template,
        category: normalizeAgentCategory(template?.category, template?.id, template?.name),
    };
    const templateWithPromptPass = applyBundledTrackerPromptPass(normalizedTemplate);
    const bundledScripts = getBundledRegexScriptsForTemplate(templateWithPromptPass?.id);
    const templateWithRegexPostDefaults = applyBundledRegexPostDefaults(templateWithPromptPass, bundledScripts);
    if (bundledScripts.length === 0) {
        return {
            ...templateWithRegexPostDefaults,
            regexScripts: getAgentRegexScripts(templateWithRegexPostDefaults),
        };
    }

    return {
        ...templateWithRegexPostDefaults,
        regexScripts: bundledScripts,
    };
}

function getDefaultBundledTemplates() {
    return templates.filter(template => {
        const templateId = String(template?.id ?? '').trim();
        return DEFAULT_BUNDLED_TEMPLATE_IDS.has(templateId) || INTERNAL_BUNDLED_TEMPLATE_IDS.has(templateId);
    });
}

function getVisibleTemplateBrowserTemplates() {
    return templates.filter(template => !HIDDEN_TEMPLATE_BROWSER_IDS.has(String(template?.id ?? '').trim()));
}

function getVisibleInChatAgents(agentList = getAgents()) {
    return agentList.filter(agent => !isPathfinderAgent(agent));
}

function getTemplateRegexCount(template) {
    return Array.isArray(template?.regexScripts) ? template.regexScripts.length : 0;
}

const TEMPLATE_BROWSER_CATEGORY_LABELS = {
    tracker: 'Trackers',
    randomizer: 'Randomizers',
    content: 'Content',
    companion: 'Companions',
    tool: 'Tools',
};

function getTemplateBrowserCategoryOrder(templateList = templates) {
    return Object.keys(AGENT_CATEGORIES)
        .filter(category => category !== 'custom')
        .filter(category => templateList.some(template => template.category === category));
}

function getTemplateCategoryLabel(category) {
    return TEMPLATE_BROWSER_CATEGORY_LABELS[category] ?? AGENT_CATEGORIES[category]?.label ?? 'Custom';
}

function getTemplateSubcategoryInfo(subcategory) {
    const normalizedSubcategory = String(subcategory ?? '').trim();
    return normalizedSubcategory ? AGENT_SUBCATEGORIES[normalizedSubcategory] ?? null : null;
}

function getTemplateSubcategoryLabel(template) {
    const subcategoryInfo = getTemplateSubcategoryInfo(template?.subcategory);
    return subcategoryInfo?.label ?? String(template?.subcategory ?? '').trim();
}

function getTemplateSubcategoriesForCategory(category) {
    return Object.entries(AGENT_SUBCATEGORIES)
        .filter(([, subcategory]) => subcategory.category === category);
}

function sortTemplatesByName(templateList = []) {
    return [...templateList].sort((a, b) => String(a?.name ?? '').localeCompare(String(b?.name ?? '')));
}

function getTemplateSearchHaystack(template) {
    const categoryLabel = getTemplateCategoryLabel(template?.category);
    const subcategoryLabel = getTemplateSubcategoryLabel(template);
    const tags = Array.isArray(template?.tags) ? template.tags.join(' ') : '';

    return [
        template?.name,
        template?.description,
        tags,
        categoryLabel,
        subcategoryLabel,
    ].join(' ').toLowerCase();
}

function filterTemplates(templateList = templates, { searchTerm = '', category = '' } = {}) {
    const normalizedSearchTerm = String(searchTerm ?? '').trim().toLowerCase();
    const normalizedCategory = String(category ?? '').trim();

    return templateList.filter(template => {
        if (normalizedCategory && template.category !== normalizedCategory) {
            return false;
        }

        if (!normalizedSearchTerm) {
            return true;
        }

        return getTemplateSearchHaystack(template).includes(normalizedSearchTerm);
    });
}

function describeRegexPlacements(regexScript) {
    return (regexScript.placement || [])
        .map(placement => REGEX_PLACEMENT_LABELS[placement] || `Placement ${placement}`)
        .join(', ');
}

function describeRegexScript(regexScript) {
    const mode = regexScript.promptOnly
        ? 'prompt'
        : (regexScript.markdownOnly ? 'markdown' : 'raw');
    const toggles = [
        mode,
        regexScript.runOnEdit ? 'edit' : null,
        regexScript.disabled ? 'disabled' : null,
    ].filter(Boolean).join(' • ');
    const placements = describeRegexPlacements(regexScript) || 'AI Output';
    return `${placements} • ${toggles}`;
}

function buildRegexTemplateLabel(regexCount) {
    if (regexCount <= 0) {
        return '';
    }

    return regexCount === 1 ? '1 regex' : `${regexCount} regex`;
}

function hasPromptTransform(agent) {
    return Boolean(
        agent?.postProcess?.promptTransformEnabled &&
        ['post', 'both'].includes(String(agent?.phase ?? '')) &&
        String(agent?.prompt ?? '').trim(),
    );
}

function getAgentPreProcess(agent) {
    return {
        ...DEFAULT_PRE_PROCESS,
        ...(agent?.preProcess ?? {}),
    };
}

function isPreGenerationInterceptAgent(agent) {
    return Boolean(
        ['pre', 'both'].includes(String(agent?.phase ?? '')) &&
        getAgentPreProcess(agent).mode === 'intercept',
    );
}

function isPostMainGenerationInterceptAgent(agent) {
    return Boolean(
        isPreGenerationInterceptAgent(agent) &&
        getAgentPreProcess(agent).interceptTiming === 'post-main-generation',
    );
}

function canPreviewPreGenerationPrompt(agent) {
    return Boolean(
        !isPathfinderAgent(agent) &&
        !isCompanionAgent(agent) &&
        ['pre', 'both'].includes(String(agent?.phase ?? '')) &&
        String(agent?.prompt ?? '').trim(),
    );
}

function getPromptTransformLabel(agent) {
    return getPromptTransformMode(agent) === 'append' ? 'prompt append' : 'prompt rewrite';
}

function getCompanionTriggerLabel(companion) {
    return companion.trigger === 'manual' ? 'manual' : 'auto';
}

function getCompanionDisplayLabel(companion) {
    return companion.displayMode === 'hidden' ? 'hidden' : 'card';
}

function buildCompanionCardPill(agent) {
    if (!isCompanionAgent(agent)) {
        return '';
    }

    const companion = getCompanionConfig(agent);
    const labels = [
        getCompanionTriggerLabel(companion),
        getCompanionDisplayLabel(companion),
    ];
    return `<span class="ica--card-pill ica--card-pill--companion"><i class="fa-solid fa-user-astronaut fa-xs"></i> companion ${escapeHtml(labels.join(' / '))}</span>`;
}

function buildCompanionFeedbackPreviewText(agent) {
    const companion = getCompanionConfig(agent);
    if (!companion.feedback.enabled) {
        return 'Feedback is disabled for this companion.';
    }

    const results = collectRecentCompanionResults(agent.id, {
        beforeMessageIndex: chat.length,
        depth: companion.feedback.depth,
    });
    const body = results
        .map(result => `Message ${result.messageIndex}:\n${normalizeContentText(result.content)}`)
        .filter(Boolean)
        .join('\n\n');

    if (!body.trim()) {
        return `[${agent.name || 'Companion'} - auxiliary notes]\n(no completed companion notes found)`;
    }

    return `[${agent.name || 'Companion'} - auxiliary notes]\n${body}`;
}

async function previewCompanionFeedbackPrompt(agent) {
    const previewText = buildCompanionFeedbackPreviewText(agent);
    const previewHtml = $(
        `<div class="ica--prompt-preview">
            <div class="ica--regex-note">Preview of the helper prompt inserted before the next generation when feedback is enabled.</div>
            <pre>${escapeHtml(previewText)}</pre>
        </div>`,
    );

    await new Popup(previewHtml, POPUP_TYPE.TEXT, '', {
        wide: true,
        large: true,
        allowVerticalScrolling: true,
        leftAlign: true,
    }).show();
}

async function previewPreGenerationPrompt(agent, promptOverride = null) {
    const prompt = String(promptOverride ?? agent?.prompt ?? '');
    if (!prompt.trim()) {
        toastr.warning('Enter a prompt before previewing it.');
        return;
    }

    const previewText = substituteParams(prompt, {
        dynamicMacros: buildPromptDynamicMacros('', null, agent, 'normal'),
    });
    const previewNote = isPreGenerationInterceptAgent(agent)
        ? isPostMainGenerationInterceptAgent(agent)
            ? 'Preview shows the agent instruction after macro substitution. At runtime, post-main intercept mode also receives the fresh assistant output and can rewrite it before it is shown or saved.'
            : 'Preview shows the agent instruction after macro substitution. At runtime, intercept mode also receives the assembled outgoing context and can rewrite it before the main model sees it.'
        : 'Preview uses the current chat context with no generated assistant message yet. Random macros are evaluated now and may differ when the agent runs.';
    const previewHtml = $(
        `<div class="ica--prompt-preview">
            <div class="ica--regex-note">${escapeHtml(previewNote)}</div>
            <pre>${escapeHtml(previewText || '(empty after macro substitution)')}</pre>
        </div>`,
    );

    await new Popup(previewHtml, POPUP_TYPE.TEXT, '', {
        wide: true,
        large: true,
        allowVerticalScrolling: true,
        leftAlign: true,
    }).show();
}

function buildAgentFromTemplate(template) {
    const agent = {
        ...createDefaultAgent(),
        ...structuredClone(mergeTemplateDefaults(template)),
        id: uuidv4(),
        sourceTemplateId: template.id,
        enabled: false,
    };
    delete agent.subcategory;
    return agent;
}

function buildUpdatedAgentFromTemplate(agent, template) {
    const updatedAgent = buildAgentFromTemplate(template);
    updatedAgent.id = agent.id;
    updatedAgent.enabled = Boolean(agent.enabled);
    updatedAgent.favorite = Boolean(agent.favorite);
    updatedAgent.connectionProfile = typeof agent.connectionProfile === 'string' ? agent.connectionProfile : '';
    updatedAgent.modelOverride = typeof agent.modelOverride === 'string' ? agent.modelOverride : '';
    updatedAgent.injection = {
        ...updatedAgent.injection,
        order: getAgentOrderValue(agent),
    };
    updatedAgent.phaseLocked = false;
    return updatedAgent;
}

async function updateAgentFromSourceTemplate(agent) {
    const template = findSourceTemplateForAgent(agent);
    if (!template) {
        return;
    }

    const agentVersion = getAgentVersionValue(agent);
    const templateVersion = getTemplateVersionValue(template);
    const result = await new Popup(
        `Update "${escapeHtml(agent.name || template.name)}" from template v${escapeHtml(agentVersion)} to v${escapeHtml(templateVersion)}? Enabled state, quick toggle pin, order, and profile overrides will be kept.`,
        POPUP_TYPE.CONFIRM,
    ).show();

    if (result !== POPUP_RESULT.AFFIRMATIVE) {
        return;
    }

    await saveAgent(buildUpdatedAgentFromTemplate(agent, template));
    renderAgentList();
    toastr.success(`Updated "${template.name}" to v${templateVersion}.`);
}

function buildAgentFromSnapshot(snapshot) {
    return {
        ...createDefaultAgent(),
        ...structuredClone(snapshot),
        id: uuidv4(),
        enabled: false,
    };
}

globalThis.SillyBunnyAgents = Object.assign(globalThis.SillyBunnyAgents || {}, {
    getEnabledAgents,
});

function getComparableAgentSnapshot(agent) {
    const snapshot = structuredClone(agent || {});
    delete snapshot.id;
    delete snapshot.enabled;
    delete snapshot.favorite;
    return snapshot;
}

function stableAgentComparableValue(value) {
    if (Array.isArray(value)) {
        return value.map(stableAgentComparableValue);
    }

    if (value && typeof value === 'object') {
        return Object.fromEntries(
            Object.entries(value)
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([key, entryValue]) => [key, stableAgentComparableValue(entryValue)]),
        );
    }

    return value;
}

function getComparableAgentKey(agent) {
    return JSON.stringify(stableAgentComparableValue(getComparableAgentSnapshot(agent)));
}

function hasIdenticalAgent(agent, existingAgents = getAgents()) {
    const candidateKey = getComparableAgentKey(agent);
    const candidateName = String(agent?.name ?? '').trim();

    return existingAgents.some(existingAgent =>
        String(existingAgent?.name ?? '').trim() === candidateName &&
        getComparableAgentKey(existingAgent) === candidateKey,
    );
}

async function confirmDuplicateAgentAddition(agent, existingAgents = getAgents()) {
    if (hasIdenticalAgent(agent, existingAgents)) {
        const result = await new Popup(
            'An identical agent is already active. Add anyway?',
            POPUP_TYPE.CONFIRM,
            'Duplicate agent',
            {
                okButton: 'Add Agent',
                cancelButton: 'Cancel',
            },
        ).show();

        return result === POPUP_RESULT.AFFIRMATIVE;
    }

    const sourceTemplateId = String(agent?.sourceTemplateId ?? '').trim();
    const hasSameTemplateAgent = sourceTemplateId && existingAgents.some(existingAgent =>
        String(existingAgent?.sourceTemplateId ?? '').trim() === sourceTemplateId,
    );
    if (!hasSameTemplateAgent) {
        return true;
    }

    const agentName = String(agent?.name ?? 'this template').trim() || 'this template';
    const result = await new Popup(
        `You already have a "${escapeHtml(agentName)}" agent installed. Add another copy?`,
        POPUP_TYPE.CONFIRM,
        'Duplicate agent',
        {
            okButton: 'Add Another',
            cancelButton: 'Cancel',
        },
    ).show();

    return result === POPUP_RESULT.AFFIRMATIVE;
}

function shouldMigratePathfinderAgentTools(agent, template) {
    if (!template) {
        return false;
    }

    if (String(template?.id ?? '').trim() !== 'tpl-pathfinder') {
        return false;
    }

    const templateTools = Array.isArray(template?.tools) ? template.tools : [];
    const agentTools = Array.isArray(agent?.tools) ? agent.tools : [];
    const agentToolNames = new Set(agentTools.map(tool => tool?.name).filter(Boolean));
    const expectedToolNames = new Set([...templateTools, ...getPathfinderToolDefinitions()].map(tool => tool?.name).filter(Boolean));
    const toolStates = agent?.settings?.toolStates;
    const hasAllToolStates = toolStates && typeof toolStates === 'object' && [...expectedToolNames].every(name => Object.hasOwn(toolStates, name));

    return expectedToolNames.size > 0 && ([...expectedToolNames].some(name => !agentToolNames.has(name)) || !hasAllToolStates);
}

function getDefaultPathfinderTools(template) {
    const toolsByName = new Map();
    const templateTools = Array.isArray(template?.tools) ? template.tools : [];
    for (const tool of [...templateTools, ...getPathfinderToolDefinitions()]) {
        if (tool?.name && !toolsByName.has(tool.name)) {
            toolsByName.set(tool.name, tool);
        }
    }

    return [...toolsByName.values()];
}

async function migratePathfinderAgentToolsFromTemplate() {
    let migratedCount = 0;

    for (const agent of getAgents()) {
        const template = findTemplateForAgent(agent);
        if (!shouldMigratePathfinderAgentTools(agent, template)) {
            continue;
        }

        const existingTools = Array.isArray(agent.tools) ? agent.tools : [];
        const existingToolNames = new Set(existingTools.map(tool => tool?.name).filter(Boolean));
        const defaultTools = getDefaultPathfinderTools(template);
        const missingTools = defaultTools
            .filter(tool => tool?.name && !existingToolNames.has(tool.name))
            .map(tool => structuredClone(tool));
        const toolStates = { ...(agent.settings?.toolStates || {}) };
        for (const tool of [...existingTools, ...missingTools]) {
            if (!tool?.name || Object.hasOwn(toolStates, tool.name)) {
                continue;
            }
            toolStates[tool.name] = tool.enabled !== false;
        }

        agent.tools = [...existingTools, ...missingTools];
        agent.settings = {
            ...(agent.settings || {}),
            toolStates,
        };
        agent.sourceTemplateId = agent.sourceTemplateId || template.id;
        await saveAgent(agent);
        migratedCount++;
    }

    return migratedCount;
}

function shouldSkipBundledTemplateMigrations(agent) {
    return Boolean(agent?.phaseLocked);
}

function lockBundledAgentCustomization(agent, template = null) {
    const linkedTemplate = template ?? findTemplateForAgent(agent);
    const templateId = String(linkedTemplate?.id ?? agent?.sourceTemplateId ?? '').trim();
    if (!templateId) {
        return false;
    }

    agent.sourceTemplateId = templateId;
    agent.phaseLocked = true;
    return true;
}

function shouldMigrateBundledRegex(agent) {
    if (!agent || shouldSkipBundledTemplateMigrations(agent) || getAgentRegexScripts(agent).length > 0) {
        return false;
    }

    const template = findTemplateForAgent(agent);
    return Boolean(template && getTemplateRegexCount(template) > 0);
}

async function migrateBundledRegexScriptsToSavedAgents() {
    for (const agent of getAgents()) {
        if (!shouldMigrateBundledRegex(agent)) {
            continue;
        }

        const template = findTemplateForAgent(agent);
        if (!template) {
            continue;
        }

        agent.regexScripts = structuredClone(template.regexScripts);
        agent.sourceTemplateId = agent.sourceTemplateId || template.id;
        await saveAgent(agent);
    }
}

function hasCyoaChoiceEmptyRowCleanup(agent) {
    return getAgentRegexScripts(agent).some(script =>
        script.id === CYOA_CHOICES_EMPTY_ROW_CLEANUP_SCRIPT_ID
        || String(script.scriptName ?? '').trim().toLowerCase() === 'remove empty choice rows',
    );
}

function shouldMigrateCyoaChoiceRegexCleanup(agent, template) {
    if (!template || shouldSkipBundledTemplateMigrations(agent)) {
        return false;
    }

    if (String(template?.id ?? '').trim() !== CYOA_CHOICES_TEMPLATE_ID) {
        return false;
    }

    if (String(agent?.name ?? '').trim() !== String(template?.name ?? '').trim()) {
        return false;
    }

    if (String(agent?.prompt ?? '').trim() !== String(template?.prompt ?? '').trim()) {
        return false;
    }

    return !hasCyoaChoiceEmptyRowCleanup(agent);
}

async function migrateCyoaChoiceRegexCleanupToSavedAgents() {
    let migratedCount = 0;

    for (const agent of getAgents()) {
        const template = findTemplateForAgent(agent);
        if (!shouldMigrateCyoaChoiceRegexCleanup(agent, template)) {
            continue;
        }

        agent.regexScripts = structuredClone(template.regexScripts);
        agent.sourceTemplateId = agent.sourceTemplateId || template.id;
        await saveAgent(agent);
        migratedCount++;
    }

    return migratedCount;
}

async function migrateBundledTemplateMetadataToSavedAgents() {
    let migratedCount = 0;

    for (const agent of getAgents()) {
        if (shouldSkipBundledTemplateMigrations(agent)) {
            continue;
        }

        const template = findTemplateForAgent(agent);
        if (!template) {
            continue;
        }

        const desiredTemplate = mergeTemplateDefaults(template);
        const desiredAuthor = typeof desiredTemplate.author === 'string' ? desiredTemplate.author : '';
        const currentAuthor = typeof agent.author === 'string' ? agent.author : '';

        if (currentAuthor === desiredAuthor) {
            continue;
        }

        agent.author = desiredAuthor;
        agent.sourceTemplateId = agent.sourceTemplateId || template.id;
        await saveAgent(agent);
        migratedCount++;
    }

    return migratedCount;
}

function shouldMigrateBundledTrackerPromptPass(agent, template) {
    if (!template || !shouldUseTrackerPromptPassDefaults(template)) {
        return false;
    }

    if (shouldSkipBundledTemplateMigrations(agent)) {
        return false;
    }

    if (String(agent?.name ?? '').trim() !== String(template?.name ?? '').trim()) {
        return false;
    }

    if (String(agent?.prompt ?? '').trim() !== String(template?.prompt ?? '').trim()) {
        return false;
    }

    const mergedDefaults = mergeTemplateDefaults(template);
    const desiredPhase = mergedDefaults.phase ?? 'pre';
    const desiredRole = mergedDefaults.injection?.role ?? 1;
    const desiredPromptTransformEnabled = Boolean(mergedDefaults.postProcess?.promptTransformEnabled);
    const desiredPromptTransformMode = mergedDefaults.postProcess?.promptTransformMode === 'append' ? 'append' : 'rewrite';
    return String(agent?.phase ?? '') !== desiredPhase
        || Number(agent?.injection?.role ?? 0) !== desiredRole
        || Boolean(agent?.postProcess?.promptTransformEnabled) !== desiredPromptTransformEnabled
        || (agent?.postProcess?.promptTransformMode ?? 'rewrite') !== desiredPromptTransformMode;
}

async function migrateBundledTrackerPromptPassesToSavedAgents() {
    let migratedCount = 0;

    for (const agent of getAgents()) {
        const template = findTemplateForAgent(agent);
        if (!shouldMigrateBundledTrackerPromptPass(agent, template)) {
            continue;
        }

        const mergedTemplate = mergeTemplateDefaults(template);
        agent.phase = String(mergedTemplate.phase ?? 'pre');
        agent.injection.role = Number(mergedTemplate.injection?.role ?? 1);
        agent.sourceTemplateId = agent.sourceTemplateId || template.id;
        agent.postProcess.promptTransformEnabled = Boolean(mergedTemplate.postProcess?.promptTransformEnabled);
        agent.postProcess.promptTransformShowNotifications = Object.hasOwn(mergedTemplate.postProcess ?? {}, 'promptTransformShowNotifications')
            ? Boolean(mergedTemplate.postProcess?.promptTransformShowNotifications)
            : true;
        agent.postProcess.promptTransformMode = mergedTemplate.postProcess?.promptTransformMode === 'append' ? 'append' : 'rewrite';
        agent.postProcess.promptTransformMaxTokens = Number(mergedTemplate.postProcess?.promptTransformMaxTokens) || DEFAULT_AGENT_MAX_TOKENS;
        await saveAgent(agent);
        migratedCount++;
    }

    return migratedCount;
}

function shouldMigrateBundledRegexPostDefaults(agent, template) {
    if (!template) {
        return false;
    }

    if (shouldSkipBundledTemplateMigrations(agent)) {
        return false;
    }

    const desiredTemplate = mergeTemplateDefaults(template);
    if (!isBundledRegexPostDefaultTemplate(desiredTemplate, desiredTemplate.regexScripts)) {
        return false;
    }

    if (String(agent?.name ?? '').trim() !== String(template?.name ?? '').trim()) {
        return false;
    }

    if (String(agent?.prompt ?? '').trim() !== String(template?.prompt ?? '').trim()) {
        return false;
    }

    if (String(agent?.phase ?? '') !== String(desiredTemplate?.phase ?? 'post')) {
        return true;
    }

    if (!desiredTemplate?.postProcess?.promptTransformEnabled) {
        return false;
    }

    if (!agent?.postProcess?.promptTransformEnabled) {
        return true;
    }

    return getPromptTransformMode(agent) !== getPromptTransformMode(desiredTemplate);
}

function shouldMigrateBundledPromptTransformImpersonate(agent, template) {
    if (!template) {
        return false;
    }

    if (shouldSkipBundledTemplateMigrations(agent)) {
        return false;
    }

    const templateId = String(template?.id ?? '').trim();
    if (!BUNDLED_PROMPT_TRANSFORM_IMPERSONATE_TEMPLATE_IDS.has(templateId)) {
        return false;
    }

    if (String(agent?.name ?? '').trim() !== String(template?.name ?? '').trim()) {
        return false;
    }

    if (String(agent?.prompt ?? '').trim() !== String(template?.prompt ?? '').trim()) {
        return false;
    }

    const desiredTemplate = mergeTemplateDefaults(template);
    const desiredRunOnImpersonate = Boolean(desiredTemplate?.conditions?.runOnImpersonate);
    return Boolean(agent?.conditions?.runOnImpersonate) !== desiredRunOnImpersonate;
}

async function migrateBundledPromptTransformImpersonateToSavedAgents() {
    let migratedCount = 0;

    for (const agent of getAgents()) {
        const template = findTemplateForAgent(agent);
        if (!shouldMigrateBundledPromptTransformImpersonate(agent, template)) {
            continue;
        }

        const desiredTemplate = mergeTemplateDefaults(template);
        agent.conditions.runOnImpersonate = Boolean(desiredTemplate?.conditions?.runOnImpersonate);
        await saveAgent(agent);
        migratedCount++;
    }

    return migratedCount;
}

async function migrateBundledRegexPostDefaultsToSavedAgents() {
    let migratedCount = 0;

    for (const agent of getAgents()) {
        const template = findTemplateForAgent(agent);
        if (!shouldMigrateBundledRegexPostDefaults(agent, template)) {
            continue;
        }

        const desiredTemplate = mergeTemplateDefaults(template);
        agent.phase = String(desiredTemplate.phase ?? 'post');
        agent.sourceTemplateId = agent.sourceTemplateId || template.id;

        if (desiredTemplate?.postProcess?.promptTransformEnabled) {
            agent.postProcess.promptTransformEnabled = true;
            agent.postProcess.promptTransformShowNotifications = Object.hasOwn(desiredTemplate.postProcess ?? {}, 'promptTransformShowNotifications')
                ? Boolean(desiredTemplate.postProcess.promptTransformShowNotifications)
                : true;
            agent.postProcess.promptTransformMode = getPromptTransformMode(desiredTemplate);
            agent.postProcess.promptTransformMaxTokens = Number(desiredTemplate.postProcess?.promptTransformMaxTokens) || DEFAULT_AGENT_MAX_TOKENS;
        }

        await saveAgent(agent);
        migratedCount++;
    }

    return migratedCount;
}

async function migrateLegacyPromptTransformMaxTokens() {
    let migratedCount = 0;

    for (const agent of getAgents()) {
        if (shouldSkipBundledTemplateMigrations(agent)) {
            continue;
        }

        const currentValue = Number(agent?.postProcess?.promptTransformMaxTokens);
        if (currentValue !== LEGACY_AGENT_MAX_TOKENS) {
            continue;
        }

        agent.postProcess.promptTransformMaxTokens = DEFAULT_AGENT_MAX_TOKENS;
        await saveAgent(agent);
        migratedCount++;
    }

    return migratedCount;
}

async function removeRedundantBundledAgentDuplicates() {
    const redundantIds = getRedundantBundledAgentDuplicateIds(getAgents(), templates);

    for (const agentId of redundantIds) {
        await deleteAgent(agentId);
    }

    return redundantIds.length;
}

async function purgeRemovedBundledAgents() {
    let removedCount = 0;

    for (const agent of [...getAgents()]) {
        const sourceTemplateId = String(agent?.sourceTemplateId ?? '').trim();
        const agentName = String(agent?.name ?? '').trim().toLowerCase();
        const agentAuthor = String(agent?.author ?? '').trim().toLowerCase();
        const isRemovedBundledAgent = REMOVED_BUNDLED_TEMPLATE_IDS.has(sourceTemplateId)
            || (REMOVED_BUNDLED_AGENT_NAMES.has(agentName) && agentAuthor === 'sillybunny');

        if (!isRemovedBundledAgent) {
            continue;
        }

        await deleteAgent(agent.id);
        removedCount++;
    }

    return removedCount;
}

async function loadCustomGroupsFromServer() {
    const response = await fetch('/api/in-chat-agents/groups/list', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({}),
    });

    if (!response.ok) {
        throw new Error('Failed to load custom groups');
    }

    const groups = await response.json();
    loadCustomGroups(groups);
}

async function ensureDefaultBundledAgents() {
    let touchedSeedState = false;

    for (const template of getDefaultBundledTemplates()) {
        const templateId = String(template?.id ?? '').trim();
        if (!templateId) {
            continue;
        }

        const shouldEnsureTemplate = INTERNAL_BUNDLED_TEMPLATE_IDS.has(templateId) || !autoSeededTemplateIds.has(templateId);
        if (shouldEnsureTemplate) {
            const seededAgent = buildAgentFromTemplate(template);
            if (!hasMatchingAgentSnapshot(seededAgent)) {
                await saveAgent(seededAgent);
            }
        }

        if (!autoSeededTemplateIds.has(templateId)) {
            autoSeededTemplateIds.add(templateId);
            touchedSeedState = true;
        }
    }

    if (touchedSeedState) {
        persistExtensionState();
    }
}

async function migrateLegacyGroups(legacyGroups = []) {
    if (!Array.isArray(legacyGroups) || legacyGroups.length === 0) {
        return 0;
    }

    const existingCustomGroupIds = new Set(getCustomGroups().map(group => group.id));
    let migratedCount = 0;

    for (const group of legacyGroups) {
        if (!group || typeof group !== 'object') {
            continue;
        }

        const groupId = String(group.id ?? '').trim();
        if (groupId && existingCustomGroupIds.has(groupId)) {
            continue;
        }

        await saveGroup({
            ...structuredClone(group),
            builtin: false,
        });
        if (groupId) {
            existingCustomGroupIds.add(groupId);
        }
        migratedCount++;
    }

    return migratedCount;
}

function hasMatchingAgentSnapshot(snapshot, existingAgents = getAgents()) {
    const snapshotTemplateId = String(snapshot?.sourceTemplateId ?? '').trim();
    const snapshotName = String(snapshot?.name ?? '').trim().toLowerCase();
    const snapshotPrompt = String(snapshot?.prompt ?? '').trim();

    return existingAgents.some(agent => {
        const existingTemplateId = String(agent?.sourceTemplateId ?? '').trim();
        const existingName = String(agent?.name ?? '').trim().toLowerCase();
        const existingPrompt = String(agent?.prompt ?? '').trim();

        if (snapshotTemplateId && existingTemplateId === snapshotTemplateId) {
            return true;
        }

        if (snapshotTemplateId && snapshotName && existingName === snapshotName) {
            return true;
        }

        if (!snapshotName || existingName !== snapshotName) {
            return false;
        }

        if (snapshotPrompt) {
            return existingPrompt === snapshotPrompt;
        }

        return true;
    });
}

// ===================== Panel Rendering =====================

async function reorderAgentsInGroup(orderedIds) {
    const normalizedOrderedIds = Array.from(new Set(
        orderedIds
            .map(id => String(id ?? '').trim())
            .filter(Boolean),
    ));

    if (normalizedOrderedIds.length === 0) {
        renderAgentList();
        return;
    }

    const firstAgent = getAgentById(normalizedOrderedIds[0]);
    if (!firstAgent) {
        renderAgentList();
        return;
    }

    const targetCategory = String(firstAgent.category ?? '').trim();
    const sortedAgents = getAgents()
        .sort((a, b) => Number(a?.injection?.order ?? 0) - Number(b?.injection?.order ?? 0));
    const categoryIds = sortedAgents
        .filter(agent => String(agent?.category ?? '').trim() === targetCategory)
        .map(agent => agent.id);

    if (categoryIds.length === 0) {
        renderAgentList();
        return;
    }

    const visibleIdSet = new Set(normalizedOrderedIds);
    const reorderedCategoryIds = [
        ...normalizedOrderedIds.filter(id => categoryIds.includes(id)),
        ...categoryIds.filter(id => !visibleIdSet.has(id)),
    ];

    let categoryIndex = 0;
    const finalOrderIds = sortedAgents.map(agent => {
        if (String(agent?.category ?? '').trim() !== targetCategory) {
            return agent.id;
        }

        const nextId = reorderedCategoryIds[categoryIndex];
        categoryIndex += 1;
        return nextId ?? agent.id;
    });

    for (let i = 0; i < finalOrderIds.length; i++) {
        const agent = getAgentById(finalOrderIds[i]);
        if (!agent) {
            continue;
        }

        const desiredOrder = i * 10;
        if (Number(agent?.injection?.order ?? 0) === desiredOrder) {
            continue;
        }

        agent.injection.order = desiredOrder;
        await saveAgent(agent);
    }

    renderAgentList();
}

function isTouchSortableDevice() {
    const coarsePointer = window.matchMedia?.('(pointer: coarse)').matches
        || window.matchMedia?.('(any-pointer: coarse)').matches;
    return Boolean(coarsePointer);
}

function setupCategorySortable(itemsEl) {
    const items = $(itemsEl);
    if (!items.length || typeof items.sortable !== 'function') {
        return;
    }

    if (items.sortable('instance') !== undefined) {
        items.sortable('destroy');
    }

    const touchSortable = isTouchSortableDevice();

    items.sortable({
        items: '.ica--agent-card',
        handle: touchSortable ? '.ica--card-drag-handle' : null,
        delay: touchSortable ? 1500 : getSortableDelay(),
        distance: touchSortable ? 16 : 8,
        tolerance: 'pointer',
        cancel: '.ica--card-actions, .ica--card-actions *, .ica--card-toggle, .ica--card-select, .ica--card-favorite',
        placeholder: 'ica--agent-card-placeholder',
        forcePlaceholderSize: true,
        start: function (_event, ui) {
            suppressCardClickUntil = Date.now() + 750;
            ui.placeholder.height(ui.item.outerHeight());
        },
        stop: async function () {
            suppressCardClickUntil = Date.now() + 750;
            const orderedIds = items.children('.ica--agent-card').map((_, el) => el.dataset.agentId).get();
            await reorderAgentsInGroup(orderedIds);
        },
    });
}

function updateBulkBar() {
    const count = selectedAgentIds.size;
    $('#ica--bulkCount').text(`${count} selected`);
    $('#ica--bulkBar').toggle(selectModeActive);
    $('#ica--selectMode').toggleClass('is-active', selectModeActive);
}

function exitSelectMode() {
    selectModeActive = false;
    selectedAgentIds.clear();
    updateBulkBar();
    renderAgentList();
}

function openBulkEditPopup() {
    const popup = document.getElementById('ica--bulkEditPopup');
    if (!popup) return;
    $('#ica--bulkEdit-role').val('');
    $('#ica--bulkEdit-phase').val('');
    $('#ica--bulkEdit-promptMode').val('');
    $('#ica--bulkEdit-promptEnabled').val('');
    $('#ica--bulkEdit-ppEnabled').val('');
    $('#ica--bulkEdit-scan').val('');
    popup.style.display = '';
}

function closeBulkEditPopup() {
    const popup = document.getElementById('ica--bulkEditPopup');
    if (popup) popup.style.display = 'none';
}

function getScrollContainer(element) {
    let current = element instanceof HTMLElement ? element : null;

    while (current) {
        const style = window.getComputedStyle(current);
        const overflowY = style.overflowY;
        const isScrollable = ['auto', 'scroll', 'overlay'].includes(overflowY)
            && current.scrollHeight > current.clientHeight;
        if (isScrollable) {
            return current;
        }

        current = current.parentElement;
    }

    return document.scrollingElement instanceof HTMLElement
        ? document.scrollingElement
        : document.documentElement;
}

function captureAgentListScrollState(agentListElement) {
    const scrollContainer = getScrollContainer(agentListElement);
    if (!(scrollContainer instanceof HTMLElement)) {
        return null;
    }

    return {
        container: scrollContainer,
        scrollTop: scrollContainer.scrollTop,
        scrollLeft: scrollContainer.scrollLeft,
    };
}

function restoreAgentListScrollState(scrollState) {
    if (!(scrollState?.container instanceof HTMLElement)) {
        return;
    }

    requestAnimationFrame(() => {
        scrollState.container.scrollTop = Math.min(
            scrollState.scrollTop,
            Math.max(0, scrollState.container.scrollHeight - scrollState.container.clientHeight),
        );
        scrollState.container.scrollLeft = scrollState.scrollLeft;
    });
}

async function applyBulkEdit() {
    const role = $('#ica--bulkEdit-role').val();
    const phase = $('#ica--bulkEdit-phase').val();
    const promptMode = $('#ica--bulkEdit-promptMode').val();
    const promptEnabled = $('#ica--bulkEdit-promptEnabled').val();
    const ppEnabled = $('#ica--bulkEdit-ppEnabled').val();
    const scan = $('#ica--bulkEdit-scan').val();

    if (!role && !phase && !promptMode && !promptEnabled && !ppEnabled && !scan) {
        toastr.info('No properties selected to change.');
        return;
    }

    let changed = 0;
    for (const id of selectedAgentIds) {
        const agent = getAgentById(id);
        if (!agent) continue;
        let dirty = false;

        if (role !== '') {
            const r = Number(role);
            if (agent.injection.role !== r) {
                agent.injection.role = r;
                dirty = true;
            }
        }
        if (phase !== '') {
            if (agent.phase !== phase) {
                agent.phase = phase;
                dirty = true;
            }
        }
        if (promptMode !== '') {
            agent.postProcess = agent.postProcess || {};
            if (agent.postProcess.promptTransformMode !== promptMode) {
                agent.postProcess.promptTransformMode = promptMode;
                dirty = true;
            }
        }
        if (promptEnabled !== '') {
            agent.postProcess = agent.postProcess || {};
            const val = promptEnabled === 'true';
            if (Boolean(agent.postProcess.promptTransformEnabled) !== val) {
                agent.postProcess.promptTransformEnabled = val;
                dirty = true;
            }
        }
        if (ppEnabled !== '') {
            agent.postProcess = agent.postProcess || {};
            const val = ppEnabled === 'true';
            if (Boolean(agent.postProcess.enabled) !== val) {
                agent.postProcess.enabled = val;
                dirty = true;
            }
        }
        if (scan !== '') {
            const val = scan === 'true';
            if (Boolean(agent.injection.scan) !== val) {
                agent.injection.scan = val;
                dirty = true;
            }
        }

        if (dirty) {
            lockBundledAgentCustomization(agent);
            await saveAgent(agent);
            changed++;
        }
    }

    closeBulkEditPopup();
    if (changed > 0) {
        toastr.success(`Updated ${changed} agent(s).`);
    } else {
        toastr.info('No agents needed updating.');
    }
    exitSelectMode();
}

function updateFixTrackersButtonVisibility() {
    const shouldShowMessageButtons = areAgentsGloballyEnabled() && hasTrackerFixAgents();
    $('.mes_fix_trackers').each(function () {
        const $message = $(this).closest('.mes');
        const isAssistantMessage = $message.attr('is_user') !== 'true' && $message.attr('is_system') !== 'true';
        $(this).toggle(shouldShowMessageButtons && isAssistantMessage);
    });

    const $agentsButton = $('#ica--fixTrackers');
    const canRun = hasRunnableTrackerAgents();
    const unavailableMessage = getFixTrackersUnavailableMessage();
    $agentsButton.show();
    $agentsButton.prop('disabled', fixTrackersRunning);
    $agentsButton.attr('aria-disabled', String(!canRun || fixTrackersRunning));
    $agentsButton.attr('title', unavailableMessage || 'Re-run enabled tracker agents on the last assistant reply');
}

async function runTrackerFixFromButton(messageIndex, button) {
    if (fixTrackersRunning) return;
    fixTrackersRunning = true;
    const $button = $(button);
    $button.prop('disabled', true).addClass('mes_fix_trackers--running');
    updateFixTrackersButtonVisibility();
    try {
        await runTrackerFixOnMessage(messageIndex);
    } finally {
        fixTrackersRunning = false;
        $button.prop('disabled', false).removeClass('mes_fix_trackers--running');
        updateFixTrackersButtonVisibility();
    }
}

const AGENT_LIST_TAB_STORAGE_KEY = 'ica--agent-list-tab';
const AGENT_LIST_TABS = ['all', 'quick', 'pre', 'post', 'companion'];

function getActiveAgentListTab() {
    try {
        const stored = globalThis.localStorage?.getItem?.(AGENT_LIST_TAB_STORAGE_KEY);
        return AGENT_LIST_TABS.includes(stored) ? stored : 'all';
    } catch {
        return 'all';
    }
}

function setActiveAgentListTab(tab) {
    try {
        globalThis.localStorage?.setItem?.(AGENT_LIST_TAB_STORAGE_KEY, tab);
    } catch {
        // Private browsing or storage quota: tab selection just won't persist.
    }
}

function syncAgentTabStrip(activeTab) {
    $('#ica--agentTabs .ica--agent-tab').each(function () {
        const isActive = $(this).attr('data-tab') === activeTab;
        $(this).toggleClass('is-active', isActive);
        $(this).attr('aria-selected', String(isActive));
    });
}

/**
 * Re-renders the agent list panel.
 */
function renderAgentList() {
    const container = $('#ica--agentList');
    const scrollState = captureAgentListScrollState(container[0]);
    container.empty();
    updateCancelGenerationButton();
    const profileNames = buildConnectionProfileNameMap();
    const allAgents = sortAgentsByOrder(getVisibleInChatAgents());
    const activeTab = getActiveAgentListTab();
    syncAgentTabStrip(activeTab);

    const searchTerm = ($('#ica--search').val() || '').toString().toLowerCase();
    const categoryFilter = ($('#ica--categoryFilter').val() || '').toString();
    let agents = [...allAgents];

    if (searchTerm) {
        agents = agents.filter(a =>
            a.name.toLowerCase().includes(searchTerm) ||
            a.description.toLowerCase().includes(searchTerm) ||
            a.tags.some(t => t.toLowerCase().includes(searchTerm)),
        );
    }

    if (categoryFilter) {
        agents = agents.filter(a => a.category === categoryFilter);
    }

    if (activeTab !== 'all' && activeTab !== 'quick') {
        agents = agents.filter(a => agentMatchesListTab(a, activeTab));
    }

    const showQuickSection = !selectModeActive && allAgents.length > 0 && (activeTab === 'all' || activeTab === 'quick');
    if (showQuickSection) {
        const legend = $(`
            <div class="ica--action-legend" aria-label="Agent card action legend">
                <span><i class="fa-solid fa-eye"></i> Preview</span>
                <span><i class="fa-solid fa-robot"></i> Apply</span>
                <span><i class="fa-solid fa-user-astronaut"></i> To Companion</span>
                <span><i class="fa-solid fa-right-left"></i> To Inline</span>
                <span><i class="fa-solid fa-pen-to-square"></i> Edit</span>
                <span><i class="fa-solid fa-download"></i> Export</span>
                <span><i class="fa-solid fa-trash"></i> Delete</span>
            </div>
        `);
        const favoriteAgents = allAgents.filter(agent => agent.favorite);
        const quickSection = $(`
            <div class="ica--quick-section">
                <div class="ica--quick-header">
                    <div class="ica--quick-title">
                        <i class="fa-solid fa-star"></i>
                        <span>Quick Toggles</span>
                    </div>
                    <span class="ica--quick-count">${favoriteAgents.length} pinned</span>
                </div>
                <div class="ica--quick-subtitle">Pin the agents you use most often for one-tap enable and disable.</div>
                <div class="ica--quick-grid"></div>
            </div>
        `);
        if (activeTab !== 'quick') {
            container.append(legend);
        }
        const quickGrid = quickSection.find('.ica--quick-grid');

        if (favoriteAgents.length === 0) {
            quickGrid.append('<div class="ica--quick-empty">No pinned agents yet. Use the star button on an agent card or in the editor to keep it here.</div>');
        } else {
            for (const agent of favoriteAgents) {
                const agentEnabled = isAgentEnabledForCurrentScope(agent);
                const enabledClass = agentEnabled ? 'is-enabled' : '';
                const categoryLabel = AGENT_CATEGORIES[agent.category]?.label ?? 'Custom';
                const phaseLabel = AGENT_PHASE_LABELS[agent.phase] || agent.phase;
                const companionExecution = isCompanionAgent(agent);
                const executionLabel = companionExecution ? 'Companion' : phaseLabel;
                const orderLabel = `Order ${getAgentOrderValue(agent)}`;
                const canApplyToLastReply = !isPathfinderAgent(agent);
                const applyTitle = companionExecution ? 'Run Companion on Last Reply' : 'Apply to Last Reply';
                const applyIcon = companionExecution ? 'fa-user-astronaut' : 'fa-robot';
                const quickItem = $(`
                    <div class="ica--quick-chip ${enabledClass}">
                        <button type="button" class="ica--quick-chip-main" title="${agentEnabled ? 'Disable agent' : 'Enable agent'}">
                            <span class="ica--quick-chip-status">
                                <i class="fa-solid ${agentEnabled ? 'fa-toggle-on' : 'fa-toggle-off'}"></i>
                            </span>
                            <span class="ica--quick-chip-copy">
                                <span class="ica--quick-chip-name">${escapeHtml(agent.name || 'Untitled Agent')}</span>
                                <span class="ica--quick-chip-meta">${escapeHtml(categoryLabel)} • ${escapeHtml(executionLabel)} • ${escapeHtml(orderLabel)}</span>
                            </span>
                        </button>
                        <div class="ica--quick-chip-actions">
                            ${canApplyToLastReply ? `
                                <button type="button" class="ica--quick-chip-apply" title="${escapeHtml(applyTitle)}">
                                    <i class="fa-solid ${applyIcon}"></i>
                                </button>
                            ` : ''}
                            <button type="button" class="ica--quick-chip-pin is-active" title="Remove from Quick Toggles">
                                <i class="fa-solid fa-star"></i>
                            </button>
                        </div>
                    </div>
                `);

                quickItem.find('.ica--quick-chip-main').on('click', async event => {
                    stopEvent(event);
                    await toggleAgentEnabled(agent);
                });

                quickItem.find('.ica--quick-chip-apply').on('click', async event => {
                    stopEvent(event);
                    const lastCharMessageIndex = getLastAssistantMessageIndex();
                    if (lastCharMessageIndex < 0) {
                        toastr.warning('No assistant reply yet to manually apply this agent to.');
                        return;
                    }
                    await runAgentOnMessage(agent.id, lastCharMessageIndex);
                });

                quickItem.find('.ica--quick-chip-pin').on('click', async event => {
                    stopEvent(event);
                    await toggleAgentFavorite(agent);
                });

                quickGrid.append(quickItem);
            }
        }

        container.append(quickSection);
    }

    if (activeTab === 'quick') {
        if (allAgents.length === 0) {
            container.append('<div class="ica--empty-state">No agents yet. Click <b>New Agent</b> or <b>Templates</b> to get started.</div>');
        }
        restoreAgentListScrollState(scrollState);
        updateFixTrackersButtonVisibility();
        updateCompanionButtonVisibility();
        updateCompanionPanelHandleVisibility();
        return;
    }

    // Group by category
    const grouped = {};
    for (const cat of Object.keys(AGENT_CATEGORIES)) {
        const catAgents = agents.filter(a => a.category === cat);
        if (catAgents.length > 0) {
            grouped[cat] = catAgents;
        }
    }

    if (Object.keys(grouped).length === 0) {
        container.append(allAgents.length === 0
            ? '<div class="ica--empty-state">No agents yet. Click <b>New Agent</b> or <b>Templates</b> to get started.</div>'
            : '<div class="ica--empty-state">No agents match the current filters.</div>');
        restoreAgentListScrollState(scrollState);
        updateFixTrackersButtonVisibility();
        updateCompanionButtonVisibility();
        updateCompanionPanelHandleVisibility();
        return;
    }

    for (const [cat, catAgents] of Object.entries(grouped)) {
        const catInfo = AGENT_CATEGORIES[cat];
        const group = $('<div class="ica--category-group"></div>');

        const header = $(`
            <div class="ica--category-header${collapsedCategories.has(cat) ? ' collapsed' : ''}">
                <i class="fa-solid fa-chevron-down ica--chevron"></i>
                <i class="fa-solid ${catInfo.icon}"></i>
                ${catInfo.label}
                <span class="ica--category-count">${catAgents.length}</span>
            </div>
        `);
        header.on('click', function () {
            $(this).toggleClass('collapsed');
            if ($(this).hasClass('collapsed')) {
                collapsedCategories.add(cat);
            } else {
                collapsedCategories.delete(cat);
            }
        });
        group.append(header);

        const items = $('<div class="ica--category-items"></div>');

        for (const agent of catAgents) {
            const agentEnabled = isAgentEnabledForCurrentScope(agent);
            const enabledClass = agentEnabled ? 'is-enabled' : '';
            const toggleClass = agentEnabled ? 'is-on' : '';
            const desc = agent.description || agent.prompt.substring(0, 80).replace(/\n/g, ' ') + (agent.prompt.length > 80 ? '...' : '');
            const regexCount = getAgentRegexScripts(agent).length;
            const companionExecution = isCompanionAgent(agent);
            const promptTransformEnabled = !companionExecution && hasPromptTransform(agent);
            const promptTransformLabel = getPromptTransformLabel(agent);
            const preInterceptEnabled = !companionExecution && isPreGenerationInterceptAgent(agent);
            const preInterceptLabel = isPostMainGenerationInterceptAgent(agent) ? 'post-main intercept' : 'pre intercept';
            const previewPromptButton = canPreviewPreGenerationPrompt(agent)
                ? `<button type="button" class="ica--card-btn ica--btn-preview-prompt" title="Preview this pre-generation prompt after macro substitution" aria-label="${preInterceptEnabled ? 'Preview Instruction' : 'Preview Prompt'}"><i class="fa-solid fa-eye"></i></button>`
                : '';
            const previewCompanionButton = companionExecution
                ? '<button type="button" class="ica--card-btn ica--btn-preview-companion-feedback" title="Preview companion feedback prompt" aria-label="Preview Companion Feedback"><i class="fa-solid fa-eye"></i></button>'
                : '';
            const applyTitle = companionExecution ? 'Run this companion on the last assistant reply' : 'Manually apply this agent to the last assistant reply';
            const applyAria = companionExecution ? 'Run Companion on Last Reply' : 'Apply to Last Reply';
            const applyIcon = companionExecution ? 'fa-user-astronaut' : 'fa-robot';
            const connectionProfileLabel = agent.connectionProfile
                ? profileNames.get(agent.connectionProfile) || `Missing profile (${agent.connectionProfile})`
                : '';
            const modelOverrideLabel = agent.modelOverride && agent.modelOverride.trim()
                ? agent.modelOverride.trim()
                : '';
            const convertExecutionButton = isPathfinderAgent(agent) || isToolAgent(agent)
                ? ''
                : (companionExecution
                    ? '<button type="button" class="ica--card-btn ica--btn-convert-execution" title="Convert to inline execution (runs inside the main generation again)" aria-label="Convert to Inline"><i class="fa-solid fa-right-left"></i></button>'
                    : '<button type="button" class="ica--card-btn ica--btn-convert-execution" title="Convert to Companion (runs as a separate note card under replies, never edits the reply)" aria-label="Convert to Companion"><i class="fa-solid fa-user-astronaut"></i></button>');

            const card = $(`
                <div class="ica--agent-card ${enabledClass}${selectModeActive ? ' ica--selectable' : ''}${selectedAgentIds.has(agent.id) ? ' ica--selected' : ''}" data-agent-id="${escapeHtml(agent.id)}">
                    <div class="ica--card-header">
                        ${selectModeActive ? `<input type="checkbox" class="ica--card-select" title="Select agent" ${selectedAgentIds.has(agent.id) ? 'checked' : ''} />` : `<button type="button" class="ica--card-toggle ${toggleClass}" title="${agentEnabled ? 'Disable' : 'Enable'}"></button>`}
                        <span class="ica--card-name">${escapeHtml(agent.name)}</span>
                        <div class="ica--card-header-actions">
                            <button type="button" class="ica--card-favorite ${agent.favorite ? 'is-active' : ''}" title="${agent.favorite ? 'Remove from Quick Toggles' : 'Add to Quick Toggles'}">
                                <i class="fa-solid fa-star"></i>
                            </button>
                            <span class="ica--card-phase">${AGENT_PHASE_LABELS[agent.phase] || agent.phase}</span>
                            <button type="button" class="ica--card-drag-handle" title="Hold and drag to reorder">
                                <i class="fa-solid fa-grip-vertical"></i>
                            </button>
                        </div>
                    </div>
                    <div class="ica--card-desc">${escapeHtml(desc)}</div>
                    <div class="ica--card-meta">
                        ${agent.conditions.triggerProbability < 100 ? `<span class="ica--card-pill"><i class="fa-solid fa-dice fa-xs"></i> ${agent.conditions.triggerProbability}%</span>` : ''}
                        ${buildCompanionCardPill(agent)}
                        ${preInterceptEnabled ? `<span class="ica--card-pill"><i class="fa-solid fa-shuffle fa-xs"></i> ${preInterceptLabel}</span>` : ''}
                        ${!companionExecution && !preInterceptEnabled && agent.injection.position === 1 ? `<span class="ica--card-pill">depth ${agent.injection.depth}</span>` : ''}
                        ${promptTransformEnabled ? `<span class="ica--card-pill"><i class="fa-solid fa-robot fa-xs"></i> ${promptTransformLabel}</span>` : ''}
                        ${regexCount > 0 ? `<span class="ica--card-pill"><i class="fa-solid fa-wand-magic-sparkles fa-xs"></i> ${regexCount} regex</span>` : ''}
                        ${connectionProfileLabel ? `<span class="ica--card-pill"><i class="fa-solid fa-plug fa-xs"></i> ${escapeHtml(connectionProfileLabel)}</span>` : ''}
                        ${modelOverrideLabel ? `<span class="ica--card-pill"><i class="fa-solid fa-microchip fa-xs"></i> ${escapeHtml(modelOverrideLabel)}</span>` : ''}
                        ${buildAgentOrderPill(agent)}
                        ${buildAgentVersionPill(agent)}
                    </div>
                    <div class="ica--card-actions">
                        ${previewCompanionButton}
                        ${previewPromptButton}
                        ${isPathfinderAgent(agent) ? '' : `<button type="button" class="ica--card-btn ica--btn-run" title="${escapeHtml(applyTitle)}" aria-label="${escapeHtml(applyAria)}"><i class="fa-solid ${applyIcon}"></i></button>`}
                        ${convertExecutionButton}
                        <button type="button" class="ica--card-btn ica--btn-edit" title="Edit agent" aria-label="Edit agent"><i class="fa-solid fa-pen-to-square"></i></button>
                        ${isPathfinderAgent(agent) ? '' : '<button type="button" class="ica--card-btn ica--btn-export" title="Export agent" aria-label="Export agent"><i class="fa-solid fa-download"></i></button>'}
                        <button type="button" class="ica--card-btn ica--btn-delete caution" title="Delete agent" aria-label="Delete agent"><i class="fa-solid fa-trash"></i></button>
                    </div>
                </div>
            `);

            card.on('click', () => {
                if (Date.now() < suppressCardClickUntil) {
                    return;
                }

                if (selectModeActive) {
                    if (selectedAgentIds.has(agent.id)) {
                        selectedAgentIds.delete(agent.id);
                    } else {
                        selectedAgentIds.add(agent.id);
                    }
                    updateBulkBar();
                    renderAgentList();
                    return;
                }
                openEditor(agent.id);
            });

            card.find('.ica--card-select').on('click change', function (event) {
                event.stopPropagation();
                if ($(this).prop('checked')) {
                    selectedAgentIds.add(agent.id);
                } else {
                    selectedAgentIds.delete(agent.id);
                }
                updateBulkBar();
                renderAgentList();
            });

            card.find('.ica--card-drag-handle').on('click', stopEvent);

            // Prevent touch-punch (jQuery UI mouse widget polyfill) from
            // capturing touchstart on these buttons. Inside a .sortable()
            // container, touch-punch's _touchStart consults _mouseCapture
            // which only checks `handle` (not `cancel`), so it swallows
            // the touchstart and may never synthesize a click on mobile.
            // Stopping propagation on touch events keeps them local.
            const touchPassthrough = function (event) { event.stopPropagation(); };
            card.find('.ica--card-toggle').on('touchstart touchend', touchPassthrough);
            card.find('.ica--card-favorite').on('touchstart touchend', touchPassthrough);

            card.find('.ica--card-toggle').on('click', async function (event) {
                stopEvent(event);
                await toggleAgentEnabled(agent);
            });

            card.find('.ica--card-favorite').on('click', async function (event) {
                stopEvent(event);
                await toggleAgentFavorite(agent);
            });

            card.find('.ica--card-pill--version-update').on('click', async event => {
                stopEvent(event);
                await updateAgentFromSourceTemplate(agent);
            });

            card.find('.ica--btn-edit').on('click', event => {
                stopEvent(event);
                openEditor(agent.id);
            });

            card.find('.ica--btn-convert-execution').on('click', async event => {
                stopEvent(event);
                await applyAgentExecutionConversion(agent, isCompanionAgent(agent) ? 'inline' : 'companion');
            });

            card.find('.ica--btn-run').on('click', async event => {
                stopEvent(event);
                const lastCharMessageIndex = getLastAssistantMessageIndex();
                if (lastCharMessageIndex < 0) {
                    toastr.warning('No assistant reply yet to manually apply this agent to.');
                    return;
                }
                await runAgentOnMessage(agent.id, lastCharMessageIndex);
            });

            card.find('.ica--btn-preview-prompt').on('click', async event => {
                stopEvent(event);
                await previewPreGenerationPrompt(agent);
            });

            card.find('.ica--btn-preview-companion-feedback').on('click', async event => {
                stopEvent(event);
                await previewCompanionFeedbackPrompt(agent);
            });

            card.find('.ica--btn-export').on('click', event => {
                stopEvent(event);
                const data = exportAgent(agent.id);
                if (data) download(JSON.stringify(data, null, 2), `${agent.name}.json`, 'application/json');
            });

            card.find('.ica--btn-delete').on('click', async event => {
                stopEvent(event);
                const result = await new Popup('Delete agent "' + escapeHtml(agent.name) + '"?', POPUP_TYPE.CONFIRM).show();
                if (result === POPUP_RESULT.AFFIRMATIVE) {
                    await deleteAgent(agent.id);
                    renderAgentList();
                }
            });

            items.append(card);
        }

        setupCategorySortable(items[0]);
        group.append(items);
        container.append(group);
    }

    restoreAgentListScrollState(scrollState);
    updateFixTrackersButtonVisibility();
    updateCompanionButtonVisibility();
    updateCompanionPanelHandleVisibility();
}

// ===================== Editor Modal =====================

async function openRegexScriptEditor(existingScript = null) {
    const regexScript = existingScript
        ? normalizeRegexScript(structuredClone(existingScript))
        : createDefaultRegexScript();

    const placementOptions = [
        AGENT_REGEX_PLACEMENT.AI_OUTPUT,
        AGENT_REGEX_PLACEMENT.USER_INPUT,
        AGENT_REGEX_PLACEMENT.SLASH_COMMAND,
        AGENT_REGEX_PLACEMENT.WORLD_INFO,
        AGENT_REGEX_PLACEMENT.REASONING,
    ].map(placement => `
        <label class="checkbox_label">
            <input type="checkbox" name="ica--regex-placement" value="${placement}" ${regexScript.placement.includes(placement) ? 'checked' : ''} />
            <span>${REGEX_PLACEMENT_LABELS[placement]}</span>
        </label>
    `).join('');

    const html = $(`
        <div class="ica--regex-editor">
            <label class="ica--editor-row">Script Name
                <input type="text" id="ica--regex-name" class="text_pole" placeholder="Regex script name" value="${escapeHtml(regexScript.scriptName)}" />
            </label>
            <label class="ica--editor-row">Find Regex
                <textarea id="ica--regex-find" class="text_pole textarea_compact" rows="4" placeholder="/pattern/g or plain regex">${escapeHtml(regexScript.findRegex)}</textarea>
            </label>
            <label class="ica--editor-row">Replace String
                <textarea id="ica--regex-replace" class="text_pole textarea_compact" rows="4" placeholder="Replacement text">${escapeHtml(regexScript.replaceString)}</textarea>
            </label>
            <label class="ica--editor-row">Trim Strings <small>(one per line)</small>
                <textarea id="ica--regex-trim" class="text_pole textarea_compact" rows="3" placeholder="Text removed from capture groups before substitution">${escapeHtml((regexScript.trimStrings || []).join('\n'))}</textarea>
            </label>
            <div class="ica--editor-section ica--regex-subsection">
                <strong>Placement</strong>
                <div class="ica--regex-placement-grid">${placementOptions}</div>
                <div class="ica--regex-note">Bundled in-chat agent regex currently executes on output formatting. Other placements are preserved for compatibility.</div>
            </div>
            <div class="ica--editor-row flex-container flexGap5">
                <label class="flex1">Substitute Find Regex
                    <select id="ica--regex-substitute" class="text_pole">
                        <option value="${AGENT_REGEX_SUBSTITUTE.NONE}">None</option>
                        <option value="${AGENT_REGEX_SUBSTITUTE.RAW}">Raw macros</option>
                        <option value="${AGENT_REGEX_SUBSTITUTE.ESCAPED}">Escaped macros</option>
                    </select>
                </label>
                <label class="flex1">Min Depth
                    <input type="number" id="ica--regex-minDepth" class="text_pole" placeholder="blank" value="${regexScript.minDepth ?? ''}" />
                </label>
                <label class="flex1">Max Depth
                    <input type="number" id="ica--regex-maxDepth" class="text_pole" placeholder="blank" value="${regexScript.maxDepth ?? ''}" />
                </label>
            </div>
            <div class="ica--regex-toggles">
                <label class="checkbox_label"><input type="checkbox" id="ica--regex-markdownOnly" ${regexScript.markdownOnly ? 'checked' : ''} /><span>Markdown only</span></label>
                <label class="checkbox_label"><input type="checkbox" id="ica--regex-promptOnly" ${regexScript.promptOnly ? 'checked' : ''} /><span>Prompt only</span></label>
                <label class="checkbox_label"><input type="checkbox" id="ica--regex-runOnEdit" ${regexScript.runOnEdit ? 'checked' : ''} /><span>Run on edit</span></label>
                <label class="checkbox_label"><input type="checkbox" id="ica--regex-disabled" ${regexScript.disabled ? 'checked' : ''} /><span>Disabled</span></label>
            </div>
        </div>
    `);

    html.find('#ica--regex-substitute').val(String(regexScript.substituteRegex ?? AGENT_REGEX_SUBSTITUTE.NONE));

    const result = await new Popup(html, POPUP_TYPE.CONFIRM, '', {
        okButton: 'Save Regex',
        cancelButton: 'Cancel',
        wide: true,
        large: true,
    }).show();

    if (result !== POPUP_RESULT.AFFIRMATIVE) {
        return null;
    }

    const placement = [];
    html.find('input[name="ica--regex-placement"]:checked').each(function () {
        placement.push(Number($(this).val()));
    });

    const findRegex = html.find('#ica--regex-find').val()?.toString() ?? '';
    if (!findRegex.trim()) {
        toastr.warning('Regex scripts need a find pattern.');
        return null;
    }

    return normalizeRegexScript({
        ...regexScript,
        scriptName: html.find('#ica--regex-name').val()?.toString().trim() || 'Regex Script',
        findRegex,
        replaceString: html.find('#ica--regex-replace').val()?.toString() ?? '',
        trimStrings: html.find('#ica--regex-trim').val()?.toString()
            .split('\n')
            .map(value => value.trim())
            .filter(Boolean),
        placement,
        substituteRegex: Number(html.find('#ica--regex-substitute').val()),
        markdownOnly: html.find('#ica--regex-markdownOnly').prop('checked'),
        promptOnly: html.find('#ica--regex-promptOnly').prop('checked'),
        runOnEdit: html.find('#ica--regex-runOnEdit').prop('checked'),
        disabled: html.find('#ica--regex-disabled').prop('checked'),
        minDepth: html.find('#ica--regex-minDepth').val()?.toString() ?? '',
        maxDepth: html.find('#ica--regex-maxDepth').val()?.toString() ?? '',
    });
}

function buildCompanionDraftAgent() {
    const draft = createDefaultAgent();
    draft.category = 'companion';
    draft.execution = 'companion';
    draft.phase = 'post';
    draft.companion = getCompanionConfig(draft);
    return draft;
}

/**
 * Opens the agent editor for the given agent ID (or creates a new one).
 * @param {string|null} agentId
 * @param {object} [options]
 * @param {object|null} [options.draft] Prefilled agent to edit instead of a blank default (new agents only).
 * @param {boolean} [options.autoOpenCompanionMaker] Open the companion AI maker once the editor is up.
 */
async function openEditor(agentId = null, { draft = null, autoOpenCompanionMaker = false } = {}) {
    const existingAgent = agentId ? getAgentById(agentId) : null;
    if (agentId && !existingAgent) return;
    const agent = existingAgent ? structuredClone(existingAgent) : (draft ?? createDefaultAgent());
    const originalAgentState = JSON.stringify(agent);
    if (!agent) return;

    // Check if this is a Pathfinder agent - open special settings panel
    if (isPathfinderAgent(agent)) {
        await openPathfinderEditor(agent);
        return;
    }

    let regexScripts = getAgentRegexScripts(agent).map(script => structuredClone(script));
    const template = findTemplateForAgent(agent);
    const bundledRegexScripts = Array.isArray(template?.regexScripts)
        ? template.regexScripts.map(script => structuredClone(script))
        : [];

    const html = await renderExtensionTemplateAsync(MODULE_NAME, 'editor');
    if (!html) {
        toastr.error('Could not load the agent editor. Please refresh the page and try again.');
        return;
    }

    const editorEl = $(html);

    // Populate fields
    editorEl.find('#ica--editor-name').val(agent.name);
    editorEl.find('#ica--editor-category').val(agent.category);
    editorEl.find('#ica--editor-phase').val(agent.phase);
    editorEl.find('#ica--editor-execution').val(isCompanionAgent(agent) ? 'companion' : 'inline');
    editorEl.find('#ica--editor-description').val(agent.description);
    editorEl.find('#ica--editor-favorite').prop('checked', Boolean(agent.favorite));
    editorEl.find('#ica--editor-prompt').val(agent.prompt);
    populateConnectionProfileSelect(editorEl.find('#ica--editor-connectionProfile')[0], {
        emptyLabel: 'Use extension default',
        selectedValue: agent.connectionProfile || '',
    });
    editorEl.find('#ica--editor-modelOverride').val(agent.modelOverride || '');

    const companion = getCompanionConfig(agent);
    editorEl.find('#ica--editor-companion-trigger').val(companion.trigger);
    editorEl.find('#ica--editor-companion-displayMode').val(companion.displayMode);
    editorEl.find('#ica--editor-companion-format').val(companion.format);
    editorEl.find('#ica--editor-companion-contextMessages').val(companion.contextMessages);
    editorEl.find('#ica--editor-companion-minContextTokens').val(companion.minContextTokens);
    editorEl.find('#ica--editor-companion-historyDepth').val(companion.historyDepth);
    editorEl.find('#ica--editor-companion-maxTokens').val(companion.maxTokens);
    editorEl.find('#ica--editor-companion-includeCharacterCard').prop('checked', companion.includeCharacterCard);
    editorEl.find('#ica--editor-companion-includePersona').prop('checked', companion.includePersona);
    editorEl.find('#ica--editor-companion-includeWorldInfo').prop('checked', companion.includeWorldInfo);
    editorEl.find('#ica--editor-companion-includeAuthorsNote').prop('checked', companion.includeAuthorsNote);
    editorEl.find('#ica--editor-companion-includeSystemPrompt').prop('checked', companion.includeSystemPrompt);
    editorEl.find('#ica--editor-companion-includeHistory').prop('checked', companion.includeHistory);
    editorEl.find('#ica--editor-companion-feedbackEnabled').prop('checked', companion.feedback.enabled);
    editorEl.find('#ica--editor-companion-feedbackDepth').val(companion.feedback.depth);
    editorEl.find('#ica--editor-companion-batch').prop('checked', companion.batch);
    editorEl.find('#ica--editor-companion-rawPrompt').prop('checked', companion.rawPrompt);
    editorEl.find('#ica--editor-chatroom-style').val(normalizeChatroomStyle(agent.settings?.chatroomStyle));
    const savedChatroomCustomStyleName = normalizeChatroomCustomStyleName(agent.settings?.chatroomCustomStyleName);
    editorEl.find('#ica--editor-chatroom-custom-styles').val(getChatroomCustomStylesSetting(agent.settings));
    const savedChatroomExtraCharacterAvatars = normalizeChatroomExtraCharacterAvatars(agent.settings?.chatroomExtraCharacterAvatars);
    editorEl.find('#ica--editor-director-voice').val(normalizeDirectorCommentaryVoice(agent.settings?.directorCommentaryVoice));
    const savedDirectorCustomVoiceName = normalizeDirectorCustomVoiceName(agent.settings?.directorCommentaryCustomVoiceName);
    editorEl.find('#ica--editor-director-custom-voices').val(getDirectorCustomVoicesSetting(agent.settings));
    editorEl.find('#ica--editor-plot-compass-objective').val(typeof agent.settings?.plotCompassObjective === 'string'
        ? agent.settings.plotCompassObjective
        : '');

    let editorFullscreen = false;
    const fullscreenButton = editorEl.find('#ica--editor-fullscreen');
    const updateEditorFullscreenState = (nextEnabled) => {
        editorFullscreen = Boolean(nextEnabled);
        editorEl.toggleClass('ica--editor-fullscreen', editorFullscreen);
        document.body.classList.toggle('ica--editor-fullscreen-active', editorFullscreen);
        fullscreenButton.attr('aria-pressed', String(editorFullscreen));
        fullscreenButton.attr('title', editorFullscreen ? 'Exit fullscreen editor' : 'Toggle fullscreen editor');
        fullscreenButton.find('i').attr('class', `fa-solid ${editorFullscreen ? 'fa-compress' : 'fa-maximize'}`);
    };
    fullscreenButton.on('click', () => updateEditorFullscreenState(!editorFullscreen));

    // Injection
    editorEl.find('#ica--editor-position').val(agent.injection.position);
    editorEl.find('#ica--editor-depth').val(agent.injection.depth);
    editorEl.find('#ica--editor-role').val(agent.injection.role);
    editorEl.find('#ica--editor-order').val(agent.injection.order);
    editorEl.find('#ica--editor-scan').prop('checked', agent.injection.scan);
    const preProcess = getAgentPreProcess(agent);
    editorEl.find('#ica--editor-pre-mode').val(preProcess.mode);
    editorEl.find('#ica--editor-pre-interceptTiming').val(preProcess.interceptTiming);
    editorEl.find('#ica--editor-pre-applyMode').val(preProcess.applyMode);
    editorEl.find('#ica--editor-pre-wrapPosition').val(preProcess.wrapPosition);
    editorEl.find('#ica--editor-pre-wrapPrefix').val(preProcess.wrapPrefix);
    editorEl.find('#ica--editor-pre-wrapSuffix').val(preProcess.wrapSuffix);
    editorEl.find('#ica--editor-pre-patchStartTag').val(preProcess.patchStartTag);
    editorEl.find('#ica--editor-pre-patchEndTag').val(preProcess.patchEndTag);
    editorEl.find('#ica--editor-pre-maxTokens').val(preProcess.maxTokens ?? DEFAULT_AGENT_MAX_TOKENS);

    // Post-process
    const postProcessType = agent.postProcess.type === 'append' ? 'append' : 'extract';
    editorEl.find('#ica--editor-pp-promptEnabled').prop('checked', Boolean(agent.postProcess.promptTransformEnabled));
    editorEl.find('#ica--editor-pp-promptMode').val(getPromptTransformMode(agent));
    editorEl.find('#ica--editor-pp-promptMaxTokens').val(agent.postProcess.promptTransformMaxTokens ?? DEFAULT_AGENT_MAX_TOKENS);
    editorEl.find('#ica--editor-pp-promptShowNotifications').prop('checked', Boolean(agent.postProcess.promptTransformShowNotifications));
    editorEl.find('#ica--editor-pp-runOnImpersonate').prop('checked', Boolean(agent.conditions.runOnImpersonate));
    editorEl.find('#ica--editor-pp-enabled').prop('checked', agent.postProcess.enabled && agent.postProcess.type !== 'regex');
    editorEl.find('#ica--editor-pp-type').val(postProcessType);
    editorEl.find('#ica--editor-pp-extractPattern').val(agent.postProcess.extractPattern);
    editorEl.find('#ica--editor-pp-extractVariable').val(agent.postProcess.extractVariable);
    editorEl.find('#ica--editor-pp-appendText').val(agent.postProcess.appendText);

    // Conditions
    editorEl.find('#ica--editor-probability').val(agent.conditions.triggerProbability);
    editorEl.find('#ica--editor-keywords').val((agent.conditions.triggerKeywords || []).join(', '));
    editorEl.find('#ica--editor-type-normal').prop('checked', agent.conditions.generationTypes.includes('normal'));
    editorEl.find('#ica--editor-type-continue').prop('checked', agent.conditions.generationTypes.includes('continue'));
    editorEl.find('#ica--editor-type-impersonate').prop('checked', agent.conditions.generationTypes.includes('impersonate'));
    editorEl.find('#ica--editor-type-quiet').prop('checked', agent.conditions.generationTypes.includes('quiet'));

    function updateTrackerBuilderVisibility() {
        const category = editorEl.find('#ica--editor-category').val()?.toString() || '';
        editorEl.find('#ica--tracker-builder-section').toggle(category === 'tracker');
    }

    function isEditorCompanionExecution() {
        const category = editorEl.find('#ica--editor-category').val()?.toString() || '';
        const execution = editorEl.find('#ica--editor-execution').val()?.toString() || 'inline';
        return category === 'companion' || execution === 'companion';
    }

    function updateChatroomCustomStyleOptions() {
        const select = editorEl.find('#ica--editor-chatroom-custom-style-name');
        const currentName = normalizeChatroomCustomStyleName(select.val());
        const customStyles = parseChatroomCustomStyles(editorEl.find('#ica--editor-chatroom-custom-styles').val());

        select.empty();
        if (!customStyles.length) {
            select.append($('<option>').val('').text('Add styles below'));
            return;
        }

        const findStyleName = name => {
            const normalizedName = normalizeChatroomCustomStyleName(name).toLowerCase();
            return customStyles.find(style => style.name.toLowerCase() === normalizedName)?.name || '';
        };
        const preferredName = findStyleName(currentName) || findStyleName(savedChatroomCustomStyleName) || customStyles[0].name;

        for (const style of customStyles) {
            select.append($('<option>').val(style.name).text(style.name));
        }
        select.val(preferredName);
    }

    function updateChatroomExtraCharacterOptions() {
        const select = editorEl.find('#ica--editor-chatroom-extra-character-avatars');
        const currentAvatars = normalizeChatroomExtraCharacterAvatars(select.val());
        const selectedAvatars = currentAvatars.length ? currentAvatars : savedChatroomExtraCharacterAvatars;
        const selectedKeys = new Set(selectedAvatars.map(avatar => avatar.toLowerCase()));
        const selectableCharacters = getChatroomSelectableCharacters();
        const availableKeys = new Set(selectableCharacters.map(character => character.avatar.toLowerCase()));

        select.empty();
        if (!selectableCharacters.length && !selectedAvatars.length) {
            select.append($('<option>').val('').text('No other character cards available').prop('disabled', true));
            return;
        }

        for (const character of selectableCharacters) {
            select.append(
                $('<option>')
                    .val(character.avatar)
                    .text(character.label)
                    .prop('selected', selectedKeys.has(character.avatar.toLowerCase())),
            );
        }

        for (const avatar of selectedAvatars) {
            if (availableKeys.has(avatar.toLowerCase())) continue;

            select.append(
                $('<option>')
                    .val(avatar)
                    .text(`Missing or active: ${avatar}`)
                    .prop('selected', true),
            );
        }
    }

    function updateDirectorCustomVoiceOptions() {
        const select = editorEl.find('#ica--editor-director-custom-voice-name');
        const currentName = normalizeDirectorCustomVoiceName(select.val());
        const customVoices = parseDirectorCustomVoices(editorEl.find('#ica--editor-director-custom-voices').val());

        select.empty();
        if (!customVoices.length) {
            select.append($('<option>').val('').text('Add voices below'));
            return;
        }

        const findVoiceName = name => {
            const normalizedName = normalizeDirectorCustomVoiceName(name).toLowerCase();
            return customVoices.find(voice => voice.name.toLowerCase() === normalizedName)?.name || '';
        };
        const preferredName = findVoiceName(currentName) || findVoiceName(savedDirectorCustomVoiceName) || customVoices[0].name;

        for (const voice of customVoices) {
            select.append($('<option>').val(voice.name).text(voice.name));
        }
        select.val(preferredName);
    }

    function updateCompanionEditorVisibility() {
        const category = editorEl.find('#ica--editor-category').val()?.toString() || '';
        const companionExecution = isEditorCompanionExecution();
        const executionSelect = editorEl.find('#ica--editor-execution');
        const sourceTemplateId = String(agent.sourceTemplateId ?? '').trim();
        const showChatroomSettings = companionExecution && sourceTemplateId === CHATROOM_TEMPLATE_ID;
        const showCustomChatroomStyle = showChatroomSettings
            && normalizeChatroomStyle(editorEl.find('#ica--editor-chatroom-style').val()) === CHATROOM_CUSTOM_STYLE_VALUE;
        const showDirectorSettings = companionExecution && sourceTemplateId === DIRECTORS_COMMENTARY_TEMPLATE_ID;
        const showCustomDirectorVoice = showDirectorSettings
            && normalizeDirectorCommentaryVoice(editorEl.find('#ica--editor-director-voice').val()) === DIRECTOR_COMMENTARY_CUSTOM_VOICE_VALUE;

        if (category === 'companion') {
            executionSelect.val('companion');
        }

        executionSelect.prop('disabled', category === 'companion');
        editorEl.find('#ica--companion-section').toggle(companionExecution);
        editorEl.find('#ica--companion-feedback-depth-row').toggle(editorEl.find('#ica--editor-companion-feedbackEnabled').prop('checked'));
        editorEl.find('#ica--chatroom-style-row').toggle(showChatroomSettings);
        editorEl.find('#ica--chatroom-custom-style-row').toggle(showCustomChatroomStyle);
        editorEl.find('#ica--chatroom-extra-characters-row').toggle(showChatroomSettings);
        editorEl.find('#ica--director-voice-row').toggle(showDirectorSettings);
        editorEl.find('#ica--director-custom-voice-row').toggle(showCustomDirectorVoice);
        editorEl.find('#ica--plot-compass-objective-row').toggle(companionExecution && sourceTemplateId === PLOT_COMPASS_TEMPLATE_ID);
    }

    function readCompanionConfigFromEditor(root, baseAgent = agent) {
        const current = getCompanionConfig(baseAgent);
        return {
            ...current,
            trigger: root.find('#ica--editor-companion-trigger').val()?.toString() === 'manual' ? 'manual' : 'auto',
            displayMode: ['card', 'panel', 'hidden'].includes(root.find('#ica--editor-companion-displayMode').val()?.toString())
                ? root.find('#ica--editor-companion-displayMode').val().toString()
                : 'card',
            format: ['markdown', 'html', 'text'].includes(root.find('#ica--editor-companion-format').val()?.toString())
                ? root.find('#ica--editor-companion-format').val().toString()
                : 'markdown',
            rawPrompt: root.find('#ica--editor-companion-rawPrompt').prop('checked'),
            contextMessages: Number(root.find('#ica--editor-companion-contextMessages').val()) || current.contextMessages,
            minContextTokens: Number.isFinite(Number(root.find('#ica--editor-companion-minContextTokens').val()))
                ? Number(root.find('#ica--editor-companion-minContextTokens').val())
                : current.minContextTokens,
            includeCharacterCard: root.find('#ica--editor-companion-includeCharacterCard').prop('checked'),
            includePersona: root.find('#ica--editor-companion-includePersona').prop('checked'),
            includeWorldInfo: root.find('#ica--editor-companion-includeWorldInfo').prop('checked'),
            includeAuthorsNote: root.find('#ica--editor-companion-includeAuthorsNote').prop('checked'),
            includeSystemPrompt: root.find('#ica--editor-companion-includeSystemPrompt').prop('checked'),
            includeHistory: root.find('#ica--editor-companion-includeHistory').prop('checked'),
            historyDepth: Number(root.find('#ica--editor-companion-historyDepth').val()) || current.historyDepth,
            feedback: {
                ...current.feedback,
                enabled: root.find('#ica--editor-companion-feedbackEnabled').prop('checked'),
                depth: Number(root.find('#ica--editor-companion-feedbackDepth').val()) || current.feedback.depth,
            },
            batch: root.find('#ica--editor-companion-batch').prop('checked'),
            maxTokens: Number(root.find('#ica--editor-companion-maxTokens').val()) || current.maxTokens,
        };
    }

    function writeCompanionConfigToEditor(companionConfig) {
        const nextCompanion = getCompanionConfig({ companion: companionConfig });
        editorEl.find('#ica--editor-companion-trigger').val(nextCompanion.trigger);
        editorEl.find('#ica--editor-companion-displayMode').val(nextCompanion.displayMode);
        editorEl.find('#ica--editor-companion-format').val(nextCompanion.format);
        editorEl.find('#ica--editor-companion-contextMessages').val(nextCompanion.contextMessages);
        editorEl.find('#ica--editor-companion-minContextTokens').val(nextCompanion.minContextTokens);
        editorEl.find('#ica--editor-companion-historyDepth').val(nextCompanion.historyDepth);
        editorEl.find('#ica--editor-companion-maxTokens').val(nextCompanion.maxTokens);
        editorEl.find('#ica--editor-companion-includeCharacterCard').prop('checked', nextCompanion.includeCharacterCard);
        editorEl.find('#ica--editor-companion-includePersona').prop('checked', nextCompanion.includePersona);
        editorEl.find('#ica--editor-companion-includeWorldInfo').prop('checked', nextCompanion.includeWorldInfo);
        editorEl.find('#ica--editor-companion-includeAuthorsNote').prop('checked', nextCompanion.includeAuthorsNote);
        editorEl.find('#ica--editor-companion-includeSystemPrompt').prop('checked', nextCompanion.includeSystemPrompt);
        editorEl.find('#ica--editor-companion-includeHistory').prop('checked', nextCompanion.includeHistory);
        editorEl.find('#ica--editor-companion-feedbackEnabled').prop('checked', nextCompanion.feedback.enabled);
        editorEl.find('#ica--editor-companion-feedbackDepth').val(nextCompanion.feedback.depth);
        editorEl.find('#ica--editor-companion-batch').prop('checked', nextCompanion.batch);
        editorEl.find('#ica--editor-companion-rawPrompt').prop('checked', nextCompanion.rawPrompt);
        updateCompanionEditorVisibility();
    }

    editorEl.find('#ica--editor-category').on('change', () => {
        updateTrackerBuilderVisibility();
        updateCompanionEditorVisibility();
    });
    editorEl.find('#ica--editor-execution, #ica--editor-companion-feedbackEnabled, #ica--editor-chatroom-style, #ica--editor-director-voice').on('change', updateCompanionEditorVisibility);
    editorEl.find('#ica--editor-chatroom-custom-styles').on('input', updateChatroomCustomStyleOptions);
    editorEl.find('#ica--editor-director-custom-voices').on('input', updateDirectorCustomVoiceOptions);
    updateTrackerBuilderVisibility();
    updateChatroomCustomStyleOptions();
    updateChatroomExtraCharacterOptions();
    updateDirectorCustomVoiceOptions();
    updateCompanionEditorVisibility();

    // Show/hide sections based on phase
    function updatePhaseVisibility() {
        const phase = editorEl.find('#ica--editor-phase').val();
        editorEl.find('#ica--injection-section').toggle(phase === 'pre' || phase === 'both');
        editorEl.find('#ica--postprocess-section').toggle(phase === 'post' || phase === 'both');
        updatePreProcessVisibility();
    }
    editorEl.find('#ica--editor-phase').on('change', updatePhaseVisibility);

    function updatePreProcessVisibility() {
        const phase = editorEl.find('#ica--editor-phase').val();
        const preGenerationVisible = phase === 'pre' || phase === 'both';
        const preMode = editorEl.find('#ica--editor-pre-mode').val()?.toString() || 'inject';
        const applyMode = editorEl.find('#ica--editor-pre-applyMode').val()?.toString() || 'replace';
        const interceptVisible = preGenerationVisible && preMode === 'intercept';

        editorEl.find('#ica--pre-intercept-options').toggle(interceptVisible);
        editorEl.find('#ica--pre-injection-note').toggle(preGenerationVisible && preMode !== 'intercept');
        editorEl.find('#ica--pre-wrap-position-row').toggle(interceptVisible && (applyMode === 'wrap' || applyMode === 'patch'));
        editorEl.find('#ica--pre-wrap-options').toggle(interceptVisible && applyMode === 'wrap');
        editorEl.find('#ica--pre-patch-options').toggle(interceptVisible && applyMode === 'patch');
    }
    editorEl.find('#ica--editor-pre-mode, #ica--editor-pre-applyMode').on('change', updatePreProcessVisibility);
    updatePhaseVisibility();

    // Show/hide post-process options
    function updatePPVisibility() {
        const promptEnabled = editorEl.find('#ica--editor-pp-promptEnabled').prop('checked');
        editorEl.find('#ica--pp-prompt-options').toggle(promptEnabled);

        const enabled = editorEl.find('#ica--editor-pp-enabled').prop('checked');
        editorEl.find('#ica--pp-options').toggle(enabled);

        const type = editorEl.find('#ica--editor-pp-type').val();
        editorEl.find('#ica--pp-extract').toggle(type === 'extract');
        editorEl.find('#ica--pp-append').toggle(type === 'append');
    }
    editorEl.find('#ica--editor-pp-promptEnabled, #ica--editor-pp-enabled, #ica--editor-pp-type').on('change', updatePPVisibility);
    updatePPVisibility();

    editorEl.find('#ica--tracker-builder-generate').on('click', async () => {
        const formatText = editorEl.find('#ica--tracker-builder-format').val()?.toString() ?? '';
        if (!parseTrackerFormat(formatText)) {
            toastr.warning('Paste a tracker example with at least one opening tag like [TRACKER|Field].');
            return;
        }

        const currentPrompt = editorEl.find('#ica--editor-prompt').val()?.toString() ?? '';
        const agentName = editorEl.find('#ica--editor-name').val()?.toString().trim() ?? '';
        const description = editorEl.find('#ica--editor-description').val()?.toString().trim() ?? '';
        const rulesText = editorEl.find('#ica--tracker-builder-rules').val()?.toString() ?? '';
        const styleNotes = editorEl.find('#ica--tracker-builder-style').val()?.toString() ?? '';
        const connectionProfile = editorEl.find('#ica--editor-connectionProfile').val()?.toString() || '';

        toastr.info('Generating tracker kit...', '', { timeOut: 0, extendedTimeOut: 0 });

        let generatedKit;
        try {
            generatedKit = await generateTrackerKitWithAI({
                agentName,
                description,
                currentPrompt,
                formatText,
                rulesText,
                styleNotes,
                connectionProfile,
            });
        } catch (error) {
            toastr.clear();
            toastr.error(`Tracker generation failed: ${error instanceof Error ? error.message : String(error)}`);
            return;
        }

        toastr.clear();

        const regexItems = generatedKit.regexScripts
            .map(script => `<li><strong>${escapeHtml(script.scriptName || 'Regex Script')}</strong><br><code>${escapeHtml(script.findRegex || '')}</code></li>`)
            .join('');
        const previewHtml = $(`
            <div class="ica--regex-editor">
                ${generatedKit.usedFallback ? '<div class="ica--regex-note"><strong>Fallback scaffold used.</strong> The builder produced a safe starter kit locally because the AI response was unavailable or invalid. You can still apply and tweak it.</div>' : ''}
                <div class="ica--editor-section ica--regex-subsection">
                    <strong>Prompt</strong>
                    <pre style="white-space:pre-wrap;max-height:220px;overflow-y:auto;padding:10px;border:1px solid var(--SmartThemeBorderColor);border-radius:8px;">${escapeHtml(generatedKit.prompt)}</pre>
                </div>
                <div class="ica--editor-section ica--regex-subsection">
                    <strong>Extraction</strong>
                    <div class="ica--regex-note"><b>Variable:</b> <code>${escapeHtml(generatedKit.postProcess.extractVariable)}</code></div>
                    <pre style="white-space:pre-wrap;max-height:120px;overflow-y:auto;padding:10px;border:1px solid var(--SmartThemeBorderColor);border-radius:8px;">${escapeHtml(generatedKit.postProcess.extractPattern)}</pre>
                </div>
                <div class="ica--editor-section ica--regex-subsection">
                    <strong>Regex Beautifiers</strong>
                    <ul style="margin:0;padding-left:18px">${regexItems || '<li>No regex scripts generated.</li>'}</ul>
                </div>
            </div>
        `);

        const previewResult = await new Popup(previewHtml, POPUP_TYPE.CONFIRM, '', {
            okButton: 'Apply',
            cancelButton: 'Discard',
            wide: true,
            large: true,
        }).show();

        if (previewResult !== POPUP_RESULT.AFFIRMATIVE) {
            return;
        }

        if (!agentName && generatedKit.name) {
            editorEl.find('#ica--editor-name').val(generatedKit.name);
        }

        if (!description && generatedKit.description) {
            editorEl.find('#ica--editor-description').val(generatedKit.description);
        }

        editorEl.find('#ica--editor-category').val('tracker').trigger('change');
        editorEl.find('#ica--editor-phase').val(generatedKit.phase).trigger('change');
        editorEl.find('#ica--editor-prompt').val(generatedKit.prompt);
        editorEl.find('#ica--editor-pp-promptEnabled').prop('checked', false);
        editorEl.find('#ica--editor-pp-enabled').prop('checked', true);
        editorEl.find('#ica--editor-pp-type').val('extract');
        editorEl.find('#ica--editor-pp-extractPattern').val(generatedKit.postProcess.extractPattern);
        editorEl.find('#ica--editor-pp-extractVariable').val(generatedKit.postProcess.extractVariable);
        editorEl.find('#ica--editor-pp-appendText').val('');
        regexScripts = generatedKit.regexScripts.map(script => normalizeRegexScript(structuredClone(script)));
        updatePPVisibility();
        renderRegexList();

        toastr.success(
            generatedKit.usedFallback
                ? 'Built a starter tracker kit. Review and tweak it before saving.'
                : 'Applied generated tracker kit. Review and save when ready.',
        );
    });

    editorEl.find('#ica--editor-companion-maker').on('click', async () => {
        const currentPrompt = editorEl.find('#ica--editor-prompt').val()?.toString() || '';
        const agentName = editorEl.find('#ica--editor-name').val()?.toString().trim() || '';
        const description = editorEl.find('#ica--editor-description').val()?.toString().trim() || '';
        const connectionProfile = editorEl.find('#ica--editor-connectionProfile').val()?.toString() || '';
        const makerForm = $(`
            <div class="ica--companion-edit-popup">
                <div class="ica--regex-note">Describe the side note this companion should produce. Existing name, description, and prompt text will be used as extra context.</div>
                <textarea id="ica--companion-maker-goal" class="text_pole textarea_compact" rows="8" placeholder="Example: Watch for continuity issues, unresolved promises, location changes, and character state shifts."></textarea>
            </div>
        `);
        const makerResult = await new Popup(makerForm, POPUP_TYPE.CONFIRM, '', {
            okButton: 'Generate Companion',
            cancelButton: 'Cancel',
            wide: true,
        }).show();

        if (makerResult !== POPUP_RESULT.AFFIRMATIVE) {
            return;
        }

        const goalText = makerForm.find('#ica--companion-maker-goal').val()?.toString().trim() || '';
        if (!goalText && !currentPrompt.trim() && !description) {
            toastr.warning('Describe what this companion should watch for.');
            return;
        }

        toastr.info('Generating companion...', '', { timeOut: 0, extendedTimeOut: 0 });

        let generatedKit;
        try {
            generatedKit = await generateCompanionKitWithAI({
                agentName,
                description,
                currentPrompt,
                goalText,
                connectionProfile,
            });
        } finally {
            toastr.clear();
        }

        const generatedCompanion = getCompanionConfig({ companion: generatedKit.companion });
        const previewHtml = $(`
            <div class="ica--regex-editor">
                ${generatedKit.usedFallback ? '<div class="ica--regex-note"><strong>Fallback scaffold used.</strong> The builder produced a safe starter companion locally because the AI response was unavailable or invalid. You can still apply and tweak it.</div>' : ''}
                <div class="ica--editor-section ica--regex-subsection">
                    <strong>${escapeHtml(generatedKit.name)}</strong>
                    <div class="ica--regex-note">${escapeHtml(generatedKit.description)}</div>
                </div>
                <div class="ica--editor-section ica--regex-subsection">
                    <strong>Prompt</strong>
                    <pre style="white-space:pre-wrap;max-height:260px;overflow-y:auto;padding:10px;border:1px solid var(--SmartThemeBorderColor);border-radius:8px;">${escapeHtml(generatedKit.prompt)}</pre>
                </div>
                <div class="ica--editor-section ica--regex-subsection">
                    <strong>Settings</strong>
                    <div class="ica--regex-note">Trigger: ${escapeHtml(generatedCompanion.trigger)}. Display: ${escapeHtml(generatedCompanion.displayMode)}. Format: ${escapeHtml(generatedCompanion.format)}. Context: ${escapeHtml(generatedCompanion.contextMessages)} messages. Max tokens: ${escapeHtml(generatedCompanion.maxTokens)}.</div>
                </div>
            </div>
        `);
        const previewResult = await new Popup(previewHtml, POPUP_TYPE.CONFIRM, '', {
            okButton: 'Apply',
            cancelButton: 'Discard',
            wide: true,
            large: true,
        }).show();

        if (previewResult !== POPUP_RESULT.AFFIRMATIVE) {
            return;
        }

        if (!agentName && generatedKit.name) {
            editorEl.find('#ica--editor-name').val(generatedKit.name);
        }
        if (!description && generatedKit.description) {
            editorEl.find('#ica--editor-description').val(generatedKit.description);
        }
        if (editorEl.find('#ica--editor-category').val()?.toString() === 'custom') {
            editorEl.find('#ica--editor-category').val('companion').trigger('change');
        }
        editorEl.find('#ica--editor-execution').val('companion').trigger('change');
        editorEl.find('#ica--editor-phase').val('post').trigger('change');
        editorEl.find('#ica--editor-prompt').val(generatedKit.prompt);
        writeCompanionConfigToEditor(generatedKit.companion);
        toastr.success('Applied generated companion. Review and save when ready.');
    });

    function renderRegexList() {
        const list = editorEl.find('#ica--regex-list');
        list.empty();

        if (regexScripts.length === 0) {
            list.append('<div class="ica--regex-empty">No regex scripts yet. Add one or load bundled template regex.</div>');
            return;
        }

        for (const [index, script] of regexScripts.entries()) {
            const item = $(`
                <div class="ica--regex-item">
                    <div class="ica--regex-item-main">
                        <div class="ica--regex-item-title">${escapeHtml(script.scriptName || 'Regex Script')}</div>
                        <div class="ica--regex-item-meta">${escapeHtml(describeRegexScript(script))}</div>
                        <div class="ica--regex-item-pattern">${escapeHtml(script.findRegex)}</div>
                    </div>
                    <div class="ica--regex-item-actions">
                        <button type="button" class="ica--card-btn ica--regex-up" title="Move up"><i class="fa-solid fa-arrow-up"></i></button>
                        <button type="button" class="ica--card-btn ica--regex-down" title="Move down"><i class="fa-solid fa-arrow-down"></i></button>
                        <button type="button" class="ica--card-btn ica--regex-edit" title="Edit regex" aria-label="Edit regex"><i class="fa-solid fa-pen-to-square"></i></button>
                        <button type="button" class="ica--card-btn caution ica--regex-delete" title="Delete regex" aria-label="Delete regex"><i class="fa-solid fa-trash"></i></button>
                    </div>
                </div>
            `);

            item.find('.ica--regex-edit').on('click', async () => {
                const updatedScript = await openRegexScriptEditor(script);
                if (updatedScript) {
                    regexScripts[index] = updatedScript;
                    renderRegexList();
                }
            });

            item.find('.ica--regex-up').on('click', () => {
                if (index === 0) return;
                [regexScripts[index - 1], regexScripts[index]] = [regexScripts[index], regexScripts[index - 1]];
                renderRegexList();
            });

            item.find('.ica--regex-down').on('click', () => {
                if (index >= regexScripts.length - 1) return;
                [regexScripts[index + 1], regexScripts[index]] = [regexScripts[index], regexScripts[index + 1]];
                renderRegexList();
            });

            item.find('.ica--regex-delete').on('click', () => {
                regexScripts.splice(index, 1);
                renderRegexList();
            });

            list.append(item);
        }
    }

    editorEl.find('#ica--regex-note').text(
        bundledRegexScripts.length > 0
            ? `This template ships with ${buildRegexTemplateLabel(bundledRegexScripts.length)}.`
            : 'Attach ST-style regex scripts that run when this agent activates.',
    );

    if (bundledRegexScripts.length > 0) {
        editorEl.find('#ica--regex-resetTemplate').show();
        editorEl.find('#ica--regex-resetTemplate').on('click', () => {
            regexScripts = bundledRegexScripts.map(script => structuredClone(script));
            renderRegexList();
            toastr.success('Loaded bundled template regex.');
        });
    }

    editorEl.find('#ica--regex-add').on('click', async () => {
        const newScript = await openRegexScriptEditor();
        if (newScript) {
            regexScripts.push(newScript);
            renderRegexList();
        }
    });
    renderRegexList();

    // Refine with AI button
    editorEl.find('#ica--editor-refine').on('click', async () => {
        const currentPrompt = editorEl.find('#ica--editor-prompt').val()?.toString() || '';
        const category = editorEl.find('#ica--editor-category').val()?.toString() || 'custom';
        const phase = editorEl.find('#ica--editor-phase').val()?.toString() || 'pre';
        const connectionProfile = editorEl.find('#ica--editor-connectionProfile').val()?.toString() || '';
        const refined = await refinePromptWithAI(currentPrompt, category, phase, connectionProfile);
        if (refined) {
            editorEl.find('#ica--editor-prompt').val(refined);
        }
    });

    editorEl.find('#ica--editor-preview-prompt').on('click', async () => {
        const previewAgent = {
            ...agent,
            name: editorEl.find('#ica--editor-name').val()?.toString().trim() || agent.name,
            category: editorEl.find('#ica--editor-category').val()?.toString() || agent.category,
            execution: isEditorCompanionExecution() ? 'companion' : 'inline',
            phase: editorEl.find('#ica--editor-phase').val()?.toString() || agent.phase,
            preProcess: {
                ...getAgentPreProcess(agent),
                mode: editorEl.find('#ica--editor-pre-mode').val()?.toString() || 'inject',
                interceptTiming: editorEl.find('#ica--editor-pre-interceptTiming').val()?.toString() === 'post-main-generation'
                    ? 'post-main-generation'
                    : 'pre-generation',
            },
        };
        await previewPreGenerationPrompt(previewAgent, editorEl.find('#ica--editor-prompt').val()?.toString() || '');
    });

    editorEl.find('#ica--editor-companion-preview-feedback').on('click', async () => {
        const previewAgent = {
            ...agent,
            name: editorEl.find('#ica--editor-name').val()?.toString().trim() || agent.name,
            category: editorEl.find('#ica--editor-category').val()?.toString() || agent.category,
            execution: 'companion',
            companion: readCompanionConfigFromEditor(editorEl, agent),
        };
        await previewCompanionFeedbackPrompt(previewAgent);
    });

    if (autoOpenCompanionMaker) {
        setTimeout(() => editorEl.find('#ica--editor-companion-maker').trigger('click'), 50);
    }

    // Show popup
    const result = await new Popup(editorEl, POPUP_TYPE.CONFIRM, '', {
        okButton: 'Save',
        cancelButton: 'Cancel',
        wide: true,
        large: true,
    }).show();

    document.body.classList.remove('ica--editor-fullscreen-active');

    if (result !== POPUP_RESULT.AFFIRMATIVE) return;

    // Read values back
    agent.name = editorEl.find('#ica--editor-name').val().toString().trim() || 'Untitled Agent';
    agent.category = editorEl.find('#ica--editor-category').val().toString();
    agent.execution = agent.category === 'companion' || editorEl.find('#ica--editor-execution').val()?.toString() === 'companion'
        ? 'companion'
        : 'inline';
    agent.phase = editorEl.find('#ica--editor-phase').val().toString();
    agent.description = editorEl.find('#ica--editor-description').val().toString().trim();
    agent.favorite = editorEl.find('#ica--editor-favorite').prop('checked');
    agent.connectionProfile = editorEl.find('#ica--editor-connectionProfile').val()?.toString() || '';
    agent.modelOverride = editorEl.find('#ica--editor-modelOverride').val()?.toString().trim() || '';
    agent.prompt = editorEl.find('#ica--editor-prompt').val().toString();
    agent.companion = readCompanionConfigFromEditor(editorEl, agent);
    agent.settings = agent.settings && typeof agent.settings === 'object' && !Array.isArray(agent.settings)
        ? { ...agent.settings }
        : {};
    const sourceTemplateId = String(agent.sourceTemplateId ?? '').trim();
    if (sourceTemplateId === CHATROOM_TEMPLATE_ID) {
        agent.settings.chatroomStyle = normalizeChatroomStyle(editorEl.find('#ica--editor-chatroom-style').val());
        agent.settings.chatroomCustomStyles = normalizeChatroomCustomStyles(editorEl.find('#ica--editor-chatroom-custom-styles').val());
        agent.settings.chatroomCustomStyleName = normalizeChatroomCustomStyleName(editorEl.find('#ica--editor-chatroom-custom-style-name').val());
        agent.settings.chatroomExtraCharacterAvatars = normalizeChatroomExtraCharacterAvatars(editorEl.find('#ica--editor-chatroom-extra-character-avatars').val());
        delete agent.settings.chatroomCustomStyle;
    }
    if (sourceTemplateId === DIRECTORS_COMMENTARY_TEMPLATE_ID) {
        agent.settings.directorCommentaryVoice = normalizeDirectorCommentaryVoice(editorEl.find('#ica--editor-director-voice').val());
        agent.settings.directorCommentaryCustomVoices = normalizeDirectorCustomVoices(editorEl.find('#ica--editor-director-custom-voices').val());
        agent.settings.directorCommentaryCustomVoiceName = normalizeDirectorCustomVoiceName(editorEl.find('#ica--editor-director-custom-voice-name').val());
        delete agent.settings.directorCommentaryCustomVoice;
    }
    if (sourceTemplateId === PLOT_COMPASS_TEMPLATE_ID) {
        agent.settings.plotCompassObjective = editorEl.find('#ica--editor-plot-compass-objective').val()?.toString().trim() || '';
    }

    agent.injection.position = Number(editorEl.find('#ica--editor-position').val());
    agent.injection.depth = Number(editorEl.find('#ica--editor-depth').val());
    agent.injection.role = Number(editorEl.find('#ica--editor-role').val());
    agent.injection.order = Number(editorEl.find('#ica--editor-order').val());
    agent.injection.scan = editorEl.find('#ica--editor-scan').prop('checked');
    agent.preProcess = {
        ...getAgentPreProcess(agent),
        mode: editorEl.find('#ica--editor-pre-mode').val()?.toString() === 'intercept' ? 'intercept' : 'inject',
        interceptTiming: editorEl.find('#ica--editor-pre-interceptTiming').val()?.toString() === 'post-main-generation'
            ? 'post-main-generation'
            : 'pre-generation',
        applyMode: ['replace', 'wrap', 'patch'].includes(editorEl.find('#ica--editor-pre-applyMode').val()?.toString())
            ? editorEl.find('#ica--editor-pre-applyMode').val().toString()
            : 'replace',
        wrapPosition: editorEl.find('#ica--editor-pre-wrapPosition').val()?.toString() === 'before' ? 'before' : 'after',
        wrapPrefix: editorEl.find('#ica--editor-pre-wrapPrefix').val()?.toString() ?? '',
        wrapSuffix: editorEl.find('#ica--editor-pre-wrapSuffix').val()?.toString() ?? '',
        patchStartTag: editorEl.find('#ica--editor-pre-patchStartTag').val()?.toString() || DEFAULT_PRE_PROCESS.patchStartTag,
        patchEndTag: editorEl.find('#ica--editor-pre-patchEndTag').val()?.toString() || DEFAULT_PRE_PROCESS.patchEndTag,
        maxTokens: Number(editorEl.find('#ica--editor-pre-maxTokens').val()) || DEFAULT_AGENT_MAX_TOKENS,
    };

    if (isCompanionAgent(agent) && !agent.prompt.trim()) {
        toastr.warning('Companion execution needs an agent prompt.');
        return;
    }

    if (!isCompanionAgent(agent) && ['pre', 'both'].includes(agent.phase) && agent.preProcess.mode === 'intercept' && !agent.prompt.trim()) {
        toastr.warning('Pre-generation intercept mode needs an agent prompt.');
        return;
    }

    if (!isCompanionAgent(agent) && editorEl.find('#ica--editor-pp-promptEnabled').prop('checked') && !agent.prompt.trim()) {
        toastr.warning('Prompt-based post-generation passes need an agent prompt.');
        return;
    }

    agent.postProcess.enabled = editorEl.find('#ica--editor-pp-enabled').prop('checked');
    agent.postProcess.type = editorEl.find('#ica--editor-pp-type').val().toString();
    agent.postProcess.extractPattern = editorEl.find('#ica--editor-pp-extractPattern').val().toString();
    agent.postProcess.extractVariable = editorEl.find('#ica--editor-pp-extractVariable').val().toString();
    agent.postProcess.appendText = editorEl.find('#ica--editor-pp-appendText').val().toString();
    agent.postProcess.promptTransformEnabled = editorEl.find('#ica--editor-pp-promptEnabled').prop('checked');
    agent.postProcess.promptTransformShowNotifications = editorEl.find('#ica--editor-pp-promptShowNotifications').prop('checked');
    agent.postProcess.promptTransformMode = editorEl.find('#ica--editor-pp-promptMode').val()?.toString() === 'append' ? 'append' : 'rewrite';
    agent.postProcess.promptTransformMaxTokens = Number(editorEl.find('#ica--editor-pp-promptMaxTokens').val()) || DEFAULT_AGENT_MAX_TOKENS;
    agent.regexScripts = regexScripts.map(script => normalizeRegexScript(script));
    agent.conditions.runOnImpersonate = editorEl.find('#ica--editor-pp-runOnImpersonate').prop('checked');

    agent.conditions.triggerProbability = Number(editorEl.find('#ica--editor-probability').val());
    const kwText = editorEl.find('#ica--editor-keywords').val().toString();
    agent.conditions.triggerKeywords = kwText ? kwText.split(',').map(s => s.trim()).filter(Boolean) : [];

    const genTypes = [];
    if (editorEl.find('#ica--editor-type-normal').prop('checked')) genTypes.push('normal');
    if (editorEl.find('#ica--editor-type-continue').prop('checked')) genTypes.push('continue');
    if (editorEl.find('#ica--editor-type-impersonate').prop('checked')) genTypes.push('impersonate');
    if (editorEl.find('#ica--editor-type-quiet').prop('checked')) genTypes.push('quiet');
    agent.conditions.generationTypes = genTypes;

    if (JSON.stringify(agent) !== originalAgentState || agent.phaseLocked) {
        lockBundledAgentCustomization(agent, template);
    }

    await saveAgent(agent);
    refreshRegexSnapshotsForAgent(agent.id);
    renderAgentList();
    updateCompanionButtonVisibility();
}

// ===================== Template Browser =====================

/**
 * Loads built-in template agents from the templates directory.
 */
async function loadTemplates() {
    if (templates.length > 0) {
        return;
    }

    try {
        const [templateResponse, regexBundleResponse, groupResponse] = await Promise.all([
            fetch(getTemplateAssetUrl('index.json')),
            fetch(getTemplateAssetUrl('regex-bundles.json')),
            fetch(getTemplateAssetUrl('groups.json')),
        ]);

        const rawTemplates = templateResponse.ok ? await templateResponse.json() : [];
        templateRegexBundles = regexBundleResponse.ok ? await regexBundleResponse.json() : {};
        templates = Array.isArray(rawTemplates)
            ? rawTemplates
                .filter(template => !REMOVED_BUNDLED_TEMPLATE_IDS.has(String(template?.id ?? '').trim()))
                .map(template => mergeTemplateDefaults(template))
            : [];

        if (groupResponse.ok) {
            const rawGroups = await groupResponse.json();
            const builtinGroups = Array.isArray(rawGroups)
                ? rawGroups
                    .filter(group => !REMOVED_BUNDLED_GROUP_IDS.has(String(group?.id ?? '').trim()))
                    .map(group => ({
                        ...group,
                        agentTemplateIds: Array.isArray(group?.agentTemplateIds)
                            ? group.agentTemplateIds.filter(id => !REMOVED_BUNDLED_TEMPLATE_IDS.has(String(id ?? '').trim()))
                            : [],
                    }))
                : [];
            loadBuiltinGroups(builtinGroups);
        }
    } catch (e) {
        console.warn('[InChatAgents] Failed to load templates:', e);
    }
}

/**
 * Opens the template browser modal.
 */
async function openTemplateBrowser() {
    await loadTemplates();

    const visibleTemplates = getVisibleTemplateBrowserTemplates();
    if (visibleTemplates.length === 0) {
        toastr.info('No templates available.');
        return;
    }

    const wrapper = $('<div class="ica--template-browser"></div>');

    // Groups section
    const allGroups = getGroups();
    if (allGroups.length > 0) {
        const groupSection = $('<div class="ica--template-section"></div>');
        groupSection.append('<div class="ica--template-section-title"><i class="fa-solid fa-layer-group"></i> Agent Groups</div>');
        groupSection.append('<p class="ica--template-section-desc">Apply a whole set of agents at once. Agents you already have won\'t be duplicated.</p>');

        const groupGrid = $('<div class="ica--group-grid"></div>');
        for (const group of allGroups) {
            const count = group.agentTemplateIds.length + (group.customAgents?.length ?? 0);
            const card = $(`
                <div class="ica--group-card">
                    <div class="ica--group-card-header">
                        <strong>${escapeHtml(group.name)}</strong>
                        <span class="ica--card-pill">${count} agents</span>
                    </div>
                    <div class="ica--group-card-desc">${escapeHtml(group.description)}</div>
                    <div class="ica--group-card-actions">
                        <button type="button" class="ica--card-btn ica--grp-apply"><i class="fa-solid fa-download"></i> Apply Group</button>
                        ${!group.builtin ? '<button type="button" class="ica--card-btn ica--grp-delete caution"><i class="fa-solid fa-trash"></i></button>' : ''}
                    </div>
                </div>
            `);

            card.on('click', async () => {
                await applyGroup(group);
            });

            card.find('.ica--grp-apply').on('click', async event => {
                stopEvent(event);
                await applyGroup(group);
            });

            card.find('.ica--grp-delete').on('click', async event => {
                stopEvent(event);
                const r = await new Popup(`Delete group "${escapeHtml(group.name)}"?`, POPUP_TYPE.CONFIRM).show();
                if (r === POPUP_RESULT.AFFIRMATIVE) {
                    await deleteGroup(group.id);
                    card.remove();
                    toastr.success(`Deleted group "${group.name}".`);
                }
            });

            groupGrid.append(card);
        }

        // "Create Group" card
        const createCard = $(`
            <div class="ica--group-card ica--group-card-create">
                <div class="ica--group-card-header">
                    <strong><i class="fa-solid fa-plus"></i> Create Custom Group</strong>
                </div>
                <div class="ica--group-card-desc">Save your current agents as a reusable group.</div>
            </div>
        `);
        createCard.on('click', async () => {
            await createCustomGroup();
        });
        groupGrid.append(createCard);

        groupSection.append(groupGrid);
        wrapper.append(groupSection);
    }

    // Individual templates section
    const tplSection = $('<div class="ica--template-section"></div>');
    tplSection.append('<div class="ica--template-section-title"><i class="fa-solid fa-puzzle-piece"></i> Individual Templates</div>');
    tplSection.append('<p class="ica--template-section-desc">Bundled trackers and helpers live here. Click any card to install it into your agent list.</p>');

    let selectedCategory = '';
    const categoryOrder = getTemplateBrowserCategoryOrder(visibleTemplates);
    const filterBar = $(`
        <div class="ica--template-filter-bar">
            <input type="text" class="text_pole ica--template-search" placeholder="Search templates…" value="${escapeHtml(templateBrowserSearchValue)}" />
            <div class="ica--template-pill-row"></div>
        </div>
    `);
    const pillRow = filterBar.find('.ica--template-pill-row');
    const templateResults = $('<div class="ica--template-results"></div>');
    const existingAgents = getAgents();
    const allPill = $(`
        <button type="button" class="ica--template-pill is-active" data-category="">
            <span>All</span>
            <span class="ica--template-pill-count">0</span>
        </button>
    `);
    pillRow.append(allPill);

    for (const category of categoryOrder) {
        const catInfo = AGENT_CATEGORIES[category] || AGENT_CATEGORIES.custom;
        pillRow.append(`
            <button type="button" class="ica--template-pill" data-category="${escapeHtml(category)}">
                <i class="fa-solid ${catInfo.icon}"></i>
                <span>${escapeHtml(getTemplateCategoryLabel(category))}</span>
                <span class="ica--template-pill-count">0</span>
            </button>
        `);
    }

    function buildTemplateCard(tpl) {
        const catInfo = AGENT_CATEGORIES[tpl.category] || AGENT_CATEGORIES.custom;
        const regexCount = getTemplateRegexCount(tpl);
        const alreadyAdded = hasMatchingAgentSnapshot(buildAgentFromTemplate(tpl), existingAgents);
        const trackerBadge = tpl.category === 'tracker'
            ? '<span class="ica--card-pill"><i class="fa-solid fa-chart-line fa-xs"></i> Bundled tracker</span>'
            : '';
        const addedBadge = alreadyAdded
            ? '<span class="ica--card-pill"><i class="fa-solid fa-check fa-xs"></i> Added</span>'
            : '';
        const card = $(`
            <div class="ica--template-card${alreadyAdded ? ' ica--template-card--added' : ''}" data-id="${tpl.id}">
                <div class="ica--template-card-header">
                    <span class="ica--template-card-name">${escapeHtml(tpl.name)}</span>
                    <span class="ica--template-card-category"><i class="fa-solid ${catInfo.icon}"></i> ${escapeHtml(catInfo.label)}</span>
                </div>
                <div class="ica--template-card-description">${escapeHtml(tpl.description)}</div>
                <div class="ica--template-card-badges">
                    <span class="ica--card-pill ica--card-pill--version">v${escapeHtml(getTemplateVersionValue(tpl))}</span>
                    ${addedBadge}
                    ${trackerBadge}
                    ${regexCount > 0 ? `<span class="ica--card-pill"><i class="fa-solid fa-wand-magic-sparkles fa-xs"></i> ${buildRegexTemplateLabel(regexCount)}</span>` : ''}
                </div>
                <div class="ica--template-card-prompt">${escapeHtml((tpl.prompt || '').substring(0, 200))}</div>
            </div>
        `);

        card.on('click', async () => {
            const newAgent = buildAgentFromTemplate(tpl);
            if (!await confirmDuplicateAgentAddition(newAgent, existingAgents)) {
                toastr.info('Duplicate agent not added.');
                return;
            }

            await saveAgent(newAgent);
            renderAgentList();
            toastr.success(`Added "${tpl.name}" to your agents.`);
        });

        return card;
    }

    function appendTemplateGrid(parent, templateList) {
        const grid = $('<div class="ica--template-grid"></div>');
        for (const tpl of templateList) {
            grid.append(buildTemplateCard(tpl));
        }
        parent.append(grid);
    }

    function updateTemplatePills(searchTerm) {
        const searchedTemplates = filterTemplates(visibleTemplates, { searchTerm });
        const countsByCategory = new Map();
        for (const template of searchedTemplates) {
            countsByCategory.set(template.category, (countsByCategory.get(template.category) ?? 0) + 1);
        }

        pillRow.find('.ica--template-pill').each(function () {
            const category = $(this).attr('data-category') || '';
            const count = category ? countsByCategory.get(category) ?? 0 : searchedTemplates.length;
            $(this).toggleClass('is-active', category === selectedCategory);
            $(this).find('.ica--template-pill-count').text(count);
        });
    }

    function renderTemplateCategorySection(category, categoryTemplates, searchActive) {
        const catInfo = AGENT_CATEGORIES[category] || AGENT_CATEGORIES.custom;
        const categorySection = $(`
            <div class="ica--template-category-section">
                <div class="ica--template-category-title">
                    <i class="fa-solid ${catInfo.icon}"></i>
                    <span>${escapeHtml(getTemplateCategoryLabel(category))}</span>
                    <span class="ica--template-category-count">${categoryTemplates.length}</span>
                </div>
            </div>
        `);

        if (searchActive || !['tracker', 'content'].includes(category)) {
            appendTemplateGrid(categorySection, searchActive ? sortTemplatesByName(categoryTemplates) : categoryTemplates);
            return categorySection;
        }

        const subcategories = getTemplateSubcategoriesForCategory(category);
        const knownSubcategoryIds = new Set(subcategories.map(([subcategoryId]) => subcategoryId));
        const directTemplates = categoryTemplates.filter(template => !knownSubcategoryIds.has(String(template.subcategory ?? '').trim()));
        if (directTemplates.length > 0) {
            appendTemplateGrid(categorySection, directTemplates);
        }

        for (const [subcategoryId, subcategory] of subcategories) {
            const subgroupTemplates = categoryTemplates.filter(template => String(template.subcategory ?? '').trim() === subcategoryId);
            if (subgroupTemplates.length === 0) {
                continue;
            }

            categorySection.append(`
                <div class="ica--template-subgroup-title">
                    <i class="fa-solid ${subcategory.icon}"></i>
                    <span>${escapeHtml(subcategory.label)}</span>
                    <span>${subgroupTemplates.length}</span>
                </div>
            `);
            appendTemplateGrid(categorySection, subgroupTemplates);
        }

        return categorySection;
    }

    function renderTemplateResults() {
        const searchTerm = filterBar.find('.ica--template-search').val()?.toString() ?? '';
        templateBrowserSearchValue = searchTerm;
        const filteredTemplates = filterTemplates(visibleTemplates, {
            searchTerm,
            category: selectedCategory,
        });
        const searchActive = Boolean(searchTerm.trim());

        updateTemplatePills(searchTerm);
        templateResults.empty();

        if (filteredTemplates.length === 0) {
            templateResults.append('<div class="ica--template-empty">No templates match your filter.</div>');
            return;
        }

        for (const category of categoryOrder) {
            const categoryTemplates = filteredTemplates.filter(template => template.category === category);
            if (categoryTemplates.length === 0) {
                continue;
            }

            templateResults.append(renderTemplateCategorySection(category, categoryTemplates, searchActive));
        }
    }

    filterBar.find('.ica--template-search').on('input', renderTemplateResults);
    pillRow.on('click', '.ica--template-pill', function () {
        selectedCategory = $(this).attr('data-category') || '';
        renderTemplateResults();
    });

    tplSection.append(filterBar);
    tplSection.append(templateResults);
    wrapper.append(tplSection);
    renderTemplateResults();

    await new Popup(wrapper, POPUP_TYPE.TEXT, '', { wide: true, large: true }).show();
}

/**
 * Applies a group -- adds all its template agents that aren't already present.
 * @param {import('./agent-store.js').AgentGroup} group
 */
async function applyGroup(group) {
    let added = 0;

    for (const tplId of group.agentTemplateIds) {
        const tpl = findTemplateById(tplId);
        if (!tpl) continue;

        const newAgent = buildAgentFromTemplate(tpl);
        if (hasMatchingAgentSnapshot(newAgent)) continue;
        await saveAgent(newAgent);
        added++;
    }

    if (Array.isArray(group.customAgents)) {
        for (const customAgent of group.customAgents) {
            const newAgent = buildAgentFromSnapshot(customAgent);
            if (hasMatchingAgentSnapshot(newAgent)) continue;
            await saveAgent(newAgent);
            added++;
        }
    }

    if (!group.builtin && (!Array.isArray(group.customAgents) || group.customAgents.length === 0)) {
        for (const legacyAgentId of group.agentTemplateIds) {
            if (findTemplateById(legacyAgentId)) continue;
            const sourceAgent = getAgentById(legacyAgentId);
            if (!sourceAgent) continue;

            const snapshot = structuredClone(sourceAgent);
            delete snapshot.id;
            snapshot.enabled = false;

            if (hasMatchingAgentSnapshot(snapshot)) continue;
            await saveAgent(buildAgentFromSnapshot(snapshot));
            added++;
        }
    }

    renderAgentList();
    if (added > 0) {
        toastr.success(`Applied "${group.name}" -- added ${added} new agent(s).`);
    } else {
        toastr.info(`"${group.name}" is already applied.`);
    }
}

/**
 * Creates a custom group from the user's current agents.
 */
async function createCustomGroup() {
    const currentAgents = getVisibleInChatAgents();
    if (currentAgents.length === 0) {
        toastr.info('No agents to group. Add some agents first.');
        return;
    }

    const html = $(`
        <div style="display:flex;flex-direction:column;gap:12px;">
            <label style="display:flex;flex-direction:column;gap:4px;">
                <strong>Group Name</strong>
                <input type="text" id="ica--grp-name" class="text_pole" placeholder="My Custom Group" />
            </label>
            <label style="display:flex;flex-direction:column;gap:4px;">
                <strong>Description</strong>
                <input type="text" id="ica--grp-desc" class="text_pole" placeholder="What this group is for" />
            </label>
            <div>
                <strong>Select agents to include:</strong>
                <div id="ica--grp-agents" style="max-height:300px;overflow-y:auto;margin-top:6px;display:flex;flex-direction:column;gap:2px;"></div>
            </div>
        </div>
    `);

    const agentList = html.find('#ica--grp-agents');
    for (const agent of currentAgents) {
        agentList.append(`
            <label class="checkbox_label">
                <input type="checkbox" value="${agent.id}" checked />
                <span>${escapeHtml(agent.name)}</span>
            </label>
        `);
    }

    const result = await new Popup(html, POPUP_TYPE.CONFIRM, '', {
        okButton: 'Create Group',
        cancelButton: 'Cancel',
        wide: true,
    }).show();

    if (result !== POPUP_RESULT.AFFIRMATIVE) return;

    const name = html.find('#ica--grp-name').val()?.toString().trim();
    if (!name) {
        toastr.warning('Please enter a group name.');
        return;
    }

    const selectedIds = [];
    html.find('#ica--grp-agents input:checked').each(function () {
        selectedIds.push($(this).val());
    });

    if (selectedIds.length === 0) {
        toastr.warning('Select at least one agent.');
        return;
    }

    const selectedAgents = selectedIds
        .map(id => getAgentById(String(id)))
        .filter(Boolean);

    const group = createDefaultGroup();
    group.name = name;
    group.description = html.find('#ica--grp-desc').val()?.toString().trim() || '';
    group.agentTemplateIds = [];
    group.customAgents = selectedAgents.map(agent => {
        const snapshot = structuredClone(agent);
        delete snapshot.id;
        snapshot.enabled = false;
        return snapshot;
    });
    group.builtin = false;

    if (group.agentTemplateIds.length === 0 && group.customAgents.length === 0) {
        toastr.warning('Unable to build a reusable group from the selected agents.');
        return;
    }

    await saveGroup(group);

    toastr.success(`Created group "${name}" with ${selectedIds.length} agent(s).`);
}

// ===================== Import / Export =====================

/**
 * Handles file import.
 * @param {Event} event
 */
async function handleImport(event) {
    const file = event.target.files?.[0];
    if (!file) return;

    try {
        const text = await file.text();
        const data = JSON.parse(text);
        const imported = await importAgents(data);
        renderAgentList();
        toastr.success(`Imported ${imported.length} agent(s).`);
    } catch (e) {
        toastr.error('Failed to import: ' + e.message);
    }

    // Reset file input so the same file can be imported again
    event.target.value = '';
}

/**
 * Exports all agents to a JSON file.
 */
function handleExportAll() {
    const agents = getVisibleInChatAgents();
    if (agents.length === 0) {
        toastr.info('No agents to export.');
        return;
    }
    const data = {
        ...exportAllAgents(),
        agents,
    };
    download(JSON.stringify(data, null, 2), 'in-chat-agents.json', 'application/json');
}

// ===================== Utilities =====================

function normalizeMultilineInput(value) {
    return String(value ?? '').replace(/\r\n?/g, '\n').trim();
}

function toTitleCase(value) {
    return String(value ?? '')
        .replace(/[_-]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/\b\w/g, char => char.toUpperCase());
}

function slugifyIdentifier(value, fallback = 'tracker_data') {
    const slug = String(value ?? '')
        .trim()
        .toLowerCase()
        .replace(/^agent_/i, '')
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '');

    return slug || fallback;
}

function escapeRegexPattern(value) {
    return escapeRegex(String(value ?? ''));
}

function parseTrackerFormat(formatText) {
    const normalized = normalizeMultilineInput(formatText);
    if (!normalized) {
        return null;
    }

    const lines = normalized
        .split('\n')
        .map(line => line.trim())
        .filter(Boolean);

    const openLine = lines.find(line => /^\[[^\]]+\]$/.test(line) && !/^\[\/[^\]]+\]$/.test(line));
    if (!openLine) {
        return null;
    }

    const closeLine = [...lines].reverse().find(line => /^\[\/[^\]]+\]$/.test(line)) ?? '';
    const openInner = openLine.slice(1, -1).trim();
    const openParts = openInner.split('|').map(part => part.trim());
    const tagToken = openParts[0] ?? '';
    const closeTag = closeLine
        ? closeLine.slice(2, -1).trim()
        : (tagToken.includes(':') ? tagToken.split(':')[0].trim() : tagToken);
    const baseTag = (closeTag || tagToken.split(':')[0] || tagToken || 'TRACKER').trim();

    return {
        normalized,
        lines,
        openLine,
        closeLine,
        tagToken,
        closeTag,
        baseTag,
        headerFields: openParts.slice(1).filter(Boolean),
        bodyLines: lines.filter(line => line !== openLine && (!closeLine || line !== closeLine)),
    };
}

function buildTrackerPromptScaffold(agentName, description, definition, rulesText) {
    const title = agentName?.trim() || `${toTitleCase(definition.baseTag)} Tracker`;
    const descriptionText = description?.trim()
        || `Track ${toTitleCase(definition.baseTag).toLowerCase()} changes when they become relevant.`;
    const customRules = normalizeMultilineInput(rulesText)
        .split('\n')
        .map(line => line.trim())
        .filter(Boolean)
        .map(line => line.startsWith('-') ? line : `- ${line}`);

    const ruleLines = [
        '- Keep the opening and closing tags exactly as shown.',
        definition.headerFields.length > 0
            ? `- Keep the pipe-separated field order exactly as shown: ${definition.headerFields.join(' | ')}.`
            : '',
        definition.bodyLines.length > 0
            ? '- Preserve any extra body lines or labels exactly as shown, and do not leave required lines empty.'
            : '',
        '- Only emit this tracker when it becomes relevant or meaningfully changes.',
        ...customRules,
    ].filter(Boolean);

    return [
        `### ${title}`,
        descriptionText,
        'Use this EXACT format:',
        definition.normalized,
        'Rules:',
        ...ruleLines,
    ].join('\n');
}

function buildGenericTrackerRegexScript(definition, trackerTitle) {
    const openToken = escapeRegexPattern(definition.tagToken);
    const closeToken = escapeRegexPattern(definition.closeTag || definition.baseTag);
    const headerCaptures = definition.headerFields.map(() => '([^|\\]]+)').join('\\|');
    const openPattern = definition.headerFields.length > 0
        ? `\\[${openToken}\\|${headerCaptures}\\]`
        : `\\[${openToken}\\]`;
    const bodyPattern = definition.closeLine
        ? `\\n*([\\s\\S]*?)(?:\\n*\\[\\/${closeToken}\\])(?=\\n|$)`
        : '(?:\\n*([\\s\\S]*?))?(?=\\n|$)';
    const bodyGroupIndex = definition.headerFields.length + 1;
    const bodyLabel = definition.bodyLines.find(line => line.includes(':'))?.split(':')[0]?.trim() || 'Details';
    const summaryValue = definition.headerFields.length > 0
        ? '<span style="opacity:0.82">·</span> <span style="color:#f8f8f2">$1</span>'
        : '';
    const fieldGrid = definition.headerFields.length > 0
        ? `<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(132px,1fr));gap:8px;margin-bottom:${definition.bodyLines.length > 0 ? '10px' : '0'}">${definition.headerFields.map((field, index) => `
                <div style="padding:8px 10px;background:rgba(255,255,255,0.05);border:1px solid rgba(159,195,239,0.18);border-radius:8px">
                    <div style="font-size:10px;letter-spacing:0.08em;text-transform:uppercase;color:#9fc3ef;margin-bottom:4px">${escapeHtml(field)}</div>
                    <div style="color:#f8f8f2;font-size:11px">$${index + 1}</div>
                </div>
            `).join('')}</div>`
        : '';
    const bodyBlock = `
        <div style="padding:9px 11px;background:rgba(255,255,255,0.04);border-left:3px solid #7ba3d4;border-radius:8px;white-space:pre-line">
            <div style="font-size:10px;letter-spacing:0.08em;text-transform:uppercase;color:#9fc3ef;margin-bottom:4px">${escapeHtml(bodyLabel)}</div>
            <div style="color:#f8f8f2">$${bodyGroupIndex}</div>
        </div>
    `;

    return normalizeRegexScript({
        scriptName: `Render ${trackerTitle}`,
        findRegex: `/${openPattern}${bodyPattern}/g`,
        replaceString: `<details style="margin:10px 0"><summary style="padding:10px 13px;background:linear-gradient(135deg,rgba(21,26,34,0.97),rgba(43,78,126,0.68));border-radius:12px;border:1px solid rgba(123,163,212,0.5);box-shadow:0 10px 24px rgba(0,0,0,0.28);color:#9fc3ef;font-family:monospace;font-size:11px;cursor:pointer">${escapeHtml(trackerTitle)} ${summaryValue}</summary><div style="padding:13px;background:linear-gradient(180deg,rgba(20,22,28,0.97),rgba(34,37,46,0.96));border-radius:0 0 12px 12px;border:1px solid rgba(123,163,212,0.32);border-top:none;font-size:11px;line-height:1.68;color:#f8f8f2">${fieldGrid}${bodyBlock}</div></details>`,
        placement: [AGENT_REGEX_PLACEMENT.AI_OUTPUT],
        disabled: false,
        markdownOnly: true,
        promptOnly: false,
        runOnEdit: true,
        substituteRegex: AGENT_REGEX_SUBSTITUTE.NONE,
        minDepth: null,
        maxDepth: null,
    });
}

function buildTrackerFallbackKit({ agentName, description, formatText, rulesText }) {
    const definition = parseTrackerFormat(formatText);
    if (!definition) {
        return null;
    }

    const trackerTitle = agentName?.trim() || `${toTitleCase(definition.baseTag)} Tracker`;
    const extractPattern = definition.closeLine
        ? `\\[${escapeRegexPattern(definition.tagToken)}(?:\\|[^\\]]*)?\\][\\s\\S]*?\\[\\/${escapeRegexPattern(definition.closeTag || definition.baseTag)}\\]`
        : `\\[${escapeRegexPattern(definition.tagToken)}(?:\\|[^\\]]*)?\\]`;

    return {
        name: trackerTitle,
        description: description?.trim() || `Custom ${toTitleCase(definition.baseTag).toLowerCase()} tracker`,
        phase: 'pre',
        prompt: buildTrackerPromptScaffold(agentName, description, definition, rulesText),
        postProcess: {
            enabled: true,
            type: 'extract',
            extractPattern,
            extractVariable: slugifyIdentifier(`${definition.baseTag}_data`),
        },
        regexScripts: [buildGenericTrackerRegexScript(definition, trackerTitle)],
        usedFallback: true,
    };
}

function extractJsonObject(text) {
    const trimmed = String(text ?? '').trim();
    if (!trimmed) {
        return '';
    }

    const fencedMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fencedMatch?.[1]) {
        return fencedMatch[1].trim();
    }

    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start >= 0 && end > start) {
        return trimmed.slice(start, end + 1).trim();
    }

    return trimmed;
}

function normalizeTrackerKitResponse(rawResult, fallbackKit) {
    const rawPostProcess = rawResult?.postProcess && typeof rawResult.postProcess === 'object'
        ? rawResult.postProcess
        : {};
    const normalizedScripts = Array.isArray(rawResult?.regexScripts)
        ? rawResult.regexScripts
            .map(script => normalizeRegexScript({
                ...script,
                placement: Array.isArray(script?.placement) && script.placement.length > 0
                    ? script.placement
                    : [AGENT_REGEX_PLACEMENT.AI_OUTPUT],
                markdownOnly: script?.markdownOnly === undefined ? true : Boolean(script.markdownOnly),
                promptOnly: Boolean(script?.promptOnly),
                runOnEdit: script?.runOnEdit === undefined ? true : Boolean(script.runOnEdit),
            }))
            .filter(script => script.findRegex?.trim())
        : [];

    return {
        ...fallbackKit,
        name: typeof rawResult?.name === 'string' && rawResult.name.trim() ? rawResult.name.trim() : fallbackKit.name,
        description: typeof rawResult?.description === 'string' && rawResult.description.trim() ? rawResult.description.trim() : fallbackKit.description,
        phase: ['pre', 'post', 'both'].includes(String(rawResult?.phase)) ? String(rawResult.phase) : fallbackKit.phase,
        prompt: typeof rawResult?.prompt === 'string' && rawResult.prompt.trim() ? rawResult.prompt.trim() : fallbackKit.prompt,
        postProcess: {
            ...fallbackKit.postProcess,
            enabled: true,
            type: 'extract',
            extractPattern: typeof rawPostProcess.extractPattern === 'string' && rawPostProcess.extractPattern.trim()
                ? rawPostProcess.extractPattern.trim()
                : fallbackKit.postProcess.extractPattern,
            extractVariable: slugifyIdentifier(
                typeof rawPostProcess.extractVariable === 'string' && rawPostProcess.extractVariable.trim()
                    ? rawPostProcess.extractVariable.trim()
                    : fallbackKit.postProcess.extractVariable,
                fallbackKit.postProcess.extractVariable,
            ),
        },
        regexScripts: normalizedScripts.length > 0 ? normalizedScripts : fallbackKit.regexScripts,
        usedFallback: false,
    };
}

function buildCompanionFallbackKit({ agentName, description, currentPrompt, goalText }) {
    const name = agentName?.trim() || 'Companion Agent';
    const goal = normalizeContentText(goalText || description || currentPrompt || 'watch for useful side notes').trim();
    const prompt = currentPrompt?.trim() || [
        'Read the latest assistant reply and recent context as a companion note taker.',
        `Goal: ${goal}`,
        'Write a concise side note for the user. Focus only on evidence present in the chat. Do not rewrite the assistant reply and do not invent new facts.',
        'Return markdown bullets. If there is nothing useful to add, write exactly: No companion note needed.',
    ].join('\n');

    return {
        name,
        description: description?.trim() || 'Companion note saved under assistant replies',
        prompt,
        companion: getCompanionConfig({
            companion: {
                trigger: 'manual',
                displayMode: 'card',
                format: 'markdown',
                contextMessages: 10,
                includeHistory: true,
                historyDepth: 2,
                feedback: { enabled: false, depth: 1 },
                batch: true,
                maxTokens: 32000,
            },
        }),
        usedFallback: true,
    };
}

function normalizeCompanionKitResponse(rawResult, fallbackKit) {
    return {
        ...fallbackKit,
        name: typeof rawResult?.name === 'string' && rawResult.name.trim() ? rawResult.name.trim() : fallbackKit.name,
        description: typeof rawResult?.description === 'string' && rawResult.description.trim() ? rawResult.description.trim() : fallbackKit.description,
        prompt: typeof rawResult?.prompt === 'string' && rawResult.prompt.trim() ? rawResult.prompt.trim() : fallbackKit.prompt,
        companion: getCompanionConfig({ companion: rawResult?.companion ?? fallbackKit.companion }),
        usedFallback: false,
    };
}

async function generateCompanionKitWithAI({ agentName, description, currentPrompt, goalText, connectionProfile = '' }) {
    const fallbackKit = buildCompanionFallbackKit({ agentName, description, currentPrompt, goalText });
    const systemPrompt = `You build companion agents for SillyBunny's in-chat agents extension. Return strict JSON only, with no markdown fences and no explanation.

The JSON shape must be:
{
  "name": "Companion name",
  "description": "Short description",
  "prompt": "Full companion prompt text",
  "companion": {
    "trigger": "auto",
    "displayMode": "card",
    "format": "markdown",
    "contextMessages": 10,
    "includeHistory": true,
    "historyDepth": 2,
    "feedback": { "enabled": false, "depth": 1 },
    "batch": true,
    "maxTokens": 32000
  }
}

Requirements:
- Companion agents run after the main assistant reply and save a separate note card.
- The prompt must never ask the model to rewrite or continue the assistant reply.
- Prefer concise markdown unless the user specifically needs HTML or plain text.
- Use trigger "manual" for occasional diagnostics and "auto" for notes that should run after most replies.
- Use displayMode "hidden" only when the note is mainly for feedback into future generations.
- Keep maxTokens between 512 and 32000. Use 32000 by default unless the user asks for a smaller, cheaper companion.`;

    const userPrompt = [
        `Agent name: ${agentName || '(blank)'}`,
        `Description: ${description || '(blank)'}`,
        '',
        'Companion goal:',
        goalText || '(none)',
        '',
        'Existing prompt text to preserve if useful:',
        currentPrompt || '(none)',
    ].join('\n');

    try {
        const rawResponse = await refineLLMCall(systemPrompt, userPrompt, connectionProfile);
        const parsedResponse = JSON.parse(extractJsonObject(rawResponse));
        return normalizeCompanionKitResponse(parsedResponse, fallbackKit);
    } catch (error) {
        console.warn('[InChatAgents] Custom companion generation fell back to local scaffold.', error);
        return fallbackKit;
    }
}

function buildPromptTransformDiffMarkup(beforeText, afterText) {
    const dmp = new DiffMatchPatch();
    const diffs = dmp.diff_main(String(beforeText ?? ''), String(afterText ?? ''));
    dmp.diff_cleanupSemantic(diffs);

    return diffs.map(([operation, text]) => {
        const escapedText = escapeHtml(text);
        if (operation === 1) {
            return `<span class="ica-transform-diff-part--ins">${escapedText}</span>`;
        }
        if (operation === -1) {
            return `<span class="ica-transform-diff-part--del">${escapedText}</span>`;
        }
        return `<span>${escapedText}</span>`;
    }).join('');
}

function getPreGenerationInterceptModeLabel(entry) {
    const mode = String(entry?.applyMode ?? 'replace');
    const timing = entry?.timing === 'post-main-generation' ? 'post-main' : 'pre-gen';
    if (mode === 'wrap') {
        return `${timing} wrap`;
    }
    if (mode === 'patch') {
        return `${timing} patch`;
    }
    return `${timing} replace`;
}

function parseChatInterceptSummaryMessages(value) {
    let parsed;
    try {
        parsed = JSON.parse(String(value ?? ''));
    } catch {
        return { ok: false, reason: 'parse-error' };
    }

    if (!Array.isArray(parsed)) {
        return { ok: false, reason: 'shape-error' };
    }

    const messages = [];
    for (const [index, message] of parsed.entries()) {
        if (!message || typeof message !== 'object' || Array.isArray(message)) {
            return { ok: false, reason: 'shape-error' };
        }

        if (typeof message.role !== 'string' || typeof message.content !== 'string') {
            return { ok: false, reason: 'shape-error' };
        }

        messages.push({
            index,
            role: message.role,
            content: message.content,
        });
    }

    return { ok: true, messages };
}

export function summarizeChatInterceptChange(beforeText, afterText) {
    const beforeResult = parseChatInterceptSummaryMessages(beforeText);
    const afterResult = parseChatInterceptSummaryMessages(afterText);

    if (!beforeResult.ok) {
        return { ok: false, reason: beforeResult.reason };
    }

    if (!afterResult.ok) {
        return { ok: false, reason: afterResult.reason };
    }

    const beforeMessages = beforeResult.messages;
    const afterMessages = afterResult.messages;
    const matchedBefore = new Set();
    const matchedAfter = new Set();

    for (const beforeMessage of beforeMessages) {
        const afterMessage = afterMessages.find(candidate =>
            !matchedAfter.has(candidate.index) &&
            candidate.role === beforeMessage.role &&
            candidate.content === beforeMessage.content,
        );

        if (!afterMessage) {
            continue;
        }

        matchedBefore.add(beforeMessage.index);
        matchedAfter.add(afterMessage.index);
    }

    const changes = [];
    for (const beforeMessage of beforeMessages) {
        if (matchedBefore.has(beforeMessage.index)) {
            continue;
        }

        const afterMessage = afterMessages[beforeMessage.index];
        if (!afterMessage || matchedAfter.has(afterMessage.index)) {
            continue;
        }

        matchedBefore.add(beforeMessage.index);
        matchedAfter.add(afterMessage.index);
        changes.push({
            changeKind: 'modified',
            role: afterMessage.role || beforeMessage.role,
            beforeIndex: beforeMessage.index,
            afterIndex: afterMessage.index,
            beforeContent: beforeMessage.content,
            afterContent: afterMessage.content,
        });
    }

    for (const beforeMessage of beforeMessages) {
        if (matchedBefore.has(beforeMessage.index)) {
            continue;
        }

        changes.push({
            changeKind: 'removed',
            role: beforeMessage.role,
            beforeIndex: beforeMessage.index,
            afterIndex: null,
            beforeContent: beforeMessage.content,
            afterContent: '',
        });
    }

    for (const afterMessage of afterMessages) {
        if (matchedAfter.has(afterMessage.index)) {
            continue;
        }

        changes.push({
            changeKind: 'added',
            role: afterMessage.role,
            beforeIndex: null,
            afterIndex: afterMessage.index,
            beforeContent: '',
            afterContent: afterMessage.content,
        });
    }

    const changeKindOrder = {
        removed: 0,
        modified: 1,
        added: 2,
    };
    changes.sort((left, right) => {
        const leftIndex = left.afterIndex ?? left.beforeIndex ?? 0;
        const rightIndex = right.afterIndex ?? right.beforeIndex ?? 0;
        if (leftIndex !== rightIndex) {
            return leftIndex - rightIndex;
        }

        return changeKindOrder[left.changeKind] - changeKindOrder[right.changeKind];
    });

    return { ok: true, changes };
}

function buildPreGenerationChatChangeMarkup(change) {
    let diffMarkup = '';
    if (change.changeKind === 'added') {
        diffMarkup = `<span class="ica-transform-diff-part--ins">${escapeHtml(change.afterContent)}</span>`;
    } else if (change.changeKind === 'removed') {
        diffMarkup = `<span class="ica-transform-diff-part--del">${escapeHtml(change.beforeContent)}</span>`;
    } else {
        diffMarkup = buildPromptTransformDiffMarkup(change.beforeContent, change.afterContent);
    }

    return `
        <div class="ica-preintercept-message-change">
            <div class="ica-preintercept-message-header">
                <span class="ica-preintercept-role">${escapeHtml(change.role || 'message')}</span>
                <span class="ica-preintercept-change-kind">${escapeHtml(change.changeKind)}</span>
            </div>
            <div class="ica-transform-diff">${diffMarkup}</div>
        </div>
    `;
}

function buildPreGenerationInterceptSummaryMarkup(entry) {
    const beforeText = entry.beforeText ?? '';
    const outputText = String(entry.outputText ?? '').trim();
    const afterText = entry.contextFormat === 'chat' && entry.status === 'error' && outputText
        ? outputText
        : entry.afterText ?? '';

    if (entry.contextFormat !== 'chat') {
        return `
            <div class="ica-transform-output-title">Prompt diff</div>
            <div class="ica-transform-diff">${buildPromptTransformDiffMarkup(beforeText, afterText)}</div>
        `;
    }

    try {
        const summary = summarizeChatInterceptChange(beforeText, afterText);
        if (!summary.ok) {
            return `
                <div class="ica-preintercept-fallback-notice">Could not summarize chat messages; showing raw diff.</div>
                <div class="ica-transform-output-title">Context diff</div>
                <div class="ica-transform-diff">${buildPromptTransformDiffMarkup(beforeText, afterText)}</div>
            `;
        }

        const changesMarkup = summary.changes.length > 0
            ? summary.changes.map(buildPreGenerationChatChangeMarkup).join('')
            : '<div class="ica-preintercept-empty">No effective change.</div>';

        return `
            <div class="ica-transform-output-title">Chat changes</div>
            ${changesMarkup}
        `;
    } catch (error) {
        console.warn('[InChatAgents] Failed to summarize pre-generation intercept history entry:', error);
        return `
            <div class="ica-preintercept-fallback-notice">Could not summarize chat messages; showing raw diff.</div>
            <div class="ica-transform-output-title">Context diff</div>
            <div class="ica-transform-diff">${buildPromptTransformDiffMarkup(beforeText, afterText)}</div>
        `;
    }
}

function buildPreGenerationInterceptEntryMarkup(entry, i) {
    const timestamp = entry.timestamp ? new Date(entry.timestamp).toLocaleString() : '';
    const status = String(entry.status ?? 'changed');
    const statusText = status === 'error'
        ? `Error: ${entry.error || 'unknown error'}`
        : `${entry.changed ? 'Changed' : 'No visible change'} the ${entry.contextFormat === 'chat' ? 'chat message array' : 'text prompt'}`;
    const modeLabel = getPreGenerationInterceptModeLabel(entry);
    const output = String(entry.outputText ?? '').trim();

    return `
        <div class="ica-transform-history-entry ica-preintercept-history-entry" data-index="${i}">
            <h5>${escapeHtml(entry.agentName || 'Agent')} <small>(${escapeHtml(modeLabel)})</small></h5>
            <small>${escapeHtml(timestamp)}${timestamp ? ' · ' : ''}${escapeHtml(statusText)}</small>
            ${buildPreGenerationInterceptSummaryMarkup(entry)}
            <details class="ica-preintercept-raw">
                <summary>Raw agent output</summary>
                <pre class="ica-transform-diff">${escapeHtml(output)}</pre>
            </details>
        </div>
    `;
}

async function openPromptTransformHistoryPopup(messageIndex) {
    if (!Number.isInteger(Number(messageIndex)) || !chat[messageIndex]) {
        return;
    }

    const message = chat[Number(messageIndex)];
    const preGenerationHistory = getPreGenerationInterceptHistoryForMessage(message);
    const history = getPromptTransformHistoryForMessage(message);
    if ((!Array.isArray(preGenerationHistory) || preGenerationHistory.length === 0) && (!Array.isArray(history) || history.length === 0)) {
        toastr.info('No agent document history available.');
        return;
    }

    const preGenerationEntries = preGenerationHistory.map(buildPreGenerationInterceptEntryMarkup).join('');
    const postGenerationEntries = history.map((entry, i) => {
        const timestamp = entry.timestamp ? new Date(entry.timestamp).toLocaleString() : '';
        return `
            <div class="ica-transform-history-entry" data-index="${i}">
                <h5>${escapeHtml(entry.agentName || 'Agent')} <small>(${escapeHtml(entry.mode || 'replace')})</small></h5>
                <small>${escapeHtml(`Order ${entry.order ?? 'n/a'} | Model: ${entry.modelLabel || entry.profileLabel || 'Current model'}`)}</small>
                <small>${timestamp}</small>
                <div class="ica-transform-diff">${buildPromptTransformDiffMarkup(entry.beforeText ?? '', entry.afterText ?? '')}</div>
                <div class="ica-transform-actions">
                    <button class="ica-undo-btn menu_button" data-mesid="${messageIndex}">Undo</button>
                    <button class="ica-redo-btn menu_button" data-mesid="${messageIndex}">Redo</button>
                </div>
            </div>
        `;
    }).join('');

    const html = $(`<div class="ica-transform-history">
        ${preGenerationEntries ? `<section class="ica-transform-history-section"><h4>Generation Intercepts</h4>${preGenerationEntries}</section>` : ''}
        ${postGenerationEntries ? `<section class="ica-transform-history-section"><h4>Post-Generation Changes</h4>${postGenerationEntries}</section>` : ''}
    </div>`);

    html.find('.ica-undo-btn').on('click', async function () {
        const idx = Number($(this).data('mesid'));
        if (await undoPromptTransform(idx)) {
            toastr.success('Transform undone.');
        } else {
            toastr.warning('Could not undo transform.');
        }
    });

    html.find('.ica-redo-btn').on('click', async function () {
        const idx = Number($(this).data('mesid'));
        if (await redoPromptTransform(idx)) {
            toastr.success('Transform redone.');
        } else {
            toastr.warning('Could not redo transform.');
        }
    });

    await new Popup(html, POPUP_TYPE.TEXT, '', {
        wide: true,
        large: true,
        allowVerticalScrolling: true,
        leftAlign: true,
    }).show();
}

// ===================== Pathfinder Editor =====================

function getPathfinderSettingsAgent() {
    return getAgents().find(isPathfinderAgent) ?? null;
}

function removePathfinderExtensionsHost() {
    document.getElementById(PATHFINDER_EXTENSIONS_HOST_ID)?.remove();
    pathfinderExtensionsMountPromise = null;
}

function ensurePathfinderExtensionsHost() {
    const parent = document.getElementById('extensions_settings2') ?? document.getElementById('extensions_settings');
    if (!parent) {
        return null;
    }

    let host = document.getElementById(PATHFINDER_EXTENSIONS_HOST_ID);
    if (!host) {
        host = document.createElement('div');
        host.id = PATHFINDER_EXTENSIONS_HOST_ID;
        host.className = 'extension_container pf--extensions-host';
        host.innerHTML = `
            <div class="inline-drawer">
                <div class="inline-drawer-toggle inline-drawer-header">
                    <b><i class="fa-solid fa-route"></i> Pathfinder</b>
                    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
                </div>
                <div class="inline-drawer-content pf--extensions-body" style="display:none"></div>
            </div>
        `;
        parent.append(host);
    }

    return host;
}

async function mountPathfinderSettingsInExtensions() {
    if (!isPathfinderSubmoduleEnabled()) {
        removePathfinderExtensionsHost();
        return null;
    }

    const host = ensurePathfinderExtensionsHost();
    if (!host) {
        console.warn('[Pathfinder] Could not mount settings in Extensions drawer because #extensions_settings was not found.');
        return null;
    }

    const body = host.querySelector('.pf--extensions-body');
    if (!body) {
        return null;
    }

    const agent = getPathfinderSettingsAgent();
    body.innerHTML = '';

    if (!agent) {
        body.innerHTML = '<div class="pf--extensions-empty">Pathfinder agent is not available. Reload In-Chat Agents or restore the bundled Pathfinder template.</div>';
        return host;
    }

    const settingsPanel = await openPathfinderSettings(agent);
    if (!isPathfinderSubmoduleEnabled()) {
        removePathfinderExtensionsHost();
        return null;
    }

    if (!settingsPanel) {
        body.innerHTML = '<div class="pf--extensions-empty">Could not load Pathfinder settings.</div>';
        return host;
    }

    settingsPanel.filter('#pf--settings').addClass('pf--settings-embedded');
    for (const node of settingsPanel.toArray()) {
        body.append(node);
    }
    return host;
}

function schedulePathfinderExtensionsMount() {
    if (!isPathfinderSubmoduleEnabled()) {
        removePathfinderExtensionsHost();
        return Promise.resolve(null);
    }

    pathfinderExtensionsMountPromise = mountPathfinderSettingsInExtensions()
        .catch(error => {
            console.warn('[Pathfinder] Failed to mount settings in Extensions drawer:', error);
            return null;
        });

    return pathfinderExtensionsMountPromise;
}

function openPathfinderExtensionsDrawer(host) {
    const clickEvent = () => new (globalThis.MouseEvent ?? Event)('click', { bubbles: true });
    const drawer = document.getElementById('extensions-settings-button');
    const drawerContent = drawer?.querySelector(':scope > .drawer-content');
    if (drawer && drawerContent?.classList.contains('closedDrawer')) {
        drawer.querySelector(':scope > .drawer-toggle')?.dispatchEvent(clickEvent());
    }

    const inlineDrawer = host?.querySelector('.inline-drawer');
    const inlineContent = inlineDrawer?.querySelector(':scope > .inline-drawer-content');
    const inlineIcon = inlineDrawer?.querySelector(':scope > .inline-drawer-header .inline-drawer-icon');
    if (inlineDrawer && inlineContent && inlineIcon?.classList.contains('down')) {
        inlineDrawer.querySelector(':scope > .inline-drawer-toggle')?.dispatchEvent(clickEvent());
    }

    globalThis.setTimeout(() => {
        host?.scrollIntoView({ block: 'start', behavior: 'smooth' });
        host?.querySelector('input, button, select, textarea')?.focus?.({ preventScroll: true });
    }, 100);
}

/**
 * Opens the Pathfinder-specific settings editor
 * @param {Object} agent - The Pathfinder agent
 */
async function openPathfinderEditor(agent) {
    if (!isPathfinderSubmoduleEnabled()) {
        toastr.warning('Pathfinder is disabled in In-Chat Agents settings.');
        return;
    }

    const existingHost = document.getElementById(PATHFINDER_EXTENSIONS_HOST_ID);
    if (existingHost) {
        const host = await (pathfinderExtensionsMountPromise ?? schedulePathfinderExtensionsMount());
        openPathfinderExtensionsDrawer(host ?? existingHost);
        toastr.info('Pathfinder settings are in the Extensions drawer.');
        return;
    }

    const originalAgentState = JSON.stringify(agent);
    const template = findTemplateForAgent(agent);
    const settingsPanel = await openPathfinderSettings(agent, async (updatedAgent) => {
        await saveAgent(updatedAgent);
        renderAgentList();
    });

    if (!settingsPanel) return;

    console.log('[Pathfinder] Settings popup opened from agent editor.', {
        agentName: agent?.name || 'Pathfinder',
    });

    const result = await new Popup(settingsPanel, POPUP_TYPE.CONFIRM, '', {
        okButton: 'Save & Close',
        cancelButton: 'Cancel',
        wide: true,
        large: true,
    }).show();

    if (result === POPUP_RESULT.AFFIRMATIVE) {
        if (JSON.stringify(agent) !== originalAgentState || agent.phaseLocked) {
            lockBundledAgentCustomization(agent, template);
        }

        // Settings are already saved via the UI callbacks
        await saveAgent(agent);
        renderAgentList();
        syncToolAgentRegistrations();
        console.log('[Pathfinder] Settings popup saved and closed.', {
            agentName: agent?.name || 'Pathfinder',
        });
        toastr.success('Pathfinder settings saved');
    } else {
        console.log('[Pathfinder] Settings popup closed without confirmation.', {
            agentName: agent?.name || 'Pathfinder',
        });
    }
}

// ===================== Connection Profiles =====================

/**
 * Populates the connection profile dropdown from CMRS.
 */
function populateProfileDropdown() {
    const select = document.getElementById('ica--connectionProfile');
    if (select) {
        populateConnectionProfileSelect(select, {
            emptyLabel: 'Use selected connection profile',
            selectedValue: getGlobalSettings().connectionProfile || '',
        });
    }

    const companionSelect = document.getElementById('ica--companionConnectionProfile');
    if (companionSelect) {
        populateConnectionProfileSelect(companionSelect, {
            emptyLabel: 'Use Default Connection Profile',
            selectedValue: getGlobalSettings().companionConnectionProfile || '',
        });
    }
}

function refreshConnectionProfileUi() {
    populateProfileDropdown();

    const editorSelect = document.getElementById('ica--editor-connectionProfile');
    if (editorSelect instanceof HTMLSelectElement) {
        const emptyLabel = editorSelect.options[0]?.textContent?.trim() || 'Use extension default';
        const selectedValue = editorSelect.value || '';
        populateConnectionProfileSelect(editorSelect, {
            emptyLabel,
            selectedValue,
        });
    }

    renderAgentList();
}

function populateGlobalNotificationToggle() {
    updateGlobalAgentToggle();
    populateSeparateRecentChatsToggle();
    populatePathfinderSubmoduleToggle();
    $('#ica--promptTransformShowNotifications').prop(
        'checked',
        Boolean(getGlobalSettings().promptTransformShowNotifications),
    );
}

function populatePathfinderSubmoduleToggle() {
    $('#ica--pathfinderSubmoduleEnabled').prop('checked', isPathfinderSubmoduleEnabled());
}

function populateGlobalExecutionModeDropdown() {
    $('#ica--appendAgentsExecutionMode').val(getGlobalSettings().appendAgentsExecutionMode || 'parallel');
    $('#ica--companionExecutionMode').val(getGlobalSettings().companionExecutionMode || 'parallel');
    $('#ica--companionConcurrent').prop('checked', Boolean(getGlobalSettings().companionConcurrentWithPostGen));
}

function populateGlobalHelperPrefillField() {
    $('#ica--helperPrefillMessages').val(getGlobalSettings().helperPrefillMessages || '');
}

/**
 * Makes an LLM call for prompt refinement, using CMRS if a profile is selected.
 * @param {string} systemPrompt
 * @param {string} userPrompt
 * @returns {Promise<string>}
 */
async function refineLLMCall(systemPrompt, userPrompt, connectionProfile = '') {
    const profileId = resolveConnectionProfile(connectionProfile);
    const messages = appendHelperPrefillMessages([
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
    ], getGlobalSettings().helperPrefillMessages);

    if (!profileId) {
        return await generateQuietPrompt({
            quietPrompt: buildFallbackPromptText(messages),
            skipWIAN: true,
        });
    }

    const CMRS = getConnectionManagerRequestService();

    if (!CMRS) {
        return await generateQuietPrompt({
            quietPrompt: buildFallbackPromptText(messages),
            skipWIAN: true,
        });
    }

    try {
        const response = await CMRS.sendRequest(profileId, messages, DEFAULT_AGENT_MAX_TOKENS, {
            extractData: true,
            includePreset: true,
            includeInstruct: true,
            stream: false,
        });
        const responseText = extractProfileResponseText(response);
        if (responseText.trim()) {
            return responseText;
        }
    } catch (error) {
        console.warn(`[InChatAgents] Prompt refinement via profile "${profileId}" failed, retrying with fallback prompt formatting.`, error);
    }

    let fallbackPrompt = '';
    if (typeof CMRS.constructPrompt === 'function') {
        try {
            fallbackPrompt = CMRS.constructPrompt(messages, profileId) ?? '';
        } catch (error) {
            console.warn(`[InChatAgents] Failed to construct fallback prompt for profile "${profileId}" during prompt refinement.`, error);
        }
    }
    const fallbackRequestPrompt = Array.isArray(fallbackPrompt)
        ? fallbackPrompt
        : (normalizeContentText(fallbackPrompt).trim() ? normalizeContentText(fallbackPrompt) : buildFallbackPromptText(messages));
    const fallbackResponse = await CMRS.sendRequest(
        profileId,
        fallbackRequestPrompt,
        DEFAULT_AGENT_MAX_TOKENS,
        {
            extractData: true,
            includePreset: true,
            includeInstruct: false,
            stream: false,
        },
    );
    return extractProfileResponseText(fallbackResponse);
}

async function generateTrackerKitWithAI({
    agentName,
    description,
    currentPrompt,
    formatText,
    rulesText,
    styleNotes,
    connectionProfile = '',
}) {
    const fallbackKit = buildTrackerFallbackKit({ agentName, description, formatText, rulesText });
    if (!fallbackKit) {
        throw new Error('Tracker format example is missing a valid opening tag.');
    }

    const systemPrompt = `You build custom tracker agent kits for SillyBunny's in-chat agents extension. Return strict JSON only, with no markdown fences and no explanation.

The JSON shape must be:
{
  "name": "Tracker name",
  "description": "Short description",
  "phase": "pre",
  "prompt": "Full tracker prompt text",
  "postProcess": {
    "enabled": true,
    "type": "extract",
    "extractPattern": "regex string",
    "extractVariable": "snake_case_variable"
  },
  "regexScripts": [
    {
      "scriptName": "Human-readable name",
      "findRegex": "/pattern/g",
      "replaceString": "<details>...</details>",
      "placement": [2],
      "markdownOnly": true,
      "promptOnly": false,
      "runOnEdit": true,
      "disabled": false
    }
  ]
}

Requirements:
- This is a tracker, so phase should usually be "pre".
- The prompt must instruct the model to use the exact tracker format and obey the supplied rules.
- extractPattern must capture the full tracker block, including body lines and closing tags when present.
- extractVariable must be snake_case and must not include the "agent_" prefix.
- regexScripts must be valid ST-style regex scripts for AI output rendering.
- Use inline HTML/CSS only in replaceString. No script tags.
- Preserve the tracker's body text in the rendered output; do not drop note/detail lines.
- Keep the rendered output compact, readable, and visually consistent with SillyBunny's existing tracker cards.
- Prefer one regex script unless multiple variants are genuinely needed.
- Escape backslashes correctly for JSON.`;

    const userPrompt = [
        `Agent name: ${agentName || '(blank)'}`,
        `Description: ${description || '(blank)'}`,
        '',
        'Tracker format example:',
        formatText,
        '',
        'Additional behavior rules:',
        rulesText || '(none)',
        '',
        'HTML/style notes:',
        styleNotes || '(none)',
        '',
        'Existing prompt text to preserve if useful:',
        currentPrompt || '(none)',
    ].join('\n');

    try {
        const rawResponse = await refineLLMCall(systemPrompt, userPrompt, connectionProfile);
        const parsedResponse = JSON.parse(extractJsonObject(rawResponse));
        return normalizeTrackerKitResponse(parsedResponse, fallbackKit);
    } catch (error) {
        console.warn('[InChatAgents] Custom tracker generation fell back to local scaffold.', error);
        return fallbackKit;
    }
}

/**
 * Opens a refinement mode picker and calls the LLM to refine the given prompt.
 * @param {string} currentPrompt - The current agent prompt text
 * @param {string} category - Agent category
 * @param {string} phase - Agent phase
 * @returns {Promise<string|null>} - Refined prompt or null if cancelled
 */
async function refinePromptWithAI(currentPrompt, category, phase, connectionProfile = '') {
    if (!currentPrompt.trim()) {
        toastr.warning('Write a prompt first before refining.');
        return null;
    }

    const modes = [
        { label: 'Improve clarity', instruction: 'Make this prompt clearer and more effective for an LLM. Preserve the original intent.' },
        { label: 'Make concise', instruction: 'Shorten this prompt while preserving all meaning. Every token counts in context.' },
        { label: 'Add specificity', instruction: 'Add more detailed, specific instructions to make this prompt more effective.' },
        { label: 'Fix anti-slop', instruction: 'Add guards against common AI writing tics (purple prose, cliches, repetitive body language) while preserving the original prompt.' },
    ];

    const modeHtml = modes.map((m, i) =>
        `<label class="checkbox_label"><input type="radio" name="ica-refine-mode" value="${i}" ${i === 0 ? 'checked' : ''} /><span>${m.label}</span></label>`,
    ).join('');

    const html = $(`
        <div>
            <p>Choose how to refine this prompt:</p>
            ${modeHtml}
            <label class="checkbox_label"><input type="radio" name="ica-refine-mode" value="custom" /><span>Custom instruction:</span></label>
            <input type="text" id="ica--refine-custom" class="text_pole" placeholder="Your custom refinement instruction..." />
        </div>
    `);

    const result = await new Popup(html, POPUP_TYPE.CONFIRM, '', {
        okButton: 'Refine',
        cancelButton: 'Cancel',
    }).show();

    if (result !== POPUP_RESULT.AFFIRMATIVE) return null;

    const selectedVal = html.find('input[name="ica-refine-mode"]:checked').val();
    let instruction;
    if (selectedVal === 'custom') {
        instruction = html.find('#ica--refine-custom').val()?.toString().trim();
        if (!instruction) {
            toastr.warning('Please enter a custom instruction.');
            return null;
        }
    } else {
        instruction = modes[Number(selectedVal)].instruction;
    }

    const systemPrompt = 'You are a prompt engineering assistant for a roleplay chat application. The user has written a prompt module that will be injected into an LLM\'s context during roleplay generation. Improve it based on their request. Use {{char}} and {{user}} macros where appropriate. Be concise -- every token counts. Output ONLY the improved prompt text, nothing else.';

    const userText = `Here is my current prompt:\n---\n${currentPrompt}\n---\nCategory: ${category}\nPhase: ${phase}\n\nRequest: ${instruction}`;

    toastr.info('Refining prompt...', '', { timeOut: 0, extendedTimeOut: 0 });

    try {
        const refined = await refineLLMCall(systemPrompt, userText, connectionProfile);
        toastr.clear();

        if (!refined || !refined.trim()) {
            toastr.error('AI returned an empty response.');
            return null;
        }

        // Show diff popup
        const diffHtml = $(`
            <div>
                <h4>Original</h4>
                <pre style="white-space:pre-wrap;max-height:200px;overflow-y:auto;padding:8px;border:1px solid var(--SmartThemeBorderColor);border-radius:4px;">${escapeHtml(currentPrompt)}</pre>
                <h4>Refined</h4>
                <pre style="white-space:pre-wrap;max-height:200px;overflow-y:auto;padding:8px;border:1px solid var(--SmartThemeBorderColor);border-radius:4px;">${escapeHtml(refined.trim())}</pre>
            </div>
        `);

        const acceptResult = await new Popup(diffHtml, POPUP_TYPE.CONFIRM, '', {
            okButton: 'Accept',
            cancelButton: 'Discard',
            wide: true,
        }).show();

        if (acceptResult === POPUP_RESULT.AFFIRMATIVE) {
            return refined.trim();
        }
        return null;
    } catch (e) {
        toastr.clear();
        toastr.error('Refinement failed: ' + e.message);
        return null;
    }
}

// ===================== Initialization =====================

(async function () {
    const settingsHtml = await renderExtensionTemplateAsync(MODULE_NAME, 'settings');
    if (!settingsHtml) {
        console.warn('[InChatAgents] Could not load the settings template.');
        return;
    }

    $('#in_chat_agents_container').append(settingsHtml);

    const savedState = extension_settings.inChatAgents;
    const legacyGroups = Array.isArray(savedState?.groups)
        ? savedState.groups.map(group => structuredClone(group))
        : [];
    if (savedState && typeof savedState === 'object') {
        if (savedState.globalSettings && typeof savedState.globalSettings === 'object') {
            setGlobalSettings(savedState.globalSettings);
        }
        restoreAutoSeededTemplateIds(savedState);
        if (savedState.dismissedTemplatesCallout === true) {
            $('.ica--templates-callout').hide();
        }
    }

    const initResults = await Promise.allSettled([
        loadTemplates(),
        loadCustomGroupsFromServer(),
        (async () => {
            const settingsResp = await fetch('/api/settings/get', {
                method: 'POST',
                headers: getRequestHeaders(),
                body: JSON.stringify({}),
            });

            if (!settingsResp.ok) {
                return;
            }

            const settings = await settingsResp.json();
            if (settings.inChatAgents) {
                loadAgents(settings.inChatAgents);
            }
        })(),
    ]);

    for (const result of initResults) {
        if (result.status === 'rejected') {
            console.warn('[InChatAgents] Failed during initialization:', result.reason);
        }
    }

    if (legacyGroups.length > 0) {
        try {
            const migratedCount = await migrateLegacyGroups(legacyGroups);
            if (migratedCount > 0) {
                toastr.success(`Migrated ${migratedCount} custom group(s) to backend storage.`);
            }
        } catch (error) {
            console.warn('[InChatAgents] Failed to migrate legacy groups:', error);
        }
    }

    if (savedState && Object.hasOwn(savedState, 'groups')) {
        persistExtensionState();
    }

    await ensureDefaultBundledAgents();
    await migrateBundledRegexScriptsToSavedAgents();
    const migratedCyoaChoiceRegexCount = await migrateCyoaChoiceRegexCleanupToSavedAgents();
    if (migratedCyoaChoiceRegexCount > 0) {
        toastr.success(`Updated ${migratedCyoaChoiceRegexCount} bundled CYOA choice regex script${migratedCyoaChoiceRegexCount !== 1 ? 's' : ''}.`);
    }

    const migratedTemplateMetadataCount = await migrateBundledTemplateMetadataToSavedAgents();
    if (migratedTemplateMetadataCount > 0) {
        toastr.success(`Updated ${migratedTemplateMetadataCount} bundled agent credit${migratedTemplateMetadataCount !== 1 ? 's' : ''}.`);
    }

    const migratedTrackerPromptPassCount = await migrateBundledTrackerPromptPassesToSavedAgents();
    if (migratedTrackerPromptPassCount > 0) {
        toastr.success(`Updated ${migratedTrackerPromptPassCount} bundled tracker agent(s) to pre-generation defaults.`);
    }

    const migratedRegexPostDefaultsCount = await migrateBundledRegexPostDefaultsToSavedAgents();
    if (migratedRegexPostDefaultsCount > 0) {
        toastr.success(`Updated ${migratedRegexPostDefaultsCount} bundled regex agent(s) to post-generation defaults.`);
    }

    if (isPathfinderSubmoduleEnabled()) {
        const migratedPathfinderToolCount = await migratePathfinderAgentToolsFromTemplate();
        if (migratedPathfinderToolCount > 0) {
            toastr.success(`Updated ${migratedPathfinderToolCount} Pathfinder agent(s) with default tool toggles.`);
        }
    }

    const migratedPromptTransformImpersonateCount = await migrateBundledPromptTransformImpersonateToSavedAgents();
    if (migratedPromptTransformImpersonateCount > 0) {
        toastr.success(`Updated ${migratedPromptTransformImpersonateCount} bundled prompt pass agent(s) for impersonations.`);
    }

    const migratedPromptTransformTokenCount = await migrateLegacyPromptTransformMaxTokens();
    if (migratedPromptTransformTokenCount > 0) {
        toastr.success(`Updated ${migratedPromptTransformTokenCount} agent(s) to the new 8192 prompt transform token default.`);
    }

    const removedBundledAgentCount = await purgeRemovedBundledAgents();
    if (removedBundledAgentCount > 0) {
        toastr.success(`Removed ${removedBundledAgentCount} bundled agent(s) from the default catalog.`);
    }

    const removedDuplicateCount = await removeRedundantBundledAgentDuplicates();
    if (removedDuplicateCount > 0) {
        toastr.success(`Removed ${removedDuplicateCount} redundant bundled agent duplicate(s).`);
    }

    const migratedTrackerCompanionCount = await migrateTrackerCompanionsToAutoLoop();
    if (migratedTrackerCompanionCount > 0) {
        toastr.success(`${migratedTrackerCompanionCount} tracker companion(s) now run automatically with their own prompt, feed state back into context, and show in the Tracker panel.`);
    }

    if (getGlobalSettings().separateRecentChats) {
        const initializedScopedAgentState = initializeScopedAgentEnableState();
        const reconciledScopedAgentState = reconcileScopedEnabledAgentIdsFromLegacyFlags();
        if (initializedScopedAgentState || reconciledScopedAgentState) {
            persistExtensionState();
        }
    }

    // Initialize the pipeline runner
    try {
        initCompanionRunner();
        initAgentRunner();
    } catch (err) {
        console.error('[InChatAgents] Agent runner initialization failed:', err);
    }

    if (isPathfinderSubmoduleEnabled()) {
        try {
            initPathfinder(getContext());
        } catch (err) {
            console.warn('[InChatAgents] Pathfinder initialization failed:', err);
        }
    }

    // Sync any existing tool agents' tools with ToolManager
    try {
        syncToolAgentRegistrations();
    } catch (err) {
        console.warn('[InChatAgents] Tool agent sync failed:', err);
    }

    // Render the panel
    renderAgentList();
    initCompanionCardUi();
    configureCompanionDashboard({
        openEditor: agentId => openEditor(agentId),
        openCompanionDraftEditor: ({ autoOpenCompanionMaker = false } = {}) => openEditor(null, { draft: buildCompanionDraftAgent(), autoOpenCompanionMaker }),
        toggleAgentEnabled,
        convertAgent: applyAgentExecutionConversion,
        getVisibleAgents: getVisibleInChatAgents,
        getLastAssistantMessageIndex,
    });
    initCompanionWandMenuItem();
    configureCompanionPanel({
        openEditor: agentId => openEditor(agentId),
    });
    initCompanionPanel();
    schedulePathfinderExtensionsMount();

    // Wire up toolbar
    $('#ica--globalEnabled').on('click', () => {
        const enabled = !areAgentsGloballyEnabled();
        setGlobalSettings({ enabled });
        persistExtensionState();
        updateGlobalAgentToggle();
        syncToolAgentRegistrations();
        updateFixTrackersButtonVisibility();
        updateCompanionButtonVisibility();
        toastr.info(enabled ? 'In-Chat Agents enabled.' : 'In-Chat Agents disabled.');
    });
    $('#ica--addAgent').on('click', () => openEditor());
    $('#ica--companionsDashboard').on('click', () => openCompanionDashboard());
    $('#ica--convertAllTrackers').on('click', async () => {
        const inlineTrackers = getAgents().filter(agent => agent.category === 'tracker' && !isCompanionAgent(agent) && !isPathfinderAgent(agent));
        if (inlineTrackers.length === 0) {
            toastr.info('Every tracker already runs as a companion.');
            return;
        }

        const result = await new Popup(`Convert ${inlineTrackers.length} tracker agent(s) to companion execution? They will run automatically on their own model and show in the Tracker panel.`, POPUP_TYPE.CONFIRM).show();
        if (result !== POPUP_RESULT.AFFIRMATIVE) {
            return;
        }

        let converted = 0;
        for (const agent of inlineTrackers) {
            if (!convertAgentExecution(agent, 'companion')) {
                continue;
            }
            lockBundledAgentCustomization(agent);
            await saveAgent(agent);
            refreshRegexSnapshotsForAgent(agent.id);
            converted++;
        }

        syncToolAgentRegistrations();
        renderAgentList();
        toastr.success(`Converted ${converted} tracker(s) to companions — state shows in the Tracker panel.`);
    });
    $('#ica--importAgent').on('click', () => $('#ica--importFile').trigger('click'));
    $('#ica--importFile').on('change', handleImport);
    $('#ica--exportAll').on('click', handleExportAll);
    $('#ica--templates').on('click', openTemplateBrowser);
    $('#ica--fixTrackers').on('click', async function () {
        if (showFixTrackersUnavailableToast()) {
            updateFixTrackersButtonVisibility();
            return;
        }
        const messageIndex = getLastAssistantMessageIndex();
        if (messageIndex < 0) {
            toastr.warning('No assistant reply yet to fix trackers on.');
            return;
        }
        await runTrackerFixFromButton(messageIndex, this);
    });
    $('#ica--templatesCallout').on('click', openTemplateBrowser);
    $('#ica--templatesCalloutDismiss').on('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        $('.ica--templates-callout').hide();
        extension_settings.inChatAgents = {
            ...(extension_settings.inChatAgents ?? {}),
            dismissedTemplatesCallout: true,
        };
        saveSettingsDebounced();
    });
    $('#ica--cancelGeneration').on('click', () => {
        cancelAgentGeneration();
        updateCancelGenerationButton();
    });
    $('#ica--selectMode').on('click', () => {
        selectModeActive = !selectModeActive;
        if (!selectModeActive) {
            selectedAgentIds.clear();
        }
        updateBulkBar();
        renderAgentList();
    });
    $('#ica--bulkCancel').on('click', exitSelectMode);
    $('#ica--bulkSelectAll').on('click', () => {
        for (const agent of getVisibleInChatAgents()) {
            selectedAgentIds.add(agent.id);
        }
        updateBulkBar();
        renderAgentList();
    });
    $('#ica--bulkEnable').on('click', async () => {
        let changed = false;
        for (const id of selectedAgentIds) {
            const agent = getAgentById(id);
            if (agent && !isAgentEnabledForCurrentScope(agent)) {
                setAgentEnabledForCurrentScope(agent, true);
                await saveAgent(agent);
                changed = true;
            }
        }
        if (changed) {
            persistExtensionState();
            syncToolAgentRegistrations();
        }
        exitSelectMode();
    });
    $('#ica--bulkDisable').on('click', async () => {
        let changed = false;
        for (const id of selectedAgentIds) {
            const agent = getAgentById(id);
            if (agent && isAgentEnabledForCurrentScope(agent)) {
                setAgentEnabledForCurrentScope(agent, false);
                await saveAgent(agent);
                changed = true;
            }
        }
        if (changed) {
            persistExtensionState();
            syncToolAgentRegistrations();
        }
        exitSelectMode();
    });
    $('#ica--bulkDelete').on('click', async () => {
        const count = selectedAgentIds.size;
        if (count === 0) return;
        const result = await new Popup(`Delete ${count} selected agent${count !== 1 ? 's' : ''}?`, POPUP_TYPE.CONFIRM).show();
        if (result === POPUP_RESULT.AFFIRMATIVE) {
            for (const id of [...selectedAgentIds]) {
                await deleteAgent(id);
            }
            exitSelectMode();
        }
    });
    $('#ica--bulkRoleSystem').on('click', async () => {
        if (selectedAgentIds.size === 0) return;
        for (const id of selectedAgentIds) {
            const agent = getAgentById(id);
            if (agent && agent.injection.role !== 0) {
                agent.injection.role = 0;
                lockBundledAgentCustomization(agent);
                await saveAgent(agent);
            }
        }
        toastr.success(`Set ${selectedAgentIds.size} agent(s) to System role.`);
        exitSelectMode();
    });
    $('#ica--bulkRoleUser').on('click', async () => {
        if (selectedAgentIds.size === 0) return;
        for (const id of selectedAgentIds) {
            const agent = getAgentById(id);
            if (agent && agent.injection.role !== 1) {
                agent.injection.role = 1;
                lockBundledAgentCustomization(agent);
                await saveAgent(agent);
            }
        }
        toastr.success(`Set ${selectedAgentIds.size} agent(s) to User role.`);
        exitSelectMode();
    });
    $('#ica--bulkConvertCompanion').on('click', async () => {
        if (selectedAgentIds.size === 0) return;
        let converted = 0;
        for (const id of selectedAgentIds) {
            const agent = getAgentById(id);
            if (!agent || isPathfinderAgent(agent) || !convertAgentExecution(agent, 'companion')) {
                continue;
            }
            lockBundledAgentCustomization(agent);
            await saveAgent(agent);
            refreshRegexSnapshotsForAgent(agent.id);
            converted++;
        }
        if (converted > 0) {
            syncToolAgentRegistrations();
            toastr.success(`Converted ${converted} agent(s) to companion execution.`);
        } else {
            toastr.info('No selected agents could be converted to companions.');
        }
        exitSelectMode();
    });
    $('#ica--bulkEditProps').on('click', () => {
        if (selectedAgentIds.size === 0) return;
        openBulkEditPopup();
    });
    $('#ica--bulkEditApply').on('click', async () => {
        await applyBulkEdit();
    });
    $('#ica--bulkEditCancel').on('click', () => {
        closeBulkEditPopup();
    });

    // Wire up filter
    $('#ica--agentTabs').on('click', '.ica--agent-tab', function () {
        setActiveAgentListTab($(this).attr('data-tab') || 'all');
        renderAgentList();
    });
    $('#ica--search').on('input', renderAgentList);
    $('#ica--categoryFilter').on('change', renderAgentList);

    // Wire up connection profile dropdown
    populateProfileDropdown();
    populateGlobalNotificationToggle();
    populateGlobalExecutionModeDropdown();
    populateGlobalHelperPrefillField();
    $('#ica--connectionProfile').on('change', function () {
        setGlobalSettings({ connectionProfile: this.value });
        persistExtensionState();
        renderAgentList();
    });
    $('#ica--companionConnectionProfile').on('change', function () {
        setGlobalSettings({ companionConnectionProfile: this.value });
        persistExtensionState();
        renderAgentList();
    });
    $('#ica--separateRecentChats').on('change', function () {
        const separated = $(this).prop('checked');
        setGlobalSettings({ separateRecentChats: separated });
        if (separated) {
            initializeScopedAgentEnableState();
            reconcileScopedEnabledAgentIdsFromLegacyFlags();
        }
        persistExtensionState();
        renderAgentList();
        syncToolAgentRegistrations();
        toastr.info(separated
            ? `Agent toggles are now scoped to ${getAgentChatScopeLabel().toLowerCase()}. Switch chat types to configure the other scope.`
            : 'Agent toggles are shared across Individual and Group chats again.');
    });
    $('#ica--promptTransformShowNotifications').on('change', function () {
        setGlobalSettings({ promptTransformShowNotifications: $(this).prop('checked') });
        persistExtensionState();
    });
    $('#ica--pathfinderSubmoduleEnabled').on('change', async function () {
        const enabled = $(this).prop('checked');
        setPathfinderSubmoduleEnabled(enabled);
        persistExtensionState();
        populatePathfinderSubmoduleToggle();

        if (enabled) {
            try {
                const migratedPathfinderToolCount = await migratePathfinderAgentToolsFromTemplate();
                if (migratedPathfinderToolCount > 0) {
                    toastr.success(`Updated ${migratedPathfinderToolCount} Pathfinder agent(s) with default tool toggles.`);
                }
                initPathfinder(getContext());
                schedulePathfinderExtensionsMount();
                syncToolAgentRegistrations();
                toastr.info('Pathfinder submodule enabled.');
            } catch (err) {
                console.warn('[InChatAgents] Failed to enable Pathfinder submodule:', err);
                toastr.error('Could not enable Pathfinder.');
            }
            return;
        }

        teardownPathfinder();
        deactivatePathfinderRuntime();
        removePathfinderExtensionsHost();
        toastr.info('Pathfinder submodule disabled.');
    });
    $('#ica--appendAgentsExecutionMode').on('change', function () {
        setGlobalSettings({ appendAgentsExecutionMode: this.value });
        persistExtensionState();
    });
    $('#ica--companionExecutionMode').on('change', function () {
        setGlobalSettings({ companionExecutionMode: this.value });
        persistExtensionState();
    });
    $('#ica--companionConcurrent').on('change', function () {
        setGlobalSettings({ companionConcurrentWithPostGen: $(this).prop('checked') });
        persistExtensionState();
    });
    $('#ica--helperPrefillMessages').on('input', function () {
        setGlobalSettings({ helperPrefillMessages: this.value });
        persistExtensionState();
    });
    $('#ica--resetDefaults').on('click', async () => {
        const agents = getVisibleInChatAgents();
        const visibleDefaultBundledTemplates = getDefaultBundledTemplates()
            .filter(template => !HIDDEN_TEMPLATE_BROWSER_IDS.has(String(template?.id ?? '').trim()));
        const missingDefaultBundledTemplates = visibleDefaultBundledTemplates
            .filter(template => !hasMatchingAgentSnapshot(buildAgentFromTemplate(template), agents));
        const bundledCount = agents.filter(a => findTemplateForAgent(a)).length + missingDefaultBundledTemplates.length;
        if (bundledCount === 0) {
            toastr.info('No bundled agents found to reset.');
            return;
        }
        const result = await new Popup(
            `Reset ${bundledCount} bundled agent${bundledCount !== 1 ? 's' : ''} to their original template defaults? Custom agents will not be affected. This cannot be undone.`,
            POPUP_TYPE.CONFIRM,
        ).show();
        if (result !== POPUP_RESULT.AFFIRMATIVE) return;
        let resetCount = 0;
        for (const agent of agents) {
            const template = findTemplateForAgent(agent);
            if (!template) continue;
            const fresh = mergeTemplateDefaults(template);
            agent.name = fresh.name ?? agent.name;
            agent.description = fresh.description ?? agent.description;
            agent.icon = fresh.icon ?? agent.icon;
            agent.category = fresh.category ?? agent.category;
            agent.tags = fresh.tags ?? agent.tags;
            agent.author = fresh.author ?? agent.author;
            agent.prompt = fresh.prompt ?? agent.prompt;
            agent.phase = fresh.phase ?? 'pre';
            agent.phaseLocked = false;
            agent.injection = { ...agent.injection, ...fresh.injection };
            agent.postProcess = { ...agent.postProcess, ...fresh.postProcess };
            agent.regexScripts = Array.isArray(fresh.regexScripts) ? structuredClone(fresh.regexScripts) : agent.regexScripts;
            agent.sourceTemplateId = template.id;
            await saveAgent(agent);
            resetCount++;
        }
        for (const template of missingDefaultBundledTemplates) {
            const freshAgent = buildAgentFromTemplate(template);
            await saveAgent(freshAgent);
            autoSeededTemplateIds.add(String(template.id ?? '').trim());
            resetCount++;
        }
        if (missingDefaultBundledTemplates.length > 0) {
            persistExtensionState();
        }
        toastr.success(`Reset ${resetCount} bundled agent${resetCount !== 1 ? 's' : ''} to defaults.`);
        renderAgentList();
    });
    // Refresh profiles when chat changes (profiles may have been added/removed)
    const refreshProfileUi = () => {
        refreshConnectionProfileUi();
        populateGlobalNotificationToggle();
        populateGlobalExecutionModeDropdown();
    };

    eventSource.on(event_types.CHAT_CHANGED, refreshProfileUi);

    const connectionProfileEvents = [
        event_types.CONNECTION_PROFILE_LOADED,
        event_types.CONNECTION_PROFILE_CREATED,
        event_types.CONNECTION_PROFILE_UPDATED,
        event_types.CONNECTION_PROFILE_DELETED,
    ].filter(Boolean);

    for (const eventName of connectionProfileEvents) {
        eventSource.on(eventName, refreshProfileUi);
    }

    onAgentGenerationStateChanged(refreshGenerationUi);
    $(document).on('click', '#mes_stop', () => {
        if (!isAgentGenerationActive()) {
            return;
        }

        cancelAgentGeneration();
        refreshGenerationUi();
    });
    for (const eventName of [
        event_types.GENERATION_STARTED,
        event_types.GENERATION_ENDED,
        event_types.GENERATION_STOPPED,
    ]) {
        eventSource.on(eventName, () => refreshGenerationUi());
    }

    // Listen for Prompt Manager "Send to Agents" events
    window.addEventListener('PromptManagerSendToAgents', async (event) => {
        const pm = event.detail.prompt;
        if (!pm) return;

        const agent = createDefaultAgent();
        agent.name = pm.name || 'Imported Prompt';
        agent.prompt = pm.content || '';
        agent.injection.role = pm.role === 'user' ? 1 : pm.role === 'assistant' ? 2 : 0;
        agent.injection.position = pm.injection_position === 1 ? 1 : 0;
        agent.injection.depth = pm.injection_depth || 0;
        agent.injection.order = pm.injection_order || 100;
        agent.enabled = false;
        agent.category = 'custom';

        // Map injection_trigger to generationTypes
        if (Array.isArray(pm.injection_trigger) && pm.injection_trigger.length > 0) {
            agent.conditions.generationTypes = pm.injection_trigger.filter(t =>
                ['normal', 'continue', 'impersonate', 'quiet'].includes(t),
            );
        }

        await saveAgent(agent);
        renderAgentList();
        toastr.success(`Created agent "${agent.name}" from prompt.`);
    });
    // Sync tool agents when API settings change
    const apiSettingsEvents = [
        event_types.MAIN_API_CHANGED,
        event_types.CHATCOMPLETION_SOURCE_CHANGED,
        event_types.CHATCOMPLETION_MODEL_CHANGED,
        event_types.OAI_PRESET_CHANGED_AFTER,
        event_types.SETTINGS_UPDATED,
    ].filter(Boolean);

    for (const eventName of apiSettingsEvents) {
        eventSource.on(eventName, syncToolAgentRegistrations);
    }

    // Sync tool agents when the agents panel is opened
    document.addEventListener('sb:shell-tab-activated', (event) => {
        if (event.detail?.tabId === 'agents') {
            syncToolAgentRegistrations();
        }
    });

    $(document).on('click', '.agent-transform-badge, .mes_view_agent_changes', async function () {
        const mesId = $(this).closest('.mes').attr('mesid');
        const messageIndex = Number(mesId);
        await openPromptTransformHistoryPopup(messageIndex);
    });

    $(document).on('click', '.mes_fix_trackers', async function () {
        if (showFixTrackersUnavailableToast()) {
            updateFixTrackersButtonVisibility();
            return;
        }
        const mesId = $(this).closest('.mes').attr('mesid');
        const messageIndex = Number(mesId);
        if (isNaN(messageIndex) || messageIndex < 0) {
            toastr.warning('Invalid message.');
            return;
        }
        await runTrackerFixFromButton(messageIndex, this);
    });

    for (const eventName of [
        event_types.CHAT_CHANGED,
        event_types.USER_MESSAGE_RENDERED,
        event_types.CHARACTER_MESSAGE_RENDERED,
    ].filter(Boolean)) {
        eventSource.on(eventName, () => {
            updateFixTrackersButtonVisibility();
            updateCompanionButtonVisibility();
        });
    }
    updateFixTrackersButtonVisibility();
    updateCompanionButtonVisibility();
})();
