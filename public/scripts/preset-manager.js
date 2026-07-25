import { Fuse, lodash } from '../lib.js';

import {
    amount_gen,
    characters,
    eventSource,
    event_types,
    getRequestHeaders,
    koboldai_setting_names,
    koboldai_settings,
    main_api,
    max_context,
    nai_settings,
    novelai_setting_names,
    novelai_settings,
    online_status,
    saveSettings,
    saveSettingsDebounced,
    this_chid,
} from '../script.js';
import { groups, selected_group } from './group-chats.js';
import { t } from './i18n.js';
import { instruct_presets } from './instruct-mode.js';
import { kai_settings } from './kai-settings.js';
import { convertNovelPreset } from './nai-settings.js';
import { getChatCompletionPreset, oai_settings, openai_setting_names, openai_settings } from './openai.js';
import { POPUP_RESULT, POPUP_TYPE, Popup } from './popup.js';
import { context_presets, getContextSettings, power_user } from './power-user.js';
import {
    createPresetSelectTouchGuardState,
    resolvePresetSelectTouchGuardEnd,
    resolvePresetSelectTouchGuardMove,
    shouldSuppressPresetSelectTouchClick,
} from './preset-select-touch-guard.js';
import { reasoning_templates } from './reasoning.js';
import { SlashCommand } from './slash-commands/SlashCommand.js';
import { ARGUMENT_TYPE, SlashCommandArgument } from './slash-commands/SlashCommandArgument.js';
import { enumIcons } from './slash-commands/SlashCommandCommonEnumsProvider.js';
import { SlashCommandEnumValue, enumTypes } from './slash-commands/SlashCommandEnumValue.js';
import { SlashCommandParser } from './slash-commands/SlashCommandParser.js';
import { checkForSystemPromptInInstructTemplate, system_prompts } from './sysprompt.js';
import { renderTemplateAsync } from './templates.js';
import {
    getTextCompletionPresetSettings,
    textgenerationwebui_settings as textgen_settings,
    textgenerationwebui_preset_names,
    textgenerationwebui_presets,
} from './textgen-settings.js';
import { download, ensurePlainObject, equalsIgnoreCaseAndAccents, getSanitizedFilename, parseJsonFile, waitUntilCondition } from './utils.js';

const presetManagers = {};
const PRESET_CHANGE_EVENT_APIS = new Set(['kobold', 'novel', 'openai', 'textgenerationwebui']);
const PRESET_CHANGE_TIMEOUT_MS = 10000;
const PRESET_TEXT_FIELD_SELECTOR = 'textarea, input[type="text"]';
const PRESET_TEXT_FIELD_PANEL_SELECTORS = Object.freeze({
    kobold: '#kobold_api-settings',
    novel: '#range_block_novel, #novel_api-settings',
    openai: '#range_block_openai, #openai_settings',
    textgenerationwebui: '#textgenerationwebui_api-settings',
    context: '#ContextSettings',
    instruct: '#InstructSettingsColumn',
    sysprompt: '#SystemPromptBlock',
    reasoning: '#reasoning_prefix, #reasoning_suffix, #reasoning_separator',
});

/**
 * Automatically select a preset for current API based on character or group name.
 */
async function autoSelectPreset() {
    const presetManager = getPresetManager();

    if (!presetManager) {
        console.debug(`Preset Manager not found for API: ${main_api}`);
        return;
    }

    const name = selected_group ? groups.find(x => x.id == selected_group)?.name : characters[this_chid]?.name;

    if (!name) {
        console.debug(`Preset candidate not found for API: ${main_api}`);
        return;
    }

    const preset = presetManager.findPreset(name);
    const selectedPreset = presetManager.getSelectedPreset();

    if (preset === selectedPreset) {
        console.debug(`Preset already selected for API: ${main_api}, name: ${name}`);
        return;
    }

    if (preset !== undefined && preset !== null) {
        console.log(`Preset found for API: ${main_api}, name: ${name}`);
        await presetManager.selectPreset(preset);
    }
}

/**
 * Resolves once the requested preset manager emits its change event.
 * @param {PresetManager} presetManager Preset manager
 * @returns {Promise<void>}
 */
function waitForPresetChange(presetManager) {
    if (!PRESET_CHANGE_EVENT_APIS.has(presetManager.apiId)) {
        return Promise.resolve();
    }

    return new Promise((resolve) => {
        let timeout;
        const listener = (data = {}) => {
            if (data.apiId !== presetManager.apiId) {
                return;
            }

            eventSource.removeListener(event_types.PRESET_CHANGED, listener);
            clearTimeout(timeout);
            resolve();
        };
        timeout = setTimeout(() => {
            eventSource.removeListener(event_types.PRESET_CHANGED, listener);
            resolve();
        }, PRESET_CHANGE_TIMEOUT_MS);

        eventSource.on(event_types.PRESET_CHANGED, listener);
    });
}

/**
 * Gets a preset manager by API id.
 * @param {string} apiId API id
 * @returns {PresetManager} Preset manager
 */
export function getPresetManager(apiId = '') {
    if (apiId === 'koboldhorde') {
        apiId = 'kobold';
    }
    if (!apiId) {
        apiId = main_api == 'koboldhorde' ? 'kobold' : main_api;
    }

    if (!Object.keys(presetManagers).includes(apiId)) {
        return null;
    }

    return presetManagers[apiId];
}

/**
 * Registers preset managers for all select elements with data-preset-manager-for attribute.
 */
function registerPresetManagers() {
    $('select[data-preset-manager-for]').each((_, e) => {
        const forData = $(e).data('preset-manager-for');

        for (const apiId of forData.split(',')) {
            console.debug(`Registering preset manager for API: ${apiId}`);
            presetManagers[apiId] = new PresetManager($(e), apiId);
        }
    });
}

function snapshotAllPresetManagers() {
    Object.values(presetManagers).forEach(manager => manager.scheduleSnapshotTextFields());
}

function registerPresetDirtySnapshots() {
    // SillyBunny: keep preset dirty-state tracking aligned with the extra
    // text fields and template drawers added outside the upstream preset UI.
    eventSource.on(event_types.SETTINGS_LOADED, snapshotAllPresetManagers);
    eventSource.on(event_types.APP_READY, snapshotAllPresetManagers);
    eventSource.on(event_types.PRESET_CHANGED, (data = {}) => {
        getPresetManager(data.apiId)?.snapshotTextFields();
    });
}

function injectRestoreDefaultPresetButtons() {
    $('[data-preset-manager-restore]').each((_, element) => {
        const apiId = $(element).data('preset-manager-restore');
        if (!apiId || $(element).siblings(`[data-preset-manager-restore-defaults="${apiId}"]`).length) {
            return;
        }

        const button = $('<div></div>', {
            class: 'menu_button menu_button_icon',
            title: t`Restore default presets`,
            'aria-label': t`Restore default presets`,
            'data-i18n': '[title]Restore default presets',
            'data-preset-manager-restore-defaults': apiId,
            html: '<i class="fa-solid fa-box-open" aria-hidden="true"></i>',
        });

        $(element).after(button);
    });
}

