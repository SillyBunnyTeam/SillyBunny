import { DOMPurify, Popper } from '../lib.js';

import { eventSource, event_types, saveSettings, saveSettingsDebounced, getRequestHeaders, animation_duration, CLIENT_VERSION } from '../script.js';
import { POPUP_RESULT, POPUP_TYPE, Popup, callGenericPopup } from './popup.js';
import { renderTemplate, renderTemplateAsync } from './templates.js';
import { delay, deleteValueByPath, equalsIgnoreCaseAndAccents, escapeHtml, sanitizeSelector, setValueByPath, versionCompare } from './utils.js';
import { isAdmin } from './user.js';
import { addLocaleData, getCurrentLocale, t } from './i18n.js';
import { debounce_timeout } from './constants.js';
import { accountStorage } from './util/AccountStorage.js';
import { SimpleMutex } from './util/SimpleMutex.js';
import { loadStylesheetAsync, prefetchAsset } from './dynamic-styles.js';
import { createExtensionScriptLoadError, formatExtensionLoadError } from './extension-load-errors.js';
import {
    EXTENSION_BOOT_ACTIVATION_ACTION,
    normalizeExtensionBootId,
    resolveExtensionActivationState,
    resolveExtensionManifestRegistration,
    sortExtensionBootEntries,
} from './extension-boot-lifecycle/index.js';

export {
    getApiUrl,
    SimpleMutex as ModuleWorkerWrapper,
};

let extensionContextGetter = null;

export function setExtensionContextGetter(getter) {
    extensionContextGetter = typeof getter === 'function' ? getter : null;
}

export function getContext() {
    if (typeof extensionContextGetter !== 'function') {
        throw new Error('Extension context is not available yet.');
    }

    return extensionContextGetter();
}

/** @type {string[]} */
export let extensionNames = [];

/**
 * Holds the type of each extension.
 * Don't use this directly, use getExtensionType instead!
 * @type {Record<string, string>}
 */
export let extensionTypes = {};

/**
 * A list of active modules provided by the Extras API.
 * @type {string[]}
 */
export let modules = [];

/**
 * A set of active extensions.
 * @type {Set<string>}
 */
const activeExtensions = new Set();

/**
 * A set of normalized active extension identifiers.
 * @type {Set<string>}
 */
const activeExtensionDedupKeys = new Set();

/**
 * A set of normalized extension identifiers that are currently activating.
 * @type {Set<string>}
 */
const activatingExtensionDedupKeys = new Set();

/**
 * Errors that occurred while loading extensions.
 * @type {Set<string>}
 */
const extensionLoadErrors = new Set();

// SillyBunny: extensions append settings UI into shared columns; keep that surface resilient.
const extensionSettingsHostIds = ['extensions_settings', 'extensions_settings2'];
const ignoredExtensionSettingsSelectors = [];
const ignoredExtensionSettingsSelector = ignoredExtensionSettingsSelectors.join(', ');
const LEGACY_MOONLIT_ECHOES_SETTINGS_KEY = 'SillyTavernMoonlitEchoesTheme';
const SILLYBUNNY_MOONLIT_ECHOES_EXTENSION_NAME = 'third-party/SillyBunny-MoonlitEchoesTheme';
const MOONLIT_ECHOES_NOTICE_STORAGE_KEY = 'moonlit_echoes_moved_notice_v1';
const LEGACY_BUNDLED_OPT_IN_EXTENSION_IDS = [
    'sillytavern-character-colors',
    'sillytavern-image-gen',
    'sillytavern-moonlitechoestheme',
];
const genericExtensionSettingsClasses = new Set([
    'alignitemscenter',
    'alignitemsbaseline',
    'closeddrawer',
    'drawer-content',
    'extension_container',
    'flex-container',
    'flex1',
    'flexflowcolumn',
    'flexgrow',
    'flexnowrap',
    'hidden',
    'inline-drawer',
    'margin0',
    'marginbot10',
    'wide100p',
    'wide50p',
]);

let extensionSettingsDedupeObserver = null;
let extensionSettingsDedupeScheduled = false;
let bundledOptInSettingsLoaded = false;

const getApiUrl = () => extension_settings.apiUrl;
const sortManifestsByOrder = (a, b) => parseInt(a.loading_order) - parseInt(b.loading_order) || String(a.display_name).localeCompare(String(b.display_name));
const sortManifestsByName = (a, b) => String(a.display_name).localeCompare(String(b.display_name)) || parseInt(a.loading_order) - parseInt(b.loading_order);
let connectedToApi = false;
let extensionPrefetchToken = 0;

/**
 * Holds manifest data for each extension.
 * @type {Record<string, object>}
 */
let manifests = {};

/**
 * Default URL for the Extras API.
 */
const defaultUrl = 'http://localhost:5100';
const extensionSecondaryPrefetchAssets = Object.freeze({
    gallery: [
        { path: 'nanogallery2.woff.min.css', as: 'style' },
        { path: 'jquery.nanogallery2.min.js', as: 'script' },
    ],
    tts: [
        { path: 'kokoro-worker.js', as: 'script' },
        { path: 'lib/kokoro.web.js', as: 'script' },
    ],
});

/**
 * Checks if the extension is officially supported by its URL pattern.
 * @param {string} url URL to check
 * @returns {boolean} True if the URL matches the official pattern
 */
export const EMPTY_AUTHOR = Object.freeze({
    name: '',
    url: '',
});

export function getAuthorFromUrl(url) {
    const result = structuredClone(EMPTY_AUTHOR);

    try {
        const parsedUrl = new URL(url);
        const pathSegments = parsedUrl.pathname.split('/').filter(s => s.length > 0);

        if (parsedUrl.host === 'github.com' && pathSegments.length >= 2) {
            result.name = pathSegments[0];
            result.url = `${parsedUrl.protocol}//${parsedUrl.hostname}/${result.name}`;
        }
    } catch (error) {
        console.debug('Error parsing URL:', error);
    }

    return result;
}

export const isOfficialExtension = (url) => {
    try {
        return /^https:\/\/github\.com\/SillyTavern\/(.+)$/i.test(new URL(url).href);
    } catch {
        return false;
    }
};

let requiresReload = false;
let stateChanged = false;
let saveMetadataTimeout = null;

function getExtensionAssetVersion() {
    return encodeURIComponent(CLIENT_VERSION || 'dev');
}

function getExtensionAssetUrl(name, assetPath) {
    return `/scripts/extensions/${name}/${assetPath}?v=${getExtensionAssetVersion()}`;
}

function scheduleIdleTask(callback, timeout = 4000) {
    if ('requestIdleCallback' in window) {
        return window.requestIdleCallback(callback, { timeout });
    }

    return window.setTimeout(callback, Math.min(timeout, 1000));
}

function prefetchExtensionAsset(name, assetPath, as) {
    if (!assetPath) {
        return;
    }

    try {
        prefetchAsset(getExtensionAssetUrl(name, assetPath), { as });
    } catch (error) {
        console.debug('Could not prefetch extension asset', name, assetPath, error);
    }
}

function scheduleExtensionAssetPrefetch() {
    const connection = navigator.connection;
    if (connection?.saveData || ['slow-2g', '2g'].includes(connection?.effectiveType)) {
        return;
    }

    const token = ++extensionPrefetchToken;

    scheduleIdleTask(() => {
        if (token !== extensionPrefetchToken) {
            return;
        }

        for (const [name, manifest] of Object.entries(manifests)) {
            if (isExtensionDisabled(name)) {
                continue;
            }

            prefetchExtensionAsset(name, manifest.js, 'script');
            prefetchExtensionAsset(name, manifest.css, 'style');

            const secondaryAssets = extensionSecondaryPrefetchAssets[name] ?? [];
            for (const asset of secondaryAssets) {
                prefetchExtensionAsset(name, asset.path, asset.as);
            }
        }
    });
}

export function cancelDebouncedMetadataSave() {
    if (saveMetadataTimeout) {
        console.debug('Debounced metadata save cancelled');
        clearTimeout(saveMetadataTimeout);
        saveMetadataTimeout = null;
    }
}

export function saveMetadataDebounced() {
    const context = getContext();
    const groupId = context.groupId;
    const characterId = context.characterId;
    const chatId = context.chatId;

    cancelDebouncedMetadataSave();

    saveMetadataTimeout = setTimeout(async () => {
        const newContext = getContext();

        if (groupId !== newContext.groupId) {
            console.warn('Group changed, not saving metadata');
            return;
        }

        if (chatId !== newContext.chatId) {
            console.warn('Chat changed, not saving metadata');
            return;
        }

        if (!groupId && characterId !== newContext.characterId) {
            console.warn('Character changed, not saving metadata');
            return;
        }

        console.debug('Saving metadata...');
        await newContext.saveMetadata();
        console.debug('Saved metadata...');
    }, debounce_timeout.relaxed);
}

/**
 * Provides an ability for extensions to render HTML templates synchronously.
 * Templates sanitation and localization is forced.
 * @param {string} extensionName Extension name
 * @param {string} templateId Template ID
 * @param {object} templateData Additional data to pass to the template
 * @returns {string} Rendered HTML
 *
 * @deprecated Use renderExtensionTemplateAsync instead.
 */
export function renderExtensionTemplate(extensionName, templateId, templateData = {}, sanitize = true, localize = true) {
    return renderTemplate(getExtensionAssetUrl(extensionName, `${templateId}.html`), templateData, sanitize, localize, true);
}

/**
 * Provides an ability for extensions to render HTML templates asynchronously.
 * Templates sanitation and localization is forced.
 * @param {string} extensionName Extension name
 * @param {string} templateId Template ID
 * @param {object} templateData Additional data to pass to the template
 * @returns {Promise<string>} Rendered HTML
 */
export function renderExtensionTemplateAsync(extensionName, templateId, templateData = {}, sanitize = true, localize = true) {
    return renderTemplateAsync(getExtensionAssetUrl(extensionName, `${templateId}.html`), templateData, sanitize, localize, true);
}

export const extension_settings = {
    apiUrl: defaultUrl,
    apiKey: '',
    autoConnect: false,
    notifyUpdates: false,
    bundledOptInDefaultsApplied: false,
    bundledOptInProcessedExtensions: [],
    lockedExtensionsUnlockApplied: false,
    disabledExtensions: [],
    expressionOverrides: [],
    memory: {},
    note: {
        default: '',
        chara: [],
        wiAddition: [],
    },
    caption: {
        refine_mode: false,
    },
    expressions: {
        /** @type {number} see `EXPRESSION_API` */
        api: undefined,
        /** @type {string[]} */
        custom: [],
        showDefault: false,
        translate: false,
        /** @type {string} */
        fallback_expression: undefined,
        /** @type {string} */
        llmPrompt: undefined,
        allowMultiple: true,
        rerollIfSame: false,
        promptType: 'raw',
    },
    connectionManager: {
        selectedProfile: '',
        /** @type {import('./extensions/connection-manager/index.js').ConnectionProfile[]} */
        profiles: [],
        /** @type {import('./extensions/connection-manager/index.js').ConnectionProfileFolder[]} */
        folders: [],
    },
    dice: {},
    /** @type {import('./char-data.js').RegexScriptData[]} */
    regex: [],
    /** @type {import('./extensions/regex/index.js').RegexPreset[]} */
    regex_presets: [],
    /** @type {string[]} */
    character_allowed_regex: [],
    /** @type {Record<string, string[]>} */
    preset_allowed_regex: {},
    tts: {},
    sd: {
        prompts: {},
        character_prompts: {},
        character_negative_prompts: {},
    },
    chromadb: {},
    translate: {},
    objective: {},
    quickReply: {},
    randomizer: {
        controls: [],
        fluctuation: 0.1,
        enabled: false,
    },
    speech_recognition: {},
    rvc: {},
    hypebot: {},
    vectors: {},
    variables: {
        global: {},
    },
    /**
     * @type {import('./chats.js').FileAttachment[]}
     */
    attachments: [],
    /**
     * @type {Record<string, import('./chats.js').FileAttachment[]>}
     */
    character_attachments: {},
    /**
     * @type {string[]}
     */
    disabled_attachments: [],
    gallery: {
        /** @type {{[characterKey: string]: string}} */
        folders: {},
        /** @type {string} */
        sort: 'dateAsc',
    },
};

