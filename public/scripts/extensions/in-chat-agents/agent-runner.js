import {
    chat,
    chat_metadata,
    ensureSwipes,
    extension_prompt_roles,
    extension_prompt_types,
    extension_prompts,
    setExtensionPrompt,
    substituteParams,
    generateQuietPrompt,
    getCurrentChatId,
    normalizeContentText,
    saveChatDebounced,
    stopGeneration,
    streamingProcessor,
    syncMesToSwipe,
    updateMessageTokenAccounting,
} from '../../../script.js';
import { getContext } from '../../extensions.js';
import { eventSource, event_types } from '../../events.js';
import { ToolManager } from '../../tool-calling.js';
import {
    areAgentsGloballyEnabled,
    getAgentById,
    getAgentRegexScripts,
    getEnabledAgents,
    getEnabledToolAgents,
    getGlobalSettings,
    getPromptTransformMode,
    isCompanionAgent,
    isTrackerFixAgent,
    isPathfinderSubmoduleEnabled,
    saveAgent,
    isToolAgent,
    normalizePreProcessMaxTokens,
    normalizePromptTransformMaxTokens,
    resolveCompanionConnectionProfile,
    resolveConnectionProfile,
} from './agent-store.js';
import { regexFromString } from '../../utils.js';
import { buildFallbackPromptText, extractProfileResponseText } from './llm-utils.js';
import { getConnectionProfileDisplayName, getConnectionProfileModelName } from './profile-utils.js';
import {
    appendHelperPrefillMessages,
    parseHelperPrefillMessages,
} from '../helper-prefill.js';
import {
    getToolAction,
    getToolFormatter,
} from './tool-action-registry.js';
import {
    getSettings as getPathfinderRuntimeSettings,
    setSettings as setPathfinderRuntimeSettings,
} from './pathfinder/tree-store.js';
import { getPathfinderToolDefinitions } from './pathfinder/tool-definitions.js';
import { getContextualLorebooks } from './pathfinder/pathfinder-tool-bridge.js';
import { PATHFINDER_RETRIEVAL_PROMPT_KEYS, runSidecarRetrieval } from './pathfinder/sidecar-retrieval.js';
import { shouldAutoSummarize } from './pathfinder/auto-summary.js';
import { buildRegexScriptRefsForAgent, cacheAgentRegexScripts, migrateLegacyRegexSnapshotsInMessages } from './regex-snapshot-store.js';

