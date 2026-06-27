import { DOMPurify, Fuse } from '../../../lib.js';

import { activateSendButtons, deactivateSendButtons, event_types, eventSource, main_api, online_status, saveSettings, saveSettingsDebounced } from '../../../script.js';
import { extension_settings, getContext, renderExtensionTemplateAsync } from '../../extensions.js';
import { callGenericPopup, Popup, POPUP_RESULT, POPUP_TYPE } from '../../popup.js';
import { SlashCommand } from '../../slash-commands/SlashCommand.js';
import { SlashCommandAbortController } from '../../slash-commands/SlashCommandAbortController.js';
import { ARGUMENT_TYPE, SlashCommandArgument, SlashCommandNamedArgument } from '../../slash-commands/SlashCommandArgument.js';
import { commonEnumProviders, enumIcons } from '../../slash-commands/SlashCommandCommonEnumsProvider.js';
import { SlashCommandDebugController } from '../../slash-commands/SlashCommandDebugController.js';
import { enumTypes, SlashCommandEnumValue } from '../../slash-commands/SlashCommandEnumValue.js';
import { SlashCommandClosure } from '../../slash-commands/SlashCommandClosure.js';
import { SlashCommandParser } from '../../slash-commands/SlashCommandParser.js';
import { SlashCommandScope } from '../../slash-commands/SlashCommandScope.js';
import { cancelDebounce, collapseSpaces, getUniqueName, isFalseBoolean, isTrueBoolean, uuidv4, waitUntilCondition } from '../../utils.js';
import { t } from '../../i18n.js';
import { getSecretLabelById } from '../../secrets.js';
import { chat_completion_sources, oai_settings, selected_custom_endpoint_preset, syncCustomEndpointPresetSelectionBySecretId } from '../../openai.js';
import { performFuzzySearch } from '/scripts/power-user.js';
import { StreamingDisplay } from '/scripts/streaming-display.js';
import { ConnectionManagerRequestService } from '../shared.js';
import { formatReasoning } from '/scripts/reasoning.js';

const MODULE_NAME = 'connection-manager';
const NONE = '<None>';
const EMPTY = '<Empty>';
const PROFILE_APPLICATION_ABORTED = 'Profile application aborted';
let profileApplySequence = 0;

const DEFAULT_SETTINGS = {
    profiles: [],
    folders: [],
    selectedProfile: null,
};

// Commands that can record an empty value into the profile
const ALLOW_EMPTY = [
    'stop-strings',
    'start-reply-with',
    'request-image-resolution',
    'request-image-aspect-ratio',
    'custom-reasoning-param-name',
    'custom-reasoning-enabled-value',
    'custom-reasoning-disabled-value',
];

const CLEAR_ON_EMPTY_RESULT = [
    'api-url',
    'secret-id',
];

const CC_COMMANDS = [
    'api',
    'preset',
    // Do not fix; CC needs to set the API twice because it could be overridden by the preset
    'api',
    'secret-id',
    'api-url',
    'model',
    'proxy',
    'stop-strings',
    'start-reply-with',
    'reasoning-template',
    // SillyBunny: persist Chat Completion reasoning and request behavior in connection profiles.
    'request-reasoning',
    'reasoning-effort',
    'verbosity',
    'enable-web-search',
    'request-images',
    'request-image-resolution',
    'request-image-aspect-ratio',
    'custom-reasoning-preset',
    'custom-reasoning-param-format',
    'custom-reasoning-param-name',
    'custom-reasoning-enabled-value',
    'custom-reasoning-disabled-value',
    'prompt-post-processing',
    'regex-preset',
];

const TC_COMMANDS = [
    'api',
    'preset',
    'api-url',
    'model',
    'sysprompt',
    'sysprompt-state',
    'instruct',
    'context',
    'instruct-state',
    'tokenizer',
    'stop-strings',
    'start-reply-with',
    'reasoning-template',
    'secret-id',
    'regex-preset',
];

const FANCY_NAMES = {
    'api': 'API',
    'api-url': 'Server URL',
    'preset': 'Settings Preset',
    'model': 'Model',
    'proxy': 'Proxy Preset',
    'sysprompt-state': 'Use System Prompt',
    'sysprompt': 'System Prompt Name',
    'instruct-state': 'Instruct Mode',
    'instruct': 'Instruct Template',
    'context': 'Context Template',
    'tokenizer': 'Tokenizer',
    'stop-strings': 'Custom Stopping Strings',
    'start-reply-with': 'Start Reply With',
    'reasoning-template': 'Reasoning Template',
    'request-reasoning': 'Request Model Reasoning',
    'reasoning-effort': 'Reasoning Effort',
    'verbosity': 'Verbosity',
    'enable-web-search': 'Enable Web Search',
    'request-images': 'Request Inline Images',
    'request-image-resolution': 'Request Image Resolution',
    'request-image-aspect-ratio': 'Request Image Aspect Ratio',
    'custom-reasoning-preset': 'Custom Reasoning Preset',
    'custom-reasoning-param-format': 'Custom Reasoning Parameter Format',
    'custom-reasoning-param-name': 'Custom Reasoning Parameter Name',
    'custom-reasoning-enabled-value': 'Custom Reasoning Enabled Value',
    'custom-reasoning-disabled-value': 'Custom Reasoning Disabled Value',
    'prompt-post-processing': 'Prompt Post-Processing',
    'secret-id': 'Secret',
    'regex-preset': 'Regex Preset',
    'active-agents': 'Active Agents',
    'samplers': 'Samplers',
    'instruct-template': 'Instruct Template',
    'context-template': 'Context Template',
    'system-prompt': 'System Prompt',
    'world-info-active-count': 'World Info Active Entries',
};

/**
 * A wrapper for the connection manager spinner.
 */
class ConnectionManagerSpinner {
    /**
     * @type {AbortController[]}
     */
    static abortControllers = [];

    /** @type {HTMLElement} */
    spinnerElement;

    /** @type {AbortController} */
    abortController = new AbortController();

    constructor() {
        // @ts-ignore
        this.spinnerElement = document.getElementById('connection_profile_spinner');
        this.abortController = new AbortController();
    }

    start() {
        ConnectionManagerSpinner.abortControllers.push(this.abortController);
        this.spinnerElement.classList.remove('hidden');
    }

    stop() {
        const index = ConnectionManagerSpinner.abortControllers.indexOf(this.abortController);
        if (index === -1) {
            return;
        }

        ConnectionManagerSpinner.abortControllers.splice(index, 1);
        if (ConnectionManagerSpinner.abortControllers.length === 0) {
            this.spinnerElement.classList.add('hidden');
        }
    }

    isAborted() {
        return this.abortController.signal.aborted;
    }

    static abort() {
        for (const controller of ConnectionManagerSpinner.abortControllers) {
            controller.abort();
        }
        ConnectionManagerSpinner.abortControllers = [];
        document.getElementById('connection_profile_spinner')?.classList.add('hidden');
    }
}

/**
 * Checks if an error came from a superseded profile application.
 * @param {unknown} error Error-like value
 * @returns {boolean}
 */
function isProfileApplicationAbort(error) {
    return error instanceof Error && error.message === PROFILE_APPLICATION_ABORTED;
}

/**
 * Get named arguments for the command callback.
 * @param {object} [args] Additional named arguments
 * @param {string} [args.force] Whether to force setting the value
 * @returns {object} Named arguments
 */
function getNamedArguments(args = {}) {
    // None of the commands here use underscored args, but better safe than sorry
    return {
        _scope: new SlashCommandScope(),
        _abortController: new SlashCommandAbortController(),
        _debugController: new SlashCommandDebugController(),
        _parserFlags: {},
        _hasUnnamedArgument: false,
        quiet: 'true',
        ...args,
    };
}

/** @type {() => SlashCommandEnumValue[]} */
const profilesProvider = () => [
    new SlashCommandEnumValue(NONE),
    ...extension_settings.connectionManager.profiles.map(p => new SlashCommandEnumValue(p.name, null, enumTypes.name, enumIcons.server)),
];