/**
 * SillyBunny: core and bundled extensions used to be force-enabled, which made any entry
 * the user still had in `disabledExtensions` for them a no-op. Now that those toggles are
 * honoured, drop those stale entries once so upgrading does not silently switch off
 * extensions that have been running all along. Choices made afterwards are respected.
 * @returns {boolean} True if the settings were changed.
 */
function clearStaleLockedExtensionDisables() {
    if (extension_settings.lockedExtensionsUnlockApplied) {
        return false;
    }

    extension_settings.lockedExtensionsUnlockApplied = true;

    const staleEntries = extension_settings.disabledExtensions
        .filter(name => ['core', 'bundled'].includes(getExtensionType(name)));

    if (staleEntries.length > 0) {
        console.log(`[Extensions] Re-enabled previously locked extensions: ${staleEntries.join(', ')}`);
        extension_settings.disabledExtensions = extension_settings.disabledExtensions
            .filter(name => !staleEntries.includes(name));
    }

    return true;
}

function applyBundledOptInDefaults({ migrateLegacy = false, initializeProcessedIds = false } = {}) {
    const bundledOptInExtensions = Object.entries(manifests)
        .filter(([, manifest]) => manifest?.bundled_opt_in === true)
        .map(([name]) => name);

    const storedProcessedIds = Array.isArray(extension_settings.bundledOptInProcessedExtensions)
        ? extension_settings.bundledOptInProcessedExtensions
        : [];
    const processedIds = [];
    const processedKeys = new Set();
    let changed = initializeProcessedIds || !Array.isArray(extension_settings.bundledOptInProcessedExtensions);

    for (const id of storedProcessedIds) {
        const key = getExtensionDedupKey(id);
        if (!key || processedKeys.has(key)) {
            changed = true;
            continue;
        }

        processedKeys.add(key);
        processedIds.push(key);
        if (id !== key) {
            changed = true;
        }
    }

    // SillyBunny: the legacy global bit covered older opt-ins; newer bundled opt-ins are tracked per-extension.
    if (migrateLegacy && extension_settings.bundledOptInDefaultsApplied) {
        for (const id of LEGACY_BUNDLED_OPT_IN_EXTENSION_IDS) {
            const key = getExtensionDedupKey(id);
            if (processedKeys.has(key)) {
                continue;
            }

            processedKeys.add(key);
            processedIds.push(key);
            changed = true;
        }
    }

    for (const extensionName of bundledOptInExtensions) {
        const key = getExtensionDedupKey(extensionName);
        if (processedKeys.has(key)) {
            continue;
        }

        if (!extension_settings.disabledExtensions.some(name => areExtensionIdsEqual(name, extensionName))) {
            extension_settings.disabledExtensions.push(extensionName);
        }

        processedKeys.add(key);
        processedIds.push(key);
        changed = true;
    }

    extension_settings.bundledOptInProcessedExtensions = processedIds;
    if (bundledOptInExtensions.length > 0 && !extension_settings.bundledOptInDefaultsApplied) {
        extension_settings.bundledOptInDefaultsApplied = true;
        changed = true;
    }

    return changed;
}

function maybeShowMoonlitEchoesMovedNotice() {
    const moonlitSettings = extension_settings[LEGACY_MOONLIT_ECHOES_SETTINGS_KEY];
    if (!moonlitSettings || typeof moonlitSettings !== 'object' || moonlitSettings.enabled !== true) {
        return;
    }

    const forkExtension = findExtension(SILLYBUNNY_MOONLIT_ECHOES_EXTENSION_NAME);
    if (forkExtension?.enabled || accountStorage.getItem(MOONLIT_ECHOES_NOTICE_STORAGE_KEY) === 'true') {
        return;
    }

    const message = forkExtension
        ? t`Moonlit Echoes moved out of SillyBunny core. Your settings were left unchanged; enable the SillyBunny Moonlit Echoes Theme extension to keep Moonlit styles active.`
        : t`Moonlit Echoes moved out of SillyBunny core. Your settings were left unchanged; install the SillyBunny Moonlit Echoes Theme from Launchpad optional installs to keep Moonlit styles active.`;

    const buttonClass = 'moonlit-echoes-launchpad-button';
    const content = `${message}<br><button type="button" class="menu_button ${buttonClass}">${t`Show in Launchpad`}</button>`;
    toastr.warning(content, t`Moonlit Echoes moved`, {
        timeOut: 0,
        extendedTimeOut: 0,
        tapToDismiss: false,
        closeButton: true,
        escapeHtml: false,
        onShown() {
            const toast = this instanceof HTMLElement ? this : this?.[0];
            const button = toast?.querySelector?.(`.${buttonClass}`);
            button?.addEventListener('click', async () => {
                accountStorage.setItem(MOONLIT_ECHOES_NOTICE_STORAGE_KEY, 'true');
                await globalThis.SillyBunnyShell?.highlightLaunchpadItem?.(SILLYBUNNY_MOONLIT_ECHOES_EXTENSION_NAME);
            });
        },
        onCloseClick() {
            accountStorage.setItem(MOONLIT_ECHOES_NOTICE_STORAGE_KEY, 'true');
        },
    });
}

function showHideExtensionsMenu() {
    // Get the number of menu items that are not hidden
    const hasMenuItems = $('#extensionsMenu').children().filter((_, child) => $(child).css('display') !== 'none').length > 0;

    // We have menu items, so we can stop checking
    if (hasMenuItems) {
        clearInterval(menuInterval);
    }

    // Show or hide the menu button
    $('#extensionsMenuButton').toggle(hasMenuItems);
}

// Periodically check for new extensions
const menuInterval = setInterval(showHideExtensionsMenu, 1000);

function getExtensionHomePage(manifest) {
    const candidate = manifest?.homepage || manifest?.homePage;

    if (typeof candidate !== 'string' || !candidate) {
        return '';
    }

    try {
        const url = new URL(candidate);
        if (!['http:', 'https:'].includes(url.protocol)) {
            return '';
        }

        return url.href;
    } catch {
        return '';
    }
}

function getFullExtensionName(extensionName) {
    return String(extensionName || '').startsWith('third-party') ? extensionName : `third-party${extensionName}`;
}

function hasExtensionHook(extensionName, hookName) {
    const manifest = manifests[getFullExtensionName(extensionName)];
    return !!manifest?.hooks && Object.hasOwn(manifest.hooks, hookName);
}

/**
 * Gets the type of an extension based on its external ID.
 * @param {string} externalId External ID of the extension (excluding or including the leading 'third-party/')
 * @returns {string} Type of the extension (global, local, system, or empty string if not found)
 */
function getExtensionType(externalId) {
    const id = Object.keys(extensionTypes).find(id => id === externalId || (id.startsWith('third-party') && id.endsWith(externalId)));
    return id ? extensionTypes[id] : '';
}

function isExternalExtension(externalId) {
    return ['local', 'global'].includes(getExtensionType(externalId));
}

function areExtensionIdsEqual(left, right) {
    return getExtensionDedupKey(left) === getExtensionDedupKey(right);
}

function resolveExtensionName(name) {
    return extensionNames.find(extName => {
        return equalsIgnoreCaseAndAccents(extName, name) || equalsIgnoreCaseAndAccents(extName, `third-party/${name}`);
    }) ?? name;
}

function isExtensionDisabled(externalId) {
    return extension_settings.disabledExtensions.some(name => areExtensionIdsEqual(name, externalId));
}

function markExtensionInactive(name) {
    const extensionKey = getExtensionDedupKey(name);
    activeExtensions.delete(name);
    activeExtensionDedupKeys.delete(extensionKey);
    activatingExtensionDedupKeys.delete(extensionKey);
}

/**
 * Performs a fetch of the Extras API.
 * @param {string|URL} endpoint Extras API endpoint
 * @param {RequestInit} args Request arguments
 * @returns {Promise<Response>} Response from the fetch
 */
export async function doExtrasFetch(endpoint, args = {}) {
    if (!args) {
        args = {};
    }

    if (!args.method) {
        Object.assign(args, { method: 'GET' });
    }

    if (!args.headers) {
        args.headers = {};
    }

    if (extension_settings.apiKey) {
        Object.assign(args.headers, {
            'Authorization': `Bearer ${extension_settings.apiKey}`,
        });
    }

    return await fetch(endpoint, args);
}

/**
 * Discovers extensions from the API.
 * @returns {Promise<{name: string, type: string}[]>}
 */
async function discoverExtensions() {
    try {
        const response = await fetch('/api/extensions/discover');

        if (response.ok) {
            const extensions = await response.json();
            return extensions;
        } else {
            return [];
        }
    } catch (err) {
        console.error(err);
        return [];
    }
}

function onDisableExtensionClick() {
    const name = $(this).data('name');
    disableExtension(name, false);
}

function onEnableExtensionClick() {
    const name = $(this).data('name');
    enableExtension(name, false);
}

/**
 * Handles toggling all extensions on or off.
 * @param {Object[]} extensionsToToggle
 * @param {JQuery<HTMLElement>} toggleContainer
 * @returns {Object[]} Updated extensionsToToggle array
 */
function onToggleAllExtensions(extensionsToToggle, toggleContainer) {
    const extensionNames = Object.keys(manifests);
    const thirdPartyExtensions = extensionNames.filter(name => ['local', 'global'].includes(getExtensionType(name)));

    const checkIfDisabled = (name) => {
        const toggle = extensionsToToggle.find(ext => ext.name === name);
        return toggle
            ? !toggle.enable
            : isExtensionDisabled(name);
    };

    if (thirdPartyExtensions.length === 0) return [];

    let enable = true;

    for (const name of thirdPartyExtensions) {
        const isEnabled = !checkIfDisabled(name);

        if (isEnabled) {
            enable = false;
            break;
        }
    }

    const toggleHandler = enable ? enableExtension : disableExtension;

    for (const name of thirdPartyExtensions) {
        const isDisabled = checkIfDisabled(name);
        const doToggleExtension = enable ? isDisabled : !isDisabled;

        if (doToggleExtension) {
            const toggle = extensionsToToggle.find(ext => ext.name === name);

            if (toggle) {
                toggle.toggleHandler = toggleHandler;
                toggle.enable = enable;
            } else {
                extensionsToToggle.push({ name, toggleHandler, enable });
            }

            toggleContainer
                .find(`.extension_block[data-name="${name.replace('third-party', '')}"] .extension_toggle input`)
                .prop('checked', enable)
                .toggleClass('toggle_enable', !enable)
                .toggleClass('toggle_disable', enable)
                .toggleClass('checkbox_disabled', !enable);
        }
    }

    return extensionsToToggle;
}

/**
 * Calls a manifest hook for an extension.
 * Hooks are optional function names exported from the extension's JS entry point module.
 * The hook function can optionally return a Promise that will be awaited.
 * @param {string} name Extension name
 * @param {'install' | 'update' | 'delete' | 'enable' | 'disable' | 'activate' | 'clean'} hookName The hook to call
 * @returns {Promise<void>}
 */