const PROMPT_KEY_PREFIX = 'inchat_agent_';
const PATHFINDER_AUTO_SUMMARY_PROMPT_KEY = 'pathfinder_zz_auto_summary';
const MESSAGE_EXTRA_KEY = 'inChatAgents';
const POST_PROCESSING_RUNS_EXTRA_KEY = 'inChatAgentPostRuns';
const PATHFINDER_RETRIEVAL_CACHE_EXTRA_KEY = 'pathfinderRetrievalCache';
export const PROMPT_RUNS_EXTRA_KEY = 'inChatAgentPromptRuns';
export const PROMPT_TRANSFORM_HISTORY_KEY = 'inChatAgentTransformHistory';
export const PRE_GENERATION_INTERCEPT_HISTORY_KEY = 'inChatAgentPreGenerationInterceptHistory';
const MAX_TRANSFORM_HISTORY = 10;
const MAX_PATHFINDER_RETRIEVAL_CACHE = 6;
const PATHFINDER_RETRIEVAL_CONTEXT_MESSAGE_LIMIT = 10;
const pendingRefreshTimeouts = new Map();
const pendingRegexSnapshotSaves = new WeakSet();
const migratedLegacyRegexSnapshotChatIds = new Set();
const GREETING_GENERATION_TYPE = 'first_message';
const IMPERSONATE_GENERATION_TYPE = 'impersonate';
const PREPEND_PROMPT_TRANSFORM_TEMPLATE_IDS = new Set([
    'tpl-scene-tracker',
    'tpl-time-tracker',
]);
const IMPERSONATE_PROMPT_TRANSFORM_TEMPLATE_IDS = new Set([
    'tpl-prose-polisher',
]);
const PREPEND_PROMPT_TRANSFORM_TAG_RE = /\[(?:SCENE|TIME)\|/;
const ASSISTANT_RESPONSE_WRAPPER_RE = /^\s*<assistant_response>\s*([\s\S]*?)\s*<\/assistant_response>\s*$/i;
const CONTEXT_INTERCEPT_OUTPUT_RE = /^\s*<context>\s*([\s\S]*?)\s*<\/context>\s*$/i;
const BODY_GENERATING_FLAG_GRACE_MS = 1500;
const DEFERRED_POST_PROCESSING_RETRY_MS = 50;
const LATEST_ASSISTANT_POST_PROCESSING_FALLBACK_WINDOW_MS = 30000;
const MISSED_GENERATION_END_RECOVERY_MS = 200;
const PATHFINDER_SUMMARIZE_TOOL_NAME = 'Pathfinder_Summarize';
const PRE_GENERATION_INTERCEPT_TIMING = 'pre-generation';
const POST_MAIN_GENERATION_INTERCEPT_TIMING = 'post-main-generation';

/** @type {{ generationType: string, activeAgentIds: string[], chatId: string } | null} */
let pendingGenerationSnapshot = null;
let internalPromptTransformDepth = 0;
let isGenerationInProgress = false;
let generationStopRequested = false;
const deferredPostProcessingQueue = new Map();
let deferredPostProcessingTimeout = null;
let latestAssistantPostProcessingFallbackTimeout = null;
let latestAssistantPostProcessingFallbackDeadline = 0;
let postGenerationRecoveryTimeout = null;
let missedGenerationEndRecoveryTimeout = null;
let agentRunnerInitialized = false;
let postGenerationRecoveryHooksInitialized = false;
let postGenerationRecoveryObserver = null;
const activePromptTransformToasts = new Set();
const agentGenerationStateListeners = new Set();
const manualAgentRunQueue = [];
let manualAgentRunQueueProcessing = false;
let manualAgentRunCancelRequested = false;
let activeManualAgentRun = null;
let parallelManualRunCount = 0;
let agentGenerationCancelRevision = 0;
const promptTransformIdleResolvers = new Set();
let pendingPreGenerationInterceptRuns = [];
let generationStartChatId = '';
let postProcessingInvalidatedByChatChange = false;
let generationStartChatLength = 0;
let generationStartLastAssistantIndex = -1;
let generationStartLastAssistantMessage = null;
let generationStartLastAssistantRevision = '';
let generationStartedAt = 0;
let lastMainGenerationEndedAt = 0;
let currentMainGenerationType = 'normal';
let postProcessingGenerationRunId = 0;
let swipeNavigationPending = false;
const activeAgentRequestAbortControllers = new Set();
const activePathfinderRetrievalAbortControllers = new Set();
let activePathfinderRetrievalToast = null;
let activeInitialGenerationToast = null;
let companionRuntime = null;

export function registerCompanionRuntime(runtime = null) {
    companionRuntime = runtime && typeof runtime === 'object' ? runtime : null;
}

export function getAgentGenerationCancelRevision() {
    return agentGenerationCancelRevision;
}

function shouldDeferAgentRegularBackup() {
    return Boolean(isGenerationInProgress || internalPromptTransformDepth > 0 || isMainGenerationStillActive());
}

function getLatestUserMessageText() {
    for (let index = chat.length - 1; index >= 0; index--) {
        const message = chat[index];
        if (message?.is_user) {
            return String(message.mes ?? '');
        }
    }

    return '';
}

function isRegexLiteral(value = '') {
    return /^\/[\s\S]+\/[a-z]*$/i.test(String(value ?? '').trim());
}

function companionTriggerMatches(keyword, messageText) {
    const normalizedKeyword = String(keyword ?? '').trim();
    if (!normalizedKeyword) {
        return false;
    }

    if (isRegexLiteral(normalizedKeyword)) {
        try {
            const regex = regexFromString(normalizedKeyword);
            if (regex instanceof RegExp) {
                return regex.test(messageText);
            }
        } catch (error) {
            console.warn('[InChatAgents] Invalid Companion trigger regex:', normalizedKeyword, error);
        }
    }

    return messageText.toLowerCase().includes(normalizedKeyword.toLowerCase());
}

function saveChatDebouncedForAgent({ deferBackup = shouldDeferAgentRegularBackup() } = {}) {
    saveChatDebounced({ deferBackup: Boolean(deferBackup) });
}

async function saveChatForAgent(context, { deferBackup = shouldDeferAgentRegularBackup() } = {}) {
    if (typeof context?.saveChat !== 'function') {
        return;
    }

    await context.saveChat({ deferBackup: Boolean(deferBackup) });
}

function migrateLegacyRegexSnapshotsForCurrentChat(chatId = getCurrentChatId()) {
    const migrationKey = String(chatId ?? '');
    if (!migrationKey || migratedLegacyRegexSnapshotChatIds.has(migrationKey) || chat.length === 0) {
        return;
    }

    migratedLegacyRegexSnapshotChatIds.add(migrationKey);
    const migrated = migrateLegacyRegexSnapshotsInMessages(chat, MESSAGE_EXTRA_KEY);
    if (migrated > 0) {
        saveChatDebounced();
    }
}

/** Track which tool names were registered by the agent system so we can cleanly unregister only our own. */
const agentRegisteredToolNames = new Set();

/** Guard to prevent re-registration during generation when WORLDINFO_UPDATED fires. */
let toolSyncDuringGeneration = false;

/** Recursion depth tracker for tool-call passes. */
let toolRecursionDepth = 0;

/** Tracks automatic post-processing per generated message revision so fallback events cannot double-apply agents. */
const processedPostProcessingRuns = new WeakMap();
const processedPostProcessingRunsByIndex = new Map();
const postProcessingInFlightKeys = new Set();
const stoppedStreamingMessageIndexes = new Set();
let stoppedGenerationRunId = -1;

function escapeToastHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

export function isAgentGenerationActive() {
    return internalPromptTransformDepth > 0 || manualAgentRunQueueProcessing || manualAgentRunQueue.length > 0 || parallelManualRunCount > 0;
}

export function onAgentGenerationStateChanged(listener) {
    if (typeof listener !== 'function') {
        return () => {};
    }

    agentGenerationStateListeners.add(listener);
    return () => agentGenerationStateListeners.delete(listener);
}

function notifyAgentGenerationStateChanged() {
    const active = isAgentGenerationActive();

    for (const listener of agentGenerationStateListeners) {
        try {
            listener(active);
        } catch (error) {
            console.warn('[InChatAgents] Agent generation state listener failed:', error);
        }
    }
}

function notifyPromptTransformIdle() {
    if (internalPromptTransformDepth > 0) {
        return;
    }

    const resolvers = [...promptTransformIdleResolvers];
    promptTransformIdleResolvers.clear();

    for (const resolve of resolvers) {
        resolve();
    }

    scheduleDeferredPostProcessingFlush(0);
}

function waitForPromptTransformIdle() {
    if (internalPromptTransformDepth === 0) {
        return Promise.resolve();
    }

    return new Promise(resolve => promptTransformIdleResolvers.add(resolve));
}

function clearManualAgentRunQueue() {
    const queuedRuns = manualAgentRunQueue.splice(0);

    for (const queuedRun of queuedRuns) {
        queuedRun.resolve(null);
    }

    return queuedRuns.length;
}

export function cancelAgentGeneration() {
    const wasActive = isAgentGenerationActive();
    const queuedCount = clearManualAgentRunQueue();
    manualAgentRunCancelRequested = true;
    agentGenerationCancelRevision++;

    if (internalPromptTransformDepth > 0) {
        generationStopRequested = true;
    }

    clearLatestAssistantPostProcessingFallback();
    clearDeferredPostProcessing();
    clearMissedGenerationEndRecoveryCheck();
    clearAllPromptTransformRunningToasts();
    clearInitialGenerationToast();
    clearPathfinderRetrievalToast();
    abortActiveAgentRequests('Agent generation cancelled by user.');
    abortActivePathfinderRetrieval('Pathfinder retrieval cancelled by user.');

    const stopped = internalPromptTransformDepth > 0 || activeManualAgentRun ? stopGeneration() : false;
    notifyAgentGenerationStateChanged();

    if (stopped || wasActive || queuedCount > 0) {
        toastr.info(queuedCount > 0 ? `Stopping agent generation and clearing ${queuedCount} queued run${queuedCount === 1 ? '' : 's'}...` : 'Stopping agent generation...');
        return true;
    }

    toastr.info('No agent generation is currently running.');
    return false;
}

function skipPostMainInterceptChanges() {
    agentGenerationCancelRevision++;
    abortActiveAgentRequests('Post-main intercept changes skipped by user.');
    clearAllPromptTransformRunningToasts();
    notifyAgentGenerationStateChanged();
}

function abortActiveAgentRequests(reason = 'Agent generation cancelled.') {
    const error = reason instanceof Error ? reason : new Error(String(reason));

    for (const controller of activeAgentRequestAbortControllers) {
        controller.abort(error);
    }

    activeAgentRequestAbortControllers.clear();
}

function isAbortSignalTriggered(error, signal = null) {
    return Boolean(signal?.aborted || error?.name === 'AbortError');
}

function abortActivePathfinderRetrieval(reason = 'Pathfinder retrieval cancelled.') {
    const error = reason instanceof Error ? reason : new Error(String(reason));

    for (const controller of activePathfinderRetrievalAbortControllers) {
        controller.abort(error);
    }

    activePathfinderRetrievalAbortControllers.clear();
}

function showPathfinderRetrievalToast() {
    if (activePathfinderRetrievalToast) {
        return;
    }

    activePathfinderRetrievalToast = toastr.info('Pathfinder is processing lore for this reply...', 'Please wait', { timeOut: 0, extendedTimeOut: 0 });
}

function clearPathfinderRetrievalToast() {
    if (!activePathfinderRetrievalToast) {
        return;
    }

    toastr.clear(activePathfinderRetrievalToast);
    activePathfinderRetrievalToast = null;
}

function showInitialGenerationToast() {
    if (activeInitialGenerationToast) {
        return;
    }

    activeInitialGenerationToast = toastr.info('Generating initial message', 'In-Chat Agents', { timeOut: 0, extendedTimeOut: 0 });
}

function clearInitialGenerationToast() {
    if (!activeInitialGenerationToast) {
        return;
    }

    toastr.clear(activeInitialGenerationToast);
    activeInitialGenerationToast = null;
}

function shouldShowPathfinderRetrievalToast(pathfinderAgent) {
    const settings = pathfinderAgent?.settings ?? {};
    return Boolean(settings.pipelineEnabled || settings.sidecarEnabled);
}

async function processManualAgentRunQueue() {
    if (manualAgentRunQueueProcessing) {
        return;
    }

    manualAgentRunQueueProcessing = true;
    notifyAgentGenerationStateChanged();

    try {
        while (manualAgentRunQueue.length > 0) {
            if (manualAgentRunCancelRequested) {
                break;
            }

            await waitForPromptTransformIdle();

            if (manualAgentRunCancelRequested) {
                break;
            }

            const queuedRun = manualAgentRunQueue.shift();
            if (!queuedRun) {
                continue;
            }

            activeManualAgentRun = queuedRun;
            notifyAgentGenerationStateChanged();

            try {
                const result = await executeManualAgentRun(queuedRun.agentId, queuedRun.messageIndex, queuedRun.cancelRevision);
                queuedRun.resolve(result);
            } catch (error) {
                queuedRun.reject(error);
            } finally {
                activeManualAgentRun = null;
                notifyAgentGenerationStateChanged();
            }
        }
    } finally {
        clearManualAgentRunQueue();
        manualAgentRunCancelRequested = false;
        manualAgentRunQueueProcessing = false;
        activeManualAgentRun = null;
        notifyAgentGenerationStateChanged();
    }
}

function enqueueManualAgentRun(agentId, messageIndex) {
    const wasAlreadyActive = isAgentGenerationActive();
    manualAgentRunCancelRequested = false;
    if (!isGenerationInProgress) {
        generationStopRequested = false;
    }

    const executionMode = getGlobalSettings().appendAgentsExecutionMode === 'sequential' ? 'sequential' : 'parallel';
    const cancelRevision = agentGenerationCancelRevision;

    if (executionMode === 'parallel') {
        if (wasAlreadyActive) {
            toastr.info('Running agent in parallel.');
        }

        parallelManualRunCount++;
        notifyAgentGenerationStateChanged();

        return (async () => {
            try {
                return await executeManualAgentRun(agentId, messageIndex, cancelRevision);
            } finally {
                parallelManualRunCount = Math.max(0, parallelManualRunCount - 1);
                notifyAgentGenerationStateChanged();
            }
        })();
    }

    return new Promise((resolve, reject) => {
        manualAgentRunQueue.push({
            agentId,
            messageIndex,
            cancelRevision,
            resolve,
            reject,
        });

        if (wasAlreadyActive) {
            toastr.info('Queued agent run.');
        }

        notifyAgentGenerationStateChanged();
        void processManualAgentRunQueue();
    });
}

function isPathfinderToolAgent(agent) {
    return agent?.sourceTemplateId === 'tpl-pathfinder' ||
        agent?.name === 'Pathfinder' ||
        (agent?.category === 'tool' && agent?.tools?.some(tool => tool.name?.startsWith('Pathfinder_')));
}

export function getPathfinderRuntimeAgent(agents = getEnabledToolAgents()) {
    if (!isPathfinderSubmoduleEnabled()) {
        return null;
    }

    return agents.find(isPathfinderToolAgent) ?? null;
}

function getAgentToolByName(agent, toolName) {
    return Array.isArray(agent?.tools)
        ? agent.tools.find(tool => tool?.name === toolName)
        : null;
}

function isPathfinderToolEnabledForAgent(agent, toolName) {
    const states = agent?.settings?.toolStates;
    if (states && typeof states === 'object' && Object.prototype.hasOwnProperty.call(states, toolName)) {
        return states[toolName] !== false;
    }

    const savedTool = getAgentToolByName(agent, toolName);
    return savedTool?.enabled !== false;
}

function getPathfinderToolStateMap(agent) {
    return Object.fromEntries(
        getPathfinderToolDefinitions().map(tool => [tool.name, isPathfinderToolEnabledForAgent(agent, tool.name)]),
    );
}

function syncPathfinderRuntimeSettings(agent = getPathfinderRuntimeAgent()) {
    const currentRuntimeSettings = getPathfinderRuntimeSettings();
    const nextRuntimeSettings = agent?.settings
        ? {
            ...agent.settings,
            toolStates: getPathfinderToolStateMap(agent),
            pipelinePrompts: currentRuntimeSettings.pipelinePrompts,
            pipelines: currentRuntimeSettings.pipelines,
        }
        : {
            pipelinePrompts: currentRuntimeSettings.pipelinePrompts,
            pipelines: currentRuntimeSettings.pipelines,
        };

    setPathfinderRuntimeSettings(nextRuntimeSettings);
}

function getRegisterableAgentTools(agent) {
    if (isPathfinderToolAgent(agent)) {
        if (!isPathfinderSubmoduleEnabled()) {
            return [];
        }

        const enabledTools = getPathfinderToolDefinitions()
            .filter(tool => isPathfinderToolEnabledForAgent(agent, tool.name));

        if (agent?.settings?.sidecarEnabled) {
            return enabledTools;
        }

        return enabledTools.filter(tool => tool.name === PATHFINDER_SUMMARIZE_TOOL_NAME);
    }

    return (agent.tools ?? []).filter(tool => tool.enabled !== false);
}

function isPathfinderSummarizeToolEnabled(agent) {
    return isPathfinderToolEnabledForAgent(agent, PATHFINDER_SUMMARIZE_TOOL_NAME);
}

export function getToolRecursionState() {
    return {
        depth: toolRecursionDepth,
        limit: ToolManager.RECURSE_LIMIT ?? 5,
        registeredToolNames: [...agentRegisteredToolNames],
    };
}

export async function syncPathfinderAgentLorebooksForCurrentChat(agent = getPathfinderRuntimeAgent(), { persist = false } = {}) {
    if (!isPathfinderSubmoduleEnabled()) {
        return false;
    }

    if (!agent || !isPathfinderToolAgent(agent)) {
        return false;
    }

    const existingSettings = {
        ...getPathfinderRuntimeSettings(),
        ...(agent.settings || {}),
    };
    if (existingSettings.autoSyncLorebooksOnChatChange === false) {
        return false;
    }

    const contextualBooks = Array.from(new Set(getContextualLorebooks().filter(Boolean)));
    const currentBooks = Array.isArray(existingSettings.enabledLorebooks) ? existingSettings.enabledLorebooks : [];
    const sameBooks = currentBooks.length === contextualBooks.length && currentBooks.every((book, index) => book === contextualBooks[index]);
    const selectedLorebook = contextualBooks[0] ?? '';

    if (sameBooks && (existingSettings.selectedLorebook ?? '') === selectedLorebook) {
        return false;
    }

    const nextSettings = {
        ...existingSettings,
        enabledLorebooks: contextualBooks,
        selectedLorebook,
    };
    agent.settings = {
        ...(agent.settings || {}),
        ...nextSettings,
    };
    setPathfinderRuntimeSettings(nextSettings);

    if (persist) {
        await saveAgent(agent);
    }

    console.info('[Pathfinder] Synced enabled lorebooks to the current chat context.', {
        lorebooks: contextualBooks,
    });
    return true;
}

/**
 * Syncs tool registrations for all enabled tool-category agents.
 * Unregisters tools from disabled agents, registers tools from enabled ones.
 */
export function syncToolAgentRegistrations() {
    if (toolSyncDuringGeneration) {
        return;
    }

    const desiredTools = new Set();
    const enabledToolAgents = areAgentsGloballyEnabled() ? getEnabledToolAgents() : [];
    syncPathfinderRuntimeSettings(getPathfinderRuntimeAgent(enabledToolAgents));

    for (const agent of enabledToolAgents) {
        const enabledTools = getRegisterableAgentTools(agent);
        for (const tool of enabledTools) {
            desiredTools.add(tool.name);
        }
    }

    for (const name of agentRegisteredToolNames) {
        if (!desiredTools.has(name)) {
            ToolManager.unregisterFunctionTool(name);
            agentRegisteredToolNames.delete(name);
        }
    }

    for (const agent of enabledToolAgents) {
        const enabledTools = getRegisterableAgentTools(agent);
        for (const toolDef of enabledTools) {
            const action = getToolAction(toolDef.actionKey);
            if (!action) {
                console.warn(`[InChatAgents] Tool "${toolDef.name}" has actionKey "${toolDef.actionKey}" with no registered action. Skipping.`);
                continue;
            }

            const formatMessage = getToolFormatter(toolDef.formatMessageKey) ?? (async () => `Calling ${toolDef.displayName}...`);

            ToolManager.registerFunctionTool({
                name: toolDef.name,
                displayName: toolDef.displayName,
                description: toolDef.description,
                parameters: toolDef.parameters,
                action,
                formatMessage,
                shouldRegister: async () => true,
                stealth: toolDef.stealth ?? false,
            });

            agentRegisteredToolNames.add(toolDef.name);
        }
    }
}

/**
 * Unregisters all agent-owned tools from ToolManager.
 */
export function unregisterAllAgentTools() {
    for (const name of agentRegisteredToolNames) {
        ToolManager.unregisterFunctionTool(name);
    }
    agentRegisteredToolNames.clear();
}

function normalizeGenerationType(generationType) {
    switch (String(generationType ?? '').trim().toLowerCase()) {
        case 'continue':
        case GREETING_GENERATION_TYPE:
        case 'impersonate':
        case 'quiet':
            return String(generationType).trim().toLowerCase();
        default:
            return 'normal';
    }
}

function isGreetingGenerationType(generationType) {
    return String(generationType ?? '').trim().toLowerCase() === GREETING_GENERATION_TYPE;
}

function isImpersonateGenerationType(generationType) {
    return normalizeGenerationType(generationType) === IMPERSONATE_GENERATION_TYPE;
}

function getUserMessageName() {
    try {
        const context = getContext();
        const userName = String(context?.name1 ?? '').trim();

        return userName || 'User';
    } catch {
        return 'User';
    }
}

function getStreamingTarget(messageIndex) {
    if (!Number.isInteger(Number(messageIndex))) {
        return null;
    }

    const liveStreamingProcessor = streamingProcessor;
    if (!liveStreamingProcessor || Number(liveStreamingProcessor.messageId) !== Number(messageIndex)) {
        return null;
    }

    return liveStreamingProcessor;
}

function isStreamingMessageStillActive(messageIndex) {
    const liveStreamingProcessor = getStreamingTarget(messageIndex);
    if (!liveStreamingProcessor) {
        return false;
    }

    return Boolean(
        !liveStreamingProcessor.isFinished ||
        isGenerationInProgress ||
        isBodyGenerationFlagBlocking(),
    );
}

function isBodyGenerationFlagBlocking() {
    if (document.body?.dataset?.generating !== 'true') {
        return false;
    }

    if (isGenerationInProgress) {
        return true;
    }

    if (!lastMainGenerationEndedAt) {
        return false;
    }

    return Date.now() - lastMainGenerationEndedAt < BODY_GENERATING_FLAG_GRACE_MS;
}

function isMainGenerationStillActive() {
    return Boolean(
        isGenerationInProgress ||
        isBodyGenerationFlagBlocking(),
    );
}

function wasStreamingMessageStopped(messageIndex) {
    const numericMessageIndex = Number(messageIndex);
    if (!Number.isInteger(numericMessageIndex)) {
        return false;
    }

    if (stoppedStreamingMessageIndexes.has(numericMessageIndex)) {
        return true;
    }

    const liveStreamingProcessor = getStreamingTarget(messageIndex);
    if (!liveStreamingProcessor) {
        return false;
    }

    const isStopped = Boolean(
        generationStopRequested ||
        liveStreamingProcessor.isStopped ||
        liveStreamingProcessor.abortController?.signal?.aborted,
    );

    if (isStopped) {
        stoppedStreamingMessageIndexes.add(numericMessageIndex);
    }

    return isStopped;
}

function clearDeferredPostProcessing(messageIndex = null) {
    if (messageIndex !== null && messageIndex !== undefined) {
        const numericMessageIndex = Number(messageIndex);
        if (Number.isInteger(numericMessageIndex)) {
            deferredPostProcessingQueue.delete(numericMessageIndex);
        }
    } else {
        deferredPostProcessingQueue.clear();
    }

    if (deferredPostProcessingQueue.size === 0 && deferredPostProcessingTimeout) {
        clearTimeout(deferredPostProcessingTimeout);
        deferredPostProcessingTimeout = null;
    }
}

function clearLatestAssistantPostProcessingFallback() {
    if (!latestAssistantPostProcessingFallbackTimeout) {
        latestAssistantPostProcessingFallbackDeadline = 0;
        return;
    }

    clearTimeout(latestAssistantPostProcessingFallbackTimeout);
    latestAssistantPostProcessingFallbackTimeout = null;
    latestAssistantPostProcessingFallbackDeadline = 0;
}

function clearPostGenerationRecoveryCheck() {
    if (!postGenerationRecoveryTimeout) {
        return;
    }

    clearTimeout(postGenerationRecoveryTimeout);
    postGenerationRecoveryTimeout = null;
}

function clearMissedGenerationEndRecoveryCheck() {
    if (!missedGenerationEndRecoveryTimeout) {
        return;
    }

    clearTimeout(missedGenerationEndRecoveryTimeout);
    missedGenerationEndRecoveryTimeout = null;
}

function clearPostGenerationStateAfterCompletion() {
    if (
        isGenerationInProgress ||
        internalPromptTransformDepth > 0 ||
        postProcessingInFlightKeys.size > 0 ||
        deferredPostProcessingQueue.size > 0 ||
        generationStopRequested ||
        postProcessingInvalidatedByChatChange
    ) {
        return;
    }

    pendingGenerationSnapshot = null;
    clearLatestAssistantPostProcessingFallback();
    clearPostGenerationRecoveryCheck();
    clearMissedGenerationEndRecoveryCheck();
}

function normalizeSnapshotChatId(chatId) {
    return chatId === null || chatId === undefined ? '' : String(chatId);
}

function getCurrentSnapshotChatId() {
    try {
        return normalizeSnapshotChatId(getCurrentChatId());
    } catch {
        return '';
    }
}

function isActivationSnapshotForCurrentChat(snapshot) {
    if (!snapshot) {
        return false;
    }

    return normalizeSnapshotChatId(snapshot.chatId) === getCurrentSnapshotChatId();
}

function isCurrentGenerationChatStale() {
    return generationStartChatId && generationStartChatId !== getCurrentSnapshotChatId();
}

function clearPendingPostProcessingForChatChange() {
    if (isGenerationInProgress || pendingGenerationSnapshot || deferredPostProcessingQueue.size > 0) {
        postProcessingInvalidatedByChatChange = true;
    }

    isGenerationInProgress = false;
    toolSyncDuringGeneration = false;
    generationStopRequested = false;
    generationStartChatId = getCurrentSnapshotChatId();
    pendingGenerationSnapshot = null;
    processedPostProcessingRunsByIndex.clear();
    clearDeferredPostProcessing();
    clearLatestAssistantPostProcessingFallback();
    clearPostGenerationRecoveryCheck();
    clearMissedGenerationEndRecoveryCheck();
}

function clearStalePendingGenerationSnapshot() {
    if (!pendingGenerationSnapshot || isActivationSnapshotForCurrentChat(pendingGenerationSnapshot)) {
        return false;
    }

    clearPendingPostProcessingForChatChange();
    return true;
}

function cloneActivationSnapshot(snapshot, generationType) {
    const normalizedGenerationType = normalizeGenerationType(snapshot?.generationType ?? generationType);
    const snapshotChatId = snapshot && Object.hasOwn(snapshot, 'chatId')
        ? snapshot.chatId
        : getCurrentSnapshotChatId();

    return {
        generationType: normalizedGenerationType,
        activeAgentIds: Array.isArray(snapshot?.activeAgentIds)
            ? [...snapshot.activeAgentIds]
            : [],
        chatId: normalizeSnapshotChatId(snapshotChatId),
    };
}

function normalizeMessageRunValue(value) {
    if (value instanceof Date) {
        return value.toISOString();
    }

    if (value === null || value === undefined) {
        return '';
    }

    return String(value);
}

function getActiveSwipeInfo(message, { create = false } = {}) {
    if (!message || message.is_user || message.is_system) {
        return null;
    }

    if (create) {
        ensureSwipes(message);
    }

    if (typeof message.swipe_id !== 'number' || !Array.isArray(message.swipe_info)) {
        return null;
    }

    const swipeInfo = message.swipe_info[message.swipe_id];
    if (!swipeInfo || typeof swipeInfo !== 'object') {
        return null;
    }

    if (create && (!swipeInfo.extra || typeof swipeInfo.extra !== 'object')) {
        swipeInfo.extra = {};
    }

    return swipeInfo;
}

function cloneAgentExtraValue(value) {
    return value === undefined ? undefined : structuredClone(value);
}

export function getAgentExtraValue(message, key) {
    const swipeInfo = getActiveSwipeInfo(message);
    if (swipeInfo?.extra) {
        return swipeInfo.extra[key];
    }

    return message?.extra?.[key];
}

export function setAgentExtraValue(message, key, value) {
    if (!message) {
        return;
    }

    message.extra ??= {};
    message.extra[key] = value;

    const swipeInfo = getActiveSwipeInfo(message, { create: true });
    if (swipeInfo?.extra) {
        swipeInfo.extra[key] = cloneAgentExtraValue(value);
    }
}

export function deleteAgentExtraValue(message, key) {
    if (!message) {
        return;
    }

    if (message.extra && Object.hasOwn(message.extra, key)) {
        delete message.extra[key];
    }

    const swipeInfo = getActiveSwipeInfo(message);
    if (swipeInfo?.extra && Object.hasOwn(swipeInfo.extra, key)) {
        delete swipeInfo.extra[key];
    }
}

function hasAgentExtraValue(message, key) {
    const swipeInfo = getActiveSwipeInfo(message);
    if (swipeInfo?.extra) {
        return Object.hasOwn(swipeInfo.extra, key);
    }

    return Boolean(
        (message?.extra && Object.hasOwn(message.extra, key)),
    );
}

function syncAssistantMessageTextToSwipe(message) {
    if (!message || message.is_user || message.is_system) {
        return;
    }

    ensureSwipes(message);

    if (typeof message.swipe_id === 'number' && Array.isArray(message.swipes) && typeof message.swipes[message.swipe_id] === 'string') {
        message.swipes[message.swipe_id] = message.mes;
    }
}

function getPostProcessingRunKey(message, generationType, activationSnapshot = null) {
    const snapshotAgentIds = Array.isArray(activationSnapshot?.activeAgentIds)
        ? activationSnapshot.activeAgentIds.join(',')
        : '';
    const swipeInfo = getActiveSwipeInfo(message);

    return [
        normalizeGenerationType(activationSnapshot?.generationType ?? generationType),
        normalizeMessageRunValue(swipeInfo?.gen_started ?? message?.gen_started),
        normalizeMessageRunValue(swipeInfo?.gen_finished ?? message?.gen_finished),
        normalizeMessageRunValue(swipeInfo?.send_date ?? message?.send_date),
        normalizeMessageRunValue(message?.swipe_id),
        snapshotAgentIds,
    ].join('|');
}

function getPostProcessingIndexRunKey(message, messageIndex, generationType, activationSnapshot = null) {
    const numericMessageIndex = Number(messageIndex);
    if (!Number.isInteger(numericMessageIndex)) {
        return '';
    }

    const snapshotAgentIds = Array.isArray(activationSnapshot?.activeAgentIds)
        ? activationSnapshot.activeAgentIds.join(',')
        : '';

    return [
        postProcessingGenerationRunId,
        numericMessageIndex,
        Number.isInteger(Number(message?.swipe_id)) ? Number(message.swipe_id) : 0,
        normalizeGenerationType(activationSnapshot?.generationType ?? generationType),
        snapshotAgentIds,
    ].join('|');
}

function getStoredPostProcessingRuns(message) {
    const storedRuns = getAgentExtraValue(message, POST_PROCESSING_RUNS_EXTRA_KEY);
    return Array.isArray(storedRuns)
        ? storedRuns
        : [];
}

function getMessageRevisionKey(message) {
    const swipeInfo = getActiveSwipeInfo(message);

    return [
        normalizeMessageRunValue(swipeInfo?.gen_started ?? message?.gen_started),
        normalizeMessageRunValue(swipeInfo?.gen_finished ?? message?.gen_finished),
        normalizeMessageRunValue(swipeInfo?.send_date ?? message?.send_date),
        normalizeMessageRunValue(message?.swipe_id),
    ].join('|');
}

function getPathfinderRetrievalCacheTarget(generationType) {
    if (normalizeGenerationType(generationType) !== 'normal') {
        return null;
    }

    if (generationStartLastAssistantIndex < 0 || generationStartLastAssistantIndex !== chat.length - 1) {
        return null;
    }

    const message = chat[generationStartLastAssistantIndex];
    if (!message || message !== generationStartLastAssistantMessage || message.is_user || message.is_system) {
        return null;
    }

    return {
        message,
        messageIndex: generationStartLastAssistantIndex,
    };
}

function getPathfinderCacheMessageRole(message) {
    if (message?.is_system) {
        return 'system';
    }

    return message?.is_user ? 'user' : 'assistant';
}

function getPathfinderRetrievalContextSnapshot(targetMessageIndex) {
    const endIndex = Math.max(0, Number(targetMessageIndex));
    const startIndex = Math.max(0, endIndex - PATHFINDER_RETRIEVAL_CONTEXT_MESSAGE_LIMIT);

    return chat.slice(startIndex, endIndex).map((message, offset) => ({
        index: startIndex + offset,
        role: getPathfinderCacheMessageRole(message),
        name: normalizeMessageRunValue(message?.name),
        mes: normalizeMessageRunValue(message?.mes),
        swipeId: normalizeMessageRunValue(message?.swipe_id),
        sendDate: normalizeMessageRunValue(message?.send_date),
        genStarted: normalizeMessageRunValue(message?.gen_started),
        genFinished: normalizeMessageRunValue(message?.gen_finished),
    }));
}

function normalizePathfinderCacheValue(value, seen = new WeakSet()) {
    if (value instanceof Date) {
        return value.toISOString();
    }

    if (Array.isArray(value)) {
        return value.map(item => normalizePathfinderCacheValue(item, seen));
    }

    if (value && typeof value === 'object') {
        if (seen.has(value)) {
            return '[Circular]';
        }

        seen.add(value);
        const normalized = {};
        for (const key of Object.keys(value).sort()) {
            const item = value[key];
            if (typeof item === 'function' || item === undefined) {
                continue;
            }

            normalized[key] = normalizePathfinderCacheValue(item, seen);
        }
        seen.delete(value);
        return normalized;
    }

    if (typeof value === 'bigint') {
        return String(value);
    }

    return value ?? null;
}

function getPathfinderRetrievalSettingsSnapshot(pathfinderAgent) {
    let runtimeSettings = {};
    try {
        runtimeSettings = getPathfinderRuntimeSettings() ?? {};
    } catch {
        runtimeSettings = {};
    }

    return normalizePathfinderCacheValue({
        agentId: pathfinderAgent?.id ?? '',
        settings: pathfinderAgent?.settings ?? {},
        runtimeSettings,
    });
}

function buildPathfinderRetrievalCacheSignature(pathfinderAgent, activationSnapshot, generationType, cacheTarget) {
    if (!cacheTarget) {
        return '';
    }

    const signaturePayload = normalizePathfinderCacheValue({
        version: 1,
        chatId: normalizeSnapshotChatId(activationSnapshot?.chatId ?? getCurrentSnapshotChatId()),
        generationType: normalizeGenerationType(generationType),
        targetMessageIndex: cacheTarget.messageIndex,
        promptKeys: PATHFINDER_RETRIEVAL_PROMPT_KEYS,
        context: getPathfinderRetrievalContextSnapshot(cacheTarget.messageIndex),
        pathfinder: getPathfinderRetrievalSettingsSnapshot(pathfinderAgent),
    });

    try {
        return JSON.stringify(signaturePayload);
    } catch {
        return '';
    }
}

function isPathfinderRetrievalCacheEntry(value) {
    return Boolean(
        value &&
        typeof value === 'object' &&
        typeof value.signature === 'string' &&
        Array.isArray(value.prompts),
    );
}

function appendPathfinderRetrievalCaches(target, value) {
    if (Array.isArray(value)) {
        target.push(...value.filter(isPathfinderRetrievalCacheEntry));
    }
}

function getStoredPathfinderRetrievalCaches(message) {
    const caches = [];
    appendPathfinderRetrievalCaches(caches, message?.extra?.[PATHFINDER_RETRIEVAL_CACHE_EXTRA_KEY]);

    if (Array.isArray(message?.swipe_info)) {
        for (const swipeInfo of message.swipe_info) {
            appendPathfinderRetrievalCaches(caches, swipeInfo?.extra?.[PATHFINDER_RETRIEVAL_CACHE_EXTRA_KEY]);
        }
    }

    const deduped = new Map();
    for (const cache of caches) {
        deduped.set(cache.signature, cache);
    }

    return [...deduped.values()];
}

function findPathfinderRetrievalCache(message, signature) {
    if (!signature) {
        return null;
    }

    return getStoredPathfinderRetrievalCaches(message).find(cache => cache.signature === signature) ?? null;
}

function getPathfinderPromptValue(key) {
    const prompt = extension_prompts[key];
    if (!prompt || prompt.value === undefined || prompt.value === null) {
        return '';
    }

    return String(prompt.value);
}

function capturePathfinderRetrievalPromptSnapshot() {
    return PATHFINDER_RETRIEVAL_PROMPT_KEYS
        .map(key => ({ key, value: getPathfinderPromptValue(key) }))
        .filter(prompt => prompt.value.trim());
}

function restorePathfinderRetrievalPromptSnapshot(cache) {
    if (!isPathfinderRetrievalCacheEntry(cache)) {
        return false;
    }

    for (const prompt of cache.prompts) {
        if (!PATHFINDER_RETRIEVAL_PROMPT_KEYS.includes(prompt?.key) || typeof prompt.value !== 'string' || !prompt.value.trim()) {
            continue;
        }

        setExtensionPrompt(
            prompt.key,
            prompt.value,
            extension_prompt_types.IN_PROMPT,
            4,
            false,
            extension_prompt_roles.SYSTEM,
        );
    }

    return true;
}

function storePathfinderRetrievalCache(message, signature) {
    if (!message || !signature) {
        return;
    }

    const cacheEntry = {
        signature,
        prompts: capturePathfinderRetrievalPromptSnapshot(),
        savedAt: Date.now(),
    };
    const caches = getStoredPathfinderRetrievalCaches(message).filter(cache => cache.signature !== signature);
    caches.push(cacheEntry);

    setAgentExtraValue(message, PATHFINDER_RETRIEVAL_CACHE_EXTRA_KEY, caches.slice(-MAX_PATHFINDER_RETRIEVAL_CACHE));
    saveChatDebouncedForAgent();
}

function hasProcessedPostProcessingRun(message, runKey, messageIndex = null, indexRunKey = '') {
    const numericMessageIndex = Number(messageIndex);
    const indexRuns = Number.isInteger(numericMessageIndex)
        ? processedPostProcessingRunsByIndex.get(numericMessageIndex)
        : null;

    return Boolean(
        runKey &&
        (
            processedPostProcessingRuns.get(message)?.has(runKey) ||
            getStoredPostProcessingRuns(message).includes(runKey) ||
            indexRuns?.includes(runKey) ||
            (indexRunKey && indexRuns?.includes(indexRunKey))
        ),
    );
}

function markPostProcessingRunProcessed(message, runKey, messageIndex = null, indexRunKey = '') {
    if (!message || !runKey) {
        return false;
    }

    let processedRuns = processedPostProcessingRuns.get(message);
    if (!processedRuns) {
        processedRuns = new Set();
        processedPostProcessingRuns.set(message, processedRuns);
    }

    processedRuns.add(runKey);
    const storedRuns = getStoredPostProcessingRuns(message).filter(value => value !== runKey);
    storedRuns.push(runKey);
    setAgentExtraValue(message, POST_PROCESSING_RUNS_EXTRA_KEY, storedRuns.slice(-MAX_TRANSFORM_HISTORY));

    const numericMessageIndex = Number(messageIndex);
    if (Number.isInteger(numericMessageIndex)) {
        const indexRuns = (processedPostProcessingRunsByIndex.get(numericMessageIndex) ?? [])
            .filter(value => value !== runKey && value !== indexRunKey);
        indexRuns.push(runKey);
        if (indexRunKey) {
            indexRuns.push(indexRunKey);
        }
        processedPostProcessingRunsByIndex.set(numericMessageIndex, indexRuns.slice(-MAX_TRANSFORM_HISTORY));
    }

    return true;
}

function getDeferredActivationSnapshot(generationType) {
    return cloneActivationSnapshot(
        pendingGenerationSnapshot ?? buildActivationSnapshot(generationType),
        generationType,
    );
}

function isAssistantPostProcessingGenerationType(generationType) {
    return !isGreetingGenerationType(generationType) && !isImpersonateGenerationType(generationType);
}

function deferPostProcessing(messageIndex, generationType, activationSnapshot = null) {
    const numericMessageIndex = Number(messageIndex);
    if (!Number.isInteger(numericMessageIndex)) {
        return;
    }

    const snapshot = activationSnapshot
        ? cloneActivationSnapshot(activationSnapshot, generationType)
        : getDeferredActivationSnapshot(generationType);

    deferredPostProcessingQueue.set(numericMessageIndex, {
        messageIndex: numericMessageIndex,
        generationType: snapshot.generationType,
        message: chat[numericMessageIndex] ?? null,
        activationSnapshot: snapshot,
        wasStreamingStopped: wasStreamingMessageStopped(numericMessageIndex),
    });

    if (!isGenerationInProgress) {
        scheduleDeferredPostProcessingFlush(DEFERRED_POST_PROCESSING_RETRY_MS);
        schedulePostGenerationRecoveryCheck(DEFERRED_POST_PROCESSING_RETRY_MS);
    } else {
        scheduleMissedGenerationEndRecoveryCheck();
    }
}

function isDeferredPostProcessingMessageCurrent(pendingMessage) {
    if (!isActivationSnapshotForCurrentChat(pendingMessage.activationSnapshot)) {
        return false;
    }

    const message = chat[pendingMessage.messageIndex];

    if (!message || message.is_user || message.is_system) {
        return false;
    }

    if (message === pendingMessage.message) {
        return true;
    }

    if (pendingMessage.message && getMessageRevisionKey(message) === getMessageRevisionKey(pendingMessage.message)) {
        return true;
    }

    if (pendingMessage.messageIndex >= generationStartChatLength) {
        return true;
    }

    return isGenerationAssistantCandidate(pendingMessage.messageIndex, message);
}

function scheduleDeferredPostProcessingFlush(delayMs = 0) {
    if (deferredPostProcessingTimeout) {
        clearTimeout(deferredPostProcessingTimeout);
    }

    deferredPostProcessingTimeout = setTimeout(async () => {
        deferredPostProcessingTimeout = null;

        if (deferredPostProcessingQueue.size === 0 || generationStopRequested) {
            return;
        }

        if (isGenerationInProgress) {
            return;
        }

        if (internalPromptTransformDepth > 0) {
            scheduleDeferredPostProcessingFlush();
            return;
        }

        if (isBodyGenerationFlagBlocking()) {
            scheduleDeferredPostProcessingFlush(DEFERRED_POST_PROCESSING_RETRY_MS);
            return;
        }

        const pendingMessages = [...deferredPostProcessingQueue.values()]
            .sort((a, b) => a.messageIndex - b.messageIndex);

        for (const pendingMessage of pendingMessages) {
            if (!deferredPostProcessingQueue.has(pendingMessage.messageIndex)) {
                continue;
            }

            if (!isDeferredPostProcessingMessageCurrent(pendingMessage)) {
                deferredPostProcessingQueue.delete(pendingMessage.messageIndex);
                continue;
            }

            if (pendingMessage.wasStreamingStopped || wasStreamingMessageStopped(pendingMessage.messageIndex)) {
                deferredPostProcessingQueue.delete(pendingMessage.messageIndex);
                continue;
            }

            if (isStreamingMessageStillActive(pendingMessage.messageIndex)) {
                scheduleDeferredPostProcessingFlush(DEFERRED_POST_PROCESSING_RETRY_MS);
                return;
            }

            deferredPostProcessingQueue.delete(pendingMessage.messageIndex);
            await processReceivedMessage(pendingMessage.messageIndex, pendingMessage.generationType, pendingMessage.activationSnapshot);

            if (generationStopRequested) {
                clearDeferredPostProcessing();
                return;
            }

            if (isMainGenerationStillActive()) {
                scheduleDeferredPostProcessingFlush(DEFERRED_POST_PROCESSING_RETRY_MS);
                return;
            }
        }

        clearPostGenerationStateAfterCompletion();

        if (deferredPostProcessingQueue.size > 0) {
            scheduleDeferredPostProcessingFlush();
        }
    }, delayMs);
}

function clearLatestAssistantPostProcessingFallbackTimer() {
    if (!latestAssistantPostProcessingFallbackTimeout) {
        return;
    }

    clearTimeout(latestAssistantPostProcessingFallbackTimeout);
    latestAssistantPostProcessingFallbackTimeout = null;
}

function scheduleLatestAssistantPostProcessingFallback(delayMs = DEFERRED_POST_PROCESSING_RETRY_MS) {
    clearLatestAssistantPostProcessingFallbackTimer();

    if (clearStalePendingGenerationSnapshot()) {
        latestAssistantPostProcessingFallbackDeadline = 0;
        return;
    }

    if (!latestAssistantPostProcessingFallbackDeadline) {
        latestAssistantPostProcessingFallbackDeadline = Date.now() + LATEST_ASSISTANT_POST_PROCESSING_FALLBACK_WINDOW_MS;
    }

    latestAssistantPostProcessingFallbackTimeout = setTimeout(() => {
        latestAssistantPostProcessingFallbackTimeout = null;

        if (!pendingGenerationSnapshot || generationStopRequested || isGenerationInProgress) {
            latestAssistantPostProcessingFallbackDeadline = 0;
            return;
        }

        if (internalPromptTransformDepth > 0 || isBodyGenerationFlagBlocking()) {
            if (Date.now() < latestAssistantPostProcessingFallbackDeadline) {
                scheduleLatestAssistantPostProcessingFallback(DEFERRED_POST_PROCESSING_RETRY_MS);
            } else {
                latestAssistantPostProcessingFallbackDeadline = 0;
            }
            return;
        }

        const queueResult = queueLatestAssistantPostProcessingFromSnapshot();
        scheduleDeferredPostProcessingFlush();

        if (queueResult.retry && Date.now() < latestAssistantPostProcessingFallbackDeadline) {
            scheduleLatestAssistantPostProcessingFallback(DEFERRED_POST_PROCESSING_RETRY_MS);
        } else {
            latestAssistantPostProcessingFallbackDeadline = 0;
        }
    }, delayMs);
}

function hasPostGenerationRecoveryWork() {
    if (postProcessingInvalidatedByChatChange || isCurrentGenerationChatStale()) {
        clearPendingPostProcessingForChatChange();
        return false;
    }

    if (clearStalePendingGenerationSnapshot()) {
        return false;
    }

    return Boolean(
        !generationStopRequested &&
        (
            deferredPostProcessingQueue.size > 0 ||
            pendingGenerationSnapshot?.activeAgentIds?.length > 0
        ),
    );
}

function schedulePostGenerationRecoveryCheck(delayMs = 0) {
    if (!hasPostGenerationRecoveryWork() || isGenerationInProgress) {
        return;
    }

    if (postGenerationRecoveryTimeout) {
        clearTimeout(postGenerationRecoveryTimeout);
    }

    postGenerationRecoveryTimeout = setTimeout(() => {
        postGenerationRecoveryTimeout = null;

        if (!hasPostGenerationRecoveryWork() || isGenerationInProgress) {
            return;
        }

        queueLatestAssistantPostProcessingFromSnapshot();
        scheduleDeferredPostProcessingFlush();

        if (deferredPostProcessingQueue.size > 0 && !isBodyGenerationFlagBlocking()) {
            scheduleDeferredPostProcessingFlush();
        }
    }, delayMs);
}

function hasRecoverableAssistantPostProcessingCandidate() {
    if (postProcessingInvalidatedByChatChange || isCurrentGenerationChatStale()) {
        clearPendingPostProcessingForChatChange();
        return false;
    }

    if (clearStalePendingGenerationSnapshot() || !pendingGenerationSnapshot || generationStopRequested || internalPromptTransformDepth > 0) {
        return false;
    }

    const activationSnapshot = cloneActivationSnapshot(pendingGenerationSnapshot, pendingGenerationSnapshot.generationType);
    if (!isAssistantPostProcessingGenerationType(activationSnapshot.generationType)) {
        return false;
    }

    if (activationSnapshot.activeAgentIds.length === 0) {
        return false;
    }

    const messageIndex = getLatestAssistantMessageIndex();
    if (messageIndex < 0) {
        return false;
    }

    const message = chat[messageIndex];
    if (!isGenerationAssistantCandidate(messageIndex, message)) {
        return false;
    }

    const runKey = getPostProcessingRunKey(message, activationSnapshot.generationType, activationSnapshot);
    const indexRunKey = getPostProcessingIndexRunKey(message, messageIndex, activationSnapshot.generationType, activationSnapshot);
    return !hasProcessedPostProcessingRun(message, runKey, messageIndex, indexRunKey);
}

function hasActiveStreamingProcessorIgnoringGenerationFlag(messageIndex) {
    const liveStreamingProcessor = getStreamingTarget(messageIndex);
    if (!liveStreamingProcessor) {
        return false;
    }

    return Boolean(
        !liveStreamingProcessor.isFinished &&
        !liveStreamingProcessor.isStopped &&
        !liveStreamingProcessor.abortController?.signal?.aborted,
    );
}

function canRecoverMissedGenerationEnd() {
    if (!isGenerationInProgress || !hasRecoverableAssistantPostProcessingCandidate()) {
        return false;
    }

    const messageIndex = getLatestAssistantMessageIndex();
    const message = chat[messageIndex];

    if (hasActiveStreamingProcessorIgnoringGenerationFlag(messageIndex)) {
        return false;
    }

    if (message?.gen_finished) {
        return true;
    }

    if (document.body?.dataset?.generating !== 'true') {
        return true;
    }

    return Date.now() - generationStartedAt > BODY_GENERATING_FLAG_GRACE_MS;
}

function recoverMissedGenerationEnd(reason = 'fallback') {
    if (clearStalePendingGenerationSnapshot() || !canRecoverMissedGenerationEnd()) {
        return false;
    }

    console.warn(`[InChatAgents] Recovering missed generation end via ${reason}; flushing queued post-processing.`);
    isGenerationInProgress = false;
    lastMainGenerationEndedAt = Date.now() - BODY_GENERATING_FLAG_GRACE_MS;
    toolSyncDuringGeneration = false;
    generationStopRequested = false;
    clearMissedGenerationEndRecoveryCheck();
    clearInitialGenerationToast();
    queueLatestAssistantPostProcessingFromSnapshot();
    scheduleDeferredPostProcessingFlush();
    schedulePostGenerationRecoveryCheck();
    latestAssistantPostProcessingFallbackDeadline = Date.now() + LATEST_ASSISTANT_POST_PROCESSING_FALLBACK_WINDOW_MS;
    scheduleLatestAssistantPostProcessingFallback();
    return true;
}

function scheduleMissedGenerationEndRecoveryCheck(delayMs = MISSED_GENERATION_END_RECOVERY_MS) {
    if (!isGenerationInProgress || generationStopRequested) {
        return;
    }

    if (missedGenerationEndRecoveryTimeout) {
        clearTimeout(missedGenerationEndRecoveryTimeout);
    }

    missedGenerationEndRecoveryTimeout = setTimeout(() => {
        missedGenerationEndRecoveryTimeout = null;

        if (recoverMissedGenerationEnd('watchdog')) {
            return;
        }

        if (isGenerationInProgress && hasRecoverableAssistantPostProcessingCandidate()) {
            scheduleMissedGenerationEndRecoveryCheck();
        }
    }, delayMs);
}

function observePostGenerationRecoveryTargets() {
    if (!postGenerationRecoveryObserver) {
        return;
    }

    try {
        if (document.body) {
            postGenerationRecoveryObserver.observe(document.body, {
                attributes: true,
                attributeFilter: ['data-generating'],
            });
        }

        const chatElement = document.getElementById?.('chat') ?? document.querySelector?.('#chat');
        if (chatElement) {
            postGenerationRecoveryObserver.observe(chatElement, {
                childList: true,
                subtree: true,
            });
        }
    } catch (error) {
        console.warn('[InChatAgents] Could not start post-generation recovery observer:', error);
    }
}

function initPostGenerationRecoveryHooks() {
    if (postGenerationRecoveryHooksInitialized) {
        return;
    }

    postGenerationRecoveryHooksInitialized = true;
    const scheduleRecovery = () => {
        if (!recoverMissedGenerationEnd('event')) {
            scheduleMissedGenerationEndRecoveryCheck();
        }
        schedulePostGenerationRecoveryCheck();
    };
    const observeAndScheduleRecovery = () => {
        observePostGenerationRecoveryTargets();
        scheduleRecovery();
    };

    if (typeof MutationObserver === 'function') {
        try {
            postGenerationRecoveryObserver = new MutationObserver(scheduleRecovery);
            observePostGenerationRecoveryTargets();
        } catch (error) {
            console.warn('[InChatAgents] Could not start post-generation recovery observer:', error);
        }
    }

    if (typeof document.addEventListener === 'function') {
        document.addEventListener('visibilitychange', scheduleRecovery);
        document.addEventListener('DOMContentLoaded', observeAndScheduleRecovery);
    }

    const windowTarget = globalThis.window ?? globalThis;
    if (typeof windowTarget.addEventListener === 'function') {
        windowTarget.addEventListener('pageshow', scheduleRecovery);
        windowTarget.addEventListener('focus', scheduleRecovery);
    }
}

/**
 * Checks whether an agent should activate this turn.
 * @param {import('./agent-store.js').InChatAgent} agent
 * @param {string} generationType
 * @returns {boolean}
 */
function shouldActivate(agent, generationType) {
    const conditions = agent.conditions;

    if (conditions.generationTypes?.length > 0 && !conditions.generationTypes.includes(generationType)) {
        return false;
    }

    if (conditions.triggerProbability < 100 && Math.random() * 100 > conditions.triggerProbability) {
        return false;
    }

    if (conditions.triggerKeywords?.length > 0) {
        const triggerMessage = isCompanionAgent(agent)
            ? getLatestUserMessageText()
            : String(chat[chat.length - 1]?.mes ?? '');
        const lowerMessage = triggerMessage.toLowerCase();
        const hasKeyword = conditions.triggerKeywords.some(keyword => isCompanionAgent(agent)
            ? companionTriggerMatches(keyword, triggerMessage)
            : lowerMessage.includes(String(keyword ?? '').toLowerCase()));
        if (!hasKeyword) {
            return false;
        }
    }

    return true;
}

function getLatestAssistantMessageIndex() {
    for (let index = chat.length - 1; index >= 0; index--) {
        const message = chat[index];
        if (message && !message.is_user && !message.is_system) {
            return index;
        }
    }

    return -1;
}

function isGenerationAssistantCandidate(messageIndex, message) {
    if (!message || message.is_user || message.is_system) {
        return false;
    }

    if (messageIndex >= generationStartChatLength) {
        return true;
    }

    if (message === generationStartLastAssistantMessage) {
        return getMessageRevisionKey(message) !== generationStartLastAssistantRevision;
    }

    return generationStartLastAssistantIndex >= 0 &&
        messageIndex === generationStartLastAssistantIndex &&
        messageIndex === chat.length - 1;
}

function queueLatestAssistantPostProcessingFromSnapshot() {
    if (postProcessingInvalidatedByChatChange || isCurrentGenerationChatStale()) {
        clearPendingPostProcessingForChatChange();
        return { queued: false, retry: false };
    }

    if (clearStalePendingGenerationSnapshot() || !pendingGenerationSnapshot || generationStopRequested) {
        return { queued: false, retry: false };
    }

    const activationSnapshot = cloneActivationSnapshot(pendingGenerationSnapshot, pendingGenerationSnapshot.generationType);
    if (!isAssistantPostProcessingGenerationType(activationSnapshot.generationType)) {
        return { queued: false, retry: false };
    }

    if (activationSnapshot.activeAgentIds.length === 0) {
        return { queued: false, retry: false };
    }

    const messageIndex = getLatestAssistantMessageIndex();
    if (messageIndex < 0) {
        return { queued: false, retry: true };
    }

    const message = chat[messageIndex];
    if (!isGenerationAssistantCandidate(messageIndex, message)) {
        return { queued: false, retry: true };
    }

    if (wasStreamingMessageStopped(messageIndex)) {
        return { queued: false, retry: false };
    }

    const runKey = getPostProcessingRunKey(message, activationSnapshot.generationType, activationSnapshot);
    const indexRunKey = getPostProcessingIndexRunKey(message, messageIndex, activationSnapshot.generationType, activationSnapshot);

    if (hasProcessedPostProcessingRun(message, runKey, messageIndex, indexRunKey)) {
        return { queued: false, retry: false };
    }

    deferPostProcessing(messageIndex, activationSnapshot.generationType, activationSnapshot);
    return { queued: true, retry: false };
}

function buildActivationSnapshot(generationType) {
    const normalizedGenerationType = normalizeGenerationType(generationType);
    const chatId = getCurrentSnapshotChatId();
    if (!areAgentsGloballyEnabled()) {
        return {
            generationType: normalizedGenerationType,
            activeAgentIds: [],
            chatId,
        };
    }

    const activeAgents = getEnabledAgents().filter(agent => shouldActivate(agent, normalizedGenerationType));

    return {
        generationType: normalizedGenerationType,
        activeAgentIds: activeAgents.map(agent => agent.id),
        chatId,
    };
}

function getSnapshotAgents(snapshot) {
    if (!snapshot || !Array.isArray(snapshot.activeAgentIds)) {
        return [];
    }

    return snapshot.activeAgentIds
        .map(id => getAgentById(id))
        .filter(Boolean);
}

function getActiveAgentsForMessage(generationType, activationSnapshot = null) {
    const snapshot = activationSnapshot ?? pendingGenerationSnapshot ?? buildActivationSnapshot(generationType);
    return getSnapshotAgents(snapshot);
}

export function buildPromptDynamicMacros(messageText = '', message = null, agent = null, generationType = 'normal') {
    const normalizedGenerationType = normalizeGenerationType(generationType);
    const assistantName = String(message?.name ?? '').trim();
    const agentName = String(agent?.name ?? '').trim();

    return {
        currentMessage: messageText,
        lastMessage: messageText,
        latestMessage: messageText,
        response: messageText,
        currentResponse: messageText,
        latestResponse: messageText,
        assistantMessage: messageText,
        assistantName,
        agentName,
        generationType: normalizedGenerationType,
    };
}

function updateMessageRegexSnapshot(message, activeAgents, generationType) {
    message.extra ??= {};
    const inlineAgents = activeAgents.filter(agent => !isCompanionAgent(agent));
    const regexScriptRefs = inlineAgents.flatMap(agent => {
        const scripts = getAgentRegexScripts(agent);
        cacheAgentRegexScripts(agent?.id, scripts);
        return buildRegexScriptRefsForAgent(agent?.id, scripts);
    });

    if (regexScriptRefs.length === 0) {
        if (hasAgentExtraValue(message, MESSAGE_EXTRA_KEY)) {
            deleteAgentExtraValue(message, MESSAGE_EXTRA_KEY);
            return true;
        }

        return false;
    }

    const previousSnapshot = getAgentExtraValue(message, MESSAGE_EXTRA_KEY);
    const nextSnapshot = {
        activeAgentIds: inlineAgents.map(agent => agent.id),
        generationType: normalizeGenerationType(generationType),
        regexScriptRefs,
        edited: Boolean(previousSnapshot?.edited),
    };

    const previousComparable = previousSnapshot
        ? {
            activeAgentIds: previousSnapshot.activeAgentIds,
            generationType: previousSnapshot.generationType,
            regexScriptRefs: previousSnapshot.regexScriptRefs,
            edited: Boolean(previousSnapshot.edited),
        }
        : null;

    if (JSON.stringify(previousComparable) === JSON.stringify(nextSnapshot)) {
        return false;
    }

    setAgentExtraValue(message, MESSAGE_EXTRA_KEY, nextSnapshot);
    return true;
}

function ensureMessageRegexSnapshot(messageIndex, generationType, activationSnapshot = null, options = {}) {
    const { refresh = true, save = true } = options;
    if (!isAssistantPostProcessingGenerationType(activationSnapshot?.generationType ?? generationType)) {
        return false;
    }

    const numericMessageIndex = Number(messageIndex);
    if (!Number.isInteger(numericMessageIndex)) {
        return false;
    }

    const message = chat[numericMessageIndex];
    if (!message || message.is_user || message.is_system) {
        return false;
    }

    const resolvedActivationSnapshot = activationSnapshot
        ? cloneActivationSnapshot(activationSnapshot, generationType)
        : getDeferredActivationSnapshot(generationType);
    const activeAgents = getActiveAgentsForMessage(generationType, resolvedActivationSnapshot);

    if (!updateMessageRegexSnapshot(message, activeAgents, generationType)) {
        if (save && pendingRegexSnapshotSaves.has(message)) {
            pendingRegexSnapshotSaves.delete(message);
            saveChatDebouncedForAgent();
        }

        return false;
    }

    if (save) {
        pendingRegexSnapshotSaves.delete(message);
        saveChatDebouncedForAgent();
    } else {
        pendingRegexSnapshotSaves.add(message);
    }

    if (refresh) {
        scheduleMessageRefresh(numericMessageIndex, message, { deferBackup: shouldDeferAgentRegularBackup(), skipReloadFallback: true });
    }

    return true;
}

function isRegexRefreshAgentCandidate(agent, generationType, { respectGenerationTypes = true } = {}) {
    if (!agent || isCompanionAgent(agent) || getAgentRegexScripts(agent).length === 0) {
        return false;
    }

    if (!respectGenerationTypes) {
        return true;
    }

    const normalizedGenerationType = normalizeGenerationType(generationType);
    const generationTypes = agent.conditions?.generationTypes;
    return !Array.isArray(generationTypes)
        || generationTypes.length === 0
        || generationTypes.includes(normalizedGenerationType);
}

function getRegexSnapshotRefreshAgents(message, agentId, generationType, { includeForcedAgent = false, respectGenerationTypes = true } = {}) {
    const enabledAgentsById = new Map(getEnabledAgents().map(agent => [agent.id, agent]));
    const previousSnapshot = getAgentExtraValue(message, MESSAGE_EXTRA_KEY);
    const agentIds = new Set(Array.isArray(previousSnapshot?.activeAgentIds) ? previousSnapshot.activeAgentIds : []);

    if (agentId) {
        agentIds.add(agentId);
    }

    const refreshAgents = [];
    for (const id of agentIds) {
        let agent = enabledAgentsById.get(id);

        if (!agent && includeForcedAgent && id === agentId) {
            agent = getAgentById(id);
        }

        if (isRegexRefreshAgentCandidate(agent, generationType, { respectGenerationTypes })) {
            refreshAgents.push(agent);
        }
    }

    return refreshAgents;
}

function refreshRegexSnapshotForAgentOnMessage(agentId, messageIndex, options = {}) {
    const {
        generationType = 'normal',
        includeForcedAgent = false,
        refresh = true,
        respectGenerationTypes = true,
        save = true,
        markPendingSave = !save,
    } = options;
    const normalizedGenerationType = normalizeGenerationType(generationType);
    if (!isAssistantPostProcessingGenerationType(normalizedGenerationType)) {
        return false;
    }

    const numericMessageIndex = Number(messageIndex);
    if (!Number.isInteger(numericMessageIndex)) {
        return false;
    }

    const message = chat[numericMessageIndex];
    if (!message || message.is_user || message.is_system) {
        return false;
    }

    const activeAgents = getRegexSnapshotRefreshAgents(message, agentId, normalizedGenerationType, {
        includeForcedAgent,
        respectGenerationTypes,
    });

    if (!updateMessageRegexSnapshot(message, activeAgents, normalizedGenerationType)) {
        return false;
    }

    if (save) {
        pendingRegexSnapshotSaves.delete(message);
        saveChatDebouncedForAgent();
    } else if (markPendingSave) {
        pendingRegexSnapshotSaves.add(message);
    }

    if (refresh) {
        scheduleMessageRefresh(numericMessageIndex, message, { deferBackup: shouldDeferAgentRegularBackup(), skipReloadFallback: true });
    }

    return true;
}

export function refreshRegexSnapshotsForAgent(agentId, { generationType = 'normal' } = {}) {
    let refreshed = 0;
    for (let messageIndex = 0; messageIndex < chat.length; messageIndex++) {
        if (refreshRegexSnapshotForAgentOnMessage(agentId, messageIndex, {
            generationType,
            markPendingSave: false,
            save: false,
        })) {
            refreshed++;
        }
    }

    if (refreshed > 0) {
        saveChatDebouncedForAgent();
    }

    return refreshed;
}

function resolveAgentConnectionProfile(agent) {
    return isCompanionAgent(agent)
        ? resolveCompanionConnectionProfile(agent?.connectionProfile)
        : resolveConnectionProfile(agent?.connectionProfile);
}

function getPromptTransformAgents(activeAgents) {
    return activeAgents.filter(agent =>
        !isCompanionAgent(agent) &&
        (agent.phase === 'post' || agent.phase === 'both') &&
        agent.postProcess?.promptTransformEnabled &&
        String(agent.prompt ?? '').trim(),
    );
}

function getPromptTransformAgentsForMessage(activeAgents, generationType) {
    if (isGreetingGenerationType(generationType)) {
        // Greeting messages should remain untouched by prompt-based rewrites/appends.
        return [];
    }

    if (isImpersonateGenerationType(generationType)) {
        return [];
    }

    return getPromptTransformAgents(activeAgents);
}

function getPromptTransformAgentsForImpersonate(activeAgents) {
    return getPromptTransformAgents(activeAgents).filter(agent => {
        if (agent?.conditions?.runOnImpersonate) {
            return true;
        }

        const sourceTemplateId = String(agent?.sourceTemplateId ?? '').trim();
        return IMPERSONATE_PROMPT_TRANSFORM_TEMPLATE_IDS.has(sourceTemplateId);
    });
}

function getPreGenerationInterceptAgents(activeAgents) {
    return activeAgents.filter(agent =>
        !isToolAgent(agent) &&
        !isCompanionAgent(agent) &&
        (agent.phase === 'pre' || agent.phase === 'both') &&
        agent.preProcess?.mode === 'intercept' &&
        agent.preProcess?.interceptTiming !== POST_MAIN_GENERATION_INTERCEPT_TIMING &&
        String(agent.prompt ?? '').trim(),
    ).sort((a, b) => Number(a?.injection?.order ?? 100) - Number(b?.injection?.order ?? 100));
}

function getPostMainGenerationInterceptAgents(activeAgents) {
    return activeAgents.filter(agent =>
        !isToolAgent(agent) &&
        !isCompanionAgent(agent) &&
        (agent.phase === 'pre' || agent.phase === 'both') &&
        agent.preProcess?.mode === 'intercept' &&
        agent.preProcess?.interceptTiming === POST_MAIN_GENERATION_INTERCEPT_TIMING &&
        String(agent.prompt ?? '').trim(),
    ).sort((a, b) => Number(a?.injection?.order ?? 100) - Number(b?.injection?.order ?? 100));
}

function describePromptTransformMode(mode) {
    return mode === 'append' ? 'prompt append' : 'prompt rewrite';
}

function shouldShowPromptTransformNotifications(agent) {
    return Boolean(
        getGlobalSettings()?.promptTransformShowNotifications &&
        agent?.postProcess?.promptTransformEnabled &&
        agent?.postProcess?.promptTransformShowNotifications,
    );
}

function shouldShowPreInterceptNotifications(agent) {
    return Boolean(
        getGlobalSettings()?.promptTransformShowNotifications &&
        agent?.preProcess?.mode === 'intercept',
    );
}

function shouldShowPostMainInterceptMessageFirst() {
    return getGlobalSettings()?.postMainInterceptShowMessageFirst !== false;
}

function describePromptTransformTarget(profileId = '', runner = '') {
    if (runner === 'main') {
        return 'the main model';
    }

    if (profileId) {
        return `profile "${getConnectionProfileDisplayName(profileId)}"`;
    }

    return 'the main model';
}

function getPromptTransformProfileLabel(profileId = '') {
    return profileId ? getConnectionProfileDisplayName(profileId) : 'Main model';
}

function getPromptTransformModelLabel(agent, profileId = '') {
    const modelOverride = String(agent?.modelOverride ?? '').trim();
    if (modelOverride) {
        return modelOverride;
    }

    if (!profileId) {
        return getPromptTransformProfileLabel(profileId);
    }

    const modelName = getConnectionProfileModelName(profileId);
    const profileLabel = getConnectionProfileDisplayName(profileId);
    if (modelName && profileLabel) {
        return `${modelName} (${profileLabel})`;
    }

    return modelName || profileLabel || getPromptTransformProfileLabel(profileId);
}

function getPromptTransformRunMetadata(agent, profileId = '') {
    return {
        order: Number(agent?.injection?.order ?? 0),
        profileLabel: getPromptTransformProfileLabel(profileId),
        modelLabel: getPromptTransformModelLabel(agent, profileId),
    };
}

function showPromptTransformRunningToast(agent, mode, profileId = '', options = {}) {
    const agentName = agent?.name || 'In-Chat Agent';
    const modeLabel = describePromptTransformMode(mode);
    const targetLabel = describePromptTransformTarget(profileId, profileId ? 'profile' : 'main');
    const metadata = getPromptTransformRunMetadata(agent, profileId);
    const cancelButtonClass = 'ica--toast-cancel-agent';
    const kind = ['preIntercept', 'postMainIntercept'].includes(String(options?.kind))
        ? String(options.kind)
        : 'postGen';
    const applyMode = ['wrap', 'patch'].includes(String(options?.applyMode))
        ? String(options.applyMode)
        : 'replace';
    const skipChanges = Boolean(options?.skipChanges && kind === 'postMainIntercept');
    const cancelHandler = typeof options?.onCancel === 'function'
        ? options.onCancel
        : cancelAgentGeneration;
    const runningLabel = skipChanges
        ? 'Generating main output for pre-generation intercept'
        : kind === 'preIntercept'
            ? `Running pre-generation ${applyMode} intercept...`
            : kind === 'postMainIntercept'
                ? `Running post-main ${applyMode} intercept...`
                : `Running ${modeLabel} via ${targetLabel}...`;
    const cancelLabel = skipChanges ? 'Skip changes' : 'Cancel Agent';
    const messageHtml = `
        <div>${escapeToastHtml(runningLabel)}</div>
        <div>${escapeToastHtml(`Order ${metadata.order} | Model: ${metadata.modelLabel}`)}</div>
        <button type="button" class="menu_button menu_button_icon caution ${cancelButtonClass}">
            <i class="fa-solid fa-stop"></i>
            <span>${escapeToastHtml(cancelLabel)}</span>
        </button>
    `;

    const toast = toastr.info(messageHtml, agentName, {
        timeOut: 0,
        extendedTimeOut: 0,
        tapToDismiss: false,
        closeButton: true,
        escapeHtml: false,
        onShown() {
            const toastElement = this instanceof HTMLElement ? this : this?.[0];
            const cancelButton = toastElement?.querySelector?.(`.${cancelButtonClass}`);
            cancelButton?.addEventListener('click', event => {
                event.preventDefault();
                event.stopPropagation();
                cancelHandler();
            });
        },
    });

    if (toast) {
        activePromptTransformToasts.add(toast);
    }

    return toast;
}

function clearPromptTransformRunningToast(toast) {
    if (!toast) {
        return;
    }

    activePromptTransformToasts.delete(toast);
    toastr.clear(toast);
}

function clearAllPromptTransformRunningToasts() {
    for (const toast of activePromptTransformToasts) {
        toastr.clear(toast);
    }

    activePromptTransformToasts.clear();

    $('.toast').filter((_, element) => {
        const title = $(element).find('.toast-title').text().trim();
        const message = $(element).find('.toast-message').text().trim();
        return $(element).find('.ica--toast-cancel-agent').length > 0 ||
            (title === 'In-Chat Agent' && /^Running (?:prompt (?:rewrite|append) via |pre-generation )/u.test(message));
    }).each((_, element) => toastr.clear($(element)));
}

async function commitOpenEditorForMessage(messageIndex) {
    if (!Number.isInteger(Number(messageIndex))) {
        return;
    }

    const editorDoneButton = $(`.mes[mesid="${Number(messageIndex)}"] .mes_edit_done:visible`).first();
    if (!editorDoneButton.length) {
        return;
    }

    editorDoneButton.trigger('click');
    await Promise.resolve();
}

function syncPromptTransformMessageState(message, messageIndex) {
    if (!message || message.is_user || message.is_system) {
        return;
    }

    if (message.extra?.display_text) {
        delete message.extra.display_text;
    }

    syncAssistantMessageTextToSwipe(message);
}

async function syncPromptTransformMessageStateAsync(message, messageIndex) {
    syncPromptTransformMessageState(message, messageIndex);

    if (!message || message.is_user || message.is_system) {
        return;
    }

    await updateMessageTokenAccounting(message);

    if (messageIndex === null || messageIndex === undefined || messageIndex === '') {
        return;
    }

    const numericMessageIndex = Number(messageIndex);
    if (!Number.isInteger(numericMessageIndex)) {
        return;
    }

    const messageElement = document.querySelector(`.mes[mesid="${numericMessageIndex}"]`);
    const context = getContext();
    if (messageElement && typeof context?.updateMessageMetaBadges === 'function') {
        context.updateMessageMetaBadges(messageElement, message);
    }
}

function syncAssistantMessageStateToSwipe(message, messageIndex) {
    if (!message || message.is_user || message.is_system) {
        return;
    }

    ensureSwipes(message);

    if (typeof message.swipe_id === 'number' && Array.isArray(message.swipes) && typeof message.swipes[message.swipe_id] === 'string') {
        message.swipes[message.swipe_id] = message.mes;
    }

    syncMesToSwipe(messageIndex);
}

function showPromptTransformResultToast(agent, result) {
    const agentName = agent?.name || result?.agentName || 'In-Chat Agent';

    switch (result?.status) {
        case 'changed':
            toastr.success('', agentName, { timeOut: 3000 });
            break;
        case 'unchanged':
            toastr.info('no change', agentName, { timeOut: 2000 });
            break;
        case 'empty-response': {
            const targetLabel = describePromptTransformTarget(result?.profileId, result?.runner);
            const modeLabel = describePromptTransformMode(result?.mode);
            toastr.warning(`${modeLabel} ran via ${targetLabel} but returned an empty response.`, agentName, {
                timeOut: 7000,
                extendedTimeOut: 10000,
            });
            break;
        }
        case 'error': {
            const targetLabel = describePromptTransformTarget(result?.profileId, result?.runner);
            const modeLabel = describePromptTransformMode(result?.mode);
            toastr.error(
                result?.error
                    ? `${modeLabel} failed via ${targetLabel}: ${result.error}`
                    : `${modeLabel} failed via ${targetLabel}.`,
                agentName,
                {
                    timeOut: 10000,
                    extendedTimeOut: 12000,
                },
            );
            break;
        }
    }
}

function updatePromptTransformRuns(message, runs) {
    message.extra ??= {};

    if (!Array.isArray(runs) || runs.length === 0) {
        if (hasAgentExtraValue(message, PROMPT_RUNS_EXTRA_KEY)) {
            deleteAgentExtraValue(message, PROMPT_RUNS_EXTRA_KEY);
            return true;
        }

        return false;
    }

    setAgentExtraValue(message, PROMPT_RUNS_EXTRA_KEY, runs.map(result => sanitizePromptTransformRunForStorage(result)));
    return true;
}

function updatePromptTransformHistory(message, run) {
    if (!message || !run || !run.changed) {
        return false;
    }

    const storedHistory = getAgentExtraValue(message, PROMPT_TRANSFORM_HISTORY_KEY);
    const history = getPromptTransformHistoryForText(storedHistory, run.beforeText);
    const nextEntry = {
        agentId: run.agentId,
        agentName: run.agentName,
        mode: run.mode,
        order: run.order,
        profileLabel: run.profileLabel,
        modelLabel: run.modelLabel,
        beforeText: normalizeContentText(run.beforeText),
        afterText: normalizeContentText(run.nextMessageText),
        timestamp: run.timestamp,
    };

    history.push(nextEntry);

    const scopedHistory = getPromptTransformHistoryForText(history, run.nextMessageText);
    if (!scopedHistory.includes(nextEntry)) {
        scopedHistory.length = 0;
        scopedHistory.push(nextEntry);
    }

    while (scopedHistory.length > MAX_TRANSFORM_HISTORY) {
        scopedHistory.shift();
    }

    setAgentExtraValue(message, PROMPT_TRANSFORM_HISTORY_KEY, scopedHistory);
    return true;
}

function shouldRefreshTransformHistoryUi(messageIndex, message) {
    const numericMessageIndex = Number(messageIndex);
    if (!Number.isInteger(numericMessageIndex) || !message || message.is_user || message.is_system) {
        return false;
    }

    const messageElement = document.querySelector(`.mes[mesid="${numericMessageIndex}"]`);
    return Boolean(messageElement && hasAgentDocumentHistory(message) && !messageElement.querySelector('.agent-transform-badge'));
}

function getPromptTransformHistoryForText(history, currentText) {
    const entries = Array.isArray(history) ? history : [];
    const scopedHistory = [];
    let expectedAfterText = normalizeContentText(currentText);

    // Keep only the contiguous edit chain that produced the active message text.
    for (let i = entries.length - 1; i >= 0; i--) {
        const entry = entries[i];
        if (!entry || typeof entry !== 'object') {
            continue;
        }

        const afterText = normalizeContentText(entry.afterText);
        if (afterText !== expectedAfterText) {
            continue;
        }

        scopedHistory.unshift(entry);
        expectedAfterText = normalizeContentText(entry.beforeText);
    }

    return scopedHistory;
}

export function getPromptTransformHistoryForMessage(message) {
    const storedHistory = getAgentExtraValue(message, PROMPT_TRANSFORM_HISTORY_KEY);
    return getPromptTransformHistoryForText(storedHistory, message?.mes);
}

function getPreGenerationInterceptHistoryFromValue(history) {
    return Array.isArray(history)
        ? history.filter(entry => entry && typeof entry === 'object')
        : [];
}

export function getPreGenerationInterceptHistoryForMessage(message) {
    return getPreGenerationInterceptHistoryFromValue(
        getAgentExtraValue(message, PRE_GENERATION_INTERCEPT_HISTORY_KEY),
    );
}

function hasAgentDocumentHistory(message) {
    return getPromptTransformHistoryForMessage(message).length > 0 ||
        getPreGenerationInterceptHistoryForMessage(message).length > 0;
}

function unwrapAssistantResponseWrapper(value) {
    let text = normalizeContentText(value);
    let previousText = null;
    let passCount = 0;

    while (text !== previousText && passCount < 8) {
        previousText = text;
        const match = text.match(ASSISTANT_RESPONSE_WRAPPER_RE);
        if (!match) {
            break;
        }

        text = match[1];
        passCount += 1;
    }

    return text;
}

function unwrapContextInterceptOutput(value = '') {
    let text = unwrapAssistantResponseWrapper(value);
    let previousText = null;
    let passCount = 0;

    while (text !== previousText && passCount < 8) {
        previousText = text;
        const match = text.match(CONTEXT_INTERCEPT_OUTPUT_RE);
        if (!match) {
            break;
        }

        text = match[1];
        passCount += 1;
    }

    return text;
}

function formatContextMessageContent(content) {
    if (typeof content === 'string') {
        return content;
    }

    if (content === null || content === undefined) {
        return '';
    }

    return JSON.stringify(content, null, 2);
}

function serializeChatContext(chatMessages) {
    return JSON.stringify((Array.isArray(chatMessages) ? chatMessages : []).map(message => ({
        ...message,
        content: formatContextMessageContent(message?.content),
    })), null, 2);
}

function parseChatContext(value) {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) {
        throw new Error('Intercepted chat context must be a JSON array of chat messages.');
    }

    const allowedRoles = new Set(['system', 'user', 'assistant', 'tool']);
    for (const [index, message] of parsed.entries()) {
        if (!message || typeof message !== 'object' || Array.isArray(message)) {
            throw new Error(`Intercepted chat message at index ${index} must be an object.`);
        }

        if (!allowedRoles.has(message.role)) {
            throw new Error(`Intercepted chat message at index ${index} has an unsupported role.`);
        }

        const hasContent = typeof message.content === 'string' || Array.isArray(message.content);
        const hasToolCalls = Array.isArray(message.tool_calls);
        if (!hasContent && !hasToolCalls) {
            throw new Error(`Intercepted chat message at index ${index} must include content or tool_calls.`);
        }

        if (message.role === 'tool' && typeof message.tool_call_id !== 'string') {
            throw new Error(`Intercepted chat message at index ${index} must include tool_call_id for tool role.`);
        }
    }

    return parsed;
}

