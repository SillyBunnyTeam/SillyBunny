import { chat, substituteParams } from '../../../../script.js';
import { parseRegexFromString, world_info_logic, world_info_match_whole_words } from '../../../world-info.js';
import { isAbortLikeError } from '../../../util/abort-error.js';
import { isPathfinderSubmoduleEnabled } from '../agent-store.js';
import { getTree, findNodeById, getAllEntryUids, getSettings } from './tree-store.js';
import { getReadableBooks, getEntryContent } from './pathfinder-tool-bridge.js';
import { sidecarGenerate } from './llm-sidecar.js';
import { logPathfinderRetrievalDetail, logSidecarRetrieval, logPipelineStart, logPipelineComplete, setSidecarActive } from './activity-feed.js';
import { buildTreeFromMetadata } from './tree-builder.js';
import { runPipeline } from './prompts/pipeline-runner.js';
import { isSummaryMemoryEntry, markSummaryMemoryInjected } from './summary-memory-store.js';

const RETRIEVAL_PROMPT_KEY = 'pathfinder_sidecar_retrieval';
const PIPELINE_RETRIEVAL_KEY = 'pathfinder_pipeline_retrieval';
export const PATHFINDER_RETRIEVAL_PROMPT_KEYS = Object.freeze([
    RETRIEVAL_PROMPT_KEY,
    PIPELINE_RETRIEVAL_KEY,
]);

function clearRetrievalPrompt(setExtensionPrompt, key, extensionPromptTypes, extensionPromptRoles) {
    setExtensionPrompt(
        key,
        '',
        extensionPromptTypes?.IN_PROMPT ?? 0,
        4,
        false,
        extensionPromptRoles?.SYSTEM ?? 0,
    );
}

function getRecentChatText(limit = 10) {
    const ctx = globalThis.window?.SillyTavern?.getContext?.();
    const messages = Array.isArray(ctx?.chat) ? ctx.chat : chat;
    return messages
        .slice(-limit)
        .map(message => String(message?.mes ?? message?.content ?? message ?? ''))
        .join('\n');
}

function transformForEntry(value, entry) {
    return entry?.caseSensitive ? String(value ?? '') : String(value ?? '').toLowerCase();
}