async function callExtensionHook(name, hookName) {
    const manifest = manifests[name];

    if (!manifest) {
        console.debug(`callExtensionHook: Extension "${name}" has no manifest, skipping hook "${hookName}"`);
        return;
    }

    if (!manifest.hooks || typeof manifest.hooks !== 'object') {
        return;
    }

    if (!Object.hasOwn(manifest.hooks, hookName)) {
        return;
    }

    const hookFunctionName = manifest.hooks[hookName];

    if (typeof hookFunctionName !== 'string' || !hookFunctionName) {
        console.warn(`callExtensionHook: Extension "${name}" hook "${hookName}" is not a valid string`);
        return;
    }

    if (!manifest.js) {
        console.warn(`callExtensionHook: Extension "${name}" has hook "${hookName}" but no JS entry point defined in manifest`);
        return;
    }

    const url = getExtensionAssetUrl(name, manifest.js);
    console.debug(`callExtensionHook: Calling hook "${hookName}" (function "${hookFunctionName}") for extension "${name}"`);

    try {
        const module = await import(url);

        if (typeof module[hookFunctionName] !== 'function') {
            console.warn(`callExtensionHook: Extension "${name}" hook "${hookName}" references "${hookFunctionName}" which is not an exported function`);
            return;
        }

        const hookCallResult = module[hookFunctionName]();

        const HOOK_TIMEOUT = 5000;
        const HOOK_RESULT = {
            OK: 'ok',
            TIMEOUT: 'timeout',
        };

        const result = await Promise.race([
            (hookCallResult instanceof Promise ? hookCallResult : Promise.resolve(hookCallResult)).then(() => HOOK_RESULT.OK),
            delay(HOOK_TIMEOUT).then(() => HOOK_RESULT.TIMEOUT),
        ]);

        if (result === HOOK_RESULT.TIMEOUT) {
            console.warn(`callExtensionHook: Hook "${hookName}" for extension "${name}" timed out after ${HOOK_TIMEOUT}ms`);
        } else {
            console.debug(`callExtensionHook: Hook "${hookName}" completed for extension "${name}"`);
        }
    } catch (error) {
        console.error(`callExtensionHook: Error calling hook "${hookName}" for extension "${name}":`, error);
    }
}

/**
 * Enables an extension by name.
 * @param {string} name Extension name
 * @param {boolean} [reload=true] If true, reload the page after enabling the extension
 */
export async function enableExtension(name, reload = true) {
    const extensionName = resolveExtensionName(name);
    await callExtensionHook(extensionName, 'enable');
    extension_settings.disabledExtensions = extension_settings.disabledExtensions.filter(x => !areExtensionIdsEqual(x, extensionName));
    stateChanged = true;
    await saveSettings();
    if (reload) {
        location.reload();
    } else {
        requiresReload = true;
    }
}

/**
 * Disables an extension by name.
 * @param {string} name Extension name
 * @param {boolean} [reload=true] If true, reload the page after disabling the extension
 */
export async function disableExtension(name, reload = true) {
    const extensionName = resolveExtensionName(name);

    await callExtensionHook(extensionName, 'disable');
    extension_settings.disabledExtensions = extension_settings.disabledExtensions.filter(x => !areExtensionIdsEqual(x, extensionName));
    extension_settings.disabledExtensions.push(extensionName);
    markExtensionInactive(extensionName);
    await eventSource.emit(event_types.EXTENSION_DISABLED, extensionName);
    stateChanged = true;
    await saveSettings();
    if (reload) {
        location.reload();
    } else {
        requiresReload = true;
    }
}

/**
 * Finds an extension by name, allowing omission of the "third-party/" prefix.
 *
 * @param {string} name - The name of the extension to find
 * @returns {{name: string, enabled: boolean}|null} Object with name and enabled properties, or null if not found
 */
export function findExtension(name) {
    const internalExtensionName = resolveExtensionName(name);
    if (!extensionNames.includes(internalExtensionName)) return null;
    const isEnabled = !isExtensionDisabled(internalExtensionName);
    return { name: internalExtensionName, enabled: isEnabled };
}

/**
 * Returns a deep clone of an extension manifest by short or full name.
 * @param {string} name Extension name, with or without the third-party prefix
 * @returns {object|null} Cloned manifest, or null if not found
 */
export function getExtensionManifest(name) {
    const internalExtensionName = extensionNames.find(extName => {
        return equalsIgnoreCaseAndAccents(extName, name) || equalsIgnoreCaseAndAccents(extName, `third-party/${name}`);
    });

    const manifest = internalExtensionName ? manifests[internalExtensionName] : null;
    return manifest ? structuredClone(manifest) : null;
}

function getNormalizedSettingsText(value) {
    return String(value || '')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
}

function getExtensionSettingsTitle(element) {
    const titleElement = element.querySelector(':scope > .inline-drawer > .inline-drawer-header b, :scope > .inline-drawer > .inline-drawer-header strong, :scope > .inline-drawer > .inline-drawer-header [data-i18n], :scope > .inline-drawer-header b, :scope > .inline-drawer-header strong, :scope > h3, :scope > h4, :scope > [data-extension-name], :scope > .extension-name');
    const title = titleElement?.dataset?.extensionName || titleElement?.textContent || '';

    return getNormalizedSettingsText(title);
}

function getExtensionSettingsStructureKey(element) {
    const identifiers = [...element.querySelectorAll('[id]')]
        .slice(0, 12)
        .map(node => node.id)
        .filter(Boolean)
        .join('|');

    return identifiers ? `structure:${identifiers}` : '';
}

function getExtensionSettingsClassKey(element) {
    const classes = [...element.classList]
        .map(className => className.toLowerCase())
        .filter(className => !genericExtensionSettingsClasses.has(className))
        .sort();

    return classes.length ? `class:${classes.join('.')}` : '';
}

function getExtensionSettingsDedupeKey(element) {
    const datasetName = element.dataset?.extensionName || element.dataset?.extensionId || '';
    if (datasetName) {
        return `data:${getNormalizedSettingsText(datasetName)}`;
    }

    if (element.id && !element.classList.contains('extension_container')) {
        return `id:${element.id.toLowerCase()}`;
    }

    const title = getExtensionSettingsTitle(element);
    if (title) {
        return `title:${title}`;
    }

    const classKey = getExtensionSettingsClassKey(element);
    if (classKey) {
        return classKey;
    }

    const structureKey = getExtensionSettingsStructureKey(element);
    if (structureKey) {
        return structureKey;
    }

    return '';
}

function getExtensionSettingsUnits(host) {
    const units = [];

    for (const child of host.children) {
        if (!(child instanceof HTMLElement) || (ignoredExtensionSettingsSelector && child.matches(ignoredExtensionSettingsSelector))) {
            continue;
        }

        if (child.classList.contains('extension_container')) {
            units.push(...[...child.children].filter(node => node instanceof HTMLElement));
        } else {
            units.push(child);
        }
    }

    return units;
}

function dedupeExtensionSettingsDrawers() {
    const seen = new Map();

    for (const hostId of extensionSettingsHostIds) {
        const host = document.getElementById(hostId);
        if (!host) {
            continue;
        }

        for (const unit of getExtensionSettingsUnits(host)) {
            if (!(unit instanceof HTMLElement) || (ignoredExtensionSettingsSelector && unit.matches(ignoredExtensionSettingsSelector))) {
                continue;
            }

            const key = getExtensionSettingsDedupeKey(unit);
            if (!key) {
                continue;
            }

            const existing = seen.get(key);
            if (existing && existing.isConnected) {
                console.warn('[Extensions] Removing duplicate settings drawer', { key, removed: unit.id || unit.className || unit.tagName });
                unit.remove();
                continue;
            }

            seen.set(key, unit);
        }
    }
}

function scheduleExtensionSettingsDedupe() {
    if (extensionSettingsDedupeScheduled) {
        return;
    }

    extensionSettingsDedupeScheduled = true;
    requestAnimationFrame(() => {
        extensionSettingsDedupeScheduled = false;
        dedupeExtensionSettingsDrawers();
    });
}

function observeExtensionSettingsDrawers() {
    if (extensionSettingsDedupeObserver) {
        extensionSettingsDedupeObserver.disconnect();
    }

    const hosts = extensionSettingsHostIds
        .map(id => document.getElementById(id))
        .filter(Boolean);

    if (!hosts.length) {
        return;
    }

    extensionSettingsDedupeObserver = new MutationObserver(scheduleExtensionSettingsDedupe);
    hosts.forEach(host => extensionSettingsDedupeObserver.observe(host, { childList: true, subtree: true }));
    scheduleExtensionSettingsDedupe();
}

/**
 * Loads manifest.json files for extensions.
 * @param {string[]} names Array of extension names
 * @returns {Promise<Record<string, object>>} Object with extension names as keys and their manifests as values
 */
async function getManifests(names) {
    const results = await Promise.all(names.map(async name => {
        try {
            const response = await fetch(getExtensionAssetUrl(name, 'manifest.json'));
            if (!response.ok) {
                return { name, ok: false };
            }

            return {
                name,
                ok: true,
                manifest: await response.json(),
            };
        } catch (err) {
            console.log('Could not load manifest.json for ' + name, err);
            return { name, ok: false };
        }
    }));

    const obj = {};
    const loadedManifestKeys = new Set();

    for (const result of results) {
        if (!result.ok) {
            continue;
        }

        const registrationState = resolveExtensionManifestRegistration({
            name: result.name,
            existingKeys: loadedManifestKeys,
        });
        if (!registrationState.shouldRegister) {
            console.warn(`[Extensions] Skipping duplicate manifest entry for "${result.name}"`);
            continue;
        }

        loadedManifestKeys.add(registrationState.dedupeKey);
        obj[result.name] = result.manifest;
    }

    return obj;
}

/**
 * Tries to activate all available extensions that are not already active.
 * @returns {Promise<void>}
 */