function buildPatchTaggedText(text, preProcess = {}) {
    const startTag = String(preProcess.patchStartTag ?? '').trim() || '<context_patch>';
    const endTag = String(preProcess.patchEndTag ?? '').trim() || '</context_patch>';
    return `${startTag}\n${text}\n${endTag}`;
}

function applyContextInterceptText(originalText, interceptText, preProcess = {}) {
    const outputText = unwrapContextInterceptOutput(interceptText);
    const applyMode = preProcess.applyMode === 'wrap' || preProcess.applyMode === 'patch'
        ? preProcess.applyMode
        : 'replace';

    if (applyMode === 'wrap') {
        const wrappedText = `${String(preProcess.wrapPrefix ?? '')}${outputText}${String(preProcess.wrapSuffix ?? '')}`;
        if (preProcess.wrapPosition === 'before') {
            return joinPromptTransformText(wrappedText, originalText);
        }

        return joinPromptTransformText(originalText, wrappedText);
    }

    if (applyMode === 'patch') {
        return joinPromptTransformText(originalText, buildPatchTaggedText(outputText, preProcess));
    }

    return outputText;
}

function buildPromptTransformMessages(agentPrompt, messageText, assistantName, generationType, mode) {
    const isImpersonate = isImpersonateGenerationType(generationType);
    const targetLabel = isImpersonate ? 'generated impersonation text' : 'assistant response';
    const originalLabel = isImpersonate ? 'original text' : 'original response';
    const contentLabel = isImpersonate ? 'text' : 'response';
    const actionInstruction = mode === 'append'
        ? `Generate only the new content that should be appended after the ${targetLabel} according to the instructions above. Do not repeat, rewrite, summarize, or quote the original ${targetLabel}. Return only the appended content, with no labels or commentary unless the appended content itself requires them.`
        : `Rewrite the ${targetLabel} according to the instructions above. Return only the final rewritten ${targetLabel}. If no changes are needed, return the ${originalLabel} verbatim. Do not add commentary, labels, or code fences unless the ${contentLabel} itself requires them.`;
    const currentAssistantResponse = unwrapAssistantResponseWrapper(messageText);
    const responseLabel = isImpersonate ? 'Current generated impersonation text' : 'Current assistant response';

    return [
        {
            role: 'system',
            content: `${agentPrompt}\n\n${actionInstruction}`,
        },
        {
            role: 'user',
            content: `Assistant name: ${assistantName || 'Assistant'}\nGeneration type: ${generationType}\n\n${responseLabel}:\n<assistant_response>\n${currentAssistantResponse}\n</assistant_response>`,
        },
    ];
}

