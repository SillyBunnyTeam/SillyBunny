/**
 * Preset autosave and bundled-preset protection.
 *
 * User edits inside the Sampling, Presets and Editor tabs mark the active preset of every kind that
 * the current backend uses. After a quiet period, each marked preset is compared with the state it
 * had when the edit began and saved only if it changed. Programmatic changes never begin an edit:
 * jQuery triggers do not reach native listeners and synthetic events are not trusted.
 *
 * Bundled presets are read-only by name. An edit to one is saved to "<name> (copy)" instead, and the
 * copy becomes the active preset. Update buttons are disabled for bundled presets.
 */

import { eventSource, event_types, getRequestHeaders, main_api, saveSettingsDebounced } from '../script.js';
import { t } from './i18n.js';
import { getChatCompletionPreset, oai_settings, openai_setting_names, openai_settings } from './openai.js';
import { power_user } from './power-user.js';
import { getPresetManager, refreshPresetDirtyGuards } from './preset-manager.js';

const AUTOSAVE_DELAY_MS = 1000;
const PRESET_KINDS = Object.freeze(['openai', 'textgenerationwebui', 'kobold', 'novel', 'instruct', 'context', 'sysprompt', 'reasoning']);
const TEMPLATE_KINDS = Object.freeze(['instruct', 'context', 'sysprompt']);
const EDIT_EVENTS = Object.freeze(['pointerdown', 'keydown', 'input', 'change']);
const KEEPALIVE_BODY_LIMIT = 60_000;

const EDIT_SURFACE_SELECTOR = [
    '[data-sb-panel="sampling"]',
    '[data-sb-panel="prompting"]',
    '[data-sb-panel="editor"]',
    '#completion_prompt_manager_popup',
].join(', ');
// Preset management controls write or replace presets themselves; pending edits are saved before they act.
const FLUSH_CONTROL_SELECTOR = [
    'select[data-preset-manager-for]',
    '[data-preset-manager-update]', '[data-preset-manager-new]', '[data-preset-manager-rename]',
    '[data-preset-manager-delete]', '[data-preset-manager-import]', '[data-preset-manager-export]',
    '[data-preset-manager-restore]', '[data-preset-manager-restore-defaults]',
    '#update_oai_preset', '#new_oai_preset', '#delete_oai_preset', '#export_oai_preset', '#import_oai_preset',
    '#openai_preset_import_file', '#af_master_import', '#af_master_import_file', '#af_master_export',
    '#connection_profiles', '#main_api', '#bind_model_templates', '#sb_preset_autosave',
    'input[type="file"]', '.sb-action-btn-group',
].join(', ');
const DIALOG_SELECTOR = 'dialog[open], .popup[open], .popup.active';

/** @type {Map<string, { name: string, baseline: string, timer: number|null }>} */
const pendingEdits = new Map();
/** @type {Map<string, Promise<void>>} */
const writeQueues = new Map();
/** @type {Map<string, Promise<Set<string>>>} */
const bundledNameRequests = new Map();
/** @type {Map<string, Set<string>>} */
const bundledNames = new Map();
let activeWrites = 0;
let suppressSelectFlush = false;
let initialized = false;

export function isPresetAutosaveEnabled() {
    return power_user.sb_preset_autosave === true;
}

/** @param {string} apiId */
function normalizeKind(apiId) {
    return apiId === 'koboldhorde' ? 'kobold' : apiId;
}

/** @returns {string[]} Preset kinds the current backend reads from. */
function getActiveKinds() {
    const mainKind = normalizeKind(main_api);
    const kinds = mainKind === 'openai' ? ['openai'] : [mainKind, ...TEMPLATE_KINDS];
    return [...kinds, 'reasoning'].filter(kind => PRESET_KINDS.includes(kind));
}

/** @param {string} kind @returns {string} */
function getSelectedName(kind) {
    const manager = getPresetManager(kind);
    if (!manager) return '';
    // Kobold's GUI entry is not a preset file.
    if (kind === 'kobold' && manager.getSelectedPreset() === 'gui') return '';
    return manager.getSelectedPresetName() || '';
}

/**
 * Reads what Update would save for one preset kind, under the given name.
 * @param {string} kind @param {string} name @returns {object}
 */
function readPresetPayload(kind, name) {
    if (kind === 'openai') return getChatCompletionPreset(oai_settings);
    return getPresetManager(kind).getPresetSettings(name);
}

/** @param {string} name */
function normalizeName(name) {
    return String(name).toLocaleLowerCase();
}

/**
 * Bundled preset names for one kind, fetched once per session.
 * @param {string} kind @returns {Promise<Set<string>>}
 */