async function activateExtensions() {
    extensionLoadErrors.clear();
    const clientVersion = CLIENT_VERSION.split(':')[1].replace(/^v/, '');
    const extensions = sortExtensionBootEntries(Object.entries(manifests));
    const extensionNames = extensions.map(x => x[0]);
    const promises = [];

    for (let entry of extensions) {
        const name = entry[0];
        const manifest = entry[1];
        const extensionKey = getExtensionDedupKey(name);
        const extensionDependencies = manifest.dependencies;
        const minClientVersion = manifest.minimum_client_version;
        const displayName = manifest.display_name || name;
        const isDisabled = isExtensionDisabled(name);
        const clientVersionMeetsMinimum = minClientVersion === undefined
            || versionCompare(clientVersion, minClientVersion, { mapSillyBunnyToSillyTavern: true });
        const disabledDependencyNames = Array.isArray(extensionDependencies)
            ? extensionDependencies.filter(dep => isExtensionDisabled(dep))
            : [];
        const activationState = resolveExtensionActivationState({
            name,
            manifest,
            availableModules: modules,
            availableExtensionNames: extensionNames,
            disabledDependencyNames,
            clientVersionMeetsMinimum,
            isDisabled,
            isActive: activeExtensions.has(name),
            isDedupeActive: activeExtensionDedupKeys.has(extensionKey),
            isDedupeActivating: activatingExtensionDedupKeys.has(extensionKey),
        });

        if (activationState.invalidRequires) {
            console.warn(`Extension ${name}: manifest.json 'requires' field is not an array. Loading allowed, but any intended requirements were not verified to exist.`);
        }

        if (activationState.invalidDependencies) {
            console.warn(`Extension ${name}: manifest.json 'dependencies' field is not an array. Loading allowed, but any intended requirements were not verified to exist.`);
        }

        if (activationState.shouldSkip) {
            continue;
        }

        if (activationState.shouldActivate) {
            const activateExtension = async () => {
                console.debug('Activating extension', name);
                activatingExtensionDedupKeys.add(extensionKey);
                const promise = addExtensionLocale(name, manifest).finally(() =>
                    Promise.all([addExtensionScript(name, manifest), addExtensionStyle(name, manifest)]),
                );
                await promise
                    .then(() => {
                        activeExtensions.add(name);
                        activeExtensionDedupKeys.add(extensionKey);
                        return callExtensionHook(name, 'activate');
                    })
                    .catch(err => {
                        const loadError = formatExtensionLoadError(err);
                        console.error('Could not activate extension', name, loadError, err);
                        extensionLoadErrors.add(t`Extension "${displayName}" failed to load: ${loadError}`);
                    })
                    .finally(() => {
                        activatingExtensionDedupKeys.delete(extensionKey);
                    });
            };

            if (activationState.shouldWaitForDependencyActivations) {
                await Promise.allSettled(promises);
                try {
                    await activateExtension();
                } catch (error) {
                    console.error('Could not activate extension', name, error);
                }
            } else {
                promises.push(activateExtension().catch(error => {
                    console.error('Could not activate extension', name, error);
                }));
            }
        } else if (activationState.action === EXTENSION_BOOT_ACTIVATION_ACTION.MISSING_MODULES) {
            console.warn(t`Extension "${name}" did not load. Missing required Extras module(s): "${activationState.missingModules.join(', ')}"`);
            extensionLoadErrors.add(t`Extension "${displayName}" did not load. Missing required Extras module(s): "${activationState.missingModules.join(', ')}"`);
        } else if (activationState.action === EXTENSION_BOOT_ACTIVATION_ACTION.DISABLED_DEPENDENCIES) {
            console.warn(t`Extension "${name}" did not load. Required extensions exist but are disabled: "${activationState.disabledDependencies.join(', ')}". Enable them first, then reload.`);
            extensionLoadErrors.add(t`Extension "${displayName}" did not load. Required extensions exist but are disabled: "${activationState.disabledDependencies.join(', ')}". Enable them first, then reload.`);
        } else if (activationState.action === EXTENSION_BOOT_ACTIVATION_ACTION.MISSING_DEPENDENCIES) {
            console.warn(t`Extension "${name}" did not load. Missing required extensions: "${activationState.missingDependencies.join(', ')}"`);
            extensionLoadErrors.add(t`Extension "${displayName}" did not load. Missing required extensions: "${activationState.missingDependencies.join(', ')}"`);
        } else if (activationState.action === EXTENSION_BOOT_ACTIVATION_ACTION.CLIENT_VERSION_UNSUPPORTED) {
            console.warn(t`Extension "${name}" did not load. Requires ST client version ${minClientVersion}, but current version is ${clientVersion}.`);
            extensionLoadErrors.add(t`Extension "${displayName}" did not load. Requires ST client version ${minClientVersion}, but current version is ${clientVersion}.`);
        }
    }

    await Promise.allSettled(promises);
    $('#extensions_details').toggleClass('warning', extensionLoadErrors.size > 0);
}

async function connectClickHandler() {
    const baseUrl = String($('#extensions_url').val());
    extension_settings.apiUrl = baseUrl;
    const testApiKey = $('#extensions_api_key').val();
    extension_settings.apiKey = String(testApiKey);
    saveSettingsDebounced();
    await connectToApi(baseUrl);
}

function autoConnectInputHandler() {
    const value = $(this).prop('checked');
    extension_settings.autoConnect = !!value;

    if (value && !connectedToApi) {
        $('#extensions_connect').trigger('click');
    }

    saveSettingsDebounced();
}

async function addExtensionsButtonAndMenu() {
    // Guard against double-injection
    if (document.getElementById('extensionsMenu')) {
        return;
    }

    const buttonHTML = await renderTemplateAsync('wandButton');
    const extensionsMenuHTML = await renderTemplateAsync('wandMenu');

    $(document.body).append(extensionsMenuHTML);
    $('#leftSendForm').append(buttonHTML);

    const button = $('#extensionsMenuButton');
    const dropdown = $('#extensionsMenu');
    let isDropdownVisible = false;

    let popper = Popper.createPopper(button.get(0), dropdown.get(0), {
        placement: 'top-start',
    });

    $(button).on('click', function () {
        if (isDropdownVisible) {
            dropdown.fadeOut(animation_duration);
            isDropdownVisible = false;
        } else {
            dropdown.fadeIn(animation_duration);
            isDropdownVisible = true;
        }
        popper.update();
    });

    $('html').on('click', function (e) {
        if (!isDropdownVisible) return;
        const clickTarget = $(e.target);
        const noCloseTargets = ['#sd_gen', '#extensionsMenuButton', '#roll_dice'];
        if (!noCloseTargets.some(id => clickTarget.closest(id).length > 0)) {
            dropdown.fadeOut(animation_duration);
            isDropdownVisible = false;
        }
    });
}

function notifyUpdatesInputHandler() {
    extension_settings.notifyUpdates = !!$('#extensions_notify_updates').prop('checked');
    saveSettingsDebounced();

    if (extension_settings.notifyUpdates) {
        checkForExtensionUpdates(true);
    }
}

/**
 * Connects to the Extras API.
 * @param {string} baseUrl Extras API base URL
 * @returns {Promise<void>}
 */
async function connectToApi(baseUrl) {
    if (!baseUrl) {
        return;
    }

    const url = new URL(baseUrl);
    url.pathname = '/api/modules';

    try {
        const getExtensionsResult = await doExtrasFetch(url);

        if (getExtensionsResult.ok) {
            const data = await getExtensionsResult.json();
            modules = data.modules;
            await activateExtensions();
            await eventSource.emit(event_types.EXTRAS_CONNECTED, modules);
        }

        updateStatus(getExtensionsResult.ok);
    } catch {
        updateStatus(false);
    }
}

/**
 * Updates the status of Extras API connection.
 * @param {boolean} success Whether the connection was successful
 */
function updateStatus(success) {
    connectedToApi = success;
    const _text = success ? t`Connected to API` : t`Could not connect to API`;
    const _class = success ? 'success' : 'failure';
    $('#extensions_status').text(_text);
    $('#extensions_status').attr('class', _class);
}

/**
 * Adds a CSS file for an extension.
 * @param {string} name Extension name
 * @param {object} manifest Extension manifest
 * @returns {Promise<void>} When the CSS is loaded
 */
function addExtensionStyle(name, manifest) {
    if (!manifest.css) {
        return Promise.resolve();
    }

    const url = getExtensionAssetUrl(name, manifest.css);
    const id = sanitizeSelector(`${name}-css`);

    return loadStylesheetAsync(url, { id }).then(() => undefined);
}

/**
 * Loads a JS file for an extension.
 * @param {string} name Extension name
 * @param {object} manifest Extension manifest
 * @returns {Promise<void>} When the script is loaded
 */
function addExtensionScript(name, manifest) {
    if (!manifest.js) {
        return Promise.resolve();
    }

    return new Promise((resolve, reject) => {
        const url = getExtensionAssetUrl(name, manifest.js);
        const id = sanitizeSelector(`${name}-js`);
        let ready = false;

        if ($(`script[id="${id}"]`).length === 0) {
            const script = document.createElement('script');
            script.id = id;
            script.type = 'module';
            script.src = url;
            script.async = true;
            script.onerror = function (err) {
                reject(createExtensionScriptLoadError(name, url, err));
            };
            script.onload = function () {
                if (!ready) {
                    ready = true;
                    resolve();
                }
            };
            document.body.appendChild(script);
        }
    });
}

/**
 * Adds a localization data for an extension.
 * @param {string} name Extension name
 * @param {object} manifest Manifest object
 */
function addExtensionLocale(name, manifest) {
    // No i18n data in the manifest
    if (!manifest.i18n || typeof manifest.i18n !== 'object') {
        return Promise.resolve();
    }

    const currentLocale = getCurrentLocale();
    const localeFile = manifest.i18n[currentLocale];

    // Manifest doesn't provide a locale file for the current locale
    if (!localeFile) {
        return Promise.resolve();
    }

    return fetch(getExtensionAssetUrl(name, localeFile))
        .then(async response => {
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }

            const data = await response.json();

            if (data && typeof data === 'object') {
                addLocaleData(currentLocale, data);
            }
        })
        .catch(err => {
            console.log('Could not load extension locale data for ' + name, err);
        });
}

/**
 * Generates HTML string for displaying an extension in the UI.
 *
 * @param {string} name - The name of the extension.
 * @param {object} manifest - The manifest of the extension.
 * @param {boolean} isActive - Whether the extension is active or not.
 * @param {boolean} isDisabled - Whether the extension is disabled or not.
 * @param {boolean} isExternal - Whether the extension is external or not.
 * @param {string} checkboxClass - The class for the checkbox HTML element.
 * @return {string} - The HTML string that represents the extension.
 */
