/**
 * Prompt Store - CRUD operations for pipeline prompts with persistence
 * Prompts are stored in extension_settings and can be edited via UI
 */

import { getSettings, setSettings } from '../tree-store.js';

const PROMPTS_KEY = 'pipelinePrompts';
const PIPELINES_KEY = 'pipelines';

/** @type {Map<string, PipelinePrompt>} */
const promptCache = new Map();

/** @type {Map<string, Pipeline>} */
const pipelineCache = new Map();

/**
 * @typedef {Object} PromptSettings
 * @property {number} maxTokens
 * @property {number} temperature
 */

/**
 * @typedef {Object} PipelinePrompt
 * @property {string} id - Unique identifier
 * @property {string} name - Display name
 * @property {string} description - What this prompt does
 * @property {number} version - Version number for tracking changes
 * @property {string} systemPrompt - System message for the LLM
 * @property {string} userPromptTemplate - User message template with {{variables}}
 * @property {'json_array' | 'text_lines' | 'json_object'} outputFormat - How to parse output
 * @property {string} connectionProfile - Connection profile ID (empty = use default)
 * @property {PromptSettings} settings - Generation settings
 * @property {boolean} [isDefault] - Whether this is a bundled default prompt
 */

/**
 * @typedef {Object} PipelineStage
 * @property {string} promptId - ID of the prompt to use
 * @property {Record<string, string>} inputMapping - Maps template vars to data sources
 * @property {string} outputKey - Key to store this stage's output
 * @property {boolean} [optional] - Whether this stage can be skipped
 * @property {string} [skipCondition] - Settings path to check for skipping
 */

/**
 * @typedef {Object} Pipeline
 * @property {string} id - Unique identifier
 * @property {string} name - Display name
 * @property {string} description - What this pipeline does
 * @property {PipelineStage[]} stages - Ordered list of stages
 * @property {boolean} [isDefault] - Whether this is a bundled default pipeline
 */

/**
 * Get all prompts from storage
 * @returns {Map<string, PipelinePrompt>}
 */
export function getAllPrompts() {
    return new Map(promptCache);
}

/**
 * Get a prompt by ID
 * @param {string} promptId
 * @returns {PipelinePrompt | null}
 */
export function getPrompt(promptId) {
    return promptCache.get(promptId) ?? null;
}

/**
 * Save or update a prompt
 * @param {PipelinePrompt} prompt
 */
export function savePrompt(prompt) {
    if (!prompt.id) {
        throw new Error('Prompt must have an id');
    }
    promptCache.set(prompt.id, { ...prompt });
    persistPrompts();
}

/**
 * Delete a prompt
 * @param {string} promptId
 * @returns {boolean} Whether deletion succeeded
 */
export function deletePrompt(promptId) {
    const prompt = promptCache.get(promptId);
    if (prompt?.isDefault) {
        console.warn(`[PromptStore] Cannot delete default prompt: ${promptId}`);
        return false;
    }
    const deleted = promptCache.delete(promptId);
    if (deleted) {
        persistPrompts();
    }
    return deleted;
}

/**
 * Reset a prompt to its default version
 * @param {string} promptId
 * @param {PipelinePrompt} defaultPrompt - The default to restore
 */
export function resetPromptToDefault(promptId, defaultPrompt) {
    if (defaultPrompt) {
        promptCache.set(promptId, { ...defaultPrompt, isDefault: true });
        persistPrompts();
    }
}

/**
 * Get all pipelines from storage
 * @returns {Map<string, Pipeline>}
 */
export function getAllPipelines() {
    return new Map(pipelineCache);
}

/**
 * Get a pipeline by ID
 * @param {string} pipelineId
 * @returns {Pipeline | null}
 */
export function getPipeline(pipelineId) {
    return pipelineCache.get(pipelineId) ?? null;
}

/**
 * Save or update a pipeline
 * @param {Pipeline} pipeline
 */
export function savePipeline(pipeline) {
    if (!pipeline.id) {
        throw new Error('Pipeline must have an id');
    }
    pipelineCache.set(pipeline.id, { ...pipeline });
    persistPipelines();
}

/**
 * Delete a pipeline
 * @param {string} pipelineId
 * @returns {boolean}
 */
