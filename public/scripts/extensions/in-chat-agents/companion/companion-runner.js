import {
    chat,
    normalizeContentText,
    saveChatDebounced,
    setExtensionPrompt,
    substituteParams,
} from '../../../../script.js';
import { getContext } from '../../../extensions.js';
import { eventSource } from '../../../events.js';
import { getWorldInfoPrompt } from '../../../world-info.js';
import { getConnectionProfileDisplayName } from '../profile-utils.js';
import {
    getAgentById,
    getCompanionConfig,
    getEnabledAgents,
    getGlobalSettings,
    isCompanionAgent,
    normalizeCompanionConfig,
    resolveCompanionConnectionProfile,
} from '../agent-store.js';
import {
    buildPromptDynamicMacros,
    deleteAgentExtraValue,
    getAgentExtraValue,
    getAgentGenerationCancelRevision,
    registerCompanionRuntime,
    requestPromptTransform,
    setAgentExtraValue,
} from '../agent-runner.js';

export const COMPANION_RESULTS_EXTRA_KEY = 'inChatAgentCompanionResults';
export const COMPANION_RESULTS_UPDATED_EVENT = 'in_chat_agent_companion_results_updated';

const MAX_COMPANION_RESULT_CHARS = 64 * 1024;
const COMPANION_PROMPT_KEY_PREFIX = 'inchat_agent_companion_';
const BATCH_MARKER_RE = /<<<COMPANION:([\w-]+)>>>([\s\S]*?)<<<END:\1>>>/g;

let companionRunnerInitialized = false;

function normalizeText(value = '') {
    return normalizeContentText(String(value ?? '')).trim();
}

export function stripMarkdownFence(value = '') {
    const text = String(value ?? '').trim();
    const match = text.match(/^```[\w-]*\s*\n([\s\S]*?)\n```$/);
    return (match ? match[1] : text).trim();
}

function capResultContent(value = '') {
    return stripMarkdownFence(value).slice(0, MAX_COMPANION_RESULT_CHARS);
}

function getProfileLabel(agent, responseProfileId = '') {
    const profileId = String(responseProfileId || resolveCompanionConnectionProfile(agent?.connectionProfile) || '').trim();
    if (!profileId) {
        return 'Main model';
    }

    // Show a friendly profile name or nothing: a raw profile id in the card header reads as noise.
    const displayName = getConnectionProfileDisplayName(profileId);
    return displayName === profileId ? '' : displayName;
}

function getModelLabel(agent = {}) {
    return String(agent?.modelOverride ?? '').trim();
}

export function getCompanionResults(message) {
    const stored = getAgentExtraValue(message, COMPANION_RESULTS_EXTRA_KEY);
    return stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {};
}

export function setCompanionResult(message, agent, update = {}) {
    if (!message || !agent?.id) {
        return null;
    }

    const existingResults = getCompanionResults(message);
    const existing = existingResults[agent.id] && typeof existingResults[agent.id] === 'object'
        ? existingResults[agent.id]
        : {};
    const companion = getCompanionConfig(agent);
    const nextResults = {
        ...existingResults,
        [agent.id]: {
            agentName: String(agent.name ?? '').trim() || 'Companion',
            icon: String(agent.icon ?? '').trim(),
            format: companion.format,
            displayMode: companion.displayMode,
            status: 'pending',
            content: '',
            collapsed: Boolean(existing.collapsed),
            updatedAt: new Date().toISOString(),
            profileLabel: getProfileLabel(agent, update.profileId),
            modelLabel: getModelLabel(agent),
            ...existing,
            ...update,
            format: update.format ?? companion.format,
            displayMode: update.displayMode ?? companion.displayMode,
            updatedAt: update.updatedAt ?? new Date().toISOString(),
        },
    };

    setAgentExtraValue(message, COMPANION_RESULTS_EXTRA_KEY, nextResults);
    return nextResults[agent.id];
}