function generateExtensionHtml(name, manifest, isActive, isDisabled, isExternal, checkboxClass) {
    function getExtensionIcon() {
        const type = getExtensionType(name);
        switch (type) {
            case 'global':
                return '<i class="fa-sm fa-fw fa-solid fa-server" data-i18n="[title]ext_type_global" title="This is a global extension, available for all users."></i>';
            case 'local':
                return '<i class="fa-sm fa-fw fa-solid fa-user" data-i18n="[title]ext_type_local" title="This is a local extension, available only for you."></i>';
            case 'core':
                return '<i class="fa-sm fa-fw fa-solid fa-cube" title="This is a SillyBunny core extension. It cannot be deleted and can be disabled."></i>';
            case 'bundled':
                return '<i class="fa-sm fa-fw fa-solid fa-box-archive" title="This is a bundled third-party extension. It cannot be deleted or updated, and can be disabled."></i>';
            case 'system':
                return '<i class="fa-sm fa-fw fa-solid fa-cog" data-i18n="[title]ext_type_system" title="This is a built-in extension. It cannot be deleted and can be disabled."></i>';
            default:
                return '<i class="fa-sm fa-fw fa-solid fa-question" title="Unknown extension type."></i>';
        }
    }

    const isUserAdmin = isAdmin();
    const extensionIcon = getExtensionIcon();
    const displayName = manifest.display_name;
    const displayVersion = manifest.version || '';
    const extensionHomePage = getExtensionHomePage(manifest);
    const externalId = name.replace('third-party', '');
    let originHtml = '';
    if (isExternal) {
        originHtml = extensionHomePage
            ? `<a href="${extensionHomePage}" target="_blank" rel="noopener noreferrer">`
            : '<a>';
    }

    let toggleElement = isActive || isDisabled ?
        '<input type="checkbox" title="' + t`Click to toggle` + `" data-name="${name}" class="${isActive ? 'toggle_disable' : 'toggle_enable'} ${checkboxClass}" ${isActive ? 'checked' : ''}>` :
        `<input type="checkbox" title="Cannot enable extension" data-name="${name}" class="extension_missing ${checkboxClass}" disabled>`;

    let deleteButton = isExternal ? `<button class="btn_delete menu_button" data-name="${externalId}" data-i18n="[title]Delete" title="Delete"><i class="fa-fw fa-solid fa-trash-can"></i></button>` : '';
    let cleanButton = isExternal && hasExtensionHook(externalId, 'clean') ? `<button class="btn_clean menu_button" data-name="${externalId}" data-i18n="[title]Clean extension data" title="Clean extension data"><i class="fa-fw fa-solid fa-broom"></i></button>` : '';
    let reinstallButton = isExternal ? `<button class="btn_reinstall menu_button" data-name="${externalId}" data-i18n="[title]Reinstall" title="Reinstall"><i class="fa-fw fa-solid fa-rotate-right"></i></button>` : '';
    let updateButton = isExternal ? `<button class="btn_update menu_button displayNone" data-name="${externalId}" title="Update available"><i class="fa-solid fa-download fa-fw"></i></button>` : '';
    let moveButton = isExternal && isUserAdmin ? `<button class="btn_move menu_button" data-name="${externalId}" data-i18n="[title]Move" title="Move"><i class="fa-solid fa-folder-tree fa-fw"></i></button>` : '';
    let branchButton = isExternal && isUserAdmin ? `<button class="btn_branch menu_button" data-name="${externalId}" data-i18n="[title]Switch branch" title="Switch branch"><i class="fa-solid fa-code-branch fa-fw"></i></button>` : '';
    let syncButton = manifest.auto_update === true && !isExternal && isUserAdmin ? `<button class="btn_sync menu_button" data-name="${externalId}" title="Sync from upstream"><i class="fa-solid fa-arrows-rotate fa-fw"></i></button>` : '';
    let modulesInfo = '';

    if (isActive && Array.isArray(manifest.optional)) {
        const optional = new Set(manifest.optional);
        modules.forEach(x => optional.delete(x));
        if (optional.size > 0) {
            const optionalString = DOMPurify.sanitize([...optional].join(', '));
            modulesInfo = '<div class="extension_modules">' + t`Optional modules:` + ` <span class="optional">${optionalString}</span></div>`;
        }
    } else if (!isDisabled) { // Neither active nor disabled
        const requirements = new Set(manifest.requires);
        modules.forEach(x => requirements.delete(x));
        if (requirements.size > 0) {
            const requirementsString = DOMPurify.sanitize([...requirements].join(', '));
            modulesInfo = `<div class="extension_modules">Missing modules: <span class="failure">${requirementsString}</span></div>`;
        }
    }

    // if external, wrap the name in a link to the repo

    let extensionHtml = `
        <div class="extension_block" data-name="${externalId}">
            <div class="extension_toggle">
                ${toggleElement}
            </div>
            <div class="extension_icon">
                ${extensionIcon}
            </div>
            <div class="flexGrow extension_text_block">
                ${originHtml}
                <span class="${isActive ? 'extension_enabled' : isDisabled ? 'extension_disabled' : 'extension_missing'}">
                    <span class="extension_name">${DOMPurify.sanitize(displayName)}</span>
                    <span class="extension_version">${DOMPurify.sanitize(displayVersion)}</span>
                    ${modulesInfo}
                </span>
                ${isExternal ? '</a>' : ''}
            </div>

            <div class="extension_actions flex-container alignItemsCenter">
                ${updateButton}
                ${syncButton}
                ${branchButton}
                ${moveButton}
                ${cleanButton}
                ${reinstallButton}
                ${deleteButton}
            </div>
        </div>`;

    return extensionHtml;
}

function getExtensionDedupKey(name) {
    return normalizeExtensionBootId(name);
}

/**
 * Gets extension data and generates the corresponding HTML for displaying the extension.
 *
 * @param {Array} extension - An array where the first element is the extension name and the second element is the extension manifest.
 * @return {object} - An object with 'isExternal' indicating whether the extension is external, and 'extensionHtml' for the extension's HTML string.
 */
function getExtensionData(extension) {
    const name = extension[0];
    const manifest = extension[1];
    const isActive = activeExtensions.has(name);
    const isDisabled = isExtensionDisabled(name);
    const isExternal = isExternalExtension(name);

    const checkboxClass = isDisabled ? 'checkbox_disabled' : '';

    const extensionHtml = generateExtensionHtml(name, manifest, isActive, isDisabled, isExternal, checkboxClass);

    return { isExternal, extensionHtml, name, dedupeKey: getExtensionDedupKey(name) };
}


/**
 * Gets the module information to be displayed.
 *
 * @return {string} - The HTML string for the module information.
 */
function getModuleInformation() {
    let moduleInfo = modules.length ? `<p>${DOMPurify.sanitize(modules.join(', '))}</p>` : '<p class="failure">' + t`Not connected to the API!` + '</p>';
    return `
        <h3>` + t`Modules provided by your Extras API:` + `</h3>
        ${moduleInfo}
    `;
}

/**
 * Generates HTML for the extension load errors.
 * @returns {string} HTML string containing the errors that occurred while loading extensions.
 */
function getExtensionLoadErrorsHtml() {
    if (extensionLoadErrors.size === 0) {
        return '';
    }

    const container = document.createElement('div');
    container.classList.add('info-block', 'error');

    for (const error of extensionLoadErrors) {
        const errorElement = document.createElement('div');
        errorElement.textContent = error;
        container.appendChild(errorElement);
    }

    return container.outerHTML;
}

/**
 * Generates the HTML strings for all extensions and displays them in a popup.
 */
async function showExtensionsDetails() {
    const abortController = new AbortController();
    let popupPromise;
    try {
        // If we are updating an extension, the "old" popup is still active. We should close that.
        let initialScrollTop = 0;
        const oldPopup = Popup.util.popups.find(popup => popup.content.querySelector('.extensions_info'));
        if (oldPopup) {
            initialScrollTop = oldPopup.content.scrollTop;
            await oldPopup.completeCancelled();
        }
        const htmlErrors = getExtensionLoadErrorsHtml();
        const htmlDefault = $('<div class="marginBot10"><h3>' + t`Built-in Extensions:` + '</h3></div>');

        const htmlExternal = $(`<div class="marginBot10">
            <div class="flex-container alignitemscenter spaceBetween flexnowrap marginBot10">
                <h3 class="margin0">${t`Installed Extensions:`}</h3>
                <div class="flex-container third_party_toolbar"></div>
            </div>
        </div>`);

        const htmlLoading = $(`<div class="flex-container alignItemsCenter justifyCenter marginTop10 marginBot5">
            <i class="fa-solid fa-spinner fa-spin"></i>
            <span>` + t`Loading third-party extensions... Please wait...` + `</span>
        </div>`);

        htmlExternal.append(htmlLoading);

        const sortOrderKey = 'extensions_sortByName';
        const sortByName = accountStorage.getItem(sortOrderKey) === 'true';
        const sortFn = sortByName ? sortManifestsByName : sortManifestsByOrder;
        const extensions = Object.entries(manifests).sort((a, b) => sortFn(a[1], b[1])).map(getExtensionData);
        const renderedExtensions = new Set();
        let extensionsToToggle = [];

        extensions.forEach(value => {
            const { isExternal, extensionHtml, name, dedupeKey } = value;
            if (renderedExtensions.has(dedupeKey)) {
                console.warn(`[Extensions] Skipping duplicate extension block for "${name}"`);
                return;
            }

            renderedExtensions.add(dedupeKey);
            const container = isExternal ? htmlExternal : htmlDefault;
            container.append(extensionHtml);
        });

        const html = $('<div></div>')
            .addClass('extensions_info')
            .append(htmlErrors)
            .append(htmlDefault)
            .append(htmlExternal)
            .append(getModuleInformation());

        {
            const updateAction = async (force) => {
                requiresReload = true;
                await autoUpdateExtensions(force);
                await popup.complete(POPUP_RESULT.AFFIRMATIVE);
            };

            const toolbar = document.createElement('div');
            toolbar.classList.add('extensions_toolbar');

            const updateAllButton = document.createElement('button');
            updateAllButton.classList.add('menu_button', 'menu_button_icon');
            updateAllButton.textContent = t`Update all`;
            updateAllButton.addEventListener('click', () => updateAction(true));

            const updateEnabledOnlyButton = document.createElement('button');
            updateEnabledOnlyButton.classList.add('menu_button', 'menu_button_icon');
            updateEnabledOnlyButton.textContent = t`Update enabled`;
            updateEnabledOnlyButton.addEventListener('click', () => updateAction(false));

            const toggleAllExtensionsButton = document.createElement('div');
            toggleAllExtensionsButton.classList.add('menu_button', 'menu_button_icon');
            toggleAllExtensionsButton.title = t`Bulk toggle third-party extensions.`;
            toggleAllExtensionsButton.innerHTML = `
                <span>${t`Toggle extensions`}</span>
                <div class="fa-solid fa-circle-info opacity50p"></div>
            `;

            const restoreBulkToggledExtensionsButton = document.createElement('div');
            restoreBulkToggledExtensionsButton.classList.add('menu_button', 'menu_button_icon', 'fa-solid', 'fa-arrow-right-rotate', 'displayNone');
            restoreBulkToggledExtensionsButton.title = t`Restore toggled extensions.\n\nIt does not restore extensions toggled individually.`;

            toggleAllExtensionsButton.addEventListener('click', () => {
                extensionsToToggle = onToggleAllExtensions(extensionsToToggle, htmlExternal);

                for (const extension of extensionsToToggle) {
                    const { name } = extension;

                    htmlExternal
                        .find(`.extension_block[data-name="${name.replace('third-party', '')}"] .extension_toggle input`)
                        .off('click')
                        .one('click', () => {
                            extensionsToToggle = extensionsToToggle.filter(ext => ext.name !== name);
                        });
                }

                const restoreButtonHandler = extensionsToToggle.length > 0 ? 'remove' : 'add';

                restoreBulkToggledExtensionsButton.classList[restoreButtonHandler]('displayNone');
            });

            restoreBulkToggledExtensionsButton.addEventListener('click', () => {
                for (const extension of extensionsToToggle) {
                    const { name } = extension;
                    const isDisabled = isExtensionDisabled(name);

                    htmlExternal
                        .find(`.extension_block[data-name="${name.replace('third-party', '')}"] .extension_toggle input`)
                        .prop('checked', !isDisabled)
                        .toggleClass('toggle_enable', isDisabled)
                        .toggleClass('toggle_disable', !isDisabled)
                        .toggleClass('checkbox_disabled', isDisabled);
                }

                extensionsToToggle = [];
                restoreBulkToggledExtensionsButton.classList.add('displayNone');
            });

            const flexExpander = document.createElement('div');
            flexExpander.classList.add('expander');

            const sortOrderButton = document.createElement('button');
            sortOrderButton.classList.add('menu_button', 'menu_button_icon');
            sortOrderButton.textContent = sortByName ? t`Sort: Display Name` : t`Sort: Loading Order`;
            sortOrderButton.addEventListener('click', async () => {
                abortController.abort();
                accountStorage.setItem(sortOrderKey, sortByName ? 'false' : 'true');
                await showExtensionsDetails();
            });

            toolbar.append(updateAllButton, updateEnabledOnlyButton, flexExpander, sortOrderButton);
            htmlExternal.find('.third_party_toolbar').append(restoreBulkToggledExtensionsButton, toggleAllExtensionsButton);
            html.prepend(toolbar);
        }

        let waitingForSave = false;

        const popup = new Popup(html, POPUP_TYPE.TEXT, '', {
            okButton: t`Close`,
            wide: true,
            large: true,
            customButtons: [],
            allowVerticalScrolling: true,
            onClosing: async () => {
                if (waitingForSave) {
                    return false;
                }

                for (const extension of extensionsToToggle) {
                    const { name, toggleHandler, enable } = extension;
                    const isDisabled = isExtensionDisabled(name);

                    try {
                        if (isDisabled && !enable) continue;
                        if (!isDisabled && enable) continue;

                        requiresReload = true;

                        await toggleHandler(name, false);
                    } catch (error) {
                        console.error(`Could not toggle extension ${name}:`, error);
                        toastr.error(t`Could not toggle extension ${name}. See console for details.`);
                    }
                }

                if (stateChanged) {
                    waitingForSave = true;
                    const toast = toastr.info(t`The page will be reloaded shortly...`, t`Extensions state changed`);
                    await saveSettings();
                    toastr.clear(toast);
                    waitingForSave = false;
                    requiresReload = true;
                }

                return true;
            },
        });
        popupPromise = popup.show();
        popup.content.scrollTop = initialScrollTop;
        checkForUpdatesManual(sortFn, abortController.signal).finally(() => htmlLoading.remove());
    } catch (error) {
        toastr.error(t`Error loading extensions. See browser console for details.`);
        console.error(error);
    }
    if (popupPromise) {
        await popupPromise;
        abortController.abort();
    }
    if (requiresReload) {
        location.reload();
    }
}