class PresetManager {
    constructor(select, apiId) {
        this.select = select;
        this.apiId = apiId;
        this._textSnapshot = new Map();
        this._dirty = false;
        this._previousSelectValue = this.getSelectedPreset();
        this._beforeUnloadHandler = null;
        this._snapshotTimer = null;
        this._isApplyingPresetChange = false;
        this._allowPresetSelectChange = false;
        this._presetSelectTouchGuardState = null;
        this._presetSelectTouchSuppressClick = false;
        this._textInputHandler = () => this._checkDirty();
        this._selectChangeHandler = (event) => this._handleSelectChange(event);
        this._capturePreviousSelectValueHandler = () => this._capturePreviousSelectValue();
        this._presetSelectPointerDownHandler = (event) => this._handlePresetSelectPointerDown(event);
        this._presetSelectPointerMoveHandler = (event) => this._handlePresetSelectPointerMove(event);
        this._presetSelectPointerEndHandler = (event) => this._handlePresetSelectPointerEnd(event);
        this._presetSelectPointerCancelHandler = (event) => this._handlePresetSelectPointerCancel(event);
        this._presetSelectPointerLeaveHandler = (event) => this._handlePresetSelectPointerLeave(event);
        this._presetSelectClickHandler = (event) => this._handlePresetSelectClick(event);
        // SillyBunny: snapshot and guard all connected text fields before preset
        // changes so unsaved changes in fork-specific drawers can still warn.
        this._bindDirtyGuard();
    }

    static masterSections = {
        'instruct': {
            name: 'Instruct Template',
            getData: () => {
                const manager = getPresetManager('instruct');
                const name = manager.getSelectedPresetName();
                return manager.getPresetSettings(name);
            },
            setData: (data) => {
                const manager = getPresetManager('instruct');
                const name = data.name;
                return manager.savePreset(name, data);
            },
            isValid: (data) => PresetManager.isPossiblyInstructData(data),
        },
        'context': {
            name: 'Context Template',
            getData: () => {
                const manager = getPresetManager('context');
                const name = manager.getSelectedPresetName();
                return manager.getPresetSettings(name);
            },
            setData: (data) => {
                const manager = getPresetManager('context');
                const name = data.name;
                return manager.savePreset(name, data);
            },
            isValid: (data) => PresetManager.isPossiblyContextData(data),
        },
        'sysprompt': {
            name: 'System Prompt',
            getData: () => {
                const manager = getPresetManager('sysprompt');
                const name = manager.getSelectedPresetName();
                return manager.getPresetSettings(name);
            },
            setData: (data) => {
                const manager = getPresetManager('sysprompt');
                const name = data.name;
                return manager.savePreset(name, data);
            },
            isValid: (data) => PresetManager.isPossiblySystemPromptData(data),
        },
        'preset': {
            name: 'Text Completion Preset',
            getData: () => {
                const manager = getPresetManager('textgenerationwebui');
                const name = manager.getSelectedPresetName();
                const data = manager.getPresetSettings(name);
                data.name = name;
                return data;
            },
            setData: (data) => {
                const manager = getPresetManager('textgenerationwebui');
                const name = data.name;
                return manager.savePreset(name, data);
            },
            isValid: (data) => PresetManager.isPossiblyTextCompletionData(data),
        },
        'reasoning': {
            name: 'Reasoning Formatting',
            getData: () => {
                const manager = getPresetManager('reasoning');
                const name = manager.getSelectedPresetName();
                return manager.getPresetSettings(name);
            },
            setData: (data) => {
                const manager = getPresetManager('reasoning');
                const name = data.name;
                return manager.savePreset(name, data);
            },
            isValid: (data) => PresetManager.isPossiblyReasoningData(data),
        },
        'srw': {
            name: 'Start Reply With',
            getData: () => {
                return {
                    value: power_user.user_prompt_bias ?? '',
                    show: power_user.show_user_prompt_bias ?? false,
                };
            },
            setData: (data) => {
                power_user.user_prompt_bias = data.value ?? '';
                power_user.show_user_prompt_bias = data.show ?? false;
                $('#start_reply_with').val(power_user.user_prompt_bias);
                $('#chat-show-reply-prefix-checkbox').prop('checked', power_user.show_user_prompt_bias);
                return saveSettingsDebounced();
            },
            isValid: (data) => PresetManager.isPossiblyStartReplyWithData(data),
        },
    };

    static isPossiblyInstructData(data) {
        const instructProps = ['name', 'input_sequence', 'output_sequence'];
        return data && instructProps.every(prop => Object.keys(data).includes(prop));
    }

    static isPossiblyContextData(data) {
        const contextProps = ['name', 'story_string'];
        return data && contextProps.every(prop => Object.keys(data).includes(prop));
    }

    static isPossiblySystemPromptData(data) {
        const sysPromptProps = ['name', 'content'];
        return data && sysPromptProps.every(prop => Object.keys(data).includes(prop));
    }

    static isPossiblyTextCompletionData(data) {
        const textCompletionProps = ['temp', 'top_k', 'top_p', 'rep_pen'];
        return data && textCompletionProps.every(prop => Object.keys(data).includes(prop));
    }

    static isPossiblyReasoningData(data) {
        const reasoningProps = ['name', 'prefix', 'suffix', 'separator'];
        return data && reasoningProps.every(prop => Object.keys(data).includes(prop));
    }

    static isPossiblyStartReplyWithData(data) {
        return data && 'value' in data && 'show' in data;
    }

    /**
     * Imports master settings from JSON data.
     * @param {object} data Data to import
     * @param {string} fileName File name
     * @returns {Promise<void>}
     */
    static async performMasterImport(data, fileName) {
        if (!data || typeof data !== 'object') {
            toastr.error(t`Invalid data provided for master import`);
            return;
        }

        // Check for legacy file imports
        // 1. Instruct Template
        if (this.isPossiblyInstructData(data)) {
            toastr.info(t`Importing instruct template...`, t`Instruct template detected`);
            return await getPresetManager('instruct').savePreset(data.name, data);
        }

        // 2. Context Template
        if (this.isPossiblyContextData(data)) {
            toastr.info(t`Importing as context template...`, t`Context template detected`);
            return await getPresetManager('context').savePreset(data.name, data);
        }

        // 3. System Prompt
        if (this.isPossiblySystemPromptData(data)) {
            toastr.info(t`Importing as system prompt...`, t`System prompt detected`);
            return await getPresetManager('sysprompt').savePreset(data.name, data);
        }

        // 4. Text Completion settings
        if (this.isPossiblyTextCompletionData(data)) {
            toastr.info(t`Importing as settings preset...`, t`Text Completion settings detected`);
            return await getPresetManager('textgenerationwebui').savePreset(fileName, data);
        }

        // 5. Reasoning Template
        if (this.isPossiblyReasoningData(data)) {
            toastr.info(t`Importing as reasoning template...`, t`Reasoning template detected`);
            return await getPresetManager('reasoning').savePreset(data.name, data);
        }

        const validSections = [];
        for (const [key, section] of Object.entries(this.masterSections)) {
            if (key in data && section.isValid(data[key])) {
                validSections.push(key);
            }
        }

        if (validSections.length === 0) {
            toastr.error(t`No valid sections found in imported data`);
            return;
        }

        const sectionNames = validSections.reduce((acc, key) => {
            acc[key] = { key: key, name: this.masterSections[key].name, preset: data[key]?.name || '' };
            return acc;
        }, {});

        const html = $(await renderTemplateAsync('masterImport', { sections: sectionNames }));
        const popup = new Popup(html, POPUP_TYPE.CONFIRM, '', {
            okButton: t`Import`,
            cancelButton: t`Cancel`,
        });

        const result = await popup.show();

        // Import cancelled
        if (result !== POPUP_RESULT.AFFIRMATIVE) {
            return;
        }

        const importedSections = [];
        const confirmedSections = html.find('input:checked').map((_, el) => el instanceof HTMLInputElement && el.value).get();

        if (confirmedSections.length === 0) {
            toastr.info(t`No sections selected for import`);
            return;
        }

        for (const section of confirmedSections) {
            const sectionData = data[section];
            const masterSection = this.masterSections[section];
            if (sectionData && masterSection) {
                await masterSection.setData(sectionData);
                importedSections.push(masterSection.name);
            }
        }

        toastr.success(t`Imported ${importedSections.length} settings: ${importedSections.join(', ')}`);
    }

