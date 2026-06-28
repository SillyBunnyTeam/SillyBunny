import { saveSettingsDebounced, eventSource, event_types } from '../../../script.js';
import { extensionNames, extension_settings, renderExtensionTemplateAsync } from '../../extensions.js';
import {
    extensionName,
    flushActiveGuides,
    getActiveGuides,
    getPresetsForApiType,
    getProfileApiType,
    getProfileList,
    resolveStoredProfile,
} from './scripts/shared.js';
import { guidedCorrection } from './scripts/guidedCorrection.js';
import { guidedImpersonate } from './scripts/guidedImpersonate.js';
import { guidedResponse } from './scripts/guidedResponse.js';
import { guidedSwipe } from './scripts/guidedSwipe.js';
import {
    markOldExtensionWarningDismissed,
    shouldWarnOldExtensionDeprecated,
} from './scripts/legacyForkWarning.js';
import { simpleSend } from './scripts/simpleSend.js';

const oldExtensionKey = 'GuidedGenerations-Extension';
const oldExtensionName = 'third-party/GuidedGenerations-Extension';
const legacySystemPromptPresetNames = new Set(['GGSystemPrompt', 'GGSytemPrompt']);

const defaultSettings = {
    showGuidedResponse: true,
    showGuidedSwipe: true,
    showGuidedCorrection: true,
    showImpersonate1stPerson: true,
    showSimpleSendButton: true,
    showFlushGuidesButton: true,
    integrateQrBar: true,
    injectionEndRole: 'system',
    debugMode: false,
    promptGuidedResponse: '[Take the following into special consideration for your next message: {{input}}]',
    promptGuidedSwipe: '[Take the following into special consideration for your next message: {{input}}]',
    promptGuidedCorrection: '[Apply the following correction to your previous message: {{input}}]',
    promptImpersonate1st: 'Write the next message as {{user}}, not {{char}}. Follow the requested perspective, narration style, and constraints exactly. {{input}}',
    helperPrefillMessages: '',
    depthPromptGuidedResponse: 0,
    depthPromptGuidedSwipe: 0,
    depthPromptGuidedCorrection: 0,
    profileImpersonate1st: '',
    presetImpersonate1st: '',
    profileImpersonate1stApiType: '',
};

let qrObserver;
let qrPollTimer;
let flushGuidePollTimer;

function isLegacySystemPromptPreset(value) {
    return typeof value === 'string' && legacySystemPromptPresetNames.has(value.trim());
}

function sanitizeLegacySettings(settings) {
    let changed = false;

    for (const key of Object.keys(settings)) {
        if (key.startsWith('preset') && isLegacySystemPromptPreset(settings[key])) {
            if (Object.hasOwn(defaultSettings, key)) {
                settings[key] = defaultSettings[key];
            } else {
                delete settings[key];
            }
            changed = true;
        }
    }

    for (const key of ['promptGuidedResponse', 'promptGuidedSwipe', 'promptGuidedCorrection', 'promptImpersonate1st']) {
        if (isLegacySystemPromptPreset(settings[key])) {
            settings[key] = defaultSettings[key];
            changed = true;
        }
    }

    return changed;
}

function getSettings() {
    return extension_settings[extensionName] ?? defaultSettings;
}

function loadSettings() {
    const existing = extension_settings[extensionName] ?? {};
    const settings = Object.assign({}, defaultSettings, existing);
    let changed = false;

    if (extension_settings[oldExtensionKey] && !settings._migrated) {
        const old = extension_settings[oldExtensionKey];
        for (const key of Object.keys(defaultSettings)) {
            if (old[key] !== undefined) {
                settings[key] = old[key];
            }
        }

        settings._migrated = true;
        changed = true;
    }

    if (Object.hasOwn(settings, 'showRecoverInputButton')) {
        delete settings.showRecoverInputButton;
        changed = true;
    }

    changed = sanitizeLegacySettings(settings) || changed;
    extension_settings[extensionName] = settings;

    if (changed) {
        saveSettingsDebounced();
    }
}