function loadBundledNames(kind) {
    if (!bundledNameRequests.has(kind)) {
        const request = fetch('/api/presets/defaults', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ apiId: kind }),
        }).then(async response => {
            if (!response.ok) throw new Error(`Bundled preset names request failed with ${response.status}`);
            const data = await response.json();
            const names = new Set((Array.isArray(data?.names) ? data.names : []).map(normalizeName));
            bundledNames.set(kind, names);
            return names;
        }).catch(error => {
            bundledNameRequests.delete(kind);
            throw error;
        });
        bundledNameRequests.set(kind, request);
    }
    return bundledNameRequests.get(kind);
}

/** @param {string} kind @param {string} name @returns {boolean|null} Null while the bundled list is unknown. */
export function isBundledPresetName(kind, name) {
    const names = bundledNames.get(normalizeKind(kind));
    if (!names) return null;
    return names.has(normalizeName(name));
}

/** @param {string} kind @returns {string[]} */
function getPresetNames(kind) {
    const { preset_names } = getPresetManager(kind).getPresetList();
    return Array.isArray(preset_names) ? preset_names : Object.keys(preset_names);
}

/** @param {string} kind @param {string} name @param {Set<string>} bundled */
function getForkName(kind, name, bundled) {
    const taken = new Set([...getPresetNames(kind).map(normalizeName), ...bundled]);
    let candidate = `${name} (copy)`;
    for (let index = 2; taken.has(normalizeName(candidate)); index++) {
        candidate = `${name} (copy ${index})`;
    }
    return candidate;
}

/**
 * @param {string} kind @param {string} name @param {object} preset
 * @param {{ keepalive?: boolean }} [options]
 * @returns {Promise<string>} Saved name
 */
async function postPreset(kind, name, preset, { keepalive = false } = {}) {
    const body = JSON.stringify({ apiId: kind, name, preset });
    const response = await fetch('/api/presets/save', {
        method: 'POST',
        headers: getRequestHeaders(),
        body,
        keepalive: keepalive && body.length < KEEPALIVE_BODY_LIMIT,
    });
    if (!response.ok) throw new Error(`Preset save failed with ${response.status}`);
    const data = await response.json();
    return data.name || name;
}

/** Keeps the in-memory preset list in step with a file that was just written. */
function storeSavedPreset(kind, name, preset) {
    if (kind === 'openai') {
        openai_settings[openai_setting_names[name]] = preset;
        return;
    }
    const manager = getPresetManager(kind);
    const { presets, preset_names } = manager.getPresetList();
    const index = Array.isArray(preset_names) ? preset_names.indexOf(name) : preset_names[name];
    if (index === undefined || index < 0) {
        console.warn(`[SillyBunny] Autosaved ${kind} preset "${name}" is missing from the preset list.`);
        return;
    }
    presets[index] = preset;
}

/** Adds a forked preset and makes it the active one without reapplying settings the user is editing. */
function selectForkedPreset(kind, name, preset) {
    if (kind === 'openai') {
        openai_settings.push(preset);
        openai_setting_names[name] = openai_settings.length - 1;
        const option = document.createElement('option');
        option.value = String(openai_settings.length - 1);
        option.textContent = name;
        option.selected = true;
        document.getElementById('settings_preset_openai')?.append(option);
        oai_settings.preset_settings_openai = name;
        saveSettingsDebounced();
        void eventSource.emit(event_types.PRESET_CHANGED, { apiId: 'openai', name });
        return;
    }
    // The generic list update selects the new option and applies it, which runs the kind's own
    // selection bookkeeping (template names, bind-to-context). Applying equals the live state.
    suppressSelectFlush = true;
    try {
        getPresetManager(kind).updateList(name, preset);
    } finally {
        suppressSelectFlush = false;
    }
}

/** @param {string} kind @param {string} name @param {object} preset @param {{ keepalive?: boolean }} options */
async function writePreset(kind, name, preset, options) {
    const bundled = await loadBundledNames(kind);
    if (!bundled.has(normalizeName(name))) {
        const savedName = await postPreset(kind, name, preset, options);
        storeSavedPreset(kind, savedName, preset);
        if (getSelectedName(kind) === savedName) getPresetManager(kind)?.snapshotTextFields();
        return;
    }

    // Edits to a bundled preset only fork it while that preset is still the active one.
    if (getSelectedName(kind) !== name) return;
    const forkName = getForkName(kind, name, bundled);
    const forkPreset = TEMPLATE_KINDS.includes(kind) || kind === 'reasoning' ? { ...preset, name: forkName } : preset;
    const savedName = await postPreset(kind, forkName, forkPreset, options);
    if (getSelectedName(kind) !== name) return;
    // A later edit still marked with the bundled name now belongs to the copy.
    const pending = pendingEdits.get(kind);
    if (pending?.name === name) pending.name = savedName;
    selectForkedPreset(kind, savedName, forkPreset);
    toastr.info(t`Bundled presets are read-only. Your changes were saved to "${savedName}".`);
    refreshPresetProtectionUi();
}