function buildContextInterceptMessages(agentPrompt, contextText, generationType, contextFormat, timing = PRE_GENERATION_INTERCEPT_TIMING) {
    if (timing === POST_MAIN_GENERATION_INTERCEPT_TIMING) {
        return [
            {
                role: 'system',
                content: `${agentPrompt}\n\nYou are modifying the assistant response after the main model generated it, before it is shown or saved. Return only the final assistant response requested by the instructions above. Do not add commentary, labels, or code fences unless they are part of the response itself. If no changes are needed, return the original response verbatim.`,
            },
            {
                role: 'user',
                content: `Generation type: ${generationType}\n\nMain model output:\n<assistant_response>\n${contextText}\n</assistant_response>`,
            },
        ];
    }

    const formatLabel = contextFormat === 'chat' ? 'JSON array of chat-completion messages' : 'plain text completion prompt';

    return [
        {
            role: 'system',
            content: `${agentPrompt}\n\nYou are modifying the complete outgoing context before the main model sees it. Return only the revised context content requested by the instructions above. Do not add commentary, labels, or code fences unless they are part of the context itself. If no changes are needed, return the original context content verbatim.`,
        },
        {
            role: 'user',
            content: `Generation type: ${generationType}\nContext format: ${formatLabel}\n\nOutgoing context:\n<context>\n${contextText}\n</context>`,
        },
    ];
}

