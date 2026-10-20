import { DiffMatchPatch } from '../../../lib.js';
import { extension_settings, renderExtensionTemplateAsync, getContext } from '../../extensions.js';
import { Popup, POPUP_TYPE, POPUP_RESULT } from '../../popup.js';
import { download, escapeHtml, escapeRegex } from '../../utils.js';
import { activateSendButtons, CLIENT_VERSION, chat, deactivateSendButtons, getCurrentChatId, getRequestHeaders, generateQuietPrompt, is_send_press, normalizeContentText, saveChatDebounced, saveSettingsDebounced, substituteParams } from '../../../script.js';
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
    MAX_AGENT_MAX_TOKENS,
    getGlobalSettings,
    initializeScopedAgentEnableState,
    isAgentEnabledForCurrentScope,
    LEGACY_AGENT_MAX_TOKENS,
    getAgentChatScopeLabel,
    getPromptTransformMode,
    isTrackerFixAgent,
    isPathfinderSubmoduleEnabled,
    findTemplateForAgentSnapshot,
    getBundledAgentLatestTemplatePlan,
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
    applyCompanionContextAccessDefaults,
    applyCompanionPanelDisplayDefault,
    applyTrackerCompanionAutoLoopDefaults,
    convertAgentExecution,
    isCompanionAgent,
    isToolAgent,
    saveGroup,
    deleteGroup,
    createDefaultGroup,
    reorderAgentsIntoOrderSlots,
} from './agent-store.js';
import {
    cancelAgentGeneration,
    buildPromptDynamicMacros,
    deactivatePathfinderRuntime,
    initAgentRunner,
    isAgentGenerationActive,
    onAgentGenerationStateChanged,
    getPreGenerationInterceptHistoryForMessage,
    getAgentGenerationCancelRevision,
    getPromptTransformHistoryForMessage,
    refreshRegexSnapshotsForAgent,
    runAgentOnTarget,
    runTrackerFixOnMessage,
    syncToolAgentRegistrations,
    undoPromptTransform,
    redoPromptTransform,
} from './agent-runner.js';
import {
    AGENT_REGEX_PLACEMENT,
    AGENT_REGEX_SUBSTITUTE,
    applyRegexScriptList,
    createDefaultRegexScript,
    normalizeRegexScript,
} from './regex-scripts.js';
import { initPathfinder, teardownPathfinder } from './pathfinder-init.js';
import { openPathfinderSettings, closePathfinderSettings, canClosePathfinderSettings, cancelPathfinderSummary, refreshPathfinderSettings, isPathfinderAgent } from './pathfinder-settings-ui.js';
import { getPathfinderToolDefinitions } from './pathfinder/tool-definitions.js';
import { buildFallbackPromptText, extractProfileResponseText } from './llm-utils.js';
import { appendHelperPrefillMessages } from '../helper-prefill.js';
import {
    getConnectionManagerRequestService,
    populateConnectionProfileSelect,
} from './profile-utils.js';
import { collectRecentCompanionResults, getCompanionResults, initCompanionRunner, getLatestValidCompanionMessageIndex, runTrackerCompanionsOnMessage, runCompanionsOnMessage, COMPANION_RESULTS_UPDATED_EVENT, syncCompanionChatHistoryConfig } from './companion/companion-runner.js';
import { resolveCompanionContentMacros } from './companion/companion-macros.js';
import { createAgentSettingsControls } from './settings-controls.js';
import { getCompanionReferenceIds } from './companion/companion-shared.js';
import { initCompanionCardUi, updateCompanionButtonVisibility } from './companion/companion-ui.js';
import {
    configureCompanionDashboard,
    initCompanionWandMenuItem,
} from './companion/companion-dashboard.js';
import {
    configureCompanionPanel,
    initCompanionPanel,
    refreshCompanionPanel,
    updateCompanionPanelHandleVisibility,
    isConversationModeActive,
    captureCompanionPanelOrigin,
    restoreCompanionPanelOrigin,
    openCompanionPanel,
} from './companion/companion-panel.js';
import { t } from '../../i18n.js';
import { confirmDestructiveAction } from '../../sillybunny-delete-confirm.js';
import { buildSettingsPageModel } from './ui/settings-page-controller.js';
import {
    buildAgentFromTemplate as buildCatalogueAgentFromTemplate,
    buildUpdatedAgentFromTemplate as buildCatalogueUpdatedAgentFromTemplate,
    ensureDefaultBundledAgents as ensureCatalogueDefaultBundledAgents,
    findSourceTemplateForAgent as findCatalogueSourceTemplateForAgent,
    getAgentOrderValue,
    getAgentVersionValue,
    getTemplateVersionValue,
    getAgentsWithTemplateUpdates as getCatalogueAgentsWithTemplateUpdates,
    getDefaultBundledTemplates as getCatalogueDefaultBundledTemplates,
    hasMatchingAgentSnapshot as hasCatalogueMatchingAgentSnapshot,
    HIDDEN_TEMPLATE_BROWSER_IDS,
    isBundledRegexPostDefaultTemplate,
    isRemovedBundledAgent,
    mergeTemplateDefaults as mergeCatalogueTemplateDefaults,
    REMOVED_BUNDLED_TEMPLATE_IDS,
    resetBundledAgents,
    shouldUseTrackerPromptPassDefaults,
    listAgentEntries,
    materialise,
    duplicate,
    restoreDefault,
    turnOnGroup,
} from './catalogue.js';

const MODULE_NAME = 'in-chat-agents';
const PATHFINDER_EXTENSIONS_HOST_ID = 'extension_settings_in_chat_agents_pathfinder';

/** Built-in templates loaded from JSON files. */
let templates = [];
let templateRegexBundles = {};
let autoSeededTemplateIds = new Set();

let pathfinderExtensionsMountPromise = null;
let pathfinderExtensionsMountRevision = 0;
let fixTrackersRunning = false;
let refreshAgentsPanels = () => {};

const REMOVED_BUNDLED_GROUP_IDS = new Set([
    'grp-pura-director',
]);