/**
 * @typedef {Object} ConnectionProfile
 * @property {string} id Unique identifier
 * @property {string} mode Mode of the connection profile
 * @property {string} [name] Name of the connection profile
 * @property {string} [api] API
 * @property {string} [preset] Settings Preset
 * @property {string} [model] Model
 * @property {string} [proxy] Proxy Preset
 * @property {string} [instruct] Instruct Template
 * @property {string} [context] Context Template
 * @property {string} [instruct-state] Instruct Mode
 * @property {string} [tokenizer] Tokenizer
 * @property {string} [stop-strings] Custom Stopping Strings
 * @property {string} [start-reply-with] Start Reply With
 * @property {string} [reasoning-template] Reasoning Template
 * @property {string} [request-reasoning] Request model reasoning
 * @property {string} [reasoning-effort] Reasoning effort
 * @property {string} [verbosity] Verbosity
 * @property {string} [enable-web-search] Enable web search
 * @property {string} [request-images] Request inline images
 * @property {string} [request-image-resolution] Request image resolution
 * @property {string} [request-image-aspect-ratio] Request image aspect ratio
 * @property {string} [custom-reasoning-preset] Custom reasoning preset
 * @property {string} [custom-reasoning-param-format] Custom reasoning parameter format
 * @property {string} [custom-reasoning-param-name] Custom reasoning parameter name
 * @property {string} [custom-reasoning-enabled-value] Custom reasoning enabled value
 * @property {string} [custom-reasoning-disabled-value] Custom reasoning disabled value
 * @property {string} [prompt-post-processing] Prompt Post-Processing
 * @property {string} [sysprompt] System Prompt Name
 * @property {string} [sysprompt-state] Use System Prompt
 * @property {string} [api-url] Server URL
 * @property {string} [secret-id] Secret ID
 * @property {string} [regex-preset] Regex Preset ID
 * @property {string} [active-agents] Active in-chat agents summary
 * @property {string} [samplers] Sampler summary
 * @property {string} [instruct-template] Instruct template name
 * @property {string} [context-template] Context template name
 * @property {string} [system-prompt] System prompt name
 * @property {number|string} [world-info-active-count] Active World Info entries count
 * @property {string[]} [exclude] Commands to exclude
 * @property {string|null} [folderId] Folder identifier, or null for the root level
 * @property {boolean|string} [fav] Whether this profile is a favorite
 */

/**
 * @typedef {Object} ConnectionProfileFolder
 * @property {string} id Unique identifier
 * @property {string} name Folder display name
 * @property {number} sortOrder Folder sort order
 */

/**
 * Normalizes a folder name for storage.
 * @param {unknown} name Folder name
 * @returns {string} Normalized folder name
 */
function normalizeFolderName(name) {
    return collapseSpaces(DOMPurify.sanitize(String(name ?? ''))).trim();
}

/**
 * Normalizes a folder id from UI/settings values.
 * @param {unknown} folderId Folder id
 * @returns {string|null} Normalized folder id
 */
function normalizeFolderId(folderId) {
    return typeof folderId === 'string' && folderId.length > 0 ? folderId : null;
}

/**
 * Gets the connection profile folders array.
 * @returns {ConnectionProfileFolder[]} Folders
 */
function getConnectionProfileFolders() {
    if (!Array.isArray(extension_settings.connectionManager.folders)) {
        extension_settings.connectionManager.folders = [];
    }

    return extension_settings.connectionManager.folders;
}

/**
 * Gets folders sorted by name.
 * @returns {ConnectionProfileFolder[]} Sorted folders
 */
