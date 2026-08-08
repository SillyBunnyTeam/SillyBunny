import { canDeleteBook, canReadBook, canWriteBook, getSettings, getTree, getAllEntryUids } from './tree-store.js';
import { ALL_TOOL_NAMES, getActiveTunnelVisionBooks, getContextualLorebooks } from './pathfinder-tool-bridge.js';
import { getFeedItems } from './activity-feed.js';
import { getEnabledToolAgents } from '../agent-store.js';
import { getPathfinderRuntimeAgent, getToolRecursionState, isPathfinderToolEnabledForAgent, syncToolAgentRegistrations } from '../agent-runner.js';

function getRegisteredPathfinderTools(ToolManager) {
    const tools = ToolManager?.tools instanceof Map
        ? [...ToolManager.tools.values()]
        : Array.isArray(ToolManager?.tools)
            ? ToolManager.tools
            : [];

    return ALL_TOOL_NAMES.filter(name =>
        tools.find(t => t?.name === name),
    );
}

function formatNameList(names, fallback = 'none') {
    return names.length > 0 ? names.join(', ') : fallback;
}

function getEnabledPathfinderTools(pathfinderAgent, registeredTools = [], settings = getSettings()) {
    if (!pathfinderAgent) {
        return [];
    }

    // Runtime toolStates are re-synced from the agent right before this runs;
    // when configured they are canonical.
    const toolStates = settings?.toolStates;
    if (toolStates && typeof toolStates === 'object') {
        const configuredNames = ALL_TOOL_NAMES.filter(name => Object.prototype.hasOwnProperty.call(toolStates, name));
        if (configuredNames.length > 0) {
            return configuredNames.filter(name => toolStates[name] !== false);
        }
    }

    // Fall back to the same reader the runner uses for registration decisions
    return ALL_TOOL_NAMES.filter(name => isPathfinderToolEnabledForAgent(pathfinderAgent, name));
}

function getLastPipelineRunMessage(settings) {
    if (!settings.pipelineEnabled) {
        return 'Disabled - entries won\'t be auto-injected';
    }

    const pipelineId = settings.pipelineId || 'default';
    const lastRun = getFeedItems().find(item => item?.type === 'pathfinder_retrieval_detail' && item.mode === 'pipeline');
    if (!lastRun) {
        return `Enabled (${pipelineId} pipeline). No run recorded this session yet - send a message to trigger retrieval.`;
    }

    const metadata = lastRun.metadata || {};
    const selectedCount = Number(metadata.selectedEntryCount ?? lastRun.selectedEntries?.length ?? 0) || 0;
    const candidateCount = Number(metadata.candidateCount ?? 0) || 0;
    const stageFailure = (lastRun.stageResults || []).find(stage => stage && stage.success === false);
    if (stageFailure) {
        return `Enabled (${pipelineId} pipeline). Last run failed at ${stageFailure.promptId || `stage ${Number(stageFailure.stageIndex ?? 0) + 1}`}: ${stageFailure.error || 'unknown error'}.`;
    }

    if (metadata.reason === 'no-readable-lorebooks') {
        return `Enabled (${pipelineId} pipeline). Last run found no readable lorebooks with built trees.`;
    }

    if (metadata.reason === 'no-chat-messages') {
        return `Enabled (${pipelineId} pipeline). Last run skipped because there were no chat messages yet.`;
    }

    if (metadata.timedOut) {
        return `Enabled (${pipelineId} pipeline). Last run timed out after ${metadata.timeoutSeconds || '?'}s before entries could be injected.`;
    }

    if (metadata.error) {
        return `Enabled (${pipelineId} pipeline). Last run failed: ${metadata.error}.`;
    }

    if (selectedCount === 0) {
        return `Enabled (${pipelineId} pipeline). Last run returned 0 entries${candidateCount > 0 ? ` from ${candidateCount} candidate(s)` : ''}.${getPipelineStageSummary(lastRun.stageResults)}`;
    }

    return `Enabled (${pipelineId} pipeline). Last run injected ${selectedCount} entr${selectedCount === 1 ? 'y' : 'ies'}${candidateCount > 0 ? ` from ${candidateCount} candidate(s)` : ''}.`;
}