export function updateCompanionResult(message, agentId, update = {}) {
    const results = getCompanionResults(message);
    if (!message || !agentId || !results[agentId] || typeof results[agentId] !== 'object') {
        return null;
    }

    const nextResults = {
        ...results,
        [agentId]: {
            ...results[agentId],
            ...update,
            updatedAt: update.updatedAt ?? new Date().toISOString(),
        },
    };

    setAgentExtraValue(message, COMPANION_RESULTS_EXTRA_KEY, nextResults);
    return nextResults[agentId];
}

export function deleteCompanionResult(message, agentId) {
    const results = getCompanionResults(message);
    if (!agentId || !Object.hasOwn(results, agentId)) {
        return false;
    }

    const nextResults = { ...results };
    delete nextResults[agentId];

    if (Object.keys(nextResults).length > 0) {
        setAgentExtraValue(message, COMPANION_RESULTS_EXTRA_KEY, nextResults);
    } else {
        deleteAgentExtraValue(message, COMPANION_RESULTS_EXTRA_KEY);
    }

    return true;
}

async function emitCompanionResultsUpdated(messageIndex, agentId = '') {
    if (typeof eventSource?.emit === 'function') {
        await eventSource.emit(COMPANION_RESULTS_UPDATED_EVENT, { messageIndex, agentId });
    }
}

function isAssistantMessage(message) {
    return Boolean(message && !message.is_user && !message.is_system);
}

function getMessageLine(message) {
    const name = String(message?.name ?? '').trim();
    const role = message?.is_user ? 'User' : 'Assistant';
    const label = name || role;
    return `${label}: ${normalizeText(message?.mes ?? '')}`;
}

function getRecentConversationSection(messageIndex, companion) {
    const start = Math.max(0, messageIndex + 1 - companion.contextMessages);
    const lines = chat.slice(start, messageIndex + 1)
        .map(getMessageLine)
        .filter(line => line.trim());
    return lines.length ? lines.join('\n') : '';
}

function getCharacterCardSection(companion) {
    if (!companion.includeCharacterCard && !companion.includePersona) {
        return '';
    }

    const context = getContext();
    const fields = typeof context?.getCharacterCardFields === 'function'
        ? context.getCharacterCardFields()
        : {};
    const parts = [];

    if (companion.includeCharacterCard) {
        for (const [label, value] of [
            ['Description', fields.description],
            ['Personality', fields.personality],
            ['Scenario', fields.scenario],
            ['System', fields.system],
            ['Creator Notes', fields.creatorNotes],
            ['First Message', fields.firstMessage],
            ['Examples', fields.mesExamples],
        ]) {
            const text = normalizeText(value);
            if (text) {
                parts.push(`${label}:\n${text}`);
            }
        }
    }

    if (companion.includePersona) {
        const persona = normalizeText(fields.persona);
        if (persona) {
            parts.push(`Persona:\n${persona}`);
        }
    }

    return parts.join('\n\n');
}

async function getWorldInfoSection(messageIndex, companion) {
    if (!companion.includeWorldInfo) {
        return '';
    }

    try {
        const scanLines = chat.slice(0, messageIndex + 1)
            .map(message => normalizeText(message?.mes ?? ''))
            .filter(Boolean)
            .reverse();
        const result = await getWorldInfoPrompt(scanLines, 4096, true);
        return normalizeText(result?.worldInfoString ?? '');
    } catch (error) {
        console.warn('[InChatAgents] Companion world info scan failed:', error);
        return '';
    }
}

export function collectRecentCompanionResults(agentId, { beforeMessageIndex = chat.length, depth = 1 } = {}) {
    const results = [];
    const maxDepth = Math.max(1, Math.min(10, Number(depth) || 1));

    for (let index = Math.min(beforeMessageIndex - 1, chat.length - 1); index >= 0 && results.length < maxDepth; index--) {
        const message = chat[index];
        if (!isAssistantMessage(message)) {
            continue;
        }

        const result = getCompanionResults(message)[agentId];
        if (result?.status === 'done' && normalizeText(result.content)) {
            results.push({
                messageIndex: index,
                ...result,
            });
        }
    }

    return results;
}