    /**
     * Exports master settings to JSON data.
     * @returns {Promise<string>} JSON data
     */
    static async performMasterExport() {
        const sectionNames = Object.entries(this.masterSections).reduce((acc, [key, section]) => {
            acc[key] = { key: key, name: section.name, checked: !['preset', 'srw'].includes(key) };
            return acc;
        }, {});
        const html = $(await renderTemplateAsync('masterExport', { sections: sectionNames }));

        const popup = new Popup(html, POPUP_TYPE.CONFIRM, '', {
            okButton: t`Export`,
            cancelButton: t`Cancel`,
        });

        const result = await popup.show();

        // Export cancelled
        if (result !== POPUP_RESULT.AFFIRMATIVE) {
            return;
        }

        const confirmedSections = html.find('input:checked').map((_, el) => el instanceof HTMLInputElement && el.value).get();
        const data = {};

        if (confirmedSections.length === 0) {
            toastr.info(t`No sections selected for export`);
            return;
        }

        for (const section of confirmedSections) {
            const masterSection = this.masterSections[section];
            if (masterSection) {
                data[section] = masterSection.getData();
            }
        }

        return JSON.stringify(data, null, 4);
    }

    /**
     * Gets all preset names.
     * @returns {string[]} List of preset names
     */
    getAllPresets() {
        return $(this.select).find('option').map((_, el) => el.text).toArray();
    }

    /**
     * Finds a preset by name.
     * @param {string} name Preset name
     * @returns {any} Preset value
     */
    findPreset(name) {
        return $(this.select).find('option').filter(function () {
            return $(this).text() === name;
        }).val();
    }

    /**
     * Gets the selected preset value.
     * @returns {any} Selected preset value
     */
    getSelectedPreset() {
        return $(this.select).find('option:selected').val();
    }

    /**
     * Gets the selected preset name.
     * @returns {string} Selected preset name
     */
    getSelectedPresetName() {
        return $(this.select).find('option:selected').text();
    }

    _bindDirtyGuard() {
        const selectElement = $(this.select)[0];
        if (!(selectElement instanceof HTMLSelectElement)) {
            return;
        }

        selectElement.addEventListener('focus', this._capturePreviousSelectValueHandler, true);
        selectElement.addEventListener('pointerdown', this._capturePreviousSelectValueHandler, true);
        selectElement.addEventListener('keydown', this._capturePreviousSelectValueHandler, true);
        selectElement.addEventListener('change', this._selectChangeHandler, true);
        selectElement.addEventListener('pointerdown', this._presetSelectPointerDownHandler, true);
        selectElement.addEventListener('pointermove', this._presetSelectPointerMoveHandler, true);
        selectElement.addEventListener('pointerup', this._presetSelectPointerEndHandler, true);
        selectElement.addEventListener('pointercancel', this._presetSelectPointerCancelHandler, true);
        selectElement.addEventListener('pointerleave', this._presetSelectPointerLeaveHandler, true);
        selectElement.addEventListener('click', this._presetSelectClickHandler, true);
    }

    _isMobilePresetSelectTouchGuardEnabled() {
        return globalThis.SillyBunnyShell?.isMobileViewport?.()
            ?? Boolean(globalThis.matchMedia?.('(max-width: 768px)')?.matches);
    }

    _handlePresetSelectPointerDown(event) {
        this._presetSelectTouchSuppressClick = false;
        this._presetSelectTouchGuardState = createPresetSelectTouchGuardState({
            isMobileViewport: this._isMobilePresetSelectTouchGuardEnabled(),
            pointerType: event.pointerType,
            pointerId: event.pointerId,
            clientX: event.clientX,
            clientY: event.clientY,
        });
    }

    _handlePresetSelectPointerMove(event) {
        this._presetSelectTouchGuardState = resolvePresetSelectTouchGuardMove({
            touchGuardState: this._presetSelectTouchGuardState,
            pointerId: event.pointerId,
            clientX: event.clientX,
            clientY: event.clientY,
        });
    }

    _handlePresetSelectPointerEnd(event) {
        const touchGuardResult = resolvePresetSelectTouchGuardEnd({
            touchGuardState: this._presetSelectTouchGuardState,
            pointerId: event.pointerId,
        });

        this._presetSelectTouchGuardState = touchGuardResult.touchGuardState;
        this._presetSelectTouchSuppressClick = touchGuardResult.shouldSuppressClick;

        if (touchGuardResult.shouldSuppressClick) {
            event.preventDefault();
            event.stopImmediatePropagation();
        }
    }

    _handlePresetSelectPointerCancel(event) {
        const touchGuardResult = resolvePresetSelectTouchGuardEnd({
            touchGuardState: this._presetSelectTouchGuardState,
            pointerId: event.pointerId,
            forceSuppress: true,
        });

        this._presetSelectTouchGuardState = touchGuardResult.touchGuardState;
        this._presetSelectTouchSuppressClick = touchGuardResult.shouldSuppressClick;
    }

    _handlePresetSelectPointerLeave(event) {
        const touchGuardResult = resolvePresetSelectTouchGuardEnd({
            touchGuardState: this._presetSelectTouchGuardState,
            pointerId: event.pointerId,
            forceSuppress: true,
        });

        this._presetSelectTouchGuardState = touchGuardResult.touchGuardState;
        this._presetSelectTouchSuppressClick = touchGuardResult.shouldSuppressClick;
    }

    _handlePresetSelectClick(event) {
        if (!shouldSuppressPresetSelectTouchClick({
            isMobileViewport: this._isMobilePresetSelectTouchGuardEnabled(),
            suppressClick: this._presetSelectTouchSuppressClick,
        })) {
            return;
        }

        this._presetSelectTouchSuppressClick = false;
        event.preventDefault();
        event.stopImmediatePropagation();
    }

    _capturePreviousSelectValue() {
        this._previousSelectValue = this.getSelectedPreset();
    }

    _getAssociatedPanels() {
        const selector = PRESET_TEXT_FIELD_PANEL_SELECTORS[this.apiId];
        if (!selector) {
            return [];
        }

        return Array.from(document.querySelectorAll(selector));
    }

    _getAssociatedTextFields() {
        const fields = new Set();

        for (const panel of this._getAssociatedPanels()) {
            if (panel.matches(PRESET_TEXT_FIELD_SELECTOR)) {
                fields.add(panel);
                continue;
            }

            panel.querySelectorAll(PRESET_TEXT_FIELD_SELECTOR).forEach(element => fields.add(element));
        }

        return Array.from(fields).filter(element => element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement);
    }

