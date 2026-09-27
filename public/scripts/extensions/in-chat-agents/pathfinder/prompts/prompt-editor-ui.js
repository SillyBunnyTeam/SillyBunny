/**
 * Prompt Editor UI - UI component for editing pipeline prompts in Pathfinder settings
 */

import { getAllPrompts, getPrompt, savePrompt, isPromptModified, getAllPipelines } from './prompt-store.js';
import { getDefaultPrompts } from './default-prompts.js';
import { getSettings, setSettings, listConnectionProfiles } from '../tree-store.js';
import { attachTextareaFullscreen } from '../../textarea-fullscreen.js';

const DEFAULT_PIPELINE_MAX_TOKENS = 64000;

const EDITOR_HTML = `
<div id="pathfinder-prompt-editor" class="pathfinder-prompt-editor">
    <div class="prompt-editor-header">
        <h4>Pipeline Prompts</h4>
        <div class="prompt-editor-controls">
            <select id="pf-prompt-selector" class="text_pole">
                <option value="">Select a prompt...</option>
            </select>
            <button id="pf-prompt-reset" class="menu_button" title="Reset to default">
                <i class="fa-solid fa-rotate-left"></i>
            </button>
        </div>
    </div>

    <div id="pf-prompt-fields" class="prompt-editor-fields" style="display: none;">
        <div class="prompt-field">
            <label for="pf-prompt-name">Name</label>
            <input type="text" id="pf-prompt-name" class="text_pole" />
        </div>

        <div class="prompt-field">
            <label for="pf-prompt-description">Description</label>
            <input type="text" id="pf-prompt-description" class="text_pole" />
        </div>

        <div class="prompt-field">
            <label for="pf-prompt-connection">Connection Profile</label>
            <select id="pf-prompt-connection" class="text_pole">
                <option value="">Use default</option>
            </select>
        </div>

        <div class="prompt-field">
            <label for="pf-prompt-system">System Prompt</label>
            <textarea id="pf-prompt-system" class="text_pole" rows="8"></textarea>
        </div>

        <div class="prompt-field">
            <label for="pf-prompt-user">User Prompt Template</label>
            <textarea id="pf-prompt-user" class="text_pole" rows="6"></textarea>
            <div class="prompt-help">
                Variables: <code>{{chat_history}}</code>, <code>{{entry_list}}</code>, <code>{{candidate_entries}}</code>
            </div>
        </div>

        <div class="prompt-field-row">
            <div class="prompt-field">
                <label for="pf-prompt-maxTokens">Max Tokens</label>
                <input type="number" id="pf-prompt-maxTokens" class="text_pole" min="100" max="200000" />
            </div>
            <div class="prompt-field">
                <label for="pf-prompt-temperature">Temperature</label>
                <input type="number" id="pf-prompt-temperature" class="text_pole" min="0" max="2" step="0.1" />
            </div>
            <div class="prompt-field">
                <label for="pf-prompt-outputFormat">Output Format</label>
                <select id="pf-prompt-outputFormat" class="text_pole">
                    <option value="json_object">JSON Object</option>
                    <option value="json_array">JSON Array</option>
                    <option value="text_lines">Text Lines</option>
                </select>
            </div>
        </div>

        <div class="prompt-editor-actions">
            <button id="pf-prompt-save" class="menu_button">
                <i class="fa-solid fa-save"></i> <span>Save</span>
            </button>
            <span id="pf-prompt-status" class="prompt-status"></span>
        </div>
    </div>

    <hr class="sysHR" />

    <div class="pipeline-settings-header">
        <h4>Pipeline Settings</h4>
    </div>

    <div class="pipeline-settings-fields">
        <div class="prompt-field">
            <label class="checkbox_label">
                <input type="checkbox" id="pf-pipeline-enabled" />
                <span>Enable Predictive Pipeline</span>
            </label>
            <div class="prompt-help">Use multi-stage LLM pipeline for lorebook retrieval instead of keyword matching</div>
        </div>

        <div class="prompt-field">
            <label for="pf-pipeline-id">Pipeline</label>
            <select id="pf-pipeline-id" class="text_pole">
                <option value="default">Two-Stage Predictive Retrieval</option>
                <option value="single-pass">Single-Pass Selection</option>
            </select>
        </div>

        <div class="prompt-field-row">
            <div class="prompt-field">
                <label for="pf-entry-content-mode">Entry Content Mode</label>
                <select id="pf-entry-content-mode" class="text_pole">
                    <option value="full">Full Content</option>
                    <option value="truncated">Truncated</option>
                </select>
            </div>
            <div class="prompt-field">
                <label for="pf-truncate-length">Truncate Length</label>
                <input type="number" id="pf-truncate-length" class="text_pole" min="100" max="2000" />
            </div>
            <div class="prompt-field">
                <label for="pf-max-candidates">Max Candidates</label>
                <input type="number" id="pf-max-candidates" class="text_pole" min="5" max="50" />
            </div>
        </div>
    </div>
</div>
`;

