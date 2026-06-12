import { getRequestHeaders, saveSettingsDebounced } from '../../../script.js';
import { extension_settings, getContext } from '../../extensions.js';
import { uuidv4 } from '../../utils.js';
import {
    AGENT_REGEX_PLACEMENT,
    AGENT_REGEX_SUBSTITUTE,
    normalizeRegexScript,
} from './regex-scripts.js';
import {
    cacheAgentRegexScripts,
    clearCachedAgentRegexScripts,
    deleteCachedAgentRegexScripts,
} from './regex-snapshot-store.js';

/**
 * @typedef {object} AgentInjection
 * @property {number} position - 0=IN_PROMPT, 1=IN_CHAT, 2=BEFORE_PROMPT
 * @property {number} depth - 0-99, depth in chat history
 * @property {number} role - 0=SYSTEM, 1=USER, 2=ASSISTANT
 * @property {number} order - Ordering at same depth
 * @property {boolean} scan - Scan for World Info keywords
 */

/**
 * @typedef {object} AgentPreProcess
 * @property {'inject'|'intercept'} mode - Inject is the existing setExtensionPrompt flow; intercept rewrites the assembled outgoing context.
 * @property {'pre-generation'|'post-main-generation'} interceptTiming - When intercept mode runs.
 * @property {'replace'|'wrap'|'patch'} applyMode
 * @property {'before'|'after'} wrapPosition
 * @property {string} wrapPrefix
 * @property {string} wrapSuffix
 * @property {string} patchStartTag
 * @property {string} patchEndTag
 * @property {number} maxTokens
 */

/**
 * @typedef {object} AgentPostProcess
 * @property {boolean} enabled
 * @property {'regex'|'append'|'extract'} type
 * @property {string} regexFind
 * @property {string} regexReplace
 * @property {string} regexFlags
 * @property {string} appendText
 * @property {string} extractPattern
 * @property {string} extractVariable
 * @property {boolean} promptTransformEnabled
 * @property {boolean} promptTransformShowNotifications
 * @property {'rewrite'|'append'} promptTransformMode
 * @property {number} promptTransformMaxTokens
 */

/**
 * @typedef {object} AgentConditions
 * @property {string[]} triggerKeywords
 * @property {number} triggerProbability - 0-100
 * @property {string[]} generationTypes
 * @property {boolean} runOnImpersonate - Allows prompt-based post passes to rewrite generated impersonation text
 */

/**
 * @typedef {import('../../char-data.js').RegexScriptData} AgentRegexScript
 */

/**
 * @typedef {object} AgentToolDef
 * @property {string} name - Unique ToolManager name (e.g., 'Pathfinder_Search')
 * @property {string} displayName - Human-readable label
 * @property {string} description - LLM-facing instruction text
 * @property {object} parameters - OpenAI JSON Schema for tool parameters
 * @property {string} actionKey - Key resolved from ToolActionRegistry at runtime
 * @property {string} [formatMessageKey] - Key for display text formatter
 * @property {boolean} [shouldRegister=true] - Whether to include in LLM tool list
 * @property {boolean} [stealth=false] - If true, result hidden from chat
 * @property {boolean} [enabled=true] - Per-tool toggle within the agent
 */

/**
 * @typedef {object} InChatAgent
 * @property {string} id
 * @property {string} name
 * @property {string} description
 * @property {string} icon
 * @property {'content'|'tracker'|'randomizer'|'custom'|'tool'} category
 * @property {string[]} tags
 * @property {number} version
 * @property {string} author
 * @property {string} prompt
 * @property {'pre'|'post'|'both'} phase
 * @property {AgentInjection} injection
 * @property {AgentPreProcess} preProcess
 * @property {AgentPostProcess} postProcess
 * @property {AgentRegexScript[]} regexScripts
 * @property {string} connectionProfile
 * @property {string} modelOverride - Optional model name to use instead of profile default
 * @property {string} sourceTemplateId
 * @property {boolean} enabled
 * @property {boolean} favorite
 * @property {AgentConditions} conditions
 * @property {AgentToolDef[]} tools - Tool definitions for 'tool' category agents
 * @property {object} settings - Per-agent settings object for tool agents
 * @property {boolean} phaseLocked - Prevent bundled-template migrations from overriding user customizations
 */

/** @type {InChatAgent[]} */
let agents = [];

/** @type {AgentGroup[]} */
let builtinGroups = [];

/** @type {AgentGroup[]} */
let customGroups = [];

export const AGENT_CHAT_SCOPES = Object.freeze({
    INDIVIDUAL: 'individual',
    GROUP: 'group',
});

const AGENT_CHAT_SCOPE_KEYS = Object.values(AGENT_CHAT_SCOPES);

function createDefaultScopedEnabledAgentIds() {
    return {
        [AGENT_CHAT_SCOPES.INDIVIDUAL]: [],
        [AGENT_CHAT_SCOPES.GROUP]: [],
    };
}

/** Global settings for the In-Chat Agents extension. */
let globalSettings = {
    enabled: true,
    pathfinderEnabled: true,
    separateRecentChats: false,
    enabledAgentIdsByChatType: createDefaultScopedEnabledAgentIds(),
    scopedEnabledAgentIdsInitialized: false,
    connectionProfile: '',
    promptTransformShowNotifications: true,
    appendAgentsExecutionMode: 'parallel',
    helperPrefillMessages: '',
};

/**
 * Returns the global settings.
 * @returns {{ enabled: boolean, pathfinderEnabled: boolean, separateRecentChats: boolean, enabledAgentIdsByChatType: Record<string, string[]>, scopedEnabledAgentIdsInitialized: boolean, connectionProfile: string, promptTransformShowNotifications: boolean, appendAgentsExecutionMode: 'parallel'|'sequential', helperPrefillMessages: string }}
 */
export function getGlobalSettings() {
    return globalSettings;
}

/**
 * Updates global settings (merge).
 * @param {Partial<typeof globalSettings>} update
 */
