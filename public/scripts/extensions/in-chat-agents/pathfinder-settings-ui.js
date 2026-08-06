/**
 * Pathfinder Settings UI - Idiot-proof settings panel for Pathfinder
 */

import { renderExtensionTemplateAsync, getContext } from '../../extensions.js';
import { saveSettingsDebounced } from '../../../script.js';
import { accountStorage } from '../../util/AccountStorage.js';
import { escapeHtml } from '../../utils.js';
import { world_names, loadWorldInfo } from '../../world-info.js';
import { isAgentEnabledForCurrentScope, isPathfinderSubmoduleEnabled, persistAgentGlobalSettings, saveAgent, setAgentEnabledForCurrentScope } from './agent-store.js';
import {
    getPathfinderSettings,
    setPathfinderSettings,
    runDiagnostics,
} from './pathfinder-init.js';
import {
    setLorebookEnabled,
    listConnectionProfiles,
    normalizeAutoSummaryInterval,
    isPathfinderToolEnabled as isRuntimePathfinderToolEnabled,
    setPathfinderToolEnabled as setRuntimePathfinderToolEnabled,
    setBookPermission,
    canReadBook,
    canWriteBook,
    canDeleteBook,
} from './pathfinder/tree-store.js';
import { buildTreeFromMetadata } from './pathfinder/tree-builder.js';
import { syncToolAgentRegistrations } from './agent-runner.js';
import { ALL_TOOL_NAMES, getContextualLorebookDetails } from './pathfinder/pathfinder-tool-bridge.js';
import { getPrompt, savePrompt } from './pathfinder/prompts/prompt-store.js';
import { getDefaultPrompts } from './pathfinder/prompts/default-prompts.js';
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
let retrievalLogMode = safeGetAccountStorageItem(PATHFINDER_LOG_MODE_KEY) === 'detailed' ? 'detailed' : 'summary';
let summaryMemoryUnsubscribe = null;

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
    const chevron = section.children('.pf--collapsible-header').first().find('.pf--chevron').first();
    chevron.toggleClass('fa-chevron-down', !collapsed);
    chevron.toggleClass('fa-chevron-right', collapsed);
}

function applyPersistedCollapseStates() {
    const states = getCollapsedSectionStates();

    settingsEl.find('.pf--section-collapsible').each(function () {
        const section = $(this);
        const sectionKey = getCollapseSectionKey(section);
        if (!sectionKey || !Object.prototype.hasOwnProperty.call(states, sectionKey)) {
            return;
        }

        const collapsed = states[sectionKey] === true;
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

function addUniqueLorebookName(names, name) {
    const bookName = String(name ?? '').trim();
    if (bookName && !names.includes(bookName)) {
        names.push(bookName);
    }
}

function getActiveLorebookNames(settings, lorebooks = []) {
    const names = [...ensureEnabledLorebooks(settings)];

    if (settings.autoUseAttachedLorebook || settings.autoSyncLorebooksOnChatChange !== false) {
        for (const book of lorebooks) {
            if (book.attached) {
                addUniqueLorebookName(names, book.name);
            }
        }
    }

    if (settings.includeContextualLorebooks !== false) {
        for (const source of getContextualLorebookDetails()) {
            addUniqueLorebookName(names, source.name);
        }
    }

    return names;
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
            entries: '?',
            attached: true,
            sourceTypes,
            type: formatLorebookSourceLabel(sourceTypes),
        });
    }

    return getActiveLorebookNames(settings, allBooks)
        .map(name => booksByName.get(name) ?? { name, entries: '?', attached: false, type: 'lorebook' })
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
        entries: '?',
        attached: false,
        sourceTypes: new Set(),
    };

    if (data.entries !== undefined) {
        book.entries = data.entries;
    }

    if (data.type) {
        book.sourceTypes.add(data.type);
        if (data.type !== 'global') {
            book.attached = true;
        }
    }

    lorebooksByName.set(name, book);
}

