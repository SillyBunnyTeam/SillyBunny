import { uuidv4 } from '../../utils.js';
import {
    createDefaultAgent,
    DEFAULT_AGENT_MAX_TOKENS,
    findTemplateForAgentSnapshot,
    getAgentRegexScripts,
    getGlobalSettings,
    isAgentEnabledForCurrentScope,
    normalizeAgentCategory,
} from './agent-store.js';
import { normalizeRegexScript } from './regex-scripts.js';

export const DEFAULT_BUNDLED_TEMPLATE_IDS = new Set([]);
export const INTERNAL_BUNDLED_TEMPLATE_IDS = new Set([
    'tpl-pathfinder',
]);
export const HIDDEN_TEMPLATE_BROWSER_IDS = new Set([
    'tpl-pathfinder',
]);
export const REMOVED_BUNDLED_TEMPLATE_IDS = new Set([
    'tpl-anti-slop-regex',
    'tpl-director-core',
    'tpl-nsfw-mode',
]);
const REMOVED_BUNDLED_AGENT_NAMES = new Set(['anti-slop regex', 'director core', 'nsfw mode']);
const BUNDLED_REGEX_POST_DEFAULT_EXCLUDED_TEMPLATE_IDS = new Set(['tpl-chatroom-companion', 'tpl-message-inbox-companion']);

export function findSourceTemplateForAgent(agent, templates = []) {
    const sourceTemplateId = String(agent?.sourceTemplateId ?? '').trim();
    return sourceTemplateId ? templates.find(template => template.id === sourceTemplateId) ?? null : null;
}

export function getAgentOrderValue(agent) {
    const order = Number(agent?.injection?.order ?? 0);
    return Number.isFinite(order) ? order : 0;
}

export function getAgentVersionValue(agent) {
    const version = Number(agent?.version ?? 1);
    return Number.isFinite(version) ? version : 1;
}

export function getTemplateVersionValue(template) {
    const version = Number(template?.version ?? 1);
    return Number.isFinite(version) ? version : 1;
}

export function hasTemplateUpdate(agent, templates = []) {
    const sourceTemplate = findSourceTemplateForAgent(agent, templates);
    return Boolean(sourceTemplate && getTemplateVersionValue(sourceTemplate) > getAgentVersionValue(agent));
}

export function getAgentsWithTemplateUpdates(agents = [], templates = []) {
    return agents.filter(agent => hasTemplateUpdate(agent, templates));
}

function getBundledRegexScriptsForTemplate(templateId, regexBundles) {
    const bundledScripts = regexBundles[String(templateId ?? '').trim()];
    return Array.isArray(bundledScripts) ? bundledScripts.map(script => normalizeRegexScript(script ?? {})) : [];
}

export function shouldUseTrackerPromptPassDefaults(template) {
    return String(template?.category ?? '') === 'tracker';
}

function applyBundledTrackerPromptPass(template) {
    if (!shouldUseTrackerPromptPassDefaults(template)) return template;
    const postProcess = template?.postProcess && typeof template.postProcess === 'object' ? template.postProcess : {};
    return {
        ...template,
        phase: 'pre',
        postProcess: {
            ...postProcess,
            promptTransformEnabled: false,
            promptTransformShowNotifications: Object.hasOwn(postProcess, 'promptTransformShowNotifications')
                ? Boolean(postProcess.promptTransformShowNotifications) : true,
            promptTransformMode: 'append',
            promptTransformMaxTokens: Number.isFinite(Number(postProcess.promptTransformMaxTokens))
                ? Number(postProcess.promptTransformMaxTokens) : DEFAULT_AGENT_MAX_TOKENS,
        },
    };
}

export function isBundledRegexPostDefaultTemplate(template, bundledScripts = null, { regexBundles = {} } = {}) {
    const templateId = String(template?.id ?? '').trim();
    if (!template || shouldUseTrackerPromptPassDefaults(template) || BUNDLED_REGEX_POST_DEFAULT_EXCLUDED_TEMPLATE_IDS.has(templateId)) return false;
    const resolvedScripts = Array.isArray(bundledScripts) ? bundledScripts
        : (Array.isArray(template.regexScripts) ? template.regexScripts : getBundledRegexScriptsForTemplate(templateId, regexBundles));
    return resolvedScripts.length > 0;
}