function appendPromptTransformOutput(originalText, appendedText) {
    const baseText = unwrapAssistantResponseWrapper(originalText);
    const addition = unwrapAssistantResponseWrapper(appendedText).trim();

    if (!addition) {
        return baseText;
    }

    if (!baseText) {
        return addition;
    }

    if (baseText.endsWith('\n\n')) {
        return baseText + addition;
    }

    if (baseText.endsWith('\n')) {
        return `${baseText}\n${addition}`;
    }

    return `${baseText}\n\n${addition}`;
}

function joinPromptTransformText(leftText, rightText) {
    const left = unwrapAssistantResponseWrapper(leftText);
    const right = unwrapAssistantResponseWrapper(rightText);

    if (!left) {
        return right;
    }

    if (!right) {
        return left;
    }

    if (left.endsWith('\n\n') || right.startsWith('\n\n')) {
        return left + right;
    }

    if (left.endsWith('\n') || right.startsWith('\n')) {
        return `${left}\n${right}`;
    }

    return `${left}\n\n${right}`;
}

function shouldPrependPromptTransformOutput(agent, outputText = '') {
    const templateId = String(agent?.sourceTemplateId ?? '').trim();
    if (PREPEND_PROMPT_TRANSFORM_TEMPLATE_IDS.has(templateId)) {
        return true;
    }

    return PREPEND_PROMPT_TRANSFORM_TAG_RE.test(normalizeContentText(outputText));
}

function sanitizePromptTransformRunForStorage(result) {
    if (!result || typeof result !== 'object') {
        return result;
    }

    // Keep beforeText and nextMessageText for diff/undo — only strip raw outputText
    const storedResult = { ...result };
    delete storedResult.outputText;
    return storedResult;
}

function sanitizePreGenerationInterceptRunForStorage(result) {
    if (!result || typeof result !== 'object') {
        return result;
    }

    return {
        agentId: result.agentId,
        agentName: result.agentName,
        applyMode: result.applyMode,
        timing: result.timing === POST_MAIN_GENERATION_INTERCEPT_TIMING
            ? POST_MAIN_GENERATION_INTERCEPT_TIMING
            : PRE_GENERATION_INTERCEPT_TIMING,
        contextFormat: result.contextFormat,
        status: result.status,
        changed: Boolean(result.changed),
        beforeText: normalizeContentText(result.beforeText),
        afterText: normalizeContentText(result.afterText),
        outputText: normalizeContentText(result.outputText),
        profileId: result.profileId ?? '',
        runner: result.runner ?? '',
        role: result.role ?? '',
        timestamp: result.timestamp,
        error: result.error,
    };
}

function takePendingPreGenerationInterceptRuns() {
    const runs = pendingPreGenerationInterceptRuns;
    pendingPreGenerationInterceptRuns = [];
    return runs;
}

function storePreGenerationInterceptHistory(message, runs) {
    if (!message || !Array.isArray(runs) || runs.length === 0) {
        return false;
    }

    const storedRuns = runs
        .map(result => sanitizePreGenerationInterceptRunForStorage(result))
        .filter(result => result && typeof result === 'object' && result.status !== 'skipped-empty-prompt');

    if (storedRuns.length === 0) {
        return false;
    }

    setAgentExtraValue(message, PRE_GENERATION_INTERCEPT_HISTORY_KEY, storedRuns.slice(-MAX_TRANSFORM_HISTORY));
    return true;
}

function consolidateAppendPromptTransformOutputs(baseText, agents, results) {
    const prependSegments = [];
    const appendSegments = [];
    const seenSegments = new Set();
    const agentMap = new Map((Array.isArray(agents) ? agents : []).map(agent => [agent.id, agent]));
    const normalizedBaseText = unwrapAssistantResponseWrapper(baseText);

    for (const result of Array.isArray(results) ? results : []) {
        const outputText = unwrapAssistantResponseWrapper(result?.outputText).trim();
        if (!outputText) {
            continue;
        }

        const agent = agentMap.get(result.agentId);
        const shouldPrepend = shouldPrependPromptTransformOutput(agent, outputText);
        const dedupeKey = `${shouldPrepend ? 'prepend' : 'append'}:${outputText}`;
        if (seenSegments.has(dedupeKey)) {
            continue;
        }

        seenSegments.add(dedupeKey);
        (shouldPrepend ? prependSegments : appendSegments).push(outputText);
    }

    let mergedText = normalizedBaseText;
    if (prependSegments.length > 0) {
        mergedText = joinPromptTransformText(prependSegments.join('\n\n'), mergedText);
    }
    if (appendSegments.length > 0) {
        mergedText = joinPromptTransformText(mergedText, appendSegments.join('\n\n'));
    }

    return {
        text: mergedText,
        changed: mergedText !== normalizedBaseText,
        beforeText: normalizedBaseText,
    };
}

function getConfiguredHelperPrefillText() {
    return getGlobalSettings()?.helperPrefillMessages ?? '';
}

function appendConfiguredHelperPrefillMessages(promptMessages) {
    const helperPrefillText = getConfiguredHelperPrefillText();
    const helperPrefillMessages = parseHelperPrefillMessages(helperPrefillText);
    if (helperPrefillMessages.length === 0) {
        return {
            promptMessages,
            allowAssistantPrefillTail: false,
        };
    }

    return {
        promptMessages: appendHelperPrefillMessages(promptMessages, helperPrefillText),
        allowAssistantPrefillTail: helperPrefillMessages.at(-1)?.role === 'assistant',
    };
}

function getUserFinalPromptTransformMessages(promptMessages, options = {}) {
    const messages = (Array.isArray(promptMessages) ? promptMessages : [])
        .filter(message => message && typeof message === 'object')
        .map(message => ({
            ...message,
            role: String(message.role ?? 'user').trim().toLowerCase() || 'user',
        }));

    if (messages.length === 0) {
        return [{ role: 'user', content: 'Return only the requested transformed text.' }];
    }

    const hasToolCallContext = messages.some(message => message.role === 'tool' || Array.isArray(message.tool_calls));
    const lastMessage = messages[messages.length - 1];
    if (lastMessage.role === 'user' || hasToolCallContext) {
        return messages;
    }

    if (options.allowAssistantPrefillTail && lastMessage.role === 'assistant') {
        return messages;
    }

    // Prompt-transform helper prompts are synthetic requests, not real chat/tool-call tails.
    // Keep providers that reject assistant-prefill tails happy by appending a tiny user turn
    // instead of role-flipping any existing assistant content.
    return [
        ...messages,
        { role: 'user', content: 'Return only the requested transformed text.' },
    ];
}

function canUseMainChatCompletionHelper(context) {
    return context?.mainApi === 'openai' && typeof context?.generateRaw === 'function';
}

async function requestMainChatCompletionPromptTransform(context, promptMessages, maxTokens, options = {}, signal = null) {
    const output = await context.generateRaw({
        prompt: getUserFinalPromptTransformMessages(promptMessages, options),
        api: 'openai',
        instructOverride: true,
        responseLength: maxTokens,
        trimNames: false,
        signal,
        cacheScope: 'auxiliary',
    });

    return {
        output: extractProfileResponseText({ content: output }),
        runner: 'main',
        profileId: '',
    };
}

async function requestProfilePromptTransform(CMRS, profileId, promptMessages, maxTokens, modelOverride = '', signal = null) {
    const requestOptions = {
        extractData: true,
        includePreset: true,
        includeInstruct: true,
        stream: false,
        signal,
    };

    if (modelOverride && modelOverride.trim()) {
        requestOptions.modelOverride = modelOverride.trim();
    }

    try {
        const primaryResponse = await CMRS.sendRequest(profileId, promptMessages, maxTokens, requestOptions);
        const primaryOutput = extractProfileResponseText(primaryResponse);
        if (primaryOutput.trim()) {
            return {
                output: primaryOutput,
                runner: 'profile',
                profileId,
            };
        }
    } catch (error) {
        if (isAbortSignalTriggered(error, signal)) {
            throw error;
        }

        console.warn(`[InChatAgents] Primary prompt transform request via ${describePromptTransformTarget(profileId, 'profile')} failed, retrying with fallback prompt formatting.`, error);
    }

    let fallbackPrompt = '';
    if (typeof CMRS.constructPrompt === 'function') {
        try {
            fallbackPrompt = CMRS.constructPrompt(promptMessages, profileId) ?? '';
        } catch (error) {
            console.warn(`[InChatAgents] Failed to construct fallback prompt for ${describePromptTransformTarget(profileId, 'profile')}.`, error);
        }
    }

    const fallbackRequestPrompt = Array.isArray(fallbackPrompt)
        ? fallbackPrompt
        : (normalizeContentText(fallbackPrompt).trim() ? normalizeContentText(fallbackPrompt) : buildFallbackPromptText(promptMessages));

    const fallbackOptions = {
        extractData: true,
        includePreset: true,
        includeInstruct: false,
        stream: false,
        signal,
    };

    if (modelOverride && modelOverride.trim()) {
        fallbackOptions.modelOverride = modelOverride.trim();
    }

    const fallbackResponse = await CMRS.sendRequest(profileId, fallbackRequestPrompt, maxTokens, fallbackOptions);

    return {
        output: extractProfileResponseText(fallbackResponse),
        runner: 'profile',
        profileId,
    };
}

export async function requestPromptTransform(agent, promptMessages, maxTokens, options = {}) {
    const profileId = resolveAgentConnectionProfile(agent);
    const modelOverride = typeof agent.modelOverride === 'string' ? agent.modelOverride.trim() : '';
    const context = getContext();
    const CMRS = context?.ConnectionManagerRequestService;
    const requestAbortController = new AbortController();
    const runAsInternalPromptTransform = async (requestFn) => {
        internalPromptTransformDepth++;
        notifyAgentGenerationStateChanged();
        try {
            return await requestFn();
        } finally {
            internalPromptTransformDepth = Math.max(0, internalPromptTransformDepth - 1);
            notifyPromptTransformIdle();
            notifyAgentGenerationStateChanged();
        }
    };

    activeAgentRequestAbortControllers.add(requestAbortController);

    try {
        if (profileId) {
            if (!CMRS || typeof CMRS.sendRequest !== 'function') {
                throw new Error(`${describePromptTransformTarget(profileId, 'profile')} is set, but Connection Manager is unavailable.`);
            }

            return await runAsInternalPromptTransform(async () =>
                await requestProfilePromptTransform(CMRS, profileId, promptMessages, maxTokens, modelOverride, requestAbortController.signal),
            );
        }

        if (canUseMainChatCompletionHelper(context)) {
            return await runAsInternalPromptTransform(async () =>
                await requestMainChatCompletionPromptTransform(context, promptMessages, maxTokens, options, requestAbortController.signal),
            );
        }

        const quietPrompt = promptMessages
            .map(message => `${message.role.toUpperCase()}:\n${normalizeContentText(message?.content)}`)
            .join('\n\n');
        const preservedPrompts = Object.entries(extension_prompts)
            .filter(([key]) => key.startsWith(PROMPT_KEY_PREFIX));

        for (const [key] of preservedPrompts) {
            delete extension_prompts[key];
        }

        try {
            return await runAsInternalPromptTransform(async () => ({
                output: await generateQuietPrompt({
                    quietPrompt,
                    quietName: 'In-Chat Agent',
                    skipWIAN: true,
                    responseLength: maxTokens,
                    removeReasoning: true,
                    signal: requestAbortController.signal,
                }),
                runner: 'main',
                profileId: '',
            }));
        } finally {
            for (const [key, value] of preservedPrompts) {
                extension_prompts[key] = value;
            }
        }
    } finally {
        activeAgentRequestAbortControllers.delete(requestAbortController);
    }
}

async function runPromptTransformAgent(agent, message, generationType, messageTextOverride = null, messageIndex = null, options = {}) {
    const applyToMessage = options.applyToMessage !== false;
    const currentMessageText = unwrapAssistantResponseWrapper(
        messageTextOverride !== null ? messageTextOverride : message?.mes,
    );
    const normalizedGenerationType = normalizeGenerationType(generationType);
    const promptTransformMode = getPromptTransformMode(agent);
    const profileId = resolveAgentConnectionProfile(agent);
    const runMetadata = getPromptTransformRunMetadata(agent, profileId);
    const showNotifications = shouldShowPromptTransformNotifications(agent);

    if (!currentMessageText.trim()) {
        const result = {
            agentId: agent.id,
            agentName: agent.name,
            changed: false,
            status: 'skipped-empty-message',
            mode: promptTransformMode,
            profileId,
            ...runMetadata,
            runner: 'none',
            timestamp: new Date().toISOString(),
            outputText: '',
            nextMessageText: currentMessageText,
            beforeText: currentMessageText,
        };

        return result;
    }

    const expandedPrompt = substituteParams(agent.prompt, {
        name2Override: String(message?.name ?? '').trim(),
        original: currentMessageText,
        dynamicMacros: buildPromptDynamicMacros(currentMessageText, message, agent, normalizedGenerationType),
    }).trim();

    if (!expandedPrompt) {
        const result = {
            agentId: agent.id,
            agentName: agent.name,
            changed: false,
            status: 'skipped-empty-prompt',
            mode: promptTransformMode,
            profileId,
            ...runMetadata,
            runner: 'none',
            timestamp: new Date().toISOString(),
            outputText: '',
            nextMessageText: currentMessageText,
            beforeText: currentMessageText,
        };

        return result;
    }

    const helperRequest = appendConfiguredHelperPrefillMessages(buildPromptTransformMessages(
        expandedPrompt,
        currentMessageText,
        String(message?.name ?? '').trim(),
        normalizedGenerationType,
        promptTransformMode,
    ));
    const cancelRevision = agentGenerationCancelRevision;
    const runningToast = showNotifications
        ? showPromptTransformRunningToast(agent, promptTransformMode, profileId)
        : null;

    try {
        const maxTokens = normalizePromptTransformMaxTokens(agent.postProcess?.promptTransformMaxTokens);
        const response = await requestPromptTransform(
            agent,
            helperRequest.promptMessages,
            maxTokens,
            { allowAssistantPrefillTail: helperRequest.allowAssistantPrefillTail },
        );
        const promptOutputText = unwrapAssistantResponseWrapper(response.output).trim();

        if (!promptOutputText) {
            console.warn(`[InChatAgents] ${describePromptTransformMode(promptTransformMode)} agent "${agent.name}" returned an empty response.`);
            const result = {
                agentId: agent.id,
                agentName: agent.name,
                changed: false,
                status: 'empty-response',
                mode: promptTransformMode,
                profileId: response.profileId,
                ...getPromptTransformRunMetadata(agent, response.profileId),
                runner: response.runner,
                timestamp: new Date().toISOString(),
                outputText: '',
                nextMessageText: currentMessageText,
                beforeText: currentMessageText,
            };

            if (showNotifications) {
                showPromptTransformResultToast(agent, result);
            }

            return result;
        }

        const nextMessageText = promptTransformMode === 'append'
            ? appendPromptTransformOutput(currentMessageText, promptOutputText)
            : promptOutputText;
        if (agentGenerationCancelRevision !== cancelRevision) {
            return {
                agentId: agent.id,
                agentName: agent.name,
                changed: false,
                status: 'cancelled',
                mode: promptTransformMode,
                profileId: response.profileId,
                ...getPromptTransformRunMetadata(agent, response.profileId),
                runner: response.runner,
                timestamp: new Date().toISOString(),
                outputText: '',
                nextMessageText: currentMessageText,
                beforeText: currentMessageText,
            };
        }

        const changed = nextMessageText !== currentMessageText;
        if (changed && applyToMessage) {
            message.mes = nextMessageText;
            await syncPromptTransformMessageStateAsync(message, messageIndex);
        }

        console.info(`[InChatAgents] ${describePromptTransformMode(promptTransformMode)} agent "${agent.name}" ran via ${describePromptTransformTarget(response.profileId, response.runner)}${changed ? ' and changed the message.' : ' with no text change.'}`);

        const result = {
            agentId: agent.id,
            agentName: agent.name,
            changed,
            status: changed ? 'changed' : 'unchanged',
            mode: promptTransformMode,
            profileId: response.profileId,
            ...getPromptTransformRunMetadata(agent, response.profileId),
            runner: response.runner,
            timestamp: new Date().toISOString(),
            outputText: promptOutputText,
            nextMessageText,
            beforeText: currentMessageText,
        };

        if (showNotifications) {
            showPromptTransformResultToast(agent, result);
        }

        return result;
    } catch (error) {
        if (agentGenerationCancelRevision !== cancelRevision || generationStopRequested || isAbortSignalTriggered(error)) {
            return {
                agentId: agent.id,
                agentName: agent.name,
                changed: false,
                status: 'cancelled',
                mode: promptTransformMode,
                profileId,
                ...runMetadata,
                runner: 'cancelled',
                timestamp: new Date().toISOString(),
                outputText: '',
                nextMessageText: currentMessageText,
                beforeText: currentMessageText,
            };
        }

        console.warn(`[InChatAgents] ${describePromptTransformMode(promptTransformMode)} failed in agent "${agent.name}":`, error);
        const result = {
            agentId: agent.id,
            agentName: agent.name,
            changed: false,
            status: 'error',
            mode: promptTransformMode,
            error: error instanceof Error ? error.message : String(error),
            profileId,
            ...runMetadata,
            runner: 'error',
            timestamp: new Date().toISOString(),
            outputText: '',
            nextMessageText: currentMessageText,
            beforeText: currentMessageText,
        };

        if (showNotifications) {
            showPromptTransformResultToast(agent, result);
        }

        return result;
    } finally {
        clearPromptTransformRunningToast(runningToast);
    }
}

