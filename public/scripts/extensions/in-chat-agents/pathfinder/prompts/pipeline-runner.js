/**
 * Pipeline Runner - Orchestrates multi-stage prompt execution for predictive lore retrieval
 */

import { getPrompt, getPipeline } from './prompt-store.js';
import { sidecarGenerateWithProfile } from '../llm-sidecar.js';
import { getSettings, getTree, getAllEntryUids } from '../tree-store.js';
import { getReadableBooks, getAllEntriesWithContent } from '../pathfinder-tool-bridge.js';
import { logPipelineStageStart, logPipelineStageComplete, logPipelineError } from '../activity-feed.js';
import { isAbortLikeError } from '../../../../util/abort-error.js';

const PATHFINDER_LOG_PREFIX = '[Pathfinder]';
const DEFAULT_PIPELINE_MAX_TOKENS = 64000;

function throwIfAborted(signal) {
    if (!signal?.aborted) {
        return;
    }

    throw signal.reason ?? new Error('Pathfinder pipeline cancelled.');
}

/**
 * @typedef {Object} PipelineContext
 * @property {string} chat_history - Formatted recent chat
 * @property {string} entry_names - List of all entry names
 * @property {Map<string, Object>} entriesByName - Map of entry name -> entry data
 * @property {Map<string, any>} stageOutputs - Outputs from previous stages
 */

/**
 * @typedef {Object} PipelineResult
 * @property {boolean} success
 * @property {string[]} selectedEntries - Entry names/UIDs to activate
 * @property {Object[]} stageResults - Results from each stage
 * @property {string} [error] - Error message if failed
 */

/**
 * Run a pipeline to select relevant lorebook entries
 * @param {string} pipelineId - Pipeline to run
 * @param {Object[]} chatMessages - Recent chat messages
 * @param {number} [maxMessages=10] - Max messages to include in context
 * @returns {Promise<PipelineResult>}
 */
export async function runPipeline(pipelineId, chatMessages, maxMessages = 10, signal = null) {
    throwIfAborted(signal);
    const pipeline = getPipeline(pipelineId);
    if (!pipeline) {
        console.warn(`${PATHFINDER_LOG_PREFIX} Pipeline "${pipelineId}" was requested, but no matching pipeline was found.`);
        return {
            success: false,
            selectedEntries: [],
            stageResults: [],
            error: `Pipeline not found: ${pipelineId}`,
        };
    }

    const settings = getSettings();
    const context = await buildPipelineContext(chatMessages, maxMessages);

    if (!context.entry_names.trim()) {
        return {
            success: true,
            selectedEntries: [],
            stageResults: [],
            error: 'No lorebook entries available',
        };
    }

    const stageResults = [];
    let currentEntries = [];

    for (let i = 0; i < pipeline.stages.length; i++) {
        throwIfAborted(signal);
        const stage = pipeline.stages[i];

        // Check skip condition
        if (stage.optional && stage.skipCondition && settings[stage.skipCondition]) {
            stageResults.push({
                stageIndex: i,
                promptId: stage.promptId,
                skipped: true,
                reason: `Skipped due to ${stage.skipCondition}`,
            });
            continue;
        }

        const prompt = getPrompt(stage.promptId);
        if (!prompt) {
            const error = `Prompt not found: ${stage.promptId}`;
            logPipelineError(pipeline.name, stage.promptId, error);
            console.warn(`${PATHFINDER_LOG_PREFIX} Pipeline stage ${i + 1} is missing prompt "${stage.promptId}".`);
            return {
                success: false,
                selectedEntries: [],
                stageResults,
                error,
            };
        }

        logPipelineStageStart(pipeline.name, prompt.name, i + 1, pipeline.stages.length);

        try {
            // Resolve input mappings
            const inputs = resolveInputMappings(stage.inputMapping, context, currentEntries, settings);

            // Build the prompt
            const userPrompt = substituteTemplate(prompt.userPromptTemplate, inputs);

            // Get connection profile (stage-specific or default)
            const profileId = prompt.connectionProfile || settings.connectionProfile || '';
            const maxTokens = prompt.settings?.maxTokens ?? DEFAULT_PIPELINE_MAX_TOKENS;

            // Call the LLM
            const response = await sidecarGenerateWithProfile(
                userPrompt,
                prompt.systemPrompt,
                profileId,
                maxTokens,
                signal,
            );
            throwIfAborted(signal);

            // Parse the output
            const parsed = parseOutput(response, prompt.outputFormat, context.entriesByName);

            currentEntries = parsed.entries;
            context.stageOutputs.set(stage.outputKey, {
                entries: currentEntries,
                raw: response,
                parsed,
            });

            logPipelineStageComplete(pipeline.name, prompt.name, currentEntries.length);

            stageResults.push({
                stageIndex: i,
                promptId: stage.promptId,
                success: true,
                entriesFound: currentEntries.length,
                reasoning: parsed.reasoning,
            });
        } catch (error) {
            if (isAbortLikeError(error, signal)) {
                throw error;
            }

            const errorMsg = error instanceof Error ? error.message : String(error);
            logPipelineError(pipeline.name, stage.promptId, errorMsg);
            console.warn(`${PATHFINDER_LOG_PREFIX} Pipeline stage ${i + 1}/${pipeline.stages.length} failed.`, {
                promptId: stage.promptId,
                error: errorMsg,
            });

            stageResults.push({
                stageIndex: i,
                promptId: stage.promptId,
                success: false,
                error: errorMsg,
            });

            // If non-optional stage fails, abort
            if (!stage.optional) {
                return {
                    success: false,
                    selectedEntries: [],
                    stageResults,
                    error: `Stage ${i + 1} failed: ${errorMsg}`,
                };
            }
        }
    }

    return {
        success: true,
        selectedEntries: currentEntries,
        stageResults,
    };
}

