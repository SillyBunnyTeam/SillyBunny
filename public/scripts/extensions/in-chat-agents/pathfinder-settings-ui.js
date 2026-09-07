/**
 * Pathfinder Settings UI - Idiot-proof settings panel for Pathfinder
 */

import { renderExtensionTemplateAsync, getContext } from '../../extensions.js';
import { eventSource, event_types, online_status } from '../../../script.js';
import { accountStorage } from '../../util/AccountStorage.js';
import { escapeHtml } from '../../utils.js';
import { attachTextareaFullscreen } from './textarea-fullscreen.js';
import { world_names } from '../../world-info.js';
import { areAgentsGloballyEnabled, getActiveAgentChatScope, getAgentById, getGlobalSettings, isAgentEnabledForCurrentScope, isPathfinderSubmoduleEnabled, persistAgentGlobalSettings, saveAgent, setAgentEnabledForScope } from './agent-store.js';
import { runDiagnostics } from './pathfinder-init.js';
import {
    SETTING_DEFAULTS,
    replaceSettings,
    listConnectionProfiles,
    normalizeAutoSummaryInterval,
    canReadBook,
    canWriteBook,
    canDeleteBook,
} from './pathfinder/tree-store.js';
import { getAgentGenerationContext, getAgentGenerationCancelRevision, getPathfinderRuntimeAgent, isAgentGenerationStopped, isPathfinderToolEnabledForAgent, onAgentGenerationStateChanged, syncToolAgentRegistrations } from './agent-runner.js';
import { ALL_TOOL_NAMES, CONFIRMABLE_TOOLS, getActiveTunnelVisionBooks, getReadableBooks, getWritableBooks, getContextualLorebookDetails, resolveTargetBook } from './pathfinder/pathfinder-tool-bridge.js';
import { initializePromptStore } from './pathfinder/prompts/prompt-store.js';
import { getDefaultPrompts, getDefaultPipelines } from './pathfinder/prompts/default-prompts.js';
import { populateConnectionProfileSelect } from './profile-utils.js';
import { clearFeed, getFeedItems } from './pathfinder/activity-feed.js';
import { getSummaryMemoryState, onSummaryMemoryChanged, saveSummaryMemoryContent } from './pathfinder/summary-memory-store.js';
import { sidecarGenerate } from './pathfinder/llm-sidecar.js';
import { createSeparateSummaryMemoryEntry, createSummaryMemoryEntry, deriveSummaryLorebookTitle } from './pathfinder/tools/summarize.js';

const MODULE_NAME = 'in-chat-agents';
const PATHFINDER_LOG_PREFIX = '[Pathfinder]';
const PATHFINDER_LOG_MODE_KEY = 'pathfinder-retrieval-log-mode';
const PATHFINDER_QUICKSTART_DISMISSED_KEY = 'pathfinder-quickstart-dismissed';
const PATHFINDER_COLLAPSED_SECTIONS_KEY = 'pathfinder-collapsed-sections';
const DEFAULT_PIPELINE_MAX_TOKENS = 64000;

let settingsEl = null;
let currentAgent = null;
let settingsSession = null;
let settingsOpenRevision = 0;
let retrievalLogMode = safeGetAccountStorageItem(PATHFINDER_LOG_MODE_KEY) === 'detailed' ? 'detailed' : 'summary';

export function cancelPathfinderSummary() {
    settingsSession?.summaryController?.abort();
}

export function closePathfinderSettings(panel = settingsEl) {
    if (panel !== settingsEl) return;
    settingsOpenRevision++;
    settingsSession?.summaryController?.abort();
    settingsSession?.cleanup.forEach(dispose => dispose());
    settingsEl?.off().find('*').off();
    settingsEl?.find('input, button, select, textarea').prop('disabled', true);
    settingsSession = null;
    settingsEl = null;
    currentAgent = null;
}

export async function canClosePathfinderSettings(panel) {
    const session = settingsSession;
    if (session?.element !== panel) return true;
    const hadPendingSave = session.pending > 0;
    cancelPathfinderSummary();
    await agentSettingsSaveChain;
    // A newly failed save stays visible for retry; a subsequent Close must still work offline.
    return settingsSession !== session || (session.pending === 0
        && (!hadPendingSave || (session.dirtySettings.size === 0 && session.enabledChange === undefined)));
}

export function refreshPathfinderSettings() {
    if (!settingsSession) return;
    const saved = getAgentById(currentAgent.id);
    if (!saved) return;
    const edits = Object.fromEntries([...settingsSession.dirtySettings].map(key => [key, currentAgent.settings[key]]));
    currentAgent.settings = structuredClone({ ...SETTING_DEFAULTS, ...saved.settings, ...edits });
    if (!settingsSession.dirtySettings.has('toolStates')) currentAgent.tools = structuredClone(saved.tools ?? []);
    refreshLorebookList();
    updateModeCardStates();
    updateStatusBanner();
}

function safeGetAccountStorageItem(key) {
    try {
        return accountStorage.getItem(key);
    } catch {
        return null;
    }
}

function safeSetAccountStorageItem(key, value) {
    try {
        accountStorage.setItem(key, value);
    } catch {
        // Persistence failures must not break the settings panel.
    }
}

function isQuickstartDismissed() {
    return safeGetAccountStorageItem(PATHFINDER_QUICKSTART_DISMISSED_KEY) === 'true';
}

function applyQuickstartDismissalState() {
    if (isQuickstartDismissed()) {
        settingsEl.find('#pf--quickstart').hide();
    }
}