function getPreviousNotesSection(agent, messageIndex, companion) {
    if (!companion.includeHistory) {
        return '';
    }

    return collectRecentCompanionResults(agent.id, {
        beforeMessageIndex: messageIndex,
        depth: companion.historyDepth,
    }).map(result => `Message ${result.messageIndex}:\n${normalizeText(result.content)}`).join('\n\n');
}

async function buildCompanionContextSections(agent, messageIndex) {
    const companion = getCompanionConfig(agent);
    const sections = [];
    const characterCard = getCharacterCardSection(companion);
    const worldInfo = await getWorldInfoSection(messageIndex, companion);
    const previousNotes = getPreviousNotesSection(agent, messageIndex, companion);
    const recentConversation = getRecentConversationSection(messageIndex, companion);

    for (const [title, content] of [
        ['Character', characterCard],
        ['World Info', worldInfo],
        ['Your previous notes', previousNotes],
        ['Recent conversation', recentConversation],
    ]) {
        if (content) {
            sections.push(`[${title}]\n${content}`);
        }
    }

    return sections.join('\n\n');
}

// Companion prompts were written to ride along with a story reply; running standalone —
// especially on small models — they continue the scene unless told the story is not theirs
// to write. These guards stack on top of rawPrompt, which only suppresses format instructions.
const TRACKER_GUARD_INSTRUCTION = 'Output only the tracker state in the exact format the instructions above define. Do not continue the story: no narration, no dialogue, no commentary.';
const COMPANION_GUARD_INSTRUCTION = 'You are an auxiliary companion, not the roleplayer. Do not continue the roleplay, write story prose, or speak as any character. Output only what your instructions ask for.';
// Small models weigh the end of the prompt heaviest, and the context ends with roleplay
// dialogue begging to be continued — anchor the task after it.
const COMPANION_TASK_ANCHOR = '[Task]\nFollow your instructions on the conversation above. Output only what they ask for — do not continue the conversation itself.';

function getCompanionGuardInstruction(agent) {
    return agent?.category === 'tracker' ? TRACKER_GUARD_INSTRUCTION : COMPANION_GUARD_INSTRUCTION;
}

function getFormatInstruction(format) {
    switch (format) {
        case 'html':
            return 'Return only safe HTML for the companion card body. Do not include scripts, styles, forms, iframes, or markdown fences.';
        case 'text':
            return 'Return only plain text for the companion card body. Do not include markdown fences.';
        case 'markdown':
        default:
            return 'Return only markdown for the companion card body. Do not include a preamble or markdown fences.';
    }
}

function expandCompanionPrompt(agent, messageIndex, generationType = 'normal') {
    const message = chat[messageIndex];
    const messageText = normalizeText(message?.mes ?? '');
    return substituteParams(agent.prompt, {
        name2Override: String(message?.name ?? '').trim(),
        original: messageText,
        dynamicMacros: buildPromptDynamicMacros(messageText, message, agent, generationType),
    }).trim();
}

export async function buildCompanionPromptMessages(agent, messageIndex, generationType = 'normal') {
    const companion = getCompanionConfig(agent);
    const expandedPrompt = expandCompanionPrompt(agent, messageIndex, generationType);
    const contextSections = await buildCompanionContextSections(agent, messageIndex);
    // rawPrompt sends the agent prompt verbatim: tracker prompts define their own exact output
    // format and break when extra format instructions are appended around them.
    const systemContent = [
        expandedPrompt,
        companion.rawPrompt ? '' : getFormatInstruction(companion.format),
        getCompanionGuardInstruction(agent),
    ].filter(Boolean).join('\n\n');

    return [
        {
            role: 'system',
            content: systemContent.trim(),
        },
        {
            role: 'user',
            content: `${contextSections || '[Recent conversation]\nNo conversation context is available.'}\n\n${COMPANION_TASK_ANCHOR}`,
        },
    ];
}