/**
 * Handles the click event for the update button of an extension.
 * This function makes a POST request to '/api/extensions/update' with the extension's name.
 * If the extension is already up to date, it displays a success message.
 * If the extension is not up to date, it updates the extension and displays a success message with the new commit hash.
 */
async function onUpdateClick() {
    const isCurrentUserAdmin = isAdmin();
    const extensionName = $(this).data('name');
    const isGlobal = getExtensionType(extensionName) === 'global';
    if (isGlobal && !isCurrentUserAdmin) {
        toastr.error(t`You don't have permission to update global extensions.`);
        return;
    }

    const icon = $(this).find('i');
    icon.addClass('fa-spin');
    await updateExtension(extensionName, false);
    // updateExtension eats the error, but we can at least stop the spinner
    icon.removeClass('fa-spin');
}

async function onSyncClick() {
    const extensionName = $(this).data('name');
    const icon = $(this).find('i');
    icon.addClass('fa-spin');

    try {
        const response = await fetch('/api/extensions/sync', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ extensionName }),
        });

        if (!response.ok) {
            const text = await response.text();
            toastr.error(text || response.statusText, t`Extension sync failed`, { timeOut: 5000 });
            return;
        }

        const data = await response.json();
        const versionText = data.version ? ` v${data.version}` : '';
        const commitText = data.shortCommitHash ? ` (${data.shortCommitHash})` : '';
        toastr.success(t`Extension ${extensionName} synced${versionText}${commitText}.`, t`Reload the page to apply updates`);
        requiresReload = true;
        await showExtensionsDetails();
    } catch (error) {
        console.error('Extension sync error:', error);
        toastr.error(t`Extension sync failed. See browser console for details.`);
    } finally {
        icon.removeClass('fa-spin');
    }
}

/**
 * Updates a third-party extension via the API.
 * @param {string} extensionName Extension folder name
 * @param {boolean} quiet If true, don't show a success message
 * @param {number?} timeout Timeout in milliseconds to wait for the update to complete. If null, no timeout is set.
 */
async function updateExtension(extensionName, quiet, timeout = null) {
    try {
        const signal = timeout ? AbortSignal.timeout(timeout) : undefined;
        const response = await fetch('/api/extensions/update', {
            method: 'POST',
            signal: signal,
            headers: getRequestHeaders(),
            body: JSON.stringify({
                extensionName,
                global: getExtensionType(extensionName) === 'global',
            }),
        });

        if (!response.ok) {
            const text = await response.text();
            toastr.error(text || response.statusText, t`Extension update failed`, { timeOut: 5000 });
            console.error('Extension update failed', response.status, response.statusText, text);
            return;
        }

        const data = await response.json();

        if (!quiet) {
            void showExtensionsDetails();
        }

        if (data.isUpToDate) {
            if (!quiet) {
                toastr.success('Extension is already up to date');
            }
        } else {
            const fullExtensionName = extensionName.startsWith('third-party') ? extensionName : `third-party${extensionName}`;
            await callExtensionHook(fullExtensionName, 'update');
            toastr.success(t`Extension ${extensionName} updated to ${data.shortCommitHash}`, t`Reload the page to apply updates`);
        }
    } catch (error) {
        console.error('Extension update error:', error);
    }
}

/**
 * Handles the click event for the delete button of an extension.
 * This function makes a POST request to '/api/extensions/delete' with the extension's name.
 * If the extension is deleted, it displays a success message.
 * Creates a popup for the user to confirm before delete.
 * If the extension has a clean hook, the user can optionally run it before delete.
 */
async function onDeleteClick() {
    const extensionName = $(this).data('name');
    const isCurrentUserAdmin = isAdmin();
    const isGlobal = getExtensionType(extensionName) === 'global';
    if (isGlobal && !isCurrentUserAdmin) {
        toastr.error(t`You don't have permission to delete global extensions.`);
        return;
    }

    const hasCleanHook = hasExtensionHook(extensionName, 'clean');
    const customInputs = hasCleanHook ? [{
        id: 'extension_delete_cleanup',
        label: t`Also clean up extension data`,
        type: 'checkbox',
        defaultState: false,
    }] : [];
    const popup = new Popup(t`Are you sure you want to delete ${escapeHtml(extensionName)}?`, POPUP_TYPE.CONFIRM, '', { customInputs });
    const confirmation = await popup.show();
    if (confirmation === POPUP_RESULT.AFFIRMATIVE) {
        const shouldClean = hasCleanHook && Boolean(popup.inputResults?.get('extension_delete_cleanup'));
        await deleteExtension(extensionName, shouldClean);
    }
}

/**
 * Handles the click event for the clean button of an extension.
 */
async function onCleanClick() {
    const extensionName = $(this).data('name');

    const confirmation = await Popup.show.confirm(t`Clean extension data`, t`Are you sure you want to clean up data for ${escapeHtml(extensionName)}? This action cannot be undone.`);
    if (!confirmation) {
        return;
    }

    await cleanExtension(extensionName);
}

/**
 * Runs an extension clean hook.
 * @param {string} extensionName Extension name
 * @returns {Promise<void>}
 */
async function cleanExtension(extensionName) {
    const fullExtensionName = getFullExtensionName(extensionName);
    await callExtensionHook(fullExtensionName, 'clean');
    await saveSettings();
    toastr.success(t`Extension ${extensionName} data cleaned`);
    delay(1000).then(() => location.reload());
}

async function onReinstallClick() {
    const extensionName = $(this).data('name');
    const isCurrentUserAdmin = isAdmin();
    const isGlobal = getExtensionType(extensionName) === 'global';
    if (isGlobal && !isCurrentUserAdmin) {
        toastr.error(t`You don't have permission to reinstall global extensions.`);
        return;
    }

    // Get the extension manifest to retrieve the repo URL
    const manifest = manifests[extensionName];
    if (!manifest) {
        toastr.error(t`Cannot find extension manifest for ${extensionName}`);
        return;
    }

    const repoUrl = manifest.homepage || manifest.homePage;
    if (!repoUrl) {
        toastr.error(t`Cannot find repository URL for ${extensionName}`);
        return;
    }

    // Confirm with user
    const confirmation = await callGenericPopup(
        t`This will delete and reinstall ${extensionName} from ${repoUrl}. Any local changes will be lost. Continue?`,
        POPUP_TYPE.CONFIRM,
        '',
        {},
    );

    if (confirmation !== POPUP_RESULT.AFFIRMATIVE) {
        return;
    }

    try {
        // Delete the extension
        toastr.info(t`Deleting ${extensionName}...`, t`Reinstalling extension`);
        await callExtensionHook(extensionName, 'delete');

        const deleteResponse = await fetch('/api/extensions/delete', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({
                extensionName,
                global: isGlobal,
            }),
        });

        if (!deleteResponse.ok) {
            const text = await deleteResponse.text();
            throw new Error(text || deleteResponse.statusText);
        }

        // Reinstall the extension
        toastr.info(t`Installing ${extensionName}...`, t`Reinstalling extension`);
        await installExtension(repoUrl, isGlobal);

        toastr.success(t`Extension ${extensionName} reinstalled successfully`);
        delay(1000).then(() => location.reload());
    } catch (error) {
        console.error('Reinstall failed:', error);
        toastr.error(t`Failed to reinstall ${extensionName}: ${error.message}`, t`Reinstall failed`);
    }
}

async function onBranchClick() {
    const extensionName = $(this).data('name');
    const isCurrentUserAdmin = isAdmin();
    const isGlobal = getExtensionType(extensionName) === 'global';
    if (isGlobal && !isCurrentUserAdmin) {
        toastr.error(t`You don't have permission to switch branch.`);
        return;
    }

    let newBranch = '';

    const branches = await getExtensionBranches(extensionName, isGlobal);
    const selectElement = document.createElement('select');
    selectElement.classList.add('text_pole', 'wide100p');
    selectElement.addEventListener('change', function () {
        newBranch = this.value;
    });
    for (const branch of branches) {
        const option = document.createElement('option');
        option.value = branch.name;
        option.textContent = `${branch.name} (${branch.commit}) [${branch.label}]`;
        option.selected = branch.current;
        selectElement.appendChild(option);
    }

    const popup = new Popup(selectElement, POPUP_TYPE.CONFIRM, '', {
        okButton: t`Switch`,
        cancelButton: t`Cancel`,
    });
    const popupResult = await popup.show();

    if (!popupResult || !newBranch) {
        return;
    }

    await switchExtensionBranch(extensionName, isGlobal, newBranch);
}

async function onMoveClick() {
    const extensionName = $(this).data('name');
    const isCurrentUserAdmin = isAdmin();
    const isGlobal = getExtensionType(extensionName) === 'global';
    if (isGlobal && !isCurrentUserAdmin) {
        toastr.error(t`You don't have permission to move extensions.`);
        return;
    }

    const source = getExtensionType(extensionName);
    const destination = source === 'global' ? 'local' : 'global';

    const confirmationHeader = t`Move extension`;
    const confirmationText = source == 'global'
        ? t`Are you sure you want to move ${extensionName} to your local extensions? This will make it available only for you.`
        : t`Are you sure you want to move ${extensionName} to the global extensions? This will make it available for all users.`;

    const confirmation = await Popup.show.confirm(confirmationHeader, confirmationText);

    if (!confirmation) {
        return;
    }

    $(this).find('i').addClass('fa-spin');
    await moveExtension(extensionName, source, destination);
}

/**
 * Moves an extension via the API.
 * @param {string} extensionName Extension name
 * @param {string} source Source type
 * @param {string} destination Destination type
 * @returns {Promise<void>}
 */
async function moveExtension(extensionName, source, destination) {
    try {
        const result = await fetch('/api/extensions/move', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({
                extensionName,
                source,
                destination,
            }),
        });

        if (!result.ok) {
            const text = await result.text();
            toastr.error(text || result.statusText, t`Extension move failed`, { timeOut: 5000 });
            console.error('Extension move failed', result.status, result.statusText, text);
            return;
        }

        toastr.success(t`Extension ${extensionName} moved.`);
        await loadExtensionSettings({}, false, false);
        void showExtensionsDetails();
    } catch (error) {
        console.error('Error:', error);
    }
}

/**
 * Deletes an extension via the API.
 * @param {string} extensionName Extension name to delete
 * @param {boolean} [shouldClean=false] Whether to also run the clean hook before deleting
 */