export function deletePipeline(pipelineId) {
    const pipeline = pipelineCache.get(pipelineId);
    if (pipeline?.isDefault) {
        console.warn(`[PromptStore] Cannot delete default pipeline: ${pipelineId}`);
        return false;
    }
    const deleted = pipelineCache.delete(pipelineId);
    if (deleted) {
        persistPipelines();
    }
    return deleted;
}

// Pathfinder settings persist through the Pathfinder agent record, not
// extension_settings — without this hook, edits made outside the settings
// panel (e.g. the standalone prompt editor) were lost on reload.
let persistHook = null;

export function setPromptStorePersistHook(fn) {
    persistHook = typeof fn === 'function' ? fn : null;
}

/**
 * Persist prompts to extension settings
 */
function persistPrompts() {
    const settings = getSettings();
    const promptsObj = {};
    for (const [id, prompt] of promptCache) {
        promptsObj[id] = prompt;
    }
    settings[PROMPTS_KEY] = promptsObj;
    setSettings(settings);
    triggerSettingsSave();
    persistHook?.();
}

/**
 * Persist pipelines to extension settings
 */
function persistPipelines() {
    const settings = getSettings();
    const pipelinesObj = {};
    for (const [id, pipeline] of pipelineCache) {
        pipelinesObj[id] = pipeline;
    }
    settings[PIPELINES_KEY] = pipelinesObj;
    setSettings(settings);
    triggerSettingsSave();
    persistHook?.();
}

/**
 * Trigger SillyTavern settings save
 */
function triggerSettingsSave() {
    const context = window?.SillyTavern?.getContext?.();
    if (context?.saveSettingsDebounced) {
        context.saveSettingsDebounced();
    }
}

/**
 * Load prompts and pipelines from extension settings
 * Called during initialization
 * @param {Record<string, PipelinePrompt>} defaultPrompts - Default prompts to merge
 * @param {Record<string, Pipeline>} defaultPipelines - Default pipelines to merge
 */
export function initializePromptStore(defaultPrompts = {}, defaultPipelines = {}) {
    const settings = getSettings();

    // Load saved prompts, falling back to defaults
    const savedPrompts = settings[PROMPTS_KEY] ?? {};
    promptCache.clear();

    // First, add all defaults
    for (const [id, prompt] of Object.entries(defaultPrompts)) {
        promptCache.set(id, { ...prompt, isDefault: true });
    }

    // Then overlay with saved (user-modified) versions
    for (const [id, prompt] of Object.entries(savedPrompts)) {
        // Preserve isDefault flag from the default if it exists
        const isDefault = !!defaultPrompts[id];
        promptCache.set(id, { ...prompt, isDefault });
    }

    // Load saved pipelines, falling back to defaults
    const savedPipelines = settings[PIPELINES_KEY] ?? {};
    pipelineCache.clear();

    for (const [id, pipeline] of Object.entries(defaultPipelines)) {
        pipelineCache.set(id, { ...pipeline, isDefault: true });
    }

    for (const [id, pipeline] of Object.entries(savedPipelines)) {
        const isDefault = !!defaultPipelines[id];
        pipelineCache.set(id, { ...pipeline, isDefault });
    }
}

/**
 * Check if a prompt has been modified from its default
 * @param {string} promptId
 * @param {PipelinePrompt} defaultPrompt
 * @returns {boolean}
 */
export function isPromptModified(promptId, defaultPrompt) {
    const current = promptCache.get(promptId);
    if (!current || !defaultPrompt) return false;

    return (
        current.systemPrompt !== defaultPrompt.systemPrompt ||
        current.userPromptTemplate !== defaultPrompt.userPromptTemplate ||
        current.connectionProfile !== defaultPrompt.connectionProfile ||
        current.settings?.maxTokens !== defaultPrompt.settings?.maxTokens ||
        current.settings?.temperature !== defaultPrompt.settings?.temperature
    );
}

/**
 * Get prompt IDs that reference a specific connection profile
 * @param {string} profileId
 * @returns {string[]}
 */
export function getPromptsUsingProfile(profileId) {
    const result = [];
    for (const [id, prompt] of promptCache) {
        if (prompt.connectionProfile === profileId) {
            result.push(id);
        }
    }
    return result;
}