function getBatchKey(agent, messageIndex) {
    const companion = getCompanionConfig(agent);
    return JSON.stringify({
        profile: resolveCompanionConnectionProfile(agent.connectionProfile),
        model: String(agent.modelOverride ?? '').trim(),
        contextMessages: companion.contextMessages,
        includeCharacterCard: companion.includeCharacterCard,
        includePersona: companion.includePersona,
        includeWorldInfo: companion.includeWorldInfo,
        includeHistory: companion.includeHistory,
        historyDepth: companion.historyDepth,
        messageIndex,
    });
}

function partitionCompanionRuns(agents, messageIndex) {
    const singles = [];
    const batchBuckets = new Map();

    for (const agent of agents) {
        const companion = getCompanionConfig(agent);
        if (!companion.batch) {
            singles.push({ type: 'single', agent });
            continue;
        }

        const key = getBatchKey(agent, messageIndex);
        const bucket = batchBuckets.get(key) ?? [];
        bucket.push(agent);
        batchBuckets.set(key, bucket);
    }

    const batches = [];
    for (const bucket of batchBuckets.values()) {
        if (bucket.length < 2) {
            singles.push({ type: 'single', agent: bucket[0] });
        } else {
            batches.push({ type: 'batch', agents: bucket });
        }
    }

    return [...batches, ...singles];
}

function parseBatchResponse(output = '') {
    const parsed = new Map();
    BATCH_MARKER_RE.lastIndex = 0;

    for (const match of String(output ?? '').matchAll(BATCH_MARKER_RE)) {
        parsed.set(match[1], capResultContent(match[2]));
    }

    return parsed;
}

async function runSingleCompanionAgent(agent, messageIndex, generationType, cancelRevision) {
    const message = chat[messageIndex];
    if (!isAssistantMessage(message)) {
        return null;
    }

    const companion = getCompanionConfig(agent);

    try {
        if (getAgentGenerationCancelRevision() !== cancelRevision) {
            throw new DOMException('Companion run cancelled.', 'AbortError');
        }

        const promptMessages = await buildCompanionPromptMessages(agent, messageIndex, generationType);
        const response = await requestPromptTransform(agent, promptMessages, companion.maxTokens);

        if (getAgentGenerationCancelRevision() !== cancelRevision) {
            setCompanionResult(message, agent, {
                status: 'cancelled',
                content: '',
                error: 'Cancelled.',
                profileId: response.profileId,
                profileLabel: getProfileLabel(agent, response.profileId),
                modelLabel: getModelLabel(agent),
            });
            await emitCompanionResultsUpdated(messageIndex, agent.id);
            return getCompanionResults(message)[agent.id];
        }

        setCompanionResult(message, agent, {
            status: 'done',
            content: capResultContent(response.output),
            error: '',
            profileId: response.profileId,
            profileLabel: getProfileLabel(agent, response.profileId),
            modelLabel: getModelLabel(agent),
        });
    } catch (error) {
        const cancelled = getAgentGenerationCancelRevision() !== cancelRevision || error?.name === 'AbortError';
        setCompanionResult(message, agent, {
            status: cancelled ? 'cancelled' : 'error',
            content: '',
            error: cancelled ? 'Cancelled.' : (error instanceof Error ? error.message : String(error)),
        });
    }

    await emitCompanionResultsUpdated(messageIndex, agent.id);
    return getCompanionResults(message)[agent.id];
}