function maybeWarnOldExtensionDeprecated() {
    if (!shouldWarnOldExtensionDeprecated(extensionNames, oldExtensionName)) {
        return;
    }

    toastr.warning(
        'The old Guided Generations fork is deprecated and can conflict with the native Guided Generations port. Uninstall or disable the third-party fork.',
        'Guided Generations fork deprecated',
        {
            timeOut: 0,
            extendedTimeOut: 0,
            tapToDismiss: false,
            closeButton: true,
            preventDuplicates: true,
            onCloseClick: () => markOldExtensionWarningDismissed(),
        },
    );
}

function setElementValue(element, value) {
    if (!element) {
        return;
    }

    if (element instanceof HTMLInputElement && element.type === 'checkbox') {
        element.checked = Boolean(value);
        return;
    }

    element.value = value ?? '';
}

async function populateProfiles(container) {
    const profileSelect = container.querySelector('#gg_profileImpersonate1st');
    if (!(profileSelect instanceof HTMLSelectElement)) {
        return;
    }

    const settings = getSettings();
    const profiles = await getProfileList();
    profileSelect.innerHTML = '<option value="">Current profile</option>';
    for (const profile of profiles) {
        const option = document.createElement('option');
        // SillyBunny: use profile id as the option value so retention survives
        // profile renames. Display name is shown to the user. (#529)
        option.value = profile.id;
        option.textContent = profile.name;
        profileSelect.append(option);
    }

    // SillyBunny: resolve the stored value to a valid profile id. Existing
    // settings may store a legacy profile name instead of an id, so use
    // resolveStoredProfile which accepts both. (#529)
    const storedValue = settings.profileImpersonate1st ?? '';
    if (storedValue) {
        const resolved = resolveStoredProfile(storedValue);
        profileSelect.value = resolved?.id ?? '';
        // Migrate the stored value to an id if it was a name.
        if (resolved && resolved.id !== storedValue) {
            settings.profileImpersonate1st = resolved.id;
            saveSettingsDebounced();
        }
    } else {
        profileSelect.value = '';
    }
}

async function populatePresets(container) {
    const settings = getSettings();
    const presetSelect = container.querySelector('#gg_presetImpersonate1st');
    if (!(presetSelect instanceof HTMLSelectElement)) {
        return;
    }

    const selectedProfile = settings.profileImpersonate1st ?? '';
    const apiType = await getProfileApiType(selectedProfile);
    const presets = await getPresetsForApiType(apiType);

    presetSelect.innerHTML = '<option value="">No preset switch</option>';
    for (const preset of presets) {
        const option = document.createElement('option');
        option.value = preset;
        option.textContent = preset;
        presetSelect.append(option);
    }
    presetSelect.value = settings.presetImpersonate1st ?? '';
    settings.profileImpersonate1stApiType = apiType;
}

async function updateSettingsUI() {
    const container = document.getElementById(`extension_settings_${extensionName}`);
    if (!container) {
        return;
    }

    const settings = getSettings();
    Object.keys(defaultSettings).forEach(key => {
        const element = container.querySelector(`[name="${key}"]`);
        setElementValue(element, settings[key]);
    });

    await populateProfiles(container);
    await populatePresets(container);
}

function readSettingValue(target) {
    if (target instanceof HTMLInputElement && target.type === 'checkbox') {
        return target.checked;
    }

    if (target instanceof HTMLInputElement && target.type === 'number') {
        const value = Number(target.value);
        return Number.isFinite(value) ? value : 0;
    }

    return target.value;
}

function addSettingsEventListeners(container) {
    container.addEventListener('input', event => {
        const target = event.target;
        if (!(target instanceof HTMLInputElement || target instanceof HTMLSelectElement || target instanceof HTMLTextAreaElement)) {
            return;
        }

        if (!target.classList.contains('gg-setting-input')) {
            return;
        }

        const settings = getSettings();
        settings[target.name] = readSettingValue(target);
        saveSettingsDebounced();
        updateExtensionButtons();
    });

    container.addEventListener('change', async event => {
        const target = event.target;
        if (!(target instanceof HTMLInputElement || target instanceof HTMLSelectElement || target instanceof HTMLTextAreaElement)) {
            return;
        }

        if (!target.classList.contains('gg-setting-input')) {
            return;
        }

        const settings = getSettings();
        settings[target.name] = readSettingValue(target);

        if (target.name === 'profileImpersonate1st') {
            settings.presetImpersonate1st = '';
            await populatePresets(container);
        }

        saveSettingsDebounced();
        updateExtensionButtons();
    });

    container.querySelectorAll('.gg-default-button').forEach(button => {
        button.addEventListener('click', () => {
            const key = button.getAttribute('data-target');
            if (!key || !Object.hasOwn(defaultSettings, key)) {
                return;
            }

            const input = container.querySelector(`#gg_${key}`);
            if (input instanceof HTMLTextAreaElement || input instanceof HTMLInputElement || input instanceof HTMLSelectElement) {
                input.value = defaultSettings[key];
                input.dispatchEvent(new Event('input', { bubbles: true }));
                input.dispatchEvent(new Event('change', { bubbles: true }));
            }
        });
    });

    container.querySelector('#gg_refreshProfiles')?.addEventListener('click', async () => {
        await updateSettingsUI();
    });
}