function getSortedFolders() {
    return getConnectionProfileFolders().slice().sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Gets profiles sorted by name without mutating settings.
 * @returns {ConnectionProfile[]} Sorted profiles
 */
function getSortedProfiles() {
    return extension_settings.connectionManager.profiles.slice().sort((a, b) => String(a.name ?? '').localeCompare(String(b.name ?? '')));
}

/**
 * Counts profiles in a folder.
 * @param {string} folderId Folder id
 * @returns {number} Number of profiles in the folder
 */
function getFolderProfileCount(folderId) {
    return extension_settings.connectionManager.profiles.filter(profile => profile.folderId === folderId).length;
}

/**
 * Gets folder manager template data.
 * @returns {{folders: Array<ConnectionProfileFolder & {profileCount: number}>, hasFolders: boolean}}
 */
function getFolderManagerTemplateData() {
    const folders = getSortedFolders().map(folder => ({
        ...folder,
        profileCount: getFolderProfileCount(folder.id),
    }));

    return {
        folders,
        hasFolders: folders.length > 0,
    };
}

/**
 * Creates a new connection profile folder.
 * @param {unknown} name Folder name
 * @returns {ConnectionProfileFolder|null} Created folder, or null if invalid
 */
function createFolder(name) {
    const folderName = normalizeFolderName(name);
    if (!folderName) {
        toastr.error(t`Folder name cannot be empty.`);
        return null;
    }

    const folders = getConnectionProfileFolders();
    const sortOrder = folders.reduce((max, folder) => Math.max(max, Number(folder.sortOrder) || 0), 0) + 1;
    const folder = {
        id: uuidv4(),
        name: folderName,
        sortOrder,
    };

    folders.push(folder);
    return folder;
}

/**
 * Renames a connection profile folder.
 * @param {string} folderId Folder id
 * @param {unknown} newName New folder name
 * @returns {ConnectionProfileFolder|null} Renamed folder, or null if invalid
 */
function renameFolder(folderId, newName) {
    const folder = getConnectionProfileFolders().find(x => x.id === folderId);
    if (!folder) {
        toastr.error(t`Folder not found.`);
        return null;
    }

    const folderName = normalizeFolderName(newName);
    if (!folderName) {
        toastr.error(t`Folder name cannot be empty.`);
        return null;
    }

    folder.name = folderName;
    return folder;
}

/**
 * Deletes a connection profile folder and moves contained profiles to root.
 * @param {string} folderId Folder id
 * @returns {{folder: ConnectionProfileFolder, affectedProfiles: Array<{oldProfile: ConnectionProfile, profile: ConnectionProfile}>}|null} Deleted folder and moved profiles
 */
function deleteFolder(folderId) {
    const folders = getConnectionProfileFolders();
    const index = folders.findIndex(x => x.id === folderId);
    if (index === -1) {
        toastr.error(t`Folder not found.`);
        return null;
    }

    const [folder] = folders.splice(index, 1);
    const affectedProfiles = extension_settings.connectionManager.profiles
        .filter(profile => profile.folderId === folderId)
        .map(profile => ({ oldProfile: structuredClone(profile), profile }));

    for (const { profile } of affectedProfiles) {
        profile.folderId = null;
    }

    return { folder, affectedProfiles };
}

/**
 * Moves a connection profile to a folder.
 * @param {string} profileId Profile id
 * @param {string|null} folderId Folder id, or null for root
 * @returns {boolean} Whether the profile was moved
 */
function moveProfileToFolder(profileId, folderId) {
    const profile = extension_settings.connectionManager.profiles.find(x => x.id === profileId);
    if (!profile) {
        toastr.error(t`Profile not found.`);
        return false;
    }

    const normalizedFolderId = normalizeFolderId(folderId);
    if (normalizedFolderId && !getConnectionProfileFolders().some(folder => folder.id === normalizedFolderId)) {
        toastr.error(t`Folder not found.`);
        return false;
    }

    if (profile.folderId === normalizedFolderId) {
        return false;
    }

    profile.folderId = normalizedFolderId;
    return true;
}

/**
 * Toggles a connection profile favorite state.
 * @param {string} profileId Profile id
 * @returns {ConnectionProfile|null} Updated profile, or null if missing
 */
function toggleProfileFavorite(profileId) {
    const profile = extension_settings.connectionManager.profiles.find(x => x.id === profileId);
    if (!profile) {
        toastr.error(t`Profile not found.`);
        return null;
    }

    profile.fav = !profile.fav;
    return profile;
}

/**
 * Updates the favorite button state.
 * @param {boolean} isFavorite Whether the selected profile is a favorite
 */
function updateFavoriteButtonState(isFavorite) {
    const button = document.getElementById('toggle_profile_favorite');
    if (!button) {
        return;
    }

    const hasProfile = Boolean(extension_settings.connectionManager.selectedProfile);
    const title = !hasProfile
        ? t`Select a profile to toggle favorite`
        : isFavorite
            ? t`Remove from favorites`
            : t`Add to favorites`;

    button.classList.toggle('is_fav', isFavorite);
    button.setAttribute('aria-pressed', String(isFavorite));
    button.setAttribute('aria-label', title);
    button.title = title;
}

/**
 * Migrates and validates connection manager settings.
 * @returns {boolean} Whether settings were changed
 */
function migrateConnectionManagerSettings() {
    const settings = extension_settings.connectionManager;
    let changed = false;

    if (!Array.isArray(settings.profiles)) {
        settings.profiles = [];
        changed = true;
    }

    if (!Array.isArray(settings.folders)) {
        settings.folders = [];
        changed = true;
    }

    const seenFolderIds = new Set();
    /** @type {ConnectionProfileFolder[]} */
    const normalizedFolders = [];

    for (const [index, folder] of settings.folders.entries()) {
        if (!folder || typeof folder !== 'object') {
            changed = true;
            continue;
        }

        const id = typeof folder.id === 'string' && folder.id ? folder.id : uuidv4();
        if (seenFolderIds.has(id)) {
            changed = true;
            continue;
        }

        const name = normalizeFolderName(folder.name);
        if (!name) {
            changed = true;
            continue;
        }

        const sortOrder = Number.isFinite(Number(folder.sortOrder)) ? Number(folder.sortOrder) : index;
        normalizedFolders.push({ id, name, sortOrder });
        seenFolderIds.add(id);

        if (id !== folder.id || name !== folder.name || sortOrder !== folder.sortOrder) {
            changed = true;
        }
    }

    if (normalizedFolders.length !== settings.folders.length) {
        changed = true;
    }
    settings.folders = normalizedFolders;

    const folderIds = new Set(normalizedFolders.map(folder => folder.id));
    for (const profile of settings.profiles) {
        if (!profile || typeof profile !== 'object') {
            continue;
        }

        const normalizedFolderId = normalizeFolderId(profile.folderId);
        if (normalizedFolderId && !folderIds.has(normalizedFolderId)) {
            console.warn(`Connection profile "${profile.name ?? profile.id}" referenced a missing folder. Moving it to root.`);
            profile.folderId = null;
            changed = true;
        } else if (profile.folderId !== normalizedFolderId) {
            profile.folderId = normalizedFolderId;
            changed = true;
        }

        const isFavorite = profile.fav === true || profile.fav === 'true';
        if (profile.fav !== isFavorite) {
            profile.fav = isFavorite;
            changed = true;
        }
    }

    if (settings.selectedProfile && !settings.profiles.some(profile => profile?.id === settings.selectedProfile)) {
        settings.selectedProfile = null;
        changed = true;
    }

    return changed;
}

/**
 * Finds the best match for the search value.
 * @param {string} value Search value
 * @returns {ConnectionProfile|null} Best match or null
 */
function findProfileByName(value) {
    // Try to find exact match
    const profile = extension_settings.connectionManager.profiles.find(p => p.name === value);

    if (profile) {
        return profile;
    }

    // Try to find fuzzy match
    const fuse = new Fuse(extension_settings.connectionManager.profiles, { keys: ['name'] });
    const results = fuse.search(value);

    if (results.length === 0) {
        return null;
    }

    const bestMatch = results[0];
    return bestMatch.item;
}

function getCustomEndpointProfileSecretId(mode) {
    if (
        mode !== 'cc' ||
        main_api !== 'openai' ||
        oai_settings.chat_completion_source !== chat_completion_sources.CUSTOM ||
        selected_custom_endpoint_preset?.name === 'None'
    ) {
        return '';
    }

    // SillyBunny: Custom endpoint profiles bind to their saved preset secret, not the active fallback key.
    return String(selected_custom_endpoint_preset?.secretId ?? '').trim();
}

function syncAppliedCustomEndpointProfileSecret(mode, secretId) {
    if (
        mode !== 'cc' ||
        main_api !== 'openai' ||
        oai_settings.chat_completion_source !== chat_completion_sources.CUSTOM
    ) {
        return;
    }

    // SillyBunny: Custom status/model fetches read the selected preset secret after profile apply.
    syncCustomEndpointPresetSelectionBySecretId(secretId);
}

/**
 * Reads the connection profile from the commands.
 * @param {string} mode Mode of the connection profile
 * @param {ConnectionProfile} profile Connection profile
 * @param {boolean} [cleanUp] Whether to clean up the profile
 */
async function readProfileFromCommands(mode, profile, cleanUp = false) {
    const commands = mode === 'cc' ? CC_COMMANDS : TC_COMMANDS;
    const opposingCommands = mode === 'cc' ? TC_COMMANDS : CC_COMMANDS;
    const excludeList = Array.isArray(profile.exclude) ? profile.exclude : [];
    for (const command of commands) {
        try {
            if (excludeList.includes(command)) {
                continue;
            }

            const allowEmpty = ALLOW_EMPTY.includes(command);
            const args = getNamedArguments();
            if (command === 'secret-id') {
                const customEndpointSecretId = getCustomEndpointProfileSecretId(mode);
                if (customEndpointSecretId) {
                    profile[command] = customEndpointSecretId;
                    continue;
                }
            }

            const result = await SlashCommandParser.commands[command].callback(args, '');
            if (result || (allowEmpty && result === '')) {
                profile[command] = result;
                continue;
            }

            if (cleanUp && CLEAR_ON_EMPTY_RESULT.includes(command)) {
                delete profile[command];
            }
        } catch (error) {
            console.error(`Failed to execute command: ${command}`, error);
        }
    }

    if (cleanUp) {
        for (const command of commands) {
            if (command.endsWith('-state') && profile[command] === 'false') {
                delete profile[command.replace('-state', '')];
            }
        }
        for (const command of opposingCommands) {
            if (commands.includes(command)) {
                continue;
            }

            delete profile[command];
        }
    }

    enrichProfileSnapshot(profile);
}

function truncateSummary(value, maxLength = 260) {
    const text = String(value ?? '').trim();
    const chars = Array.from(text);
    return chars.length > maxLength ? `${chars.slice(0, maxLength - 3).join('')}...` : text;
}

function readInputDisplayValue(selector) {
    const element = document.querySelector(selector);

    if (element instanceof HTMLSelectElement) {
        const selectedText = Array.from(element.selectedOptions)
            .map(option => String(option.textContent ?? '').trim())
            .filter(Boolean)
            .join(', ');
        return selectedText || String(element.value ?? '').trim();
    }

    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
        return String(element.value ?? '').trim();
    }

    return '';
}

function getActiveAgentsSummary() {
    const agents = typeof globalThis.SillyBunnyAgents?.getEnabledAgents === 'function'
        ? globalThis.SillyBunnyAgents.getEnabledAgents()
        : [];

    if (!Array.isArray(agents) || agents.length === 0) {
        return NONE;
    }

    return truncateSummary(agents
        .map(agent => `${agent.name || agent.id} (order ${agent.injection?.order ?? 0})`)
        .join(', '));
}

function getSamplerSummary() {
    const context = getContext();
    const isChatCompletion = main_api === 'openai';
    const settings = isChatCompletion ? context.chatCompletionSettings : context.textCompletionSettings;

    if (!settings) {
        return NONE;
    }

    const temperature = isChatCompletion ? settings.temp_openai : settings.temp;
    const topP = isChatCompletion ? settings.top_p_openai : settings.top_p;
    const topK = isChatCompletion ? settings.top_k_openai : settings.top_k;

    return [
        `Temperature: ${temperature ?? NONE}`,
        `Top P: ${topP ?? NONE}`,
        `Top K: ${topK ?? NONE}`,
    ].join(', ');
}

function getWorldInfoActiveCount() {
    const values = $('#world_info').val();
    return Array.isArray(values) ? values.length : values ? 1 : 0;
}

function enrichProfileSnapshot(profile) {
    // SillyBunny: include fork-only connection summary fields so exported profile
    // snapshots still reflect the active shell state when reopened later.
    profile['active-agents'] = getActiveAgentsSummary();
    profile.samplers = getSamplerSummary();
    profile['instruct-template'] = readInputDisplayValue('#instruct_presets') || profile.instruct || NONE;
    profile['context-template'] = readInputDisplayValue('#context_presets') || profile.context || NONE;
    profile['system-prompt'] = readInputDisplayValue('#sysprompt_select') || profile.sysprompt || NONE;
    profile['world-info-active-count'] = String(getWorldInfoActiveCount());
}

/**
 * Creates a new connection profile.
 * @param {string} [forceName] Name of the connection profile
 * @returns {Promise<ConnectionProfile>} Created connection profile
 */
