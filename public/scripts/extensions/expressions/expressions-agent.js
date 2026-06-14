/**
 * Bridge between the Character Expressions extension and the In-Chat Agents system.
 *
 * SillyBunny divergence: this module lets expression classification run as a companion
 * agent instead of blocking the main generation pipeline with a synchronous classifier.
 *
 * The expressions agent is a bundled companion template (`tpl-expressions-agent`).
 * After each assistant reply the companion classifies the emotional tone and stores the
 * result in `message.extra.inChatAgentCompanionResults`. The expressions extension reads
 * that result here and falls back to the configured fallback expression when the agent
 * is unavailable or has not finished yet.
 */

import { getContext, extension_settings } from '../../extensions.js';
import { system_message_types } from '../../../script.js';
import { normalizeAgentExpressionLabel } from './expressions-agent-utils.js';

const EXPRESSIONS_AGENT_TEMPLATE_ID = 'tpl-expressions-agent';
const QIG_EXTENSION_NAME = 'quick-image-gen';

/**
 * Cached import handles for the companion subsystem. Populated lazily because the
 * in-chat-agents extension loads after expressions (loading_order 20 vs 6).
 * @type {{agentStore?: object, companionShared?: object, qigBridge?: object}}
 */
const moduleCache = {
    agentStore: null,
    companionShared: null,
    qigBridge: null,
};

/**
 * Lazily load the in-chat-agents store. Failure is non-fatal and returns null so the
 * expression extension degrades gracefully when the agent subsystem is disabled.
 * @returns {Promise<object|null>}
 */
async function getAgentStore() {
    if (moduleCache.agentStore) return moduleCache.agentStore;
    try {
        moduleCache.agentStore = await import('../in-chat-agents/agent-store.js');
        return moduleCache.agentStore;
    } catch (error) {
        console.debug('[Expressions Agent] agent-store not available:', error.message);
        return null;
    }
}

/**
 * Lazily load the companion shared constants module.
 * @returns {Promise<object|null>}
 */
async function getCompanionShared() {
    if (moduleCache.companionShared) return moduleCache.companionShared;
    try {
        moduleCache.companionShared = await import('../in-chat-agents/companion/companion-shared.js');
        return moduleCache.companionShared;
    } catch (error) {
        console.debug('[Expressions Agent] companion-shared not available:', error.message);
        return null;
    }
}

/**
 * Lazily load the expression sprite bridge. This avoids pulling in Quick Image Gen
 * until a sprite actually needs to be generated.
 * @returns {Promise<object|null>}
 */
async function getQigBridge() {
    if (moduleCache.qigBridge) return moduleCache.qigBridge;
    try {
        moduleCache.qigBridge = await import('./expression-sprite-bridge.js');
        return moduleCache.qigBridge;
    } catch (error) {
        console.debug('[Expressions Agent] expression-sprite-bridge not available:', error.message);
        return null;
    }
}

/**
 * Returns the last assistant-authored message in the current chat.
 * @param {object} context
 * @returns {object|null}
 */
function getLatestAssistantMessage(context) {
    if (!Array.isArray(context?.chat)) return null;
    for (let i = context.chat.length - 1; i >= 0; i--) {
        const mes = context.chat[i];
        if (!mes || mes.is_user || mes.is_system || mes.extra?.type === system_message_types.NARRATOR) {
            continue;
        }
        return mes;
    }
    return null;
}

/**
 * Find the enabled expressions agent among active in-chat agents.
 * @returns {Promise<object|null>}
 */
export async function getExpressionsAgent() {
    const agentStore = await getAgentStore();
    if (!agentStore) return null;

    const { getEnabledAgents, getAgentById } = agentStore;
    if (typeof getEnabledAgents !== 'function') return null;

    const enabledAgents = getEnabledAgents();
    if (!Array.isArray(enabledAgents)) return null;

    const companionShared = await getCompanionShared();
    const isExpressionsAgent = companionShared?.isExpressionsAgent
        ? companionShared.isExpressionsAgent.bind(companionShared)
        : (agent) => (agent?.sourceTemplateId || agent?.id) === EXPRESSIONS_AGENT_TEMPLATE_ID;

    let agent = enabledAgents.find(isExpressionsAgent);

    // If not found by template id, try a direct id lookup as a fallback.
    if (!agent && typeof getAgentById === 'function') {
        agent = getAgentById(EXPRESSIONS_AGENT_TEMPLATE_ID);
        if (agent && !isExpressionsAgent(agent)) agent = null;
    }

    return agent;
}