const EDITOR_CSS = `
<style>
.pathfinder-prompt-editor {
    padding: 10px 0;
}

.prompt-editor-header,
.pipeline-settings-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 10px;
}

.prompt-editor-header h4,
.pipeline-settings-header h4 {
    margin: 0;
    font-size: 14px;
    font-weight: 600;
}

.prompt-editor-controls {
    display: flex;
    gap: 5px;
    align-items: center;
}

.prompt-editor-controls select {
    min-width: 200px;
}

.prompt-editor-fields,
.pipeline-settings-fields {
    display: flex;
    flex-direction: column;
    gap: 12px;
}

.prompt-field {
    display: flex;
    flex-direction: column;
    gap: 4px;
}

.prompt-field label {
    font-size: 12px;
    font-weight: 500;
    color: var(--SmartThemeCSSBody, #888);
}

.prompt-field textarea {
    font-family: monospace;
    font-size: 12px;
    resize: vertical;
}

.prompt-field-row {
    display: flex;
    gap: 10px;
}

.prompt-field-row .prompt-field {
    flex: 1;
}

.prompt-help {
    font-size: 11px;
    color: var(--SmartThemeCSSBody, #666);
    margin-top: 2px;
}

.prompt-help code {
    background: var(--SmartThemeBlurTintColor, rgba(0,0,0,0.2));
    padding: 1px 4px;
    border-radius: 3px;
    font-size: 10px;
}

.prompt-editor-actions {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-top: 5px;
}

.prompt-status {
    font-size: 12px;
    color: var(--SmartThemeColorQuote, #888);
}

.prompt-status.success {
    color: var(--SmartThemeColorQuote, #4caf50);
}

.prompt-status.error {
    color: var(--SmartThemeColorError, #f44336);
}

.pathfinder-prompt-editor .checkbox_label {
    display: flex;
    align-items: center;
    gap: 8px;
    cursor: pointer;
}

.pathfinder-prompt-editor .checkbox_label input[type="checkbox"] {
    margin: 0;
}
</style>
`;

let currentPromptId = null;
let isInitialized = false;

/**
 * Initialize the prompt editor UI
 * @param {HTMLElement} container - Container to inject the editor into
 */
export function initPromptEditorUI(container) {
    if (isInitialized) return;

    // Inject CSS
    if (!document.getElementById('pf-prompt-editor-styles')) {
        const styleEl = document.createElement('div');
        styleEl.id = 'pf-prompt-editor-styles';
        styleEl.innerHTML = EDITOR_CSS;
        document.head.appendChild(styleEl.firstElementChild);
    }

    // Inject HTML
    container.innerHTML = EDITOR_HTML;
    attachTextareaFullscreen(container);

    // Bind events
    bindEditorEvents();
    populatePromptSelector();
    populatePipelineSelector();
    populateConnectionProfiles();
    loadPipelineSettings();

    isInitialized = true;
}

function bindEditorEvents() {
    // Prompt selector
    document.getElementById('pf-prompt-selector')?.addEventListener('change', (e) => {
        const promptId = e.target.value;
        if (promptId) {
            loadPromptIntoEditor(promptId);
        } else {
            hidePromptFields();
        }
    });

    // Reset button
    document.getElementById('pf-prompt-reset')?.addEventListener('click', resetCurrentPrompt);

    // Save button
    document.getElementById('pf-prompt-save')?.addEventListener('click', saveCurrentPrompt);

    // Pipeline settings
    document.getElementById('pf-pipeline-enabled')?.addEventListener('change', savePipelineSettings);
    document.getElementById('pf-pipeline-id')?.addEventListener('change', savePipelineSettings);
    document.getElementById('pf-entry-content-mode')?.addEventListener('change', savePipelineSettings);
    document.getElementById('pf-truncate-length')?.addEventListener('change', savePipelineSettings);
    document.getElementById('pf-max-candidates')?.addEventListener('change', savePipelineSettings);
}

function populatePromptSelector() {
    const selector = document.getElementById('pf-prompt-selector');
    if (!selector) return;

    const prompts = getAllPrompts();
    selector.innerHTML = '<option value="">Select a prompt...</option>';

    for (const [id, prompt] of prompts) {
        const option = document.createElement('option');
        option.value = id;
        option.textContent = prompt.name;
        if (isPromptModified(id, getDefaultPrompts()[id])) {
            option.textContent += ' (modified)';
        }
        selector.appendChild(option);
    }
}

function populatePipelineSelector() {
    const selector = document.getElementById('pf-pipeline-id');
    if (!selector) return;

    const pipelines = getAllPipelines();
    selector.innerHTML = '';

    for (const [id, pipeline] of pipelines) {
        const option = document.createElement('option');
        option.value = id;
        option.textContent = pipeline.name;
        selector.appendChild(option);
    }
}

function populateConnectionProfiles() {
    const selector = document.getElementById('pf-prompt-connection');
    if (!selector) return;

    const profiles = listConnectionProfiles();
    selector.innerHTML = '<option value="">Use default</option>';

    for (const profile of profiles) {
        const option = document.createElement('option');
        option.value = profile.id;
        option.textContent = profile.name || profile.id;
        selector.appendChild(option);
    }
}