async function runPromptTransformAppendBatch(agents, message, generationType, messageTextOverride = null, messageIndex = null) {
    const currentMessageText = unwrapAssistantResponseWrapper(
        messageTextOverride !== null ? messageTextOverride : message?.mes,
    );
    const globalSettings = getGlobalSettings();
    const executionMode = globalSettings.appendAgentsExecutionMode === 'sequential' ? 'sequential' : 'parallel';

    let results = [];

    if (executionMode === 'sequential') {
        for (const agent of agents) {
            try {
                const result = await runPromptTransformAgent(agent, message, generationType, currentMessageText, messageIndex, {
                    applyToMessage: false,
                });
                results.push(result);
            } catch (error) {
                results.push({
                    agentId: agent.id,
                    agentName: agent.name,
                    changed: false,
                    status: 'error',
                    mode: getPromptTransformMode(agent),
                    error: error instanceof Error ? error.message : String(error),
                    runner: 'error',
                    timestamp: new Date().toISOString(),
                    outputText: '',
                    nextMessageText: currentMessageText,
                    beforeText: currentMessageText,
                });
            }
        }
    } else {
        results = await Promise.all(
            agents.map(async (agent) => {
                try {
                    return await runPromptTransformAgent(agent, message, generationType, currentMessageText, messageIndex, {
                        applyToMessage: false,
                    });
                } catch (error) {
                    return {
                        agentId: agent.id,
                        agentName: agent.name,
                        changed: false,
                        status: 'error',
                        mode: getPromptTransformMode(agent),
                        error: error instanceof Error ? error.message : String(error),
                        runner: 'error',
                        timestamp: new Date().toISOString(),
                        outputText: '',
                        nextMessageText: currentMessageText,
                        beforeText: currentMessageText,
                    };
                }
            }),
        );
    }

    const consolidated = consolidateAppendPromptTransformOutputs(currentMessageText, agents, results);
    if (consolidated.changed) {
        message.mes = consolidated.text;
        await syncPromptTransformMessageStateAsync(message, messageIndex);
    }

    return {
        results,
        changed: consolidated.changed,
        nextMessageText: consolidated.text,
        beforeText: currentMessageText,
    };
}

async function refreshMessageAfterMutation(messageIndex, message, { deferBackup = false, skipReloadFallback = false } = {}) {
    const context = getContext();
    const messageElement = document.querySelector(`.mes[mesid="${messageIndex}"]`);

    if (messageElement && typeof context?.updateMessageBlock === 'function') {
        // Await the repaint so MESSAGE_UPDATED fires only after the DOM is actually
        // re-rendered. On the deferred mobile path updateMessageBlock resolves after the
        // rAF flush; otherwise it resolves synchronously. This lets DOM-mutating
        // listeners (e.g. Dialogue Colors) re-decorate against the final DOM instead of
        // racing the deferred render.
        await context.updateMessageBlock(messageIndex, message);

        if (typeof eventSource?.emit === 'function' && event_types?.MESSAGE_UPDATED) {
            await eventSource.emit(event_types.MESSAGE_UPDATED, messageIndex);
        }

        return;
    }

    // Bookkeeping-only mutations (regex snapshot adds/removals in message.extra) never change what an
    // unrendered message will look like once it is lazy-loaded, so they must not fall through to the
    // save+reload path below: reloading the whole chat for every off-screen message races the debounced
    // save against clearChat() and can persist an emptied chat. Persistence is already arranged by the
    // snapshot-update call sites that set this flag.
    if (skipReloadFallback) {
        return;
    }

    await saveChatForAgent(context, { deferBackup });

    if (typeof context?.reloadCurrentChat === 'function') {
        await context.reloadCurrentChat();
        return;
    }

    if (typeof eventSource?.emit === 'function' && event_types?.MESSAGE_UPDATED) {
        await eventSource.emit(event_types.MESSAGE_UPDATED, messageIndex);
        return;
    }

    if (typeof eventSource?.emit === 'function' && event_types?.CHAT_CHANGED) {
        await eventSource.emit(event_types.CHAT_CHANGED);
    }
}

function scheduleMessageRefresh(messageIndex, expectedMessage, { deferBackup = false, skipReloadFallback = false } = {}) {
    const existingRefresh = pendingRefreshTimeouts.get(messageIndex);
    if (existingRefresh) {
        clearTimeout(existingRefresh.timeoutId);
    }

    // When a pending refresh for the same message is replaced, a full-fallback request must never be
    // downgraded to a bookkeeping-only one, or a genuine text mutation could miss its refresh.
    const mergedSkipReloadFallback = existingRefresh
        ? (existingRefresh.skipReloadFallback && skipReloadFallback)
        : skipReloadFallback;

    const timeoutId = setTimeout(async () => {
        pendingRefreshTimeouts.delete(messageIndex);

        const liveMessage = chat[messageIndex];
        if (!liveMessage || liveMessage !== expectedMessage) {
            return;
        }

        await refreshMessageAfterMutation(messageIndex, liveMessage, { deferBackup, skipReloadFallback: mergedSkipReloadFallback });
    }, 0);

    pendingRefreshTimeouts.set(messageIndex, { timeoutId, skipReloadFallback: mergedSkipReloadFallback });
}

function clearInChatAgentExtensionPrompts() {
    for (const key of Object.keys(extension_prompts)) {
        if (key.startsWith(PROMPT_KEY_PREFIX)) {
            delete extension_prompts[key];
        }
    }
    clearPathfinderExtensionPrompts();
}

function clearPathfinderExtensionPrompts() {
    for (const key of Object.keys(extension_prompts)) {
        if (PATHFINDER_RETRIEVAL_PROMPT_KEYS.includes(key) || key === PATHFINDER_AUTO_SUMMARY_PROMPT_KEY) {
            delete extension_prompts[key];
        }
    }
}

export function deactivatePathfinderRuntime() {
    clearPathfinderRetrievalToast();
    abortActivePathfinderRetrieval('Pathfinder disabled.');
    clearPathfinderExtensionPrompts();
    toolRecursionDepth = 0;
    syncToolAgentRegistrations();
}

function injectPreGenerationAgentPrompts(activeAgents, generationType) {
    const promptAgents = activeAgents.filter(agent =>
        !isCompanionAgent(agent) &&
        (agent.phase === 'pre' || agent.phase === 'both') &&
        agent.preProcess?.mode !== 'intercept',
    );

    for (const agent of promptAgents) {
        if (isToolAgent(agent)) {
            continue;
        }

        const expandedPrompt = substituteParams(agent.prompt, {
            dynamicMacros: buildPromptDynamicMacros('', null, agent, generationType),
        });
        if (!expandedPrompt.trim()) {
            continue;
        }

        const key = PROMPT_KEY_PREFIX + agent.id;
        setExtensionPrompt(
            key,
            expandedPrompt,
            agent.injection.position,
            agent.injection.depth,
            agent.injection.scan,
            agent.injection.role,
        );
    }
}

/**
 * Cleans up all in-chat agent extension prompts before a new generation.
 */
function onGenerationStarted(generationType, _options, dryRun) {
    swipeNavigationPending = false;

    if (dryRun || internalPromptTransformDepth > 0) {
        return;
    }

    currentMainGenerationType = normalizeGenerationType(generationType);
    isGenerationInProgress = true;
    generationStartChatId = getCurrentSnapshotChatId();
    postProcessingInvalidatedByChatChange = false;
    toolSyncDuringGeneration = true;
    generationStopRequested = false;
    generationStartedAt = Date.now();
    lastMainGenerationEndedAt = 0;
    postProcessingGenerationRunId++;
    stoppedGenerationRunId = -1;
    stoppedStreamingMessageIndexes.clear();
    clearLatestAssistantPostProcessingFallback();
    clearPostGenerationRecoveryCheck();
    clearMissedGenerationEndRecoveryCheck();
    clearAllPromptTransformRunningToasts();
    clearInitialGenerationToast();
    takePendingPreGenerationInterceptRuns();
    pendingGenerationSnapshot = buildActivationSnapshot(currentMainGenerationType);
    generationStartChatLength = chat.length;
    const latestAssistantMessageIndex = getLatestAssistantMessageIndex();
    generationStartLastAssistantIndex = latestAssistantMessageIndex;
    generationStartLastAssistantMessage = latestAssistantMessageIndex >= 0 ? chat[latestAssistantMessageIndex] : null;
    generationStartLastAssistantRevision = getMessageRevisionKey(generationStartLastAssistantMessage);
    processedPostProcessingRunsByIndex.clear();

    const lastMsg = chat[chat.length - 1];
    const isRecursiveToolPass = lastMsg?.extra?.tool_invocations != null;
    if (isRecursiveToolPass) {
        toolRecursionDepth++;
    } else {
        toolRecursionDepth = 0;
    }

    clearInChatAgentExtensionPrompts();
}

function onGenerationEnded() {
    if (internalPromptTransformDepth > 0) {
        return;
    }

    clearInitialGenerationToast();

    if (stoppedGenerationRunId === postProcessingGenerationRunId) {
        isGenerationInProgress = false;
        lastMainGenerationEndedAt = Date.now();
        toolSyncDuringGeneration = false;
        clearLatestAssistantPostProcessingFallback();
        clearPostGenerationRecoveryCheck();
        clearMissedGenerationEndRecoveryCheck();
        clearDeferredPostProcessing();
        clearAllPromptTransformRunningToasts();
        return;
    }

    if (postProcessingInvalidatedByChatChange || isCurrentGenerationChatStale()) {
        isGenerationInProgress = false;
        toolSyncDuringGeneration = false;
        generationStopRequested = false;
        clearPendingPostProcessingForChatChange();
        return;
    }

    pendingGenerationSnapshot ??= buildActivationSnapshot(currentMainGenerationType);
    isGenerationInProgress = false;
    lastMainGenerationEndedAt = Date.now();
    toolSyncDuringGeneration = false;
    generationStopRequested = false;
    clearMissedGenerationEndRecoveryCheck();
    clearAllPromptTransformRunningToasts();
    queueLatestAssistantPostProcessingFromSnapshot();
    scheduleDeferredPostProcessingFlush();
    schedulePostGenerationRecoveryCheck();
    latestAssistantPostProcessingFallbackDeadline = Date.now() + LATEST_ASSISTANT_POST_PROCESSING_FALLBACK_WINDOW_MS;
    scheduleLatestAssistantPostProcessingFallback();
}

function onGenerationStopped() {
    if (internalPromptTransformDepth > 0) {
        return;
    }

    generationStopRequested = true;
    stoppedGenerationRunId = postProcessingGenerationRunId;
    const stoppedMessageIndex = Number(streamingProcessor?.messageId);
    if (Number.isInteger(stoppedMessageIndex) && stoppedMessageIndex >= 0) {
        stoppedStreamingMessageIndexes.add(stoppedMessageIndex);
    }
    isGenerationInProgress = false;
    lastMainGenerationEndedAt = Date.now();
    clearLatestAssistantPostProcessingFallback();
    clearPostGenerationRecoveryCheck();
    clearMissedGenerationEndRecoveryCheck();
    clearDeferredPostProcessing();
    clearAllPromptTransformRunningToasts();
    clearPathfinderRetrievalToast();
    clearInitialGenerationToast();
    takePendingPreGenerationInterceptRuns();
    abortActivePathfinderRetrieval('Pathfinder retrieval cancelled because generation stopped.');
}

/**
 * Injects pre-generation agent prompts.
 * @param {string} generationType
 * @param {object} _options
 * @param {boolean} dryRun
 */
async function onGenerationAfterCommands(generationType, _options, dryRun) {
    if (internalPromptTransformDepth > 0) {
        return;
    }

    const normalizedGenerationType = normalizeGenerationType(generationType);

    if (dryRun && isGenerationInProgress) {
        return;
    }

    if (dryRun) {
        clearInChatAgentExtensionPrompts();
    }

    if (!areAgentsGloballyEnabled()) {
        return;
    }

    const activationSnapshot = dryRun
        ? buildActivationSnapshot(normalizedGenerationType)
        : pendingGenerationSnapshot?.generationType === normalizedGenerationType
            ? cloneActivationSnapshot(pendingGenerationSnapshot, normalizedGenerationType)
            : buildActivationSnapshot(normalizedGenerationType);

    if (!dryRun) {
        pendingGenerationSnapshot = activationSnapshot;
    }

    const activeAgents = getSnapshotAgents(activationSnapshot);
    const pathfinderAgent = getPathfinderRuntimeAgent(activeAgents);

    if (!dryRun && pathfinderAgent) {
        const retrievalCancelRevision = agentGenerationCancelRevision;
        syncPathfinderRuntimeSettings(pathfinderAgent);
        const retrievalCacheTarget = getPathfinderRetrievalCacheTarget(normalizedGenerationType);
        const retrievalCacheSignature = buildPathfinderRetrievalCacheSignature(pathfinderAgent, activationSnapshot, normalizedGenerationType, retrievalCacheTarget);
        const cachedRetrieval = findPathfinderRetrievalCache(retrievalCacheTarget?.message, retrievalCacheSignature);
        let retrievalAbortController = null;

        if (cachedRetrieval) {
            restorePathfinderRetrievalPromptSnapshot(cachedRetrieval);
        } else {
            retrievalAbortController = new AbortController();
            activePathfinderRetrievalAbortControllers.add(retrievalAbortController);

            try {
                if (shouldShowPathfinderRetrievalToast(pathfinderAgent)) {
                    showPathfinderRetrievalToast();
                }
                await runSidecarRetrieval(setExtensionPrompt, extension_prompt_types, extension_prompt_roles, retrievalAbortController.signal);
            } finally {
                clearPathfinderRetrievalToast();
                activePathfinderRetrievalAbortControllers.delete(retrievalAbortController);
            }

            if (!generationStopRequested && agentGenerationCancelRevision === retrievalCancelRevision && !retrievalAbortController.signal.aborted) {
                storePathfinderRetrievalCache(retrievalCacheTarget?.message, retrievalCacheSignature);
            }
        }

        if (generationStopRequested || agentGenerationCancelRevision !== retrievalCancelRevision || retrievalAbortController?.signal.aborted) {
            return;
        }

        if (shouldAutoSummarize() && isPathfinderSummarizeToolEnabled(pathfinderAgent)) {
            setExtensionPrompt(
                PATHFINDER_AUTO_SUMMARY_PROMPT_KEY,
                'Pathfinder memory summary is due. If the recent conversation contains a meaningful scene, event, state change, or resolved arc, call Pathfinder_Summarize with a concise title, useful content, significance, and arc when applicable. If nothing important happened, do not call it.',
                extension_prompt_types.IN_PROMPT,
                4,
                false,
                extension_prompt_roles.SYSTEM,
            );
            // SillyBunny: do NOT reset the counter here. The counter is reset
            // only after the Pathfinder_Summarize tool actually writes a summary.
            // Resetting at injection time caused the interval to be consumed even
            // when the model skipped or failed the tool call, preventing future
            // summaries from triggering. (#530)
        }
    }

    injectPreGenerationAgentPrompts(activeAgents, generationType);
    companionRuntime?.injectCompanionFeedbackPrompts?.(activeAgents);

    if (!dryRun) {
        syncToolAgentRegistrations();
    }
}

/**
 * Runs post-generation utilities on the received message and snapshots active regex scripts.
 * @param {number} messageIndex
 * @param {string} generationType
 * @param {{ generationType: string, activeAgentIds: string[], chatId: string } | null} activationSnapshot
 */
async function processReceivedMessage(messageIndex, generationType, activationSnapshot = null) {
    const message = chat[messageIndex];
    if (!message || message.is_user || message.is_system) {
        return;
    }

    if (!isAssistantPostProcessingGenerationType(activationSnapshot?.generationType ?? generationType)) {
        return;
    }

    const swipeId = Number(message?.swipe_id);
    const inFlightKey = `${messageIndex}:${Number.isInteger(swipeId) ? swipeId : 0}`;
    if (postProcessingInFlightKeys.has(inFlightKey)) {
        return;
    }

    postProcessingInFlightKeys.add(inFlightKey);
    try {
        syncAssistantMessageTextToSwipe(message);

        const resolvedActivationSnapshot = activationSnapshot
            ? cloneActivationSnapshot(activationSnapshot, generationType)
            : cloneActivationSnapshot(pendingGenerationSnapshot ?? buildActivationSnapshot(generationType), generationType);
        const runKey = getPostProcessingRunKey(message, generationType, resolvedActivationSnapshot);
        const indexRunKey = getPostProcessingIndexRunKey(message, messageIndex, generationType, resolvedActivationSnapshot);
        if (hasProcessedPostProcessingRun(message, runKey, messageIndex, indexRunKey)) {
            return;
        }
        markPostProcessingRunProcessed(message, runKey, messageIndex, indexRunKey);

        const activeAgents = getActiveAgentsForMessage(generationType, resolvedActivationSnapshot);
        let chatStateChanged = false;
        let messageDisplayChanged = false;

        const postDisplayInterceptResult = await runPostDisplayPostMainGenerationInterceptors(
            message,
            messageIndex,
            generationType,
            resolvedActivationSnapshot,
        );
        pendingPreGenerationInterceptRuns.push(...postDisplayInterceptResult.runs);
        if (postDisplayInterceptResult.changed) {
            chatStateChanged = true;
            messageDisplayChanged = true;
        }

        // Companions normally run last so they see the post-transform reply; the concurrent
        // option trades that for speed and runs them against the current reply alongside the passes.
        const companionStageArgs = { messageIndex, message, generationType, activeAgents };
        const concurrentCompanionStage = getGlobalSettings().companionConcurrentWithPostGen && companionRuntime?.runCompanionStage
            ? companionRuntime.runCompanionStage(companionStageArgs).catch(error => {
                console.warn('[InChatAgents] Companion stage failed:', error);
            })
            : null;
        const promptTransformAgents = getPromptTransformAgentsForMessage(activeAgents, generationType);
        const utilityAgents = isImpersonateGenerationType(generationType)
            ? []
            : activeAgents.filter(agent =>
                !isCompanionAgent(agent) &&
                agent.postProcess?.enabled &&
                agent.postProcess.type !== 'regex' &&
                (
                    agent.phase === 'post' ||
                    agent.phase === 'both' ||
                    agent.postProcess.type === 'extract'
                ),
            );

        if (storePreGenerationInterceptHistory(message, takePendingPreGenerationInterceptRuns())) {
            chatStateChanged = true;
            messageDisplayChanged = true;
        }

        const promptRuns = [];
        let currentPromptTransformText = unwrapAssistantResponseWrapper(message.mes);
        if (currentPromptTransformText !== normalizeContentText(message.mes)) {
            message.mes = currentPromptTransformText;
            await syncPromptTransformMessageStateAsync(message, messageIndex);
            chatStateChanged = true;
            messageDisplayChanged = true;
        }
        let appendBatch = [];
        const flushAppendBatch = async () => {
            if (appendBatch.length === 0) {
                return;
            }

            const batchAgents = appendBatch;
            appendBatch = [];

            const batchResult = await runPromptTransformAppendBatch(
                batchAgents,
                message,
                generationType,
                currentPromptTransformText,
                messageIndex,
            );
            promptRuns.push(...batchResult.results);
            currentPromptTransformText = batchResult.nextMessageText;

            if (batchResult.changed) {
                chatStateChanged = true;
                messageDisplayChanged = true;
            }
        };

        for (const agent of promptTransformAgents) {
            if (getPromptTransformMode(agent) === 'append') {
                appendBatch.push(agent);
                continue;
            }

            await flushAppendBatch();

            try {
                const result = await runPromptTransformAgent(agent, message, generationType, currentPromptTransformText, messageIndex);
                promptRuns.push(result);
                currentPromptTransformText = result.nextMessageText;

                if (result.changed) {
                    chatStateChanged = true;
                    messageDisplayChanged = true;
                }
            } catch (error) {
                promptRuns.push({
                    agentId: agent.id,
                    agentName: agent.name,
                    changed: false,
                    status: 'error',
                    mode: getPromptTransformMode(agent),
                    error: error instanceof Error ? error.message : String(error),
                    runner: 'error',
                    timestamp: new Date().toISOString(),
                });
            }
        }

        await flushAppendBatch();

        if (updatePromptTransformRuns(message, promptRuns)) {
            chatStateChanged = true;
        }

        let promptHistoryChanged = false;
        for (const run of promptRuns) {
            promptHistoryChanged = updatePromptTransformHistory(message, run) || promptHistoryChanged;
        }

        if (promptHistoryChanged) {
            chatStateChanged = true;
        }

        for (const agent of utilityAgents) {
            const postProcess = agent.postProcess;

            switch (postProcess.type) {
                case 'extract': {
                    if (!postProcess.extractPattern || !postProcess.extractVariable) {
                        break;
                    }

                    try {
                        const regex = new RegExp(postProcess.extractPattern, 'g');
                        const matches = message.mes.match(regex);
                        if (matches) {
                            chat_metadata[`agent_${postProcess.extractVariable}`] = matches.join('\n');
                            chatStateChanged = true;
                        }
                    } catch (error) {
                        console.warn(`[InChatAgents] Extract error in agent "${agent.name}":`, error);
                    }
                    break;
                }

                case 'append': {
                    if (!postProcess.appendText) {
                        break;
                    }

                    const appendedText = substituteParams(postProcess.appendText);
                    if (appendedText.trim()) {
                        message.mes += appendedText;
                        chatStateChanged = true;
                        messageDisplayChanged = true;
                    }
                    break;
                }
            }
        }

        if (updateMessageRegexSnapshot(message, activeAgents, generationType)) {
            chatStateChanged = true;
            messageDisplayChanged = true;
        }

        if (chatStateChanged) {
            syncAssistantMessageStateToSwipe(message, messageIndex);
            saveChatDebouncedForAgent({ deferBackup: false });
        }

        if (messageDisplayChanged) {
            scheduleMessageRefresh(messageIndex, message, { deferBackup: true });
        }

        if (concurrentCompanionStage) {
            await concurrentCompanionStage;
        } else if (companionRuntime?.runCompanionStage) {
            try {
                await companionRuntime.runCompanionStage(companionStageArgs);
            } catch (error) {
                console.warn('[InChatAgents] Companion stage failed:', error);
            }
        }
    } finally {
        postProcessingInFlightKeys.delete(inFlightKey);
    }
}