async function ensureLorebookTree(bookName) {
    try {
        const bookData = await loadWorldInfo(bookName);
        if (!bookData?.entries) {
            console.warn(`${PATHFINDER_LOG_PREFIX} Lorebook "${bookName}" could not be loaded for tree building.`);
            return false;
        }

        await buildTreeFromMetadata(bookName, bookData);
        return true;
    } catch (err) {
        console.warn(`${PATHFINDER_LOG_PREFIX} Failed to build tree for lorebook "${bookName}".`, err);
        return false;
    }
}

async function syncAutoAttachedLorebooks(lorebooks, settings) {
    if (!settings.autoUseAttachedLorebook && !settings.autoSyncLorebooksOnChatChange) {
        return [];
    }

    const enabledLorebooks = [...ensureEnabledLorebooks(settings)];
    const attachedLorebooks = lorebooks.filter(book => book.attached).map(book => book.name);
    const syncedLorebooks = Array.from(new Set(attachedLorebooks));
    const selectedLorebook = syncedLorebooks[0] ?? '';
    const autoSyncChanged = settings.autoSyncLorebooksOnChatChange
        && (enabledLorebooks.length !== syncedLorebooks.length
            || enabledLorebooks.some((name, index) => name !== syncedLorebooks[index])
            || (settings.selectedLorebook ?? '') !== selectedLorebook);
    if (settings.autoSyncLorebooksOnChatChange) {
        settings.enabledLorebooks = syncedLorebooks;
        settings.selectedLorebook = selectedLorebook;
        setPathfinderSettings(settings);
    }

    const newLorebooks = attachedLorebooks.filter(name => !enabledLorebooks.includes(name));

    if (attachedLorebooks.length === 0) {
        if (autoSyncChanged) {
            return enabledLorebooks;
        }
        return [];
    }

    if (!settings.autoSyncLorebooksOnChatChange) {
        settings.enabledLorebooks = Array.from(new Set([...enabledLorebooks, ...attachedLorebooks]));
        if (!settings.selectedLorebook || !settings.enabledLorebooks.includes(settings.selectedLorebook)) {
            settings.selectedLorebook = settings.enabledLorebooks[0] ?? '';
        }
    }
    attachedLorebooks.forEach(bookName => setLorebookEnabled(bookName, true));
    setPathfinderSettings(settings);

    if (newLorebooks.length > 0) {
        for (const bookName of newLorebooks) {
            await ensureLorebookTree(bookName);
        }
    }

    if (autoSyncChanged) {
        const removedLorebooks = enabledLorebooks.filter(name => !syncedLorebooks.includes(name));
        return Array.from(new Set([...newLorebooks, ...removedLorebooks]));
    }

    return newLorebooks;
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

    currentAgent = agent;
    const existingSettings = getPathfinderSettings();
    setPathfinderSettings({
        pipelinePrompts: existingSettings.pipelinePrompts,
        pipelines: existingSettings.pipelines,
        ...(agent?.settings || {}),
    });

    const html = await renderExtensionTemplateAsync(MODULE_NAME, 'pathfinder-settings');
    if (!html) {
        toastr.error('Could not load Pathfinder settings.');
        return null;
    }

    settingsEl = $(html);
    if (summaryMemoryUnsubscribe) {
        summaryMemoryUnsubscribe();
    }
    summaryMemoryUnsubscribe = onSummaryMemoryChanged(renderSummaryMemoryEditor);

    // Initialize UI
    await refreshLorebookList();
    applyQuickstartDismissalState();
    loadSettingsIntoUI();
    applyPersistedCollapseStates();
    bindEvents();
    settingsEl.find('#pf--log-mode').val(retrievalLogMode);
    updateStatusBanner();
    updateModeCardStates();
    renderRetrievalLog();
    renderSummaryMemoryEditor();

    return settingsEl;
}

/**
 * Get available lorebooks from current context
 */