async function loadSettingsPanel() {
    const parentContainer = document.getElementById('extensions_settings');
    if (!parentContainer) {
        console.error(`${extensionName}: Could not find #extensions_settings.`);
        return;
    }

    let container = document.getElementById(`extension_settings_${extensionName}`);
    if (!container) {
        container = document.createElement('div');
        container.id = `extension_settings_${extensionName}`;
        parentContainer.append(container);
    }

    container.innerHTML = await renderExtensionTemplateAsync(extensionName, 'settings');
    await updateSettingsUI();
    addSettingsEventListeners(container);
}

function createActionButton(id, title, iconClass, actionFunc) {
    const button = document.createElement('button');
    button.id = id;
    button.type = 'button';
    button.className = `gg-action-button menu_button menu_button_icon ${iconClass}`;
    button.title = title;
    button.setAttribute('aria-label', title);
    button.addEventListener('click', event => {
        event.preventDefault();
        actionFunc();
    });
    return button;
}

function getFlushGuideButtonLabel(activeCount) {
    return activeCount > 0 ? `Flush Guide (${activeCount} active)` : 'Flush Guide';
}

function updateFlushGuideButton() {
    const button = document.getElementById('gg_flush_guides_button');
    if (!(button instanceof HTMLButtonElement)) {
        return;
    }

    const activeCount = getActiveGuides().length;
    const label = getFlushGuideButtonLabel(activeCount);
    const labelElement = button.querySelector('.gg-flush-guides-label');
    const countElement = button.querySelector('.gg-flush-guides-count');

    if (labelElement) {
        labelElement.textContent = 'Flush Guide';
    }
    if (countElement) {
        countElement.textContent = activeCount > 0 ? `(${activeCount} active)` : '';
    }

    button.title = label;
    button.setAttribute('aria-label', label);
    button.dataset.activeCount = String(activeCount);
    button.disabled = activeCount === 0;
    button.classList.toggle('gg-flush-guides-active', activeCount > 0);
}

async function flushGuides() {
    if (getActiveGuides().length === 0) {
        updateFlushGuideButton();
        return;
    }

    try {
        await flushActiveGuides();
    } catch (error) {
        console.warn('[GuidedGenerations][Flush] Could not flush active guides:', error);
    } finally {
        updateFlushGuideButton();
    }
}

function createFlushGuidesButton() {
    const button = document.createElement('button');
    button.id = 'gg_flush_guides_button';
    button.type = 'button';
    button.className = 'gg-action-button gg-flush-guides-button menu_button';

    const icon = document.createElement('span');
    icon.className = 'fa-solid fa-broom';
    icon.setAttribute('aria-hidden', 'true');

    const label = document.createElement('span');
    label.className = 'gg-flush-guides-label';

    const count = document.createElement('span');
    count.className = 'gg-flush-guides-count';

    button.append(icon, label, count);
    button.addEventListener('click', async event => {
        event.preventDefault();
        await flushGuides();
    });
    updateFlushGuideButton();
    return button;
}

function startFlushGuideButtonUpdates() {
    if (flushGuidePollTimer) {
        return;
    }

    flushGuidePollTimer = window.setInterval(updateFlushGuideButton, 500);
}

function ensureButtonContainer() {
    const sendForm = document.getElementById('send_form');
    const nonQrFormItems = document.getElementById('nonQRFormItems');
    if (!sendForm || !nonQrFormItems) {
        return null;
    }

    let container = document.getElementById('gg-action-button-container');
    if (!container) {
        container = document.createElement('div');
        container.id = 'gg-action-button-container';
        container.className = 'gg-action-buttons-container';
        nonQrFormItems.insertAdjacentElement('afterend', container);
    }

    return container;
}