export function setGlobalSettings(update) {
    if (!update || typeof update !== 'object') {
        return;
    }

    Object.assign(globalSettings, update);
    globalSettings.pathfinderEnabled = globalSettings.pathfinderEnabled !== false;
    globalSettings.enabledAgentIdsByChatType = normalizeScopedEnabledAgentIds(globalSettings.enabledAgentIdsByChatType);
    globalSettings.helperPrefillMessages = typeof globalSettings.helperPrefillMessages === 'string'
        ? globalSettings.helperPrefillMessages
        : '';

    if (!globalSettings.scopedEnabledAgentIdsInitialized) {
        const scopedSetting = update.enabledAgentIdsByChatType;
        globalSettings.scopedEnabledAgentIdsInitialized = Boolean(
            scopedSetting &&
            typeof scopedSetting === 'object' &&
            AGENT_CHAT_SCOPE_KEYS.some(scope => Object.hasOwn(scopedSetting, scope)),
        );
    }
}

function normalizeAgentIdList(value) {
    if (!Array.isArray(value)) {
        return [];
    }

    return Array.from(new Set(
        value
            .map(id => String(id ?? '').trim())
            .filter(Boolean),
    ));
}

function normalizeAgentChatScope(scope = AGENT_CHAT_SCOPES.INDIVIDUAL) {
    return AGENT_CHAT_SCOPE_KEYS.includes(scope) ? scope : AGENT_CHAT_SCOPES.INDIVIDUAL;
}

function normalizeScopedEnabledAgentIds(value = {}) {
    return {
        [AGENT_CHAT_SCOPES.INDIVIDUAL]: normalizeAgentIdList(value?.[AGENT_CHAT_SCOPES.INDIVIDUAL]),
        [AGENT_CHAT_SCOPES.GROUP]: normalizeAgentIdList(value?.[AGENT_CHAT_SCOPES.GROUP]),
    };
}

function ensureScopedEnabledAgentIds() {
    globalSettings.enabledAgentIdsByChatType = normalizeScopedEnabledAgentIds(globalSettings.enabledAgentIdsByChatType);
    return globalSettings.enabledAgentIdsByChatType;
}

export function getActiveAgentChatScope() {
    try {
        return getContext()?.groupId ? AGENT_CHAT_SCOPES.GROUP : AGENT_CHAT_SCOPES.INDIVIDUAL;
    } catch {
        return AGENT_CHAT_SCOPES.INDIVIDUAL;
    }
}

export function getAgentChatScopeLabel(scope = getActiveAgentChatScope()) {
    return normalizeAgentChatScope(scope) === AGENT_CHAT_SCOPES.GROUP ? 'Group chats' : 'Individual chats';
}

export function areAgentTogglesScopedByChatType() {
    return Boolean(globalSettings.separateRecentChats);
}

function getScopedEnabledAgentIdSet(scope = getActiveAgentChatScope()) {
    const scopedEnabledAgentIds = ensureScopedEnabledAgentIds();
    return new Set(scopedEnabledAgentIds[normalizeAgentChatScope(scope)]);
}

function isAgentIdEnabledInAnyScope(agentId, scopedEnabledAgentIds = ensureScopedEnabledAgentIds()) {
    const normalizedAgentId = String(agentId ?? '').trim();
    if (!normalizedAgentId) {
        return false;
    }

    return AGENT_CHAT_SCOPE_KEYS.some(scope => scopedEnabledAgentIds[scope].includes(normalizedAgentId));
}

export function isAgentEnabledForScope(agent, scope = getActiveAgentChatScope()) {
    if (!areAgentTogglesScopedByChatType() || !globalSettings.scopedEnabledAgentIdsInitialized) {
        return Boolean(agent?.enabled);
    }

    const agentId = String(agent?.id ?? '').trim();
    if (!agentId) {
        return false;
    }

    return getScopedEnabledAgentIdSet(scope).has(agentId);
}

export function isAgentEnabledForCurrentScope(agent) {
    return isAgentEnabledForScope(agent, getActiveAgentChatScope());
}

export function isAgentEnabledForAnyScope(agent) {
    if (!areAgentTogglesScopedByChatType() || !globalSettings.scopedEnabledAgentIdsInitialized) {
        return Boolean(agent?.enabled);
    }

    const agentId = String(agent?.id ?? '').trim();
    if (!agentId) {
        return false;
    }

    return isAgentIdEnabledInAnyScope(agentId);
}

export function setAgentEnabledForScope(agent, enabled, scope = getActiveAgentChatScope()) {
    if (!agent) {
        return false;
    }

    const nextEnabled = Boolean(enabled);

    if (!areAgentTogglesScopedByChatType()) {
        const changed = Boolean(agent.enabled) !== nextEnabled;
        agent.enabled = nextEnabled;
        return changed;
    }

    const agentId = String(agent.id ?? '').trim();
    if (!agentId) {
        return false;
    }

    const normalizedScope = normalizeAgentChatScope(scope);
    const scopedEnabledAgentIds = ensureScopedEnabledAgentIds();
    const enabledIds = new Set(scopedEnabledAgentIds[normalizedScope]);
    const wasEnabled = enabledIds.has(agentId);

    if (nextEnabled) {
        enabledIds.add(agentId);
    } else {
        enabledIds.delete(agentId);
    }

    scopedEnabledAgentIds[normalizedScope] = [...enabledIds];
    globalSettings.scopedEnabledAgentIdsInitialized = true;

    const previousLegacyEnabled = Boolean(agent.enabled);
    agent.enabled = isAgentEnabledForAnyScope(agent);

    return wasEnabled !== nextEnabled || previousLegacyEnabled !== Boolean(agent.enabled);
}

export function setAgentEnabledForCurrentScope(agent, enabled) {
    return setAgentEnabledForScope(agent, enabled, getActiveAgentChatScope());
}

function syncLegacyAgentEnabledFlagsFromScopes() {
    for (const agent of agents) {
        agent.enabled = isAgentEnabledForAnyScope(agent);
    }
}

