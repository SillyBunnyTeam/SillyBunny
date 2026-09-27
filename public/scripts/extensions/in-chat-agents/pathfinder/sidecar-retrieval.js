import { chat, getCurrentChatId } from '../../../../script.js';
import { isAbortLikeError } from '../../../util/abort-error.js';
import { isPathfinderSubmoduleEnabled } from '../agent-store.js';
import { getTree, findNodeById, getSettings } from './tree-store.js';
import { getReadableBooks } from './pathfinder-tool-bridge.js';
import { sidecarGenerate } from './llm-sidecar.js';
import { logPathfinderRetrievalDetail, logSidecarRetrieval, logPipelineStart, logPipelineComplete } from './activity-feed.js';
import { buildTreeFromMetadata } from './tree-builder.js';
import { loadRetrievalEntries, runPipeline } from './prompts/pipeline-runner.js';
import { isSummaryMemoryEntry, markSummaryMemoryInjected } from './summary-memory-store.js';

const RETRIEVAL_PROMPT_KEY = 'pathfinder_sidecar_retrieval';
const PIPELINE_RETRIEVAL_KEY = 'pathfinder_pipeline_retrieval';
export const PATHFINDER_RETRIEVAL_PROMPT_KEYS = Object.freeze([
    RETRIEVAL_PROMPT_KEY,
    PIPELINE_RETRIEVAL_KEY,
]);

function clearRetrievalPrompt(setExtensionPrompt, key, extensionPromptTypes, extensionPromptRoles) {
    setExtensionPrompt(key, '', extensionPromptTypes?.IN_PROMPT ?? 0, 4, false, extensionPromptRoles?.SYSTEM ?? 0);
}

function throwIfAborted(signal) {
    if (signal?.aborted) {
        throw signal.reason ?? new Error('Pathfinder retrieval cancelled.');
    }
}

function formatCollapsedGuide(tree) {
    if (!tree) return '';
    const lines = [];
    function walk(node, depth = 0) {
        const indent = '  '.repeat(depth);
        const entries = (node.entries || []).length;
        const subWaypoints = (node.children || []).length;
        let line = `${indent}${node.name}`;
        if (entries) line += ` (${entries} entries)`;
        if (subWaypoints) line += ` [${subWaypoints} sub-waypoints]`;
        if (depth > 0 && node.id) line += ` [id: ${node.id}]`;
        lines.push(line);
        for (const child of node.children || []) walk(child, depth + 1);
    }
    walk(tree);
    return lines.join('\n');
}

async function ensureReadableBookTrees(bookNames, signal) {
    const books = [...new Set(bookNames.filter(Boolean))];
    for (const bookName of books) {
        throwIfAborted(signal);
        if (getTree(bookName)) continue;

        const ctx = globalThis.window?.SillyTavern?.getContext?.();
        const bookData = await ctx?.loadWorldInfo?.(bookName);
        throwIfAborted(signal);
        if (!bookData?.entries) {
            throw new Error(`Could not build a tree for "${bookName}" because no lorebook entries were found.`);
        }
        await buildTreeFromMetadata(bookName, bookData);
        throwIfAborted(signal);
    }
    return books;
}

async function runPipelineRetrieval(books, chatMessages, signal) {
    const pipelineId = getSettings().pipelineId || 'default';
    if (books.length === 0 || chatMessages.length === 0) {
        return {
            success: true,
            selectedEntries: [],
            stageResults: [],
            metadata: { pipelineId, reason: books.length ? 'no-chat-messages' : 'no-readable-lorebooks' },
        };
    }

    logPipelineStart(pipelineId, 2);
    const result = await runPipeline(pipelineId, chatMessages, 10, signal, books);
    throwIfAborted(signal);
    logPipelineComplete(pipelineId, result.selectedEntries?.length ?? 0, result.stageResults);

    if (!result.success) {
        console.warn('[Pathfinder] Pipeline retrieval failed:', result.error);
    }

    return {
        success: result.success,
        cacheable: result.stageResults.every(stage => stage.success !== false),
        selectedEntries: (result.selectedEntryData ?? []).map(entry => ({ name: entry.comment, bookName: entry.bookName, uid: entry.uid, content: entry.content || '' })),
        stageResults: result.stageResults,
        metadata: { pipelineId, ...(result.error && { error: result.error }) },
    };
}

async function runLegacySidecarRetrieval(books, chatMessages, signal) {
    const contextText = books.map(bookName => `\n### ${bookName}\n${formatCollapsedGuide(getTree(bookName))}\n`).join('');
    if (!contextText.trim()) {
        return { success: true, selectedEntries: [], stageResults: [], metadata: {} };
    }

    const history = chatMessages.map(message => `${message.is_user || message.role === 'user' ? 'User' : (message.name || 'Assistant')}: ${message.mes}`).join('\n\n');
    const prompt = `Given the current conversation context, which of these lorebook waypoints contain information relevant to what's happening right now? List the waypoint/node IDs (the "id: node_..." values) you'd retrieve.\n\n${history}\n\n${contextText}`;
    const response = await sidecarGenerate(prompt, 'You are a lorebook retrieval assistant. Analyze the conversation and identify which waypoints are relevant. Respond with waypoint/node IDs (the "id: node_..." values), one per line.', signal);
    throwIfAborted(signal);
    const nodeIds = [...new Set(response.split('\n').map(line => line.match(/node_[a-z0-9]+/i)?.[0]).filter(Boolean))];
    const selectedEntries = [];

    for (const bookName of books) {
        const tree = getTree(bookName);
        const uids = new Set(nodeIds.flatMap(nodeId => findNodeById(tree, nodeId)?.entries ?? []));
        if (uids.size === 0) continue;

        const entries = await loadRetrievalEntries(bookName, signal);
        for (const entry of entries) {
            if (uids.has(entry.uid)) selectedEntries.push({ name: entry.comment, bookName, uid: entry.uid, content: entry.content || '' });
        }
    }

    logSidecarRetrieval(nodeIds, selectedEntries.length);
    return {
        success: true,
        selectedEntries,
        stageResults: [{ stageIndex: 0, promptId: 'legacy-sidecar', success: true, entriesFound: selectedEntries.length, nodeIds }],
        metadata: { nodeIds },
    };
}