    snapshotTextFields() {
        this._clearScheduledSnapshot();

        for (const element of this._textSnapshot.keys()) {
            element.removeEventListener('input', this._textInputHandler);
        }

        this._textSnapshot.clear();
        this._dirty = false;
        this._isApplyingPresetChange = false;
        this._previousSelectValue = this.getSelectedPreset();

        for (const element of this._getAssociatedTextFields()) {
            this._textSnapshot.set(element, element.value);
            element.addEventListener('input', this._textInputHandler);
        }

        this._updateBeforeUnload();
    }

    scheduleSnapshotTextFields() {
        this._isApplyingPresetChange = true;

        if (this._snapshotTimer) {
            clearTimeout(this._snapshotTimer);
        }

        this._snapshotTimer = setTimeout(() => {
            this._snapshotTimer = null;
            this.snapshotTextFields();
        }, 0);
    }

    _clearScheduledSnapshot() {
        if (this._snapshotTimer) {
            clearTimeout(this._snapshotTimer);
            this._snapshotTimer = null;
        }
    }

    _checkDirty({ force = false } = {}) {
        if (this._isApplyingPresetChange && !force) {
            return;
        }

        let dirty = false;

        for (const [element, savedValue] of this._textSnapshot) {
            if (!element.isConnected) {
                continue;
            }

            if (element.value !== savedValue) {
                dirty = true;
                break;
            }
        }

        if (dirty && !this._dirty) {
            this._previousSelectValue = this.getSelectedPreset();
        } else if (!dirty) {
            this._previousSelectValue = this.getSelectedPreset();
        }

        this._dirty = dirty;
        this._updateBeforeUnload();
    }

    _updateBeforeUnload() {
        if (this._dirty && !this._beforeUnloadHandler) {
            this._beforeUnloadHandler = (event) => {
                event.preventDefault();
                event.returnValue = '';
                return '';
            };
            window.addEventListener('beforeunload', this._beforeUnloadHandler);
        } else if (!this._dirty && this._beforeUnloadHandler) {
            window.removeEventListener('beforeunload', this._beforeUnloadHandler);
            this._beforeUnloadHandler = null;
        }
    }

    _runInternalPresetSelectChange(callback) {
        this._allowPresetSelectChange = true;

        try {
            return callback();
        } finally {
            this._allowPresetSelectChange = false;
        }
    }

    _triggerPresetSelectChange(value) {
        this.scheduleSnapshotTextFields();
        this._runInternalPresetSelectChange(() => {
            const selectElement = $(this.select)[0];
            $(this.select).val(value);

            if (selectElement instanceof HTMLSelectElement) {
                selectElement.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
            } else {
                $(this.select).trigger('change');
            }
        });
    }

    _handleSelectChange(event) {
        if (!this._allowPresetSelectChange) {
            this._clearScheduledSnapshot();
            this._isApplyingPresetChange = false;
            this._checkDirty({ force: true });
        }

        if (this._allowPresetSelectChange || !this._dirty) {
            this.scheduleSnapshotTextFields();
            return;
        }

        const selectElement = event.currentTarget;
        if (!(selectElement instanceof HTMLSelectElement)) {
            return;
        }

        const newValue = selectElement.value;
        const previousValue = this._previousSelectValue;

        if (previousValue === undefined || previousValue === null) {
            this.scheduleSnapshotTextFields();
            return;
        }

        if (String(newValue) === String(previousValue)) {
            return;
        }

        event.preventDefault();
        event.stopImmediatePropagation();
        $(selectElement).val(previousValue);
        this._confirmDiscardAndSelect(newValue);
    }

    async _confirmDiscardAndSelect(newValue) {
        const bodyText = !this.isAdvancedFormatting()
            ? t`You have unsaved changes to this preset. Discard them?`
            : t`You have unsaved changes to this template. Discard them?`;
        const confirm = await Popup.show.confirm(t`Unsaved changes`, bodyText);

        if (confirm !== POPUP_RESULT.AFFIRMATIVE) {
            return;
        }

        this._dirty = false;
        this._updateBeforeUnload();
        this._triggerPresetSelectChange(newValue);
    }

    /**
     * Selects a preset by option value.
     * @param {string} value Preset option value
     * @returns {Promise<void>}
     */
    async selectPreset(value) {
        const option = $(this.select).find('option').filter(function () {
            return String($(this).val()) === String(value);
        });
        const presetName = option.text();
        const waitForChange = presetName ? waitForPresetChange(this) : Promise.resolve();
        option.prop('selected', true);
        this._triggerPresetSelectChange(value);
        await waitForChange;
        this.snapshotTextFields();
    }

    /**
     * Updates the preset select element with the current API presets.
     * @param {object} [options] Options for saving the preset
     * @param {boolean} [options.skipUpdate=false] If true, skips updating the preset list after saving.
     */
    async updatePreset(option = { skipUpdate: false }) {
        const selected = $(this.select).find('option:selected');
        console.log(selected);

        if (selected.val() == 'gui') {
            toastr.info(t`Cannot update GUI preset`);
            return;
        }

        const name = selected.text();
        const headerText = !this.isAdvancedFormatting() ? t`Save this preset?` : t`Save this template?`;
        const bodyText = !this.isAdvancedFormatting()
            ? t`This will overwrite the selected preset.`
            : t`This will overwrite the selected template.`;
        const confirm = await Popup.show.confirm(headerText, bodyText);
        if (confirm !== POPUP_RESULT.AFFIRMATIVE) {
            console.debug(!this.isAdvancedFormatting() ? 'Preset update cancelled' : 'Template update cancelled');
            return;
        }

        await this.savePreset(name, null, option);
        this.snapshotTextFields();

        const successToast = !this.isAdvancedFormatting() ? t`Preset updated` : t`Template updated`;
        toastr.success(successToast);
    }

    /**
     * Saves the currently selected preset with a new name.
     */
    async savePresetAs() {
        const inputValue = this.getSelectedPresetName();
        const popupText = !this.isAdvancedFormatting() ? '<h4>' + t`Hint: Use a character/group name to bind preset to a specific chat.` + '</h4>' : '';
        const headerText = !this.isAdvancedFormatting() ? t`Preset name:` : t`Template name:`;
        const name = await Popup.show.input(headerText, popupText, inputValue);
        if (!name) {
            console.log('Preset name not provided');
            return;
        }

        await this.savePreset(name);
        this.snapshotTextFields();

        const successToast = !this.isAdvancedFormatting() ? t`Preset saved` : t`Template saved`;
        toastr.success(successToast);
    }