function applyBundledRegexPostDefaults(template, bundledScripts) {
    if (!isBundledRegexPostDefaultTemplate(template, bundledScripts)) return template;
    const postProcess = template?.postProcess && typeof template.postProcess === 'object' ? template.postProcess : {};
    const hasPrompt = Boolean(String(template?.prompt ?? '').trim());
    return {
        ...template,
        phase: 'post',
        postProcess: {
            ...postProcess,
            promptTransformEnabled: hasPrompt ? true : Boolean(postProcess.promptTransformEnabled),
            promptTransformShowNotifications: Object.hasOwn(postProcess, 'promptTransformShowNotifications')
                ? Boolean(postProcess.promptTransformShowNotifications) : true,
            promptTransformMode: hasPrompt ? (shouldUseTrackerPromptPassDefaults(template) ? 'append' : 'rewrite')
                : (postProcess.promptTransformMode === 'append' ? 'append' : 'rewrite'),
            promptTransformMaxTokens: Number.isFinite(Number(postProcess.promptTransformMaxTokens))
                ? Number(postProcess.promptTransformMaxTokens) : DEFAULT_AGENT_MAX_TOKENS,
        },
    };
}

export function mergeTemplateDefaults(template, { regexBundles = {} } = {}) {
    const normalizedTemplate = { ...template, category: normalizeAgentCategory(template?.category, template?.id, template?.name) };
    const templateWithPromptPass = applyBundledTrackerPromptPass(normalizedTemplate);
    const bundledScripts = getBundledRegexScriptsForTemplate(templateWithPromptPass?.id, regexBundles);
    const templateWithRegexPostDefaults = applyBundledRegexPostDefaults(templateWithPromptPass, bundledScripts);
    return {
        ...templateWithRegexPostDefaults,
        regexScripts: bundledScripts.length > 0 ? bundledScripts : getAgentRegexScripts(templateWithRegexPostDefaults),
    };
}

export function getDefaultBundledTemplates(templates = []) {
    return templates.filter(template => {
        const templateId = String(template?.id ?? '').trim();
        return DEFAULT_BUNDLED_TEMPLATE_IDS.has(templateId) || INTERNAL_BUNDLED_TEMPLATE_IDS.has(templateId);
    });
}

export function buildAgentFromTemplate(template, options = {}) {
    const agent = {
        ...createDefaultAgent(),
        ...structuredClone(mergeTemplateDefaults(template, options)),
        id: uuidv4(),
        sourceTemplateId: template.id,
        enabled: false,
    };
    delete agent.subcategory;
    return agent;
}

export function buildUpdatedAgentFromTemplate(agent, template, options = {}) {
    const updatedAgent = buildAgentFromTemplate(template, options);
    updatedAgent.id = agent.id;
    updatedAgent.enabled = Boolean(agent.enabled);
    updatedAgent.favorite = Boolean(agent.favorite);
    updatedAgent.connectionProfile = typeof agent.connectionProfile === 'string' ? agent.connectionProfile : '';
    updatedAgent.modelOverride = typeof agent.modelOverride === 'string' ? agent.modelOverride : '';
    updatedAgent.injection = { ...updatedAgent.injection, order: getAgentOrderValue(agent) };
    updatedAgent.phaseLocked = false;
    return updatedAgent;
}

export function buildAgentFromSnapshot(snapshot) {
    return { ...createDefaultAgent(), ...structuredClone(snapshot), id: uuidv4(), enabled: false };
}

function getComparableAgentSnapshot(agent) {
    const snapshot = structuredClone(agent || {});
    delete snapshot.id;
    delete snapshot.enabled;
    delete snapshot.favorite;
    return snapshot;
}

function stableAgentComparableValue(value) {
    if (Array.isArray(value)) return value.map(stableAgentComparableValue);
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
            .map(([key, entryValue]) => [key, stableAgentComparableValue(entryValue)]));
    }
    return value;
}

function getComparableAgentKey(agent) {
    return JSON.stringify(stableAgentComparableValue(getComparableAgentSnapshot(agent)));
}

export function hasIdenticalAgent(agent, existingAgents = []) {
    const candidateKey = getComparableAgentKey(agent);
    const candidateName = String(agent?.name ?? '').trim();
    return existingAgents.some(existing => String(existing?.name ?? '').trim() === candidateName && getComparableAgentKey(existing) === candidateKey);
}

export function hasMatchingAgentSnapshot(snapshot, existingAgents = []) {
    const snapshotTemplateId = String(snapshot?.sourceTemplateId ?? '').trim();
    const snapshotName = String(snapshot?.name ?? '').trim().toLowerCase();
    const snapshotPrompt = String(snapshot?.prompt ?? '').trim();
    return existingAgents.some(agent => {
        const existingTemplateId = String(agent?.sourceTemplateId ?? '').trim();
        const existingName = String(agent?.name ?? '').trim().toLowerCase();
        const existingPrompt = String(agent?.prompt ?? '').trim();
        if (snapshotTemplateId && existingTemplateId === snapshotTemplateId) return true;
        if (snapshotTemplateId && snapshotName && existingName === snapshotName) return true;
        if (!snapshotName || existingName !== snapshotName) return false;
        return snapshotPrompt ? existingPrompt === snapshotPrompt : true;
    });
}