export function injectPathfinderRetrieval(result, setExtensionPrompt, extensionPromptTypes, extensionPromptRoles, nativeEntries = []) {
    if (!result?.success || !Array.isArray(result.selectedEntries)) return;

    const selectedEntries = [];
    const skippedNaturalEntries = [];
    const readableBooks = new Set(getReadableBooks());
    for (const entry of result.selectedEntries) {
        if (!readableBooks.has(entry.bookName)) continue;
        if (result.dedupeNaturalActivation !== false && nativeEntries.some(native =>
            native.world === entry.bookName && String(native.uid) === String(entry.uid),
        )) {
            skippedNaturalEntries.push({ name: entry.name, bookName: entry.bookName, uid: entry.uid, reason: 'WORLD_INFO_ACTIVATED' });
        } else {
            selectedEntries.push(entry);
        }
    }

    const injectedPrompt = selectedEntries.length
        ? `<pathfinder_context>\n${selectedEntries.map(entry => `[${entry.name}]\n${entry.content}`).join('\n\n')}\n</pathfinder_context>`
        : '';
    if (setExtensionPrompt(result.promptKey, injectedPrompt, extensionPromptTypes?.IN_PROMPT ?? 0, 4, false, extensionPromptRoles?.SYSTEM ?? 0) === false) {
        return;
    }
    if (selectedEntries.some(entry => isSummaryMemoryEntry(entry))) {
        markSummaryMemoryInjected({ mode: result.mode });
    }
    logPathfinderRetrievalDetail({
        mode: result.mode,
        books: result.books,
        selectedEntries: selectedEntries.map(entry => ({
            name: entry.name,
            bookName: entry.bookName,
            uid: entry.uid,
            preview: entry.content ? String(entry.content).slice(0, 240) : '',
        })),
        stageResults: result.stageResults,
        injectedPrompt,
        metadata: {
            ...result.metadata,
            selectedEntryCount: selectedEntries.length,
            candidateCount: result.selectedEntries.length,
            skippedNaturalActivationCount: skippedNaturalEntries.length,
            skippedNaturalEntries,
        },
    });
}

export async function runSidecarRetrieval(setExtensionPrompt, extensionPromptTypes, extensionPromptRoles, signal = null, { chatMessages = null } = {}) {
    const s = getSettings();
    if (!isPathfinderSubmoduleEnabled() || !(s.sidecarEnabled || s.pipelineEnabled)) {
        return { success: false };
    }

    const chatId = getCurrentChatId();
    const isCurrent = () => !signal?.aborted && isPathfinderSubmoduleEnabled() && getCurrentChatId() === chatId;
    const writePrompt = (...args) => isCurrent() ? setExtensionPrompt(...args) : false;
    const ctx = globalThis.window?.SillyTavern?.getContext?.();
    const messages = (chatMessages ?? ctx?.chat ?? chat).slice(-10).map(message => ({
        name: message.name,
        is_user: message.is_user || message.role === 'user',
        mes: String(message.mes ?? message.content ?? ''),
    }));
    const mode = s.pipelineEnabled ? 'pipeline' : 'tool-retrieval';
    const promptKey = s.pipelineEnabled ? PIPELINE_RETRIEVAL_KEY : RETRIEVAL_PROMPT_KEY;
    const seconds = Number(s.retrievalTimeoutSeconds ?? 8);
    const timeoutMs = Math.max(1, Math.min(60, Number.isFinite(seconds) ? seconds : 8)) * 1000;
    const timeoutId = setTimeout(() => {
        if (isCurrent()) {
            globalThis.toastr?.warning?.('Pathfinder is processing lore for this reply...', 'Please wait');
        }
    }, timeoutMs);

    try {
        throwIfAborted(signal);
        for (const key of PATHFINDER_RETRIEVAL_PROMPT_KEYS) {
            clearRetrievalPrompt(writePrompt, key, extensionPromptTypes, extensionPromptRoles);
        }
        const books = await ensureReadableBookTrees(getReadableBooks(), signal);
        const selection = s.pipelineEnabled
            ? await runPipelineRetrieval(books, messages, signal)
            : await runLegacySidecarRetrieval(books, messages, signal);
        throwIfAborted(signal);
        if (!isCurrent()) return { success: false };

        const result = { ...selection, books, mode, promptKey, dedupeNaturalActivation: s.dedupeNaturalActivation };
        injectPathfinderRetrieval(result, writePrompt, extensionPromptTypes, extensionPromptRoles);
        return result;
    } catch (err) {
        if (!isAbortLikeError(err, signal)) {
            console.warn('[Pathfinder] Retrieval failed:', err);
        }
        return { success: false };
    } finally {
        clearTimeout(timeoutId);
    }
}