/**
 * Check whether the expressions agent is installed, enabled, and ready to use.
 * @returns {Promise<boolean>}
 */
export async function isExpressionsAgentAvailable() {
    const agent = await getExpressionsAgent();
    return Boolean(agent);
}

/**
 * Returns the Quick Image Gen LLM override Connection Manager profile id, if any.
 * @returns {string}
 */
function getQigLlmOverrideProfileId() {
    const qigSettings = extension_settings?.[QIG_EXTENSION_NAME];
    if (!qigSettings?.llmOverrideEnabled) return '';
    return String(qigSettings.llmOverrideProfileId || '').trim();
}

/**
 * Resolve the Connection Manager profile id that should be used by the Expressions Agent.
 *
 * When the user has enabled "Use Quick Image Gen LLM override profile" in the expression
 * settings, the agent shares that profile so classification and QIG's LLM tasks use the
 * same model/endpoint.
 *
 * @param {object} agent - The expressions agent.
 * @returns {string}
 */
export function resolveExpressionsAgentProfile(agent) {
    if (!agent) return '';
    if (extension_settings.expressions.agentUseQigLlmProfile) {
        const qigProfileId = getQigLlmOverrideProfileId();
        if (qigProfileId) return qigProfileId;
    }
    return String(agent.connectionProfile || '');
}

/**
 * Keep the Expressions Agent's connectionProfile in sync with the user's preference.
 * If sharing with QIG is enabled, the agent adopts QIG's LLM override profile. If not,
 * any previously-synced value is cleared so the agent falls back to its own setting.
 *
 * @returns {Promise<boolean>} True if the agent was found and updated.
 */
export async function syncExpressionsAgentProfile() {
    const agent = await getExpressionsAgent();
    if (!agent?.id) return false;

    const agentStore = await getAgentStore();
    if (!agentStore?.saveAgent) return false;

    const targetProfile = extension_settings.expressions.agentUseQigLlmProfile
        ? getQigLlmOverrideProfileId()
        : '';

    const currentProfile = String(agent.connectionProfile || '');
    if (currentProfile === targetProfile) return true;

    agent.connectionProfile = targetProfile;
    await agentStore.saveAgent(agent);
    console.debug('[Expressions Agent] Synced connection profile to:', targetProfile || '(none)');
    return true;
}

/**
 * Read the expression label the companion agent stored for the latest assistant reply.
 *
 * @param {object} [context] - Optional SillyBunny context. Defaults to getContext().
 * @param {string[]} [allowedExpressions] - Optional list of valid expression labels.
 * @returns {Promise<string|null>} The classified expression label, or null if not ready.
 */
export async function getAgentExpressionLabel(context, allowedExpressions) {
    const ctx = context || getContext();
    const message = getLatestAssistantMessage(ctx);
    if (!message?.extra?.inChatAgentCompanionResults) return null;

    const agent = await getExpressionsAgent();
    if (!agent?.id) return null;

    const result = message.extra.inChatAgentCompanionResults[agent.id];
    if (!result || result.status !== 'done' || typeof result.content !== 'string') {
        return null;
    }

    return normalizeAgentExpressionLabel(result.content, allowedExpressions);
}

/**
 * Trigger Quick Image Gen to create a sprite for the given expression. This is best-effort:
 * failures are logged but never block the expression update. The caller is responsible for
 * saving the returned URL into the character's sprite folder via the existing upload path.
 *
 * @param {string} expression - The expression label to generate a sprite for.
 * @returns {Promise<string|null>} A URL/data-URI for the generated image, or null on failure.
 */
export async function maybeGenerateExpressionSprite(expression) {
    if (!expression) return null;

    const qigBridge = await getQigBridge();
    if (!qigBridge?.generateExpressionSprite) {
        console.debug('[Expressions Agent] Quick Image Gen sprite generator is not available');
        return null;
    }

    const context = getContext();
    const charName = context.name2 || 'character';

    try {
        console.debug(`[Expressions Agent] Requesting sprite for ${expression} from QIG`);
        const imageUrl = await qigBridge.generateExpressionSprite(expression, charName);
        return imageUrl || null;
    } catch (error) {
        console.error('[Expressions Agent] Failed to generate sprite:', error);
        return null;
    }
}

/**
 * Remove the inline sprite-generation spinner. Safe to call on chat changes.
 */
export async function cleanupExpressionAgentSpinner() {
    const qigBridge = await getQigBridge();
    if (qigBridge?.cleanupExpressionSpriteSpinner) {
        qigBridge.cleanupExpressionSpriteSpinner();
    }
}