    /**
     * Saves a preset with the given name and settings.
     * @param {string} name Name of the preset to save
     * @param {object} [settings] Settings to save as the preset. If not provided, uses the current preset settings.
     * @param {object} [options] Options for saving the preset
     * @param {boolean} [options.skipUpdate=false] If true, skips updating the preset list after saving.
     */
    async savePreset(name, settings, { skipUpdate = false } = {}) {
        if (this.apiId === 'instruct' && settings) {
            await checkForSystemPromptInInstructTemplate(name, settings);
        }

        if (this.apiId === 'novel' && settings) {
            settings = convertNovelPreset(settings);
        }

        const preset = settings ?? this.getPresetSettings(name);

        const response = await fetch('/api/presets/save', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ preset, name, apiId: this.apiId }),
        });

        if (!response.ok) {
            toastr.error(t`Check the server connection and reload the page to prevent data loss.`, t`Preset could not be saved`);
            console.error('Preset could not be saved', response);
            throw new Error('Preset could not be saved');
        }

        const data = await response.json();
        name = data.name;

        if (skipUpdate) {
            console.debug(`Preset ${name} saved, but not updating the list`);
            return;
        }

        this.updateList(name, preset);
    }

    /**
     * Renames the currently selected preset.
     * @param {string} newName New name for the preset
     */
    async renamePreset(newName) {
        const oldName = this.getSelectedPresetName();
        if (equalsIgnoreCaseAndAccents(oldName, newName)) {
            throw new Error('New name must be different from old name');
        }
        try {
            await this.savePreset(newName);
            await this.deletePreset(oldName);
        } catch (error) {
            toastr.error(t`Check the server connection and reload the page to prevent data loss.`, t`Preset could not be renamed`);
            console.error('Preset could not be renamed', error);
            throw new Error('Preset could not be renamed');
        }
    }

    /**
     * Gets a list of presets for the API.
     * @param {string} [api] API ID. If not specified, uses the current API ID.
     * @returns {{presets: any[], preset_names: object, settings: object}}
     */
    getPresetList(api) {
        let presets = [];
        let preset_names = {};
        let settings = {};

        // If no API specified, use the current API
        if (api === undefined) {
            api = this.apiId;
        }

        switch (api) {
            case 'koboldhorde':
            case 'kobold':
                presets = koboldai_settings;
                preset_names = koboldai_setting_names;
                settings = kai_settings;
                break;
            case 'novel':
                presets = novelai_settings;
                preset_names = novelai_setting_names;
                settings = nai_settings;
                break;
            case 'textgenerationwebui':
                presets = textgenerationwebui_presets;
                preset_names = textgenerationwebui_preset_names;
                settings = textgen_settings;
                break;
            case 'openai':
                presets = openai_settings;
                preset_names = openai_setting_names;
                settings = oai_settings;
                break;
            case 'context':
                presets = context_presets;
                preset_names = context_presets.map(x => x.name);
                settings = power_user.context;
                break;
            case 'instruct':
                presets = instruct_presets;
                preset_names = instruct_presets.map(x => x.name);
                settings = power_user.instruct;
                break;
            case 'sysprompt':
                presets = system_prompts;
                preset_names = system_prompts.map(x => x.name);
                settings = power_user.sysprompt;
                break;
            case 'reasoning':
                presets = reasoning_templates;
                preset_names = reasoning_templates.map(x => x.name);
                settings = power_user.reasoning;
                break;
            default:
                console.warn(`Unknown API ID ${api}`);
        }

        return { presets, preset_names, settings };
    }

    /**
     * Returns true if the API is keyed, meaning it uses a name to identify presets.
     */
    isKeyedApi() {
        return this.apiId == 'textgenerationwebui' || this.isAdvancedFormatting();
    }

    /**
     * Returns true if the API is from Advanced Formatting group.
     */
    isAdvancedFormatting() {
        return ['context', 'instruct', 'sysprompt', 'reasoning'].includes(this.apiId);
    }

    /**
     * Updates the preset list with a new or existing preset.
     * @param {string} name Name of the preset
     * @param {object} preset Preset object
     */
    updateList(name, preset) {
        const { presets, preset_names } = this.getPresetList();
        const presetExists = this.isKeyedApi() ? preset_names.includes(name) : Object.keys(preset_names).includes(name);

        if (presetExists) {
            if (this.isKeyedApi()) {
                presets[preset_names.indexOf(name)] = preset;
                $(this.select).find(`option[value="${name}"]`).prop('selected', true);
                this._triggerPresetSelectChange(name);
            } else {
                const value = preset_names[name];
                presets[value] = preset;
                $(this.select).find(`option[value="${value}"]`).prop('selected', true);
                this._triggerPresetSelectChange(value);
            }
        } else {
            presets.push(preset);
            const value = presets.length - 1;

            if (this.isKeyedApi()) {
                preset_names[value] = name;
                const option = $('<option></option>', { value: name, text: name, selected: true });
                $(this.select).append(option);
                this._triggerPresetSelectChange(name);
            } else {
                preset_names[name] = value;
                const option = $('<option></option>', { value: value, text: name, selected: true });
                $(this.select).append(option);
                this._triggerPresetSelectChange(value);
            }
        }
    }

    /**
     * Gets the preset settings for the given name.
     * @param {string} name Name of the preset
     * @returns {object} Preset settings object for the given name
     */
    getPresetSettings(name) {
        function getSettingsByApiId(apiId) {
            switch (apiId) {
                case 'koboldhorde':
                case 'kobold':
                    return kai_settings;
                case 'novel':
                    return nai_settings;
                case 'textgenerationwebui':
                    return getTextCompletionPresetSettings();
                case 'openai':
                    return getChatCompletionPreset(oai_settings);
                case 'context': {
                    const context_preset = getContextSettings();
                    context_preset.name = name || power_user.context.preset;
                    return context_preset;
                }
                case 'instruct': {
                    const instruct_preset = structuredClone(power_user.instruct);
                    instruct_preset.name = name || power_user.instruct.preset;
                    return instruct_preset;
                }
                case 'sysprompt': {
                    const sysprompt_preset = structuredClone(power_user.sysprompt);
                    sysprompt_preset.name = name || power_user.sysprompt.preset;
                    return sysprompt_preset;
                }
                case 'reasoning': {
                    const reasoning_preset = structuredClone(power_user.reasoning);
                    reasoning_preset.name = name || power_user.reasoning.preset;
                    return reasoning_preset;
                }
                default:
                    console.warn(`Unknown API ID ${apiId}`);
                    return {};
            }
        }

        const filteredKeys = [
            'api_server',
            'preset',
            'streaming',
            'truncation_length',
            'n',
            'streaming_url',
            'stopping_strings',
            'can_use_tokenization',
            'can_use_streaming',
            'preset_settings_novel',
            'preset_settings',
            'streaming_novel',
            'nai_preamble',
            'model_novel',
            'streaming_kobold',
            'enabled',
            'bind_to_context',
            'seed',
            'legacy_api',
            'mancer_model',
            'togetherai_model',
            'ollama_model',
            'vllm_model',
            'aphrodite_model',
            'llamacpp_model',
            'server_urls',
            'type',
            'custom_model',
            'bypass_status_check',
            'infermaticai_model',
            'dreamgen_model',
            'openrouter_model',
            'featherless_model',
            'max_tokens_second',
            'openrouter_providers',
            'openrouter_quantizations',
            'openrouter_allow_fallbacks',
            'tabby_model',
            'derived',
            'generic_model',
            'include_reasoning',
            'global_banned_tokens',
            'send_banned_tokens',

            // Reasoning exclusions
            'auto_parse',
            'add_to_prompts',
            'auto_expand',
            'show_hidden',
            'max_additions',
        ];
        /** @type {Record<string, any>} */
        const settings = Object.assign({}, getSettingsByApiId(this.apiId));

        for (const key of filteredKeys) {
            if (Object.hasOwn(settings, key)) {
                delete settings[key];
            }
        }

        if (!this.isAdvancedFormatting() && this.apiId !== 'openai') {
            settings.genamt = amount_gen;
            settings.max_length = max_context;
        }

        return settings;
    }

    /**
     * Retrieves a completion preset by name.
     * @param {string} name Name of the preset to retrieve
     * @returns {any} Preset object if found, otherwise undefined
     */
    getCompletionPresetByName(name) {
        // Retrieve a completion preset by name. Return undefined if not found.
        let { presets, preset_names } = this.getPresetList();
        let preset;

        // Some APIs use an array of names, others use an object of {name: index}
        if (Array.isArray(preset_names)) {  // array of names
            if (preset_names.includes(name)) {
                preset = presets[preset_names.indexOf(name)];
            }
        } else {  // object of {names: index}
            if (preset_names[name] !== undefined) {
                preset = presets[preset_names[name]];
            }
        }

        if (preset === undefined) {
            console.error(`Preset ${name} not found`);
        }

        // if the preset isn't found, returns undefined
        return preset;
    }

    /**
     * Deletes a preset by name. If not provided, deletes the currently selected preset.
     * @param {string} [name] Name of the preset to delete.
     */
    async deletePreset(name) {
        const { preset_names, presets } = this.getPresetList();
        const value = name ? (this.isKeyedApi() ? this.findPreset(name) : name) : this.getSelectedPreset();
        const nameToDelete = name || this.getSelectedPresetName();

        if (value == 'gui') {
            toastr.info(t`Cannot delete GUI preset`);
            return;
        }

        if (this.isKeyedApi()) {
            $(this.select).find(`option[value="${value}"]`).remove();
            const index = preset_names.indexOf(nameToDelete);
            preset_names.splice(index, 1);
            presets.splice(index, 1);
        } else {
            const index = preset_names[nameToDelete];
            $(this.select).find(`option[value="${index}"]`).remove();
            delete preset_names[nameToDelete];
        }

        // switch in UI only when deleting currently selected preset
        const switchPresets = !name || this.getSelectedPresetName() == name;

        if (Object.keys(preset_names).length && switchPresets) {
            const nextPresetName = Object.keys(preset_names)[0];
            const newValue = preset_names[nextPresetName];
            $(this.select).find(`option[value="${newValue}"]`).attr('selected', 'true');
            this._triggerPresetSelectChange(newValue);
        }

        const response = await fetch('/api/presets/delete', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ name: nameToDelete, apiId: this.apiId }),
        });

        return response.ok;
    }

    /**
     * Deletes multiple presets by name.
     * @param {string[]} names Names of presets to delete.
     * @returns {Promise<{deleted: string[], failed: string[]}>}
     */
    async deletePresets(names) {
        const deleted = [];
        const failed = [];

        for (const name of names) {
            try {
                const result = await this.deletePreset(name);
                if (result) {
                    deleted.push(name);
                } else {
                    failed.push(name);
                }
            } catch {
                failed.push(name);
            }
        }

        return { deleted, failed };
    }

    /**
     * Opens a checkbox picker for deleting multiple presets.
     * @returns {Promise<string[]>}
     */
    async selectPresetsForDeletion() {
        const presetNames = this.getAllPresets().filter(name => name !== 'gui');

        if (presetNames.length === 0) {
            toastr.info(t`No deletable presets found.`);
            return [];
        }

        const escapeAttr = value => String(value)
            .replaceAll('&', '&amp;')
            .replaceAll('<', '&lt;')
            .replaceAll('>', '&gt;')
            .replaceAll('"', '&quot;');

        const html = $(
            `<div class="flex-container flexFlowColumn flexGap10">
                <div>${t`Select the presets you want to delete.`}</div>
                <div class="flex-container flexFlowColumn flexGap5">
                    ${presetNames.map(name => `
                        <label class="checkbox_label justifyStart">
                            <input type="checkbox" value="${escapeAttr(name)}" />
                            <span>${escapeAttr(name)}</span>
                        </label>
                    `).join('')}
                </div>
            </div>`,
        );

        const result = await new Popup(html, POPUP_TYPE.CONFIRM, '', {
            okButton: t`Delete selected`,
            cancelButton: t`Cancel`,
            wide: true,
        }).show();

        if (result !== POPUP_RESULT.AFFIRMATIVE) {
            return [];
        }

        return html.find('input:checked').map((_, el) => String($(el).val())).get();
    }

    /**
     * Retrieves the default preset for the API from the server.
     * @param {string} name Name of the preset to restore
     * @returns {Promise<any>} Default preset object, or undefined if the request fails
     */
    async getDefaultPreset(name) {
        const response = await fetch('/api/presets/restore', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ name, apiId: this.apiId }),
        });

        if (!response.ok) {
            const errorToast = !this.isAdvancedFormatting() ? t`Failed to restore default preset` : t`Failed to restore default template`;
            toastr.error(errorToast);
            return;
        }

        return await response.json();
    }

    /**
     * Restores all bundled default presets for this API.
     * @returns {Promise<any>} Restore result from the server
     */
    async restoreDefaultPresets() {
        const response = await fetch('/api/presets/restore-defaults', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ apiId: this.apiId }),
        });

        if (!response.ok) {
            const errorToast = !this.isAdvancedFormatting() ? t`Failed to restore default presets` : t`Failed to restore default templates`;
            toastr.error(errorToast);
            return null;
        }

        return await response.json();
    }

    /**
     * Adds restored presets to the select and in-memory preset list without selecting them.
     * @param {string[]} filenames Restored preset filenames
     */
    async refreshRestoredDefaultOptions(filenames = []) {
        const { preset_names, presets } = this.getPresetList();
        const names = filenames
            .map(filename => String(filename || '').replace(/\.[^.]+$/, '').split(/[\\/]/).pop())
            .filter(Boolean);

        for (const name of names) {
            if (this.findPreset(name) !== undefined) {
                continue;
            }

            const data = await this.getDefaultPreset(name);
            if (!data?.isDefault || !data.preset || Object.keys(data.preset).length === 0) {
                continue;
            }

            if (this.isKeyedApi()) {
                presets.push(data.preset);
                preset_names.push(name);
                $(this.select).append($('<option></option>', { value: name, text: name }));
            } else if (!Object.hasOwn(preset_names, name)) {
                const value = presets.length;
                presets.push(data.preset);
                preset_names[name] = value;
                $(this.select).append($('<option></option>', { value, text: name }));
            }
        }
    }

    /**
     * Reads a preset extension field from the preset.
     * @param {object} options
     * @param {string} [options.name] Name of the preset. If not provided, uses the currently selected preset name.
     * @param {string} options.path Path to the preset extension field, e.g. 'myextension.data'. If empty, reads the entire extensions object.
     * @return {any} The value of the preset extension field, or null if not found.
     */
    readPresetExtensionField({ name, path }) {
        const { settings } = this.getPresetList();
        const selectedName = this.getSelectedPresetName();
        const presetName = name || selectedName;

        // Read from settings if the selected preset is the same as the provided name
        if (settings && selectedName === presetName) {
            const settingsExtensions = ensurePlainObject(settings.extensions || {});
            return path ? lodash.get(settingsExtensions, path, null) : settingsExtensions;
        }

        // Otherwise, read from the preset by name
        const preset = this.getCompletionPresetByName(presetName);
        if (!preset) {
            return null;
        }

        const presetExtensions = ensurePlainObject(preset.extensions || {});
        const value = path ? lodash.get(presetExtensions, path, null) : presetExtensions;
        return value;
    }

    /**
     * Writes a value to a preset extension field.
     * @param {object} options
     * @param {string} [options.name] Name of the preset. If not provided, uses the currently selected preset name.
     * @param {string} options.path Path to the preset extension field, e.g. 'myextension.data'. If empty, writes to the root of the extensions object.
     * @param {any} options.value Value to write to the preset extension field.
     * @return {Promise<void>} Resolves when the preset is saved.
     */
    async writePresetExtensionField({ name, path, value }) {
        const { settings } = this.getPresetList();
        const selectedName = this.getSelectedPresetName();
        const presetName = name || selectedName;

        // Write to settings if the selected preset is the same as the provided name
        if (settings && selectedName === presetName) {
            // Set the value at the specified path
            settings.extensions = ensurePlainObject(settings.extensions || {});
            path ? lodash.set(settings.extensions, path, value) : (settings.extensions = value);
            await saveSettings();
        }

        // Also update the preset by name
        const preset = this.getCompletionPresetByName(presetName);
        if (!preset) {
            return;
        }

        // Set the value at the specified path
        preset.extensions = ensurePlainObject(preset.extensions || {});
        path ? lodash.set(preset.extensions, path, value) : (preset.extensions = value);

        // Save the updated preset
        await this.savePreset(presetName, preset, { skipUpdate: true });
    }
}

