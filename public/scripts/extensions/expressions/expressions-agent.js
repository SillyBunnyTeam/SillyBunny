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

import { getContext } from '../../extensions.js';
import { system_message_types } from '../../../script.js';
import { normalizeAgentExpressionLabel } from './expressions-agent-utils.js';

const EXPRESSIONS_AGENT_TEMPLATE_ID = 'tpl-expressions-agent';

/**
 * Cached import handles for the companion subsystem. Populated lazily because the
 * in-chat-agents extension loads after expressions (loading_order 20 vs 6).
 * @type {{agentStore?: object, companionShared?: object}}
 */
const moduleCache = {
    agentStore: null,
    companionShared: null,
    qig: null,
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
 * Lazily load the Quick Image Gen extension module.
 * @returns {Promise<object|null>}
 */
async function getQigModule() {
    if (moduleCache.qig) return moduleCache.qig;
    try {
        moduleCache.qig = await import('../quick-image-gen/index.js');
        return moduleCache.qig;
    } catch (error) {
        console.debug('[Expressions Agent] quick-image-gen not available:', error.message);
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

    const qig = await getQigModule();
    if (!qig?.generateExpressionSprite) {
        console.debug('[Expressions Agent] Quick Image Gen sprite generator is not available');
        return null;
    }

    const context = getContext();
    const charName = context.name2 || 'character';

    try {
        console.debug(`[Expressions Agent] Requesting sprite for ${expression} from QIG`);
        const imageUrl = await qig.generateExpressionSprite(expression, charName);
        return imageUrl || null;
    } catch (error) {
        console.error('[Expressions Agent] Failed to generate sprite:', error);
        return null;
    }
}