async function createConnectionProfile(forceName = null) {
    const mode = main_api === 'openai' ? 'cc' : 'tc';
    const id = uuidv4();
    /** @type {ConnectionProfile} */
    const profile = {
        id,
        mode,
        exclude: [],
        folderId: null,
        fav: false,
    };

    await readProfileFromCommands(mode, profile);

    const profileForDisplay = makeFancyProfile(profile);
    const template = $(await renderExtensionTemplateAsync(MODULE_NAME, 'profile', { profile: profileForDisplay }));
    template.find('input[name="exclude"]').on('input', function () {
        const fancyName = String($(this).val());
        const keyName = Object.entries(FANCY_NAMES).find(x => x[1] === fancyName)?.[0];
        if (!keyName) {
            console.warn('Key not found for fancy name:', fancyName);
            return;
        }

        if (!Array.isArray(profile.exclude)) {
            profile.exclude = [];
        }

        const excludeState = !$(this).prop('checked');
        if (excludeState) {
            profile.exclude.push(keyName);
        } else {
            const index = profile.exclude.indexOf(keyName);
            index !== -1 && profile.exclude.splice(index, 1);
        }
    });
    const isNameTaken = (n) => extension_settings.connectionManager.profiles.some(p => p.name === n);
    const suggestedName = getUniqueName(collapseSpaces(`${profile.api ?? ''} ${profile.model ?? ''} - ${profile.preset ?? ''}`), isNameTaken);
    let name = forceName ?? await callGenericPopup(template, POPUP_TYPE.INPUT, suggestedName);
    // If it's cancelled, it will be false
    if (!name) {
        return null;
    }
    name = DOMPurify.sanitize(String(name));
    if (!name) {
        toastr.error('Name cannot be empty.');
        return null;
    }

    if (isNameTaken(name) || name === NONE) {
        toastr.error('A profile with the same name already exists.');
        return null;
    }

    if (Array.isArray(profile.exclude)) {
        for (const command of profile.exclude) {
            delete profile[command];
        }
    }

    profile.name = String(name);
    return profile;
}

/**
 * Deletes the selected connection profile.
 * @returns {Promise<void>}
 */
async function deleteConnectionProfile() {
    const selectedProfile = extension_settings.connectionManager.selectedProfile;
    if (!selectedProfile) {
        return;
    }

    const index = extension_settings.connectionManager.profiles.findIndex(p => p.id === selectedProfile);
    if (index === -1) {
        return;
    }

    const profile = extension_settings.connectionManager.profiles[index];
    const name = profile.name;
    const confirm = await Popup.show.confirm(t`Are you sure you want to delete the selected profile?`, name);

    if (!confirm) {
        return;
    }

    extension_settings.connectionManager.profiles.splice(index, 1);
    extension_settings.connectionManager.selectedProfile = null;
    await saveSettings();

    await eventSource.emit(event_types.CONNECTION_PROFILE_DELETED, profile);
}

/**
 * Selects multiple connection profiles for deletion.
 * @returns {Promise<ConnectionProfile[]>}
 */