export function initializeScopedAgentEnableState(scope = getActiveAgentChatScope()) {
    ensureScopedEnabledAgentIds();

    if (globalSettings.scopedEnabledAgentIdsInitialized) {
        return false;
    }

    const normalizedScope = normalizeAgentChatScope(scope);
    const enabledAgentIds = agents
        .filter(agent => agent.enabled)
        .map(agent => String(agent.id ?? '').trim())
        .filter(Boolean);

    globalSettings.enabledAgentIdsByChatType = createDefaultScopedEnabledAgentIds();
    globalSettings.enabledAgentIdsByChatType[normalizedScope] = enabledAgentIds;
    globalSettings.scopedEnabledAgentIdsInitialized = true;
    syncLegacyAgentEnabledFlagsFromScopes();
    return true;
}

export function reconcileScopedEnabledAgentIdsFromLegacyFlags(scope = getActiveAgentChatScope()) {
    if (!areAgentTogglesScopedByChatType() || !globalSettings.scopedEnabledAgentIdsInitialized) {
        return false;
    }

    const normalizedScope = normalizeAgentChatScope(scope);
    const scopedEnabledAgentIds = ensureScopedEnabledAgentIds();
    const enabledIds = new Set(scopedEnabledAgentIds[normalizedScope]);
    let changed = false;

    for (const agent of agents) {
        if (!agent?.enabled) {
            continue;
        }

        const agentId = String(agent.id ?? '').trim();
        if (!agentId || isAgentIdEnabledInAnyScope(agentId, scopedEnabledAgentIds)) {
            continue;
        }

        enabledIds.add(agentId);
        changed = true;
    }

    if (!changed) {
        return false;
    }

    scopedEnabledAgentIds[normalizedScope] = [...enabledIds];
    syncLegacyAgentEnabledFlagsFromScopes();
    return true;
}

export function persistAgentGlobalSettings() {
    extension_settings.inChatAgents = {
        ...(extension_settings.inChatAgents ?? {}),
        globalSettings: structuredClone(globalSettings),
    };
    delete extension_settings.inChatAgents.groups;
    saveSettingsDebounced();
}

function removeAgentIdFromScopedEnabledAgentIds(id) {
    const agentId = String(id ?? '').trim();
    if (!agentId) {
        return false;
    }

    const scopedEnabledAgentIds = ensureScopedEnabledAgentIds();
    let changed = false;

    for (const scope of AGENT_CHAT_SCOPE_KEYS) {
        const nextIds = scopedEnabledAgentIds[scope].filter(enabledId => enabledId !== agentId);
        if (nextIds.length !== scopedEnabledAgentIds[scope].length) {
            scopedEnabledAgentIds[scope] = nextIds;
            changed = true;
        }
    }

    return changed;
}

function normalizeConnectionProfileId(value) {
    return typeof value === 'string' ? value.trim() : '';
}

function getLiveConnectionManagerProfile() {
    const connectionProfilesSelect = document.getElementById('connection_profiles');

    if (!(connectionProfilesSelect instanceof HTMLSelectElement)) {
        return '';
    }

    return normalizeConnectionProfileId(connectionProfilesSelect.value);
}

export function getActiveConnectionProfile() {
    const globalProfileId = normalizeConnectionProfileId(globalSettings.connectionProfile);
    if (globalProfileId) {
        return globalProfileId;
    }

    const liveConnectionManagerProfile = getLiveConnectionManagerProfile();
    if (liveConnectionManagerProfile) {
        return liveConnectionManagerProfile;
    }

    const selectedConnectionManagerProfile = normalizeConnectionProfileId(
        extension_settings?.connectionManager?.selectedProfile,
    );
    return selectedConnectionManagerProfile || '';
}

export function getDefaultConnectionProfile() {
    return getActiveConnectionProfile();
}

export function resolveConnectionProfile(profileId = '') {
    const explicitProfileId = normalizeConnectionProfileId(profileId);
    if (explicitProfileId) {
        return explicitProfileId;
    }

    return getActiveConnectionProfile();
}

export const LEGACY_AGENT_MAX_TOKENS = 2000;
export const DEFAULT_AGENT_MAX_TOKENS = 8192;
export const PATHFINDER_TEMPLATE_ID = 'tpl-pathfinder';

export function areAgentsGloballyEnabled() {
    return globalSettings.enabled !== false;
}

export function isPathfinderSubmoduleEnabled() {
    return globalSettings.pathfinderEnabled !== false;
}

export function setPathfinderSubmoduleEnabled(enabled) {
    setGlobalSettings({ pathfinderEnabled: enabled !== false });
}

function getAgentTemplateName(value) {
    return String(value ?? '').trim().toLowerCase();
}

function isLikelyBundledAgentTemplateMatch(agent, template) {
    const agentName = getAgentTemplateName(agent?.name);
    const templateName = getAgentTemplateName(template?.name);
    if (!agentName || agentName !== templateName) {
        return false;
    }

    const agentAuthor = String(agent?.author ?? '').trim().toLowerCase();
    const templateAuthor = String(template?.author ?? '').trim().toLowerCase();
    if (!agentAuthor || !templateAuthor || agentAuthor !== templateAuthor) {
        return false;
    }

    const agentCategory = normalizeAgentCategory(agent?.category, agent?.sourceTemplateId, agent?.name);
    const templateCategory = normalizeAgentCategory(template?.category, template?.id, template?.name);
    return agentCategory === templateCategory;
}

export function findTemplateForAgentSnapshot(agent, templates = []) {
    const sourceTemplateId = String(agent?.sourceTemplateId ?? '').trim();
    if (sourceTemplateId) {
        return templates.find(template => String(template?.id ?? '').trim() === sourceTemplateId) ?? null;
    }

    const agentName = getAgentTemplateName(agent?.name);
    const agentPrompt = String(agent?.prompt ?? '').trim();
    if (!agentName) {
        return null;
    }

    const exactTemplate = templates.find(template =>
        getAgentTemplateName(template?.name) === agentName &&
        String(template?.prompt ?? '').trim() === agentPrompt,
    );
    if (exactTemplate) {
        return exactTemplate;
    }

    const likelyTemplates = templates.filter(template => isLikelyBundledAgentTemplateMatch(agent, template));
    return likelyTemplates.length === 1 ? likelyTemplates[0] : null;
}