export async function deleteExtension(extensionName, shouldClean = false) {
    const fullExtensionName = getFullExtensionName(extensionName);
    if (shouldClean) {
        await callExtensionHook(fullExtensionName, 'clean');
    }

    await callExtensionHook(fullExtensionName, 'delete');

    try {
        await fetch('/api/extensions/delete', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({
                extensionName,
                global: getExtensionType(extensionName) === 'global',
            }),
        });
    } catch (error) {
        console.error('Error:', error);
    }

    await saveSettings();
    toastr.success(t`Extension ${extensionName} deleted`);
    delay(1000).then(() => location.reload());
}

/**
 * Fetches the version details of a specific extension.
 *
 * @param {string} extensionName - The name of the extension.
 * @param {AbortSignal} [abortSignal] - The signal to abort the operation.
 * @return {Promise<object>} - An object containing the extension's version details.
 * This object includes the currentBranchName, currentCommitHash, isUpToDate, and remoteUrl.
 * @throws {error} - If there is an error during the fetch operation, it logs the error to the console.
 */
async function getExtensionVersion(extensionName, abortSignal) {
    try {
        const response = await fetch('/api/extensions/version', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({
                extensionName,
                global: getExtensionType(extensionName) === 'global',
            }),
            signal: abortSignal,
        });

        const data = await response.json();
        return data;
    } catch (error) {
        console.error('Error:', error);
    }
}

/**
 * Gets the list of branches for a specific extension.
 * @param {string} extensionName The name of the extension
 * @param {boolean} isGlobal Whether the extension is global or not
 * @returns {Promise<ExtensionBranch[]>} List of branches for the extension
 * @typedef {object} ExtensionBranch
 * @property {string} name The name of the branch
 * @property {string} commit The commit hash of the branch
 * @property {boolean} current Whether this branch is the current one
 * @property {string} label The commit label of the branch
 */
async function getExtensionBranches(extensionName, isGlobal) {
    try {
        const response = await fetch('/api/extensions/branches', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({
                extensionName,
                global: isGlobal,
            }),
        });

        if (!response.ok) {
            const text = await response.text();
            toastr.error(text || response.statusText, t`Extension branches fetch failed`);
            console.error('Extension branches fetch failed', response.status, response.statusText, text);
            return [];
        }

        return await response.json();
    } catch (error) {
        console.error('Error:', error);
        return [];
    }
}

/**
 * Switches the branch of an extension.
 * @param {string} extensionName The name of the extension
 * @param {boolean} isGlobal If the extension is global
 * @param {string} branch Branch name to switch to
 * @returns {Promise<void>}
 */
async function switchExtensionBranch(extensionName, isGlobal, branch) {
    try {
        const response = await fetch('/api/extensions/switch', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({
                extensionName,
                branch,
                global: isGlobal,
            }),
        });

        if (!response.ok) {
            const text = await response.text();
            toastr.error(text || response.statusText, t`Extension branch switch failed`);
            console.error('Extension branch switch failed', response.status, response.statusText, text);
            return;
        }

        toastr.success(t`Extension ${extensionName} switched to ${branch}`, t`Reload the page to apply updates`);
        await loadExtensionSettings({}, false, false);
        void showExtensionsDetails();
    } catch (error) {
        console.error('Error:', error);
    }
}

/**
 * Installs a third-party extension via the API.
 * @param {string} url Extension repository URL
 * @param {boolean} global Is the extension global?
 * @returns {Promise<void>}
 */
export async function installExtension(url, global, branch = '') {
    try {
        const parsedUrl = new URL(url);
        if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
            throw new Error('Invalid URL protocol');
        }
        url = parsedUrl.href;
    } catch (error) {
        console.error('Invalid URL:', error);
        toastr.error(t`Only valid HTTP and HTTPS URLs are allowed.`, t`Invalid URL`);
        return false;
    }

    if (!isOfficialExtension(url)) {
        const extensionInstallationWarningKey = 'extensionInstallationWarningShown';
        if (accountStorage.getItem(extensionInstallationWarningKey)) {
            console.debug('Bypassed URL check for third-party extension (account preference).', url);
        } else {
            let dismissWarning = false;
            const confirmation = await Popup.show.confirm(
                t`Install a third-party extension?`,
                await renderTemplateAsync('thirdPartyExtensionWarning'),
                {
                    customInputs: [{ id: 'dontAskAgain', type: 'checkbox', label: t`Don't show this warning again`, defaultState: false }],
                    onClose: (popup) => {
                        if (!popup.result) {
                            return;
                        }
                        dismissWarning = Boolean(popup.inputResults?.get('dontAskAgain') ?? false);
                    },
                    okButton: t`Yes, install it`,
                    cancelButton: t`No, cancel`,
                },
            );
            if (!confirmation) {
                return false;
            }
            if (dismissWarning) {
                accountStorage.setItem(extensionInstallationWarningKey, '1');
            }
        }
    }

    console.debug('Extension installation started', url);

    toastr.info(t`Please wait...`, t`Installing extension`);

    const request = await fetch('/api/extensions/install', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({
            url,
            global,
            branch,
        }),
    });

    if (!request.ok) {
        const text = await request.text();
        toastr.warning(text || request.statusText, t`Extension installation failed`, { timeOut: 5000 });
        console.error('Extension installation failed', request.status, request.statusText, text);
        return;
    }

    const response = await request.json();
    toastr.success(t`Extension '${response.display_name}' by ${response.author} (version ${response.version}) has been installed successfully!`, t`Extension installation successful`);
    console.debug(`Extension "${response.display_name}" has been installed successfully at ${response.extensionPath}`);
    await loadExtensionSettings({}, false, false);
    await eventSource.emit(event_types.EXTENSION_SETTINGS_LOADED, response);

    if (response.folderName) {
        const extensionName = `third-party/${response.folderName}`;
        await callExtensionHook(extensionName, 'install');
    }

    return true;
}

/**
 * Loads extension settings from the app settings.
 * @param {object} settings App Settings
 * @param {boolean} versionChanged Is this a version change?
 * @param {boolean} enableAutoUpdate Enable auto-update
 */
export async function loadExtensionSettings(settings, versionChanged, enableAutoUpdate) {
    const persistedExtensionSettings = settings.extension_settings;
    const hasPersistedProcessedIds = Array.isArray(persistedExtensionSettings?.bundledOptInProcessedExtensions);
    const shouldInitializeProcessedIds = !bundledOptInSettingsLoaded && !hasPersistedProcessedIds;

    if (settings.extension_settings) {
        Object.assign(extension_settings, settings.extension_settings);
    }

    $('#extensions_url').val(extension_settings.apiUrl);
    $('#extensions_api_key').val(extension_settings.apiKey);
    $('#extensions_autoconnect').prop('checked', extension_settings.autoConnect);
    $('#extensions_notify_updates').prop('checked', extension_settings.notifyUpdates);

    // Activate offline extensions
    await eventSource.emit(event_types.EXTENSIONS_FIRST_LOAD);
    const extensions = await discoverExtensions();
    extensionNames = extensions.map(x => x.name);
    extensionTypes = Object.fromEntries(extensions.map(x => [x.name, x.type]));
    manifests = await getManifests(extensionNames);

    // Clean stale entries from disabledExtensions list
    const originalDisabledCount = extension_settings.disabledExtensions.length;
    extension_settings.disabledExtensions = extension_settings.disabledExtensions.filter(name => {
        const exists = extensionNames.includes(name);
        if (!exists) {
            console.log(`[Extensions] Removed stale disabled extension: ${name}`);
        }
        return exists;
    });
    const removedCount = originalDisabledCount - extension_settings.disabledExtensions.length;

    const unlockMigrationChanged = clearStaleLockedExtensionDisables();
    const bundledOptInChanged = applyBundledOptInDefaults({
        migrateLegacy: shouldInitializeProcessedIds,
        initializeProcessedIds: shouldInitializeProcessedIds,
    });

    if (unlockMigrationChanged || bundledOptInChanged || removedCount > 0) {
        saveSettingsDebounced();
    }
    bundledOptInSettingsLoaded = true;

    scheduleExtensionAssetPrefetch();

    maybeShowMoonlitEchoesMovedNotice();
    if (versionChanged && enableAutoUpdate) {
        await autoUpdateExtensions(false);
    }

    // SillyBunny: extension settings are injected by many independent modules,
    // so guard the shared settings columns against duplicate top-level drawers.
    observeExtensionSettingsDrawers();
    await activateExtensions();
    if (extension_settings.autoConnect && extension_settings.apiUrl) {
        connectToApi(extension_settings.apiUrl);
    }
}

export function doDailyExtensionUpdatesCheck() {
    setTimeout(() => {
        if (extension_settings.notifyUpdates) {
            checkForExtensionUpdates(false);
        }
    }, 1);
}

const concurrencyLimit = 5;
let activeRequestsCount = 0;
const versionCheckQueue = [];

function enqueueVersionCheck(fn) {
    return new Promise((resolve, reject) => {
        versionCheckQueue.push(() => fn().then(resolve).catch(reject));
        processVersionCheckQueue();
    });
}

function processVersionCheckQueue() {
    if (activeRequestsCount >= concurrencyLimit || versionCheckQueue.length === 0) {
        return;
    }
    activeRequestsCount++;
    const fn = versionCheckQueue.shift();
    fn().finally(() => {
        activeRequestsCount--;
        processVersionCheckQueue();
    });
}

/**
 * Performs a manual check for updates on all 3rd-party extensions.
 * @param {function} sortFn Sort function
 * @param {AbortSignal} abortSignal Signal to abort the operation
 * @returns {Promise<any[]>}
 */
async function checkForUpdatesManual(sortFn, abortSignal) {
    const promises = [];
    for (const id of Object.keys(manifests).filter(isExternalExtension).sort((a, b) => sortFn(manifests[a], manifests[b]))) {
        const externalId = id.replace('third-party', '');
        const promise = enqueueVersionCheck(async () => {
            try {
                const data = await getExtensionVersion(externalId, abortSignal);
                const extensionBlock = document.querySelector(`.extension_block[data-name="${externalId}"]`);
                if (extensionBlock && data) {
                    if (data.isUpToDate === false) {
                        const buttonElement = extensionBlock.querySelector('.btn_update');
                        if (buttonElement) {
                            buttonElement.classList.remove('displayNone');
                        }
                        const nameElement = extensionBlock.querySelector('.extension_name');
                        if (nameElement) {
                            nameElement.classList.add('update_available');
                        }
                    }
                    let branch = data.currentBranchName;
                    let commitHash = data.currentCommitHash;
                    let origin = data.remoteUrl || getExtensionHomePage(manifests[id]);

                    const originLink = extensionBlock.querySelector('a');
                    if (originLink) {
                        try {
                            const url = new URL(origin);
                            if (!['https:', 'http:'].includes(url.protocol)) {
                                throw new Error('Invalid protocol');
                            }
                            originLink.href = url.href;
                            originLink.target = '_blank';
                            originLink.rel = 'noopener noreferrer';
                        } catch (error) {
                            console.log('Error setting origin link', originLink, error);
                        }
                    }

                    const versionElement = extensionBlock.querySelector('.extension_version');
                    if (versionElement) {
                        versionElement.textContent += ` (${branch}-${commitHash.substring(0, 7)})`;
                    }
                }
            } catch (error) {
                console.error('Error checking for extension updates', error);
            }
        });
        promises.push(promise);
    }
    return Promise.allSettled(promises);
}

/**
 * Checks if there are updates available for enabled 3rd-party extensions.
 * @param {boolean} force Skip nag check
 * @returns {Promise<any>}
 */