function escapeRegexLiteral(value) {
    return String(value ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function matchesWorldInfoKey(haystack, key, entry) {
    const substituted = substituteParams(String(key ?? '')).trim();
    if (!substituted) {
        return false;
    }

    const keyRegex = parseRegexFromString(substituted);
    if (keyRegex) {
        return keyRegex.test(haystack);
    }

    const transformedHaystack = transformForEntry(haystack, entry);
    const transformedKey = transformForEntry(substituted, entry);
    const matchWholeWords = entry?.matchWholeWords ?? world_info_match_whole_words;

    if (!matchWholeWords) {
        return transformedHaystack.includes(transformedKey);
    }

    const keyWords = transformedKey.split(/\s+/);
    if (keyWords.length > 1) {
        return transformedHaystack.includes(transformedKey);
    }

    return new RegExp(`(?:^|\\W)(${escapeRegexLiteral(transformedKey)})(?:$|\\W)`).test(transformedHaystack);
}

function hasSecondaryActivationMatch(textToScan, entry) {
    if (!entry?.selective || !Array.isArray(entry.keysecondary) || entry.keysecondary.length === 0) {
        return true;
    }

    const selectiveLogic = entry.selectiveLogic ?? world_info_logic.AND_ANY;
    let hasAnyMatch = false;
    let hasAllMatch = true;

    for (const key of entry.keysecondary) {
        const matched = matchesWorldInfoKey(textToScan, key, entry);
        if (matched) hasAnyMatch = true;
        if (!matched) hasAllMatch = false;

        if (selectiveLogic === world_info_logic.AND_ANY && matched) return true;
        if (selectiveLogic === world_info_logic.NOT_ALL && !matched) return true;
    }

    if (selectiveLogic === world_info_logic.NOT_ANY && !hasAnyMatch) return true;
    if (selectiveLogic === world_info_logic.AND_ALL && hasAllMatch) return true;
    return false;
}

function getNaturalActivationReason(entry, textToScan = getRecentChatText()) {
    if (!entry || entry.disable) {
        return '';
    }

    if (entry.decorators?.includes?.('@@activate')) {
        return '@@activate decorator';
    }

    if (entry.constant) {
        return 'constant entry';
    }

    const primaryKeyMatch = Array.isArray(entry.key)
        ? entry.key.find(key => matchesWorldInfoKey(textToScan, key, entry))
        : null;
    if (!primaryKeyMatch) {
        return '';
    }

    return hasSecondaryActivationMatch(textToScan, entry)
        ? `keyword match: ${primaryKeyMatch}`
        : '';
}

function shouldSkipNaturalActivation(entry, textToScan) {
    const settings = getSettings();
    if (settings.dedupeNaturalActivation === false) {
        return '';
    }

    return getNaturalActivationReason(entry, textToScan);
}

function getRetrievalStatusTimeoutMs() {
    const seconds = Number(getSettings().retrievalTimeoutSeconds ?? 8);
    return Math.max(1, Math.min(60, Number.isFinite(seconds) ? seconds : 8)) * 1000;
}

function throwIfAborted(signal) {
    if (!signal?.aborted) {
        return;
    }

    throw signal.reason ?? new Error('Pathfinder retrieval cancelled.');
}

async function withRetrievalStatusGuard(task, mode = 'retrieval', signal = null) {
    const timeoutMs = getRetrievalStatusTimeoutMs();
    let timeoutId = null;

    timeoutId = setTimeout(() => {
        console.warn(`[Pathfinder] ${mode} is still running after ${timeoutMs / 1000}s; waiting for retrieval before generation.`);
    }, timeoutMs);

    try {
        throwIfAborted(signal);
        return await task(signal);
    } finally {
        clearTimeout(timeoutId);
    }
}

function formatCollapsedGuide(tree, bookName) {
    if (!tree) return '';
    const lines = [];
    function walk(node, depth = 0) {
        const indent = '  '.repeat(depth);
        const entries = (node.entries || []).length;
        const subWaypoints = (node.children || []).length;
        let line = `${indent}${node.name}`;
        if (entries) line += ` (${entries} entries)`;
        if (subWaypoints) line += ` [${subWaypoints} sub-waypoints]`;
        lines.push(line);
        for (const child of node.children || []) walk(child, depth + 1);
    }
    walk(tree);
    return lines.join('\n');
}

async function ensureLorebookTree(bookName, signal = null) {
    throwIfAborted(signal);

    if (getTree(bookName)) {
        return true;
    }

    const ctx = window?.SillyTavern?.getContext?.();
    if (typeof ctx?.loadWorldInfo !== 'function') {
        console.warn(`[Pathfinder] Could not build a tree for "${bookName}" because loadWorldInfo is unavailable.`);
        return false;
    }

    try {
        const bookData = await ctx.loadWorldInfo(bookName);
        throwIfAborted(signal);
        if (!bookData?.entries) {
            console.warn(`[Pathfinder] Could not build a tree for "${bookName}" because no lorebook entries were found.`);
            return false;
        }

        await buildTreeFromMetadata(bookName, bookData);
        return true;
    } catch (err) {
        console.warn(`[Pathfinder] Failed to build a tree for "${bookName}".`, err);
        return false;
    }
}

async function ensureReadableBookTrees(bookNames, signal = null) {
    const readableBooks = Array.from(new Set((bookNames ?? []).filter(Boolean)));

    for (const bookName of readableBooks) {
        await ensureLorebookTree(bookName, signal);
    }

    return readableBooks.filter(bookName => getTree(bookName));
}

/**
 * Run predictive pipeline retrieval
 * @param {Function} setExtensionPrompt
 * @param {Object} extensionPromptTypes
 * @param {Object} extensionPromptRoles
 * @returns {Promise<void>}
 */
async function runPipelineRetrieval(setExtensionPrompt, extensionPromptTypes, extensionPromptRoles, signal = null) {
    const s = getSettings();
    const pipelineId = s.pipelineId || 'default';
    const books = await ensureReadableBookTrees(getReadableBooks(), signal);

    // Get chat messages from context
    const ctx = window?.SillyTavern?.getContext?.();
    const chatMessages = ctx?.chat ?? [];

    if (books.length === 0) {
        clearRetrievalPrompt(setExtensionPrompt, PIPELINE_RETRIEVAL_KEY, extensionPromptTypes, extensionPromptRoles);
        logPathfinderRetrievalDetail({
            mode: 'pipeline',
            books,
            selectedEntries: [],
            stageResults: [],
            injectedPrompt: '',
            metadata: { pipelineId, reason: 'no-readable-lorebooks' },
        });
        return;
    }

    if (chatMessages.length === 0) {
        clearRetrievalPrompt(setExtensionPrompt, PIPELINE_RETRIEVAL_KEY, extensionPromptTypes, extensionPromptRoles);
        logPathfinderRetrievalDetail({
            mode: 'pipeline',
            books,
            selectedEntries: [],
            stageResults: [],
            injectedPrompt: '',
            metadata: { pipelineId, reason: 'no-chat-messages' },
        });
        return;
    }

    logPipelineStart(pipelineId, 2); // Assuming 2-stage pipeline

    const result = await runPipeline(pipelineId, chatMessages, 10, signal);

    logPipelineComplete(pipelineId, result.selectedEntries?.length ?? 0, result.stageResults);

    if (!result.success) {
        clearRetrievalPrompt(setExtensionPrompt, PIPELINE_RETRIEVAL_KEY, extensionPromptTypes, extensionPromptRoles);
        console.warn('[Pathfinder] Pipeline retrieval failed:', result.error);
        logPathfinderRetrievalDetail({
            mode: 'pipeline',
            books,
            selectedEntries: [],
            stageResults: result.stageResults,
            injectedPrompt: '',
            metadata: { pipelineId, error: result.error },
        });
        return;
    }

    if (result.selectedEntries.length === 0) {
        clearRetrievalPrompt(setExtensionPrompt, PIPELINE_RETRIEVAL_KEY, extensionPromptTypes, extensionPromptRoles);
        logPathfinderRetrievalDetail({
            mode: 'pipeline',
            books,
            selectedEntries: [],
            stageResults: result.stageResults,
            injectedPrompt: '',
            metadata: { pipelineId, selectedEntryCount: 0 },
        });
        return;
    }

    // Build content for injection - fetch actual entry content
    const entryContents = [];
    const skippedNaturalEntries = [];
    const textToScan = getRecentChatText();

    for (const entryName of result.selectedEntries) {
        for (const bookName of books) {
            const tree = getTree(bookName);
            if (!tree) continue;

            const uids = getAllEntryUids(tree);
            for (const uid of uids) {
                const entry = await getEntryContent(bookName, uid);
                if (entry && entry.comment === entryName) {
                    const naturalActivationReason = shouldSkipNaturalActivation(entry, textToScan);
                    if (naturalActivationReason) {
                        skippedNaturalEntries.push({
                            name: entry.comment,
                            bookName,
                            uid,
                            reason: naturalActivationReason,
                        });
                        break;
                    }

                    entryContents.push({
                        name: entry.comment,
                        bookName,
                        uid,
                        content: entry.content,
                    });
                    break;
                }
            }
        }
    }

    if (entryContents.length > 0) {
        const formattedContent = entryContents
            .map(e => `[${e.name}]\n${e.content}`)
            .join('\n\n');

        const content = `<pathfinder_context>\n${formattedContent}\n</pathfinder_context>`;
        if (entryContents.some(entry => isSummaryMemoryEntry(entry))) {
            markSummaryMemoryInjected({ mode: 'pipeline' });
        }

        logPathfinderRetrievalDetail({
            mode: 'pipeline',
            books,
            selectedEntries: entryContents.map(entry => ({
                name: entry.name,
                bookName: entry.bookName || '',
                uid: entry.uid ?? null,
                preview: entry.content ? String(entry.content).slice(0, 240) : '',
            })),
            stageResults: result.stageResults,
            injectedPrompt: content,
            metadata: {
                pipelineId,
                selectedEntryCount: entryContents.length,
                candidateCount: result.selectedEntries?.length ?? 0,
                skippedNaturalActivationCount: skippedNaturalEntries.length,
                skippedNaturalEntries,
            },
        });
        setExtensionPrompt(
            PIPELINE_RETRIEVAL_KEY,
            content,
            extensionPromptTypes?.IN_PROMPT ?? 0,
            4,
            false,
            extensionPromptRoles?.SYSTEM ?? 0,
        );
    } else {
        clearRetrievalPrompt(setExtensionPrompt, PIPELINE_RETRIEVAL_KEY, extensionPromptTypes, extensionPromptRoles);
        logPathfinderRetrievalDetail({
            mode: 'pipeline',
            books,
            selectedEntries: [],
            stageResults: result.stageResults,
            injectedPrompt: '',
            metadata: {
                pipelineId,
                selectedEntryCount: 0,
                candidateCount: result.selectedEntries?.length ?? 0,
                skippedNaturalActivationCount: skippedNaturalEntries.length,
                skippedNaturalEntries,
            },
        });
    }
}

/**
 * Run legacy waypoint-based sidecar retrieval
 * @param {Function} setExtensionPrompt
 * @param {Object} extensionPromptTypes
 * @param {Object} extensionPromptRoles
 * @returns {Promise<void>}
 */
async function runLegacySidecarRetrieval(setExtensionPrompt, extensionPromptTypes, extensionPromptRoles, signal = null) {
    const books = await ensureReadableBookTrees(getReadableBooks(), signal);
    if (books.length === 0) return;

    let contextText = '';

    for (const bookName of books) {
        const tree = getTree(bookName);
        if (!tree) continue;
        contextText += `\n### ${bookName}\n${formatCollapsedGuide(tree, bookName)}\n`;
    }

    if (!contextText.trim()) return;

    const prompt = `Given the current conversation context, which of these lorebook waypoints contain information relevant to what's happening right now? List the waypoint/node IDs you'd retrieve.\n\n${contextText}`;

    try {
        const response = await sidecarGenerate(prompt, 'You are a lorebook retrieval assistant. Analyze the conversation and identify which waypoints are relevant. Respond with waypoint/node IDs, one per line.', signal);
        const nodeIds = response.split('\n').map(l => l.trim()).filter(Boolean);
        const allEntries = [];

        for (const bookName of books) {
            const tree = getTree(bookName);
            if (!tree) continue;
            for (const nodeId of nodeIds) {
                const node = findNodeById(tree, nodeId);
                if (node && node.entries?.length) {
                    allEntries.push(...node.entries);
                }
            }
        }

        logSidecarRetrieval(nodeIds, allEntries.length);
        logPathfinderRetrievalDetail({
            mode: 'tool-retrieval',
            books,
            selectedEntries: allEntries.map(entry => ({
                uid: entry?.uid ?? null,
                name: entry?.comment || entry?.key?.[0] || '',
                preview: entry?.content ? String(entry.content).slice(0, 240) : '',
            })),
            stageResults: [{
                stageIndex: 0,
                promptId: 'legacy-sidecar',
                success: true,
                entriesFound: allEntries.length,
                nodeIds,
            }],
            injectedPrompt: allEntries.length > 0 ? `**Pathfinder Auto-Retrieval** (${allEntries.length} entries relevant)` : '',
            metadata: {
                nodeIds,
                selectedEntryCount: allEntries.length,
            },
        });

        if (allEntries.some(entry => isSummaryMemoryEntry(entry))) {
            markSummaryMemoryInjected({ mode: 'tool-retrieval' });
        }

        if (allEntries.length > 0) {
            const content = `**Pathfinder Auto-Retrieval** (${allEntries.length} entries relevant)`;
            setExtensionPrompt(RETRIEVAL_PROMPT_KEY, content, extensionPromptTypes?.IN_PROMPT ?? 0, 4, false, extensionPromptRoles?.SYSTEM ?? 0);
        }
    } catch (err) {
        if (!isAbortLikeError(err, signal)) {
            console.warn('[Pathfinder] Sidecar retrieval failed:', err);
        }
    }
}

export async function runSidecarRetrieval(setExtensionPrompt, extensionPromptTypes, extensionPromptRoles, signal = null) {
    if (!isPathfinderSubmoduleEnabled()) {
        return;
    }

    const s = getSettings();
    if (!(s.sidecarEnabled || s.pipelineEnabled)) return;

    const books = getReadableBooks();
    if (books.length === 0) return;

    setSidecarActive(true);

    try {
        await withRetrievalStatusGuard(async (retrievalSignal) => {
            if (s.pipelineEnabled) {
                await runPipelineRetrieval(setExtensionPrompt, extensionPromptTypes, extensionPromptRoles, retrievalSignal);
            } else {
                await runLegacySidecarRetrieval(setExtensionPrompt, extensionPromptTypes, extensionPromptRoles, retrievalSignal);
            }
        }, s.pipelineEnabled ? 'pipeline' : 'tool-retrieval', signal);
    } catch (err) {
        if (!isAbortLikeError(err, signal)) {
            console.warn('[Pathfinder] Retrieval failed:', err);
        }
    } finally {
        setSidecarActive(false);
    }
}