export function isRemovedBundledAgent(agent) {
    return REMOVED_BUNDLED_TEMPLATE_IDS.has(String(agent?.sourceTemplateId ?? '').trim())
        || (REMOVED_BUNDLED_AGENT_NAMES.has(String(agent?.name ?? '').trim().toLowerCase()) && String(agent?.author ?? '').trim().toLowerCase() === 'sillybunny');
}

export function isPathfinderAgent(agent) {
    return agent?.sourceTemplateId === 'tpl-pathfinder' || agent?.name === 'Pathfinder'
        || (agent?.category === 'tool' && agent?.tools?.some(tool => tool.name?.startsWith('Pathfinder_')));
}

export async function ensureDefaultBundledAgents(context) {
    let touchedSeedState = false;
    for (const template of getDefaultBundledTemplates(context.templates)) {
        const templateId = String(template?.id ?? '').trim();
        if (!templateId) continue;
        if (INTERNAL_BUNDLED_TEMPLATE_IDS.has(templateId) || !context.autoSeededTemplateIds.has(templateId)) {
            const seededAgent = buildAgentFromTemplate(template, context);
            if (!hasMatchingAgentSnapshot(seededAgent, context.getAgents())) await context.saveAgent(seededAgent);
        }
        if (!context.autoSeededTemplateIds.has(templateId)) {
            context.autoSeededTemplateIds.add(templateId);
            touchedSeedState = true;
        }
    }
    if (touchedSeedState) context.persistState();
}

export function listAgentEntries({ agents, templates, regexBundles = {} }) {
    const entries = agents.filter(agent => !isPathfinderAgent(agent) && !isRemovedBundledAgent(agent)).map(agent => {
        const template = findSourceTemplateForAgent(agent, templates);
        return { key: `agent:${agent.id}`, kind: 'agent', agent, template, subcategory: String(template?.subcategory ?? '').trim() };
    });
    const savedTemplateIds = new Set(agents.map(agent => String(agent.sourceTemplateId ?? '').trim()));
    for (const template of templates) {
        if (savedTemplateIds.has(template.id) || HIDDEN_TEMPLATE_BROWSER_IDS.has(template.id) || REMOVED_BUNDLED_TEMPLATE_IDS.has(template.id)) continue;
        const agent = {
            ...structuredClone(mergeTemplateDefaults(template, { regexBundles })),
            id: template.id,
            sourceTemplateId: template.id,
            enabled: false,
            favorite: Boolean(template.favorite),
        };
        delete agent.subcategory;
        entries.push({ key: `agent-template:${template.id}`, kind: 'agent-template', agent, template, subcategory: String(template.subcategory ?? '').trim() });
    }
    return entries;
}

const RESERVED_EDIT_FIELDS = new Set(['id', 'sourceTemplateId', 'enabled', 'subcategory']);
const MERGED_EDIT_FIELDS = new Set(['injection', 'preProcess', 'postProcess', 'conditions', 'companion', 'settings']);

function applyAgentEdits(agent, edits) {
    for (const [key, value] of Object.entries(edits)) {
        if (RESERVED_EDIT_FIELDS.has(key)) continue;
        const clonedValue = structuredClone(value);
        agent[key] = MERGED_EDIT_FIELDS.has(key) && clonedValue && typeof clonedValue === 'object' && !Array.isArray(clonedValue)
            ? { ...agent[key], ...clonedValue } : clonedValue;
    }
    return agent;
}

async function saveEnabledAgent(agent, context) {
    const settings = getGlobalSettings();
    const previousScopeState = {
        enabledAgentIdsByChatType: structuredClone(settings.enabledAgentIdsByChatType),
        scopedEnabledAgentIdsInitialized: settings.scopedEnabledAgentIdsInitialized,
    };
    let saved;
    try {
        if (settings.separateRecentChats) context.initializeScopedAgentEnableState();
        context.setAgentEnabledForCurrentScope(agent, true);
        saved = await context.saveAgent(agent);
    } catch (error) {
        // Restore the trusted snapshot directly: setGlobalSettings re-infers legacy initialization.
        Object.assign(getGlobalSettings(), previousScopeState);
        throw error;
    }
    context.persistState();
    return saved;
}

export async function materialise(templateId, { enable = false, favorite, edits = {} } = {}, context) {
    const template = context.templates.find(template => template.id === templateId);
    if (!template) throw new Error(`Unknown agent template: ${templateId}`);
    const existing = context.getAgents().find(agent => String(agent.sourceTemplateId ?? '').trim() === templateId);
    const agent = applyAgentEdits(existing ? structuredClone(existing) : buildAgentFromTemplate(template, context), edits);
    if (favorite !== undefined) agent.favorite = Boolean(favorite);
    return enable ? saveEnabledAgent(agent, context) : context.saveAgent(agent);
}