function hasPathfinderToolMetadata(agent) {
    return Array.isArray(agent?.tools) && agent.tools.some(tool => String(tool?.name ?? '').startsWith('Pathfinder_'));
}

export function isBundledPathfinderAgentSnapshot(agent, templates = []) {
    const sourceTemplateId = String(agent?.sourceTemplateId ?? '').trim();
    if (sourceTemplateId === PATHFINDER_TEMPLATE_ID) {
        return true;
    }

    const template = findTemplateForAgentSnapshot(agent, templates);
    if (String(template?.id ?? '').trim() === PATHFINDER_TEMPLATE_ID) {
        return true;
    }

    const agentName = String(agent?.name ?? '').trim().toLowerCase();
    const agentPrompt = String(agent?.prompt ?? '').trim();
    const agentAuthor = String(agent?.author ?? '').trim().toLowerCase();
    const category = normalizeAgentCategory(agent?.category, agent?.sourceTemplateId, agent?.name);
    return agentName === 'pathfinder' &&
        category === 'tool' &&
        agentPrompt === '' &&
        (agentAuthor === 'sillybunny' || hasPathfinderToolMetadata(agent));
}

function getBundledAgentDuplicateKey(agent, templates = []) {
    if (isBundledPathfinderAgentSnapshot(agent, templates)) {
        return `template\u0000${PATHFINDER_TEMPLATE_ID}`;
    }

    const agentName = String(agent?.name ?? '').trim().toLowerCase();
    const agentPrompt = String(agent?.prompt ?? '').trim();
    if (!agentName || !agentPrompt) {
        return '';
    }

    return `${agentName}\u0000${agentPrompt}`;
}

function getPathfinderKeepRank(agent) {
    const sourceTemplateId = String(agent?.sourceTemplateId ?? '').trim();
    if (sourceTemplateId === PATHFINDER_TEMPLATE_ID && !agent?.phaseLocked) {
        return 0;
    }
    if (sourceTemplateId === PATHFINDER_TEMPLATE_ID) {
        return 1;
    }
    if (!agent?.phaseLocked) {
        return 2;
    }
    return 3;
}

function choosePathfinderAgentToKeep(agents) {
    return [...agents].sort((a, b) => getPathfinderKeepRank(a) - getPathfinderKeepRank(b))[0] ?? null;
}

function chooseSameTemplateAgentToKeep(agents, template) {
    const templatePrompt = template ? String(template?.prompt ?? '').trim() : null;
    if (templatePrompt !== null) {
        const currentTemplatePromptAgent = agents.find(agent => String(agent?.prompt ?? '').trim() === templatePrompt);
        if (currentTemplatePromptAgent) {
            return currentTemplatePromptAgent;
        }
    }

    return agents.find(agent => agent?.enabled) ?? agents[0] ?? null;
}

export function getRedundantBundledAgentDuplicateIds(agentList = [], templateList = []) {
    const groupedAgents = new Map();

    for (const agent of agentList) {
        const key = getBundledAgentDuplicateKey(agent, templateList);
        if (!key) {
            continue;
        }

        if (!groupedAgents.has(key)) {
            groupedAgents.set(key, []);
        }

        groupedAgents.get(key).push(agent);
    }

    const redundantIds = new Set();

    for (const grouped of groupedAgents.values()) {
        if (grouped.length < 2) {
            continue;
        }

        const pathfinderAgents = grouped.filter(agent => isBundledPathfinderAgentSnapshot(agent, templateList));
        if (pathfinderAgents.length > 1) {
            const keepAgent = choosePathfinderAgentToKeep(pathfinderAgents);
            for (const agent of pathfinderAgents) {
                if (agent?.id && agent.id !== keepAgent?.id && !agent.phaseLocked) {
                    redundantIds.add(agent.id);
                }
            }
            continue;
        }

        const templateBacked = grouped.filter(agent => String(agent?.sourceTemplateId ?? '').trim());
        const unsourced = grouped.filter(agent => !String(agent?.sourceTemplateId ?? '').trim());

        if (templateBacked.length !== 1 || unsourced.length === 0) {
            continue;
        }

        const template = findTemplateForAgentSnapshot(templateBacked[0], templateList);
        if (!template) {
            continue;
        }

        for (const agent of unsourced) {
            if (agent?.id && !agent.phaseLocked) {
                redundantIds.add(agent.id);
            }
        }
    }

    const agentsByTemplateId = new Map();
    for (const agent of agentList) {
        const sourceTemplateId = String(agent?.sourceTemplateId ?? '').trim();
        if (!sourceTemplateId) {
            continue;
        }

        if (!agentsByTemplateId.has(sourceTemplateId)) {
            agentsByTemplateId.set(sourceTemplateId, []);
        }

        agentsByTemplateId.get(sourceTemplateId).push(agent);
    }

    for (const grouped of agentsByTemplateId.values()) {
        if (grouped.length < 2) {
            continue;
        }

        const template = findTemplateForAgentSnapshot(grouped[0], templateList);
        const keepAgent = chooseSameTemplateAgentToKeep(grouped, template);
        for (const agent of grouped) {
            if (agent?.id && agent.id !== keepAgent?.id && !agent.phaseLocked) {
                redundantIds.add(agent.id);
            }
        }
    }

    return [...redundantIds];
}

export function getPromptTransformMode(agent) {
    return agent?.postProcess?.promptTransformMode === 'append' ? 'append' : 'rewrite';
}

export function normalizePromptTransformMaxTokens(value) {
    if (!Number.isFinite(Number(value))) {
        return DEFAULT_AGENT_MAX_TOKENS;
    }

    return Math.max(16, Math.min(16000, Number(value)));
}