async function checkForExtensionUpdates(force) {
    if (!force) {
        const STORAGE_NAG_KEY = 'extension_update_nag';
        const currentDate = new Date().toDateString();

        // Don't nag more than once a day
        if (accountStorage.getItem(STORAGE_NAG_KEY) === currentDate) {
            return;
        }

        accountStorage.setItem(STORAGE_NAG_KEY, currentDate);
    }

    const isCurrentUserAdmin = isAdmin();
    const updatesAvailable = [];
    const promises = [];

    for (const [id, manifest] of Object.entries(manifests)) {
        const isDisabled = isExtensionDisabled(id);
        if (isDisabled) {
            console.debug(`Skipping extension: ${manifest.display_name} (${id}) for non-admin user`);
            continue;
        }
        const isGlobal = getExtensionType(id) === 'global';
        if (isGlobal && !isCurrentUserAdmin) {
            console.debug(`Skipping global extension: ${manifest.display_name} (${id}) for non-admin user`);
            continue;
        }

        if (manifest.auto_update && isExternalExtension(id)) {
            const promise = enqueueVersionCheck(async () => {
                try {
                    const data = await getExtensionVersion(id.replace('third-party', ''));
                    if (!data.isUpToDate) {
                        updatesAvailable.push(manifest.display_name);
                    }
                } catch (error) {
                    console.error('Error checking for extension updates', error);
                }
            });
            promises.push(promise);
        }
    }

    await Promise.allSettled(promises);

    if (updatesAvailable.length > 0) {
        toastr.info(`${updatesAvailable.map(x => `• ${x}`).join('\n')}`, t`Extension updates available`);
    }
}

/**
 * Updates all enabled 3rd-party extensions that have auto-update enabled.
 * @param {boolean} forceAll Include disabled and not auto-updating
 * @returns {Promise<void>}
 */
async function autoUpdateExtensions(forceAll) {
    if (!Object.entries(manifests).some(([id, manifest]) => isExternalExtension(id) && (forceAll || manifest.auto_update))) {
        return;
    }

    const banner = toastr.info(t`Auto-updating extensions. This may take several minutes.`, t`Please wait...`, { timeOut: 10000, extendedTimeOut: 10000 });
    const isCurrentUserAdmin = isAdmin();
    const promises = [];
    const autoUpdateTimeout = 60 * 1000;
    for (const [id, manifest] of Object.entries(manifests)) {
        const isDisabled = isExtensionDisabled(id);
        if (!forceAll && isDisabled) {
            console.debug(`Skipping extension: ${manifest.display_name} (${id}) for non-admin user`);
            continue;
        }
        const isGlobal = getExtensionType(id) === 'global';
        if (isGlobal && !isCurrentUserAdmin) {
            console.debug(`Skipping global extension: ${manifest.display_name} (${id}) for non-admin user`);
            continue;
        }
        if ((forceAll || manifest.auto_update) && isExternalExtension(id)) {
            console.debug(`Auto-updating 3rd-party extension: ${manifest.display_name} (${id})`);
            promises.push(updateExtension(id.replace('third-party', ''), true, autoUpdateTimeout));
        }
    }
    await Promise.allSettled(promises);
    toastr.clear(banner);
}

/**
 * Runs the generate interceptors for all extensions.
 * @param {any[]} chat Chat array
 * @param {number} contextSize Context size
 * @param {string} type Generation type
 * @returns {Promise<boolean>} True if generation should be aborted
 */
export async function runGenerationInterceptors(chat, contextSize, type) {
    let aborted = false;
    let exitImmediately = false;

    const abort = (/** @type {boolean} */ immediately) => {
        aborted = true;
        exitImmediately = immediately;
    };

    for (const [name, manifest] of Object.entries(manifests).filter(([, x]) => x.generate_interceptor).sort((a, b) => sortManifestsByOrder(a[1], b[1]))) {
        if (isExtensionDisabled(name) || !activeExtensions.has(name)) {
            continue;
        }

        const interceptorKey = manifest.generate_interceptor;
        if (typeof globalThis[interceptorKey] === 'function') {
            try {
                await globalThis[interceptorKey](chat, contextSize, abort, type);
            } catch (e) {
                console.error(`Failed running interceptor for ${manifest.display_name}`, e);
            }
        }

        if (exitImmediately) {
            break;
        }
    }

    return aborted;
}

/**
 * Writes a field to the character's data extensions object.
 * @param {number|string} characterId Index in the character array
 * @param {string} key Field name
 * @param {any} value Field value
 * @returns {Promise<void>} When the field is written
 */
export async function writeExtensionField(characterId, key, value) {
    const context = getContext();
    const character = context.characters[characterId];
    if (!character) {
        console.warn('Character not found', characterId);
        return;
    }
    const extensionPath = `data.extensions.${key}`;
    const isUnset = value === UNSET_VALUE;

    if (isUnset) {
        deleteValueByPath(character, extensionPath);
    } else {
        setValueByPath(character, extensionPath, value);
    }

    // Process JSON data
    if (character.json_data) {
        const jsonData = JSON.parse(character.json_data);
        if (isUnset) {
            deleteValueByPath(jsonData, extensionPath);
        } else {
            setValueByPath(jsonData, extensionPath, value);
        }
        character.json_data = JSON.stringify(jsonData);

        // Make sure the data doesn't get lost when saving the current character
        if (Number(characterId) === Number(context.characterId)) {
            $('#character_json_data').val(character.json_data);
        }
    }

    // Save data to the server
    const saveDataRequest = {
        avatar: character.avatar,
        data: {
            extensions: {
                [key]: value,
            },
        },
    };
    const mergeResponse = await fetch('/api/characters/merge-attributes', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify(saveDataRequest),
    });

    if (!mergeResponse.ok) {
        console.error('Failed to save extension field', mergeResponse.statusText);
    }
}

/**
 * Sentinel value that signals an extension field should be deleted.
 * @type {string}
 */
export const UNSET_VALUE = '__@@UNSET@@__';

/**
 * @typedef {object} BulkExtensionFieldResult
 * @property {string[]} updated Avatar filenames that were updated
 * @property {string[]} skipped Avatar filenames skipped by filters
 * @property {string[]} failed Avatar filenames that failed
 */

/**
 * Writes or deletes an extension field for multiple characters.
 * @param {string[]|null} avatars Avatar filenames. Empty/null targets all character cards.
 * @param {string} key Extension field name
 * @param {any} value Field value, or UNSET_VALUE to delete it
 * @param {object} [options={}] Options
 * @param {string} [options.filterPath] Dot-path filter that must exist
 * @returns {Promise<BulkExtensionFieldResult>} Bulk operation summary
 */
export async function writeExtensionFieldBulk(avatars, key, value, { filterPath } = {}) {
    const context = getContext();
    const extensionPath = `data.extensions.${key}`;
    const isUnset = value === UNSET_VALUE;
    const requestBody = {
        avatars: Array.isArray(avatars) && avatars.length > 0 ? avatars : [],
        data: {
            data: {
                extensions: {
                    [key]: value,
                },
            },
        },
    };

    const resolvedFilterPath = filterPath ?? (isUnset ? extensionPath : undefined);
    if (resolvedFilterPath) {
        requestBody.filter = { path: resolvedFilterPath };
    }

    const mergeResponse = await fetch('/api/characters/merge-attributes', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify(requestBody),
    });

    if (!mergeResponse.ok) {
        console.error('Bulk extension field update failed', mergeResponse.statusText);
        return { updated: [], skipped: [], failed: [] };
    }

    /** @type {BulkExtensionFieldResult} */
    const result = await mergeResponse.json();
    const updatedSet = new Set(result.updated);

    for (const character of context.characters) {
        if (!character || !updatedSet.has(character.avatar)) {
            continue;
        }

        if (isUnset) {
            deleteValueByPath(character, extensionPath);
        } else {
            setValueByPath(character, extensionPath, value);
        }

        if (character.json_data) {
            const jsonData = JSON.parse(character.json_data);
            if (isUnset) {
                deleteValueByPath(jsonData, extensionPath);
            } else {
                setValueByPath(jsonData, extensionPath, value);
            }
            character.json_data = JSON.stringify(jsonData);
        }
    }

    if (context.characterId !== undefined) {
        const activeChar = context.characters[context.characterId];
        if (activeChar && updatedSet.has(activeChar.avatar) && activeChar.json_data) {
            $('#character_json_data').val(activeChar.json_data);
        }
    }

    return result;
}

/**
 * Prompts the user to enter the Git URL of the extension to import.
 * After obtaining the Git URL, makes a POST request to '/api/extensions/install' to import the extension.
 * If the extension is imported successfully, a success message is displayed.
 * If the extension import fails, an error message is displayed and the error is logged to the console.
 * After successfully importing the extension, the extension settings are reloaded and a 'EXTENSION_SETTINGS_LOADED' event is emitted.
 * @param {string} [suggestUrl] Suggested URL to install
 * @returns {Promise<void>}
 */
export async function openThirdPartyExtensionMenu(suggestUrl = '') {
    const isCurrentUserAdmin = isAdmin();
    const html = await renderTemplateAsync('installExtension', { isCurrentUserAdmin });
    const okButton = isCurrentUserAdmin ? t`Install just for me` : t`Install`;

    let global = false;
    const installForAllButton = {
        text: t`Install for all users`,
        appendAtEnd: false,
        action: async () => {
            global = true;
            await popup.complete(POPUP_RESULT.AFFIRMATIVE);
        },
    };
    /** @type {import('./popup.js').CustomPopupInput} */
    const branchNameInput = {
        id: 'extension_branch_name',
        label: t`Branch or tag name (optional)`,
        type: 'text',
        tooltip: 'e.g. main, dev, v1.0.0',
    };

    const customButtons = isCurrentUserAdmin ? [installForAllButton] : [];
    const customInputs = [branchNameInput];
    const popup = new Popup(html, POPUP_TYPE.INPUT, suggestUrl ?? '', { okButton, customButtons, customInputs });
    const input = await popup.show();

    if (!input) {
        console.debug('Extension install cancelled');
        return;
    }

    const url = String(input).trim();
    const branchName = String(popup.inputResults.get('extension_branch_name') ?? '').trim();
    await installExtension(url, global, branchName);
}

export async function initExtensions() {
    await addExtensionsButtonAndMenu();
    $('#extensionsMenuButton').css('display', 'flex');

    $('#extensions_connect').on('click', connectClickHandler);
    $('#extensions_autoconnect').on('input', autoConnectInputHandler);
    $('#extensions_details').on('click', showExtensionsDetails);
    $('#extensions_notify_updates').on('input', notifyUpdatesInputHandler);
    $(document).on('click', '.extensions_info .extension_block .toggle_disable', onDisableExtensionClick);
    $(document).on('click', '.extensions_info .extension_block .toggle_enable', onEnableExtensionClick);
    $(document).on('click', '.extensions_info .extension_block .btn_update', onUpdateClick);
    $(document).on('click', '.extensions_info .extension_block .btn_sync', onSyncClick);
    $(document).on('click', '.extensions_info .extension_block .btn_delete', onDeleteClick);
    $(document).on('click', '.extensions_info .extension_block .btn_clean', onCleanClick);
    $(document).on('click', '.extensions_info .extension_block .btn_reinstall', onReinstallClick);
    $(document).on('click', '.extensions_info .extension_block .btn_move', onMoveClick);
    $(document).on('click', '.extensions_info .extension_block .btn_branch', onBranchClick);

    /**
     * Handles the click event for the third-party extension import button.
     *
     * @listens #third_party_extension_button#click - The click event of the '#third_party_extension_button' element.
     */
    $('#third_party_extension_button').on('click', () => openThirdPartyExtensionMenu());
}