async function onMessageReceived(messageIndex, generationType) {
    if (!areAgentsGloballyEnabled()) {
        return;
    }

    if (isGreetingGenerationType(generationType)) {
        swipeNavigationPending = false;
        clearDeferredPostProcessing(Number(messageIndex));
        return;
    }

    if (postProcessingInvalidatedByChatChange || isCurrentGenerationChatStale()) {
        clearPendingPostProcessingForChatChange();
        return;
    }

    if (!isAssistantPostProcessingGenerationType(generationType)) {
        return;
    }

    if (internalPromptTransformDepth > 0) {
        deferPostProcessing(Number(messageIndex), generationType, buildActivationSnapshot(generationType));
        return;
    }

    const numericMessageIndex = Number(messageIndex);
    const message = chat[numericMessageIndex];
    if (!message || message.is_user || message.is_system) {
        return;
    }

    ensureMessageRegexSnapshot(numericMessageIndex, generationType);

    if (generationStopRequested || wasStreamingMessageStopped(numericMessageIndex)) {
        clearDeferredPostProcessing(numericMessageIndex);
        return;
    }

    if (isStreamingMessageStillActive(numericMessageIndex)) {
        deferPostProcessing(numericMessageIndex, generationType);
        return;
    }

    if (isMainGenerationStillActive()) {
        deferPostProcessing(numericMessageIndex, generationType);
        return;
    }

    clearDeferredPostProcessing(numericMessageIndex);

    await processReceivedMessage(numericMessageIndex, generationType);
    clearPostGenerationStateAfterCompletion();
}

function onStreamTokenReceived() {
    if (internalPromptTransformDepth > 0 || !areAgentsGloballyEnabled()) {
        return;
    }

    const liveStreamingProcessor = streamingProcessor;
    if (!liveStreamingProcessor || liveStreamingProcessor.type === 'impersonate') {
        return;
    }

    const numericMessageIndex = Number(liveStreamingProcessor.messageId);
    if (!Number.isInteger(numericMessageIndex) || numericMessageIndex < 0) {
        return;
    }

    const generationType = pendingGenerationSnapshot?.generationType
        ?? currentMainGenerationType
        ?? liveStreamingProcessor.type;

    ensureMessageRegexSnapshot(
        numericMessageIndex,
        generationType,
        pendingGenerationSnapshot,
        { refresh: false, save: false },
    );
}

async function onCharacterMessageRendered(messageIndex, generationType) {
    const numericMessageIndex = Number(messageIndex);
    const message = chat[numericMessageIndex];

    if (isGreetingGenerationType(generationType)) {
        swipeNavigationPending = false;
        if (shouldRefreshTransformHistoryUi(numericMessageIndex, message)) {
            scheduleMessageRefresh(numericMessageIndex, message);
        }
        return;
    }

    if (swipeNavigationPending) {
        swipeNavigationPending = false;
        if (shouldRefreshTransformHistoryUi(numericMessageIndex, message)) {
            scheduleMessageRefresh(numericMessageIndex, message);
        }
        return;
    }

    if (shouldRefreshTransformHistoryUi(numericMessageIndex, message)) {
        scheduleMessageRefresh(numericMessageIndex, message);
    }

    await onMessageReceived(messageIndex, generationType);
}

function onMessageEdited(messageIndex) {
    if (!areAgentsGloballyEnabled()) {
        return;
    }

    const message = chat[messageIndex];
    const snapshot = getAgentExtraValue(message, MESSAGE_EXTRA_KEY);
    if (!message || !snapshot) {
        return;
    }

    snapshot.edited = true;
    setAgentExtraValue(message, MESSAGE_EXTRA_KEY, snapshot);
    saveChatDebouncedForAgent();
}

async function runPromptTransformAgentsForText(promptTransformAgents, initialText, generationType) {
    const message = {
        mes: initialText,
        name: getUserMessageName(),
        is_user: true,
        is_system: false,
        extra: {},
    };
    const promptRuns = [];
    let currentPromptTransformText = unwrapAssistantResponseWrapper(initialText);
    let appendBatch = [];

    const flushAppendBatch = async () => {
        if (appendBatch.length === 0) {
            return;
        }

        const batchAgents = appendBatch;
        appendBatch = [];

        const batchResult = await runPromptTransformAppendBatch(
            batchAgents,
            message,
            generationType,
            currentPromptTransformText,
            null,
        );
        promptRuns.push(...batchResult.results);
        currentPromptTransformText = batchResult.nextMessageText;
    };

    for (const agent of promptTransformAgents) {
        if (getPromptTransformMode(agent) === 'append') {
            appendBatch.push(agent);
            continue;
        }

        await flushAppendBatch();

        try {
            const result = await runPromptTransformAgent(agent, message, generationType, currentPromptTransformText, null, {
                applyToMessage: false,
            });
            promptRuns.push(result);
            currentPromptTransformText = result.nextMessageText;
        } catch (error) {
            promptRuns.push({
                agentId: agent.id,
                agentName: agent.name,
                changed: false,
                status: 'error',
                mode: getPromptTransformMode(agent),
                error: error instanceof Error ? error.message : String(error),
                runner: 'error',
                timestamp: new Date().toISOString(),
            });
        }
    }

    await flushAppendBatch();

    return {
        promptRuns,
        text: currentPromptTransformText,
        changed: currentPromptTransformText !== unwrapAssistantResponseWrapper(initialText),
    };
}

async function runContextInterceptAgent(agent, currentContextText, generationType, contextFormat, options = {}) {
    const timing = options.timing === POST_MAIN_GENERATION_INTERCEPT_TIMING
        ? POST_MAIN_GENERATION_INTERCEPT_TIMING
        : PRE_GENERATION_INTERCEPT_TIMING;
    const beforeText = normalizeContentText(currentContextText);
    const applyMode = ['wrap', 'patch'].includes(String(agent?.preProcess?.applyMode))
        ? String(agent.preProcess.applyMode)
        : 'replace';
    const profileId = resolveAgentConnectionProfile(agent);
    const baseResult = {
        agentId: agent.id,
        agentName: agent.name,
        applyMode,
        timing,
        contextFormat,
        changed: false,
        beforeText,
        afterText: beforeText,
        outputText: '',
        profileId: '',
        runner: 'none',
        timestamp: new Date().toISOString(),
    };
    const expandedPrompt = substituteParams(agent.prompt, {
        original: currentContextText,
        dynamicMacros: buildPromptDynamicMacros(currentContextText, null, agent, generationType),
    }).trim();

    if (!expandedPrompt || !currentContextText.trim()) {
        return {
            ...baseResult,
            status: 'skipped-empty-prompt',
        };
    }

    const helperRequest = appendConfiguredHelperPrefillMessages(
        buildContextInterceptMessages(expandedPrompt, currentContextText, generationType, contextFormat, timing),
    );
    const cancelRevision = agentGenerationCancelRevision;
    const skipChanges = timing === POST_MAIN_GENERATION_INTERCEPT_TIMING && Boolean(options?.skipChanges);
    const showRunningToast = skipChanges || shouldShowPreInterceptNotifications(agent);
    const runningToast = showRunningToast
        ? showPromptTransformRunningToast(agent, applyMode, profileId, {
            kind: timing === POST_MAIN_GENERATION_INTERCEPT_TIMING ? 'postMainIntercept' : 'preIntercept',
            applyMode,
            skipChanges,
            onCancel: skipChanges ? options?.onCancel : null,
        })
        : null;

    try {
        const response = await requestPromptTransform(
            agent,
            helperRequest.promptMessages,
            normalizePreProcessMaxTokens(agent.preProcess?.maxTokens),
            { allowAssistantPrefillTail: helperRequest.allowAssistantPrefillTail },
        );

        if (agentGenerationCancelRevision !== cancelRevision) {
            return {
                ...baseResult,
                status: 'cancelled',
                profileId: response.profileId,
                runner: response.runner,
            };
        }

        const outputText = unwrapContextInterceptOutput(response.output).trim();

        if (!outputText) {
            console.warn(`[InChatAgents] pre-generation intercept agent "${agent.name}" returned an empty response.`);
            return {
                ...baseResult,
                status: 'empty-response',
                profileId: response.profileId,
                runner: response.runner,
            };
        }

        return {
            ...baseResult,
            status: 'changed',
            changed: true,
            outputText,
            profileId: response.profileId,
            runner: response.runner,
        };
    } catch (error) {
        if (agentGenerationCancelRevision !== cancelRevision || generationStopRequested || isAbortSignalTriggered(error)) {
            return {
                ...baseResult,
                status: 'cancelled',
                profileId,
                runner: 'cancelled',
            };
        }

        throw error;
    } finally {
        clearPromptTransformRunningToast(runningToast);
    }
}

function getGenerationContextSnapshot(generationType = null) {
    const normalizedGenerationType = normalizeGenerationType(generationType ?? currentMainGenerationType);

    if (pendingGenerationSnapshot?.generationType === normalizedGenerationType) {
        return cloneActivationSnapshot(pendingGenerationSnapshot, normalizedGenerationType);
    }

    return buildActivationSnapshot(normalizedGenerationType);
}

async function runPreGenerationInterceptorsOnText(initialContextText, generationType, contextFormat) {
    if (internalPromptTransformDepth > 0 || !areAgentsGloballyEnabled()) {
        return { text: initialContextText, runs: [] };
    }

    let currentContextText = String(initialContextText ?? '');
    if (!currentContextText.trim()) {
        return { text: currentContextText, runs: [] };
    }

    const activationSnapshot = getGenerationContextSnapshot(generationType);
    const interceptAgents = getPreGenerationInterceptAgents(getSnapshotAgents(activationSnapshot));
    if (interceptAgents.length === 0) {
        return { text: currentContextText, runs: [] };
    }

    const runs = [];
    for (const agent of interceptAgents) {
        if (generationStopRequested) {
            break;
        }

        try {
            const result = await runContextInterceptAgent(agent, currentContextText, activationSnapshot.generationType, contextFormat);
            if (result.status !== 'changed') {
                runs.push(result);
                if (result.status === 'cancelled') {
                    break;
                }
                continue;
            }

            currentContextText = applyContextInterceptText(currentContextText, result.outputText, agent.preProcess);
            result.afterText = currentContextText;
            result.changed = result.afterText !== result.beforeText;
            result.status = result.changed ? 'changed' : 'unchanged';
            runs.push(result);
        } catch (error) {
            console.warn(`[InChatAgents] Pre-generation intercept agent "${agent.name}" failed. Leaving context unchanged for this agent.`, error);
            runs.push({
                agentId: agent.id,
                agentName: agent.name,
                applyMode: ['wrap', 'patch'].includes(String(agent?.preProcess?.applyMode)) ? String(agent.preProcess.applyMode) : 'replace',
                timing: PRE_GENERATION_INTERCEPT_TIMING,
                contextFormat,
                changed: false,
                status: 'error',
                error: error instanceof Error ? error.message : String(error),
                beforeText: currentContextText,
                afterText: currentContextText,
                outputText: '',
                profileId: '',
                runner: 'error',
                timestamp: new Date().toISOString(),
            });
        }
    }

    return { text: currentContextText, runs };
}

function getContextInterceptChatRole(agent) {
    switch (Number(agent?.injection?.role)) {
        case extension_prompt_roles.USER:
            return 'user';
        case extension_prompt_roles.ASSISTANT:
            return 'assistant';
        default:
            return 'system';
    }
}

function insertContextInterceptChatMessage(chatMessages, content, agent) {
    const message = {
        role: getContextInterceptChatRole(agent),
        content,
    };

    if (agent?.preProcess?.wrapPosition === 'before') {
        chatMessages.unshift(message);
    } else {
        chatMessages.push(message);
    }
}

async function runPreGenerationInterceptorsOnChat(initialChatMessages, generationType) {
    if (internalPromptTransformDepth > 0 || !areAgentsGloballyEnabled()) {
        return { chat: initialChatMessages, runs: [] };
    }

    let currentChatMessages = Array.isArray(initialChatMessages) ? [...initialChatMessages] : [];
    if (currentChatMessages.length === 0) {
        return { chat: currentChatMessages, runs: [] };
    }

    const activationSnapshot = getGenerationContextSnapshot(generationType);
    const interceptAgents = getPreGenerationInterceptAgents(getSnapshotAgents(activationSnapshot));
    if (interceptAgents.length === 0) {
        return { chat: currentChatMessages, runs: [] };
    }

    const runs = [];
    for (const agent of interceptAgents) {
        if (generationStopRequested) {
            break;
        }

        const contextText = serializeChatContext(currentChatMessages);
        let result = null;

        try {
            result = await runContextInterceptAgent(agent, contextText, activationSnapshot.generationType, 'chat');
            if (result.status !== 'changed') {
                runs.push(result);
                if (result.status === 'cancelled') {
                    break;
                }
                continue;
            }

            if (agent.preProcess?.applyMode === 'wrap') {
                insertContextInterceptChatMessage(
                    currentChatMessages,
                    `${String(agent.preProcess?.wrapPrefix ?? '')}${result.outputText}${String(agent.preProcess?.wrapSuffix ?? '')}`,
                    agent,
                );
                result.afterText = serializeChatContext(currentChatMessages);
                result.changed = result.afterText !== result.beforeText;
                result.status = result.changed ? 'changed' : 'unchanged';
                result.role = getContextInterceptChatRole(agent);
                runs.push(result);
                continue;
            }

            if (agent.preProcess?.applyMode === 'patch') {
                insertContextInterceptChatMessage(currentChatMessages, buildPatchTaggedText(result.outputText, agent.preProcess), agent);
                result.afterText = serializeChatContext(currentChatMessages);
                result.changed = result.afterText !== result.beforeText;
                result.status = result.changed ? 'changed' : 'unchanged';
                result.role = getContextInterceptChatRole(agent);
                runs.push(result);
                continue;
            }

            currentChatMessages = parseChatContext(result.outputText);
            result.afterText = serializeChatContext(currentChatMessages);
            result.changed = result.afterText !== result.beforeText;
            result.status = result.changed ? 'changed' : 'unchanged';
            runs.push(result);
        } catch (error) {
            console.warn(`[InChatAgents] Pre-generation intercept agent "${agent.name}" failed. Leaving chat context unchanged for this agent.`, error);
            runs.push({
                agentId: agent.id,
                agentName: agent.name,
                applyMode: ['wrap', 'patch'].includes(String(agent?.preProcess?.applyMode)) ? String(agent.preProcess.applyMode) : 'replace',
                timing: PRE_GENERATION_INTERCEPT_TIMING,
                contextFormat: 'chat',
                changed: false,
                status: 'error',
                error: error instanceof Error ? error.message : String(error),
                beforeText: contextText,
                afterText: contextText,
                outputText: normalizeContentText(result?.outputText),
                profileId: result?.profileId ?? '',
                runner: result?.runner ?? 'error',
                timestamp: result?.timestamp ?? new Date().toISOString(),
            });
        }
    }

    return { chat: currentChatMessages, runs };
}

async function runPostMainGenerationInterceptorsOnText(initialOutputText, generationType, options = {}) {
    if (internalPromptTransformDepth > 0 || !areAgentsGloballyEnabled()) {
        return { text: initialOutputText, runs: [], cancelled: false };
    }

    let currentOutputText = String(initialOutputText ?? '');
    if (!currentOutputText.trim()) {
        return { text: currentOutputText, runs: [], cancelled: false };
    }

    if (generationStopRequested) {
        return { text: currentOutputText, runs: [], cancelled: true };
    }

    const activationSnapshot = options?.activationSnapshot
        ? cloneActivationSnapshot(options.activationSnapshot, generationType)
        : getGenerationContextSnapshot(generationType);
    const interceptAgents = getPostMainGenerationInterceptAgents(getSnapshotAgents(activationSnapshot));
    if (interceptAgents.length === 0) {
        return { text: currentOutputText, runs: [], cancelled: false };
    }

    const runs = [];
    for (const agent of interceptAgents) {
        if (generationStopRequested) {
            return { text: currentOutputText, runs, cancelled: true };
        }

        try {
            const result = await runContextInterceptAgent(
                agent,
                currentOutputText,
                activationSnapshot.generationType,
                'text',
                {
                    timing: POST_MAIN_GENERATION_INTERCEPT_TIMING,
                    skipChanges: Boolean(options?.skipChanges),
                    onCancel: options?.onCancel,
                },
            );

            if (generationStopRequested || result.status === 'cancelled') {
                runs.push({ ...result, status: 'cancelled', changed: false, afterText: currentOutputText });
                return { text: currentOutputText, runs, cancelled: true };
            }

            if (result.status !== 'changed') {
                runs.push(result);
                continue;
            }

            currentOutputText = applyContextInterceptText(currentOutputText, result.outputText, agent.preProcess);
            result.afterText = currentOutputText;
            result.changed = result.afterText !== result.beforeText;
            result.status = result.changed ? 'changed' : 'unchanged';
            runs.push(result);
        } catch (error) {
            console.warn(`[InChatAgents] Post-main intercept agent "${agent.name}" failed. Leaving generated output unchanged for this agent.`, error);
            runs.push({
                agentId: agent.id,
                agentName: agent.name,
                applyMode: ['wrap', 'patch'].includes(String(agent?.preProcess?.applyMode)) ? String(agent.preProcess.applyMode) : 'replace',
                timing: POST_MAIN_GENERATION_INTERCEPT_TIMING,
                contextFormat: 'text',
                changed: false,
                status: 'error',
                error: error instanceof Error ? error.message : String(error),
                beforeText: currentOutputText,
                afterText: currentOutputText,
                outputText: '',
                profileId: '',
                runner: 'error',
                timestamp: new Date().toISOString(),
            });

            if (generationStopRequested) {
                return { text: currentOutputText, runs, cancelled: true };
            }
        }
    }

    return { text: currentOutputText, runs, cancelled: false };
}

async function runPostDisplayPostMainGenerationInterceptors(message, messageIndex, generationType, activationSnapshot = null) {
    if (!shouldShowPostMainInterceptMessageFirst()) {
        return { runs: [], changed: false, cancelled: false };
    }

    const currentMessageText = unwrapAssistantResponseWrapper(message?.mes);
    const result = await runPostMainGenerationInterceptorsOnText(currentMessageText, generationType, {
        activationSnapshot,
        skipChanges: true,
        onCancel: skipPostMainInterceptChanges,
    });

    if (result.cancelled || generationStopRequested) {
        const cancelledRuns = result.runs.map(run => ({
            ...run,
            status: 'cancelled',
            changed: false,
            afterText: currentMessageText,
        }));
        return { runs: cancelledRuns, changed: false, cancelled: true };
    }

    const nextMessageText = unwrapAssistantResponseWrapper(result.text);
    if (nextMessageText === currentMessageText) {
        return { runs: result.runs, changed: false, cancelled: false };
    }

    message.mes = nextMessageText;
    await syncPromptTransformMessageStateAsync(message, messageIndex);

    return { runs: result.runs, changed: true, cancelled: false };
}

function getPostMainGenerationInterceptorsForGeneration(generationType) {
    if (internalPromptTransformDepth > 0 || !areAgentsGloballyEnabled()) {
        return [];
    }

    const activationSnapshot = getGenerationContextSnapshot(generationType);
    return getPostMainGenerationInterceptAgents(getSnapshotAgents(activationSnapshot));
}

async function onGenerateAfterCombinePrompts(eventData) {
    if (eventData?.dryRun || internalPromptTransformDepth > 0 || !isGenerationInProgress) {
        return;
    }

    if (!eventData || typeof eventData.prompt !== 'string') {
        return;
    }

    const result = await runPreGenerationInterceptorsOnText(
        eventData.prompt,
        currentMainGenerationType,
        'text',
    );
    eventData.prompt = result.text;
    pendingPreGenerationInterceptRuns.push(...result.runs);
}

async function onChatCompletionPromptReady(eventData) {
    if (eventData?.dryRun || internalPromptTransformDepth > 0 || !isGenerationInProgress) {
        return;
    }

    if (!eventData || !Array.isArray(eventData.chat)) {
        return;
    }

    const originalChat = eventData.chat;
    const result = await runPreGenerationInterceptorsOnChat(originalChat, currentMainGenerationType);
    const nextChat = result.chat;
    pendingPreGenerationInterceptRuns.push(...result.runs);
    if (nextChat === originalChat || !result.runs.some(run => run.changed)) {
        return;
    }

    originalChat.splice(0, originalChat.length, ...nextChat);
    eventData.chat = originalChat;
    eventData.chatChanged = true;
}