async function buildBatchPromptMessages(agents, messageIndex, generationType) {
    const contextSections = await buildCompanionContextSections(agents[0], messageIndex);
    const tasks = agents.map(agent => {
        const companion = getCompanionConfig(agent);
        const formatLines = companion.rawPrompt ? [] : ['Output format:', getFormatInstruction(companion.format)];
        return [
            `<<<COMPANION:${agent.id}>>>`,
            `Agent: ${String(agent.name ?? '').trim() || agent.id}`,
            'Instruction:',
            expandCompanionPrompt(agent, messageIndex, generationType),
            ...formatLines,
            getCompanionGuardInstruction(agent),
            `<<<END:${agent.id}>>>`,
        ].join('\n');
    }).join('\n\n');

    return [
        {
            role: 'system',
            content: 'Run each Companion task independently. Return every result inside its matching <<<COMPANION:agentId>>> and <<<END:agentId>>> markers. Do not add text outside markers.',
        },
        {
            role: 'user',
            content: `${contextSections || '[Recent conversation]\nNo conversation context is available.'}\n\n[Companion tasks]\n${tasks}\n\nReturn every result inside its markers now. Do not continue the conversation itself.`,
        },
    ];
}

async function runBatchCompanionAgents(agents, messageIndex, generationType, cancelRevision) {
    const message = chat[messageIndex];
    if (!isAssistantMessage(message)) {
        return [];
    }

    try {
        const promptMessages = await buildBatchPromptMessages(agents, messageIndex, generationType);
        const maxTokens = Math.min(16000, agents.reduce((sum, agent) => sum + normalizeCompanionConfig(agent.companion).maxTokens, 0));
        const response = await requestPromptTransform(agents[0], promptMessages, maxTokens);

        if (getAgentGenerationCancelRevision() !== cancelRevision) {
            for (const agent of agents) {
                setCompanionResult(message, agent, {
                    status: 'cancelled',
                    content: '',
                    error: 'Cancelled.',
                    profileId: response.profileId,
                    profileLabel: getProfileLabel(agent, response.profileId),
                    modelLabel: getModelLabel(agent),
                });
                await emitCompanionResultsUpdated(messageIndex, agent.id);
            }
            return agents.map(agent => getCompanionResults(message)[agent.id]);
        }

        const parsed = parseBatchResponse(response.output);
        const missingAgents = [];
        for (const agent of agents) {
            if (!parsed.has(agent.id)) {
                missingAgents.push(agent);
                continue;
            }

            setCompanionResult(message, agent, {
                status: 'done',
                content: parsed.get(agent.id),
                error: '',
                profileId: response.profileId,
                profileLabel: getProfileLabel(agent, response.profileId),
                modelLabel: getModelLabel(agent),
            });
            await emitCompanionResultsUpdated(messageIndex, agent.id);
        }

        for (const agent of missingAgents) {
            await runSingleCompanionAgent(agent, messageIndex, generationType, cancelRevision);
        }
    } catch (error) {
        console.warn('[InChatAgents] Companion batch failed, falling back to individual runs:', error);
        for (const agent of agents) {
            await runSingleCompanionAgent(agent, messageIndex, generationType, cancelRevision);
        }
    }

    return agents.map(agent => getCompanionResults(message)[agent.id]);
}

async function runCompanionUnit(unit, messageIndex, generationType, cancelRevision) {
    if (unit.type === 'batch') {
        return await runBatchCompanionAgents(unit.agents, messageIndex, generationType, cancelRevision);
    }

    return await runSingleCompanionAgent(unit.agent, messageIndex, generationType, cancelRevision);
}

function getRunnableCompanionAgents(activeAgents = [], { manual = false } = {}) {
    return activeAgents.filter(agent => {
        const companion = getCompanionConfig(agent);
        return isCompanionAgent(agent) &&
            String(agent.prompt ?? '').trim() &&
            (manual || companion.trigger === 'auto');
    });
}