/**
 * Selects a preset by name for current API.
 * @param {any} _ Named arguments
 * @param {string} name Unnamed arguments
 * @returns {Promise<string>} Selected or current preset name
 */
async function presetCommandCallback(_, name) {
    const shouldReconnect = online_status !== 'no_connection';
    const presetManager = getPresetManager();
    const allPresets = presetManager.getAllPresets();
    const currentPreset = presetManager.getSelectedPresetName();

    if (!presetManager) {
        console.debug(`Preset Manager not found for API: ${main_api}`);
        return '';
    }

    if (!name) {
        console.log('No name provided for /preset command, using current preset');
        return currentPreset;
    }

    if (!Array.isArray(allPresets) || allPresets.length === 0) {
        console.log(`No presets found for API: ${main_api}`);
        return currentPreset;
    }

    // Find exact match
    const exactMatch = allPresets.find(p => p.toLowerCase().trim() === name.toLowerCase().trim());

    if (exactMatch) {
        console.log('Found exact preset match', exactMatch);

        if (currentPreset !== exactMatch) {
            const presetValue = presetManager.findPreset(exactMatch);

            if (presetValue) {
                await presetManager.selectPreset(presetValue);
                shouldReconnect && await waitForConnection();
            }
        }

        return exactMatch;
    } else {
        // Find fuzzy match
        const fuse = new Fuse(allPresets);
        const fuzzyMatch = fuse.search(name);

        if (!fuzzyMatch.length) {
            console.warn(`WARN: Preset found with name ${name}`);
            return currentPreset;
        }

        const fuzzyPresetName = fuzzyMatch[0].item;
        const fuzzyPresetValue = presetManager.findPreset(fuzzyPresetName);

        if (fuzzyPresetValue) {
            console.log('Found fuzzy preset match', fuzzyPresetName);

            if (currentPreset !== fuzzyPresetName) {
                await presetManager.selectPreset(fuzzyPresetValue);
                shouldReconnect && await waitForConnection();
            }
        }

        return fuzzyPresetName;
    }
}

