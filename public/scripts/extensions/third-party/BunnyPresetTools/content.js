import {
    chat_metadata,
    eventSource,
    event_types,
    getCurrentChatId,
    saveSettingsDebounced,
} from '../../../../script.js';
import { extension_settings, saveMetadataDebounced } from '../../../extensions.js';
import { background_settings } from '../../../backgrounds.js';
import { promptManager } from '../../../openai.js';
import { power_user } from '../../../power-user.js';
import {
    buildSectionBlocks,
    computeReorderedOrder,
    getSectionLockState,
    setSectionLockState,
    stripDividerPrefix,
} from './sectionOrder.js';

const EXTENSION_NAME = 'BunnyPresetTools';
const LEGACY_EXTENSION_NAME = 'NemoPresetExt';
const BUILT_IN_DIVIDER_PATTERNS = ['=+', '-{3,}', '\\*{3,}', '(?:[^\\w\\s]+\\s*)?[─━—-]\\+'];
const VIDEO_EXTENSIONS = new Set(['mp4', 'webm', 'ogv', 'm4v']);
const BACKGROUND_LOCK_KEY = 'custom_background';
const SECTION_DRAG_HOLD_MS = 2500;
const SECTION_DRAG_MOVE_THRESHOLD_PX = 8;

let promptListElement = null;
let promptListObserver = null;
let promptContainerElement = null;
let promptContainerObserver = null;
let promptRefreshTimer = null;
let promptRefreshFrame = null;
let isRefreshingPromptSections = false;

let settingsContainerElement = null;
let settingsContainerObserver = null;

let backgroundLayerElement = null;
let backgroundMutationObserver = null;
let backgroundCardObserversAttached = false;
let backgroundSyncTimer = null;
let backgroundLifecycleHandlersAttached = false;
let legacySettingsMigrationChecked = false;
let activeSectionDrag = null;
let sectionDropIndicator = null;
let suppressSectionToggleUntil = 0;

function migrateLegacySettings() {
    if (legacySettingsMigrationChecked) {
        return;
    }

    legacySettingsMigrationChecked = true;

    const legacySettings = extension_settings[LEGACY_EXTENSION_NAME];
    if (!legacySettings || typeof legacySettings !== 'object') {
        return;
    }

    const currentSettings = extension_settings[EXTENSION_NAME];
    extension_settings[EXTENSION_NAME] = currentSettings && typeof currentSettings === 'object'
        ? { ...legacySettings, ...currentSettings }
        : { ...legacySettings };
    delete extension_settings[LEGACY_EXTENSION_NAME];
    saveSettingsDebounced();
}

function ensureSettings() {
    migrateLegacySettings();

    if (!extension_settings[EXTENSION_NAME] || typeof extension_settings[EXTENSION_NAME] !== 'object') {
        extension_settings[EXTENSION_NAME] = {};
    }

    const settings = extension_settings[EXTENSION_NAME];

    if (typeof settings.enablePromptSections !== 'boolean') {
        settings.enablePromptSections = true;
    }
    if (typeof settings.dividerRegexPattern !== 'string') {
        settings.dividerRegexPattern = '';
    }
    if (!settings.promptSectionStates || typeof settings.promptSectionStates !== 'object') {
        settings.promptSectionStates = {};
    }
    if (!settings.promptSectionLocks || typeof settings.promptSectionLocks !== 'object') {
        settings.promptSectionLocks = {};
    }
    if (!settings.openSectionStates || typeof settings.openSectionStates !== 'object') {
        settings.openSectionStates = {};
    }
    if (typeof settings.settingsPanelExpanded !== 'boolean') {
        settings.settingsPanelExpanded = false;
    }
    if (typeof settings.enableAnimatedBackgrounds !== 'boolean') {
        settings.enableAnimatedBackgrounds = true;
    }
    if (typeof settings.animatedBackgroundMuted !== 'boolean') {
        settings.animatedBackgroundMuted = true;
    }
    if (typeof settings.animatedBackgroundLoop !== 'boolean') {
        settings.animatedBackgroundLoop = true;
    }
    if (typeof settings.animatedBackgroundAutoplay !== 'boolean') {
        settings.animatedBackgroundAutoplay = true;
    }
    if (typeof settings.animatedBackgroundShowControls !== 'boolean') {
        settings.animatedBackgroundShowControls = false;
    }
    if (typeof settings.animatedBackgroundVolume !== 'number') {
        settings.animatedBackgroundVolume = 15;
    }
    if (!Array.isArray(settings.savedAnimatedSources)) {
        settings.savedAnimatedSources = [];
    }

    return settings;
}

function bootstrap() {
    ensureSettings();
    injectSettingsPanel();
    attachPromptEnhancer();
    attachBackgroundEnhancer();
}

function watchSettingsContainer() {
    const nextSettingsContainer = document.getElementById('extensions_settings');
    if (!nextSettingsContainer || nextSettingsContainer === settingsContainerElement) {
        return;
    }

    settingsContainerElement = nextSettingsContainer;

    if (settingsContainerObserver) {
        settingsContainerObserver.disconnect();
    }

    settingsContainerObserver = new MutationObserver(() => {
        if (!document.getElementById('bpt-settings')) {
            injectSettingsPanel();
        }
    });

    settingsContainerObserver.observe(settingsContainerElement, {
        childList: true,
        subtree: true,
    });
}

function watchPromptContainer() {
    const nextPromptContainer = document.getElementById(promptManager?.configuration?.containerIdentifier || 'completion_prompt_manager');
    if (!nextPromptContainer || nextPromptContainer === promptContainerElement) {
        return;
    }

    promptContainerElement = nextPromptContainer;

    if (promptContainerObserver) {
        promptContainerObserver.disconnect();
    }

    promptContainerObserver = new MutationObserver(() => {
        const currentPromptList = document.querySelector('#completion_prompt_manager_list');
        if (!currentPromptList || currentPromptList === promptListElement) {
            return;
        }

        attachPromptEnhancer();
    });

    promptContainerObserver.observe(promptContainerElement, {
        childList: true,
        subtree: true,
    });
}

function attachPromptEnhancer() {
    watchPromptContainer();

    const nextPromptList = document.querySelector('#completion_prompt_manager_list');
    if (!nextPromptList || nextPromptList === promptListElement) {
        return;
    }

    promptListElement = nextPromptList;
    injectPromptToolbar(promptListElement);

    if (promptListObserver) {
        promptListObserver.disconnect();
    }

    promptListObserver = new MutationObserver((mutations) => {
        if (isRefreshingPromptSections) {
            return;
        }

        // Ignore mutations caused by our own section rows
        const isOwnMutation = mutations.every(m =>
            Array.from(m.addedNodes).concat(Array.from(m.removedNodes)).every(n =>
                n instanceof HTMLElement && (n.classList?.contains('bpt-section-row') || n.classList?.contains('bpt-divider-row')),
            ),
        );
        if (isOwnMutation) {
            return;
        }

        schedulePromptRefresh();
    });

    promptListObserver.observe(promptListElement, {
        childList: true,
        subtree: true,
    });

    schedulePromptRefresh();
}

function schedulePromptRefresh() {
    if (!promptListElement) {
        return;
    }

    if (promptRefreshTimer !== null) {
        clearTimeout(promptRefreshTimer);
        promptRefreshTimer = null;
    }

    if (promptRefreshFrame !== null) {
        cancelAnimationFrame(promptRefreshFrame);
    }

    // Refresh on the next frame so Prompt Manager can finish its DOM rebuild
    // without letting the raw divider prompt flash on screen.
    promptRefreshFrame = requestAnimationFrame(() => {
        promptRefreshFrame = null;
        refreshPromptSections();
    });

    // Prompt Manager can do a follow-up rebuild shortly after the first paint.
    // Run one delayed pass as well so section headers survive that second render.
    promptRefreshTimer = window.setTimeout(() => {
        promptRefreshTimer = null;
        refreshPromptSections();
    }, 140);
}