export async function runCompanionStage({ messageIndex, message, generationType = 'normal', activeAgents = [] } = {}) {
    if (!isAssistantMessage(message)) {
        return [];
    }

    const agents = getRunnableCompanionAgents(activeAgents);
    if (agents.length === 0) {
        return [];
    }

    for (const agent of agents) {
        setCompanionResult(message, agent, {
            status: 'pending',
            content: '',
            error: '',
        });
        await emitCompanionResultsUpdated(messageIndex, agent.id);
    }

    const cancelRevision = getAgentGenerationCancelRevision();
    const units = partitionCompanionRuns(agents, messageIndex);
    const executionMode = getGlobalSettings().companionExecutionMode === 'sequential' ? 'sequential' : 'parallel';

    if (executionMode === 'sequential') {
        for (const unit of units) {
            await runCompanionUnit(unit, messageIndex, generationType, cancelRevision);
        }
    } else {
        await Promise.all(units.map(unit => runCompanionUnit(unit, messageIndex, generationType, cancelRevision)));
    }

    saveChatDebounced({ deferBackup: false });
    return agents.map(agent => getCompanionResults(message)[agent.id]);
}

export function injectCompanionFeedbackPrompts(activeAgents = []) {
    for (const agent of activeAgents) {
        if (!isCompanionAgent(agent)) {
            continue;
        }

        const companion = getCompanionConfig(agent);
        if (!companion.feedback?.enabled) {
            continue;
        }

        const notes = collectRecentCompanionResults(agent.id, {
            beforeMessageIndex: chat.length,
            depth: companion.feedback.depth,
        });
        if (notes.length === 0) {
            continue;
        }

        const body = notes.map(result => normalizeText(result.content)).filter(Boolean).join('\n\n');
        if (!body) {
            continue;
        }

        setExtensionPrompt(
            COMPANION_PROMPT_KEY_PREFIX + agent.id,
            `[${String(agent.name ?? 'Companion').trim()} - auxiliary notes]\n${body}`,
            agent.injection.position,
            agent.injection.depth,
            agent.injection.scan,
            agent.injection.role,
        );
    }
}

export async function runCompanionAgentOnMessage(agentId, messageIndex, { cancelRevision = getAgentGenerationCancelRevision() } = {}) {
    const agent = getAgentById(agentId);
    const message = chat[messageIndex];
    if (!agent || !isCompanionAgent(agent) || !isAssistantMessage(message)) {
        return null;
    }

    setCompanionResult(message, agent, {
        status: 'pending',
        content: '',
        error: '',
    });
    await emitCompanionResultsUpdated(messageIndex, agent.id);
    const result = await runSingleCompanionAgent(agent, messageIndex, 'normal', cancelRevision);
    saveChatDebounced({ deferBackup: false });
    return result;
}

export async function runCompanionsOnMessage(messageIndex) {
    const message = chat[messageIndex];
    if (!isAssistantMessage(message)) {
        return [];
    }

    const agents = getRunnableCompanionAgents(getEnabledAgents(), { manual: true });
    if (agents.length === 0) {
        return [];
    }

    for (const agent of agents) {
        setCompanionResult(message, agent, {
            status: 'pending',
            content: '',
            error: '',
        });
        await emitCompanionResultsUpdated(messageIndex, agent.id);
    }

    const cancelRevision = getAgentGenerationCancelRevision();
    const units = partitionCompanionRuns(agents, messageIndex);
    const executionMode = getGlobalSettings().companionExecutionMode === 'sequential' ? 'sequential' : 'parallel';

    if (executionMode === 'sequential') {
        for (const unit of units) {
            await runCompanionUnit(unit, messageIndex, 'normal', cancelRevision);
        }
    } else {
        await Promise.all(units.map(unit => runCompanionUnit(unit, messageIndex, 'normal', cancelRevision)));
    }

    saveChatDebounced({ deferBackup: false });
    return agents.map(agent => getCompanionResults(message)[agent.id]);
}

export function initCompanionRunner() {
    if (companionRunnerInitialized) {
        return;
    }

    companionRunnerInitialized = true;
    registerCompanionRuntime({
        runCompanionStage,
        injectCompanionFeedbackPrompts,
        runCompanionAgentOnMessage,
    });
}
