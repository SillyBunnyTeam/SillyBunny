import { getSettings, setSettings, isLorebookEnabled, setLorebookEnabled, clearAllTrees } from './pathfinder/tree-store.js';
import { initEntryManagerAPIs, onPathfinderWorldInfoUpdated } from './pathfinder/entry-manager.js';
import { getSummaryMemoryState } from './pathfinder/summary-memory-store.js';
import { initActivityFeed } from './pathfinder/activity-feed.js';
import { isPathfinderSubmoduleEnabled } from './agent-store.js';
import { unregisterToolAction, unregisterToolFormatter } from './tool-action-registry.js';
import { deinitAutoSummary, initAutoSummary } from './pathfinder/auto-summary.js';
import { initCommands, removeCommands } from './pathfinder/commands.js';
import { getPathfinderToolDefinitions } from './pathfinder/tool-definitions.js';

import { registerActions as registerSearchActions } from './pathfinder/tools/search.js';
import { registerActions as registerRememberActions } from './pathfinder/tools/remember.js';
import { registerActions as registerUpdateActions } from './pathfinder/tools/update.js';
import { registerActions as registerForgetActions } from './pathfinder/tools/forget.js';
import { registerActions as registerSummarizeActions } from './pathfinder/tools/summarize.js';
import { registerActions as registerReorganizeActions } from './pathfinder/tools/reorganize.js';
import { registerActions as registerMergeSplitActions } from './pathfinder/tools/merge-split.js';
import { registerActions as registerNotebookActions } from './pathfinder/tools/notebook.js';

import { buildTreeFromMetadata, buildTreeWithLLM } from './pathfinder/tree-builder.js';
import { runDiagnostics } from './pathfinder/diagnostics.js';

// Pipeline system imports
import { initializePromptStore } from './pathfinder/prompts/prompt-store.js';
import { getDefaultPrompts, getDefaultPipelines } from './pathfinder/prompts/default-prompts.js';

let initialized = false;
let initializationRevision = 0;

function registerPathfinderToolActions() {
    registerSearchActions();
    registerRememberActions();
    registerUpdateActions();
    registerForgetActions();
    registerSummarizeActions();
    registerReorganizeActions();
    registerMergeSplitActions();
    registerNotebookActions();
}

function unregisterPathfinderToolActions() {
    for (const tool of getPathfinderToolDefinitions()) {
        if (tool?.actionKey) {
            unregisterToolAction(tool.actionKey);
        }
        if (tool?.formatMessageKey) {
            unregisterToolFormatter(tool.formatMessageKey);
        }
    }
}

export function initPathfinder(context) {
    if (!isPathfinderSubmoduleEnabled()) {
        teardownPathfinder();
        return;
    }

    if (initialized) return;
    initialized = true;
    const revision = ++initializationRevision;

    registerPathfinderToolActions();

    initActivityFeed();

    // Initialize pipeline prompt store with defaults
    initializePromptStore(getDefaultPrompts(), getDefaultPipelines());

    const entryManagerAPIs = ['loadWorldInfo', 'createWorldInfoEntry', 'saveWorldInfo'];
    const missingEntryManagerAPIs = entryManagerAPIs.filter(api => !context?.[api]);
    if (missingEntryManagerAPIs.length === 0) {
        initEntryManagerAPIs(context.loadWorldInfo, context.createWorldInfoEntry, context.saveWorldInfo);
        const summary = getSummaryMemoryState();
        if (summary.bookName && summary.uid !== null) {
            // Changes made while disabled or offline may not have delivered a book event.
            void Promise.resolve().then(() => context.loadWorldInfo(summary.bookName)).then(data => {
                if (initialized && revision === initializationRevision
                    && JSON.stringify(getSummaryMemoryState()) === JSON.stringify(summary)) {
                    onPathfinderWorldInfoUpdated(summary.bookName, data);
                }
            }).catch(error => console.warn(error));
        }
    } else {
        console.error(`[Pathfinder] Missing context APIs for lorebook writes: ${missingEntryManagerAPIs.join(', ')}`);
    }

    if (context?.eventSource && context?.eventTypes) {
        initAutoSummary(context.eventSource, context.eventTypes);
    }

    if (context?.registerSlashCommand) {
        initCommands(context.registerSlashCommand);
    }

    console.info('[Pathfinder] Initialized with 8 tools and predictive pipeline system.');
}

export function teardownPathfinder() {
    if (!initialized) {
        return;
    }

    unregisterPathfinderToolActions();
    deinitAutoSummary();
    removeCommands();
    // Stale trees would survive a disable/enable cycle and shadow any
    // lorebook edits made while Pathfinder was off.
    clearAllTrees();
    initialized = false;
    initializationRevision++;
    console.info('[Pathfinder] Disabled and unregistered.');
}

export async function buildPathfinderTree(bookName, bookData, useLLM = false, llmGenerate = null) {
    if (useLLM && llmGenerate) {
        return await buildTreeWithLLM(bookName, bookData, llmGenerate);
    }
    return await buildTreeFromMetadata(bookName, bookData);
}

export { runDiagnostics };
export { getSettings as getPathfinderSettings, setSettings as setPathfinderSettings };
export { isLorebookEnabled, setLorebookEnabled };
export { getPathfinderToolDefinitions };

// Export pipeline-related functions for external use
export { initPromptEditorUI, refreshPromptEditorUI } from './pathfinder/prompts/prompt-editor-ui.js';
export { runPipeline } from './pathfinder/prompts/pipeline-runner.js';
export { getAllPrompts, getPrompt, savePrompt } from './pathfinder/prompts/prompt-store.js';