async function selectConnectionProfilesForDeletion() {
    const profiles = extension_settings.connectionManager.profiles;
    if (!Array.isArray(profiles) || profiles.length === 0) {
        toastr.info(t`No connection profiles to delete.`);
        return [];
    }

    const escapeAttr = value => String(value)
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;');

    const html = $(
        `<div class="flex-container flexFlowColumn flexGap10">
            <div>${t`Select the connection profiles you want to delete.`}</div>
            <div class="flex-container flexFlowColumn flexGap5">
                ${profiles.map(profile => `
                    <label class="checkbox_label justifyStart">
                        <input type="checkbox" value="${escapeAttr(profile.id)}" />
                        <span>${escapeAttr(profile.name || profile.id)}</span>
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

    const selectedIds = new Set(html.find('input:checked').map((_, el) => String($(el).val())).get());
    return profiles.filter(profile => selectedIds.has(profile.id));
}

/**
 * Deletes selected saved connection profiles.
 * @returns {Promise<void>}
 */
async function deleteAllConnectionProfiles() {
    const profilesToDelete = await selectConnectionProfilesForDeletion();
    if (profilesToDelete.length === 0) {
        return;
    }

    const confirm = await Popup.show.confirm(
        t`Delete selected connection profiles?`,
        t`This will permanently delete ${profilesToDelete.length} saved connection profile(s).`,
    );

    if (!confirm) {
        return;
    }

    const selectedIds = new Set(profilesToDelete.map(profile => profile.id));
    extension_settings.connectionManager.profiles = extension_settings.connectionManager.profiles.filter(profile => !selectedIds.has(profile.id));
    if (selectedIds.has(extension_settings.connectionManager.selectedProfile)) {
        extension_settings.connectionManager.selectedProfile = null;
    }
    await saveSettings();

    for (const profile of profilesToDelete) {
        await eventSource.emit(event_types.CONNECTION_PROFILE_DELETED, profile);
    }

    toastr.success(t`Deleted ${profilesToDelete.length} connection profile(s).`);
}

/**
 * Formats the connection profile for display.
 * @param {ConnectionProfile} profile Connection profile
 * @returns {Object} Fancy profile
 */
function makeFancyProfile(profile) {
    return Object.entries(FANCY_NAMES).reduce((acc, [key, value]) => {
        const allowEmpty = ALLOW_EMPTY.includes(key);
        if (!profile[key]) {
            if (profile[key] === '' && allowEmpty) {
                acc[value] = EMPTY;
            }
            return acc;
        }

        // UUID is not very useful in the UI, so we replace it with a label (if available)
        if (key === 'secret-id') {
            const label = getSecretLabelById(profile[key]);
            if (label) {
                acc[value] = label;
                return acc;
            }
        }

        if (key === 'regex-preset') {
            const label = extension_settings.regex_presets?.find(p => p.id === profile[key])?.name;
            if (label) {
                acc[value] = label;
                return acc;
            }
        }

        acc[value] = profile[key];
        return acc;
    }, {});
}

/**
 * Applies the connection profile.
 * @param {ConnectionProfile} profile Connection profile
 * @returns {Promise<void>}
 */
async function applyConnectionProfile(profile) {
    if (!profile) {
        return;
    }

    // Abort any ongoing profile application
    ConnectionManagerSpinner.abort();

    const mode = profile.mode;
    const commands = mode === 'cc' ? CC_COMMANDS : TC_COMMANDS;
    const spinner = new ConnectionManagerSpinner();
    spinner.start();

    try {
        for (const command of commands) {
            if (spinner.isAborted()) {
                throw new Error(PROFILE_APPLICATION_ABORTED);
            }

            const argument = profile[command];
            const allowEmpty = ALLOW_EMPTY.includes(command);
            if (!argument && !(allowEmpty && argument === '')) {
                continue;
            }
            try {
                const args = getNamedArguments(allowEmpty ? { force: 'true' } : {});
                const commandPromise = SlashCommandParser.commands[command].callback(args, argument);
                // SillyBunny: profile application triggers UI handlers that queue partial settings saves.
                // Keep persistence centralized in the explicit save after the full profile is applied.
                cancelDebounce(saveSettingsDebounced);
                try {
                    const result = await commandPromise;
                    if (command === 'secret-id') {
                        syncAppliedCustomEndpointProfileSecret(mode, result || argument);
                    }
                } finally {
                    cancelDebounce(saveSettingsDebounced);
                }
            } catch (error) {
                if (spinner.isAborted()) {
                    throw new Error(PROFILE_APPLICATION_ABORTED);
                }

                console.error(`Failed to execute command: ${command} ${argument}`, error);
            }

            if (spinner.isAborted()) {
                throw new Error(PROFILE_APPLICATION_ABORTED);
            }
        }
    } finally {
        spinner.stop();
    }
}

/**
 * Updates the selected connection profile.
 * @param {ConnectionProfile} profile Connection profile
 * @returns {Promise<void>}
 */
async function updateConnectionProfile(profile) {
    profile.mode = main_api === 'openai' ? 'cc' : 'tc';
    await readProfileFromCommands(profile.mode, profile, true);
}

/**
 * Renders the connection profile details.
 * @param {HTMLSelectElement} profiles Select element containing connection profiles
 */
function renderConnectionProfiles(profiles) {
    profiles.innerHTML = '';
    const selectedProfileId = extension_settings.connectionManager.selectedProfile;
    const noneOption = document.createElement('option');

    noneOption.value = '';
    noneOption.textContent = NONE;
    noneOption.selected = !selectedProfileId;
    profiles.appendChild(noneOption);

    /**
     * Creates an option element for a profile.
     * @param {ConnectionProfile} profile Connection profile
     * @param {boolean} [allowSelected] Whether this option can become the visible selected option
     * @returns {HTMLOptionElement} Profile option
     */
    function createProfileOption(profile, allowSelected = true) {
        const option = document.createElement('option');
        option.value = profile.id;
        option.textContent = `${profile.fav ? '★ ' : ''}${profile.name}`;
        option.selected = allowSelected && profile.id === selectedProfileId;
        option.dataset.folderId = profile.folderId ?? '';
        option.dataset.favorite = String(Boolean(profile.fav));
        return option;
    }

    const sortedProfiles = getSortedProfiles();
    const favoriteProfiles = sortedProfiles.filter(profile => profile.fav);

    if (favoriteProfiles.length > 0) {
        const favoritesGroup = document.createElement('optgroup');
        favoritesGroup.label = '★ Favorites';
        for (const profile of favoriteProfiles) {
            favoritesGroup.appendChild(createProfileOption(profile, false));
        }
        profiles.appendChild(favoritesGroup);
    }

    const rootProfiles = sortedProfiles.filter(profile => !profile.folderId);
    for (const profile of rootProfiles) {
        profiles.appendChild(createProfileOption(profile));
    }

    for (const folder of getSortedFolders()) {
        const folderProfiles = sortedProfiles.filter(profile => profile.folderId === folder.id);
        if (folderProfiles.length === 0) {
            continue;
        }

        const optgroup = document.createElement('optgroup');
        optgroup.label = `📁 ${folder.name}`;
        for (const profile of folderProfiles) {
            optgroup.appendChild(createProfileOption(profile));
        }

        profiles.appendChild(optgroup);
    }
}

/**
 * Renders the content of the details element.
 * @param {HTMLElement} detailsContent Content element of the details
 */
async function renderDetailsContent(detailsContent) {
    detailsContent.innerHTML = '';
    if (detailsContent.classList.contains('hidden')) {
        return;
    }
    const selectedProfile = extension_settings.connectionManager.selectedProfile;
    const profile = extension_settings.connectionManager.profiles.find(p => p.id === selectedProfile);
    if (profile) {
        const profileForDisplay = makeFancyProfile(profile);
        const templateParams = { profile: profileForDisplay };
        if (Array.isArray(profile.exclude) && profile.exclude.length > 0) {
            templateParams.omitted = profile.exclude.map(e => FANCY_NAMES[e]).join(', ');
        }
        const template = await renderExtensionTemplateAsync(MODULE_NAME, 'view', templateParams);
        detailsContent.innerHTML = template;
    } else {
        detailsContent.textContent = t`No profile selected`;
    }
}

/**
 * Callback for the /profile-genstream command
 * Generates text using Connection Manager with streaming display support.
 * @param {object} args Named arguments
 * @param {string} value Unnamed argument (the prompt)
 * @returns {Promise<string>} The generated text, optionally with formatted reasoning
 */
async function generateStreamCallback(args, value) {
    if (!value) {
        console.warn('WARN: No argument provided for /profile-genstream command');
        return '';
    }

    // Check if Connection Manager is available
    const context = getContext();
    if (context.extensionSettings.disabledExtensions.includes('connection-manager')) {
        toastr.error(t`Connection Manager is required for /profile-genstream. Use /gen or /genraw instead.`);
        return '';
    }

    const profileIdOrName = args?.profile;
    const includeReasoning = isTrueBoolean(args?.reasoning);
    const systemPrompt = typeof args?.system == 'string' ? args.system : '';
    const maxTokens = Number(args?.length ?? 2048) || 2048;
    const lock = isTrueBoolean(args?.lock);
    const generatingLabel = typeof args?.generating === 'string' ? args.generating : 'Generating...';
    const completedLabel = typeof args?.completed === 'string' ? args.completed : 'Generated';
    const enableStop = !isFalseBoolean(args?.stop);
    const onStopClosure = args?.onStop instanceof SlashCommandClosure ? args.onStop : null;
    const onCompleteClosure = args?.onComplete instanceof SlashCommandClosure ? args.onComplete : null;

    // Parse delay: 'infinite' or negative = null (stay open), number = delay in ms
    let completeDelay = 3000; // Default 3 seconds
    if (args?.delay !== undefined) {
        if (typeof args.delay === 'string' && args.delay.toLowerCase() === 'infinite') {
            completeDelay = null; // Stay until user closes
        } else {
            const parsed = Number(args.delay);
            if (!isNaN(parsed) && parsed >= 0) {
                completeDelay = parsed;
            } else if (!isNaN(parsed) && parsed < 0) {
                completeDelay = null; // Negative = infinite
            }
        }
    }

    // Create abort controller for stop functionality (when stop is enabled)
    const abortController = enableStop ? new AbortController() : null;

    // Compose the stop handler: abort the request + optionally invoke user closure
    const onStopHandler = enableStop ? async () => {
        abortController.abort();
        if (onStopClosure) {
            try {
                const localClosure = onStopClosure.getCopy();
                localClosure.onProgress = () => { };
                await localClosure.execute();
            } catch (e) {
                console.error('[GenStream] Error executing onStop closure', e);
            }
        }
    } : null;

    try {
        if (lock) {
            deactivateSendButtons();
        }

        // Determine which profile to use
        // Use the currently selected profile if no profile specified
        let effectiveProfileId = context.extensionSettings.connectionManager.selectedProfile;

        const profiles = context.extensionSettings.connectionManager.profiles;

        if (profileIdOrName) {
            // Use try to find profile by id first, then fuse search
            const profile = profiles.find(p => p.id === profileIdOrName);
            if (profile) {
                effectiveProfileId = profile.id;
            } else {
                const keys = [
                    { name: 'name', weight: 10 },
                ];
                const fuseResults = performFuzzySearch('profile', profiles, keys, profileIdOrName);
                if (fuseResults.length > 0) {
                    effectiveProfileId = fuseResults[0].item.id;
                } else {
                    toastr.warning(t`Connection profile not found: ${profileIdOrName}`);
                    return '';
                }
            }
        }

        if (!effectiveProfileId) {
            toastr.error(t`No connection profile specified or selected. Use profile= argument or select a profile in Connection Manager.`);
            return '';
        }

        // Create streaming display
        const display = new StreamingDisplay();
        display.show({
            label: generatingLabel,
            icon: ConnectionManagerRequestService.getProfileIcon(effectiveProfileId),
            onStop: onStopHandler,
        });

        const messages = [
            ...(systemPrompt ? [{ role: 'system', content: systemPrompt }] : []),
            { role: 'user', content: value },
        ];

        let finalText = '';
        let finalReasoning = '';

        /** Gets the final (if requested, formatted) text to return for this command @returns {string} */
        function buildResultText() {
            // Format output with reasoning if requested
            if (includeReasoning && finalReasoning) {
                const { formatted } = formatReasoning(finalReasoning, finalText);
                return formatted;
            }

            return finalText;
        }

        try {
            // Attempt streaming first
            const streamResponse = await ConnectionManagerRequestService.sendRequest(
                effectiveProfileId,
                messages,
                maxTokens,
                { extractData: true, includePreset: true, stream: true, signal: abortController?.signal ?? undefined },
            );

            if (typeof streamResponse === 'function') {
                const generator = streamResponse();
                for await (const chunk of generator) {
                    finalText = chunk.text;
                    finalReasoning = chunk.state?.reasoning || '';
                    display.updateReasoning(finalReasoning);
                    display.updateContent(finalText);
                }
            } else {
                // Non-streaming fallback within the try block
                const extracted = streamResponse;
                finalText = extracted?.content || '';
                finalReasoning = extracted?.reasoning || '';
                if (finalReasoning) {
                    display.updateReasoning(finalReasoning);
                }
                display.updateContent(finalText);
            }
        } catch (error) {
            // If the user clicked stop, don't retry — show stopped state and return empty
            if (abortController?.signal?.aborted) {
                display.markStopped({ label: `${generatingLabel} [Stopped]` });
                return buildResultText();
            }

            console.warn('[Slash Commands] Streaming failed, falling back to non-streaming:', error);
            display.hide({ instant: true });

            // Retry with non-streaming
            const response = await ConnectionManagerRequestService.sendRequest(
                effectiveProfileId,
                messages,
                maxTokens,
                { extractData: true, includePreset: true, stream: false },
            );

            const extracted = /** @type {import('../../custom-request.js').ExtractedData} */ (response);
            finalText = extracted?.content || '';
            finalReasoning = extracted?.reasoning || '';

            // Show quick non-streaming display
            display.show({
                label: generatingLabel,
                icon: ConnectionManagerRequestService.getProfileIcon(effectiveProfileId),
            });
            if (finalReasoning) {
                display.updateReasoning(finalReasoning);
            }
            display.updateContent(finalText);
        }

        // Mark as complete with delay (null = stay open until user closes)
        display.complete({ label: completedLabel, delay: completeDelay });

        // Invoke onComplete closure if provided
        if (onCompleteClosure) {
            try {
                const localClosure = onCompleteClosure.getCopy();
                localClosure.onProgress = () => { };
                await localClosure.execute();
            } catch (e) {
                console.error('[GenStream] Error executing onComplete closure', e);
            }
        }

        if (!finalText) {
            toastr.warning(t`Generation returned empty result`);
            return '';
        }

        return buildResultText();
    } catch (err) {
        console.error('Error on /genstream generation', err);
        toastr.error(err.message, t`API Error`, { preventDuplicates: true });
        return '';
    } finally {
        if (lock) {
            activateSendButtons();
        }
    }
}

export async function init() {
    extension_settings.connectionManager = extension_settings.connectionManager || structuredClone(DEFAULT_SETTINGS);

    let settingsChanged = false;
    for (const key of Object.keys(DEFAULT_SETTINGS)) {
        if (extension_settings.connectionManager[key] === undefined) {
            extension_settings.connectionManager[key] = structuredClone(DEFAULT_SETTINGS[key]);
            settingsChanged = true;
        }
    }
    settingsChanged = migrateConnectionManagerSettings() || settingsChanged;
    if (settingsChanged) {
        await saveSettings();
    }

    const container = document.getElementById('rm_api_block');
    const settings = await renderExtensionTemplateAsync(MODULE_NAME, 'settings');
    container.insertAdjacentHTML('afterbegin', settings);

    /** @type {HTMLSelectElement} */
    // @ts-ignore
    const profiles = document.getElementById('connection_profiles');
    const detailsContent = document.getElementById('connection_profile_details_content');
    renderConnectionProfiles(profiles);

    /**
     * Applies a real disabled state to an action icon.
     * @param {HTMLElement | null} button
     * @param {boolean} disabled
     */
    function setActionButtonDisabled(button, disabled) {
        if (!button) {
            return;
        }

        button.classList.toggle('disabled', disabled);
        button.toggleAttribute('disabled', disabled);
        button.setAttribute('aria-disabled', String(disabled));
    }

    /**
     * Checks whether an action icon is disabled.
     * @param {HTMLElement | null} button
     * @returns {boolean}
     */
    function isActionButtonDisabled(button) {
        return !button
            || button.classList.contains('disabled')
            || button.hasAttribute('disabled')
            || button.getAttribute('aria-disabled') === 'true';
    }

    function toggleProfileSpecificButtons() {
        const profileId = extension_settings.connectionManager.selectedProfile;
        const profile = extension_settings.connectionManager.profiles.find(p => p.id === profileId);
        const profileSpecificButtons = [
            'view_connection_profile',
            'update_connection_profile',
            'edit_connection_profile',
            'toggle_profile_favorite',
            'reload_connection_profile',
            'delete_connection_profile',
        ];
        profileSpecificButtons.forEach(id => setActionButtonDisabled(document.getElementById(id), !profileId));
        updateFavoriteButtonState(Boolean(profile?.fav));
    }
    toggleProfileSpecificButtons();

    /**
     * Refreshes profile organization controls after folder/favorite changes.
     * @returns {Promise<void>}
     */
    async function refreshProfileOrganizationUi() {
        renderConnectionProfiles(profiles);
        await renderDetailsContent(detailsContent);
        toggleProfileSpecificButtons();
    }

    /**
     * Emits profile update events for changed profiles.
     * @param {Array<{oldProfile: ConnectionProfile, profile: ConnectionProfile}>} profilePairs Changed profiles
     * @returns {Promise<void>}
     */
    async function emitProfileUpdatePairs(profilePairs) {
        for (const { oldProfile, profile } of profilePairs) {
            await eventSource.emit(event_types.CONNECTION_PROFILE_UPDATED, oldProfile, profile);
        }
    }

    /**
     * Opens the profile folder manager popup.
     * @returns {Promise<void>}
     */
    async function showProfileFolderManager() {
        /** @type {Popup|null} */
        let popup = null;

        async function refreshFolderManagerContent() {
            if (!popup) {
                return;
            }

            const content = await buildFolderManagerContent();
            popup.content.innerHTML = '';
            $(popup.content).append(content);
        }

        async function buildFolderManagerContent() {
            const template = $(await renderExtensionTemplateAsync(MODULE_NAME, 'folder-manager', getFolderManagerTemplateData()));

            template.find('#add_new_folder').on('click', async () => {
                const nameInput = template.find('#new_profile_folder_name');
                const folder = createFolder(nameInput.val());
                if (!folder) {
                    return;
                }

                await saveSettings();
                await refreshProfileOrganizationUi();
                await refreshFolderManagerContent();
                toastr.success(t`Profile folder created.`);
            });
            template.find('#new_profile_folder_name').on('keydown', function (event) {
                if (event.key !== 'Enter') {
                    return;
                }

                event.preventDefault();
                template.find('#add_new_folder').trigger('click');
            });

            template.find('.folder-name-input').on('change', async function () {
                const input = $(this);
                const originalName = String(input.data('originalName') ?? '');
                const folderId = String(input.closest('.folder-item').data('folderId') ?? '');
                const newName = normalizeFolderName(input.val());

                if (newName === originalName) {
                    input.val(originalName);
                    return;
                }

                const folder = renameFolder(folderId, newName);
                if (!folder) {
                    input.val(originalName);
                    return;
                }

                await saveSettings();
                await refreshProfileOrganizationUi();
                await refreshFolderManagerContent();
                toastr.success(t`Profile folder renamed.`);
            });

            template.find('.folder-delete-btn').on('click', async function () {
                const folderId = String($(this).closest('.folder-item').data('folderId') ?? '');
                const folder = getConnectionProfileFolders().find(x => x.id === folderId);
                if (!folder) {
                    toastr.error(t`Folder not found.`);
                    return;
                }

                const profileCount = getFolderProfileCount(folderId);
                const confirm = await Popup.show.confirm(
                    t`Delete profile folder?`,
                    profileCount > 0
                        ? t`Deleting "${folder.name}" will move ${profileCount} profile(s) to the root level.`
                        : folder.name,
                );
                if (!confirm) {
                    return;
                }

                const result = deleteFolder(folderId);
                if (!result) {
                    return;
                }

                await saveSettings();
                await emitProfileUpdatePairs(result.affectedProfiles);
                await refreshProfileOrganizationUi();
                await refreshFolderManagerContent();
                toastr.success(t`Profile folder deleted.`);
            });

            return template;
        }

        const content = await buildFolderManagerContent();
        popup = new Popup(content, POPUP_TYPE.TEXT, '', {
            okButton: t`Close`,
            cancelButton: false,
            wide: true,
            allowVerticalScrolling: true,
        });
        await popup.show();
    }

    const manageFoldersButton = document.getElementById('manage_profile_folders');
    manageFoldersButton?.addEventListener('click', showProfileFolderManager);

    const favoriteButton = document.getElementById('toggle_profile_favorite');
    favoriteButton?.addEventListener('click', async () => {
        if (isActionButtonDisabled(favoriteButton)) {
            return;
        }

        const profileId = extension_settings.connectionManager.selectedProfile;
        const profile = extension_settings.connectionManager.profiles.find(p => p.id === profileId);
        if (!profile) {
            toastr.warning(t`No profile selected.`);
            return;
        }

        const oldProfile = structuredClone(profile);
        const updatedProfile = toggleProfileFavorite(profile.id);
        if (!updatedProfile) {
            return;
        }

        await saveSettings();
        await eventSource.emit(event_types.CONNECTION_PROFILE_UPDATED, oldProfile, updatedProfile);
        await refreshProfileOrganizationUi();
    });

    profiles.addEventListener('change', async function () {
        const applySequence = ++profileApplySequence;
        const selectedProfile = profiles.selectedOptions[0];
        if (!selectedProfile) {
            // Safety net for preventing the command getting stuck
            await eventSource.emit(event_types.CONNECTION_PROFILE_LOADED, NONE);
            return;
        }

        const profileId = selectedProfile.value;
        extension_settings.connectionManager.selectedProfile = profileId;
        await renderDetailsContent(detailsContent);

        toggleProfileSpecificButtons();

        // None option selected
        if (!profileId) {
            await saveSettings();
            await eventSource.emit(event_types.CONNECTION_PROFILE_LOADED, NONE);
            return;
        }

        const profile = extension_settings.connectionManager.profiles.find(p => p.id === profileId);

        if (!profile) {
            console.debug(`Profile not found: ${profileId}`);
            return;
        }

        try {
            await applyConnectionProfile(profile);
        } catch (error) {
            if (!isProfileApplicationAbort(error)) {
                console.error('Failed to apply connection profile', error);
            }
            return;
        }

        if (applySequence !== profileApplySequence) {
            return;
        }

        await saveSettings();
        await eventSource.emit(event_types.CONNECTION_PROFILE_LOADED, profile.name);
    });

    const reloadButton = document.getElementById('reload_connection_profile');
    reloadButton.addEventListener('click', async () => {
        if (isActionButtonDisabled(reloadButton)) {
            return;
        }

        const selectedProfile = extension_settings.connectionManager.selectedProfile;
        const profile = extension_settings.connectionManager.profiles.find(p => p.id === selectedProfile);
        if (!profile) {
            console.debug('No profile selected');
            return;
        }
        ++profileApplySequence;
        try {
            await applyConnectionProfile(profile);
        } catch (error) {
            if (!isProfileApplicationAbort(error)) {
                console.error('Failed to reload connection profile', error);
            }
            return;
        }
        await renderDetailsContent(detailsContent);
        await saveSettings();
        await eventSource.emit(event_types.CONNECTION_PROFILE_LOADED, profile.name);
        toastr.success('Connection profile reloaded', '', { timeOut: 1500 });
    });

    const createButton = document.getElementById('create_connection_profile');
    createButton.addEventListener('click', async () => {
        const profile = await createConnectionProfile();
        if (!profile) {
            return;
        }
        extension_settings.connectionManager.profiles.push(profile);
        extension_settings.connectionManager.selectedProfile = profile.id;
        await saveSettings();
        renderConnectionProfiles(profiles);
        await renderDetailsContent(detailsContent);
        toggleProfileSpecificButtons();
        await eventSource.emit(event_types.CONNECTION_PROFILE_CREATED, profile);
        await eventSource.emit(event_types.CONNECTION_PROFILE_LOADED, profile.name);
    });

    const updateButton = document.getElementById('update_connection_profile');
    updateButton.addEventListener('click', async () => {
        if (isActionButtonDisabled(updateButton)) {
            return;
        }

        const selectedProfile = extension_settings.connectionManager.selectedProfile;
        const profile = extension_settings.connectionManager.profiles.find(p => p.id === selectedProfile);
        if (!profile) {
            console.debug('No profile selected');
            return;
        }
        const oldProfile = structuredClone(profile);
        await updateConnectionProfile(profile);
        await renderDetailsContent(detailsContent);
        await saveSettings();
        await eventSource.emit(event_types.CONNECTION_PROFILE_UPDATED, oldProfile, profile);
        await eventSource.emit(event_types.CONNECTION_PROFILE_LOADED, profile.name);
        toastr.success('Connection profile updated', '', { timeOut: 1500 });
    });

    const deleteAllButton = document.getElementById('delete_all_connection_profiles');
    deleteAllButton?.addEventListener('click', async () => {
        await deleteAllConnectionProfiles();
        renderConnectionProfiles(profiles);
        await renderDetailsContent(detailsContent);
        toggleProfileSpecificButtons();
        await eventSource.emit(event_types.CONNECTION_PROFILE_LOADED, NONE);
    });

    const deleteButton = document.getElementById('delete_connection_profile');
    deleteButton.addEventListener('click', async () => {
        if (isActionButtonDisabled(deleteButton)) {
            return;
        }

        await deleteConnectionProfile();
        renderConnectionProfiles(profiles);
        await renderDetailsContent(detailsContent);
        toggleProfileSpecificButtons();
        await eventSource.emit(event_types.CONNECTION_PROFILE_LOADED, NONE);
    });

    const editButton = document.getElementById('edit_connection_profile');
    editButton.addEventListener('click', async () => {
        if (isActionButtonDisabled(editButton)) {
            return;
        }

        const selectedProfile = extension_settings.connectionManager.selectedProfile;
        const profile = extension_settings.connectionManager.profiles.find(p => p.id === selectedProfile);
        if (!profile) {
            console.debug('No profile selected');
            return;
        }
        if (!Array.isArray(profile.exclude)) {
            profile.exclude = [];
        }

        let saveChanges = false;
        const sortByViewOrder = (a, b) => Object.keys(FANCY_NAMES).indexOf(a) - Object.keys(FANCY_NAMES).indexOf(b);
        const commands = profile.mode === 'cc' ? CC_COMMANDS : TC_COMMANDS;
        const settings = commands.slice().sort(sortByViewOrder).reduce((acc, command) => {
            const fancyName = FANCY_NAMES[command];
            acc[fancyName] = !profile.exclude.includes(command);
            return acc;
        }, {});
        const folders = getSortedFolders().map(folder => ({
            ...folder,
            selected: folder.id === profile.folderId,
        }));
        const template = $(await renderExtensionTemplateAsync(MODULE_NAME, 'edit', { name: profile.name, settings, folders }));
        let newName = await callGenericPopup(template, POPUP_TYPE.INPUT, profile.name, {
            customButtons: [{
                text: t`Save and Update`,
                classes: ['popup-button-ok'],
                result: POPUP_RESULT.AFFIRMATIVE,
                action: () => {
                    saveChanges = true;
                },
            }],
        });

        // If it's cancelled, it will be false
        if (!newName) {
            return;
        }
        newName = DOMPurify.sanitize(String(newName));
        if (!newName) {
            toastr.error('Name cannot be empty.');
            return;
        }

        if (profile.name !== newName && extension_settings.connectionManager.profiles.some(p => p.name === newName)) {
            toastr.error('A profile with the same name already exists.');
            return;
        }

        const newExcludeList = template.find('input[name="exclude"]:not(:checked)').map(function () {
            return Object.entries(FANCY_NAMES).find(x => x[1] === String($(this).val()))?.[0];
        }).get();
        const newFolderId = normalizeFolderId(template.find('#profile_folder_select').val());

        const oldProfile = structuredClone(profile);
        moveProfileToFolder(profile.id, newFolderId);

        if (newExcludeList.length !== profile.exclude.length || !newExcludeList.every(e => profile.exclude.includes(e))) {
            profile.exclude = newExcludeList;
            for (const command of newExcludeList) {
                delete profile[command];
            }
            if (saveChanges) {
                await updateConnectionProfile(profile);
            } else {
                toastr.info('Press "Update" to record them into the profile.', 'Included settings list updated');
            }
        }

        if (profile.name !== newName) {
            toastr.success('Connection profile renamed.');
            profile.name = newName;
        }

        await saveSettings();
        await eventSource.emit(event_types.CONNECTION_PROFILE_UPDATED, oldProfile, profile);
        renderConnectionProfiles(profiles);
        await renderDetailsContent(detailsContent);
    });

    /** @type {HTMLElement} */
    const viewDetails = document.getElementById('view_connection_profile');
    viewDetails.addEventListener('click', async () => {
        if (isActionButtonDisabled(viewDetails)) {
            return;
        }

        viewDetails.classList.toggle('active');
        detailsContent.classList.toggle('hidden');
        await renderDetailsContent(detailsContent);
    });

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'profile',
        helpString: 'Switch to a connection profile or return the name of the current profile in no argument is provided. Use <code>&lt;None&gt;</code> to switch to no profile.',
        returns: 'name of the profile',
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: 'Name of the connection profile',
                enumProvider: profilesProvider,
                isRequired: false,
            }),
        ],
        namedArgumentList: [
            SlashCommandNamedArgument.fromProps({
                name: 'await',
                description: 'Wait for the connection profile to be applied before returning.',
                isRequired: false,
                typeList: [ARGUMENT_TYPE.BOOLEAN],
                defaultValue: 'true',
                enumList: commonEnumProviders.boolean('trueFalse')(),
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'timeout',
                description: 'Maximum time to wait for the API connection to be established, in milliseconds. Set to 0 to disable. Only applies when await=true.',
                isRequired: false,
                typeList: [ARGUMENT_TYPE.NUMBER],
                defaultValue: '2000',
            }),
        ],
        callback: async (args, value) => {
            if (!value || typeof value !== 'string') {
                const selectedProfile = extension_settings.connectionManager.selectedProfile;
                const profile = extension_settings.connectionManager.profiles.find(p => p.id === selectedProfile);
                if (!profile) {
                    return NONE;
                }
                return profile.name;
            }

            if (value === NONE) {
                profiles.selectedIndex = 0;
                profiles.dispatchEvent(new Event('change'));
                return NONE;
            }

            const profile = findProfileByName(value);

            if (!profile) {
                return '';
            }

            const shouldAwait = !isFalseBoolean(String(args?.await));
            const awaitPromise = new Promise((resolve) => eventSource.once(event_types.CONNECTION_PROFILE_LOADED, resolve));

            profiles.selectedIndex = Array.from(profiles.options).findIndex(o => o.value === profile.id);
            profiles.dispatchEvent(new Event('change'));

            if (shouldAwait) {
                await awaitPromise;

                // We should also await the connection to be established
                const parsedTimeout = parseInt(args?.timeout?.toString());
                const timeout = !isNaN(parsedTimeout) ? Math.max(0, parsedTimeout) : 2000;
                if (timeout > 0) {
                    await waitUntilCondition(() => online_status !== 'no_connection', timeout, 100, { rejectOnTimeout: false });
                }
            }

            return profile.name;
        },
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'profile-list',
        helpString: 'List all connection profile names.',
        returns: 'list of profile names',
        callback: () => JSON.stringify(extension_settings.connectionManager.profiles.map(p => p.name)),
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'profile-create',
        returns: 'name of the new profile',
        helpString: 'Create a new connection profile using the current settings.',
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: 'name of the new connection profile',
                isRequired: true,
                typeList: [ARGUMENT_TYPE.STRING],
            }),
        ],
        callback: async (_args, name) => {
            if (!name || typeof name !== 'string') {
                toastr.warning('Please provide a name for the new connection profile.');
                return '';
            }
            const profile = await createConnectionProfile(name);
            if (!profile) {
                return '';
            }
            extension_settings.connectionManager.profiles.push(profile);
            extension_settings.connectionManager.selectedProfile = profile.id;
            await saveSettings();
            renderConnectionProfiles(profiles);
            await renderDetailsContent(detailsContent);
            toggleProfileSpecificButtons();
            await eventSource.emit(event_types.CONNECTION_PROFILE_CREATED, profile);
            return profile.name;
        },
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'profile-update',
        helpString: 'Update the selected connection profile.',
        callback: async () => {
            const selectedProfile = extension_settings.connectionManager.selectedProfile;
            const profile = extension_settings.connectionManager.profiles.find(p => p.id === selectedProfile);
            if (!profile) {
                toastr.warning('No profile selected.');
                return '';
            }
            const oldProfile = structuredClone(profile);
            await updateConnectionProfile(profile);
            await renderDetailsContent(detailsContent);
            await saveSettings();
            await eventSource.emit(event_types.CONNECTION_PROFILE_UPDATED, oldProfile, profile);
            return profile.name;
        },
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'profile-get',
        helpString: 'Get the details of the connection profile. Returns the selected profile if no argument is provided.',
        returns: 'object of the selected profile',
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: 'Name of the connection profile',
                enumProvider: profilesProvider,
                isRequired: false,
            }),
        ],
        callback: async (_args, value) => {
            if (!value || typeof value !== 'string') {
                const selectedProfile = extension_settings.connectionManager.selectedProfile;
                const profile = extension_settings.connectionManager.profiles.find(p => p.id === selectedProfile);
                if (!profile) {
                    return '';
                }
                return JSON.stringify(profile);
            }

            const profile = findProfileByName(value);
            if (!profile) {
                return '';
            }
            return JSON.stringify(profile);
        },
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'profile-genstream',
        callback: generateStreamCallback,
        returns: t`generated text`,
        namedArgumentList: [
            new SlashCommandNamedArgument(
                'lock', t`lock user input during generation`, [ARGUMENT_TYPE.BOOLEAN], false, false, 'off', commonEnumProviders.boolean('onOff')(),
            ),
            SlashCommandNamedArgument.fromProps({
                name: 'profile',
                description: t`connection profile ID to use for generation`,
                typeList: [ARGUMENT_TYPE.STRING],
                enumProvider: commonEnumProviders.connectionProfiles(),
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'reasoning',
                description: t`include formatted reasoning in the output`,
                typeList: [ARGUMENT_TYPE.BOOLEAN],
                defaultValue: 'false',
                enumProvider: commonEnumProviders.boolean('trueFalse'),
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'system',
                description: t`system prompt at the start`,
                typeList: [ARGUMENT_TYPE.STRING],
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'length',
                description: t`API response length in tokens`,
                typeList: [ARGUMENT_TYPE.NUMBER],
                defaultValue: '2048',
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'generating',
                description: t`label/title for the generation display`,
                typeList: [ARGUMENT_TYPE.STRING],
                defaultValue: 'Generating...',
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'completed',
                description: t`updated label/title for when generation completes`,
                typeList: [ARGUMENT_TYPE.STRING],
                defaultValue: 'Generated',
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'delay',
                description: t`auto-hide delay in ms after generation completes. Use "infinite" or negative to keep until manually closed`,
                typeList: [ARGUMENT_TYPE.NUMBER],
                defaultValue: '3000',
                enumList: [
                    new SlashCommandEnumValue('infinite', 'Keep the streaming display open until manually closed', 'command', '♾️'),
                    new SlashCommandEnumValue('any delay in seconds', null, 'number', '⌚', () => true, input => input),
                ],
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'stop',
                description: t`show a stop button on the streaming display that aborts generation when clicked`,
                typeList: [ARGUMENT_TYPE.BOOLEAN],
                defaultValue: 'true',
                enumProvider: commonEnumProviders.boolean('trueFalse'),
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'onStop',
                description: t`closure to execute when the stop button is clicked (in addition to aborting the request)`,
                typeList: [ARGUMENT_TYPE.CLOSURE],
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'onComplete',
                description: t`closure to execute after generation completes successfully`,
                typeList: [ARGUMENT_TYPE.CLOSURE],
            }),
        ],
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: 'prompt',
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: true,
            }),
        ],
        helpString: `
            <div>
                ${t`Generates text using Connection Manager with streaming display. Shows live generation progress including reasoning (thinking) and content.`}
            </div>
            <div>
                ${t`Requires Connection Manager extension. Uses the currently selected profile or the specified profile= argument.`}
            </div>
            <div>
                ${t`Use reasoning=true to include formatted reasoning in the output (using the defined reasoning template). This can be parsed later with /reasoning-parse.`}
            </div>
            <div>
                ${t`Use delay to control auto-hide behavior: number (ms), "infinite", or negative to keep the display open until manually closed. The display shows a green LED when complete.`}
            </div>
            <div>
                ${t`A stop button is shown by default (stop=true). Click it to abort generation and return whatever was streamed so far. Use stop=false to hide the stop button.`}
            </div>
            <div>
                ${t`Use onStop and onComplete closures for custom behavior when generation is stopped or completes.`}
            </div>
            <div>
                ${t`Example: <pre><code>/profile-genstream profile=my-profile-id reasoning=true Summarize the following text</code></pre>`}
            </div>
            <div>
                ${t`Example with infinite display: <pre><code>/profile-genstream delay=infinite Tell me a story</code></pre>`}
            </div>
            <div>
                ${t`Example with custom stop handler: <pre><code>/profile-genstream onStop={: /echo "Generation stopped!" :} Tell me a story</code></pre>`}
            </div>
        `,
    }));
}