async function onGenerationOutputBufferingDecision(eventData) {
    if (!eventData || eventData.dryRun || internalPromptTransformDepth > 0 || !isGenerationInProgress) {
        return;
    }

    const interceptAgents = getPostMainGenerationInterceptorsForGeneration(eventData.type ?? currentMainGenerationType);
    if (interceptAgents.length > 0) {
        if (shouldShowPostMainInterceptMessageFirst()) {
            return;
        }

        eventData.hasPostMainInterceptors = true;
        if (interceptAgents.some(shouldShowPreInterceptNotifications)) {
            showInitialGenerationToast();
        }
    }
}

async function onMainGenerationOutputReady(eventData) {
    if (!eventData || eventData.dryRun || internalPromptTransformDepth > 0) {
        return;
    }

    clearInitialGenerationToast();

    if (generationStopRequested) {
        eventData.cancelled = true;
        return;
    }

    if (!isGenerationInProgress || typeof eventData.text !== 'string') {
        return;
    }

    if (shouldShowPostMainInterceptMessageFirst()) {
        return;
    }

    const generationType = eventData.type ?? currentMainGenerationType;
    const result = await runPostMainGenerationInterceptorsOnText(eventData.text, generationType);
    pendingPreGenerationInterceptRuns.push(...result.runs);

    if (result.cancelled || generationStopRequested) {
        eventData.cancelled = true;
        return;
    }

    eventData.text = result.text;
}

async function onImpersonateReady(text = '') {
    if (internalPromptTransformDepth > 0 || !areAgentsGloballyEnabled()) {
        return;
    }

    const textarea = document.querySelector('#send_textarea');
    if (!textarea) {
        return;
    }

    const textareaTextAtStart = normalizeContentText(textarea.value);
    const eventText = normalizeContentText(text);
    const initialText = textareaTextAtStart || eventText;
    if (!initialText.trim()) {
        return;
    }

    const activationSnapshot = pendingGenerationSnapshot?.generationType === IMPERSONATE_GENERATION_TYPE
        ? cloneActivationSnapshot(pendingGenerationSnapshot, IMPERSONATE_GENERATION_TYPE)
        : buildActivationSnapshot(IMPERSONATE_GENERATION_TYPE);
    const activeAgents = getSnapshotAgents(activationSnapshot);
    const promptTransformAgents = getPromptTransformAgentsForImpersonate(activeAgents);
    if (promptTransformAgents.length === 0) {
        return;
    }

    // Impersonate produces user-side text; rewrite only the composer value, never the last assistant swipe.
    const result = await runPromptTransformAgentsForText(promptTransformAgents, initialText, IMPERSONATE_GENERATION_TYPE);
    if (!result.changed) {
        return;
    }

    if (normalizeContentText(textarea.value) !== textareaTextAtStart) {
        toastr.warning('Skipped applying the impersonation prompt pass because the input changed while it was running.', 'In-Chat Agents');
        return;
    }

    textarea.value = result.text;
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
}

async function onMessageSwiped(data) {
    // `MESSAGE_SWIPED` fires during swipe navigation before any overswipe generation starts.
    // Re-running prompt-transform / append agents here mutates the current swipe again,
    // which makes agents like Prose Polisher fire just from browsing swipes.
    // Real swipe generations are handled later by `MESSAGE_RECEIVED`.
    swipeNavigationPending = true;
    void data;
}

function onMessageSwipeDeleted(data) {
    if (internalPromptTransformDepth > 0) {
        return;
    }

    pendingGenerationSnapshot = null;
    clearLatestAssistantPostProcessingFallback();
    clearPostGenerationRecoveryCheck();
    clearDeferredPostProcessing(Number(data?.messageId));
}

/**
 * Handles CHAT_COMPLETION_SETTINGS_READY for tool-category agents.
 * Converts registered tools to Anthropic format when needed,
 * and strips tools on the final recursion pass to force narrative output.
 * @param {object} data Generation data being prepared for the API call
 */
function onChatCompletionSettingsReady(data) {
    if (!areAgentsGloballyEnabled() || agentRegisteredToolNames.size === 0) {
        return;
    }

    const recurseLimit = ToolManager.RECURSE_LIMIT ?? 5;
    if (toolRecursionDepth >= recurseLimit - 1) {
        delete data.tools;
        data.tool_choice = 'none';
        return;
    }

    if (!Array.isArray(data.tools) || data.tools.length === 0) {
        return;
    }

    const isClaude = String(data.model ?? '').startsWith('claude') ||
        data.chat_completion_source === 'claude';

    if (isClaude && Array.isArray(data.tools)) {
        data.tools = data.tools.map(tool => {
            if (tool.type === 'function' && tool.function) {
                return {
                    name: tool.function.name,
                    description: tool.function.description,
                    input_schema: tool.function.parameters,
                };
            }
            return tool;
        });

        if (data.tool_choice === 'auto') {
            data.tool_choice = { type: 'auto' };
        } else if (typeof data.tool_choice === 'object' && data.tool_choice?.function?.name) {
            data.tool_choice = { type: 'tool', name: data.tool_choice.function.name };
        }
    }
}

/**
 * Handles WORLDINFO_ENTRIES_LOADED for tool-category agents.
 * Pathfinder now leaves native World Info activation intact and de-dupes its
 * own injected retrieval context against naturally activated entries instead.
 * @param {object} data World info data with globalLore, characterLore, etc.
 */
function onWorldInfoEntriesLoaded(data) {
    void data;
}

let _onChatChangedToolSync = false;

function onChatChangedToolSync() {
    clearPendingPostProcessingForChatChange();

    if (!areAgentsGloballyEnabled()) {
        syncToolAgentRegistrations();
        return;
    }

    if (_onChatChangedToolSync) {
        return;
    }
    _onChatChangedToolSync = true;

    requestAnimationFrame(() => {
        _onChatChangedToolSync = false;
        toolRecursionDepth = 0;
        void (async () => {
            const pathfinderAgent = getPathfinderRuntimeAgent();
            if (pathfinderAgent) {
                await syncPathfinderAgentLorebooksForCurrentChat(pathfinderAgent, { persist: true });
            }
            syncToolAgentRegistrations();
        })();
    });
}

function onWorldInfoUpdatedToolSync() {
    if (!areAgentsGloballyEnabled()) {
        syncToolAgentRegistrations();
        return;
    }

    if (toolSyncDuringGeneration || isGenerationInProgress) {
        return;
    }
    syncToolAgentRegistrations();
}

export async function undoPromptTransform(messageIndex) {
    const message = chat[messageIndex];
    if (!message || message.is_user || message.is_system) {
        return false;
    }

    const history = getPromptTransformHistoryForMessage(message);

    if (history.length === 0) {
        return false;
    }

    const lastEntry = history[history.length - 1];
    message.mes = lastEntry.beforeText;
    await syncPromptTransformMessageStateAsync(message, messageIndex);
    saveChatDebouncedForAgent();
    scheduleMessageRefresh(messageIndex, message);
    return true;
}

export async function redoPromptTransform(messageIndex) {
    const message = chat[messageIndex];
    if (!message || message.is_user || message.is_system) {
        return false;
    }

    const history = getPromptTransformHistoryForMessage(message);

    if (history.length === 0) {
        return false;
    }

    const lastEntry = history[history.length - 1];
    message.mes = lastEntry.afterText;
    await syncPromptTransformMessageStateAsync(message, messageIndex);
    saveChatDebouncedForAgent();
    scheduleMessageRefresh(messageIndex, message);
    return true;
}

/**
 * Registers all event listeners for the agent runner.
 */
export function initAgentRunner() {
    if (agentRunnerInitialized) {
        return;
    }

    agentRunnerInitialized = true;
    initPostGenerationRecoveryHooks();

    eventSource.on(event_types.GENERATION_STARTED, onGenerationStarted);
    eventSource.on(event_types.GENERATION_AFTER_COMMANDS, onGenerationAfterCommands);
    eventSource.on(event_types.GENERATION_ENDED, onGenerationEnded);
    eventSource.on(event_types.GENERATION_STOPPED, onGenerationStopped);
    eventSource.on(event_types.MESSAGE_RECEIVED, onMessageReceived);
    eventSource.on(event_types.MESSAGE_EDITED, onMessageEdited);

    if (event_types.STREAM_TOKEN_RECEIVED) {
        eventSource.on(event_types.STREAM_TOKEN_RECEIVED, onStreamTokenReceived);
    }

    if (event_types.CHARACTER_MESSAGE_RENDERED) {
        eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, onCharacterMessageRendered);
    }

    if (event_types.IMPERSONATE_READY) {
        eventSource.on(event_types.IMPERSONATE_READY, onImpersonateReady);
    }

    if (event_types.MESSAGE_SWIPED) {
        eventSource.on(event_types.MESSAGE_SWIPED, onMessageSwiped);
    }

    if (event_types.MESSAGE_SWIPE_DELETED) {
        eventSource.on(event_types.MESSAGE_SWIPE_DELETED, onMessageSwipeDeleted);
    }

    if (event_types.CHAT_COMPLETION_SETTINGS_READY) {
        eventSource.on(event_types.CHAT_COMPLETION_SETTINGS_READY, onChatCompletionSettingsReady);
    }

    if (event_types.GENERATE_AFTER_COMBINE_PROMPTS) {
        eventSource.on(event_types.GENERATE_AFTER_COMBINE_PROMPTS, onGenerateAfterCombinePrompts);
    }

    if (event_types.CHAT_COMPLETION_PROMPT_READY) {
        eventSource.on(event_types.CHAT_COMPLETION_PROMPT_READY, onChatCompletionPromptReady);
    }

    if (event_types.GENERATION_OUTPUT_BUFFERING_DECISION) {
        eventSource.on(event_types.GENERATION_OUTPUT_BUFFERING_DECISION, onGenerationOutputBufferingDecision);
    }

    if (event_types.MAIN_GENERATION_OUTPUT_READY) {
        eventSource.on(event_types.MAIN_GENERATION_OUTPUT_READY, onMainGenerationOutputReady);
    }

    if (event_types.WORLDINFO_ENTRIES_LOADED) {
        eventSource.on(event_types.WORLDINFO_ENTRIES_LOADED, onWorldInfoEntriesLoaded);
    }

    if (event_types.CHAT_CHANGED) {
        eventSource.on(event_types.CHAT_CHANGED, migrateLegacyRegexSnapshotsForCurrentChat);
        eventSource.on(event_types.CHAT_CHANGED, onChatChangedToolSync);
    }

    if (event_types.WORLDINFO_UPDATED) {
        eventSource.on(event_types.WORLDINFO_UPDATED, onWorldInfoUpdatedToolSync);
    }

    migrateLegacyRegexSnapshotsForCurrentChat();
}

async function executeManualAgentRun(agentId, messageIndex, cancelRevision = agentGenerationCancelRevision) {
    await commitOpenEditorForMessage(messageIndex);

    const agent = getAgentById(agentId);
    if (!agent) {
        toastr.error('Agent not found.');
        return null;
    }

    const message = chat[messageIndex];
    if (!message || message.is_user || message.is_system) {
        return null;
    }

    if (isCompanionAgent(agent)) {
        if (!companionRuntime?.runCompanionAgentOnMessage) {
            toastr.error('Companion runtime is unavailable.');
            return null;
        }

        return await companionRuntime.runCompanionAgentOnMessage(agent.id, messageIndex, { cancelRevision });
    }

    const generationType = 'normal';
    const regexSnapshotChanged = refreshRegexSnapshotForAgentOnMessage(agent.id, messageIndex, {
        generationType,
        includeForcedAgent: true,
        markPendingSave: false,
        respectGenerationTypes: false,
        save: false,
    });
    const result = await runPromptTransformAgent(agent, message, generationType, null, messageIndex, {
        applyToMessage: false,
    });
    if (agentGenerationCancelRevision !== cancelRevision) {
        return null;
    }

    if (result.changed) {
        message.mes = result.nextMessageText;
        await syncPromptTransformMessageStateAsync(message, messageIndex);
    }

    const promptTransformRunsChanged = updatePromptTransformRuns(message, [result]);
    if (regexSnapshotChanged || promptTransformRunsChanged) {
        saveChatDebouncedForAgent();
    }

    const historyChanged = updatePromptTransformHistory(message, result);
    if (historyChanged) {
        syncAssistantMessageStateToSwipe(message, messageIndex);
        saveChatDebouncedForAgent();
    }

    if (result.changed || regexSnapshotChanged) {
        scheduleMessageRefresh(messageIndex, message);
    }

    return result;
}

/**
 * Manually runs a single agent on a specific message (on-demand, not triggered by generation).
 * Requests are queued so repeated manual runs apply one at a time.
 * @param {string} agentId
 * @param {number} messageIndex
 * @returns {Promise<import('./agent-store.js').InChatAgent | null>}
 */
export async function runAgentOnMessage(agentId, messageIndex) {
    if (!areAgentsGloballyEnabled()) {
        toastr.warning('In-Chat Agents are disabled.');
        return null;
    }

    return await enqueueManualAgentRun(agentId, messageIndex);
}

export async function runTrackerFixOnMessage(messageIndex) {
    if (!areAgentsGloballyEnabled()) {
        toastr.warning('In-Chat Agents are disabled.');
        return;
    }

    await commitOpenEditorForMessage(messageIndex);

    const message = chat[messageIndex];
    if (!message || message.is_user || message.is_system) {
        return;
    }

    const generationType = 'normal';
    const enabledAgents = getEnabledAgents();
    const trackerAgents = enabledAgents.filter(agent => !isCompanionAgent(agent) && isTrackerFixAgent(agent));

    if (trackerAgents.length === 0) {
        toastr.info('No enabled tracker agents found.');
        return;
    }

    const trackerTransformAgents = trackerAgents.filter(agent =>
        (agent.phase === 'post' || agent.phase === 'both') &&
        agent.postProcess?.promptTransformEnabled &&
        String(agent.prompt ?? '').trim(),
    );

    let regexSnapshotChanged = false;
    for (const agent of trackerAgents) {
        const changed = refreshRegexSnapshotForAgentOnMessage(agent.id, messageIndex, {
            generationType,
            includeForcedAgent: true,
            markPendingSave: false,
            respectGenerationTypes: false,
            save: false,
        });
        regexSnapshotChanged = regexSnapshotChanged || changed;
    }

    let chatStateChanged = false;
    let messageDisplayChanged = false;
    const promptRuns = [];
    let trackerRegenerations = 0;
    let trackerRegenerationErrors = 0;
    const applyExtractPostProcess = (agent, sourceText) => {
        const postProcess = agent.postProcess;
        if (!postProcess?.extractPattern || !postProcess.extractVariable) {
            return false;
        }

        try {
            const regex = new RegExp(postProcess.extractPattern, 'g');
            const matches = String(sourceText ?? '').match(regex);
            if (matches) {
                chat_metadata[`agent_${postProcess.extractVariable}`] = matches.join('\n');
                return true;
            }
        } catch (error) {
            console.warn(`[InChatAgents] Extract error in agent "${agent.name}":`, error);
        }

        return false;
    };
    let currentPromptTransformText = unwrapAssistantResponseWrapper(message.mes);

    if (currentPromptTransformText !== normalizeContentText(message.mes)) {
        message.mes = currentPromptTransformText;
        await syncPromptTransformMessageStateAsync(message, messageIndex);
        chatStateChanged = true;
        messageDisplayChanged = true;
    }

    let appendBatch = [];
    const flushAppendBatch = async () => {
        if (appendBatch.length === 0) {
            return;
        }

        const batchAgents = appendBatch;
        appendBatch = [];

        const batchResult = await runPromptTransformAppendBatch(
            batchAgents,
            message,
            generationType,
            currentPromptTransformText,
            messageIndex,
        );
        promptRuns.push(...batchResult.results);
        currentPromptTransformText = batchResult.nextMessageText;

        if (batchResult.changed) {
            chatStateChanged = true;
            messageDisplayChanged = true;
        }
    };

    for (const agent of trackerTransformAgents) {
        if (getPromptTransformMode(agent) === 'append') {
            appendBatch.push(agent);
            continue;
        }

        await flushAppendBatch();

        try {
            const result = await runPromptTransformAgent(agent, message, generationType, currentPromptTransformText, messageIndex);
            promptRuns.push(result);
            currentPromptTransformText = result.nextMessageText;

            if (result.changed) {
                chatStateChanged = true;
                messageDisplayChanged = true;
            }
        } catch (error) {
            promptRuns.push({
                agentId: agent.id,
                agentName: agent.name,
                changed: false,
                status: 'error',
                mode: getPromptTransformMode(agent),
                error: error instanceof Error ? error.message : String(error),
                runner: 'error',
                timestamp: new Date().toISOString(),
            });
        }
    }

    await flushAppendBatch();

    if (currentPromptTransformText !== message.mes) {
        message.mes = currentPromptTransformText;
        await syncPromptTransformMessageStateAsync(message, messageIndex);
        chatStateChanged = true;
        messageDisplayChanged = true;
    }

    const extractRegenerationAgents = trackerAgents.filter(agent =>
        agent.postProcess?.enabled &&
        agent.postProcess.type === 'extract' &&
        !agent.postProcess.promptTransformEnabled &&
        String(agent.prompt ?? '').trim() &&
        agent.postProcess.extractPattern &&
        agent.postProcess.extractVariable,
    );
    const extractRegenerationAgentIds = new Set(extractRegenerationAgents.map(agent => agent.id));

    // SillyBunny divergence: repair inline extract trackers by regenerating their
    // block; re-extraction alone cannot recover a missing [TAG|...] payload.
    for (const agent of extractRegenerationAgents) {
        try {
            const result = await runPromptTransformAgent(agent, message, generationType, currentPromptTransformText, messageIndex, {
                applyToMessage: false,
            });
            const regenerated = String(result.outputText ?? '').trim()
                ? applyExtractPostProcess(agent, result.outputText)
                : false;
            const extracted = regenerated || applyExtractPostProcess(agent, message.mes);

            if (result.status === 'error') {
                trackerRegenerationErrors++;
            }

            if (extracted) {
                chatStateChanged = true;
            }

            if (regenerated) {
                trackerRegenerations++;
            }
        } catch (error) {
            trackerRegenerationErrors++;
            console.warn(`[InChatAgents] Tracker regeneration failed in agent "${agent.name}":`, error);

            if (applyExtractPostProcess(agent, message.mes)) {
                chatStateChanged = true;
            }
        }
    }

    const utilityAgents = trackerAgents.filter(agent =>
        agent.postProcess?.enabled &&
        agent.postProcess.type !== 'regex' &&
        !extractRegenerationAgentIds.has(agent.id),
    );

    for (const agent of utilityAgents) {
        const postProcess = agent.postProcess;

        switch (postProcess.type) {
            case 'extract': {
                if (applyExtractPostProcess(agent, message.mes)) {
                    chatStateChanged = true;
                }
                break;
            }

            case 'append': {
                if (!postProcess.appendText) {
                    break;
                }

                const appendedText = substituteParams(postProcess.appendText);
                if (appendedText.trim()) {
                    message.mes += appendedText;
                    chatStateChanged = true;
                    messageDisplayChanged = true;
                }
                break;
            }
        }
    }

    if (updateMessageRegexSnapshot(message, trackerAgents, generationType)) {
        chatStateChanged = true;
        messageDisplayChanged = true;
    }

    if (promptRuns.length > 0 && updatePromptTransformRuns(message, promptRuns)) {
        chatStateChanged = true;
    }

    let promptHistoryChanged = false;
    for (const run of promptRuns) {
        promptHistoryChanged = updatePromptTransformHistory(message, run) || promptHistoryChanged;
    }

    if (promptHistoryChanged) {
        chatStateChanged = true;
    }

    if (chatStateChanged || regexSnapshotChanged) {
        syncAssistantMessageStateToSwipe(message, messageIndex);
        saveChatDebouncedForAgent({ deferBackup: false });
    }

    if (messageDisplayChanged) {
        scheduleMessageRefresh(messageIndex, message, { deferBackup: true });
    }

    const changedRuns = promptRuns.filter(r => r.changed);
    const failedRuns = promptRuns.filter(r => r.status === 'error');
    const postProcessRuns = utilityAgents.length + extractRegenerationAgents.length;
    const errorRuns = failedRuns.length + trackerRegenerationErrors;
    const parts = [];
    if (trackerRegenerations > 0) parts.push(`${trackerRegenerations} tracker${trackerRegenerations > 1 ? 's' : ''} regenerated`);
    if (changedRuns.length > 0) parts.push(`${changedRuns.length} prompt transform${changedRuns.length > 1 ? 's' : ''} applied`);
    if (postProcessRuns > 0) parts.push(`${postProcessRuns} post-process${postProcessRuns > 1 ? 'es' : ''} run`);
    if (regexSnapshotChanged) parts.push('regex snapshot updated');
    if (errorRuns > 0) parts.push(`${errorRuns} error${errorRuns > 1 ? 's' : ''}`);

    if (parts.length > 0) {
        toastr.success(parts.join(', '), 'Trackers fixed');
    } else {
        toastr.info('No changes made.', 'Trackers fixed');
    }
}