function loadPromptIntoEditor(promptId) {
    const prompt = getPrompt(promptId);
    if (!prompt) return;

    currentPromptId = promptId;

    document.getElementById('pf-prompt-name').value = prompt.name || '';
    document.getElementById('pf-prompt-description').value = prompt.description || '';
    document.getElementById('pf-prompt-connection').value = prompt.connectionProfile || '';
    document.getElementById('pf-prompt-system').value = prompt.systemPrompt || '';
    document.getElementById('pf-prompt-user').value = prompt.userPromptTemplate || '';
    document.getElementById('pf-prompt-maxTokens').value = prompt.settings?.maxTokens ?? DEFAULT_PIPELINE_MAX_TOKENS;
    document.getElementById('pf-prompt-temperature').value = prompt.settings?.temperature ?? 0.3;
    document.getElementById('pf-prompt-outputFormat').value = prompt.outputFormat || 'json_object';

    showPromptFields();
    clearStatus();
}

function showPromptFields() {
    const fields = document.getElementById('pf-prompt-fields');
    if (fields) fields.style.display = 'flex';
}

function hidePromptFields() {
    const fields = document.getElementById('pf-prompt-fields');
    if (fields) fields.style.display = 'none';
    currentPromptId = null;
}

function saveCurrentPrompt() {
    if (!currentPromptId) return;

    const prompt = getPrompt(currentPromptId);
    if (!prompt) return;

    const updated = {
        ...prompt,
        name: document.getElementById('pf-prompt-name').value.trim(),
        description: document.getElementById('pf-prompt-description').value.trim(),
        connectionProfile: document.getElementById('pf-prompt-connection').value,
        systemPrompt: document.getElementById('pf-prompt-system').value,
        userPromptTemplate: document.getElementById('pf-prompt-user').value,
        outputFormat: document.getElementById('pf-prompt-outputFormat').value,
        settings: {
            maxTokens: parseInt(document.getElementById('pf-prompt-maxTokens').value) || DEFAULT_PIPELINE_MAX_TOKENS,
            temperature: parseFloat(document.getElementById('pf-prompt-temperature').value) || 0.3,
        },
    };

    savePrompt(updated);
    populatePromptSelector();
    document.getElementById('pf-prompt-selector').value = currentPromptId;
    showStatus('Saved!', 'success');
}

function resetCurrentPrompt() {
    if (!currentPromptId) return;

    const defaults = getDefaultPrompts();
    const defaultPrompt = defaults[currentPromptId];

    if (!defaultPrompt) {
        showStatus('No default available', 'error');
        return;
    }

    savePrompt({ ...defaultPrompt, isDefault: true });
    loadPromptIntoEditor(currentPromptId);
    populatePromptSelector();
    document.getElementById('pf-prompt-selector').value = currentPromptId;
    showStatus('Reset to default', 'success');
}

function loadPipelineSettings() {
    const s = getSettings();

    const pipelineEnabled = document.getElementById('pf-pipeline-enabled');
    const pipelineId = document.getElementById('pf-pipeline-id');
    const entryContentMode = document.getElementById('pf-entry-content-mode');
    const truncateLength = document.getElementById('pf-truncate-length');
    const maxCandidates = document.getElementById('pf-max-candidates');

    if (pipelineEnabled) pipelineEnabled.checked = s.pipelineEnabled ?? false;
    if (pipelineId) pipelineId.value = s.pipelineId ?? 'default';
    if (entryContentMode) entryContentMode.value = s.entryContentMode ?? 'full';
    if (truncateLength) truncateLength.value = s.truncateLength ?? 500;
    if (maxCandidates) maxCandidates.value = s.maxCandidates ?? 20;
}

function savePipelineSettings() {
    const s = getSettings();

    s.pipelineEnabled = document.getElementById('pf-pipeline-enabled')?.checked ?? false;
    s.pipelineId = document.getElementById('pf-pipeline-id')?.value ?? 'default';
    s.entryContentMode = document.getElementById('pf-entry-content-mode')?.value ?? 'full';
    s.truncateLength = parseInt(document.getElementById('pf-truncate-length')?.value) || 500;
    s.maxCandidates = parseInt(document.getElementById('pf-max-candidates')?.value) || 20;

    setSettings(s);

    const context = window?.SillyTavern?.getContext?.();
    if (context?.saveSettingsDebounced) {
        context.saveSettingsDebounced();
    }
}

function showStatus(message, type = '') {
    const status = document.getElementById('pf-prompt-status');
    if (status) {
        status.textContent = message;
        status.className = 'prompt-status ' + type;
        setTimeout(() => {
            status.textContent = '';
            status.className = 'prompt-status';
        }, 3000);
    }
}

function clearStatus() {
    const status = document.getElementById('pf-prompt-status');
    if (status) {
        status.textContent = '';
        status.className = 'prompt-status';
    }
}

/**
 * Refresh the editor UI (call when settings change externally)
 */
export function refreshPromptEditorUI() {
    if (!isInitialized) return;
    populatePromptSelector();
    populatePipelineSelector();
    populateConnectionProfiles();
    loadPipelineSettings();
    if (currentPromptId) {
        loadPromptIntoEditor(currentPromptId);
    }
}