function getCollapsedSectionStates() {
    const rawValue = safeGetAccountStorageItem(PATHFINDER_COLLAPSED_SECTIONS_KEY);
    if (!rawValue) {
        return {};
    }

    try {
        const parsed = JSON.parse(rawValue);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch (err) {
        console.warn(`${PATHFINDER_LOG_PREFIX} Failed to read Pathfinder collapsed section preferences.`, err);
        return {};
    }
}

function getCollapseSectionKey(section) {
    const sectionId = section.attr('id');
    if (sectionId) {
        return sectionId;
    }

    return section.children('.pf--collapsible-header').first().find('strong').first().text().trim();
}

function setSectionCollapsedPreference(sectionKey, collapsed) {
    if (!sectionKey) {
        return;
    }

    const states = getCollapsedSectionStates();
    states[sectionKey] = collapsed;
    safeSetAccountStorageItem(PATHFINDER_COLLAPSED_SECTIONS_KEY, JSON.stringify(states));
}

function setSectionChevronState(section, collapsed) {
    const header = section.children('.pf--collapsible-header').first();
    const chevron = header.find('.pf--chevron').first();
    header.attr('aria-expanded', String(!collapsed));
    chevron.toggleClass('fa-chevron-down', !collapsed);
    chevron.toggleClass('fa-chevron-right', collapsed);
}

function applyPersistedCollapseStates() {
    const states = getCollapsedSectionStates();

    settingsEl.find('.pf--section-collapsible').each(function () {
        const section = $(this);
        const sectionKey = getCollapseSectionKey(section);
        const collapsed = Object.hasOwn(states, sectionKey)
            ? states[sectionKey] === true
            : section.children('.pf--collapsible-header').attr('aria-expanded') === 'false';
        section.children('.pf--section-body').first().toggle(!collapsed);
        setSectionChevronState(section, collapsed);
    });
}

function ensureEnabledLorebooks(settings) {
    if (!Array.isArray(settings.enabledLorebooks)) {
        settings.enabledLorebooks = [];
    }

    return settings.enabledLorebooks;
}

function getEffectiveLorebooks(lorebooks, settings) {
    const allBooks = Array.isArray(lorebooks) ? lorebooks : [];
    const booksByName = new Map(allBooks.map(book => [book.name, book]));

    for (const source of getContextualLorebookDetails()) {
        if (!source.name || booksByName.has(source.name)) {
            continue;
        }

        const sourceTypes = Array.isArray(source.types) ? new Set(source.types) : new Set([source.type || 'attached']);
        booksByName.set(source.name, {
            name: source.name,
            attached: true,
            sourceTypes,
            type: formatLorebookSourceLabel(sourceTypes),
        });
    }

    return getActiveTunnelVisionBooks(settings)
        .map(name => booksByName.get(name) ?? { name, attached: false, type: 'lorebook' })
        .filter(book => book?.name);
}

export function normalizeSummaryIntervalInput(value) {
    return normalizeAutoSummaryInterval(value);
}

function formatLorebookSourceLabel(sourceTypes) {
    const orderedTypes = ['character', 'group', 'chat', 'persona', 'attached', 'global'];
    const labels = orderedTypes.filter(type => sourceTypes.has(type));
    return labels.join(', ') || 'global';
}

function upsertLorebook(lorebooksByName, name, data = {}) {
    if (!name) {
        return;
    }

    const book = lorebooksByName.get(name) ?? {
        name,
        attached: false,
        sourceTypes: new Set(),
    };

    if (data.type) {
        book.sourceTypes.add(data.type);
        if (data.type !== 'global') {
            book.attached = true;
        }
    }

    lorebooksByName.set(name, book);
}

/**
 * Opens the Pathfinder settings panel
 * @param {Object} agent - The Pathfinder agent object
 */
export async function openPathfinderSettings(agent) {
    if (!isPathfinderSubmoduleEnabled()) {
        toastr.warning('Pathfinder is disabled in In-Chat Agents settings.');
        return null;
    }

    closePathfinderSettings();
    const openRevision = settingsOpenRevision;
    const html = await renderExtensionTemplateAsync(MODULE_NAME, 'pathfinder-settings');
    if (openRevision !== settingsOpenRevision || !isPathfinderSubmoduleEnabled()) return null;
    if (!html) {
        toastr.error('Could not load Pathfinder settings.');
        return null;
    }

    settingsEl = $(html);
    currentAgent = structuredClone(getAgentById(agent.id) ?? agent);
    currentAgent.settings = structuredClone({ ...SETTING_DEFAULTS, ...currentAgent.settings });
    const session = settingsSession = {
        element: settingsEl,
        agent: currentAgent,
        revision: 0,
        contextRevision: 0,
        pending: 0,
        dirtySettings: new Set(),
        cleanup: [],
        summaryDraft: null,
        summaryBusy: false,
        summaryController: null,
    };
    session.cleanup.push(onSummaryMemoryChanged(() => {
        if (settingsSession === session) renderSummaryMemoryEditor();
    }));
    session.cleanup.push(onAgentGenerationStateChanged(refreshPathfinderSettings));
    const refreshContext = () => {
        session.summaryController?.abort();
        // A chat switch invalidates queued edits; the runner owns auto-sync.
        session.contextRevision++;
        session.dirtySettings.clear();
        session.enabledChange = undefined;
        session.element.find('#pf--settings-save-status').text('');
        session.element.find('#pf--settings-retry').hide();
        refreshPathfinderSettings();
        loadSettingsIntoUI();
    };
    eventSource.on(event_types.CHAT_CHANGED, refreshContext);
    session.cleanup.push(() => eventSource.removeListener(event_types.CHAT_CHANGED, refreshContext));
    const refreshStatus = () => {
        updateStatusBanner();
        populateConnectionProfiles();
    };
    for (const event of [
        event_types.SETTINGS_UPDATED,
        event_types.MAIN_API_CHANGED,
        event_types.ONLINE_STATUS_CHANGED,
        event_types.CHATCOMPLETION_SOURCE_CHANGED,
        event_types.CHATCOMPLETION_MODEL_CHANGED,
        event_types.OAI_PRESET_CHANGED_AFTER,
        event_types.GENERATION_ENDED,
        event_types.GENERATION_STOPPED,
        event_types.CONNECTION_PROFILE_LOADED,
        event_types.CONNECTION_PROFILE_CREATED,
        event_types.CONNECTION_PROFILE_UPDATED,
        event_types.CONNECTION_PROFILE_DELETED,
    ].filter(Boolean)) {
        eventSource.on(event, refreshStatus);
        session.cleanup.push(() => eventSource.removeListener(event, refreshStatus));
    }

    // Initialize UI
    refreshLorebookList();
    applyQuickstartDismissalState();
    loadSettingsIntoUI();
    applyPersistedCollapseStates();
    bindEvents();
    settingsEl.find('#pf--log-mode').val(retrievalLogMode);
    updateStatusBanner();
    updateModeCardStates();
    renderRetrievalLog();
    renderSummaryMemoryEditor();
    attachTextareaFullscreen(settingsEl);

    return settingsEl;
}

/**
 * Get available lorebooks from current context
 */
function getAvailableLorebooks() {
    const ctx = getContext();
    if (!ctx && !globalThis.window?.SillyTavern?.getContext?.() && (!Array.isArray(world_names) || world_names.length === 0)) {
        console.warn(`${PATHFINDER_LOG_PREFIX} Could not resolve the current context while gathering lorebooks.`);
        return [];
    }

    const lorebooksByName = new Map();

    // Counts and waypoint builds belong to retrieval, not opening settings.
    for (const name of world_names ?? []) {
        upsertLorebook(lorebooksByName, name, { type: 'global' });
    }

    for (const source of getContextualLorebookDetails()) {
        upsertLorebook(lorebooksByName, source.name, { type: source.type || 'attached' });
        const book = lorebooksByName.get(source.name);
        if (book && Array.isArray(source.types)) {
            for (const type of source.types) {
                book.sourceTypes.add(type);
            }
        }
    }

    for (const name of ensureEnabledLorebooks(currentAgent.settings)) {
        upsertLorebook(lorebooksByName, name);
    }

    const lorebooks = Array.from(lorebooksByName.values()).map(book => ({
        ...book,
        type: formatLorebookSourceLabel(book.sourceTypes),
    }));

    return lorebooks;
}

/**
 * Refresh the lorebook list in the UI
 */
function refreshLorebookList() {
    const listEl = settingsEl.find('#pf--lorebook-list');
    listEl.empty();

    const lorebooks = getAvailableLorebooks();
    const settings = currentAgent.settings;
    ensureEnabledLorebooks(settings);
    const enabledBooks = getActiveTunnelVisionBooks(settings);

    if (lorebooks.length === 0) {
        listEl.html(`
            <div class="pf--empty-state">
                <i class="fa-solid fa-book-open"></i>
                <span>No lorebooks found. Create a lorebook in World Info first.</span>
            </div>
        `);
        renderPermissionMatrix([]);
        return;
    }

    for (const [index, book] of lorebooks.entries()) {
        const isEnabled = enabledBooks.includes(book.name);
        const item = $(`
            <label class="pf--lorebook-item ${isEnabled ? 'selected' : ''}" data-book="${escapeHtml(book.name)}">
                <input type="checkbox" aria-labelledby="pf--lorebook-name-${index}" ${isEnabled ? 'checked' : ''} />
                <span class="pf--lorebook-info">
                    <span class="pf--lorebook-name" id="pf--lorebook-name-${index}">${escapeHtml(book.name)}</span>
                    <span class="pf--lorebook-meta">${escapeHtml(book.type)}</span>
                </span>
            </label>
        `);

        listEl.append(item);
    }

    renderPermissionMatrix(lorebooks);
}


function setPathfinderToolEnabled(toolName, enabled) {
    if (!currentAgent) {
        return;
    }

    if (!currentAgent.settings || typeof currentAgent.settings !== 'object') {
        currentAgent.settings = {};
    }
    currentAgent.settings.toolStates = {
        ...(currentAgent.settings.toolStates || {}),
        [toolName]: Boolean(enabled),
    };

    if (!Array.isArray(currentAgent.tools)) {
        currentAgent.tools = [];
    }

    const tool = currentAgent.tools.find(t => t.name === toolName);
    if (tool) {
        tool.enabled = enabled;
    }
}

function isPathfinderToolEnabled(toolName) {
    return isPathfinderToolEnabledForAgent(currentAgent, toolName);
}

function getToolLabel(toolName) {
    switch (toolName) {
        case 'Pathfinder_Search': return 'Search - Browse waypoint map';
        case 'Pathfinder_Remember': return 'Remember - Create new entries';
        case 'Pathfinder_Update': return 'Update - Edit existing entries';
        case 'Pathfinder_Forget': return 'Forget - Disable/delete entries';
        case 'Pathfinder_Summarize': return 'Summarize - Write memory summaries';
        case 'Pathfinder_Reorganize': return 'Reorganize - Move entries and waypoints';
        case 'Pathfinder_MergeSplit': return 'Merge/Split - Combine or divide entries';
        case 'Pathfinder_Notebook': return 'Notebook - Private AI scratchpad';
        default: return toolName;
    }
}

function renderToolToggles() {
    const toolList = settingsEl.find('.pf--tool-list:not(#pf--confirm-tool-list)');
    if (!toolList.length) {
        return;
    }

    toolList.empty();
    for (const toolName of ALL_TOOL_NAMES) {
        if (toolName === 'Pathfinder_Summarize') {
            continue;
        }

        const item = $(`
            <label class="checkbox_label">
                <input type="checkbox" data-tool="${escapeHtml(toolName)}" />
                <span>${escapeHtml(getToolLabel(toolName))}</span>
            </label>
        `);
        item.find('input').prop('checked', isPathfinderToolEnabled(toolName));
        toolList.append(item);
    }
}

function renderConfirmToggles() {
    const confirmList = settingsEl.find('#pf--confirm-tool-list');
    if (!confirmList.length) {
        return;
    }

    const confirmTools = currentAgent.settings.confirmTools ?? {};
    confirmList.empty();
    for (const toolName of ALL_TOOL_NAMES) {
        if (!CONFIRMABLE_TOOLS.has(toolName)) {
            continue;
        }

        const item = $(`
            <label class="checkbox_label">
                <input type="checkbox" data-confirm-tool="${escapeHtml(toolName)}" />
                <span>${escapeHtml(getToolLabel(toolName))}</span>
            </label>
        `);
        item.find('input').prop('checked', confirmTools[toolName] === true);
        confirmList.append(item);
    }
}

function renderPermissionMatrix(lorebooks = null) {
    const matrix = settingsEl.find('#pf--permission-matrix');
    if (!matrix.length) {
        return;
    }

    const settings = currentAgent.settings;
    const books = getEffectiveLorebooks(lorebooks, settings);

    if (books.length === 0) {
        matrix.html('<div class="pf--empty-state pf--permission-empty"><i class="fa-solid fa-lock-open"></i><span>Select a lorebook above, or attach one to the current character/chat with auto-select enabled.</span></div>');
        return;
    }

    const rows = books.map((book, index) => `
        <div class="pf--permission-row" data-book="${escapeHtml(book.name)}" role="group" aria-labelledby="pf--permission-book-${index}">
            <div class="pf--permission-book">
                <strong id="pf--permission-book-${index}">${escapeHtml(book.name)}</strong>
                <span>${escapeHtml(book.type || 'lorebook')}</span>
            </div>
            <label class="checkbox_label"><input type="checkbox" data-permission="read" aria-labelledby="pf--permission-book-${index} pf--permission-read-${index}" ${canReadBook(book.name, settings) ? 'checked' : ''} /><span id="pf--permission-read-${index}">Read</span></label>
            <label class="checkbox_label"><input type="checkbox" data-permission="write" aria-labelledby="pf--permission-book-${index} pf--permission-write-${index}" ${canWriteBook(book.name, settings) ? 'checked' : ''} /><span id="pf--permission-write-${index}">Write</span></label>
            <label class="checkbox_label"><input type="checkbox" data-permission="delete" aria-labelledby="pf--permission-book-${index} pf--permission-delete-${index}" ${canDeleteBook(book.name, settings) ? 'checked' : ''} /><span id="pf--permission-delete-${index}">Delete</span></label>
        </div>
    `).join('');

    matrix.html(rows);
}

function readPromptMaxTokens() {
    const value = parseInt(settingsEl.find('#pf--prompt-max-tokens').val(), 10) || DEFAULT_PIPELINE_MAX_TOKENS;
    return Math.min(200000, Math.max(100, value));
}

/**
 * Load current settings into UI elements
 */
function loadSettingsIntoUI() {
    const s = currentAgent.settings;

    settingsEl.find('#pf--master-enable').prop('checked', settingsSession.enabledChange ?? isAgentEnabledForCurrentScope(getAgentById(currentAgent.id) ?? currentAgent));

    // Pipeline settings
    settingsEl.find('#pf--enable-pipeline').prop('checked', s.pipelineEnabled || false);
    settingsEl.find('#pf--pipeline-type').val(s.pipelineId || 'default');
    settingsEl.find('#pf--content-mode').val(s.entryContentMode || 'full');
    settingsEl.find('#pf--truncate-length').val(s.truncateLength || 500);
    settingsEl.find('#pf--max-candidates').val(s.maxCandidates || 20);
    settingsEl.find('#pf--retrieval-timeout').val(s.retrievalTimeoutSeconds || 8);

    // Tool settings
    settingsEl.find('#pf--enable-tools').prop('checked', s.sidecarEnabled || false);
    settingsEl.find('#pf--mandatory-tools').prop('checked', s.mandatoryTools || false);
    settingsEl.find('#pf--auto-use-attached').prop('checked', s.autoUseAttachedLorebook || false);
    settingsEl.find('#pf--auto-sync-lorebooks').prop('checked', s.autoSyncLorebooksOnChatChange !== false);
    settingsEl.find('#pf--include-contextual-lorebooks').prop('checked', s.includeContextualLorebooks !== false);
    settingsEl.find('#pf--dedupe-natural-activation').prop('checked', s.dedupeNaturalActivation !== false);
    settingsEl.find('#pf--auto-summary').prop('checked', s.autoSummary || false);
    settingsEl.find('#pf--auto-summary-interval').val(s.autoSummaryInterval ?? 20);

    settingsEl.find('#pf--enable-summarize-tool').prop('checked', isPathfinderToolEnabled('Pathfinder_Summarize'));

    // Populate connection profiles
    populateConnectionProfiles();

    // Load tool states from agent
    renderToolToggles();
    renderConfirmToggles();
    settingsEl.find('input[data-tool]').each(function () {
        const toolName = $(this).data('tool');
        $(this).prop('checked', isPathfinderToolEnabled(toolName));
    });
}

/**
 * Populate connection profile dropdowns
 */
function populateConnectionProfiles() {
    populateConnectionProfileSelect(settingsEl.find('#pf--pipeline-profile')[0], {
        emptyLabel: 'Use main model',
        selectedValue: currentAgent.settings.connectionProfile ?? '',
    });
}


function formatSummaryTimestamp(timestamp) {
    if (!timestamp) {
        return '';
    }

    return new Date(timestamp).toLocaleString();
}

function renderSummaryMemoryEditor() {
    if (!settingsEl) {
        return;
    }

    const summary = getSummaryMemoryState();
    const textarea = settingsEl.find('#pf--summary-content');
    const indicator = settingsEl.find('#pf--summary-injection-indicator');
    const meta = settingsEl.find('#pf--summary-meta');
    const hasSummary = Boolean(summary.content || summary.uid !== null || settingsSession.summaryDraft);
    const draft = settingsSession.summaryDraft;
    const currentContent = String(draft?.content ?? summary.content ?? '').trim();

    if (!draft) {
        textarea.val(summary.content ?? '');
    }

    textarea.prop('disabled', !hasSummary);
    const busy = settingsSession.summaryBusy || settingsSession.pending > 0;
    settingsEl.find('#pf--summary-save').prop('disabled', !hasSummary || busy);
    settingsEl.find('#pf--summary-save-entry').prop('disabled', !currentContent || busy);
    settingsEl.find('#pf--summary-create').toggle(!hasSummary).prop('disabled', hasSummary || busy);

    indicator.removeClass('pf--summary-indicator-missing pf--summary-indicator-not-injected pf--summary-indicator-injected');
    if (!hasSummary) {
        indicator.addClass('pf--summary-indicator-missing').text('No summary');
        meta.text('No Pathfinder summary has been created yet.');
        return;
    }

    const isInjected = summary.injectedAt && summary.injectedAt >= summary.updatedAt;
    if (isInjected) {
        indicator.addClass('pf--summary-indicator-injected').text('Injected');
    } else {
        indicator.addClass('pf--summary-indicator-not-injected').text('Not injected');
    }

    const title = summary.title || 'Untitled summary';
    const location = summary.bookName && summary.uid !== null ? `${summary.bookName} / UID ${summary.uid}` : 'not linked to a lorebook entry';
    const updated = summary.updatedAt ? `Updated ${formatSummaryTimestamp(summary.updatedAt)}` : 'Not saved yet';
    const injected = summary.injectedAt ? `Last injected ${formatSummaryTimestamp(summary.injectedAt)}${summary.injectedMode ? ` via ${summary.injectedMode}` : ''}` : 'Not injected by retrieval yet';
    meta.text(`${title} - ${location}. ${updated}. ${injected}.`);
}

function getSummaryEditorDraft() {
    const summary = settingsSession.summaryDraft?.source ?? getSummaryMemoryState();
    const content = String(settingsEl.find('#pf--summary-content').val() ?? '').trim();
    return {
        title: deriveSummaryLorebookTitle({
            title: summary.title,
            content,
            arc: summary.arc,
        }),
        content,
        significance: summary.significance || 'medium',
        arc: summary.arc || '',
        book: summary.bookName || currentAgent.settings.selectedLorebook || '',
    };
}

function assertSummarySource(expected) {
    const current = getSummaryMemoryState();
    if (['bookName', 'uid', 'title', 'content'].some(key => expected[key] !== current[key])) {
        throw new Error('The summary or its linked entry changed while the user was editing. Saves are blocked to prevent overwriting.');
    }
    return current;
}

function getRecentChatForSummary(maxMessages = 24) {
    const ctx = getContext();
    const messages = Array.isArray(ctx?.chat) ? ctx.chat : [];

    return messages
        .filter(message => message && !message.is_system && String(message.mes ?? '').trim())
        .slice(-maxMessages)
        .map(message => {
            const name = message.is_user ? 'User' : (String(message.name ?? '').trim() || 'Assistant');
            return `${name}: ${String(message.mes ?? '').trim()}`;
        })
        .join('\n\n');
}

function extractJsonObject(text) {
    const raw = String(text ?? '').trim();
    if (!raw) {
        return null;
    }

    try {
        return JSON.parse(raw);
    } catch {
        const match = raw.match(/\{[\s\S]*\}/);
        if (!match) {
            return null;
        }

        try {
            return JSON.parse(match[0]);
        } catch {
            return null;
        }
    }
}

function parseGeneratedSummary(rawSummary) {
    const parsed = extractJsonObject(rawSummary);
    if (parsed && typeof parsed === 'object') {
        return {
            title: String(parsed.title || 'Recent scene summary').trim(),
            content: String(parsed.content || '').trim(),
            significance: String(parsed.significance || 'medium').trim().toLowerCase(),
            arc: String(parsed.arc || '').trim(),
        };
    }

    return {
        title: 'Recent scene summary',
        content: String(rawSummary || '').trim(),
        significance: 'medium',
        arc: '',
    };
}

async function createManualSummaryMemory() {
    const session = settingsSession;
    const generation = getAgentGenerationContext();
    const alreadyStopped = isAgentGenerationStopped();
    const agentId = currentAgent.id;
    const agent = getAgentById(agentId) ?? currentAgent;
    const targetBook = resolveTargetBook(agent.settings?.selectedLorebook, getWritableBooks());
    if (!targetBook) throw new Error('No Pathfinder-enabled lorebooks available for writing.');
    const recentChat = getRecentChatForSummary();
    if (!recentChat) {
        throw new Error('No recent chat messages are available to summarize.');
    }

    const prompt = `Summarize the recent roleplay/chat into durable Pathfinder memory.

Return only a compact JSON object with this shape:
{"title":"short event title","content":"5-8 sentence useful memory summary","significance":"low|medium|high|critical","arc":"optional arc name"}

Recent chat:
${recentChat}`;

    const controller = session.summaryController = new AbortController();
    const isCurrent = () => {
        const liveAgent = getAgentById(agentId);
        const context = getAgentGenerationContext();
        return settingsSession === session && !controller.signal.aborted
            && generation.chatId === context.chatId && generation.runId === context.runId
            && generation.cancelRevision === getAgentGenerationCancelRevision()
            && (alreadyStopped || !isAgentGenerationStopped())
            && areAgentsGloballyEnabled() && isPathfinderSubmoduleEnabled()
            && liveAgent && isAgentEnabledForCurrentScope(liveAgent)
            && getPathfinderRuntimeAgent()?.id === agentId
            && getWritableBooks().includes(targetBook);
    };
    const checkCurrent = () => {
        if (!isCurrent()) controller.abort();
    };
    const unsubscribe = onAgentGenerationStateChanged(checkCurrent);
    session.cleanup.push(unsubscribe);
    try {
        checkCurrent();
        controller.signal.throwIfAborted();
        const rawSummary = await sidecarGenerate(
            prompt,
            'You create concise long-term memory summaries for creative roleplay. Preserve names, changed state, unresolved threads, and why the scene matters. Return valid JSON only.',
            controller.signal,
        );
        checkCurrent();
        controller.signal.throwIfAborted();
        const summary = parseGeneratedSummary(rawSummary);
        if (!summary.content) throw new Error('The sidecar model returned an empty summary.');

        return await createSummaryMemoryEntry({ ...summary, book: targetBook }, { signal: controller.signal, isCurrent });
    } finally {
        unsubscribe();
        session.cleanup = session.cleanup.filter(dispose => dispose !== unsubscribe);
        if (session.summaryController === controller) session.summaryController = null;
    }
}

/**
 * Bind all event handlers
 */
function bindEvents() {
    const session = settingsSession;
    const panel = settingsEl;
    // Autosave failures remain visible and retryable; explicit saves await rejection.
    const save = keys => updateAgentSettings(keys).catch(() => {});

    settingsEl.find('#pf--quickstart-dismiss').on('click', () => {
        safeSetAccountStorageItem(PATHFINDER_QUICKSTART_DISMISSED_KEY, 'true');
        settingsEl.find('#pf--quickstart').stop(true, true).slideUp(window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 180);
    });

    settingsEl.find('#pf--master-enable').on('change', function () {
        session.enabledChange = this.checked;
        if (!this.checked) cancelPathfinderSummary();
        return save();
    });

    settingsEl.find('#pf--settings-retry').on('click', () => save());

    settingsEl.find('#pf--refresh-lorebooks').on('click', () => {
        refreshPathfinderSettings();
        toastr.info('Lorebook list refreshed');
    });

    settingsEl.on('change', '[data-pf-setting]', function () {
        const key = this.dataset.pfSetting;
        let value = this.type === 'checkbox' ? this.checked : this.value;
        if (this.type === 'number') {
            value = key === 'autoSummaryInterval'
                ? normalizeSummaryIntervalInput(value)
                : Math.max(Number(this.min), Math.min(Number(this.max), parseInt(value, 10) || SETTING_DEFAULTS[key]));
            this.value = String(value);
        }
        currentAgent.settings[key] = value;
        const keys = [key];
        if (key === 'autoSummary' && value) {
            setPathfinderToolEnabled('Pathfinder_Summarize', true);
            settingsEl.find('#pf--enable-summarize-tool').prop('checked', true);
            keys.push('toolStates');
        }
        if (['autoUseAttachedLorebook', 'autoSyncLorebooksOnChatChange', 'includeContextualLorebooks'].includes(key)) {
            refreshLorebookList();
        }
        updateModeCardStates();
        return save(keys);
    });

    settingsEl.on('change', '#pf--lorebook-list input', function () {
        const item = $(this).closest('.pf--lorebook-item');
        const bookName = item.attr('data-book');
        const checked = this.checked;
        const s = currentAgent.settings;
        s.enabledLorebooks = ensureEnabledLorebooks(s).filter(name => name !== bookName);
        if (checked) s.enabledLorebooks.push(bookName);
        // Selection must not erase the user's independent permission choices.
        s.bookPermissions = { ...s.bookPermissions, [bookName]: { ...s.bookPermissions?.[bookName], enabled: checked } };
        if (!s.selectedLorebook || (!checked && s.selectedLorebook === bookName)) {
            s.selectedLorebook = getActiveTunnelVisionBooks(s)[0] ?? '';
        }
        item.toggleClass('selected', checked);
        renderPermissionMatrix(getAvailableLorebooks());
        return save(['enabledLorebooks', 'selectedLorebook', 'bookPermissions']);
    });

    settingsEl.find('#pf--summary-save').on('click', async () => {
        if (session.summaryBusy) return;
        const status = panel.find('#pf--summary-save-status');
        const draft = session.summaryDraft ?? { source: getSummaryMemoryState(), content: String(panel.find('#pf--summary-content').val() ?? '') };
        session.summaryDraft = draft;
        session.summaryBusy = true;
        renderSummaryMemoryEditor();
        try {
            const current = assertSummarySource(draft.source);
            if (current.bookName && !getWritableBooks().includes(current.bookName)) {
                throw new Error('No Pathfinder-enabled lorebooks available for writing.');
            }
            await saveSummaryMemoryContent(draft.content);
            if (settingsSession !== session) return;
            const committed = assertSummarySource({ ...draft.source, content: draft.content.trim() });
            if (session.summaryDraft === draft) session.summaryDraft = null;
            else session.summaryDraft.source = committed;
            status.text('Saved!').removeClass('error').addClass('success');
        } catch (err) {
            if (settingsSession !== session) return;
            status.text(`Save failed: ${err.message}`).removeClass('success').addClass('error');
        } finally {
            session.summaryBusy = false;
            if (settingsSession === session) renderSummaryMemoryEditor();
        }
    });

    settingsEl.find('#pf--summary-content').on('input', function () {
        session.summaryDraft = {
            source: session.summaryDraft?.source ?? getSummaryMemoryState(),
            content: this.value,
        };
        panel.find('#pf--summary-save-status').text('');
        renderSummaryMemoryEditor();
    });

    settingsEl.find('#pf--summary-save-entry').on('click', async () => {
        if (session.summaryBusy) return;
        const status = panel.find('#pf--summary-save-status');
        const draft = getSummaryEditorDraft();
        if (!draft.content) {
            status.text('Write or create a summary first.').removeClass('success').addClass('error');
            return;
        }

        session.summaryBusy = true;
        renderSummaryMemoryEditor();
        status.text('Saving entry...').removeClass('success error');

        try {
            const result = await createSeparateSummaryMemoryEntry(draft);
            if (settingsSession !== session) return;
            status.text(`Saved "${result.summaryTitle}"`).removeClass('error').addClass('success');
        } catch (err) {
            if (settingsSession !== session) return;
            status.text(`Entry save failed: ${err.message}`).removeClass('success').addClass('error');
        } finally {
            session.summaryBusy = false;
            if (settingsSession === session) renderSummaryMemoryEditor();
        }
    });

    settingsEl.find('#pf--summary-create').on('click', async () => {
        if (session.summaryBusy) return;
        const status = panel.find('#pf--summary-save-status');
        session.summaryBusy = true;
        renderSummaryMemoryEditor();
        status.text('Creating summary...').removeClass('success error');

        try {
            const result = await createManualSummaryMemory();
            if (settingsSession !== session) return;
            status.text(`Created UID ${result.uid}`).removeClass('error').addClass('success');
        } catch (err) {
            if (settingsSession !== session) return;
            status.text(err.name === 'AbortError' ? 'Cancelled' : `Create failed: ${err.message}`).removeClass('success').addClass('error');
        } finally {
            session.summaryBusy = false;
            if (settingsSession === session) renderSummaryMemoryEditor();
        }
    });

    settingsEl.on('change', '#pf--confirm-tool-list input[data-confirm-tool]', function () {
        const toolName = $(this).data('confirmTool');
        currentAgent.settings.confirmTools = { ...currentAgent.settings.confirmTools, [toolName]: this.checked };
        return save(['confirmTools']);
    });

    settingsEl.on('change', 'input[data-tool]', function () {
        setPathfinderToolEnabled($(this).data('tool'), this.checked);
        updateModeCardStates();
        return save(['toolStates']);
    });

    settingsEl.on('change', '#pf--permission-matrix input[data-permission]', function () {
        const row = $(this).closest('.pf--permission-row');
        const bookName = row.attr('data-book');
        const permission = $(this).data('permission');
        const enabled = $(this).prop('checked');

        if (!bookName || !permission) {
            return;
        }

        const permissions = currentAgent.settings.bookPermissions;
        currentAgent.settings.bookPermissions = { ...permissions, [bookName]: { ...permissions?.[bookName], [permission]: enabled ? 'readwrite' : 'none' } };
        return save(['bookPermissions']);
    });

    // Collapsible sections
    settingsEl.find('.pf--collapsible-header').on('click', function () {
        const section = $(this).closest('.pf--section-collapsible');
        const body = section.children('.pf--section-body').first();
        const willOpen = $(this).attr('aria-expanded') !== 'true';

        body.stop(true, true).toggle(willOpen);
        setSectionChevronState(section, !willOpen);
        setSectionCollapsedPreference(getCollapseSectionKey(section), !willOpen);
    });

    // Prompt editor
    settingsEl.find('#pf--prompt-selector').on('change', function () {
        const promptId = $(this).val();
        if (promptId) {
            loadPromptIntoEditor(promptId);
            settingsEl.find('#pf--prompt-fields').show();
        } else {
            settingsEl.find('#pf--prompt-fields').hide();
        }
    });

    settingsEl.find('#pf--prompt-save').on('click', saveCurrentPrompt);
    settingsEl.find('#pf--prompt-reset').on('click', resetCurrentPrompt);

    // Diagnostics
    settingsEl.find('#pf--run-diagnostics').on('click', async () => {
        const output = settingsEl.find('#pf--diagnostics-output');
        output.text('Running diagnostics...');

        try {
            const results = await runDiagnostics();
            if (settingsSession !== session) return;
            let text = '';

            for (const [key, value] of Object.entries(results)) {
                const icon = value.ok ? '✓' : '✗';
                text += `${icon} ${key}: ${value.message}\n`;
            }

            output.text(text || 'All checks passed!');
        } catch (err) {
            if (settingsSession !== session) return;
            output.text('Error running diagnostics: ' + err.message);
            console.warn(`${PATHFINDER_LOG_PREFIX} Pathfinder diagnostics failed.`, err);
        }
    });

    settingsEl.find('#pf--copy-diagnostics').on('click', async () => {
        const text = settingsEl.find('#pf--diagnostics-output').text() || '';
        try {
            await navigator.clipboard.writeText(text);
            toastr.success('Pathfinder diagnostics copied.');
        } catch {
            const textarea = $('<textarea>').val(text).css({ position: 'fixed', left: '-9999px', top: '0' });
            $('body').append(textarea);
            textarea[0].select();
            document.execCommand('copy');
            textarea.remove();
            toastr.success('Pathfinder diagnostics copied.');
        }
    });

    settingsEl.find('#pf--refresh-log').on('click', () => {
        renderRetrievalLog();
    });

    settingsEl.find('#pf--log-mode').on('change', function () {
        retrievalLogMode = String($(this).val()) === 'detailed' ? 'detailed' : 'summary';
        safeSetAccountStorageItem(PATHFINDER_LOG_MODE_KEY, retrievalLogMode);
        renderRetrievalLog();
    });

    settingsEl.find('#pf--clear-log').on('click', () => {
        clearFeed();
        renderRetrievalLog();
    });
}

/**
 * Update status banner based on current configuration
 */
function updateStatusBanner() {
    if (!settingsEl) return;
    const banner = settingsEl.find('#pf--status-banner');
    const agent = getAgentById(currentAgent.id) ?? currentAgent;
    settingsEl.find('#pf--master-enable').prop('checked', settingsSession.enabledChange ?? isAgentEnabledForCurrentScope(agent));
    const s = agent.settings ?? {};
    const books = getActiveTunnelVisionBooks(s);
    const readableBooks = getReadableBooks(s);
    const ToolManager = getContext()?.ToolManager;
    const usesTools = s.sidecarEnabled || isPathfinderToolEnabledForAgent(agent, 'Pathfinder_Summarize');
    const enabledTools = ALL_TOOL_NAMES.filter(name => (s.sidecarEnabled || name === 'Pathfinder_Summarize') && isPathfinderToolEnabledForAgent(agent, name));
    const registered = (ToolManager?.tools ?? []).map(tool => tool.toFunctionOpenAI?.()?.function?.name);
    let title = 'Pathfinder is not configured';
    let message = 'Select at least one lorebook below to get started';
    let ready = false;

    if (!areAgentsGloballyEnabled() || !isPathfinderSubmoduleEnabled() || !isAgentEnabledForCurrentScope(agent)) {
        title = 'Pathfinder is disabled';
        message = !areAgentsGloballyEnabled()
            ? 'In-Chat Agents disabled.'
            : !isPathfinderSubmoduleEnabled()
                ? 'Pathfinder is disabled in In-Chat Agents settings.'
                : 'Enable Pathfinder above to use the current setup';
    } else if (books.length > 0) {
        title = 'Lorebooks selected';
        message = 'Enable Tool Mode or Pipeline Mode above';
        if (readableBooks.length === 0) {
            title = 'Lorebook Permissions';
            message = 'No readable lorebooks';
        } else if (usesTools || s.pipelineEnabled) {
            if (getPathfinderRuntimeAgent()?.id !== agent.id) {
                message = 'Tool mode is enabled, but the Pathfinder tool agent is not active right now. Enable Pathfinder as a tool agent, then reopen settings or reload agents.';
            } else if (s.pipelineEnabled && s.connectionProfile && !listConnectionProfiles().some(profile => profile.id === s.connectionProfile)) {
                message = `Missing profile (${s.connectionProfile})`;
            } else if (online_status === 'no_connection' && (usesTools || !s.connectionProfile)) {
                message = 'Not connected to API!';
            } else if (usesTools && !ToolManager?.isToolCallingSupported?.()) {
                message = 'Tool calling is not supported for the current API/settings. Enable "Function Calling" in OpenAI settings and ensure the current model supports tools.';
            } else if (usesTools && enabledTools.length === 0) {
                message = 'Tool mode is enabled, but every Pathfinder tool toggle is off. Re-enable at least one Pathfinder tool in Tool Settings.';
            } else if (usesTools && enabledTools.some(name => !registered.includes(name))) {
                message = 'Tools are configured but not registered with ToolManager. Try reloading the extension or switching API sources.';
            } else {
                ready = true;
                title = 'Pathfinder is ready';
                message = `${readableBooks.length} lorebook(s) available`;
            }
        }
    }
    banner.toggleClass('pf--status-ready', ready).toggleClass('pf--status-disabled', !ready);
    banner.find('.pf--status-icon i').toggleClass('fa-circle-check', ready).toggleClass('fa-circle-xmark', !ready);
    banner.find('.pf--status-text strong').text(title);
    banner.find('.pf--status-text span').text(message);
}

function renderRetrievalLog() {
    const output = settingsEl.find('#pf--retrieval-log-output');
    if (!output.length) {
        return;
    }

    const items = getFeedItems().filter(item =>
        item.type === 'pathfinder_retrieval_detail'
        || item.type === 'pipeline_start'
        || item.type === 'pipeline_stage_start'
        || item.type === 'pipeline_stage_complete'
        || item.type === 'pipeline_complete'
        || item.type === 'pipeline_error'
        || item.type === 'sidecar_retrieval'
        || item.type === 'tool_call_started'
        || item.type === 'tool_call_completed'
        || item.type === 'tool_call_error',
    );

    if (items.length === 0) {
        output.text('No Pathfinder retrieval activity recorded yet.');
        return;
    }

    const text = formatRetrievalLog(items);
    output.text(text || 'No Pathfinder retrieval activity recorded yet.');
}

function formatTime(timestamp) {
    return timestamp ? new Date(timestamp).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' }) : '--:--:--';
}

function compactText(value, maxLength = 220) {
    const text = String(value ?? '').replace(/\s+/g, ' ').trim();
    return text.length > maxLength ? `${text.slice(0, maxLength - 1).trimEnd()}…` : text;
}

function formatCount(count, noun) {
    const value = Number(count) || 0;
    const plural = noun === 'entry' ? 'entries' : `${noun}s`;
    return `${value} ${value === 1 ? noun : plural}`;
}

function prettyJson(value, fallback = '') {
    if (value === undefined || value === null || value === '') {
        return fallback;
    }

    if (typeof value === 'string') {
        return value;
    }

    try {
        return JSON.stringify(value, null, 2);
    } catch {
        return String(value);
    }
}

function formatRetrievalMode(mode) {
    switch (mode) {
        case 'pipeline': return 'Pipeline retrieval';
        case 'tool-retrieval': return 'Tool/legacy retrieval';
        default: return 'Pathfinder retrieval';
    }
}

function formatStageLine(stage) {
    const stageNumber = Number.isFinite(Number(stage.stageIndex)) ? Number(stage.stageIndex) + 1 : null;
    const label = stage.promptName || stage.stageName || stage.promptId || (stageNumber ? `Stage ${stageNumber}` : 'Stage');
    const status = stage.success === false ? 'failed' : (stage.skipped ? 'skipped' : 'completed');
    const count = stage.entriesFound ?? stage.selectedEntries ?? 0;
    const extras = [];

    if (stage.reason) extras.push(stage.reason);
    if (stage.error) extras.push(`Error: ${stage.error}`);
    if (stage.reasoning) extras.push(`Reasoning: ${compactText(stage.reasoning, 180)}`);

    return `  ${stageNumber ? `${stageNumber}. ` : '- '}${label}: ${status}, ${formatCount(count, 'entry')}${extras.length ? ` — ${extras.join('; ')}` : ''}`;
}

function formatRetrievalDetail(item, { detailed = false } = {}) {
    const selectedEntries = Array.isArray(item.selectedEntries) ? item.selectedEntries : [];
    const stageResults = Array.isArray(item.stageResults) ? item.stageResults : [];
    const metadata = item.metadata || {};
    const injectedPrompt = String(item.injectedPrompt || '');
    const lines = [
        `▸ ${formatRetrievalMode(item.mode)} at ${formatTime(item.timestamp)}`,
        `  Lorebooks: ${(item.books || []).join(', ') || 'none'}`,
        `  Result: ${formatCount(selectedEntries.length, 'entry')} selected${metadata.candidateCount !== undefined ? ` from ${formatCount(metadata.candidateCount, 'candidate')}` : ''}`,
    ];

    if (metadata.reason) {
        lines.push(`  Note: ${metadata.reason.replace(/-/g, ' ')}`);
    }

    if (metadata.skippedNaturalActivationCount > 0) {
        lines.push(`  Skipped native World Info activations: ${formatCount(metadata.skippedNaturalActivationCount, 'entry')}`);
    }

    if (stageResults.length > 0) {
        lines.push('', detailed ? '  Retrieval stages:' : '  Stages:');
        lines.push(...stageResults.map(formatStageLine));
    }

    if (selectedEntries.length > 0) {
        lines.push('', detailed ? '  Lorebook entries selected for injection:' : '  Selected lore:');
        for (const entry of selectedEntries.slice(0, detailed ? 50 : 12)) {
            const name = entry.name || 'Untitled entry';
            const book = entry.bookName ? ` · ${entry.bookName}` : '';
            const uid = entry.uid !== null && entry.uid !== undefined ? ` · uid ${entry.uid}` : '';
            lines.push(`  - ${name}${book}${uid}`);
            if (entry.preview) {
                lines.push(`    ${detailed ? String(entry.preview).trim() : compactText(entry.preview, 180)}`);
            }
        }
        if (!detailed && selectedEntries.length > 12) {
            lines.push(`  - …and ${selectedEntries.length - 12} more`);
        }
    }

    if (injectedPrompt) {
        lines.push('', `  Injected context: ${formatCount(injectedPrompt.length, 'character')}`);
        lines.push(detailed ? injectedPrompt : `  ${compactText(injectedPrompt, 300)}`);
    } else {
        lines.push('', '  Injected context: none');
    }

    if (detailed && Object.keys(metadata).length > 0) {
        lines.push('', '  Retrieval metadata:');
        lines.push(prettyJson(metadata));
    }

    if (metadata.error) {
        lines.push('', `  Error: ${metadata.error}`);
    }

    return lines.join('\n');
}

function formatPipelineSummary(items) {
    const pipelineEvents = items.filter(item => item.type?.startsWith?.('pipeline_'));
    if (!pipelineEvents.length) {
        return '';
    }

    const latestStart = pipelineEvents.find(item => item.type === 'pipeline_start');
    const latestComplete = pipelineEvents.find(item => item.type === 'pipeline_complete');
    const latestError = pipelineEvents.find(item => item.type === 'pipeline_error');
    const startedStages = pipelineEvents.filter(item => item.type === 'pipeline_stage_start').length;
    const completedStages = pipelineEvents.filter(item => item.type === 'pipeline_stage_complete').length;

    const lines = ['Recent pipeline activity:'];
    if (latestStart) lines.push(`  Started “${latestStart.pipelineName}” at ${formatTime(latestStart.timestamp)} (${formatCount(latestStart.stageCount, 'stage')}).`);
    if (latestComplete) lines.push(`  Finished with ${formatCount(latestComplete.totalEntries, 'entry')} across ${formatCount(latestComplete.stageResults, 'stage result')}.`);
    if (latestError) lines.push(`  Last error: ${latestError.stageName || latestError.pipelineName}: ${latestError.error}`);
    if (!latestComplete && !latestError) lines.push(`  Progress: ${completedStages}/${startedStages || '?'} stages completed.`);

    return lines.join('\n');
}

function formatToolActivity(items) {
    const toolItems = items.filter(item => item.type?.startsWith?.('tool_call_')).slice(0, 8);
    if (!toolItems.length) {
        return '';
    }

    const lines = ['Recent tool activity:'];
    for (const item of toolItems) {
        if (item.type === 'tool_call_started') {
            lines.push(`  - ${formatTime(item.timestamp)} ${item.toolName}: started`);
        } else if (item.type === 'tool_call_completed') {
            const result = typeof item.result === 'string' ? item.result : JSON.stringify(item.result);
            lines.push(`  - ${formatTime(item.timestamp)} ${item.toolName}: completed — ${compactText(result, 180)}`);
        } else if (item.type === 'tool_call_error') {
            lines.push(`  - ${formatTime(item.timestamp)} ${item.toolName}: failed — ${item.error}`);
        }
    }
    return lines.join('\n');
}

function formatDetailedToolActivity(items) {
    const toolItems = items.filter(item => item.type?.startsWith?.('tool_call_')).slice(0, 30).reverse();
    if (!toolItems.length) {
        return '';
    }

    const lines = ['Tool calls and lorebook actions:'];
    for (const item of toolItems) {
        const toolName = item.toolName || 'Tool';
        if (item.type === 'tool_call_started') {
            lines.push(`\n- ${formatTime(item.timestamp)} ${toolName}: started${item.isSidecar ? ' (sidecar)' : ''}`);
            if (item.args !== undefined) {
                lines.push('  Arguments:');
                lines.push(prettyJson(item.args).split('\n').map(line => `  ${line}`).join('\n'));
            }
        } else if (item.type === 'tool_call_completed') {
            lines.push(`\n- ${formatTime(item.timestamp)} ${toolName}: completed${item.isSidecar ? ' (sidecar)' : ''}`);
            if (item.result !== undefined) {
                lines.push('  Result:');
                lines.push(prettyJson(item.result).split('\n').map(line => `  ${line}`).join('\n'));
            }
        } else if (item.type === 'tool_call_error') {
            lines.push(`\n- ${formatTime(item.timestamp)} ${toolName}: failed`);
            lines.push(`  Error: ${item.error}`);
        }
    }
    return lines.join('\n');
}

function formatRawEventTimeline(items) {
    const lines = ['Event timeline:'];
    for (const item of items.slice(0, 30).reverse()) {
        lines.push(`  - ${formatTime(item.timestamp)} ${formatRetrievalLogItem(item).replace(/^\[[^\]]+\]\s*/, '').replace(/\n/g, '\n    ')}`);
    }
    return lines.join('\n');
}

function formatRetrievalLog(items) {
    const latestDetail = items.find(item => item.type === 'pathfinder_retrieval_detail');
    const sections = [];
    const detailed = retrievalLogMode === 'detailed';

    if (latestDetail) {
        sections.push(formatRetrievalDetail(latestDetail, { detailed }));
    } else {
        sections.push('No completed retrieval summary yet. Refresh after Pathfinder runs, or check pipeline/tool activity below.');
    }

    const pipelineSummary = formatPipelineSummary(items);
    if (pipelineSummary) sections.push(pipelineSummary);

    const toolActivity = detailed ? formatDetailedToolActivity(items) : formatToolActivity(items);
    if (toolActivity) sections.push(toolActivity);

    if (detailed) {
        sections.push(formatRawEventTimeline(items));
    }

    const legacyRetrieval = items.find(item => item.type === 'sidecar_retrieval');
    if (legacyRetrieval && latestDetail?.mode !== 'tool-retrieval') {
        sections.push(`Legacy retrieval: selected ${formatCount(legacyRetrieval.entryCount, 'entry')} from waypoint IDs ${(legacyRetrieval.nodeIds || []).join(', ') || 'none'}.`);
    }

    return sections.filter(Boolean).join('\n\n');
}

function formatRetrievalLogItem(item) {
    const timestamp = formatTime(item?.timestamp);

    switch (item.type) {
        case 'pathfinder_retrieval_detail': {
            const selectedEntries = Array.isArray(item.selectedEntries) ? item.selectedEntries : [];
            const stageResults = Array.isArray(item.stageResults) ? item.stageResults : [];
            const lines = [
                `[${timestamp}] Retrieval (${item.mode || 'unknown'})`,
                `Books: ${(item.books || []).join(', ') || 'None'}`,
                `Selected entries: ${selectedEntries.length}`,
            ];

            if (selectedEntries.length > 0) {
                lines.push('Entries:');
                for (const entry of selectedEntries) {
                    const label = entry.bookName ? `${entry.name || 'Untitled'} (${entry.bookName})` : (entry.name || 'Untitled');
                    lines.push(`- ${label}${entry.uid !== null && entry.uid !== undefined ? ` [uid ${entry.uid}]` : ''}`);
                    if (entry.preview) {
                        lines.push(`  ${String(entry.preview).replace(/\s+/g, ' ').trim()}`);
                    }
                }
            }

            if (stageResults.length > 0) {
                lines.push('Stages:');
                for (const stage of stageResults) {
                    const stageLabel = stage.promptId || stage.stageName || `Stage ${Number(stage.stageIndex) + 1}`;
                    const stageStatus = stage.success === false ? 'error' : (stage.skipped ? 'skipped' : 'ok');
                    const count = stage.entriesFound ?? stage.selectedEntries ?? 0;
                    lines.push(`- ${stageLabel}: ${stageStatus}${count ? ` (${count})` : ''}`);
                    if (stage.reasoning) {
                        lines.push(`  Reasoning: ${String(stage.reasoning).replace(/\s+/g, ' ').trim()}`);
                    }
                    if (stage.error) {
                        lines.push(`  Error: ${stage.error}`);
                    }
                }
            }

            if (item.injectedPrompt) {
                lines.push('Injected prompt:');
                lines.push(item.injectedPrompt);
            }

            return lines.join('\n');
        }
        case 'pipeline_start':
            return `[${timestamp}] Pipeline start: ${item.pipelineName} (${item.stageCount} stage(s))`;
        case 'pipeline_stage_start':
            return `[${timestamp}] Pipeline stage start: ${item.stageName} (${item.stageIndex}/${item.totalStages})`;
        case 'pipeline_stage_complete':
            return `[${timestamp}] Pipeline stage complete: ${item.stageName} (${item.entriesFound} entries)`;
        case 'pipeline_complete':
            return `[${timestamp}] Pipeline complete: ${item.pipelineName} (${item.totalEntries} entries, ${item.stageResults} stage results)`;
        case 'pipeline_error':
            return `[${timestamp}] Pipeline error: ${item.pipelineName} / ${item.stageName} - ${item.error}`;
        case 'sidecar_retrieval':
            return `[${timestamp}] Legacy retrieval selected ${item.entryCount} entries from node IDs: ${(item.nodeIds || []).join(', ') || 'none'}`;
        case 'tool_call_started':
            return `[${timestamp}] Tool started: ${item.toolName}`;
        case 'tool_call_completed':
            return `[${timestamp}] Tool completed: ${item.toolName} - ${typeof item.result === 'string' ? item.result : JSON.stringify(item.result, null, 2)}`;
        case 'tool_call_error':
            return `[${timestamp}] Tool error: ${item.toolName} - ${item.error}`;
        default:
            return '';
    }
}

/**
 * Update mode card visual states
 */
function updateModeCardStates() {
    const s = currentAgent.settings;

    const toolEnabled = Boolean(s.sidecarEnabled);
    const pipelineEnabled = Boolean(s.pipelineEnabled);
    const toolCard = settingsEl.find('.pf--mode-card[data-mode="tools"]');
    const pipelineCard = settingsEl.find('.pf--mode-card[data-mode="pipeline"]');

    settingsEl.find('#pf--enable-tools').prop('checked', toolEnabled);
    settingsEl.find('#pf--enable-pipeline').prop('checked', pipelineEnabled);

    toolCard.toggleClass('active', toolEnabled);
    pipelineCard.toggleClass('active', pipelineEnabled);

    // Show/hide settings sections
    settingsEl.find('#pf--tool-settings').show();
    settingsEl.find('.pf--tool-mode-only').toggle(toolEnabled);
    settingsEl.find('#pf--pipeline-settings').toggle(pipelineEnabled);
    settingsEl.find('#pf--prompt-editor-section').toggle(pipelineEnabled);

    // Update dual-mode warning
    updateDualModeWarning();
}

/**
 * Show/hide warning when both modes are enabled
 */
function updateDualModeWarning() {
    const s = currentAgent.settings;
    const bothEnabled = s.sidecarEnabled && s.pipelineEnabled;
    settingsEl.find('#pf--dual-mode-warning').toggle(bothEnabled);
}

/**
 * Queue private edits, preserving unrelated changes made outside this panel.
 */
let agentSettingsSaveChain = Promise.resolve();

function updateAgentSettings(keys = []) {
    const session = settingsSession;
    const agentId = currentAgent.id;
    keys.forEach(key => session.dirtySettings.add(key));
    const changes = structuredClone(Object.fromEntries([...session.dirtySettings].map(key => [key, currentAgent.settings[key]])));
    const enabled = session.enabledChange;
    const scope = getActiveAgentChatScope();
    const contextRevision = session.contextRevision;
    const revision = ++session.revision;
    const status = session.element.find('#pf--settings-save-status');
    session.pending++;
    status.text('Not saved yet').removeClass('success error').attr('aria-busy', 'true');
    session.element.find('#pf--settings-retry').hide();
    renderSummaryMemoryEditor();

    const run = saveAgent(agentId, { update: agent => {
        if (settingsSession !== session || session.contextRevision !== contextRevision) return null;
        if (!agent) throw new Error('Pathfinder agent is not available. Reload In-Chat Agents or restore the bundled Pathfinder template.');
        agent.settings = { ...agent.settings, ...changes };
        if (changes.toolStates) {
            agent.tools = (agent.tools ?? []).map(tool => Object.hasOwn(changes.toolStates, tool.name)
                ? { ...tool, enabled: changes.toolStates[tool.name] !== false } : tool);
        }
        if (enabled !== undefined) {
            const global = getGlobalSettings();
            agent.enabled = enabled || (global.separateRecentChats && Object.entries(global.enabledAgentIdsByChatType ?? {})
                .some(([otherScope, ids]) => otherScope !== scope && ids.includes(agentId)));
        }
        return agent;
    } }).then(agent => {
        if (!agent) return;
        if (enabled !== undefined) {
            setAgentEnabledForScope(getAgentById(agentId) ?? agent, enabled, scope);
            persistAgentGlobalSettings();
        }
        if (session.contextRevision !== contextRevision) return;

        try {
            if (getPathfinderRuntimeAgent()?.id === agentId) {
                replaceSettings(structuredClone(agent.settings));
                initializePromptStore(getDefaultPrompts(), getDefaultPipelines());
            }
            syncToolAgentRegistrations();
        } catch (err) {
            console.warn('[Pathfinder] Could not refresh tool registrations after saving.', err);
        }
        if (settingsSession !== session) return;
        if (revision === session.revision) {
            session.dirtySettings.clear();
            session.enabledChange = undefined;
            session.agent.settings = structuredClone({ ...SETTING_DEFAULTS, ...agent.settings });
            session.agent.tools = structuredClone(agent.tools ?? []);
            status.text('Saved!').removeClass('error').addClass('success');
            session.element.find('#pf--prompt-status.error').text('');
            updateModeCardStates();
        }
        updateStatusBanner();
    }).catch(err => {
        if (settingsSession === session && revision === session.revision && session.contextRevision === contextRevision) {
            status.text(`Save failed: ${err.message}`).removeClass('success').addClass('error');
            session.element.find('#pf--settings-retry').show();
        }
        throw err;
    }).finally(() => {
        session.pending--;
        if (settingsSession === session) {
            status.attr('aria-busy', String(session.pending > 0));
            session.element.find('#pf--settings-retry').prop('disabled', session.pending > 0);
            renderSummaryMemoryEditor();
        }
    });
    agentSettingsSaveChain = run.catch(() => {});
    return run;
}

/**
 * Load a prompt into the editor
 */
function loadPromptIntoEditor(promptId) {
    const prompt = currentAgent.settings.pipelinePrompts?.[promptId] ?? getDefaultPrompts()[promptId];
    if (!prompt) return;

    settingsEl.find('#pf--prompt-system').val(prompt.systemPrompt || '');
    settingsEl.find('#pf--prompt-max-tokens').val(prompt.settings?.maxTokens ?? DEFAULT_PIPELINE_MAX_TOKENS);
    settingsEl.find('#pf--prompt-user').val(prompt.userPromptTemplate || '');
    clearPromptStatus();
}

/**
 * Save the current prompt
 */
async function saveCurrentPrompt() {
    const session = settingsSession;
    const contextRevision = session.contextRevision;
    const promptId = settingsEl.find('#pf--prompt-selector').val();
    if (!promptId) return;

    const prompt = structuredClone(currentAgent.settings.pipelinePrompts?.[promptId] ?? getDefaultPrompts()[promptId]);
    if (!prompt) return;

    prompt.systemPrompt = settingsEl.find('#pf--prompt-system').val();
    prompt.userPromptTemplate = settingsEl.find('#pf--prompt-user').val();
    prompt.settings = {
        ...(prompt.settings || {}),
        maxTokens: readPromptMaxTokens(),
    };

    currentAgent.settings.pipelinePrompts = { ...currentAgent.settings.pipelinePrompts, [promptId]: prompt };
    try {
        await updateAgentSettings(['pipelinePrompts']);
        if (settingsSession === session && session.contextRevision === contextRevision && settingsEl.find('#pf--prompt-selector').val() === promptId) {
            const unchanged = settingsEl.find('#pf--prompt-system').val() === prompt.systemPrompt
                && settingsEl.find('#pf--prompt-user').val() === prompt.userPromptTemplate
                && readPromptMaxTokens() === prompt.settings.maxTokens;
            showPromptStatus(unchanged ? 'Saved!' : 'Not saved yet', unchanged ? 'success' : '');
        }
    } catch (err) {
        if (settingsSession === session && session.contextRevision === contextRevision) showPromptStatus(`Save failed: ${err.message}`, 'error');
    }
}

/**
 * Reset the current prompt to default
 */
async function resetCurrentPrompt() {
    const session = settingsSession;
    const contextRevision = session.contextRevision;
    const promptId = settingsEl.find('#pf--prompt-selector').val();
    if (!promptId) return;

    const defaults = getDefaultPrompts();
    const defaultPrompt = defaults[promptId];

    if (!defaultPrompt) {
        showPromptStatus('No default available', 'error');
        return;
    }

    const fields = ['#pf--prompt-system', '#pf--prompt-user', '#pf--prompt-max-tokens'];
    const originalValues = fields.map(selector => settingsEl.find(selector).val());
    currentAgent.settings.pipelinePrompts = { ...currentAgent.settings.pipelinePrompts, [promptId]: structuredClone({ ...defaultPrompt, isDefault: true }) };
    try {
        await updateAgentSettings(['pipelinePrompts']);
        if (settingsSession !== session || session.contextRevision !== contextRevision || settingsEl.find('#pf--prompt-selector').val() !== promptId) return;
        const unchanged = fields.every((selector, index) => settingsEl.find(selector).val() === originalValues[index]);
        if (unchanged) loadPromptIntoEditor(promptId);
        showPromptStatus(unchanged ? 'Reset to default' : 'Not saved yet', unchanged ? 'success' : '');
    } catch (err) {
        if (settingsSession === session && session.contextRevision === contextRevision) showPromptStatus(`Save failed: ${err.message}`, 'error');
    }
}

function showPromptStatus(message, type) {
    const status = settingsEl.find('#pf--prompt-status');
    status.text(message).removeClass('success error').addClass(type);
}

function clearPromptStatus() {
    settingsEl.find('#pf--prompt-status').text('');
}

/**
 * Check if an agent is Pathfinder
 */
export function isPathfinderAgent(agent) {
    return agent?.sourceTemplateId === 'tpl-pathfinder' ||
           agent?.name === 'Pathfinder' ||
           (agent?.category === 'tool' && agent?.tools?.some(t => t.name?.startsWith('Pathfinder_')));
}