function injectPromptToolbar(promptList) {
    if (!promptList || document.getElementById('bpt-prompt-toolbar')) {
        return;
    }

    const toolbar = document.createElement('div');
    toolbar.id = 'bpt-prompt-toolbar';
    toolbar.innerHTML = `
        <input id="bpt-prompt-search" class="text_pole" type="search" placeholder="Search prompts by name or content">
        <div class="bpt-toolbar-actions">
            <button id="bpt-prompt-clear" class="menu_button menu_button_icon" type="button" title="Clear search">
                <i class="fa-solid fa-xmark"></i>
            </button>
            <button id="bpt-prompt-toggle" class="menu_button menu_button_icon" type="button" title="Toggle collapsible sections">
                <i class="fa-solid fa-layer-group"></i>
            </button>
            <button id="bpt-prompt-collapse" class="menu_button menu_button_icon" type="button" title="Collapse all sections">
                <i class="fa-solid fa-angles-up"></i>
            </button>
            <button id="bpt-prompt-expand" class="menu_button menu_button_icon" type="button" title="Expand all sections">
                <i class="fa-solid fa-angles-down"></i>
            </button>
        </div>
    `;

    promptList.parentElement.insertBefore(toolbar, promptList);

    toolbar.querySelector('#bpt-prompt-search').addEventListener('input', schedulePromptRefresh);
    toolbar.querySelector('#bpt-prompt-clear').addEventListener('click', () => {
        toolbar.querySelector('#bpt-prompt-search').value = '';
        schedulePromptRefresh();
    });
    toolbar.querySelector('#bpt-prompt-toggle').addEventListener('click', () => {
        const settings = ensureSettings();
        settings.enablePromptSections = !settings.enablePromptSections;
        saveSettingsDebounced();
        schedulePromptRefresh();
        syncSettingsPanel();
    });
    toolbar.querySelector('#bpt-prompt-collapse').addEventListener('click', () => {
        const settings = ensureSettings();
        const sections = Array.from(promptList.querySelectorAll('.bpt-section-row'));
        sections.forEach(section => {
            const sectionName = section.dataset.sectionName || section.dataset.sectionId;
            if (!getSectionLockState(settings, section.dataset.sectionId, sectionName)) {
                setPromptSectionOpenState(settings, section.dataset.sectionId, sectionName, false);
            }
        });
        saveSettingsDebounced();
        schedulePromptRefresh();
    });
    toolbar.querySelector('#bpt-prompt-expand').addEventListener('click', () => {
        const settings = ensureSettings();
        const sections = Array.from(promptList.querySelectorAll('.bpt-section-row'));
        sections.forEach(section => {
            const sectionName = section.dataset.sectionName || section.dataset.sectionId;
            if (!getSectionLockState(settings, section.dataset.sectionId, sectionName)) {
                setPromptSectionOpenState(settings, section.dataset.sectionId, sectionName, true);
            }
        });
        saveSettingsDebounced();
        schedulePromptRefresh();
    });
}

function getPromptSearchQuery() {
    return String(document.getElementById('bpt-prompt-search')?.value || '').trim().toLowerCase();
}

function getPromptRows() {
    if (!promptListElement) {
        return [];
    }

    return Array.from(promptListElement.querySelectorAll(':scope > li.completion_prompt_manager_prompt[data-pm-identifier]'));
}

function getPromptRowName(row) {
    const promptName = String(getPromptRowData(row)?.name || '').trim();
    if (promptName) {
        return promptName;
    }

    const inspectLink = row.querySelector('.prompt-manager-inspect-action');
    if (inspectLink) {
        return String(inspectLink.getAttribute('title') || inspectLink.textContent || '').trim();
    }

    const nameContainer = row.querySelector('.completion_prompt_manager_prompt_name');
    return String(nameContainer?.textContent || '').trim();
}

function getPromptRowData(row) {
    const identifier = row.dataset.pmIdentifier;
    return identifier ? promptManager?.getPromptById?.(identifier) : null;
}

function hasPromptRowContent(row) {
    return String(getPromptRowData(row)?.content || '').trim().length > 0;
}

function getPromptSearchText(row) {
    const prompt = getPromptRowData(row);
    return `${getPromptRowName(row)}\n${prompt?.content || ''}`.toLowerCase();
}

function buildDividerRegex() {
    const settings = ensureSettings();
    const customPatterns = String(settings.dividerRegexPattern || '')
        .split(',')
        .map(pattern => pattern.trim())
        .filter(Boolean);
    const allPatterns = [...new Set([
        ...BUILT_IN_DIVIDER_PATTERNS,
        ...customPatterns,
        ...customPatterns.map(escapeRegex),
    ])];

    try {
        return new RegExp(`^(${allPatterns.join('|')})`, 'u');
    } catch (error) {
        console.warn('[BunnyPresetTools] Invalid divider regex, falling back to built-ins.', error);
        return new RegExp(`^(${BUILT_IN_DIVIDER_PATTERNS.join('|')})`, 'u');
    }
}