function getToolRegistrationDetail(enabledTools, registeredTools) {
    const missingTools = enabledTools.filter(name => !registeredTools.includes(name));
    const recursion = getToolRecursionState();
    const recursionLimit = Number(recursion?.limit ?? 0) || 0;
    const recursionText = recursionLimit > 0 ? ` Recursion: ${recursion.depth}/${recursionLimit}.` : '';

    return {
        missingTools,
        recursionText,
        registeredText: `Registered: ${formatNameList(registeredTools)}. Enabled: ${formatNameList(enabledTools)}.`,
    };
}

function getPipelineStageSummary(stageResults = []) {
    const stageCounts = stageResults
        .filter(stage => stage && Number.isFinite(Number(stage.entriesFound)))
        .map(stage => `${stage.promptId || `stage ${Number(stage.stageIndex ?? 0) + 1}`}: ${Number(stage.entriesFound)} entr${Number(stage.entriesFound) === 1 ? 'y' : 'ies'}`);

    return stageCounts.length > 0 ? ` Stages: ${stageCounts.join('; ')}.` : '';
}

export async function runDiagnostics() {
    const results = {};
    const s = getSettings();

    try {
        syncToolAgentRegistrations();
    } catch (error) {
        console.warn('[Pathfinder] Diagnostics could not refresh tool registrations before checks.', error);
    }

    // Check enabled lorebooks
    const manualBooks = (s.enabledLorebooks || []);
    const contextualBooks = s.includeContextualLorebooks === false ? [] : getContextualLorebooks();
    const books = getActiveTunnelVisionBooks();
    results['Lorebooks'] = {
        ok: books.length > 0,
        message: books.length > 0
            ? `${books.length} lorebook(s) available: ${books.join(', ')}. Manual: ${manualBooks.length}; contextual: ${contextualBooks.length}.`
            : 'No lorebooks selected or attached - select one above or attach chat/character/persona lore.',
    };

    // Check pipeline mode
    results['Pipeline Mode'] = {
        ok: true,
        message: getLastPipelineRunMessage(s),
    };

    // Check sidecar/tool mode
    results['Tool Mode'] = {
        ok: true,
        message: s.sidecarEnabled
            ? 'Enabled - AI can use Pathfinder tools'
            : 'Disabled - AI cannot call Pathfinder tools',
    };

    // Check trees built
    const activeBooks = getActiveTunnelVisionBooks();
    let treesBuilt = 0;
    let totalEntries = 0;

    for (const bookName of activeBooks) {
        const tree = getTree(bookName);
        if (tree) {
            treesBuilt++;
            totalEntries += getAllEntryUids(tree).length;
        }
    }

    results['Waypoint Trees'] = {
        ok: treesBuilt === activeBooks.length || activeBooks.length === 0,
        message: activeBooks.length === 0
            ? 'No lorebooks enabled'
            : treesBuilt === activeBooks.length
                ? `${treesBuilt} tree(s) built with ${totalEntries} total entries`
                : `${treesBuilt}/${activeBooks.length} trees built - some lorebooks need tree building`,
    };

    // Check tool registration
    const ToolManager = window?.SillyTavern?.getContext?.()?.ToolManager;
    const isToolCallingSupported = ToolManager?.isToolCallingSupported?.() ?? false;

    if (s.sidecarEnabled) {
        const enabledAgents = getEnabledToolAgents();
        const pathfinderAgent = getPathfinderRuntimeAgent(enabledAgents);
        const registeredTools = getRegisteredPathfinderTools(ToolManager);
        const enabledPathfinderToolNames = getEnabledPathfinderTools(pathfinderAgent, registeredTools, s);
        const registrationDetail = getToolRegistrationDetail(enabledPathfinderToolNames, registeredTools);

        if (enabledPathfinderToolNames.length > 0 && enabledPathfinderToolNames.every(name => registeredTools.includes(name))) {
            if (isToolCallingSupported) {
                results['Tool Registration'] = {
                    ok: true,
                    message: `All ${enabledPathfinderToolNames.length} enabled Pathfinder tool(s) registered and active. ${registrationDetail.registeredText}${registrationDetail.recursionText}`,
                };
            } else {
                results['Tool Registration'] = {
                    ok: false,
                    message: `${registeredTools.length} Pathfinder tool(s) registered, but tool calling is not supported for the current API/settings. ${registrationDetail.registeredText} Enable "Function Calling" in OpenAI settings and ensure the current model supports tools.`,
                };
            }
        } else if (!pathfinderAgent) {
            results['Tool Registration'] = {
                ok: false,
                message: 'Tool mode is enabled, but the Pathfinder tool agent is not active right now. Enable Pathfinder as a tool agent, then reopen settings or reload agents.',
            };
        } else if (enabledPathfinderToolNames.length === 0) {
            console.debug('[Pathfinder] Diagnostics found no enabled Pathfinder tools.', {
                agentTools: pathfinderAgent?.tools ?? [],
                registeredTools,
                sidecarEnabled: s.sidecarEnabled,
            });
            results['Tool Registration'] = {
                ok: false,
                message: 'Tool mode is enabled, but every Pathfinder tool toggle is off. Re-enable at least one Pathfinder tool in Tool Settings.',
            };
        } else if (registeredTools.length === 0) {
            results['Tool Registration'] = {
                ok: false,
                message: isToolCallingSupported
                    ? 'Tools are configured but not registered with ToolManager. Try reloading the extension or switching API sources.'
                    : 'Tool calling is not supported for the current API/settings. Enable "Function Calling" in OpenAI settings and ensure the current model supports tools.',
            };
        } else {
            results['Tool Registration'] = {
                ok: false,
                message: `Partial: ${registeredTools.length}/${enabledPathfinderToolNames.length} enabled Pathfinder tools registered. Missing: ${formatNameList(registrationDetail.missingTools)}. ${registrationDetail.registeredText}${registrationDetail.recursionText}`,
            };
        }
    } else {
        results['Tool Registration'] = {
            ok: true,
            message: 'Tool mode disabled - skipped. Tool agents are not required unless you want Pathfinder tools.',
        };
    }

    // Check tool calling support
    if (s.sidecarEnabled && ToolManager) {
        results['Tool Calling'] = {
            ok: isToolCallingSupported,
            message: isToolCallingSupported
                ? 'Tool calling is supported for the current API/settings'
                : 'Tool calling is NOT supported. Enable "Function Calling" in OpenAI settings and ensure the current model supports tools.',
        };
    }

    const readableBooks = activeBooks.filter(canReadBook);
    const writableBooks = activeBooks.filter(canWriteBook);
    const deletableBooks = activeBooks.filter(canDeleteBook);
    results['Tool Permissions'] = {
        ok: activeBooks.length === 0 || readableBooks.length > 0,
        message: activeBooks.length === 0
            ? 'No active lorebooks, permissions will apply after selecting a book.'
            : `Read: ${formatNameList(readableBooks)}. Write: ${formatNameList(writableBooks)}. Delete: ${formatNameList(deletableBooks)}.`,
    };

    results['Lorebook Auto-Sync'] = {
        ok: true,
        message: s.autoSyncLorebooksOnChatChange === false
            ? `Disabled. Contextual lorebooks detected: ${formatNameList(contextualBooks)}.`
            : `Enabled. Pathfinder will reset selected lorebooks to current chat context (${formatNameList(contextualBooks)}).`,
    };

    const lastPipelineDetail = getFeedItems().find(item => item?.type === 'pathfinder_retrieval_detail' && item.mode === 'pipeline');
    const skippedNaturalCount = Number(lastPipelineDetail?.metadata?.skippedNaturalActivationCount ?? 0) || 0;
    results['World Info Dedupe'] = {
        ok: true,
        message: s.dedupeNaturalActivation === false
            ? 'Disabled. Pathfinder may inject entries that World Info also activates naturally.'
            : `Enabled. Last pipeline skipped ${skippedNaturalCount} naturally activated entr${skippedNaturalCount === 1 ? 'y' : 'ies'}.`,
    };

    // Check connection profile
    results['Connection Profile'] = {
        ok: true,
        message: s.connectionProfile
            ? `Using profile: ${s.connectionProfile}`
            : 'Using main model',
    };

    return results;
}