/** @param {string} kind @param {string} name @param {object} preset @param {{ keepalive?: boolean }} [options] */
function enqueueWrite(kind, name, preset, options = {}) {
    activeWrites++;
    const previous = writeQueues.get(kind) ?? Promise.resolve();
    const next = previous
        .then(() => writePreset(kind, name, preset, options))
        .catch(error => {
            console.error(`[SillyBunny] Could not autosave ${kind} preset "${name}"`, error);
            toastr.error(t`Check the server connection and reload the page to prevent data loss.`, t`Preset could not be saved`);
        })
        .finally(() => { activeWrites--; });
    writeQueues.set(kind, next);
    return next;
}

/**
 * Saves one pending edit now.
 * @param {string} kind
 * @param {{ name?: string, keepalive?: boolean }} [options] `name` reads live state as that preset,
 * for the moment a preset switch has updated the select but not yet applied the new values.
 */
function flushKind(kind, { name, keepalive = false } = {}) {
    const pending = pendingEdits.get(kind);
    if (!pending) return;
    if (pending.timer !== null) clearTimeout(pending.timer);
    pendingEdits.delete(kind);
    if (!isPresetAutosaveEnabled()) return;
    const liveName = name ?? getSelectedName(kind);
    // The preset changed under the edit without a flush point; its live state belongs to another preset.
    if (liveName !== pending.name) return;
    const payload = readPresetPayload(kind, liveName);
    if (JSON.stringify(payload) === pending.baseline) return;
    void enqueueWrite(kind, liveName, structuredClone(payload), { keepalive });
}

/** @param {{ keepalive?: boolean }} [options] */
function flushAll(options = {}) {
    for (const kind of [...pendingEdits.keys()]) flushKind(kind, options);
}

function schedule(kind) {
    const pending = pendingEdits.get(kind);
    if (!pending) return;
    if (pending.timer !== null) clearTimeout(pending.timer);
    pending.timer = window.setTimeout(() => {
        // Popups such as delete confirmations finish their change after the user confirms.
        if (document.querySelector(DIALOG_SELECTOR)) {
            schedule(kind);
            return;
        }
        flushKind(kind);
    }, AUTOSAVE_DELAY_MS);
}

/** Starts or extends an edit for every preset the active backend reads. */
function noteUserEdit() {
    if (!isPresetAutosaveEnabled()) return;
    for (const kind of getActiveKinds()) {
        const name = getSelectedName(kind);
        if (!name) continue;
        const pending = pendingEdits.get(kind);
        if (pending && pending.name !== name) flushKind(kind);
        if (!pendingEdits.has(kind)) {
            pendingEdits.set(kind, { name, baseline: JSON.stringify(readPresetPayload(kind, name)), timer: null });
        }
        schedule(kind);
    }
}

/** @param {Event} event */
function handleTrustedInteraction(event) {
    if (!event.isTrusted || !(event.target instanceof Element)) return;
    if (event.target.closest(FLUSH_CONTROL_SELECTOR)) {
        flushAll();
        return;
    }
    if (event.target.closest(EDIT_SURFACE_SELECTOR) || event.target.closest(DIALOG_SELECTOR)) noteUserEdit();
}

/**
 * Native preset switches (Save as, delete, import, slash commands, connection profiles) dispatch a
 * change before any apply handler runs. Live settings still hold the previous preset here.
 * @param {Event} event
 */
function handlePresetSelectChange(event) {
    const select = event.target;
    if (suppressSelectFlush || !(select instanceof HTMLSelectElement) || !select.matches('select[data-preset-manager-for]')) return;
    for (const kind of String(select.dataset.presetManagerFor).split(',').map(normalizeKind)) {
        const pending = pendingEdits.get(kind);
        if (pending) flushKind(kind, { name: pending.name });
    }
}

function handlePageHide() {
    flushAll({ keepalive: true });
}

/** @param {BeforeUnloadEvent} event */
function handleBeforeUnload(event) {
    if (!isPresetAutosaveEnabled()) return;
    flushAll({ keepalive: true });
    if (activeWrites === 0) return;
    event.preventDefault();
    event.returnValue = '';
}

/** @param {Element} button @param {boolean} readOnly */
function setUpdateButtonReadOnly(button, readOnly) {
    if (!(button instanceof HTMLElement)) return;
    const isReadOnly = button.dataset.sbPresetReadOnly === 'true';
    if (readOnly === isReadOnly) return;
    if (readOnly) {
        button.dataset.sbPresetUpdateTitle = button.getAttribute('title') ?? '';
        button.dataset.sbPresetReadOnly = 'true';
        button.classList.add('sb-preset-update-read-only');
        button.setAttribute('aria-disabled', 'true');
        button.setAttribute('title', t`Bundled presets are read-only. Use Save as to keep your changes.`);
        return;
    }
    delete button.dataset.sbPresetReadOnly;
    button.classList.remove('sb-preset-update-read-only');
    button.removeAttribute('aria-disabled');
    button.setAttribute('title', button.dataset.sbPresetUpdateTitle ?? '');
    delete button.dataset.sbPresetUpdateTitle;
}