export function normalizePreProcessMaxTokens(value) {
    if (!Number.isFinite(Number(value))) {
        return DEFAULT_AGENT_MAX_TOKENS;
    }

    return Math.max(16, Math.min(16000, Number(value)));
}

const TRACKER_CATEGORY_TEMPLATE_IDS = new Set([
    'tpl-achievements-tracker',
    'tpl-cyoa-choices',
    'tpl-direction-menu',
    'tpl-event-tracker',
    'tpl-item-tracker',
    'tpl-parallel-tracker',
    'tpl-relationship-tracker',
    'tpl-reputation-tracker',
    'tpl-scene-tracker',
    'tpl-secrets-tracker',
    'tpl-status-tracker',
    'tpl-time-tracker',
    'tpl-world-detail',
]);

const TRACKER_CATEGORY_NAMES = new Set([
    'achievements tracker',
    'cyoa choices',
    'direction menu',
    'event tracker',
    'item tracker',
    'parallel off-screen',
    'relationship tracker',
    'reputation tracker',
    'scene tracker',
    'secrets tracker',
    'status tracker',
    'time tracker',
    'world detail',
]);

export function normalizeAgentCategory(category = '', sourceTemplateId = '', name = '') {
    const normalizedTemplateId = typeof sourceTemplateId === 'string' ? sourceTemplateId.trim() : '';
    if (TRACKER_CATEGORY_TEMPLATE_IDS.has(normalizedTemplateId)) {
        return 'tracker';
    }

    const normalizedName = typeof name === 'string' ? name.trim().toLowerCase() : '';
    if (TRACKER_CATEGORY_NAMES.has(normalizedName)) {
        return 'tracker';
    }

    const normalizedCategory = typeof category === 'string' ? category.trim().toLowerCase() : '';
    if (['content', 'tracker', 'randomizer', 'custom', 'tool'].includes(normalizedCategory)) {
        return normalizedCategory;
    }

    return 'custom';
}

/**
 * Category display order and labels.
 */
export const AGENT_CATEGORIES = {
    tracker: { label: 'Tracker', icon: 'fa-chart-line' },
    randomizer: { label: 'Randomizer', icon: 'fa-dice' },
    content: { label: 'Content', icon: 'fa-film' },
    tool: { label: 'Tool', icon: 'fa-screwdriver-wrench' },
    custom: { label: 'Custom', icon: 'fa-puzzle-piece' },
};

/**
 * Modal-only template subgroup labels.
 */
export const AGENT_SUBCATEGORIES = {
    world: { category: 'tracker', label: 'World & Scene', icon: 'fa-map' },
    characters: { category: 'tracker', label: 'Character State', icon: 'fa-users' },
    progress: { category: 'tracker', label: 'Player Progress', icon: 'fa-trophy' },
    'player-choices': { category: 'tracker', label: 'Player Choices', icon: 'fa-list-check' },
    'prose-quality': { category: 'content', label: 'Prose Quality', icon: 'fa-feather' },
    pov: { category: 'content', label: 'Point of View', icon: 'fa-user-pen' },
    behaviour: { category: 'content', label: 'Behaviour & Tone', icon: 'fa-masks-theater' },
};

function escapeRegexLiteral(value) {
    return String(value ?? '').replaceAll('/', '\\/');
}

/**
 * Converts a legacy single regex post-process block into an ST-style regex script.
 * @param {Partial<InChatAgent>} rawAgent
 * @returns {AgentRegexScript|null}
 */