export function buildRestoredAgentFromTemplate(agent, template, options = {}) {
    return {
        ...buildAgentFromTemplate(template, options),
        id: agent.id,
        enabled: Boolean(agent.enabled),
        favorite: Boolean(agent.favorite),
        connectionProfile: agent.connectionProfile,
        modelOverride: agent.modelOverride,
    };
}

export async function restoreDefault(agentId, context) {
    const agent = context.getAgents().find(agent => agent.id === agentId);
    if (!agent) return null;
    const template = findTemplateForAgentSnapshot(agent, context.templates);
    if (!template) return null;
    return context.saveAgent(buildRestoredAgentFromTemplate(agent, template, context));
}

export async function resetBundledAgents(context) {
    const agents = context.getAgents().filter(agent => !isPathfinderAgent(agent));
    const missingDefaults = getDefaultBundledTemplates(context.templates)
        .filter(template => !HIDDEN_TEMPLATE_BROWSER_IDS.has(template.id))
        .filter(template => !hasMatchingAgentSnapshot(buildAgentFromTemplate(template, context), agents));
    let reset = 0;
    for (const agent of agents) {
        if (await restoreDefault(agent.id, context)) reset++;
    }
    for (const template of missingDefaults) {
        await context.saveAgent(buildAgentFromTemplate(template, context));
        context.autoSeededTemplateIds.add(template.id);
    }
    if (missingDefaults.length > 0) context.persistState();
    return { reset, added: missingDefaults.length };
}

export async function duplicate(key, context) {
    const separator = key.indexOf(':');
    const kind = key.slice(0, separator);
    const id = key.slice(separator + 1);
    const source = kind === 'agent' ? context.getAgents().find(agent => agent.id === id)
        : kind === 'agent-template' ? context.templates.find(template => template.id === id) : null;
    if (!source) throw new Error(`Unknown agent entry: ${key}`);
    const copy = kind === 'agent' ? buildAgentFromSnapshot(source) : buildAgentFromTemplate(source, context);
    copy.sourceTemplateId = '';
    const sharesTemplateName = context.templates.some(template => String(template.name ?? '').trim().toLowerCase() === String(copy.name ?? '').trim().toLowerCase());
    if (source.sourceTemplateId || sharesTemplateName || findTemplateForAgentSnapshot(copy, context.templates)) {
        if (typeof context.t !== 'function') throw new TypeError('Agent duplication requires a translated copy name.');
        const name = copy.name;
        copy.name = context.t`${name} (Copy)`;
    }
    return context.saveAgent(copy);
}

function findMatchingSavedAgent(snapshot, agents) {
    const templateId = String(snapshot.sourceTemplateId ?? '').trim();
    return (templateId ? agents.find(agent => String(agent.sourceTemplateId ?? '').trim() === templateId) : null)
        ?? agents.find(agent => hasMatchingAgentSnapshot(snapshot, [agent]));
}

export async function turnOnGroup(group, context) {
    const resolved = new Map();
    const addSnapshot = snapshot => {
        const candidates = [...context.getAgents(), ...Array.from(resolved.values(), entry => entry.agent)];
        const existing = findMatchingSavedAgent(snapshot, candidates);
        const agent = existing ?? snapshot;
        if (!resolved.has(agent.id)) resolved.set(agent.id, { agent, added: !existing });
    };
    for (const id of group.agentTemplateIds ?? []) {
        const template = context.templates.find(template => template.id === id);
        if (template) addSnapshot(buildAgentFromTemplate(template, context));
    }
    for (const snapshot of group.customAgents ?? []) addSnapshot(buildAgentFromSnapshot(snapshot));
    if (!group.builtin && !group.customAgents?.length) {
        for (const id of group.agentTemplateIds ?? []) {
            if (context.templates.some(template => template.id === id)) continue;
            const agent = context.getAgents().find(agent => agent.id === id);
            if (agent && !resolved.has(agent.id)) resolved.set(agent.id, { agent, added: false });
        }
    }
    let added = 0;
    let enabled = 0;
    for (const { agent, added: isNew } of resolved.values()) {
        const wasEnabled = isAgentEnabledForCurrentScope(agent);
        if (isNew || !wasEnabled) await saveEnabledAgent(structuredClone(agent), context);
        if (isNew) added++;
        if (!wasEnabled) enabled++;
    }
    return { added, enabled, agentIds: [...resolved.keys()] };
}