/** @param {string} kind @returns {Element[]} */
function getUpdateButtons(kind) {
    const buttons = [...document.querySelectorAll(`[data-preset-manager-update="${kind}"]`)];
    if (kind === 'openai') buttons.push(...document.querySelectorAll('#update_oai_preset'));
    return buttons;
}

/** Updates Update-button protection and the Editor header for the active presets. */
export function refreshPresetProtectionUi() {
    for (const kind of PRESET_KINDS) {
        const readOnly = isBundledPresetName(kind, getSelectedName(kind)) === true;
        for (const button of getUpdateButtons(kind)) setUpdateButtonReadOnly(button, readOnly);
    }

    const autosave = document.querySelector('[data-sb-editor-autosave]');
    if (autosave instanceof HTMLElement) {
        const label = isPresetAutosaveEnabled() ? 'Autosave on' : 'Autosave off';
        autosave.hidden = false;
        autosave.dataset.i18n = label;
        autosave.textContent = isPresetAutosaveEnabled() ? t`Autosave on` : t`Autosave off`;
    }
    const readOnly = document.querySelector('[data-sb-editor-read-only]');
    if (readOnly instanceof HTMLElement) {
        readOnly.hidden = !getActiveKinds().some(kind => kind !== 'reasoning' && isBundledPresetName(kind, getSelectedName(kind)) === true);
    }
    const toggle = document.getElementById('sb_preset_autosave');
    if (toggle instanceof HTMLInputElement && toggle.checked !== isPresetAutosaveEnabled()) toggle.checked = isPresetAutosaveEnabled();
}

/** @param {MouseEvent} event */
function blockReadOnlyUpdate(event) {
    if (!(event.target instanceof Element)) return;
    const button = event.target.closest('[data-sb-preset-read-only="true"]');
    if (!button) return;
    event.preventDefault();
    event.stopImmediatePropagation();
}

/**
 * Switch row for the global autosave setting, placed in the Presets group.
 * @returns {HTMLLabelElement}
 */
export function createPresetAutosaveToggle() {
    const label = document.createElement('label');
    label.className = 'checkbox_label';
    label.htmlFor = 'sb_preset_autosave';
    label.dataset.sbPresetAutosave = 'true';

    const input = document.createElement('input');
    input.type = 'checkbox';
    input.id = 'sb_preset_autosave';
    input.checked = isPresetAutosaveEnabled();
    input.addEventListener('change', () => {
        power_user.sb_preset_autosave = input.checked;
        saveSettingsDebounced();
        refreshPresetDirtyGuards();
        refreshPresetProtectionUi();
    });

    const title = document.createElement('small');
    title.dataset.i18n = 'Autosave presets';
    title.textContent = t`Autosave presets`;
    const subtitle = document.createElement('small');
    subtitle.dataset.i18n = 'Enables auto-saving functionality for presets.';
    subtitle.textContent = t`Enables auto-saving functionality for presets.`;

    label.append(input, title, subtitle);
    return label;
}

export function initializePresetAutosave() {
    if (initialized) return;
    initialized = true;

    for (const type of EDIT_EVENTS) document.addEventListener(type, handleTrustedInteraction, true);
    document.addEventListener('change', handlePresetSelectChange, true);
    document.addEventListener('click', blockReadOnlyUpdate, true);
    window.addEventListener('pagehide', handlePageHide);
    window.addEventListener('beforeunload', handleBeforeUnload);
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') flushAll({ keepalive: true });
    });

    eventSource.on(event_types.OAI_PRESET_CHANGED_BEFORE, (event = {}) => {
        const pending = pendingEdits.get('openai');
        if (pending && pending.name === event.presetNameBefore) flushKind('openai', { name: pending.name });
    });
    // Profiles replace preset values without a user edit; anything pending was flushed when it began.
    eventSource.on(event_types.CONNECTION_PROFILE_LOADED, () => pendingEdits.clear());
    eventSource.on(event_types.PRESET_CHANGED, () => refreshPresetProtectionUi());
    $(document).on('change', 'select[data-preset-manager-for]', () => refreshPresetProtectionUi());

    void Promise.allSettled(PRESET_KINDS.map(loadBundledNames)).then(results => {
        for (const result of results) {
            if (result.status === 'rejected') console.warn('[SillyBunny] Could not load bundled preset names', result.reason);
        }
        refreshPresetProtectionUi();
    });
}