async function getAvailableLorebooks() {
    const ctx = getContext();
    if (!ctx && !globalThis.window?.SillyTavern?.getContext?.() && (!Array.isArray(world_names) || world_names.length === 0)) {
        console.warn(`${PATHFINDER_LOG_PREFIX} Could not resolve the current context while gathering lorebooks.`);
        return [];
    }

    const lorebooksByName = new Map();

    // Use the global world_names array from world-info.js
    if (Array.isArray(world_names) && world_names.length > 0) {
        for (const name of world_names) {
            try {
                // Try to load the world info to get entry count
                const bookData = await loadWorldInfo(name);
                const entryCount = bookData?.entries ? Object.keys(bookData.entries).length : '?';
                upsertLorebook(lorebooksByName, name, {
                    entries: entryCount,
                    type: 'global',
                });
            } catch (err) {
                // If we can't load it, just add with unknown count
                console.warn(`${PATHFINDER_LOG_PREFIX} Failed to load lorebook metadata for "${name}".`, err);
                upsertLorebook(lorebooksByName, name, {
                    entries: '?',
                    type: 'global',
                });
            }
        }
    }

    for (const source of getContextualLorebookDetails()) {
        upsertLorebook(lorebooksByName, source.name, { type: source.type || 'attached' });
        const book = lorebooksByName.get(source.name);
        if (book && Array.isArray(source.types)) {
            for (const type of source.types) {
                book.sourceTypes.add(type);
            }
        }

        if (book?.entries === '?') {
            try {
                const bookData = await loadWorldInfo(source.name);
                book.entries = bookData?.entries ? Object.keys(bookData.entries).length : '?';
            } catch {
                // Keep unknown count for contextual books that are not importable as standalone lorebooks.
            }
        }
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
async function refreshLorebookList() {
    const listEl = settingsEl.find('#pf--lorebook-list');
    listEl.empty();

    const lorebooks = await getAvailableLorebooks();
    const settings = getPathfinderSettings();
    ensureEnabledLorebooks(settings);

    settingsEl.find('#pf--auto-use-attached').prop('checked', Boolean(settings.autoUseAttachedLorebook));
    const autoEnabledLorebooks = await syncAutoAttachedLorebooks(lorebooks, settings);
    if (autoEnabledLorebooks.length > 0) {
        await updateAgentSettings();
        updateStatusBanner();
    }
    const enabledBooks = getActiveLorebookNames(getPathfinderSettings(), lorebooks);

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

    for (const book of lorebooks) {
        const isEnabled = enabledBooks.includes(book.name);
        const item = $(`
            <div class="pf--lorebook-item ${isEnabled ? 'selected' : ''}" data-book="${escapeHtml(book.name)}">
                <input type="checkbox" ${isEnabled ? 'checked' : ''} />
                <div class="pf--lorebook-info">
                    <span class="pf--lorebook-name">${escapeHtml(book.name)}</span>
                    <span class="pf--lorebook-meta">${book.entries} entries · ${book.type}</span>
                </div>
            </div>
        `);

        item.on('click', async function (e) {
            if (e.target.tagName === 'INPUT') return;
            const checkbox = $(this).find('input[type="checkbox"]');
            checkbox.prop('checked', !checkbox.prop('checked')).trigger('change');
        });

        item.find('input').on('change', async function () {
            const bookName = item.data('book');
            const checked = $(this).prop('checked');

            item.toggleClass('selected', checked);

            // Update settings
            const s = getPathfinderSettings();
            ensureEnabledLorebooks(s);

            if (checked && !s.enabledLorebooks.includes(bookName)) {
                s.enabledLorebooks.push(bookName);
                s.selectedLorebook = s.selectedLorebook || bookName;
                setLorebookEnabled(bookName, true);
                await ensureLorebookTree(bookName);
            } else if (!checked) {
                s.enabledLorebooks = s.enabledLorebooks.filter(b => b !== bookName);
                if (s.selectedLorebook === bookName) {
                    s.selectedLorebook = s.enabledLorebooks[0] ?? '';
                }
                setLorebookEnabled(bookName, false);
            }

            setPathfinderSettings(s);
            updateAgentSettings();
            updateStatusBanner();
            renderPermissionMatrix(lorebooks);
        });

        listEl.append(item);
    }

    renderPermissionMatrix(lorebooks);
}


function setPathfinderToolEnabled(toolName, enabled) {
    setRuntimePathfinderToolEnabled(toolName, enabled);
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
    const fallbackTool = Array.isArray(currentAgent?.tools)
        ? currentAgent.tools.find(t => t.name === toolName)
        : null;

    if (currentAgent?.settings?.toolStates && Object.hasOwn(currentAgent.settings.toolStates, toolName)) {
        return currentAgent.settings.toolStates[toolName] !== false;
    }

    return isRuntimePathfinderToolEnabled(toolName, fallbackTool?.enabled !== false);
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
    const toolList = settingsEl.find('.pf--tool-list');
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

function renderPermissionMatrix(lorebooks = null) {
    const matrix = settingsEl.find('#pf--permission-matrix');
    if (!matrix.length) {
        return;
    }

    const books = getEffectiveLorebooks(lorebooks, getPathfinderSettings());

    if (books.length === 0) {
        matrix.html('<div class="pf--empty-state pf--permission-empty"><i class="fa-solid fa-lock-open"></i><span>Select a lorebook above, or attach one to the current character/chat with auto-select enabled.</span></div>');
        return;
    }

    const rows = books.map(book => `
        <div class="pf--permission-row" data-book="${escapeHtml(book.name)}">
            <div class="pf--permission-book">
                <strong>${escapeHtml(book.name)}</strong>
                <span>${escapeHtml(book.type || 'lorebook')}</span>
            </div>
            <label class="checkbox_label"><input type="checkbox" data-permission="read" ${canReadBook(book.name) ? 'checked' : ''} /><span>Read</span></label>
            <label class="checkbox_label"><input type="checkbox" data-permission="write" ${canWriteBook(book.name) ? 'checked' : ''} /><span>Write</span></label>
            <label class="checkbox_label"><input type="checkbox" data-permission="delete" ${canDeleteBook(book.name) ? 'checked' : ''} /><span>Delete</span></label>
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
    const s = getPathfinderSettings();

    settingsEl.find('#pf--master-enable').prop('checked', currentAgent ? isAgentEnabledForCurrentScope(currentAgent) : false);

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
    settingsEl.find('#pf--dedupe-natural-activation').prop('checked', s.dedupeNaturalActivation !== false);
    settingsEl.find('#pf--auto-summary').prop('checked', s.autoSummary || false);
    settingsEl.find('#pf--auto-summary-interval').val(s.autoSummaryInterval ?? 20);

    settingsEl.find('#pf--enable-summarize-tool').prop('checked', isPathfinderToolEnabled('Pathfinder_Summarize'));

    // Populate connection profiles
    populateConnectionProfiles();

    // Load tool states from agent
    renderToolToggles();
    settingsEl.find('input[data-tool]').each(function () {
        const toolName = $(this).data('tool');
        $(this).prop('checked', isPathfinderToolEnabled(toolName));
    });
}

/**
 * Populate connection profile dropdowns
 */
function populateConnectionProfiles() {
    const profiles = listConnectionProfiles();
    const select = settingsEl.find('#pf--pipeline-profile');

    select.find('option:not(:first)').remove();

    for (const profile of profiles) {
        select.append(`<option value="${escapeHtml(profile.id)}">${escapeHtml(profile.name || profile.id)}</option>`);
    }

    const s = getPathfinderSettings();
    if (s.connectionProfile) {
        select.val(s.connectionProfile);
    }
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
    const hasSummary = Boolean(summary.content || summary.uid);
    const currentContent = String(textarea.val() || summary.content || '').trim();

    if (document.activeElement !== textarea[0]) {
        textarea.val(summary.content || '');
    }

    textarea.prop('disabled', !hasSummary);
    settingsEl.find('#pf--summary-save').prop('disabled', !hasSummary);
    settingsEl.find('#pf--summary-save-entry').prop('disabled', !currentContent);
    settingsEl.find('#pf--summary-create').toggle(!hasSummary).prop('disabled', hasSummary);

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
    meta.text(`${title} — ${location}. ${updated}. ${injected}.`);
}

function getSummaryEditorDraft() {
    const summary = getSummaryMemoryState();
    const content = String(settingsEl.find('#pf--summary-content').val() || summary.content || '').trim();
    return {
        title: deriveSummaryLorebookTitle({
            title: summary.title,
            content,
            arc: summary.arc,
        }),
        content,
        significance: summary.significance || 'medium',
        arc: summary.arc || '',
        book: summary.bookName || getPathfinderSettings().selectedLorebook || '',
    };
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
    const recentChat = getRecentChatForSummary();
    if (!recentChat) {
        throw new Error('No recent chat messages are available to summarize.');
    }

    const prompt = `Summarize the recent roleplay/chat into durable Pathfinder memory.

Return only a compact JSON object with this shape:
{"title":"short event title","content":"5-8 sentence useful memory summary","significance":"low|medium|high|critical","arc":"optional arc name"}

Recent chat:
${recentChat}`;

    const rawSummary = await sidecarGenerate(
        prompt,
        'You create concise long-term memory summaries for creative roleplay. Preserve names, changed state, unresolved threads, and why the scene matters. Return valid JSON only.',
    );
    const summary = parseGeneratedSummary(rawSummary);

    if (!summary.content) {
        throw new Error('The sidecar model returned an empty summary.');
    }

    return await createSummaryMemoryEntry(summary);
}

/**
 * Bind all event handlers
 */
function bindEvents() {
    settingsEl.find('#pf--quickstart-dismiss').on('click', () => {
        safeSetAccountStorageItem(PATHFINDER_QUICKSTART_DISMISSED_KEY, 'true');
        settingsEl.find('#pf--quickstart').slideUp(180);
    });

    settingsEl.find('#pf--master-enable').on('change', async function () {
        if (!currentAgent) {
            return;
        }

        const enabled = $(this).prop('checked');
        setAgentEnabledForCurrentScope(currentAgent, enabled);
        await saveAgent(currentAgent);
        persistAgentGlobalSettings();
        saveSettingsDebounced();
        updateStatusBanner();
    });

    // Refresh lorebooks
    settingsEl.find('#pf--refresh-lorebooks').on('click', async () => {
        await refreshLorebookList();
        toastr.info('Lorebook list refreshed');
    });

    settingsEl.find('#pf--auto-use-attached').on('change', async function () {
        const enabled = $(this).prop('checked');
        const s = getPathfinderSettings();
        s.autoUseAttachedLorebook = enabled;
        setPathfinderSettings(s);

        if (enabled) {
            await refreshLorebookList();
        }

        updateAgentSettings();
        updateStatusBanner();
    });

    settingsEl.find('#pf--auto-sync-lorebooks').on('change', async function () {
        const enabled = $(this).prop('checked');
        const s = getPathfinderSettings();
        s.autoSyncLorebooksOnChatChange = enabled;
        setPathfinderSettings(s);

        if (enabled) {
            await refreshLorebookList();
        }

        await updateAgentSettings();
        updateStatusBanner();
    });

    // Mode toggles
    settingsEl.find('#pf--enable-tools').on('change', function () {
        const enabled = $(this).prop('checked');
        const s = getPathfinderSettings();
        s.sidecarEnabled = enabled;
        setPathfinderSettings(s);
        updateModeCardStates();
        updateDualModeWarning();
        updateStatusBanner();
        updateAgentSettings();
        syncToolAgentRegistrations();
    });

    settingsEl.find('#pf--enable-pipeline').on('change', function () {
        const enabled = $(this).prop('checked');
        const s = getPathfinderSettings();
        s.pipelineEnabled = enabled;
        // Don't force sidecarEnabled - let user choose both independently
        setPathfinderSettings(s);
        updateModeCardStates();
        updateStatusBanner();
        updateAgentSettings();
    });

    // Pipeline settings
    settingsEl.find('#pf--pipeline-type').on('change', function () {
        const s = getPathfinderSettings();
        s.pipelineId = $(this).val();
        setPathfinderSettings(s);
        updateAgentSettings();
    });

    settingsEl.find('#pf--content-mode').on('change', function () {
        const s = getPathfinderSettings();
        s.entryContentMode = $(this).val();
        setPathfinderSettings(s);
        updateAgentSettings();
    });

    settingsEl.find('#pf--truncate-length').on('change', function () {
        const s = getPathfinderSettings();
        s.truncateLength = parseInt($(this).val()) || 500;
        setPathfinderSettings(s);
        updateAgentSettings();
    });

    settingsEl.find('#pf--max-candidates').on('change', function () {
        const s = getPathfinderSettings();
        s.maxCandidates = parseInt($(this).val()) || 20;
        setPathfinderSettings(s);
        updateAgentSettings();
    });

    settingsEl.find('#pf--retrieval-timeout').on('change', function () {
        const s = getPathfinderSettings();
        s.retrievalTimeoutSeconds = Math.max(1, Math.min(60, parseInt($(this).val()) || 8));
        setPathfinderSettings(s);
        updateAgentSettings();
    });

    settingsEl.find('#pf--pipeline-profile').on('change', function () {
        const s = getPathfinderSettings();
        s.connectionProfile = $(this).val();
        setPathfinderSettings(s);
        updateAgentSettings();
    });

    settingsEl.find('#pf--dedupe-natural-activation').on('change', function () {
        const s = getPathfinderSettings();
        s.dedupeNaturalActivation = $(this).prop('checked');
        setPathfinderSettings(s);
        updateAgentSettings();
    });

    // Memory summary settings
    settingsEl.find('#pf--enable-summarize-tool').on('change', async function () {
        const enabled = $(this).prop('checked');
        setPathfinderToolEnabled('Pathfinder_Summarize', enabled);
        await updateAgentSettings();
        syncToolAgentRegistrations();
    });

    settingsEl.find('#pf--auto-summary').on('change', function () {
        const s = getPathfinderSettings();
        s.autoSummary = $(this).prop('checked');
        if (s.autoSummary) {
            setPathfinderToolEnabled('Pathfinder_Summarize', true);
            settingsEl.find('#pf--enable-summarize-tool').prop('checked', true);
        }
        setPathfinderSettings(s);
        updateAgentSettings();
        syncToolAgentRegistrations();
    });

    settingsEl.find('#pf--auto-summary-interval').on('change', function () {
        const s = getPathfinderSettings();
        s.autoSummaryInterval = normalizeSummaryIntervalInput($(this).val());
        setPathfinderSettings(s);
        updateAgentSettings();
    });

    settingsEl.find('#pf--summary-save').on('click', async () => {
        const status = settingsEl.find('#pf--summary-save-status');
        try {
            await saveSummaryMemoryContent(settingsEl.find('#pf--summary-content').val());
            renderSummaryMemoryEditor();
            status.text('Saved!').removeClass('error').addClass('success');
            setTimeout(() => status.text(''), 3000);
        } catch (err) {
            status.text(`Save failed: ${err.message}`).removeClass('success').addClass('error');
        }
    });

    settingsEl.find('#pf--summary-content').on('input', renderSummaryMemoryEditor);

    settingsEl.find('#pf--summary-save-entry').on('click', async () => {
        const status = settingsEl.find('#pf--summary-save-status');
        const button = settingsEl.find('#pf--summary-save-entry');
        const draft = getSummaryEditorDraft();
        if (!draft.content) {
            status.text('Write or create a summary first.').removeClass('success').addClass('error');
            return;
        }

        button.prop('disabled', true);
        status.text('Saving entry...').removeClass('success error');

        try {
            const result = await createSeparateSummaryMemoryEntry(draft);
            setPathfinderToolEnabled('Pathfinder_Summarize', true);
            settingsEl.find('#pf--enable-summarize-tool').prop('checked', true);
            await updateAgentSettings();
            syncToolAgentRegistrations();
            status.text(`Saved "${result.summaryTitle}"`).removeClass('error').addClass('success');
            setTimeout(() => status.text(''), 4000);
        } catch (err) {
            status.text(`Entry save failed: ${err.message}`).removeClass('success').addClass('error');
        } finally {
            renderSummaryMemoryEditor();
        }
    });

    settingsEl.find('#pf--summary-create').on('click', async () => {
        const status = settingsEl.find('#pf--summary-save-status');
        const button = settingsEl.find('#pf--summary-create');
        button.prop('disabled', true);
        status.text('Creating summary...').removeClass('success error');

        try {
            const result = await createManualSummaryMemory();
            setPathfinderToolEnabled('Pathfinder_Summarize', true);
            settingsEl.find('#pf--enable-summarize-tool').prop('checked', true);
            await updateAgentSettings();
            syncToolAgentRegistrations();
            renderSummaryMemoryEditor();
            status.text(`Created UID ${result.uid}`).removeClass('error').addClass('success');
            setTimeout(() => status.text(''), 3000);
        } catch (err) {
            button.prop('disabled', false);
            status.text(`Create failed: ${err.message}`).removeClass('success').addClass('error');
        }
    });

    // Tool settings
    settingsEl.find('#pf--mandatory-tools').on('change', function () {
        const s = getPathfinderSettings();
        s.mandatoryTools = $(this).prop('checked');
        setPathfinderSettings(s);
        updateAgentSettings();
    });

    settingsEl.on('change', '.pf--tool-list input[data-tool]', async function () {
        const toolName = $(this).data('tool');
        const enabled = $(this).prop('checked');

        setPathfinderToolEnabled(toolName, enabled);

        await updateAgentSettings();
        syncToolAgentRegistrations();
    });

    settingsEl.on('change', '#pf--permission-matrix input[data-permission]', async function () {
        const row = $(this).closest('.pf--permission-row');
        const bookName = row.data('book');
        const permission = $(this).data('permission');
        const enabled = $(this).prop('checked');

        if (!bookName || !permission) {
            return;
        }

        setBookPermission(bookName, permission, enabled ? 'readwrite' : 'none');
        await updateAgentSettings();
    });

    // Collapsible sections
    settingsEl.find('.pf--collapsible-header').on('click', function () {
        const section = $(this).closest('.pf--section-collapsible');
        const body = section.children('.pf--section-body').first();
        const willOpen = !body.is(':visible');

        body.slideToggle(200);
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
            let text = '';

            for (const [key, value] of Object.entries(results)) {
                const icon = value.ok ? '✓' : '✗';
                text += `${icon} ${key}: ${value.message}\n`;
            }

            output.text(text || 'All checks passed!');
        } catch (err) {
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
    const banner = settingsEl.find('#pf--status-banner');
    const s = getPathfinderSettings();
    const activeBooks = getActiveLorebookNames(s);
    const hasBooks = activeBooks.length > 0;
    const hasMode = s.sidecarEnabled || s.pipelineEnabled;
    const masterEnabled = currentAgent ? isAgentEnabledForCurrentScope(currentAgent) : false;

    if (hasBooks && hasMode && !masterEnabled) {
        banner.removeClass('pf--status-ready').addClass('pf--status-disabled');
        banner.find('.pf--status-icon i').removeClass('fa-circle-check').addClass('fa-circle-xmark');
        banner.find('.pf--status-text strong').text('Pathfinder is disabled');
        banner.find('.pf--status-text span').text('Enable Pathfinder above to use the current setup');
    } else if (hasBooks && hasMode) {
        banner.removeClass('pf--status-disabled').addClass('pf--status-ready');
        banner.find('.pf--status-icon i').removeClass('fa-circle-xmark').addClass('fa-circle-check');
        banner.find('.pf--status-text strong').text('Pathfinder is ready');
        banner.find('.pf--status-text span').text(`${activeBooks.length} lorebook(s) available`);
    } else if (hasBooks) {
        banner.removeClass('pf--status-disabled').addClass('pf--status-ready');
        banner.find('.pf--status-icon i').removeClass('fa-circle-xmark').addClass('fa-circle-check');
        banner.find('.pf--status-text strong').text('Lorebooks selected');
        banner.find('.pf--status-text span').text('Enable Tool Mode or Pipeline Mode above');
    } else {
        banner.removeClass('pf--status-ready').addClass('pf--status-disabled');
        banner.find('.pf--status-icon i').removeClass('fa-circle-check').addClass('fa-circle-xmark');
        banner.find('.pf--status-text strong').text('Pathfinder is not configured');
        banner.find('.pf--status-text span').text('Select at least one lorebook below to get started');
    }
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
    const s = getPathfinderSettings();

    const toolEnabled = Boolean(s.sidecarEnabled);
    const pipelineEnabled = Boolean(s.pipelineEnabled);
    const toolCard = settingsEl.find('.pf--mode-card[data-mode="tools"]');
    const pipelineCard = settingsEl.find('.pf--mode-card[data-mode="pipeline"]');

    settingsEl.find('#pf--enable-tools').prop('checked', toolEnabled);
    settingsEl.find('#pf--enable-pipeline').prop('checked', pipelineEnabled);

    toolCard.toggleClass('active', toolEnabled);
    pipelineCard.toggleClass('active', pipelineEnabled);

    // Show/hide settings sections
    settingsEl.find('#pf--tool-settings').toggle(toolEnabled);
    settingsEl.find('#pf--pipeline-settings').toggle(pipelineEnabled);
    settingsEl.find('#pf--prompt-editor-section').toggle(pipelineEnabled);

    // Update dual-mode warning
    updateDualModeWarning();
}

/**
 * Show/hide warning when both modes are enabled
 */
function updateDualModeWarning() {
    const s = getPathfinderSettings();
    const bothEnabled = s.sidecarEnabled && s.pipelineEnabled;
    settingsEl.find('#pf--dual-mode-warning').toggle(bothEnabled);
}

/**
 * Update agent settings object and trigger save
 */
async function updateAgentSettings() {
    if (!currentAgent) return;

    const s = getPathfinderSettings();
    currentAgent.settings = { ...s };

    await saveAgent(currentAgent);
    persistAgentGlobalSettings();
    saveSettingsDebounced();
}

/**
 * Load a prompt into the editor
 */
function loadPromptIntoEditor(promptId) {
    const prompt = getPrompt(promptId);
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
    const promptId = settingsEl.find('#pf--prompt-selector').val();
    if (!promptId) return;

    const prompt = getPrompt(promptId);
    if (!prompt) return;

    prompt.systemPrompt = settingsEl.find('#pf--prompt-system').val();
    prompt.userPromptTemplate = settingsEl.find('#pf--prompt-user').val();
    prompt.settings = {
        ...(prompt.settings || {}),
        maxTokens: readPromptMaxTokens(),
    };

    savePrompt(prompt);
    await updateAgentSettings();
    showPromptStatus('Saved!', 'success');
}

/**
 * Reset the current prompt to default
 */
async function resetCurrentPrompt() {
    const promptId = settingsEl.find('#pf--prompt-selector').val();
    if (!promptId) return;

    const defaults = getDefaultPrompts();
    const defaultPrompt = defaults[promptId];

    if (!defaultPrompt) {
        showPromptStatus('No default available', 'error');
        return;
    }

    savePrompt({ ...defaultPrompt, isDefault: true });
    await updateAgentSettings();
    loadPromptIntoEditor(promptId);
    showPromptStatus('Reset to default', 'success');
}

function showPromptStatus(message, type) {
    const status = settingsEl.find('#pf--prompt-status');
    status.text(message).removeClass('success error').addClass(type);
    setTimeout(() => status.text(''), 3000);
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