/**
 * Waits for API connection to be established.
 */
async function waitForConnection() {
    try {
        await waitUntilCondition(() => online_status !== 'no_connection', 10000, 100);
    } catch {
        console.log('Timeout waiting for API to connect');
    }
}

export async function initPresetManager() {
    eventSource.on(event_types.CHAT_CHANGED, autoSelectPreset);
    registerPresetManagers();
    registerPresetDirtySnapshots();
    snapshotAllPresetManagers();
    injectRestoreDefaultPresetButtons();
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'preset',
        callback: presetCommandCallback,
        returns: 'current preset',
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: 'name',
                typeList: [ARGUMENT_TYPE.STRING],
                enumProvider: () => getPresetManager().getAllPresets().map(preset => new SlashCommandEnumValue(preset, null, enumTypes.enum, enumIcons.preset)),
            }),
        ],
        helpString: `
            <div>
                Sets a preset by name for the current API. Gets the current preset if no name is provided.
            </div>
            <div>
                <strong>Example:</strong>
                <ul>
                    <li>
                        <pre><code>/preset myPreset</code></pre>
                    </li>
                    <li>
                        <pre><code>/preset</code></pre>
                    </li>
                </ul>
            </div>
        `,
    }));


    $(document).on('click', '[data-preset-manager-update]', async function () {
        const apiId = $(this).data('preset-manager-update');
        const presetManager = getPresetManager(apiId);

        if (!presetManager) {
            console.warn(`Preset Manager not found for API: ${apiId}`);
            return;
        }

        await presetManager.updatePreset();
    });

    $(document).on('click', '[data-preset-manager-new]', async function () {
        const apiId = $(this).data('preset-manager-new');
        const presetManager = getPresetManager(apiId);

        if (!presetManager) {
            console.warn(`Preset Manager not found for API: ${apiId}`);
            return;
        }

        await presetManager.savePresetAs();
    });

    $(document).on('click', '[data-preset-manager-rename]', async function () {
        const apiId = $(this).data('preset-manager-rename');
        const presetManager = getPresetManager(apiId);

        if (!presetManager) {
            console.warn(`Preset Manager not found for API: ${apiId}`);
            return;
        }

        const popupHeader = !presetManager.isAdvancedFormatting() ? t`Rename preset` : t`Rename template`;
        const oldName = presetManager.getSelectedPresetName();
        const newName = await getSanitizedFilename(await Popup.show.input(popupHeader, t`Enter a new name:`, oldName) || '');
        if (!newName || oldName === newName) {
            console.debug(!presetManager.isAdvancedFormatting() ? 'Preset rename cancelled' : 'Template rename cancelled');
            return;
        }
        if (equalsIgnoreCaseAndAccents(oldName, newName)) {
            toastr.warning(t`Name not accepted, as it is the same as before (ignoring case and accents).`, t`Rename Preset`);
            return;
        }

        await eventSource.emit(event_types.PRESET_RENAMED_BEFORE, { apiId: apiId, oldName: oldName, newName: newName });
        const extensions = presetManager.readPresetExtensionField({ name: oldName, path: '' });
        await presetManager.renamePreset(newName);
        await presetManager.writePresetExtensionField({ name: newName, path: '', value: extensions });
        await eventSource.emit(event_types.PRESET_RENAMED, { apiId: apiId, oldName: oldName, newName: newName });

        if (apiId === 'openai') {
            // This is a horrible mess, but prevents the renamed preset from being corrupted.
            $('#update_oai_preset').trigger('click');
            return;
        }

        const successToast = !presetManager.isAdvancedFormatting() ? t`Preset renamed` : t`Template renamed`;
        toastr.success(successToast);
    });

    $(document).on('click', '[data-preset-manager-export]', async function () {
        const apiId = $(this).data('preset-manager-export');
        const presetManager = getPresetManager(apiId);

        if (!presetManager) {
            console.warn(`Preset Manager not found for API: ${apiId}`);
            return;
        }

        const selected = $(presetManager.select).find('option:selected');
        const name = selected.text();
        const preset = presetManager.getPresetSettings(name);
        const data = JSON.stringify(preset, null, 4);
        download(data, `${name}.json`, 'application/json');
    });

    $(document).on('click', '[data-preset-manager-import]', async function () {
        const apiId = $(this).data('preset-manager-import');
        $(`[data-preset-manager-file="${apiId}"]`).trigger('click');
    });

    $(document).on('change', '[data-preset-manager-file]', async function (e) {
        const apiId = $(this).data('preset-manager-file');
        const presetManager = getPresetManager(apiId);

        if (!presetManager) {
            console.warn(`Preset Manager not found for API: ${apiId}`);
            return;
        }

        const file = e.target.files[0];

        if (!file) {
            return;
        }

        const fileName = file.name.replace('.json', '').replace('.settings', '');
        const data = await parseJsonFile(file);
        const name = data?.name ?? fileName;
        data.name = name;

        await presetManager.savePreset(name, data);
        const successToast = !presetManager.isAdvancedFormatting() ? t`Preset imported` : t`Template imported`;
        toastr.success(successToast);
        e.target.value = null;
    });

    $(document).on('click', '[data-preset-manager-delete]', async function () {
        const apiId = $(this).data('preset-manager-delete');
        const presetManager = getPresetManager(apiId);

        if (!presetManager) {
            console.warn(`Preset Manager not found for API: ${apiId}`);
            return;
        }

        const headerText = !presetManager.isAdvancedFormatting() ? t`Delete this preset?` : t`Delete this template?`;
        const confirm = await Popup.show.confirm(headerText, t`This action is irreversible and your current settings will be overwritten.`);
        if (!confirm) {
            return;
        }

        const name = presetManager.getSelectedPresetName();
        const result = await presetManager.deletePreset();

        if (result) {
            const successToast = !presetManager.isAdvancedFormatting() ? t`Preset deleted` : t`Template deleted`;
            toastr.success(successToast);
            await eventSource.emit(event_types.PRESET_DELETED, { apiId, name });
        } else {
            const warningToast = !presetManager.isAdvancedFormatting() ? t`Preset was not deleted from server` : t`Template was not deleted from server`;
            toastr.warning(warningToast);
        }

        saveSettingsDebounced();
    });

    $(document).on('click', '[data-preset-manager-delete-all]', async function () {
        const apiId = $(this).data('preset-manager-delete-all');
        const presetManager = getPresetManager(apiId);

        if (!presetManager) {
            console.warn(`Preset Manager not found for API: ${apiId}`);
            return;
        }

        const presetNames = await presetManager.selectPresetsForDeletion();
        if (presetNames.length === 0) {
            return;
        }

        const noun = presetManager.isAdvancedFormatting() ? t`template` : t`preset`;
        const pluralNoun = presetManager.isAdvancedFormatting() ? t`templates` : t`presets`;
        const confirm = await Popup.show.confirm(
            t`Delete selected ${pluralNoun}?`,
            t`This will permanently delete ${presetNames.length} selected ${pluralNoun} for this section. The built-in GUI preset is kept.`,
        );

        if (!confirm) {
            return;
        }

        const { deleted, failed } = await presetManager.deletePresets(presetNames);

        if (deleted.length) {
            toastr.success(t`Deleted ${deleted.length} ${deleted.length === 1 ? noun : pluralNoun}.`);
            for (const name of deleted) {
                await eventSource.emit(event_types.PRESET_DELETED, { apiId, name });
            }
        }

        if (failed.length) {
            toastr.warning(t`Failed to delete ${failed.length} ${failed.length === 1 ? noun : pluralNoun} from the server.`);
        }

        saveSettingsDebounced();
    });

    $(document).on('click', '[data-preset-manager-restore]', async function () {
        const apiId = $(this).data('preset-manager-restore');
        const presetManager = getPresetManager(apiId);

        if (!presetManager) {
            console.warn(`Preset Manager not found for API: ${apiId}`);
            return;
        }

        const name = presetManager.getSelectedPresetName();
        const data = await presetManager.getDefaultPreset(name);

        if (name == 'gui') {
            toastr.info(t`Cannot restore GUI preset`);
            return;
        }

        if (!data) {
            return;
        }

        if (data.isDefault) {
            if (Object.keys(data.preset).length === 0) {
                const errorToast = !presetManager.isAdvancedFormatting() ? t`Default preset cannot be restored` : t`Default template cannot be restored`;
                toastr.error(errorToast);
                return;
            }

            const confirmText = !presetManager.isAdvancedFormatting()
                ? t`Resetting a <b>default preset</b> will restore the default settings.`
                : t`Resetting a <b>default template</b> will restore the default settings.`;
            const confirm = await Popup.show.confirm(t`Are you sure?`, confirmText);
            if (!confirm) {
                return;
            }

            await presetManager.deletePreset();
            await presetManager.savePreset(name, data.preset);
            const option = presetManager.findPreset(name);
            await presetManager.selectPreset(option);
            const successToast = !presetManager.isAdvancedFormatting() ? t`Default preset restored` : t`Default template restored`;
            toastr.success(successToast);
        } else {
            const confirmText = !presetManager.isAdvancedFormatting()
                ? t`Resetting a <b>custom preset</b> will restore to the last saved state.`
                : t`Resetting a <b>custom template</b> will restore to the last saved state.`;
            const confirm = await Popup.show.confirm(t`Are you sure?`, confirmText);
            if (!confirm) {
                return;
            }

            const option = presetManager.findPreset(name);
            await presetManager.selectPreset(option);
            const successToast = !presetManager.isAdvancedFormatting() ? t`Preset restored` : t`Template restored`;
            toastr.success(successToast);
        }
    });

    $(document).on('click', '[data-preset-manager-restore-defaults]', async function () {
        const apiId = $(this).data('preset-manager-restore-defaults');
        const presetManager = getPresetManager(apiId);

        if (!presetManager) {
            console.warn(`Preset Manager not found for API: ${apiId}`);
            return;
        }

        const noun = presetManager.isAdvancedFormatting() ? t`templates` : t`presets`;
        const confirm = await Popup.show.confirm(
            t`Restore default presets?`,
            t`Deleted bundled default ${noun} for this section will be restored. Custom ${noun} are kept.`,
        );

        if (!confirm) {
            return;
        }

        const result = await presetManager.restoreDefaultPresets();
        if (!result) {
            return;
        }

        await presetManager.refreshRestoredDefaultOptions(result.restored);
        toastr.success(t`Restored ${result.restored.length} default ${noun}.`);
        saveSettingsDebounced();
    });

    $('#af_master_import').on('click', () => {
        $('#af_master_import_file').trigger('click');
    });

    $('#af_master_import_file').on('change', async function (e) {
        if (!(e.target instanceof HTMLInputElement)) {
            return;
        }
        const file = e.target.files[0];

        if (!file) {
            return;
        }

        const data = await parseJsonFile(file);
        const fileName = file.name.replace('.json', '');
        await PresetManager.performMasterImport(data, fileName);
        e.target.value = null;
    });

    $('#af_master_export').on('click', async () => {
        const data = await PresetManager.performMasterExport();

        if (!data) {
            return;
        }

        const shortDate = new Date().toISOString().split('T')[0];
        download(data, `ST-formatting-${shortDate}.json`, 'application/json');
    });
}