export function getLegacyRegexScript(rawAgent = {}) {
    const postProcess = rawAgent.postProcess;

    if (!postProcess?.enabled || postProcess.type !== 'regex' || !postProcess.regexFind) {
        return null;
    }

    const flags = String(postProcess.regexFlags ?? 'g').trim() || 'g';
    return normalizeRegexScript({
        id: `legacy-${String(rawAgent.id ?? uuidv4())}`,
        scriptName: `${String(rawAgent.name ?? '').trim() || 'Agent'} legacy regex`,
        findRegex: `/${escapeRegexLiteral(postProcess.regexFind)}/${flags}`,
        replaceString: String(postProcess.regexReplace ?? ''),
        trimStrings: [],
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

/**
 * Returns the usable regex scripts for an agent, including legacy regex-only agents.
 * @param {Partial<InChatAgent>} rawAgent
 * @returns {AgentRegexScript[]}
 */
export function getAgentRegexScripts(rawAgent = {}) {
    const explicitScripts = Array.isArray(rawAgent.regexScripts)
        ? rawAgent.regexScripts.map(script => normalizeRegexScript(script ?? {}))
        : [];

    if (explicitScripts.length > 0) {
        return explicitScripts;
    }

    const legacyScript = getLegacyRegexScript(rawAgent);
    return legacyScript ? [legacyScript] : [];
}

function cacheAgentRegexScriptsForAgent(agent) {
    cacheAgentRegexScripts(agent?.id, getAgentRegexScripts(agent));
}

function refreshAgentRegexScriptCache() {
    clearCachedAgentRegexScripts();
    for (const agent of agents) {
        cacheAgentRegexScriptsForAgent(agent);
    }
}

/**
 * Creates a new agent with default values.
 * @returns {InChatAgent}
 */
export function createDefaultAgent() {
    return {
        id: uuidv4(),
        name: '',
        description: '',
        icon: '',
        category: 'custom',
        tags: [],
        version: 1,
        author: '',
        prompt: '',
        phase: 'pre',
        connectionProfile: '',
        modelOverride: '',
        sourceTemplateId: '',
        injection: {
            position: 1,
            depth: 1,
            role: 0,
            order: 100,
            scan: false,
        },
        preProcess: {
            mode: 'inject',
            interceptTiming: 'pre-generation',
            applyMode: 'replace',
            wrapPosition: 'after',
            wrapPrefix: '',
            wrapSuffix: '',
            patchStartTag: '<context_patch>',
            patchEndTag: '</context_patch>',
            maxTokens: DEFAULT_AGENT_MAX_TOKENS,
        },
        postProcess: {
            enabled: false,
            type: 'regex',
            regexFind: '',
            regexReplace: '',
            regexFlags: 'g',
            appendText: '',
            extractPattern: '',
            extractVariable: '',
            promptTransformEnabled: false,
            promptTransformShowNotifications: true,
            promptTransformMode: 'rewrite',
            promptTransformMaxTokens: DEFAULT_AGENT_MAX_TOKENS,
        },
        regexScripts: [],
        enabled: false,
        favorite: false,
        phaseLocked: false,
        conditions: {
            triggerKeywords: [],
            triggerProbability: 100,
            generationTypes: ['normal', 'continue', 'impersonate'],
            runOnImpersonate: false,
        },
        tools: [],
        settings: {},
    };
}

/**
 * Normalizes a single tool definition loaded from disk or import.
 * @param {Partial<AgentToolDef>} raw
 * @returns {AgentToolDef}
 */
export function normalizeToolDef(raw = {}) {
    return {
        name: typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : '',
        displayName: typeof raw.displayName === 'string' ? raw.displayName : (raw.name ?? ''),
        description: typeof raw.description === 'string' ? raw.description : '',
        parameters: raw.parameters && typeof raw.parameters === 'object' ? raw.parameters : { type: 'object', properties: {} },
        actionKey: typeof raw.actionKey === 'string' ? raw.actionKey.trim() : '',
        formatMessageKey: typeof raw.formatMessageKey === 'string' ? raw.formatMessageKey.trim() : '',
        shouldRegister: typeof raw.shouldRegister === 'boolean' ? raw.shouldRegister : true,
        stealth: typeof raw.stealth === 'boolean' ? raw.stealth : false,
        enabled: typeof raw.enabled === 'boolean' ? raw.enabled : true,
    };
}

/**
 * Normalizes an agent loaded from disk or import.
 * @param {Partial<InChatAgent>} rawAgent
 * @returns {InChatAgent}
 */
export function normalizeAgent(rawAgent = {}) {
    const defaults = createDefaultAgent();
    const rawAgentWithoutModalMetadata = { ...rawAgent };
    delete rawAgentWithoutModalMetadata.subcategory;

    const rawPreProcess = rawAgent.preProcess && typeof rawAgent.preProcess === 'object' ? rawAgent.preProcess : {};
    const rawPostProcess = rawAgent.postProcess && typeof rawAgent.postProcess === 'object' ? rawAgent.postProcess : {};
    const conditions = rawAgent.conditions && typeof rawAgent.conditions === 'object' ? rawAgent.conditions : {};

    return {
        ...defaults,
        ...rawAgentWithoutModalMetadata,
        id: typeof rawAgent.id === 'string' && rawAgent.id.trim() ? rawAgent.id.trim() : defaults.id,
        name: typeof rawAgent.name === 'string' ? rawAgent.name : defaults.name,
        description: typeof rawAgent.description === 'string' ? rawAgent.description : defaults.description,
        icon: typeof rawAgent.icon === 'string' ? rawAgent.icon : defaults.icon,
        category: normalizeAgentCategory(rawAgent.category, rawAgent.sourceTemplateId, rawAgent.name),
        tags: Array.isArray(rawAgent.tags)
            ? rawAgent.tags.map(tag => String(tag ?? '').trim()).filter(Boolean)
            : defaults.tags,
        version: Number.isFinite(Number(rawAgent.version)) ? Number(rawAgent.version) : defaults.version,
        author: typeof rawAgent.author === 'string' ? rawAgent.author : defaults.author,
        prompt: typeof rawAgent.prompt === 'string' ? rawAgent.prompt : defaults.prompt,
        phase: ['pre', 'post', 'both'].includes(rawAgent.phase) ? rawAgent.phase : defaults.phase,
        connectionProfile: typeof rawAgent.connectionProfile === 'string' ? rawAgent.connectionProfile : defaults.connectionProfile,
        modelOverride: typeof rawAgent.modelOverride === 'string' ? rawAgent.modelOverride : defaults.modelOverride,
        sourceTemplateId: typeof rawAgent.sourceTemplateId === 'string' ? rawAgent.sourceTemplateId : defaults.sourceTemplateId,
        injection: {
            ...defaults.injection,
            ...(rawAgent.injection ?? {}),
        },
        preProcess: {
            ...defaults.preProcess,
            ...rawPreProcess,
            mode: ['inject', 'intercept'].includes(String(rawPreProcess.mode))
                ? String(rawPreProcess.mode)
                : defaults.preProcess.mode,
            interceptTiming: ['pre-generation', 'post-main-generation'].includes(String(rawPreProcess.interceptTiming))
                ? String(rawPreProcess.interceptTiming)
                : defaults.preProcess.interceptTiming,
            applyMode: ['replace', 'wrap', 'patch'].includes(String(rawPreProcess.applyMode))
                ? String(rawPreProcess.applyMode)
                : defaults.preProcess.applyMode,
            wrapPosition: ['before', 'after'].includes(String(rawPreProcess.wrapPosition))
                ? String(rawPreProcess.wrapPosition)
                : defaults.preProcess.wrapPosition,
            wrapPrefix: typeof rawPreProcess.wrapPrefix === 'string' ? rawPreProcess.wrapPrefix : defaults.preProcess.wrapPrefix,
            wrapSuffix: typeof rawPreProcess.wrapSuffix === 'string' ? rawPreProcess.wrapSuffix : defaults.preProcess.wrapSuffix,
            patchStartTag: typeof rawPreProcess.patchStartTag === 'string' && rawPreProcess.patchStartTag.trim()
                ? rawPreProcess.patchStartTag
                : defaults.preProcess.patchStartTag,
            patchEndTag: typeof rawPreProcess.patchEndTag === 'string' && rawPreProcess.patchEndTag.trim()
                ? rawPreProcess.patchEndTag
                : defaults.preProcess.patchEndTag,
            maxTokens: normalizePreProcessMaxTokens(rawPreProcess.maxTokens),
        },
        postProcess: {
            ...defaults.postProcess,
            ...rawPostProcess,
            enabled: Boolean(rawPostProcess.enabled),
            type: ['regex', 'append', 'extract'].includes(String(rawPostProcess.type))
                ? String(rawPostProcess.type)
                : defaults.postProcess.type,
            regexFind: typeof rawPostProcess.regexFind === 'string' ? rawPostProcess.regexFind : defaults.postProcess.regexFind,
            regexReplace: typeof rawPostProcess.regexReplace === 'string' ? rawPostProcess.regexReplace : defaults.postProcess.regexReplace,
            regexFlags: typeof rawPostProcess.regexFlags === 'string' ? rawPostProcess.regexFlags : defaults.postProcess.regexFlags,
            appendText: typeof rawPostProcess.appendText === 'string' ? rawPostProcess.appendText : defaults.postProcess.appendText,
            extractPattern: typeof rawPostProcess.extractPattern === 'string' ? rawPostProcess.extractPattern : defaults.postProcess.extractPattern,
            extractVariable: typeof rawPostProcess.extractVariable === 'string' ? rawPostProcess.extractVariable : defaults.postProcess.extractVariable,
            promptTransformEnabled: Boolean(rawPostProcess.promptTransformEnabled),
            promptTransformShowNotifications: Object.hasOwn(rawPostProcess, 'promptTransformShowNotifications')
                ? Boolean(rawPostProcess.promptTransformShowNotifications)
                : defaults.postProcess.promptTransformShowNotifications,
            promptTransformMode: ['rewrite', 'append'].includes(String(rawPostProcess.promptTransformMode))
                ? String(rawPostProcess.promptTransformMode)
                : defaults.postProcess.promptTransformMode,
            promptTransformMaxTokens: Number.isFinite(Number(rawPostProcess.promptTransformMaxTokens))
                ? Math.max(16, Math.min(16000, Number(rawPostProcess.promptTransformMaxTokens)))
                : defaults.postProcess.promptTransformMaxTokens,
        },
        regexScripts: Array.isArray(rawAgent.regexScripts)
            ? rawAgent.regexScripts.map(script => normalizeRegexScript(script ?? {}))
            : defaults.regexScripts,
        enabled: Boolean(rawAgent.enabled),
        favorite: Boolean(rawAgent.favorite),
        phaseLocked: Boolean(rawAgent.phaseLocked),
        conditions: {
            ...defaults.conditions,
            ...conditions,
            triggerKeywords: Array.isArray(conditions.triggerKeywords)
                ? conditions.triggerKeywords.map(keyword => String(keyword ?? '').trim()).filter(Boolean)
                : defaults.conditions.triggerKeywords,
            triggerProbability: Number.isFinite(Number(conditions.triggerProbability))
                ? Math.max(0, Math.min(100, Number(conditions.triggerProbability)))
                : defaults.conditions.triggerProbability,
            generationTypes: Array.isArray(conditions.generationTypes)
                ? conditions.generationTypes.map(type => String(type ?? '').trim()).filter(Boolean)
                : defaults.conditions.generationTypes,
            runOnImpersonate: Object.hasOwn(conditions, 'runOnImpersonate')
                ? Boolean(conditions.runOnImpersonate)
                : defaults.conditions.runOnImpersonate,
        },
        tools: Array.isArray(rawAgent.tools)
            ? rawAgent.tools.map(tool => normalizeToolDef(tool))
            : defaults.tools,
        settings: rawAgent.settings && typeof rawAgent.settings === 'object' && !Array.isArray(rawAgent.settings)
            ? { ...rawAgent.settings }
            : { ...defaults.settings },
    };
}

/**
 * Returns a shallow copy of the agents array.
 * @returns {InChatAgent[]}
 */
export function getAgents() {
    return [...agents];
}

/**
 * Returns enabled agents, sorted by injection order.
 * @returns {InChatAgent[]}
 */
export function getEnabledAgents() {
    if (globalSettings.enabled === false) {
        return [];
    }

    const activeScope = getActiveAgentChatScope();

    return agents
        .filter(agent => isAgentEnabledForScope(agent, activeScope))
        .sort((a, b) => a.injection.order - b.injection.order);
}

/**
 * Finds an agent by ID.
 * @param {string} id
 * @returns {InChatAgent|undefined}
 */
export function getAgentById(id) {
    return agents.find(agent => agent.id === id);
}

/**
 * Returns all tool-category agents.
 * @returns {InChatAgent[]}
 */
export function getToolAgents() {
    return agents.filter(agent => agent.category === 'tool');
}

/**
 * Returns enabled tool agents.
 * @returns {InChatAgent[]}
 */
export function getEnabledToolAgents() {
    if (globalSettings.enabled === false) {
        return [];
    }

    const activeScope = getActiveAgentChatScope();
    return agents.filter(agent => isAgentEnabledForScope(agent, activeScope) && agent.category === 'tool');
}

/**
 * Checks if an agent is a tool-category agent.
 * @param {InChatAgent} agent
 * @returns {boolean}
 */
export function isToolAgent(agent) {
    return agent?.category === 'tool';
}

/**
 * Loads agents from the server settings response.
 * @param {object[]} data - Array of agent objects from settings
 */
export function loadAgents(data) {
    if (Array.isArray(data)) {
        agents = data.map(normalizeAgent);
        refreshAgentRegexScriptCache();
    }
}

/**
 * Saves an agent to the server. Updates local array.
 * @param {InChatAgent} agent
 */
export async function saveAgent(agent) {
    const normalizedAgent = normalizeAgent(agent);
    const index = agents.findIndex(existingAgent => existingAgent.id === normalizedAgent.id);

    if (index >= 0) {
        agents[index] = normalizedAgent;
    } else {
        agents.push(normalizedAgent);
    }
    cacheAgentRegexScriptsForAgent(normalizedAgent);

    const response = await fetch('/api/in-chat-agents/save', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify(normalizedAgent),
    });

    if (!response.ok) {
        throw new Error('Failed to save agent');
    }
}

/**
 * Deletes an agent from the server and local array.
 * @param {string} id
 */
export async function deleteAgent(id) {
    agents = agents.filter(agent => agent.id !== id);
    deleteCachedAgentRegexScripts(id);
    const scopedStateChanged = removeAgentIdFromScopedEnabledAgentIds(id);

    const response = await fetch('/api/in-chat-agents/delete', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ id }),
    });

    if (!response.ok) {
        throw new Error('Failed to delete agent');
    }

    if (scopedStateChanged) {
        persistAgentGlobalSettings();
    }
}