function updateExtensionButtons() {
    const settings = getSettings();
    const container = ensureButtonContainer();
    if (!container) {
        return;
    }

    const existingQrBar = document.getElementById('qr--bar');
    if (existingQrBar && container.contains(existingQrBar)) {
        const sendForm = document.getElementById('send_form');
        sendForm?.insertBefore(existingQrBar, sendForm.firstElementChild);
    }

    container.innerHTML = '';

    const qrContainer = document.createElement('div');
    qrContainer.id = 'gg-qr-container';
    qrContainer.className = 'gg-qr-container';
    const actionsContainer = document.createElement('div');
    actionsContainer.className = 'gg-regular-buttons-container';

    container.append(qrContainer, actionsContainer);

    const buttons = [
        settings.showSimpleSendButton && createActionButton('gg_simple_send_button', 'Simple Send', 'fa-solid fa-paper-plane', simpleSend),
        settings.showImpersonate1stPerson && createActionButton('gg_impersonate_button', 'Guided Impersonate', 'fa-solid fa-user-pen', guidedImpersonate),
        settings.showGuidedSwipe && createActionButton('gg_swipe_button', 'Guided Swipe', 'fa-solid fa-forward', guidedSwipe),
        settings.showGuidedCorrection && createActionButton('gg_correction_button', 'Guided Correction', 'fa-solid fa-pen-to-square', guidedCorrection),
        settings.showGuidedResponse && createActionButton('gg_response_button', 'Guided Response', 'fa-solid fa-compass', guidedResponse),
        settings.showFlushGuidesButton && createFlushGuidesButton(),
    ].filter(Boolean);

    actionsContainer.append(...buttons);
    updateFlushGuideButton();
    integrateQrBar();
}

function integrateQrBar() {
    const qrBar = document.getElementById('qr--bar');
    const qrContainer = document.getElementById('gg-qr-container');
    const sendForm = document.getElementById('send_form');
    if (!qrBar || !qrContainer) {
        return false;
    }

    if (getSettings().integrateQrBar) {
        if (qrBar.parentElement !== qrContainer) {
            qrContainer.append(qrBar);
        }
        return true;
    }

    if (qrBar.parentElement === qrContainer && sendForm) {
        sendForm.insertBefore(qrBar, sendForm.firstElementChild);
    }
    return true;
}

function startQrIntegration() {
    qrPollTimer = window.setInterval(() => {
        if (integrateQrBar()) {
            window.clearInterval(qrPollTimer);
            qrPollTimer = null;
        }
    }, 1000);

    window.setTimeout(() => {
        if (qrPollTimer) {
            window.clearInterval(qrPollTimer);
            qrPollTimer = null;
        }
    }, 30000);

    qrObserver?.disconnect();
    qrObserver = new MutationObserver(() => {
        integrateQrBar();
    });
    qrObserver.observe(document.body, { childList: true, subtree: true });
}

export async function init() {
    loadSettings();
    maybeWarnOldExtensionDeprecated();
    await loadSettingsPanel();
    updateExtensionButtons();
    startFlushGuideButtonUpdates();
    startQrIntegration();

    // SillyBunny: re-populate profile/preset dropdowns when Connection Manager
    // profiles change, so the UI stays in sync without requiring a manual
    // refresh click. Fixes the race condition where dropdowns populate before
    // Connection Manager data is ready. (#529)
    const refreshDropdowns = async () => {
        const container = document.getElementById(`extension_settings_${extensionName}`);
        if (container) {
            await updateSettingsUI();
        }
    };

    if (event_types?.CONNECTION_PROFILE_CREATED) {
        eventSource.on(event_types.CONNECTION_PROFILE_CREATED, refreshDropdowns);
    }
    if (event_types?.CONNECTION_PROFILE_UPDATED) {
        eventSource.on(event_types.CONNECTION_PROFILE_UPDATED, refreshDropdowns);
    }
    if (event_types?.CONNECTION_PROFILE_DELETED) {
        eventSource.on(event_types.CONNECTION_PROFILE_DELETED, refreshDropdowns);
    }
}

export {
    defaultSettings,
    loadSettings,
    updateExtensionButtons,
    updateSettingsUI,
};