/**
 * Build the initial context for pipeline execution
 * @param {Object[]} chatMessages
 * @param {number} maxMessages
 * @returns {Promise<PipelineContext>}
 */
async function buildPipelineContext(chatMessages, maxMessages) {
    const books = getReadableBooks();

    // Format chat history
    const recentMessages = chatMessages.slice(-maxMessages);
    const chat_history = recentMessages
        .map(msg => {
            const name = msg.is_user ? 'User' : (msg.name || 'Assistant');
            return `${name}: ${msg.mes}`;
        })
        .join('\n\n');

    // Gather all entries from enabled lorebooks (one load per book;
    // per-UID fetches re-loaded the whole book for every entry)
    const entriesByName = new Map();
    const entryNames = [];

    for (const bookName of books) {
        const tree = getTree(bookName);
        if (!tree) {
            continue;
        }

        const treeUids = new Set(getAllEntryUids(tree));
        const entries = await getAllEntriesWithContent(bookName);
        for (const entry of entries) {
            if (!treeUids.has(entry.uid) || !entry.comment) {
                continue;
            }
            entriesByName.set(entry.comment, { ...entry, bookName });
            entryNames.push(`- ${entry.comment}`);
        }
    }

    return {
        chat_history,
        entry_names: entryNames.join('\n'),
        entriesByName,
        stageOutputs: new Map(),
    };
}

/**
 * Resolve input mappings for a stage
 * @param {Record<string, string>} mappings
 * @param {PipelineContext} context
 * @param {string[]} currentEntries
 * @param {Object} settings
 * @returns {Record<string, string>}
 */
function resolveInputMappings(mappings, context, currentEntries, settings) {
    const resolved = {};

    for (const [key, source] of Object.entries(mappings)) {
        if (source.startsWith('source:')) {
            // Direct source data
            const sourceKey = source.slice(7);
            resolved[key] = context[sourceKey] ?? '';
        } else if (source.startsWith('prev:')) {
            // Data from previous stage
            const prevKey = source.slice(5);
            if (prevKey === 'candidate_entries') {
                // Build entry content for candidates
                resolved[key] = formatCandidateEntries(currentEntries, context, settings);
            } else {
                const prevOutput = context.stageOutputs.get(prevKey);
                resolved[key] = prevOutput?.entries?.join('\n') ?? '';
            }
        } else if (source.startsWith('settings:')) {
            // Settings value
            const settingsKey = source.slice(9);
            resolved[key] = String(settings[settingsKey] ?? '');
        } else {
            resolved[key] = source;
        }
    }

    return resolved;
}