/**
 * Imports agents from a JSON object (single or pack).
 * @param {object} data - Agent or agent pack
 * @returns {InChatAgent[]} - Imported agents
 */
export async function importAgents(data) {
    let agentsToImport = [];

    if (data.format === 'sillybunny-inchat-agents' && Array.isArray(data.agents)) {
        agentsToImport = data.agents;
    } else if (data.id && data.prompt !== undefined) {
        agentsToImport = [data];
    } else {
        throw new Error('Unrecognized agent format');
    }

    const imported = [];
    for (const rawAgent of agentsToImport) {
        const agent = normalizeAgent({ ...createDefaultAgent(), ...rawAgent, id: uuidv4() });
        await saveAgent(agent);
        imported.push(agent);
    }

    return imported;
}

/**
 * Exports all agents as an agent pack.
 * @returns {object}
 */
export function exportAllAgents() {
    return {
        format: 'sillybunny-inchat-agents',
        version: 1,
        agents,
    };
}

/**
 * Exports a single agent.
 * @param {string} id
 * @returns {InChatAgent|null}
 */
export function exportAgent(id) {
    return agents.find(agent => agent.id === id) || null;
}

// ===================== Agent Groups =====================

/**
 * @typedef {object} AgentGroup
 * @property {string} id
 * @property {string} name
 * @property {string} description
 * @property {string[]} agentTemplateIds - Template IDs (tpl-*) included in this group
 * @property {Partial<InChatAgent>[]} customAgents - Custom agent snapshots included in this group
 * @property {boolean} builtin - Whether this is a pre-made group
 */