const CHATROOM_TEMPLATE_ID = 'tpl-chatroom-companion';
const DIRECTORS_COMMENTARY_TEMPLATE_ID = 'tpl-directors-commentary-companion';
const PLOT_COMPASS_TEMPLATE_ID = 'tpl-plot-compass-companion';
const LEVEL_UP_COMPANION_TEMPLATE_ID = 'tpl-level-up-companion';
const USER_BASED_STATS_TEMPLATE_ID = 'tpl-user-based-stats-generator';
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
const LEVEL_UP_STATS_CONTEXT_LINKS_VERSION = 2;
const CHATROOM_STYLE_VALUES = Object.freeze([
    'mixed',
    'in-world',
    'discord/twitch',
    'twitter/x',
    'reddit',
    'ao3/wattpad',
    'newsroom',
    'thread-board/4chan',
    'infomercial',
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

function normalizeCompanionBatchAgentIds(value = []) {
    const rawValues = Array.isArray(value)
        ? value
        : String(value ?? '').split(/[\n,]/);
    const seenIds = new Set();
    const ids = [];

    for (const rawValue of rawValues) {
        const id = String(rawValue ?? '').trim().slice(0, 128);
        const key = id.toLowerCase();
        if (!id || seenIds.has(key)) continue;

        seenIds.add(key);
        ids.push(id);
    }

    return ids;
}

function getCompanionAgentOptionLabel(agent) {
    const name = String(agent?.name ?? '').trim() || agent?.id || 'Companion';
    return `${name} (Order ${getAgentOrderValue(agent)})`;
}

// SillyBunny: display legacy template references without silently rewriting their stored IDs.
function getAgentEditorCompanionOptions(id, enabledOnly = false, selectedIds = []) {
    return getAgents()
        .filter(candidate => candidate.id !== id && isCompanionAgent(candidate))
        .filter(candidate => !enabledOnly || isAgentEnabledForCurrentScope(candidate))
        .flatMap(candidate => {
            const references = new Set(getCompanionReferenceIds(candidate).map(value => value.toLowerCase()));
            const selected = selectedIds.filter(value => references.has(value.toLowerCase()));
            return (selected.length ? selected : [candidate.id]).map(value => [value, getCompanionAgentOptionLabel(candidate)]);
        });
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

// SillyBunny: the detail uses the same library migrations and parsers as the retained editor.
function agentEditorTemplateSettings(agent) {
    const settings = { ...agent.settings };
    const activeName = (items, name) => items.find(item => item.name.toLowerCase() === name.toLowerCase())?.name ?? items[0]?.name ?? '';
    if (agent.sourceTemplateId === CHATROOM_TEMPLATE_ID) {
        settings.chatroomStyle = normalizeChatroomStyle(settings.chatroomStyle);
        settings.chatroomCustomStyles = getChatroomCustomStylesSetting(settings);
        settings.chatroomCustomStyleName = activeName(
            parseChatroomCustomStyles(settings.chatroomCustomStyles),
            normalizeChatroomCustomStyleName(settings.chatroomCustomStyleName),
        );
        settings.chatroomExtraCharacterAvatars = normalizeChatroomExtraCharacterAvatars(settings.chatroomExtraCharacterAvatars);
        delete settings.chatroomCustomStyle;
    } else if (agent.sourceTemplateId === DIRECTORS_COMMENTARY_TEMPLATE_ID) {
        settings.directorCommentaryVoice = normalizeDirectorCommentaryVoice(settings.directorCommentaryVoice);
        settings.directorCommentaryCustomVoices = getDirectorCustomVoicesSetting(settings);
        settings.directorCommentaryCustomVoiceName = activeName(
            parseDirectorCustomVoices(settings.directorCommentaryCustomVoices),
            normalizeDirectorCustomVoiceName(settings.directorCommentaryCustomVoiceName),
        );
        delete settings.directorCommentaryCustomVoice;
    } else if (agent.sourceTemplateId === PLOT_COMPASS_TEMPLATE_ID) {
        settings.plotCompassObjective = String(settings.plotCompassObjective ?? '').trim();
    }
    return settings;
}

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

function getCatalogueContext() {
    return {
        templates,
        regexBundles: templateRegexBundles,
        getAgents,
        saveAgent,
        initializeScopedAgentEnableState,
        setAgentEnabledForCurrentScope,
        persistState: persistExtensionState,
        autoSeededTemplateIds,
        t,
    };
}

function getAgentListEntries() {
    return listAgentEntries({ agents: getAgents(), templates, regexBundles: templateRegexBundles });
}

function currentAgentListEntry(entry) {
    const current = getAgentListEntries().find(value => value.key === entry.key);
    if (!current) throw new Error(`Agent entry no longer exists: ${entry.key}`);
    return current;
}

async function setAgentListEntryEnabled(entry, enabled) {
    entry = currentAgentListEntry(entry);
    if (entry.kind === 'agent-template') {
        if (!enabled) return null;
        const saved = await materialise(entry.template.id, { enable: true }, getCatalogueContext());
        refreshRegexSnapshotsForAgent(saved.id);
        syncToolAgentRegistrations();
        renderAgentList();
        return saved;
    }
    const agent = structuredClone(entry.agent);
    const settings = getGlobalSettings();
    const previousScopeState = {
        enabledAgentIdsByChatType: structuredClone(settings.enabledAgentIdsByChatType),
        scopedEnabledAgentIdsInitialized: settings.scopedEnabledAgentIdsInitialized,
    };
    if (getGlobalSettings().separateRecentChats) initializeScopedAgentEnableState();
    setAgentEnabledForCurrentScope(agent, enabled);
    let saved;
    try {
        saved = await saveAgent(agent);
    } catch (error) {
        Object.assign(settings, previousScopeState);
        throw error;
    }
    persistExtensionState();
    refreshRegexSnapshotsForAgent(saved.id);
    syncToolAgentRegistrations();
    renderAgentList();
    return saved;
}

async function openAgentListEntry(entry) {
    if (!entry) return openEditor();
    entry = currentAgentListEntry(entry);
    if (entry.kind === 'agent') return openEditor(entry.agent.id);
    const defaults = createDefaultAgent();
    const draft = { ...defaults, ...structuredClone(entry.agent) };
    // SillyBunny: catalogue previews are partial; keep the detail's creation boundary complete.
    for (const field of ['injection', 'conditions', 'preProcess', 'postProcess', 'companion', 'settings']) {
        draft[field] = { ...defaults[field], ...draft[field] };
    }
    return openEditor(null, { draft, materialiseTemplateId: entry.template.id });
}

async function performAgentListAction(entry, action) {
    const allowedActions = new Set(['pin', 'unpin', 'preview-prompt', 'preview-feedback', 'export', 'duplicate', 'apply-target', 'apply-last', 'run-last', 'convert-companion', 'convert-inline', 'update', 'restore-default', 'delete']);
    if (!allowedActions.has(action)) throw new Error(`Unknown agent action: ${action}`);
    entry = currentAgentListEntry(entry);
    if (entry.kind === 'agent-template' && ['update', 'restore-default', 'delete'].includes(action)) {
        throw new Error(`Agent action requires a saved entry: ${action}`);
    }
    if (action === 'preview-prompt') return previewPreGenerationPrompt(entry.agent);
    if (action === 'preview-feedback') return previewCompanionFeedbackPrompt(entry.agent);
    if (action === 'export') {
        const data = entry.kind === 'agent' ? exportAgent(entry.agent.id) : entry.agent;
        download(JSON.stringify(data, null, 2), `${entry.agent.name}.json`, 'application/json');
        return;
    }
    if (action === 'duplicate') {
        const saved = await duplicate(entry.key, getCatalogueContext());
        renderAgentList();
        return saved;
    }
    // Q51: target selection must finish before an unused entry becomes a saved, disabled agent.
    let targets;
    if (action === 'apply-target') {
        targets = await pickManualAgentRunTargets(entry.agent);
        if (!targets?.length) return;
    } else if (action === 'apply-last' || action === 'run-last') {
        const messageIndex = getLastAssistantMessageIndex();
        if (messageIndex < 0) {
            toastr.warning('No assistant reply yet to manually apply this agent to.');
            return;
        }
        targets = [{ kind: 'message', messageIndex }];
    }
    let agent = structuredClone(entry.agent);
    if (entry.kind === 'agent-template') {
        const edits = {};
        if (action === 'pin' || action === 'unpin') edits.favorite = action === 'pin';
        if (action === 'convert-companion' || action === 'convert-inline') {
            convertAgentExecution(agent, action === 'convert-companion' ? 'companion' : 'inline');
            lockBundledAgentCustomization(agent);
            Object.assign(edits, agent);
        }
        agent = await materialise(entry.template.id, { edits }, getCatalogueContext());
    } else if (action === 'pin' || action === 'unpin') {
        agent.favorite = action === 'pin';
        agent = await saveAgent(agent);
    } else if (action === 'convert-companion' || action === 'convert-inline') {
        await applyAgentExecutionConversion(agent, action === 'convert-companion' ? 'companion' : 'inline');
    } else if (action === 'update') {
        await updateAgentFromSourceTemplate(agent);
    } else if (action === 'restore-default') {
        agent = await restoreDefault(agent.id, getCatalogueContext());
    } else if (action === 'delete') {
        await deleteAgent(agent.id);
    }
    if (targets) await Promise.all(targets.map(target => runAgentOnTarget(agent.id, target)));
    refreshRegexSnapshotsForAgent(agent.id);
    syncToolAgentRegistrations();
    renderAgentList();
    return action === 'delete' ? null : agent;
}

async function fixTrackersFromList() {
    if (showFixTrackersUnavailableToast()) return;
    const inlineMessageIndex = getLastAssistantMessageIndex();
    const companionMessageIndex = getLatestValidCompanionMessageIndex();
    const messageIndex = Math.max(inlineMessageIndex, companionMessageIndex);
    if (messageIndex < 0) {
        toastr.warning('No assistant reply yet to fix trackers on.');
        return;
    }
    await runTrackerFixFromButton(messageIndex, null, { inlineMessageIndex, companionMessageIndex });
}

async function convertTrackersFromList() {
    const inlineTrackers = getAgents().filter(agent => agent.category === 'tracker' && !isCompanionAgent(agent) && !isPathfinderAgent(agent));
    if (!inlineTrackers.length) {
        toastr.info('Every tracker already runs as a companion.');
        return;
    }
    const result = await new Popup(`Convert ${inlineTrackers.length} tracker agent(s) to companion execution? They will run automatically on their own model and show in the Tracker panel.`, POPUP_TYPE.CONFIRM).show();
    if (result !== POPUP_RESULT.AFFIRMATIVE) return;
    for (const agent of inlineTrackers) {
        if (!convertAgentExecution(agent, 'companion')) continue;
        lockBundledAgentCustomization(agent);
        await saveAgent(agent);
        refreshRegexSnapshotsForAgent(agent.id);
    }
    syncToolAgentRegistrations();
    renderAgentList();
}

async function registerAgentListUi(settingsStore, settingsFields) {
    const ui = await import('./ui/agent-list.js');
    const { objectNavigation } = await import('../../sillybunny-editor/object-navigation.js');
    for (const [kind, captureState, restoreOrigin] of [
        ['companion-panel', captureCompanionPanelOrigin, restoreCompanionPanelOrigin],
    ]) {
        objectNavigation.register(
            kind,
            {
                captureState,
                async open(_target, {
                    restore,
                    isCurrent,
                }) {
                    if (!isCurrent()) return false;
                    await ui.closeAgentDetail();
                    if (restore?.settingsOpen === false && document.documentElement.dataset.sbSettingsOpen === 'true') {
                        document.getElementById('sb-settings-close')?.click();
                        await new Promise(resolve => requestAnimationFrame(resolve));
                    }
                    return restoreOrigin(restore, isCurrent);
                },
            },
        );
    }
    refreshAgentsPanels = ui.refreshAgentsPanels;
    ui.registerAgentsPanelAdapter({
        categories: AGENT_CATEGORIES,
        subcategories: AGENT_SUBCATEGORIES,
        settings: {
            fields: settingsFields,
            controls: new Map(settingsFields.map(field => [field.id, document.getElementById(field.id)])),
            controlStore: settingsStore,
            readSettings: getGlobalSettings,
            applySetting(key, value) {
                const field = buildSettingsPageModel().groups.flatMap(group => group.rows).find(field => field.key === key);
                if (!field) throw new Error(`Unknown Agents setting: ${key}`);
                const input = document.getElementById(field.id);
                if (field.kind === 'switch') input.checked = value;
                else input.value = value;
                input.dispatchEvent(new Event(field.event, { bubbles: true }));
            },
            resetBundledAgents: resetBundledAgentsFromSettings,
        },
        companions: {
            readSnapshot: () => ({ agents: getVisibleInChatAgents(), chat, enabled: areAgentsGloballyEnabled(), conversationMode: isConversationModeActive() }),
            selectors: {
                getResults: getCompanionResults, getCompanionConfig, isCompanionAgent, isToolAgent,
                isAgentEnabledForCurrentScope, getAgentById, resolveContent: resolveCompanionContentMacros,
            },
            subscribeResults(handler) {
                eventSource.on(COMPANION_RESULTS_UPDATED_EVENT, handler);
                return () => eventSource.removeListener(COMPANION_RESULTS_UPDATED_EVENT, handler);
            },
            getLatestMessageIndex: getLatestValidCompanionMessageIndex,
            runAll: runCompanionsOnMessage,
            openEditor: id => openEditor(id, {}, 'companion-dashboard'),
            async openPanel() {
                await ui.closeAgentDetail();
                document.getElementById('sb-settings-close')?.click();
                openCompanionPanel();
            },
            async jumpToMessage(index) {
                await ui.closeAgentDetail();
                document.getElementById('sb-settings-close')?.click();
                const message = document.querySelector(`.mes[mesid="${index}"]`);
                const chatRoot = document.getElementById('chat');
                if (!message || !chatRoot?.contains(message)) {
                    toastr.info('That message is above the rendered window. Scroll up in the chat to load it.');
                    return;
                }
                const chatRect = chatRoot.getBoundingClientRect();
                const rect = message.getBoundingClientRect();
                const top = chatRoot.scrollTop + rect.top - chatRect.top - (chatRect.height - rect.height) / 2;
                chatRoot.scrollTo({
                    top: Math.min(Math.max(top, 0), Math.max(0, chatRoot.scrollHeight - chatRoot.clientHeight)),
                    behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth',
                });
            },
            notify(code) {
                if (code === 'no-message') toastr.warning('No message yet to run companions on.');
                else if (code === 'no-companions-ran') toastr.info('No companion agents ran for this message.');
            },
        },
        groups: {
            getGroups, deleteGroup, createGroup: createCustomGroup,
            async turnOnGroup(group) {
                const result = await turnOnGroup(group, getCatalogueContext());
                syncToolAgentRegistrations();
                renderAgentList();
                return result;
            },
        },
        importFile: settingsStore.querySelector('#ica--importFile'),
        getEntries: getAgentListEntries,
        state: () => ({
            enabled: areAgentsGloballyEnabled(), running: isAgentGenerationActive(), fixRunning: fixTrackersRunning,
            enabledKeys: new Set(getAgents().filter(isAgentEnabledForCurrentScope).map(agent => `agent:${agent.id}`)),
            updates: getAgentsWithTemplateUpdates().filter(agent => !isPathfinderAgent(agent)).length,
            tokens: getInChatAgentTokenUsage(), conversationMode: isConversationModeActive(),
        }),
        setGlobalEnabled: enabled => {
            setGlobalSettings({ enabled });
            if (!enabled) cancelPathfinderSummary();
            persistExtensionState();
            syncToolAgentRegistrations();
            renderAgentList();
        },
        stop: () => {
            cancelAgentGeneration(); refreshGenerationUi();
        },
        openEditor: openAgentListEntry,
        newCompanion: autoOpenCompanionMaker => openEditor(null, { draft: buildCompanionDraftAgent(), autoOpenCompanionMaker }),
        setEnabled: setAgentListEntryEnabled,
        perform: performAgentListAction,
        bulk: performAgentBulkAction,
        editProperties: editAgentListProperties,
        reorder: async ids => {
            await reorderAgentsIntoOrderSlots(ids); renderAgentList(); refreshCompanionPanel();
        },
        updateAll: updateAllAgentsFromSourceTemplates,
        fixTrackers: fixTrackersFromList,
        convertTrackers: convertTrackersFromList,
        exportAll: handleExportAll,
        getGroups,
        turnOnGroup: async group => {
            const result = await turnOnGroup(group, getCatalogueContext()); syncToolAgentRegistrations(); renderAgentList();
            return result;
        },
        deleteGroup,
        createGroup: createCustomGroup,
        editor: {
            saveAgent: agent => saveAgent({
                ...agent,
                settings: agentEditorTemplateSettings(agent),
            }),
            materialise: (id, options) => materialise(
                id,
                {
                    ...options,
                    edits: {
                        ...options.edits,
                        settings: agentEditorTemplateSettings(options.edits),
                    },
                },
                getCatalogueContext(),
            ),
            syncCompanionChatHistoryConfig,
            saveChatDebounced,
            refreshRegexSnapshotsForAgent,
            updateCompanionButtonVisibility: () => {
                updateCompanionButtonVisibility();
                syncToolAgentRegistrations();
                refreshCompanionPanel();
            },
            populateProfiles: (select, selectedValue) => populateConnectionProfileSelect(select, { selectedValue }),
            profileMenu: async trigger => {
                const { openActionMenu } = await import('../../sillybunny-action-menu.js');
                const { confirmActiveEditorLeave } = await import('../../sillybunny-editor/navigation.js');
                openActionMenu({
                    trigger,
                    sections: [
                        {
                            items: [
                                {
                                    label: t`Connections`,
                                    icon: 'fa-solid fa-plug',
                                    onSelect: async () => {
                                        if (await confirmActiveEditorLeave()) await globalThis.SillyBunnyShell.openTab('left', 'connections');
                                    },
                                },
                            ],
                        },
                    ],
                });
            },
            companions: getAgentEditorCompanionOptions,
            characters: () => getChatroomSelectableCharacters().map(character => [character.avatar, character.label]),
            templateSettings: agentEditorTemplateSettings,
            customStyles: value => parseChatroomCustomStyles(value).map(item => [item.name, item.name]),
            customVoices: value => parseDirectorCustomVoices(value).map(item => [item.name, item.name]),
            chatroomStyles: [
                ['mixed', t`Mixed`],
                ['in-world', t`In-world`],
                ['discord/twitch', t`Discord / Twitch`],
                ['twitter/x', t`Twitter / X`],
                ['reddit', t`Reddit`],
                ['ao3/wattpad', t`AO3 / Wattpad`],
                ['newsroom', t`Newsroom`],
                ['thread-board/4chan', t`Thread-board / 4chan`],
                ['infomercial', t`Infomercial`],
                ['custom', t`Custom`],
            ],
            directorVoices: [
                ['active', t`Active narration voice`],
                ['conspiratorial-absurdity', t`Conspiratorial absurdity`],
                ['bureaucratic-irony', t`Bureaucratic irony`],
                ['cosmic-playbook', t`Cosmic playbook`],
                ['beige-undercurrents', t`Beige undercurrents`],
                ['gossipy-voyeurism', t`Gossipy voyeurism`],
                ['cruel-realism', t`Cruel realism`],
                ['solemn-witness', t`Solemn witness`],
                ['grand-satirical-stage', t`Grand satirical stage`],
                ['randomised', t`Randomised`],
                ['custom', t`Custom`],
            ],
            preview: previewPreGenerationPrompt,
            feedback: previewCompanionFeedbackPrompt,
            refine: refinePromptWithAI,
            createRegex: createDefaultRegexScript,
            normalizeRegex: normalizeRegexScript,
            regexSubstitutions: [
                [AGENT_REGEX_SUBSTITUTE.NONE, t`None`],
                [AGENT_REGEX_SUBSTITUTE.RAW, t`Raw macros`],
                [AGENT_REGEX_SUBSTITUTE.ESCAPED, t`Escaped macros`],
            ],
            regexPlacements: [
                [AGENT_REGEX_PLACEMENT.USER_INPUT, t`User Input`],
                [AGENT_REGEX_PLACEMENT.AI_OUTPUT, t`AI Output`],
                [AGENT_REGEX_PLACEMENT.SLASH_COMMAND, t`Slash Commands`],
                [AGENT_REGEX_PLACEMENT.WORLD_INFO, t`World Info`],
                [AGENT_REGEX_PLACEMENT.REASONING, t`Reasoning`],
            ],
            generateCompanionKitWithAI,
            generateTrackerKitWithAI,
            parseTrackerFormat,
            buildTrackerPreviewPopupContent,
        },
    });
}

async function performAgentBulkAction(keys, action, { properties = {}, onSaved = () => {} } = {}) {
    const entries = new Map(getAgentListEntries().map(entry => [entry.key, entry]));
    let eligible = 0;
    let changed = 0;
    try {
        for (const key of new Set(keys)) {
            const entry = entries.get(key);
            if (!entry) continue;
            if (action === 'delete') {
                if (entry.kind !== 'agent') continue;
                await deleteAgent(entry.agent.id);
                changed++;
                continue;
            }
            if (action === 'on' || action === 'off') {
                const enabled = action === 'on';
                if ((entry.kind === 'agent' && isAgentEnabledForCurrentScope(entry.agent)) === enabled) continue;
                const saved = await setAgentListEntryEnabled(entry, enabled);
                if (saved) {
                    changed++; onSaved(key, saved);
                }
                continue;
            }
            const agent = structuredClone(entry.agent);
            agent.injection ??= {};
            agent.conditions ??= {};
            agent.postProcess ??= {};
            let dirty = false;
            if (action === 'companion-outputs') {
                if (isCompanionAgent(agent) || isToolAgent(agent) || !['post', 'both'].includes(agent.phase)) continue;
                eligible++;
                if (agent.conditions.runOnCompanionOutputs) continue;
                agent.conditions.runOnCompanionOutputs = true;
                dirty = true;
            } else if (action === 'convert-companion') {
                dirty = convertAgentExecution(agent, 'companion');
            } else if (action === 'properties' || action === 'role-system' || action === 'role-user') {
                const values = action === 'properties' ? properties : { role: action === 'role-system' ? '0' : '1' };
                const fields = [
                    ['role', agent.injection, 'role', Number],
                    ['phase', agent, 'phase', String],
                    ['promptMode', agent.postProcess, 'promptTransformMode', String],
                    ['promptEnabled', agent.postProcess, 'promptTransformEnabled', value => value === 'true'],
                    ['ppEnabled', agent.postProcess, 'enabled', value => value === 'true'],
                    ['scan', agent.injection, 'scan', value => value === 'true'],
                ];
                for (const [field, target, property, parse] of fields) {
                    if (values[field] === undefined || values[field] === '') continue;
                    const value = parse(values[field]);
                    const current = typeof value === 'boolean' ? Boolean(target[property]) : target[property];
                    if (current === value) continue;
                    target[property] = value;
                    dirty = true;
                }
            } else {
                throw new Error(`Unknown agent bulk action: ${action}`);
            }
            if (!dirty) continue;
            lockBundledAgentCustomization(agent);
            const saved = entry.kind === 'agent-template'
                ? await materialise(entry.template.id, { edits: agent }, getCatalogueContext())
                : await saveAgent(agent);
            refreshRegexSnapshotsForAgent(saved.id);
            changed++;
            onSaved(key, saved);
        }
        if (action === 'companion-outputs') {
            if (changed) toastr.success(`Enabled ${changed} selected post-generation agent(s) on companion outputs.`);
            else if (eligible) toastr.info('Selected post-generation agents are already enabled on companion outputs.');
            else toastr.warning('No selected post-generation agents can run on companion outputs.');
        }
        return changed;
    } finally {
        syncToolAgentRegistrations();
        renderAgentList();
    }
}

async function editAgentListProperties(keys, options) {
    const content = document.getElementById('ica--bulkEditPopup');
    if (!content) throw new Error('Agent bulk-edit content is unavailable');
    const marker = document.createComment('Agent bulk-edit origin');
    content.before(marker);
    const fields = ['role', 'phase', 'promptMode', 'promptEnabled', 'ppEnabled', 'scan'];
    for (const field of fields) content.querySelector(`#ica--bulkEdit-${field}`).value = '';
    content.style.display = '';
    try {
        const result = await new Popup(content, POPUP_TYPE.CONFIRM, '', { okButton: t`Apply`, cancelButton: t`Cancel`, wide: true }).show();
        if (result !== POPUP_RESULT.AFFIRMATIVE) return false;
        const properties = Object.fromEntries(fields.map(field => [field, content.querySelector(`#ica--bulkEdit-${field}`).value]));
        if (fields.every(field => properties[field] === '')) {
            toastr.info('No properties selected to change.');
            return false;
        }
        const changed = await performAgentBulkAction(keys, 'properties', { ...options, properties });
        if (changed) toastr.success(`Updated ${changed} agent(s).`);
        else toastr.info('No agents needed updating.');
        return true;
    } finally {
        content.style.display = 'none';
        marker.replaceWith(content);
    }
}

function restoreAutoSeededTemplateIds(savedState) {
    const rawIds = Array.isArray(savedState?.autoSeededTemplateIds) ? savedState.autoSeededTemplateIds : [];
    autoSeededTemplateIds = new Set(
        rawIds
            .map(id => String(id ?? '').trim())
            .filter(Boolean),
    );
}

function getLastAssistantMessageIndex() {
    return chat.findLastIndex(message => message && !message.is_user && !message.is_system);
}

function getManualAgentRunMessageIndices(rangeText, lastAssistantIndex) {
    const range = String(rangeText ?? '').trim();
    if (!range) {
        return lastAssistantIndex >= 0 ? [lastAssistantIndex] : [];
    }

    const indexes = new Set();
    for (const section of range.split(',')) {
        const match = section.trim().match(/^(\d+)(?:\s*-\s*(\d+))?$/);
        if (!match) {
            return null;
        }

        const start = Number(match[1]);
        const end = Number(match[2] ?? match[1]);
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end) {
            return null;
        }

        for (let index = Math.max(0, start); index <= Math.min(chat.length - 1, end); index++) {
            const message = chat[index];
            if (message && !message.is_user && !message.is_system) {
                indexes.add(index);
            }
        }
    }

    return [...indexes].sort((a, b) => a - b);
}

/**
 * Shows a picker for the manual "Apply to…" action listing what exists right now:
 * the last assistant reply, the composer text box, and the finished companion notes
 * on that reply. Returns runAgentOnTarget-compatible targets, or null on cancel.
 */
async function pickManualAgentRunTargets(agent) {
    const lastAssistantIndex = getLastAssistantMessageIndex();
    const composerText = String(document.getElementById('send_textarea')?.value ?? '').trim();
    const options = [];

    if (lastAssistantIndex >= 0) {
        const replyName = String(chat[lastAssistantIndex]?.name ?? '').trim();
        options.push({
            value: 'message',
            label: `Last assistant reply #${lastAssistantIndex}${replyName ? ` (${replyName})` : ''}`,
        });

        for (const [companionAgentId, result] of Object.entries(getCompanionResults(chat[lastAssistantIndex]))) {
            if (result?.status !== 'done' || !String(result?.content ?? '').trim()) continue;

            const companionLabel = String(result?.agentName ?? '').trim()
                || getAgentById(companionAgentId)?.name
                || companionAgentId;
            options.push({
                value: `companion:${companionAgentId}`,
                label: `Companion note: ${companionLabel}`,
            });
        }
    }

    if (composerText) {
        options.push({ value: 'composer', label: 'Composer text box (current input)' });
    }

    if (options.length === 0) {
        toastr.warning('No targets available: no assistant reply yet and the composer is empty.');
        return null;
    }

    const picker = $(`
        <div class="ica--run-target-picker">
            <h4>Apply "${escapeHtml(agent.name)}" to…</h4>
        </div>
    `);

    options.forEach((option, index) => {
        picker.append($(`
            <label class="checkbox_label">
                <input type="checkbox" name="ica--run-target" value="${escapeHtml(option.value)}" ${index === 0 ? 'checked' : ''} />
                <span>${escapeHtml(option.label)}</span>
            </label>
        `));
        if (option.value === 'message') {
            picker.append($(`
                <label class="ica--run-target-range">
                    <span>Messages</span>
                    <input type="text" id="ica--run-target-message-range" class="text_pole" placeholder="0-5, 8" inputmode="text" />
                </label>
            `));
        }
    });

    const popupResult = await new Popup(picker, POPUP_TYPE.CONFIRM, '', { okButton: 'Apply', cancelButton: 'Cancel' }).show();
    if (popupResult !== POPUP_RESULT.AFFIRMATIVE) {
        return null;
    }

    const selected = picker.find('input[name="ica--run-target"]:checked').map((_, input) => String(input.value)).get();
    if (selected.length === 0) {
        toastr.warning('Select at least one target.');
        return null;
    }

    const messageIndices = selected.includes('message')
        ? getManualAgentRunMessageIndices(picker.find('#ica--run-target-message-range').val(), lastAssistantIndex)
        : [];
    if (messageIndices === null || (selected.includes('message') && messageIndices.length === 0)) {
        toastr.warning('Select at least one target.');
        return null;
    }

    return selected.flatMap(value => {
        if (value === 'composer') {
            return [{ kind: 'composer' }];
        }

        if (value.startsWith('companion:')) {
            return [{
                kind: 'companion',
                messageIndex: lastAssistantIndex,
                companionAgentId: value.slice('companion:'.length),
            }];
        }

        if (value === 'message') {
            return messageIndices.map(messageIndex => ({ kind: 'message', messageIndex }));
        }

        return [];
    });
}

function hasTrackerFixAgents() {
    return getAgents().some(isTrackerFixAgent);
}

function hasRunnableInlineTrackerAgents() {
    if (!areAgentsGloballyEnabled()) return false;
    return getEnabledAgents().some(agent => !isCompanionAgent(agent) && isTrackerFixAgent(agent));
}

function hasRunnableCompanionTrackerAgents() {
    if (!areAgentsGloballyEnabled()) return false;
    return getEnabledAgents().some(agent => isCompanionAgent(agent) && isTrackerFixAgent(agent));
}

function hasAnyFixableAgents() {
    return hasRunnableInlineTrackerAgents() || hasRunnableCompanionTrackerAgents();
}

function getFixTrackersUnavailableMessage() {
    if (!areAgentsGloballyEnabled()) {
        return 'In-Chat Agents are disabled.';
    }
    if (!hasTrackerFixAgents()) {
        return 'No tracker or connected companion agents are installed. Add one from Templates first.';
    }
    if (!hasAnyFixableAgents()) {
        return `No tracker or connected companion agents are enabled for ${getAgentChatScopeLabel().toLowerCase()}.`;
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
    refreshAgentsPanels();
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

function populateSeparateRecentChatsToggle() {
    $('#ica--separateRecentChats').prop('checked', Boolean(getGlobalSettings().separateRecentChats));
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

function getLevelUpStatsContextRecipientTemplateId(agent) {
    const templateId = String(agent?.sourceTemplateId || agent?.id || '').trim();
    if (templateId === LEVEL_UP_COMPANION_TEMPLATE_ID) {
        return USER_BASED_STATS_TEMPLATE_ID;
    }

    if (templateId === USER_BASED_STATS_TEMPLATE_ID) {
        return LEVEL_UP_COMPANION_TEMPLATE_ID;
    }

    return '';
}

function applyLevelUpStatsContextLinkDefault(agent) {
    const recipientTemplateId = getLevelUpStatsContextRecipientTemplateId(agent);
    if (!recipientTemplateId || !isCompanionAgent(agent)) {
        return false;
    }

    const companion = getCompanionConfig(agent);
    const recipientIds = normalizeCompanionBatchAgentIds(companion.contextRecipientAgentIds);
    const dependencyIds = normalizeCompanionBatchAgentIds(companion.dependencies);
    const templateId = String(agent?.sourceTemplateId || agent?.id || '').trim();
    const recipientKey = recipientTemplateId.toLowerCase();
    let changed = false;

    if (!recipientIds.some(id => id.toLowerCase() === recipientKey)) {
        recipientIds.push(recipientTemplateId);
        changed = true;
    }

    if (!companion.sendContextToCompanions) {
        companion.sendContextToCompanions = true;
        changed = true;
    }

    if (templateId === USER_BASED_STATS_TEMPLATE_ID) {
        const dependencyKey = LEVEL_UP_COMPANION_TEMPLATE_ID.toLowerCase();
        if (!dependencyIds.some(id => id.toLowerCase() === dependencyKey)) {
            dependencyIds.push(LEVEL_UP_COMPANION_TEMPLATE_ID);
            changed = true;
        }

        if (!companion.waitForDependencies) {
            companion.waitForDependencies = true;
            changed = true;
        }
    }

    if (!changed) {
        return false;
    }

    agent.companion = {
        ...(agent.companion || {}),
        ...companion,
        sendContextToCompanions: true,
        contextRecipientAgentIds: recipientIds,
        dependencies: dependencyIds,
        waitForDependencies: templateId === USER_BASED_STATS_TEMPLATE_ID ? true : companion.waitForDependencies,
    };
    return true;
}

async function migrateLevelUpStatsContextLinks() {
    const settings = getGlobalSettings();
    const appliedVersion = Number(settings.levelUpStatsContextLinksVersion ?? 0) || 0;
    if (appliedVersion >= LEVEL_UP_STATS_CONTEXT_LINKS_VERSION) {
        return 0;
    }

    let migrated = 0;
    for (const agent of getAgents()) {
        if (applyLevelUpStatsContextLinkDefault(agent)) {
            await saveAgent(agent);
            migrated++;
        }
    }

    setGlobalSettings({
        levelUpStatsContextLinksVersion: LEVEL_UP_STATS_CONTEXT_LINKS_VERSION,
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

function findTemplateForAgent(agent) {
    return findTemplateForAgentSnapshot(agent, templates);
}

function findSourceTemplateForAgent(agent) {
    return findCatalogueSourceTemplateForAgent(agent, templates);
}

function getAgentsWithTemplateUpdates() {
    return getCatalogueAgentsWithTemplateUpdates(getAgents(), templates);
}

function mergeTemplateDefaults(template) {
    return mergeCatalogueTemplateDefaults(template, { regexBundles: templateRegexBundles });
}

function getDefaultBundledTemplates() {
    return getCatalogueDefaultBundledTemplates(templates);
}

function getVisibleInChatAgents(agentList = getAgents()) {
    return agentList.filter(agent => !isPathfinderAgent(agent));
}

function getTemplateRegexCount(template) {
    return Array.isArray(template?.regexScripts) ? template.regexScripts.length : 0;
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
    return buildCatalogueAgentFromTemplate(template, { regexBundles: templateRegexBundles });
}

function buildUpdatedAgentFromTemplate(agent, template) {
    return buildCatalogueUpdatedAgentFromTemplate(agent, template, { regexBundles: templateRegexBundles });
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

async function updateAllAgentsFromSourceTemplates() {
    const outdatedAgents = getAgentsWithTemplateUpdates();
    if (outdatedAgents.length === 0) {
        toastr.info('Every bundled agent is already on its latest template.');
        return;
    }

    const names = outdatedAgents
        .map(agent => {
            const template = findSourceTemplateForAgent(agent);
            return `<li>${escapeHtml(agent.name || template.name)} — v${escapeHtml(getAgentVersionValue(agent))} &rarr; v${escapeHtml(getTemplateVersionValue(template))}</li>`;
        })
        .join('');
    const result = await new Popup(
        `Update ${outdatedAgents.length} agent(s) to their latest templates? Enabled state, quick toggle pin, order, and profile overrides will be kept.<ul class="ica--update-all-list">${names}</ul>`,
        POPUP_TYPE.CONFIRM,
    ).show();

    if (result !== POPUP_RESULT.AFFIRMATIVE) {
        return;
    }

    let updated = 0;
    for (const agent of outdatedAgents) {
        const template = findSourceTemplateForAgent(agent);
        if (!template) {
            continue;
        }
        await saveAgent(buildUpdatedAgentFromTemplate(agent, template));
        updated++;
    }

    syncToolAgentRegistrations();
    renderAgentList();
    toastr.success(`Updated ${updated} agent(s) to their latest templates.`);
}

globalThis.SillyBunnyAgents = Object.assign(globalThis.SillyBunnyAgents || {}, {
    getEnabledAgents,
});

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

async function refreshBundledAgentsFromLatestTemplates() {
    const { updates, redundantIds } = getBundledAgentLatestTemplatePlan(getAgents(), templates);

    for (const agentId of redundantIds) {
        await deleteAgent(agentId);
    }

    for (const update of updates) {
        await saveAgent(update.agent);
    }

    return {
        updatedCount: updates.length,
        removedCount: redundantIds.length,
    };
}

async function purgeRemovedBundledAgents() {
    let removedCount = 0;

    for (const agent of [...getAgents()]) {
        if (!isRemovedBundledAgent(agent)) {
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
    await ensureCatalogueDefaultBundledAgents(getCatalogueContext());
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
    return hasCatalogueMatchingAgentSnapshot(snapshot, existingAgents);
}

// ===================== Panel Rendering =====================

function updateFixTrackersButtonVisibility() {
    const hasInlineCandidates = getAgents().some(agent => !isCompanionAgent(agent) && isTrackerFixAgent(agent));
    const hasCompanionCandidates = getAgents().some(agent => isCompanionAgent(agent) && isTrackerFixAgent(agent));
    const hasInstalledFixables = hasInlineCandidates || hasCompanionCandidates;
    const shouldShowMessageButtons = areAgentsGloballyEnabled() && hasInstalledFixables;
    $('.mes_fix_trackers').each(function () {
        const $message = $(this).closest('.mes');
        const isNonSystemMessage = $message.attr('is_system') !== 'true';
        const isAssistantMessage = isNonSystemMessage && $message.attr('is_user') !== 'true';
        $(this).toggle(shouldShowMessageButtons && (
            (hasInlineCandidates && isAssistantMessage) ||
            (hasCompanionCandidates && isNonSystemMessage)
        ));
    });

    refreshAgentsPanels();
}

async function runTrackerFixFromButton(messageIndex, button, { inlineMessageIndex = messageIndex, companionMessageIndex = messageIndex } = {}) {
    if (fixTrackersRunning) return;
    fixTrackersRunning = true;
    const $button = $(button);
    $button.prop('disabled', true).addClass('mes_fix_trackers--running');
    updateFixTrackersButtonVisibility();
    try {
        const cancelRevision = getAgentGenerationCancelRevision();
        const hasInlineTrackers = hasRunnableInlineTrackerAgents();
        const hasCompanionTrackers = hasRunnableCompanionTrackerAgents();
        if (!hasInlineTrackers && !hasCompanionTrackers) {
            toastr.info('No enabled tracker or connected companion agents found.');
            return;
        }

        const inlineMessage = chat[inlineMessageIndex];
        const companionMessage = chat[companionMessageIndex];
        const fixChatId = getCurrentChatId();
        const isFixContextCurrent = () => getCurrentChatId() === fixChatId
            && chat[inlineMessageIndex] === inlineMessage
            && chat[companionMessageIndex] === companionMessage;
        const canRunInlineTrackers = inlineMessage && !inlineMessage.is_user && !inlineMessage.is_system;
        const canRunCompanionTrackers = companionMessage && !companionMessage.is_system;

        if (hasInlineTrackers && canRunInlineTrackers) {
            await runTrackerFixOnMessage(inlineMessageIndex, { cancelRevision });
        } else if (hasInlineTrackers) {
            toastr.warning('No assistant reply selected to fix trackers on.');
        }
        if (hasCompanionTrackers && canRunCompanionTrackers && isFixContextCurrent()) {
            await runTrackerCompanionsOnMessage(companionMessageIndex, { cancelRevision });
        } else if (hasCompanionTrackers && isFixContextCurrent()) {
            toastr.warning('No message selected to run connected companions on.');
        }
    } finally {
        fixTrackersRunning = false;
        $button.prop('disabled', false).removeClass('mes_fix_trackers--running');
        updateFixTrackersButtonVisibility();
    }
}

/**
 * Re-renders the agent list panel.
 */
function getInChatAgentTokenUsage() {
    let tokenCount = 0;
    try {
        tokenCount = Number(getContext()?.promptManager?.getInChatAgentTokenUsage?.() ?? 0);
    } catch {
        tokenCount = 0;
    }

    return Number.isFinite(tokenCount) ? tokenCount : 0;
}

function updateAgentTokenCounter() {
    refreshAgentsPanels();
}

function renderAgentList() {
    refreshAgentsPanels();
    updateFixTrackersButtonVisibility();
    updateCompanionButtonVisibility();
    updateCompanionPanelHandleVisibility();
}

// ===================== Editor Modal =====================


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
async function openEditor(agentId = null, {
    draft = null,
    autoOpenCompanionMaker = false,
    materialiseTemplateId = null,
} = {}, origin = 'agent-list') {
    // SillyBunny: preserve the public hook while routing generic agents to Backend detail.
    const saved = agentId ? getAgentById(agentId) : null;
    if (agentId && !saved) return;
    if (saved && isPathfinderAgent(saved)) return openPathfinderEditor(saved);
    const ui = await import('./ui/agent-list.js');
    const entry = getAgentListEntries().find(value => materialiseTemplateId ? value.key === `agent-template:${materialiseTemplateId}` : value.key === `agent:${agentId}`);
    return ui.openAgentDetail({
        entry,
        draft: entry ? null : draft ?? createDefaultAgent(),
        autoOpenCompanionMaker,
        origin,
    });
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
 * Creates a custom group from the user's current agents.
 */
async function createCustomGroup(selectedKeys = null) {
    const entries = selectedKeys ? getAgentListEntries() : getAgentListEntries().filter(entry => entry.kind === 'agent');
    const currentAgents = entries.map(entry => entry.agent);
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
    for (const entry of entries) {
        const agent = entry.agent;
        agentList.append(`
            <label class="checkbox_label">
                <input type="checkbox" value="${escapeHtml(entry.key)}" ${!selectedKeys || selectedKeys.includes(entry.key) ? 'checked' : ''} />
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
        .map(key => entries.find(entry => entry.key === key)?.agent)
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

function buildTrackerHtmlPreviewNode(generatedKit, sampleText) {
    const sampleOutput = normalizeMultilineInput(sampleText);
    let renderedOutput = sampleOutput;
    let previewError = '';

    try {
        renderedOutput = applyRegexScriptList(
            sampleOutput,
            generatedKit.regexScripts,
            AGENT_REGEX_PLACEMENT.AI_OUTPUT,
            {
                isMarkdown: true,
                substituteParamsFn: substituteParams,
            },
        );
    } catch (error) {
        previewError = error instanceof Error ? error.message : String(error);
    }

    const hasRenderedPreview = Boolean(renderedOutput && renderedOutput !== sampleOutput && !previewError);
    const previewNode = $(`
        <div class="ica--editor-section ica--regex-subsection">
            <div class="ica--tracker-preview-heading">
                <strong>HTML Preview</strong>
                <span class="ica--tracker-preview-status">${hasRenderedPreview ? 'Rendered from sample' : 'No regex match'}</span>
            </div>
            <div class="ica--regex-note">Rendered from the pasted tracker format example, using the generated regex beautifier.</div>
            <div class="ica--tracker-preview-frame"></div>
            ${previewError ? `<div class="ica--regex-note">Preview failed: ${escapeHtml(previewError)}</div>` : ''}
            ${!hasRenderedPreview && !previewError ? '<div class="ica--regex-note">No generated regex matched the sample, so the raw tracker example is shown instead.</div>' : ''}
        </div>
    `);
    const previewFrame = previewNode.find('.ica--tracker-preview-frame').get(0);

    if (previewFrame) {
        previewFrame.innerHTML = hasRenderedPreview
            ? renderedOutput
            : `<pre class="ica--tracker-preview-source">${escapeHtml(sampleOutput || '(empty tracker sample)')}</pre>`;
    }

    return previewNode;
}

function buildTrackerPreviewPopupContent(generatedKit, sampleText, extraInstructions = '') {
    const regexItems = generatedKit.regexScripts
        .map(script => `<li><strong>${escapeHtml(script.scriptName || 'Regex Script')}</strong><br><code>${escapeHtml(script.findRegex || '')}</code></li>`)
        .join('');
    const previewContent = $(`
        <div class="ica--regex-editor">
            ${generatedKit.usedFallback ? '<div class="ica--regex-note"><strong>Fallback scaffold used.</strong> The builder produced a safe starter kit locally because the AI response was unavailable or invalid. You can still apply and tweak it.</div>' : ''}
            <div class="ica--tracker-preview-slot"></div>
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
            <div class="ica--editor-section ica--regex-subsection">
                <label>Extra instructions for regeneration <small>(optional)</small>
                    <textarea id="ica--tracker-builder-extra-instructions" class="text_pole textarea_compact" rows="4" placeholder="Example: Make the card denser, use warmer colors, and put note text first."></textarea>
                </label>
                <div class="ica--regex-note">Use Regenerate to update the tracker kit and preview before applying it.</div>
            </div>
        </div>
    `);

    previewContent.find('.ica--tracker-preview-slot').replaceWith(buildTrackerHtmlPreviewNode(generatedKit, sampleText));
    previewContent.find('#ica--tracker-builder-extra-instructions').val(extraInstructions);

    return previewContent;
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
                batch: false,
                maxTokens: MAX_AGENT_MAX_TOKENS,
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
    "batch": false,
    "maxTokens": 64000
  }
}

Requirements:
- Companion agents run after the main assistant reply and save a separate note card.
- The prompt must never ask the model to rewrite or continue the assistant reply.
- Prefer concise markdown unless the user specifically needs HTML or plain text.
- Use trigger "manual" for occasional diagnostics and "auto" for notes that should run after most replies.
- Use displayMode "hidden" only when the note is mainly for feedback into future generations.
- Keep maxTokens between 512 and 64000. Use 64000 by default unless the user asks for a smaller, cheaper companion.`;

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
    pathfinderExtensionsMountRevision++;
    closePathfinderSettings();
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

async function mountPathfinderSettingsInExtensions(agent = getPathfinderSettingsAgent()) {
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

    const mountRevision = ++pathfinderExtensionsMountRevision;
    closePathfinderSettings();
    delete host.dataset.pathfinderAgentId;
    body.innerHTML = '';

    if (!agent) {
        body.innerHTML = '<div class="pf--extensions-empty">Pathfinder agent is not available. Reload In-Chat Agents or restore the bundled Pathfinder template.</div>';
        return host;
    }

    body.setAttribute('aria-busy', 'true');
    const settingsPanel = await openPathfinderSettings(agent).catch(error => {
        if (mountRevision === pathfinderExtensionsMountRevision) {
            body.setAttribute('aria-busy', 'false');
            body.innerHTML = '<div class="pf--extensions-empty">Could not load Pathfinder settings.</div>';
        }
        throw error;
    });
    if (mountRevision !== pathfinderExtensionsMountRevision || !host.isConnected || !isPathfinderSubmoduleEnabled()) {
        if (settingsPanel) closePathfinderSettings(settingsPanel);
        return null;
    }
    body.setAttribute('aria-busy', 'false');

    if (!settingsPanel) {
        body.innerHTML = '<div class="pf--extensions-empty">Could not load Pathfinder settings.</div>';
        return host;
    }

    settingsPanel.filter('#pf--settings').addClass('pf--settings-embedded');
    for (const node of settingsPanel.toArray()) {
        body.append(node);
    }
    host.dataset.pathfinderAgentId = agent.id;
    return host;
}

function schedulePathfinderExtensionsMount(agent) {
    if (!isPathfinderSubmoduleEnabled()) {
        removePathfinderExtensionsHost();
        return Promise.resolve(null);
    }

    pathfinderExtensionsMountPromise = mountPathfinderSettingsInExtensions(agent)
        .catch(error => {
            console.warn('[Pathfinder] Failed to mount settings in Extensions drawer:', error);
            return null;
        });

    return pathfinderExtensionsMountPromise;
}

function scrollElementIntoNearestPanelScroller(element, { block = 'nearest' } = {}) {
    if (!(element instanceof HTMLElement)) {
        return;
    }

    const scroller = element.closest('.sb-shell-panel-scroller, .scrollableInner, .scrollableInnerFull');
    const behavior = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
    if (!(scroller instanceof HTMLElement) || scroller.clientHeight <= 0) {
        element.scrollIntoView({ block, inline: 'nearest', behavior });
        return;
    }

    const scrollerRect = scroller.getBoundingClientRect();
    const elementRect = element.getBoundingClientRect();
    const topOverflow = elementRect.top - scrollerRect.top;
    const bottomOverflow = elementRect.bottom - scrollerRect.bottom;
    let delta = 0;

    if (block === 'start') {
        delta = topOverflow;
    } else if (block === 'center') {
        delta = topOverflow - ((scrollerRect.height - elementRect.height) / 2);
    } else if (topOverflow < 0) {
        delta = topOverflow;
    } else if (bottomOverflow > 0) {
        delta = bottomOverflow;
    }

    if (Math.abs(delta) > 1) {
        scroller.scrollTo({
            top: Math.min(Math.max(scroller.scrollTop + delta, 0), Math.max(0, scroller.scrollHeight - scroller.clientHeight)),
            behavior,
        });
    }
}

function openPathfinderExtensionsDrawer(host) {
    refreshPathfinderSettings();
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
        if (!host?.isConnected) return;
        refreshPathfinderSettings();
        scrollElementIntoNearestPanelScroller(host, { block: 'start' });
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
        const host = await (existingHost.dataset.pathfinderAgentId === agent.id
            ? (pathfinderExtensionsMountPromise ?? schedulePathfinderExtensionsMount(agent))
            : schedulePathfinderExtensionsMount(agent));
        openPathfinderExtensionsDrawer(host ?? existingHost);
        toastr.info('Pathfinder settings are in the Extensions drawer.');
        return;
    }

    const settingsPanel = await openPathfinderSettings(agent);

    if (!settingsPanel) return;

    try {
        await new Popup(settingsPanel, POPUP_TYPE.TEXT, '', {
            okButton: 'Close',
            wide: true,
            large: true,
            onClosing: () => canClosePathfinderSettings(settingsPanel),
        }).show();
    } finally {
        closePathfinderSettings(settingsPanel);
        renderAgentList();
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

    renderAgentList();
}

function populateGlobalNotificationToggle() {
    refreshAgentsPanels();
    populateSeparateRecentChatsToggle();
    populatePathfinderSubmoduleToggle();
    $('#ica--promptTransformShowNotifications').prop(
        'checked',
        Boolean(getGlobalSettings().promptTransformShowNotifications),
    );
    $('#ica--postMainInterceptShowMessageFirst').prop(
        'checked',
        getGlobalSettings().postMainInterceptShowMessageFirst !== false,
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
    extraInstructions = '',
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
        '',
        'Extra custom instructions for this generation:',
        extraInstructions || '(none)',
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
async function refinePromptWithAI(currentPrompt, category, phase, connectionProfile = '', isCurrent = () => true) {
    if (!isCurrent()) return null;
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

    if (result !== POPUP_RESULT.AFFIRMATIVE || !isCurrent()) return null;

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
        if (!isCurrent()) return null;

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

async function resetBundledAgentsFromSettings() {
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
    if (!await confirmDestructiveAction({
        text: bundledCount === 1
            ? t`Reset 1 bundled agent to their original template defaults? Custom agents will not be affected. This cannot be undone.`
            : t`Reset ${bundledCount} bundled agents to their original template defaults? Custom agents will not be affected. This cannot be undone.`,
        confirmLabel: t`Reset`,
    })) return;
    const result = await resetBundledAgents(getCatalogueContext());
    const resetCount = result.reset + result.added;
    toastr.success(resetCount === 1
        ? t`Reset 1 bundled agent to defaults.`
        : t`Reset ${resetCount} bundled agents to defaults.`);
    renderAgentList();
    return result;
}

(async function () {
    const bulkEditHtml = await renderExtensionTemplateAsync(MODULE_NAME, 'bulk-edit');
    if (!bulkEditHtml) return;
    const { store: settingsStore, fields: settingsFields } = createAgentSettingsControls();
    document.body.append(settingsStore);
    document.body.append($(bulkEditHtml)[0]);

    const savedState = extension_settings.inChatAgents;
    const legacyGroups = Array.isArray(savedState?.groups)
        ? savedState.groups.map(group => structuredClone(group))
        : [];
    if (savedState && typeof savedState === 'object') {
        if (savedState.globalSettings && typeof savedState.globalSettings === 'object') {
            setGlobalSettings(savedState.globalSettings);
        }
        restoreAutoSeededTemplateIds(savedState);
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
    const latestBundledAgentMigration = await refreshBundledAgentsFromLatestTemplates();
    if (latestBundledAgentMigration.updatedCount > 0) {
        toastr.success(`Updated ${latestBundledAgentMigration.updatedCount} bundled agent${latestBundledAgentMigration.updatedCount !== 1 ? 's' : ''} to the latest template defaults.`);
    }
    if (latestBundledAgentMigration.removedCount > 0) {
        toastr.success(`Removed ${latestBundledAgentMigration.removedCount} redundant bundled agent duplicate${latestBundledAgentMigration.removedCount !== 1 ? 's' : ''}.`);
    }

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

    await migrateLevelUpStatsContextLinks();

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

    // The shell may already be mounted; registration reveals it only after initialization.
    await registerAgentListUi(settingsStore, settingsFields);
    renderAgentList();
    initCompanionCardUi();
    configureCompanionDashboard({
        openOverview: async () => (await import('./ui/agent-list.js')).openCompanionsOverview(),
    });
    initCompanionWandMenuItem();
    configureCompanionPanel({
        openEditor: agentId => openEditor(agentId, {}, 'companion-panel'),
        refreshAgentList: () => renderAgentList(),
    });
    initCompanionPanel();
    schedulePathfinderExtensionsMount();

    $('#ica--importFile').on('change', handleImport);

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
    $('#ica--postMainInterceptShowMessageFirst').on('change', function () {
        setGlobalSettings({ postMainInterceptShowMessageFirst: $(this).prop('checked') });
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
            refreshProfileUi();
            updateAgentTokenCounter();
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
        event_types.CHAT_COMPLETION_PROMPT_READY,
    ].filter(Boolean)) {
        eventSource.on(eventName, () => {
            updateFixTrackersButtonVisibility();
            updateCompanionButtonVisibility();
            updateAgentTokenCounter();
        });
    }
    updateFixTrackersButtonVisibility();
    updateCompanionButtonVisibility();
    updateAgentTokenCounter();
})();
