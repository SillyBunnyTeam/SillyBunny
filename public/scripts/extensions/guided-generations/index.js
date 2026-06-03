import { saveSettingsDebounced } from '../../../script.js';
import { extensionNames, extension_settings, renderExtensionTemplateAsync } from '../../extensions.js';
import { extensionName, getPresetsForApiType, getProfileApiType, getProfileList } from './scripts/shared.js';
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
    integrateQrBar: true,
    injectionEndRole: 'system',
    debugMode: false,
    promptGuidedResponse: '[Take the following into special consideration for your next message: {{input}}]',
    promptGuidedSwipe: '[Take the following into special consideration for your next message: {{input}}]',
    promptGuidedCorrection: '[Apply the following correction to your previous message: {{input}}]',
    promptImpersonate1st: 'Write in first Person perspective from {{user}}. {{input}}',
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
        option.value = profile;
        option.textContent = profile;
        profileSelect.append(option);
    }
    profileSelect.value = settings.profileImpersonate1st ?? '';
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
        settings.showImpersonate1stPerson && createActionButton('gg_impersonate_button', 'Guided Impersonate', 'fa-solid fa-user', guidedImpersonate),
        settings.showGuidedSwipe && createActionButton('gg_swipe_button', 'Guided Swipe', 'fa-solid fa-forward', guidedSwipe),
        settings.showGuidedCorrection && createActionButton('gg_correction_button', 'Guided Correction', 'fa-solid fa-pen-to-square', guidedCorrection),
        settings.showGuidedResponse && createActionButton('gg_response_button', 'Guided Response', 'fa-solid fa-compass', guidedResponse),
    ].filter(Boolean);

    actionsContainer.append(...buttons);
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
    startQrIntegration();
}

export {
    defaultSettings,
    loadSettings,
    updateExtensionButtons,
    updateSettingsUI,
};