/**
 * Creates a default empty group.
 * @returns {AgentGroup}
 */
export function createDefaultGroup() {
    return {
        id: uuidv4(),
        name: '',
        description: '',
        agentTemplateIds: [],
        customAgents: [],
        builtin: false,
    };
}

/**
 * Normalizes an agent snapshot used inside custom groups.
 * @param {Partial<InChatAgent>} rawAgent
 * @returns {Partial<InChatAgent>}
 */
function normalizeGroupAgentSnapshot(rawAgent = {}) {
    const normalizedAgent = normalizeAgent(rawAgent);
    delete normalizedAgent.id;
    normalizedAgent.enabled = false;
    return normalizedAgent;
}

/**
 * Normalizes a group payload.
 * @param {Partial<AgentGroup>} rawGroup
 * @param {object} [options]
 * @param {boolean} [options.builtin]
 * @returns {AgentGroup}
 */
function normalizeGroup(rawGroup = {}, { builtin = false } = {}) {
    const defaults = createDefaultGroup();

    return {
        ...defaults,
        ...rawGroup,
        id: typeof rawGroup.id === 'string' && rawGroup.id.trim() ? rawGroup.id.trim() : defaults.id,
        name: String(rawGroup.name ?? '').trim(),
        description: String(rawGroup.description ?? '').trim(),
        agentTemplateIds: Array.isArray(rawGroup.agentTemplateIds)
            ? rawGroup.agentTemplateIds.map(id => String(id ?? '').trim()).filter(Boolean)
            : [],
        customAgents: Array.isArray(rawGroup.customAgents)
            ? rawGroup.customAgents.map(agent => normalizeGroupAgentSnapshot(agent ?? {}))
            : [],
        builtin: builtin || Boolean(rawGroup.builtin),
    };
}

/**
 * Returns all groups (builtin + custom).
 * @returns {AgentGroup[]}
 */
export function getGroups() {
    return [...builtinGroups, ...customGroups];
}

/**
 * Returns custom groups only.
 * @returns {AgentGroup[]}
 */
export function getCustomGroups() {
    return [...customGroups];
}

/**
 * Loads builtin groups from extension templates.
 * @param {AgentGroup[]} data
 */
export function loadBuiltinGroups(data) {
    builtinGroups = Array.isArray(data)
        ? data.map(group => normalizeGroup(group, { builtin: true }))
        : [];
}

/**
 * Loads custom groups from backend storage.
 * @param {AgentGroup[]} data
 */
export function loadCustomGroups(data) {
    customGroups = Array.isArray(data)
        ? data.map(group => normalizeGroup(group, { builtin: false }))
        : [];
}

/**
 * Saves a custom group to the backend and local state.
 * @param {AgentGroup} group
 * @returns {Promise<AgentGroup>}
 */
export async function saveGroup(group) {
    const normalizedGroup = normalizeGroup(group, { builtin: false });
    const index = customGroups.findIndex(existingGroup => existingGroup.id === normalizedGroup.id);

    if (index >= 0) {
        customGroups[index] = normalizedGroup;
    } else {
        customGroups.push(normalizedGroup);
    }

    const response = await fetch('/api/in-chat-agents/groups/save', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify(normalizedGroup),
    });

    if (!response.ok) {
        throw new Error('Failed to save group');
    }

    return normalizedGroup;
}

/**
 * Deletes a custom group by ID.
 * @param {string} id
 */
export async function deleteGroup(id) {
    customGroups = customGroups.filter(group => group.id !== id);

    const response = await fetch('/api/in-chat-agents/groups/delete', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ id }),
    });

    if (!response.ok) {
        throw new Error('Failed to delete group');
    }
}