function escapeRegex(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function getPromptSectionOpenState(settings, sectionId, sectionName) {
    const stateById = settings.promptSectionStates?.[sectionId];
    const stateByName = settings.openSectionStates?.[sectionName];
    const legacyStateByName = settings.promptSectionStates?.[sectionName];

    // Prefer the section id when available, then the dedicated name-based store.
    // This prevents stale legacy name entries from snapping a section shut after re-renders.
    const resolvedState = typeof stateById === 'boolean'
        ? stateById
        : typeof stateByName === 'boolean'
            ? stateByName
            : typeof legacyStateByName === 'boolean'
                ? legacyStateByName
                : true;

    settings.promptSectionStates[sectionId] = resolvedState;
    settings.promptSectionStates[sectionName] = resolvedState;
    settings.openSectionStates[sectionName] = resolvedState;

    return resolvedState;
}

function setPromptSectionOpenState(settings, sectionId, sectionName, isOpen) {
    settings.promptSectionStates[sectionId] = isOpen;
    settings.promptSectionStates[sectionName] = isOpen;
    settings.openSectionStates[sectionName] = isOpen;
}

function isDividerPrompt(promptName, dividerRegex, _settings) {
    return dividerRegex.test(promptName);
}

function cleanupPromptSections() {
    if (!promptListElement) {
        return;
    }

    promptListElement.querySelectorAll('.bpt-section-row').forEach(row => row.remove());

    getPromptRows().forEach(row => {
        row.classList.remove('bpt-section-item', 'bpt-divider-row', 'bpt-divider-source', 'bpt-divider-structural');
        row.style.display = '';
        delete row.dataset.sectionId;
    });
}

function applySectionRowStyles(row, isOpen) {
    if (!(row instanceof HTMLElement)) {
        return;
    }

    const isLocked = row.classList.contains('is-locked');

    row.style.setProperty('display', 'grid', 'important');
    row.style.setProperty('width', '100%', 'important');
    row.style.gridTemplateColumns = 'minmax(0, 1fr) auto';
    row.style.alignItems = 'stretch';
    row.style.setProperty('min-height', '48px', 'important');
    row.style.boxSizing = 'border-box';
    row.style.padding = '0';
    row.style.margin = '8px 0 4px';
    row.style.listStyle = 'none';
    row.style.overflow = 'hidden';
    row.style.position = 'relative';
    row.style.isolation = 'isolate';
    row.style.border = '1px solid color-mix(in srgb, var(--SmartThemeBorderColor) 80%, transparent)';
    row.style.borderRadius = '14px';
    row.style.background = 'color-mix(in srgb, var(--SmartThemeBlurTintColor) 88%, transparent)';
    row.style.opacity = isOpen ? '1' : '0.92';

    const trigger = row.querySelector('.bpt-section-trigger');
    if (trigger instanceof HTMLElement) {
        trigger.style.setProperty('display', 'flex', 'important');
        trigger.style.setProperty('align-items', 'center', 'important');
        trigger.style.setProperty('width', '100%', 'important');
        trigger.style.setProperty('grid-column', '1', 'important');
        trigger.style.setProperty('min-height', '48px', 'important');
        trigger.style.setProperty('gap', '10px', 'important');
        trigger.style.setProperty('padding', '10px 12px', 'important');
        trigger.style.border = '0';
        trigger.style.borderRadius = '14px 0 0 14px';
        trigger.style.background = 'transparent';
        trigger.style.color = 'inherit';
        trigger.style.font = 'inherit';
        trigger.style.textAlign = 'left';
        trigger.style.cursor = isLocked ? 'default' : 'pointer';
        trigger.style.touchAction = 'manipulation';
        trigger.style.appearance = 'none';
        trigger.style.webkitAppearance = 'none';
    }

    const toggle = row.querySelector('.bpt-section-toggle');
    if (toggle instanceof HTMLElement) {
        toggle.style.display = 'flex';
        toggle.style.flex = '0 0 auto';
        toggle.style.alignItems = 'center';
        toggle.style.justifyContent = 'center';
        toggle.style.width = '28px';
        toggle.style.height = '28px';
        toggle.style.borderRadius = '999px';
        toggle.style.background = 'color-mix(in srgb, var(--SmartThemeQuoteColor) 22%, transparent)';
        toggle.style.color = 'var(--SmartThemeBodyColor)';
    }

    const title = row.querySelector('.bpt-section-title');
    if (title instanceof HTMLElement) {
        title.style.flex = '1 1 auto';
        title.style.fontWeight = '700';
        title.style.letterSpacing = '0.01em';
    }

    const count = row.querySelector('.bpt-section-count');
    if (count instanceof HTMLElement) {
        count.style.color = 'var(--SmartThemeEmColor)';
        count.style.fontSize = '0.9em';
        count.style.whiteSpace = 'nowrap';
    }

    const lockButton = row.querySelector('.bpt-section-lock');
    if (lockButton instanceof HTMLElement) {
        lockButton.style.display = 'flex';
        lockButton.style.alignItems = 'center';
        lockButton.style.justifyContent = 'center';
        lockButton.style.alignSelf = 'stretch';
        lockButton.style.minWidth = '46px';
        lockButton.style.minHeight = '48px';
        lockButton.style.padding = '0 12px';
        lockButton.style.border = '0';
        lockButton.style.borderLeft = '1px solid color-mix(in srgb, var(--SmartThemeBorderColor) 72%, transparent)';
        lockButton.style.borderRadius = '0 14px 14px 0';
        lockButton.style.background = isLocked
            ? 'color-mix(in srgb, var(--SmartThemeQuoteColor) 20%, transparent)'
            : 'color-mix(in srgb, var(--SmartThemeBlurTintColor) 52%, transparent)';
        lockButton.style.color = isLocked ? 'var(--SmartThemeBodyColor)' : 'var(--SmartThemeEmColor)';
        lockButton.style.cursor = 'pointer';
        lockButton.style.touchAction = 'manipulation';
        lockButton.style.appearance = 'none';
        lockButton.style.webkitAppearance = 'none';
    }
}

function getSectionRowsForDrag() {
    if (!promptListElement) {
        return [];
    }

    return Array.from(promptListElement.querySelectorAll(':scope > li.bpt-section-row'))
        .filter(row => row instanceof HTMLElement && row.style.display !== 'none' && row.getClientRects().length > 0);
}

function ensureSectionDropIndicator() {
    if (!sectionDropIndicator) {
        sectionDropIndicator = document.createElement('li');
        sectionDropIndicator.className = 'bpt-drop-indicator';
        sectionDropIndicator.setAttribute('aria-hidden', 'true');
        sectionDropIndicator.setAttribute('role', 'presentation');
    }

    return sectionDropIndicator;
}

function clearSectionDropIndicator() {
    sectionDropIndicator?.remove();
    sectionDropIndicator = null;
}

function clearSectionDropTarget() {
    promptListElement?.querySelectorAll('.bpt-section-drop-target').forEach(row => {
        row.classList.remove('bpt-section-drop-target');
    });
}

function placeSectionDropIndicator(targetSectionId) {
    if (!promptListElement || !activeSectionDrag?.isDragging) {
        return;
    }

    const indicator = ensureSectionDropIndicator();
    const rows = getSectionRowsForDrag().filter(row => row !== activeSectionDrag.row);
    const targetRow = targetSectionId
        ? rows.find(row => row.dataset.sectionId === targetSectionId)
        : null;

    clearSectionDropTarget();

    if (targetRow) {
        targetRow.classList.add('bpt-section-drop-target');
        promptListElement.insertBefore(indicator, targetRow);
        return;
    }

    promptListElement.append(indicator);
}

function resolveSectionDropTarget(clientX, clientY) {
    const rows = getSectionRowsForDrag().filter(row => row !== activeSectionDrag?.row);
    if (!rows.length) {
        return null;
    }

    const rowAtPoint = document.elementsFromPoint?.(clientX, clientY)
        .map(element => element.closest?.('.bpt-section-row'))
        .find(row => row instanceof HTMLElement && row !== activeSectionDrag?.row && rows.includes(row));

    if (rowAtPoint) {
        const rect = rowAtPoint.getBoundingClientRect();
        if (clientY <= rect.top + rect.height / 2) {
            return rowAtPoint.dataset.sectionId || null;
        }

        const nextRow = rows[rows.indexOf(rowAtPoint) + 1];
        return nextRow?.dataset.sectionId || null;
    }

    for (const row of rows) {
        const rect = row.getBoundingClientRect();
        if (clientY <= rect.top + rect.height / 2) {
            return row.dataset.sectionId || null;
        }
    }

    return null;
}

function updateSectionDropTarget(clientX, clientY) {
    if (!activeSectionDrag?.isDragging) {
        return;
    }

    const targetSectionId = resolveSectionDropTarget(clientX, clientY);
    activeSectionDrag.dropTargetSectionId = targetSectionId;
    placeSectionDropIndicator(targetSectionId);
}

function hasSamePromptOrder(previousOrder, nextOrder) {
    if (!Array.isArray(previousOrder) || !Array.isArray(nextOrder) || previousOrder.length !== nextOrder.length) {
        return false;
    }

    return previousOrder.every((entry, index) => entry?.identifier === nextOrder[index]?.identifier);
}

function commitSectionReorder(fromSectionId, toSectionId) {
    const activeCharacter = promptManager?.activeCharacter;
    const promptOrder = promptManager?.getPromptOrderForCharacter?.(activeCharacter);

    if (!promptListElement || !activeCharacter || !Array.isArray(promptOrder)) {
        return false;
    }

    const rows = Array.from(promptListElement.querySelectorAll(':scope > li.bpt-section-row, :scope > li.completion_prompt_manager_prompt[data-pm-identifier]'));
    const blocks = buildSectionBlocks(rows);
    const updatedPromptOrder = computeReorderedOrder(promptOrder, blocks, fromSectionId, toSectionId);

    if (hasSamePromptOrder(promptOrder, updatedPromptOrder)) {
        return false;
    }

    promptManager.removePromptOrderForCharacter(activeCharacter);
    promptManager.addPromptOrderForCharacter(activeCharacter, updatedPromptOrder);
    promptManager.log?.(`Prompt sections reordered for ${activeCharacter.name}.`);

    const renderUpdatedOrder = () => {
        promptManager.render?.(false);
        schedulePromptRefresh();
    };
    const saveResult = promptManager.saveServiceSettings?.();

    if (saveResult?.then) {
        saveResult.then(renderUpdatedOrder).catch(error => {
            console.warn('[BunnyPresetTools] Failed to save section reorder.', error);
            renderUpdatedOrder();
        });
    } else {
        saveSettingsDebounced();
        renderUpdatedOrder();
    }

    return true;
}

function removeSectionDragListeners() {
    document.removeEventListener('pointermove', handleSectionDragPointerMove, true);
    document.removeEventListener('pointerup', handleSectionDragPointerUp, true);
    document.removeEventListener('pointercancel', handleSectionDragPointerCancel, true);
    document.removeEventListener('contextmenu', handleSectionDragContextMenu, true);
}

function finishSectionDrag({ suppressClick = false } = {}) {
    if (!activeSectionDrag) {
        return;
    }

    window.clearTimeout(activeSectionDrag.holdTimer);
    removeSectionDragListeners();

    if (suppressClick || activeSectionDrag.isDragging) {
        suppressSectionToggleUntil = Date.now() + 450;
    }

    activeSectionDrag.row.classList.remove('bpt-section-dragging');
    activeSectionDrag.trigger?.removeAttribute('aria-grabbed');
    promptListElement?.classList.remove('bpt-section-reordering');
    clearSectionDropTarget();
    clearSectionDropIndicator();

    try {
        activeSectionDrag.trigger?.releasePointerCapture?.(activeSectionDrag.pointerId);
    } catch {
        // Pointer capture may already be released by the browser.
    }

    activeSectionDrag = null;
}

function beginSectionDrag() {
    if (!activeSectionDrag || activeSectionDrag.isDragging) {
        return;
    }

    const settings = ensureSettings();
    if (getSectionLockState(settings, activeSectionDrag.sectionId, activeSectionDrag.sectionName) || power_user.prompt_manager_drag_locked) {
        finishSectionDrag();
        return;
    }

    activeSectionDrag.isDragging = true;
    activeSectionDrag.row.classList.add('bpt-section-dragging');
    activeSectionDrag.trigger?.setAttribute('aria-grabbed', 'true');
    promptListElement?.classList.add('bpt-section-reordering');

    try {
        activeSectionDrag.trigger?.setPointerCapture?.(activeSectionDrag.pointerId);
    } catch {
        // Pointer capture is a progressive enhancement for this reorder gesture.
    }

    updateSectionDropTarget(activeSectionDrag.lastX, activeSectionDrag.lastY);
}

function armSectionDrag(event, row, sectionId, sectionName) {
    if (!(event instanceof PointerEvent) || !event.isPrimary || (event.button !== undefined && event.button !== 0)) {
        return;
    }

    const settings = ensureSettings();
    if (getSectionLockState(settings, sectionId, sectionName) || power_user.prompt_manager_drag_locked || !promptManager?.activeCharacter) {
        return;
    }

    finishSectionDrag();

    activeSectionDrag = {
        row,
        trigger: event.currentTarget instanceof HTMLElement ? event.currentTarget : row.querySelector('.bpt-section-trigger'),
        sectionId,
        sectionName,
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        lastX: event.clientX,
        lastY: event.clientY,
        dropTargetSectionId: sectionId,
        holdTimer: window.setTimeout(beginSectionDrag, SECTION_DRAG_HOLD_MS),
        isDragging: false,
    };

    document.addEventListener('pointermove', handleSectionDragPointerMove, true);
    document.addEventListener('pointerup', handleSectionDragPointerUp, true);
    document.addEventListener('pointercancel', handleSectionDragPointerCancel, true);
    document.addEventListener('contextmenu', handleSectionDragContextMenu, true);
}

function handleSectionDragPointerMove(event) {
    if (!activeSectionDrag || event.pointerId !== activeSectionDrag.pointerId) {
        return;
    }

    activeSectionDrag.lastX = event.clientX;
    activeSectionDrag.lastY = event.clientY;

    const distance = Math.hypot(event.clientX - activeSectionDrag.startX, event.clientY - activeSectionDrag.startY);
    if (!activeSectionDrag.isDragging && distance > SECTION_DRAG_MOVE_THRESHOLD_PX) {
        finishSectionDrag();
        return;
    }

    if (activeSectionDrag.isDragging) {
        event.preventDefault();
        event.stopPropagation();
        updateSectionDropTarget(event.clientX, event.clientY);
    }
}

function handleSectionDragPointerUp(event) {
    if (!activeSectionDrag || event.pointerId !== activeSectionDrag.pointerId) {
        return;
    }

    if (!activeSectionDrag.isDragging) {
        finishSectionDrag();
        return;
    }

    event.preventDefault();
    event.stopPropagation();

    const { sectionId, dropTargetSectionId } = activeSectionDrag;
    commitSectionReorder(sectionId, dropTargetSectionId);
    finishSectionDrag({ suppressClick: true });
}

function handleSectionDragPointerCancel(event) {
    if (!activeSectionDrag || event.pointerId !== activeSectionDrag.pointerId) {
        return;
    }

    finishSectionDrag({ suppressClick: activeSectionDrag.isDragging });
}

function handleSectionDragContextMenu(event) {
    if (!activeSectionDrag) {
        return;
    }

    event.preventDefault();
    if (!activeSectionDrag.isDragging) {
        finishSectionDrag();
    }
}

function createSectionRow(sectionId, title, sectionName, isOpen, isLocked) {
    const row = document.createElement('li');
    row.className = `bpt-section-row ${isOpen ? '' : 'is-collapsed'} ${isLocked ? 'is-locked' : 'is-unlocked'}`.trim();
    row.dataset.sectionId = sectionId;
    row.dataset.sectionName = sectionName;
    const triggerTitle = isLocked
        ? 'Unlock this section before changing its open state or position.'
        : power_user.prompt_manager_drag_locked
            ? 'Tap to open or close. Unlock Prompt Manager reordering to move this section.'
            : 'Tap to open or close. Hold for 2.5 seconds to move this section.';
    row.innerHTML = `
        <button class="bpt-section-trigger" type="button" aria-expanded="${String(isOpen)}" aria-disabled="${String(isLocked)}" aria-label="Toggle section">
            <span class="bpt-section-toggle" aria-hidden="true">
                <i class="fa-solid ${isOpen ? 'fa-chevron-down' : 'fa-chevron-right'}"></i>
            </span>
            <span class="bpt-section-title"></span>
            <span class="bpt-section-count"></span>
        </button>
        <button class="bpt-section-lock" type="button" aria-pressed="${String(isLocked)}" aria-label="Toggle section lock">
            <i class="fa-solid ${isLocked ? 'fa-lock' : 'fa-unlock'}" aria-hidden="true"></i>
        </button>
    `;
    applySectionRowStyles(row, isOpen);
    row.querySelector('.bpt-section-title').textContent = title;
    const toggleSection = () => {
        const settings = ensureSettings();
        if (getSectionLockState(settings, sectionId, sectionName)) {
            return;
        }

        const nextIsOpen = !getPromptSectionOpenState(settings, sectionId, sectionName);
        setPromptSectionOpenState(settings, sectionId, sectionName, nextIsOpen);
        saveSettingsDebounced();
        schedulePromptRefresh();
    };

    const trigger = row.querySelector('.bpt-section-trigger');
    trigger.setAttribute('aria-label', `Toggle ${title}`);
    trigger.setAttribute('title', triggerTitle);
    let lastToggleAt = 0;
    const activateTrigger = event => {
        event.preventDefault();
        event.stopPropagation();

        if (Date.now() < suppressSectionToggleUntil) {
            return;
        }

        const now = Date.now();
        if (now - lastToggleAt < 180) {
            return;
        }

        lastToggleAt = now;
        toggleSection();
    };
    trigger.addEventListener('pointerdown', event => armSectionDrag(event, row, sectionId, sectionName));
    trigger.addEventListener('click', activateTrigger);
    trigger.addEventListener('touchend', activateTrigger);

    const lockButton = row.querySelector('.bpt-section-lock');
    const lockLabel = isLocked ? `Unlock ${title} section` : `Lock ${title} section open or closed`;
    lockButton.setAttribute('aria-label', lockLabel);
    lockButton.setAttribute('title', lockLabel);
    let lastLockToggleAt = 0;
    const activateLockButton = event => {
        event.preventDefault();
        event.stopPropagation();

        const now = Date.now();
        if (now - lastLockToggleAt < 180) {
            return;
        }

        lastLockToggleAt = now;

        const settings = ensureSettings();
        const nextLocked = !getSectionLockState(settings, sectionId, sectionName);
        setSectionLockState(settings, sectionId, sectionName, nextLocked);
        saveSettingsDebounced();
        schedulePromptRefresh();
    };
    lockButton.addEventListener('click', activateLockButton);
    lockButton.addEventListener('touchend', activateLockButton);
    return row;
}

function refreshPromptSections() {
    if (!promptListElement || isRefreshingPromptSections) {
        return;
    }

    isRefreshingPromptSections = true;

    // Disconnect observer during DOM changes to prevent feedback loops
    if (promptListObserver) {
        promptListObserver.disconnect();
    }

    // SillyBunny: Keep PromptManager's scroller anchored while rebuilding section rows.
    const scrollContainer = promptListElement.closest('.sb-shell-panel-scroller, .scrollableInner');
    const savedScrollTop = scrollContainer?.scrollTop ?? 0;

    try {
        cleanupPromptSections();

        const settings = ensureSettings();
        const query = getPromptSearchQuery();
        const rows = getPromptRows();

        if (!settings.enablePromptSections) {
            rows.forEach(row => {
                const matches = !query || getPromptSearchText(row).includes(query);
                row.style.display = matches ? '' : 'none';
            });
            return;
        }

        const dividerRegex = buildDividerRegex();
        const sections = [];
        let currentSection = null;

        rows.forEach(row => {
            const promptName = getPromptRowName(row);

            if (isDividerPrompt(promptName, dividerRegex, settings)) {
                if (row.classList.contains('bpt-header-item') || row.closest('details.bpt-engine-section')) {
                    currentSection = null;
                    return;
                }

                const sectionId = row.dataset.pmIdentifier || promptName || `bpt-section-${sections.length}`;
                const isOpen = getPromptSectionOpenState(settings, sectionId, promptName);
                const isLocked = getSectionLockState(settings, sectionId, promptName);
                const sectionTitle = stripDividerPrefix(promptName, dividerRegex);
                const sectionRow = createSectionRow(sectionId, sectionTitle, promptName, isOpen, isLocked);
                const isSourcePrompt = hasPromptRowContent(row);

                row.before(sectionRow);
                row.classList.add('bpt-divider-row');

                currentSection = {
                    id: sectionId,
                    title: sectionTitle,
                    isOpen,
                    isLocked,
                    row: sectionRow,
                    prompts: [],
                };
                sections.push(currentSection);

                if (isSourcePrompt) {
                    row.classList.add('bpt-section-item', 'bpt-divider-source');
                    row.dataset.sectionId = currentSection.id;
                    currentSection.prompts.push(row);
                } else {
                    // Keep structural divider prompts available inside expanded sections
                    // so they do not disappear permanently from the prompt list/editor flow.
                    row.classList.add('bpt-section-item', 'bpt-divider-structural');
                    row.dataset.sectionId = currentSection.id;
                    currentSection.prompts.push(row);
                }

                return;
            }

            if (currentSection) {
                row.classList.add('bpt-section-item');
                row.dataset.sectionId = currentSection.id;
                currentSection.prompts.push(row);
            }
        });

        sections.forEach(section => {
            const titleMatches = query.length > 0 && section.title.toLowerCase().includes(query);
            let matchedCount = 0;
            const countablePrompts = section.prompts.filter(row => !row.classList.contains('bpt-divider-structural'));

            section.prompts.forEach(row => {
                const matches = !query || titleMatches || getPromptSearchText(row).includes(query);
                if (matches) {
                    matchedCount += 1;
                }

                const isStructuralDivider = row.classList.contains('bpt-divider-structural');
                const shouldShow = !isStructuralDivider && matches && (query.length > 0 || section.isOpen);
                row.style.display = shouldShow ? '' : 'none';
            });

            const enabledCount = countablePrompts.filter(row => row.querySelector('.prompt-manager-toggle-action.fa-toggle-on')).length;
            section.row.querySelector('.bpt-section-count').textContent = `${enabledCount}/${countablePrompts.length}`;
            section.row.style.display = query.length === 0 || titleMatches || matchedCount > 0 ? '' : 'none';
            section.row.classList.toggle('is-collapsed', !section.isOpen && query.length === 0);
            section.row.classList.toggle('is-locked', section.isLocked);
            section.row.classList.toggle('is-unlocked', !section.isLocked);
            const sectionTrigger = section.row.querySelector('.bpt-section-trigger');
            sectionTrigger?.setAttribute('aria-expanded', String(section.isOpen || query.length > 0));
            sectionTrigger?.setAttribute('aria-disabled', String(section.isLocked));
            applySectionRowStyles(section.row, section.isOpen || query.length > 0);

            const icon = section.row.querySelector('.bpt-section-toggle i');
            icon.className = `fa-solid ${section.isOpen || query.length > 0 ? 'fa-chevron-down' : 'fa-chevron-right'}`;
        });

        rows
            .filter(row => !row.dataset.sectionId && !row.classList.contains('bpt-divider-row'))
            .forEach(row => {
                const matches = !query || getPromptSearchText(row).includes(query);
                row.style.display = matches ? '' : 'none';
            });

        if (!sections.length) {
            const dividerCandidates = rows
                .map(row => getPromptRowName(row))
                .filter(name => /^(?:=+|-{3,}|\*{3,}|[^\w\s]*[─—-]\+)/u.test(String(name).trim()));

            if (dividerCandidates.length) {
                console.warn('[BunnyPresetTools] Divider prompts were detected but no collapsible sections were rendered.', dividerCandidates);
            }
        }
    } finally {
        isRefreshingPromptSections = false;

        // Reconnect observer after our DOM changes are done
        if (promptListObserver && promptListElement) {
            promptListObserver.observe(promptListElement, {
                childList: true,
                subtree: true,
            });
        }

        if (scrollContainer) {
            scrollContainer.scrollTop = savedScrollTop;
        }
    }
}

function attachBackgroundEnhancer() {
    const bgBase = document.getElementById('bg1');
    if (bgBase && !backgroundLayerElement) {
        backgroundLayerElement = document.createElement('div');
        backgroundLayerElement.id = 'bpt-animated-bg-layer';
        bgBase.insertAdjacentElement('afterend', backgroundLayerElement);

        backgroundMutationObserver = new MutationObserver(scheduleBackgroundSync);
        backgroundMutationObserver.observe(bgBase, {
            attributes: true,
            attributeFilter: ['style', 'class'],
        });
    }

    attachBackgroundLifecycleHandlers();

    const backgroundDrawer = document.getElementById('Backgrounds');
    if (backgroundDrawer) {
        injectAnimatedBackgroundPanel(backgroundDrawer);
    }

    if (!backgroundCardObserversAttached) {
        const bgMenuContent = document.getElementById('bg_menu_content');
        const bgCustomContent = document.getElementById('bg_custom_content');

        if (bgMenuContent) {
            new MutationObserver(decorateBackgroundCards).observe(bgMenuContent, { childList: true, subtree: true });
            backgroundCardObserversAttached = true;
        }

        if (bgCustomContent) {
            new MutationObserver(decorateBackgroundCards).observe(bgCustomContent, { childList: true, subtree: true });
        }
    }

    decorateBackgroundCards();
    scheduleBackgroundSync();
}

function injectAnimatedBackgroundPanel(backgroundDrawer) {
    if (document.getElementById('bpt-animated-bg-panel')) {
        syncBackgroundPanel();
        return;
    }

    const panel = document.createElement('div');
    panel.id = 'bpt-animated-bg-panel';
    panel.innerHTML = `
        <div class="bpt-animated-bg-header">
            <div class="bpt-animated-bg-title">Animated Backgrounds</div>
            <div class="bpt-animated-bg-note">Use the normal uploader for local MP4/WebM files, or paste a YouTube/direct video URL here.</div>
        </div>
        <div class="bpt-animated-bg-url-row">
            <input id="bpt-animated-bg-url" class="text_pole" type="text" placeholder="https://youtube.com/... or https://.../loop.mp4">
            <button id="bpt-animated-bg-apply" class="menu_button menu_button_icon" type="button">
                <i class="fa-solid fa-wand-magic-sparkles"></i>
                <span>Use URL</span>
            </button>
        </div>
        <div class="bpt-animated-bg-controls">
            <label class="checkbox_label" for="bpt-animated-bg-enabled">
                <input id="bpt-animated-bg-enabled" type="checkbox">
                <span>Enable video and YouTube backgrounds</span>
            </label>
            <label class="checkbox_label" for="bpt-animated-bg-muted">
                <input id="bpt-animated-bg-muted" type="checkbox">
                <span>Muted</span>
            </label>
            <label class="checkbox_label" for="bpt-animated-bg-loop">
                <input id="bpt-animated-bg-loop" type="checkbox">
                <span>Loop</span>
            </label>
            <label class="checkbox_label" for="bpt-animated-bg-autoplay">
                <input id="bpt-animated-bg-autoplay" type="checkbox">
                <span>Autoplay</span>
            </label>
            <label class="bpt-animated-bg-volume" for="bpt-animated-bg-volume">
                <span>Volume</span>
                <input id="bpt-animated-bg-volume" type="range" min="0" max="100" step="1">
            </label>
        </div>
        <div id="bpt-animated-bg-sources"></div>
    `;

    const tabs = backgroundDrawer.querySelector('#bg_tabs');
    if (tabs) {
        backgroundDrawer.insertBefore(panel, tabs);
    } else {
        backgroundDrawer.prepend(panel);
    }

    panel.querySelector('#bpt-animated-bg-apply').addEventListener('click', () => {
        const input = panel.querySelector('#bpt-animated-bg-url');
        const url = String(input.value || '').trim();
        if (!url) {
            return;
        }

        applyAnimatedSource(url);
        input.value = '';
    });

    panel.querySelector('#bpt-animated-bg-url').addEventListener('keydown', event => {
        if (event.key === 'Enter') {
            event.preventDefault();
            panel.querySelector('#bpt-animated-bg-apply').click();
        }
    });

    panel.querySelector('#bpt-animated-bg-enabled').addEventListener('change', event => {
        ensureSettings().enableAnimatedBackgrounds = event.target.checked;
        saveSettingsDebounced();
        scheduleBackgroundSync();
        syncSettingsPanel();
    });

    panel.querySelector('#bpt-animated-bg-muted').addEventListener('change', event => {
        ensureSettings().animatedBackgroundMuted = event.target.checked;
        saveSettingsDebounced();
        scheduleBackgroundSync();
    });

    panel.querySelector('#bpt-animated-bg-loop').addEventListener('change', event => {
        ensureSettings().animatedBackgroundLoop = event.target.checked;
        saveSettingsDebounced();
        scheduleBackgroundSync();
    });

    panel.querySelector('#bpt-animated-bg-autoplay').addEventListener('change', event => {
        ensureSettings().animatedBackgroundAutoplay = event.target.checked;
        saveSettingsDebounced();
        scheduleBackgroundSync();
    });

    panel.querySelector('#bpt-animated-bg-volume').addEventListener('input', event => {
        ensureSettings().animatedBackgroundVolume = Number(event.target.value || 0);
        saveSettingsDebounced();
        scheduleBackgroundSync();
    });

    const fittingSelect = document.getElementById('background_fitting');
    if (fittingSelect) {
        fittingSelect.addEventListener('input', scheduleBackgroundSync);
    }

    syncBackgroundPanel();
}

function syncBackgroundPanel() {
    const panel = document.getElementById('bpt-animated-bg-panel');
    if (!panel) {
        return;
    }

    const settings = ensureSettings();
    panel.querySelector('#bpt-animated-bg-enabled').checked = settings.enableAnimatedBackgrounds;
    panel.querySelector('#bpt-animated-bg-muted').checked = settings.animatedBackgroundMuted;
    panel.querySelector('#bpt-animated-bg-loop').checked = settings.animatedBackgroundLoop;
    panel.querySelector('#bpt-animated-bg-autoplay').checked = settings.animatedBackgroundAutoplay;
    panel.querySelector('#bpt-animated-bg-volume').value = String(settings.animatedBackgroundVolume);

    renderAnimatedSourceList();
}

function scheduleBackgroundSync() {
    clearTimeout(backgroundSyncTimer);
    backgroundSyncTimer = setTimeout(syncAnimatedBackgroundLayer, 40);
}

function extractCssUrl(value) {
    const match = String(value || '').match(/^url\((['"]?)(.*?)\1\)$/);
    return match?.[2] || '';
}

function getCurrentBackgroundReference() {
    const lockedBackground = extractCssUrl(chat_metadata[BACKGROUND_LOCK_KEY]);
    if (lockedBackground) {
        return lockedBackground;
    }

    if (background_settings?.name) {
        return background_settings.name;
    }

    return extractCssUrl(background_settings?.url);
}

function getUrlExtension(value) {
    if (!value) {
        return '';
    }

    try {
        const pathname = new URL(value, window.location.origin).pathname;
        return pathname.split('.').pop()?.toLowerCase() ?? '';
    } catch {
        return String(value).split('?')[0].split('#')[0].split('.').pop()?.toLowerCase() ?? '';
    }
}

function isYouTubeUrl(value) {
    return /(?:youtube(?:-nocookie)?\.com\/(?:[^/]+\/.+\/|(?:v|e(?:mbed)?)\/|.*[?&]v=|.*\/shorts\/)|youtu\.be\/)([^"&?/\\s]{11})/i.test(String(value));
}

function getYouTubeVideoId(value) {
    const match = String(value).match(/(?:youtube(?:-nocookie)?\.com\/(?:[^/]+\/.+\/|(?:v|e(?:mbed)?)\/|.*[?&]v=|.*\/shorts\/)|youtu\.be\/)([^"&?/\\s]{11})/i);
    return match ? match[1] : '';
}

function getAnimatedBackgroundDescriptor() {
    const currentReference = getCurrentBackgroundReference();
    if (!currentReference) {
        return null;
    }

    if (isYouTubeUrl(currentReference)) {
        const videoId = getYouTubeVideoId(currentReference);
        if (!videoId) {
            return null;
        }

        return {
            kind: 'youtube',
            key: currentReference,
            videoId,
        };
    }

    const extension = getUrlExtension(currentReference);
    if (!VIDEO_EXTENSIONS.has(extension)) {
        return null;
    }

    if (/^https?:\/\//i.test(currentReference) || currentReference.startsWith('backgrounds/')) {
        return {
            kind: 'video',
            key: currentReference,
            src: currentReference,
        };
    }

    return {
        kind: 'video',
        key: currentReference,
        src: `backgrounds/${encodeURIComponent(currentReference)}`,
    };
}

function getObjectFitValue() {
    const fitting = document.getElementById('background_fitting')?.value || 'cover';
    switch (fitting) {
        case 'contain':
            return 'contain';
        case 'stretch':
            return 'fill';
        case 'center':
            return 'none';
        default:
            return 'cover';
    }
}

function buildYouTubeEmbedUrl(videoId) {
    const settings = ensureSettings();
    const params = new URLSearchParams({
        autoplay: settings.animatedBackgroundAutoplay ? '1' : '0',
        loop: settings.animatedBackgroundLoop ? '1' : '0',
        mute: settings.animatedBackgroundMuted ? '1' : '0',
        playlist: settings.animatedBackgroundLoop ? videoId : '',
        controls: settings.animatedBackgroundShowControls ? '1' : '0',
        modestbranding: '1',
        rel: '0',
        iv_load_policy: '3',
        disablekb: '1',
    });

    return `https://www.youtube.com/embed/${videoId}?${params.toString()}`;
}

function isIOSWebKit() {
    return /iPad|iPhone|iPod/.test(navigator.platform) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

function clearAnimatedBackgroundLayer() {
    if (!backgroundLayerElement) {
        return;
    }

    backgroundLayerElement.innerHTML = '';
    backgroundLayerElement.removeAttribute('data-active-key');
    document.body.classList.remove('bpt-animated-bg-active');
    renderAnimatedSourceList();
}

function suspendAnimatedBackgroundMedia() {
    if (!isIOSWebKit() || !backgroundLayerElement) {
        return;
    }

    const video = backgroundLayerElement.querySelector('video');
    if (video) {
        video.pause();
    }

    const iframe = backgroundLayerElement.querySelector('iframe');
    if (iframe instanceof HTMLIFrameElement && !iframe.dataset.bptSuspendedSrc) {
        iframe.dataset.bptSuspendedSrc = iframe.getAttribute('src') || '';
        iframe.removeAttribute('src');
    }
}

function resumeAnimatedBackgroundMedia() {
    if (!isIOSWebKit() || !backgroundLayerElement) {
        return;
    }

    const iframe = backgroundLayerElement.querySelector('iframe[data-bpt-suspended-src]');
    if (iframe instanceof HTMLIFrameElement) {
        iframe.src = iframe.dataset.bptSuspendedSrc || '';
        delete iframe.dataset.bptSuspendedSrc;
    }

    const video = backgroundLayerElement.querySelector('video');
    if (video && ensureSettings().animatedBackgroundAutoplay) {
        const playPromise = video.play();
        if (playPromise?.catch) {
            playPromise.catch(() => {});
        }
    }

    scheduleBackgroundSync();
}

function attachBackgroundLifecycleHandlers() {
    if (backgroundLifecycleHandlersAttached) {
        return;
    }

    document.addEventListener('visibilitychange', () => {
        if (document.hidden) {
            suspendAnimatedBackgroundMedia();
        } else {
            resumeAnimatedBackgroundMedia();
        }
    });
    window.addEventListener('pagehide', suspendAnimatedBackgroundMedia, { passive: true });
    window.addEventListener('pageshow', resumeAnimatedBackgroundMedia, { passive: true });
    backgroundLifecycleHandlersAttached = true;
}

function syncAnimatedBackgroundLayer() {
    syncBackgroundPanel();

    if (!backgroundLayerElement) {
        return;
    }

    const settings = ensureSettings();
    const descriptor = getAnimatedBackgroundDescriptor();

    if (!settings.enableAnimatedBackgrounds || !descriptor) {
        clearAnimatedBackgroundLayer();
        return;
    }

    const activeKey = `${descriptor.kind}:${descriptor.key}:${settings.animatedBackgroundMuted}:${settings.animatedBackgroundLoop}:${settings.animatedBackgroundAutoplay}:${settings.animatedBackgroundVolume}`;
    if (backgroundLayerElement.dataset.activeKey === activeKey) {
        const video = backgroundLayerElement.querySelector('video');
        if (video) {
            video.muted = settings.animatedBackgroundMuted;
            video.loop = settings.animatedBackgroundLoop;
            video.controls = settings.animatedBackgroundShowControls;
            video.volume = settings.animatedBackgroundMuted ? 0 : settings.animatedBackgroundVolume / 100;
            video.style.objectFit = getObjectFitValue();
        }
        renderAnimatedSourceList();
        return;
    }

    backgroundLayerElement.innerHTML = '';
    backgroundLayerElement.dataset.activeKey = activeKey;

    if (descriptor.kind === 'youtube') {
        const iframe = document.createElement('iframe');
        iframe.src = buildYouTubeEmbedUrl(descriptor.videoId);
        iframe.allow = 'autoplay; encrypted-media; picture-in-picture';
        iframe.referrerPolicy = 'strict-origin-when-cross-origin';
        backgroundLayerElement.appendChild(iframe);
    } else {
        const video = document.createElement('video');
        video.src = descriptor.src;
        video.muted = settings.animatedBackgroundMuted;
        video.loop = settings.animatedBackgroundLoop;
        video.controls = settings.animatedBackgroundShowControls;
        video.autoplay = settings.animatedBackgroundAutoplay;
        video.playsInline = true;
        video.preload = isIOSWebKit() ? 'metadata' : 'auto';
        video.volume = settings.animatedBackgroundMuted ? 0 : settings.animatedBackgroundVolume / 100;
        video.style.objectFit = getObjectFitValue();
        backgroundLayerElement.appendChild(video);

        const playPromise = video.play();
        if (playPromise?.catch) {
            playPromise.catch(() => {});
        }
    }

    document.body.classList.add('bpt-animated-bg-active');
    renderAnimatedSourceList();
}

function makeAnimatedSourceLabel(source) {
    if (isYouTubeUrl(source)) {
        const videoId = getYouTubeVideoId(source);
        return `YouTube ${videoId}`;
    }

    try {
        const url = new URL(source);
        const lastSegment = url.pathname.split('/').filter(Boolean).pop();
        return lastSegment || url.hostname;
    } catch {
        return source.split('/').pop() || source;
    }
}

function setCurrentBackgroundToSource(source) {
    const cssUrl = `url("${source}")`;
    const hasLockedBackground = Boolean(chat_metadata[BACKGROUND_LOCK_KEY]) && Boolean(getCurrentChatId());

    if (hasLockedBackground) {
        chat_metadata[BACKGROUND_LOCK_KEY] = cssUrl;
        saveMetadataDebounced();
    } else {
        background_settings.name = source;
        background_settings.url = cssUrl;
        saveSettingsDebounced();
    }

    const bgBase = document.getElementById('bg1');
    if (bgBase) {
        bgBase.style.backgroundImage = cssUrl;
    }
}

function applyAnimatedSource(source) {
    const trimmedSource = String(source || '').trim();
    if (!trimmedSource) {
        return;
    }

    const settings = ensureSettings();
    settings.savedAnimatedSources = [
        trimmedSource,
        ...settings.savedAnimatedSources.filter(item => item !== trimmedSource),
    ].slice(0, 16);

    setCurrentBackgroundToSource(trimmedSource);
    saveSettingsDebounced();
    renderAnimatedSourceList();
    scheduleBackgroundSync();
}

function renderAnimatedSourceList() {
    const container = document.getElementById('bpt-animated-bg-sources');
    if (!container) {
        return;
    }

    const settings = ensureSettings();
    const activeSource = getCurrentBackgroundReference();
    const sources = settings.savedAnimatedSources;

    if (!sources.length) {
        container.innerHTML = '<div class="bpt-animated-source-empty">Saved video and YouTube URLs will show up here.</div>';
        return;
    }

    container.innerHTML = '';
    sources.forEach(source => {
        const card = document.createElement('div');
        card.className = 'bpt-animated-source-card';
        if (source === activeSource) {
            card.classList.add('is-active');
        }

        const icon = isYouTubeUrl(source) ? 'fa-brands fa-youtube' : 'fa-solid fa-film';
        card.innerHTML = `
            <button class="bpt-animated-source-main" type="button">
                <i class="${icon}"></i>
                <span class="bpt-animated-source-label"></span>
            </button>
            <button class="menu_button menu_button_icon" type="button" title="Remove saved source">
                <i class="fa-solid fa-trash-can"></i>
            </button>
        `;

        card.querySelector('.bpt-animated-source-label').textContent = makeAnimatedSourceLabel(source);
        card.querySelector('.bpt-animated-source-main').addEventListener('click', () => applyAnimatedSource(source));
        card.querySelector('.menu_button').addEventListener('click', () => {
            settings.savedAnimatedSources = settings.savedAnimatedSources.filter(item => item !== source);
            saveSettingsDebounced();
            renderAnimatedSourceList();
        });

        container.appendChild(card);
    });
}

function decorateBackgroundCards() {
    document.querySelectorAll('.bg_example[data-media-type="video"]').forEach(card => {
        if (!card.querySelector('.bpt-bg-media-badge')) {
            const badge = document.createElement('div');
            badge.className = 'bpt-bg-media-badge';
            badge.innerHTML = '<i class="fa-solid fa-film"></i><span>Video</span>';
            card.appendChild(badge);
        }

        const clipper = card.querySelector('.thumbnail-clipper');
        if (clipper && !clipper.classList.contains('bpt-video-thumb')) {
            clipper.classList.add('bpt-video-thumb');
            const fill = document.createElement('div');
            fill.className = 'bpt-video-thumb-fill';
            fill.innerHTML = '<i class="fa-solid fa-circle-play"></i>';
            clipper.prepend(fill);
        }
    });
}

function setSettingsPanelExpanded(expand) {
    const panel = document.getElementById('bpt-settings');
    if (!panel) {
        return;
    }

    const header = panel.querySelector(':scope > .inline-drawer-header');
    const icon = panel.querySelector(':scope > .inline-drawer-header .inline-drawer-icon');
    const content = panel.querySelector(':scope > .inline-drawer-content');
    if (!(icon instanceof HTMLElement) || !(content instanceof HTMLElement)) {
        return;
    }

    if (header instanceof HTMLElement) {
        header.setAttribute('aria-expanded', String(expand));
    }

    icon.classList.toggle('down', !expand);
    icon.classList.toggle('fa-circle-chevron-down', !expand);
    icon.classList.toggle('up', expand);
    icon.classList.toggle('fa-circle-chevron-up', expand);
    content.style.display = expand ? 'block' : 'none';
    panel.dataset.expanded = String(expand);
}

function isSettingsPanelExpanded(panel = document.getElementById('bpt-settings')) {
    if (!(panel instanceof HTMLElement)) {
        return false;
    }

    const content = panel.querySelector(':scope > .inline-drawer-content');
    if (!(content instanceof HTMLElement)) {
        return false;
    }

    return getComputedStyle(content).display !== 'none';
}

function persistSettingsPanelExpanded(expand) {
    const settings = ensureSettings();
    if (settings.settingsPanelExpanded === expand) {
        return;
    }

    settings.settingsPanelExpanded = expand;
    saveSettingsDebounced();
}

function injectSettingsPanel() {
    watchSettingsContainer();

    const settingsContainer = document.getElementById('extensions_settings');
    if (!settingsContainer || document.getElementById('bpt-settings')) {
        syncSettingsPanel();
        return;
    }

    const panel = document.createElement('div');
    panel.id = 'bpt-settings';
    panel.className = 'inline-drawer wide100p';
    panel.innerHTML = `
        <div class="inline-drawer-toggle inline-drawer-header" role="button" tabindex="0" aria-expanded="false">
            <b><span>Bunny Preset Tools</span></b>
            <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
        </div>
        <div class="inline-drawer-content" style="display:none;">
            <div class="bpt-settings-body">
                <div class="bpt-settings-subtitle">Prompt sections and animated backgrounds</div>
                <div class="bpt-settings-help">Prompt sections are added directly to the prompt manager. Animated background controls live in the Backgrounds drawer.</div>
                <div class="bpt-settings-row">
                    <label class="checkbox_label" for="bpt-enable-sections">
                        <input id="bpt-enable-sections" type="checkbox">
                        <span>Enable collapsible prompt sections</span>
                    </label>
                    <label class="checkbox_label" for="bpt-enable-animated">
                        <input id="bpt-enable-animated" type="checkbox">
                        <span>Enable animated backgrounds</span>
                    </label>
                </div>
                <div class="bpt-settings-row">
                    <input id="bpt-divider-patterns" class="text_pole" type="text" placeholder="Extra divider regex patterns, comma-separated">
                    <button id="bpt-save-divider-patterns" class="menu_button menu_button_icon" type="button">
                        <i class="fa-solid fa-save"></i>
                        <span>Save</span>
                    </button>
                </div>
                <div class="bpt-settings-help">Built-in divider patterns include headings that start with <code>===</code>, <code>---</code>, <code>***</code>, or symbol prefixes like <code>⭐─+</code>, <code>🌱 ━+</code>, and <code>━+</code>.</div>
            </div>
        </div>
    `;

    settingsContainer.appendChild(panel);

    const header = panel.querySelector(':scope > .inline-drawer-header');
    if (header instanceof HTMLElement) {
        const togglePanel = (event) => {
            event.preventDefault();
            event.stopPropagation();
            const nextExpanded = !isSettingsPanelExpanded(panel);
            setSettingsPanelExpanded(nextExpanded);
            persistSettingsPanelExpanded(nextExpanded);
        };

        header.addEventListener('click', togglePanel);
        header.addEventListener('keydown', event => {
            if (event.key === 'Enter' || event.key === ' ') {
                togglePanel(event);
            }
        });
    }

    panel.querySelector('#bpt-enable-sections').addEventListener('change', event => {
        ensureSettings().enablePromptSections = event.target.checked;
        saveSettingsDebounced();
        schedulePromptRefresh();
    });

    panel.querySelector('#bpt-enable-animated').addEventListener('change', event => {
        ensureSettings().enableAnimatedBackgrounds = event.target.checked;
        saveSettingsDebounced();
        scheduleBackgroundSync();
        syncBackgroundPanel();
    });

    panel.querySelector('#bpt-save-divider-patterns').addEventListener('click', () => {
        ensureSettings().dividerRegexPattern = String(panel.querySelector('#bpt-divider-patterns').value || '').trim();
        saveSettingsDebounced();
        schedulePromptRefresh();
    });

    syncSettingsPanel();
}

function syncSettingsPanel() {
    const panel = document.getElementById('bpt-settings');
    if (!panel) {
        return;
    }

    const settings = ensureSettings();
    panel.querySelector('#bpt-enable-sections').checked = settings.enablePromptSections;
    panel.querySelector('#bpt-enable-animated').checked = settings.enableAnimatedBackgrounds;
    panel.querySelector('#bpt-divider-patterns').value = settings.dividerRegexPattern;
    setSettingsPanelExpanded(settings.settingsPanelExpanded);
}

bootstrap();
setInterval(bootstrap, 1000);
eventSource.on(event_types.CHAT_CHANGED, scheduleBackgroundSync);