/**
 * Format candidate entries for the relevance filter stage
 * @param {string[]} candidates
 * @param {PipelineContext} context
 * @param {Object} settings
 * @returns {string}
 */
function formatCandidateEntries(candidates, context, settings) {
    const contentMode = settings.entryContentMode ?? 'full';
    const truncateLength = settings.truncateLength ?? 500;
    const maxCandidates = settings.maxCandidates ?? 20;

    const limited = candidates.slice(0, maxCandidates);
    const formatted = [];

    for (const name of limited) {
        const entry = context.entriesByName.get(name);
        if (!entry) continue;

        let content = entry.content || '';

        if (contentMode === 'truncated' && content.length > truncateLength) {
            content = content.slice(0, truncateLength) + '...';
        }

        formatted.push(`### ${name}\n${content}`);
    }

    return formatted.join('\n\n');
}

function normalizeEntryName(name) {
    return String(name || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function resolveEntryName(name, entriesByName) {
    if (typeof name !== 'string') {
        return null;
    }

    const trimmed = name.trim();
    if (entriesByName.has(trimmed)) {
        return trimmed;
    }

    const normalized = normalizeEntryName(trimmed);
    for (const knownName of entriesByName.keys()) {
        if (normalizeEntryName(knownName) === normalized) {
            return knownName;
        }
    }

    return null;
}

/**
 * Substitute template variables
 * @param {string} template
 * @param {Record<string, string>} values
 * @returns {string}
 */
function substituteTemplate(template, values) {
    let result = template;
    for (const [key, value] of Object.entries(values)) {
        // Function replacer: chat text may contain $&/$1 replacement patterns
        result = result.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), () => value);
    }
    return result;
}

/**
 * Parse LLM output based on format
 * @param {string} response
 * @param {string} format
 * @param {Map<string, Object>} entriesByName
 * @returns {{ entries: string[], reasoning?: string }}
 */
function parseOutput(response, format, entriesByName) {
    const trimmed = response.trim();

    if (format === 'json_object' || format === 'json_array') {
        // Try to extract JSON from response
        const jsonMatch = trimmed.match(/```json\s*([\s\S]*?)```/) ||
                          trimmed.match(/\{[\s\S]*\}/) ||
                          trimmed.match(/\[[\s\S]*\]/);

        if (jsonMatch) {
            try {
                const json = JSON.parse(jsonMatch[1] || jsonMatch[0]);

                // Handle various output formats
                let entries = [];
                let reasoning = '';

                if (Array.isArray(json)) {
                    entries = json;
                } else if (json.candidates) {
                    entries = json.candidates;
                    reasoning = json.reasoning;
                } else if (json.selected) {
                    entries = json.selected;
                    reasoning = json.reasoning;
                }

                // Validate entries exist
                const validEntries = [];
                for (const name of entries) {
                    const resolvedName = resolveEntryName(name, entriesByName);
                    if (resolvedName) {
                        validEntries.push(resolvedName);
                    }
                }

                if (entries.length > 0 && validEntries.length === 0) {
                    console.warn(`${PATHFINDER_LOG_PREFIX} Pipeline JSON returned candidates, but none matched loaded lorebook entries.`, {
                        requestedEntries: entries,
                        knownEntryCount: entriesByName.size,
                        knownEntries: Array.from(entriesByName.keys()).slice(0, 50),
                    });
                    reasoning = [
                        reasoning,
                        `Pathfinder warning: model returned ${entries.length} candidate(s), but none matched the ${entriesByName.size} loaded lorebook entry names.`,
                    ].filter(Boolean).join('\n\n');
                }

                return { entries: validEntries, reasoning };
            } catch (e) {
                console.warn(`${PATHFINDER_LOG_PREFIX} Failed to parse pipeline JSON output.`, e);
            }
        }
    }

    // Fallback: extract entry names line by line
    const lines = trimmed.split('\n')
        .map(line => line.replace(/^[-*]\s*/, '').trim())
        .filter(line => line && entriesByName.has(line));

    return { entries: lines };
}
