import {
    abortStatusCheck,
    eventSource,
    event_types,
    getRequestHeaders,
    is_send_press,
    main_api,
    online_status,
    resultCheckStatus,
    setOnlineStatus,
    startStatusLoading,
} from '../script.js';
import { t } from './i18n.js';
import { chat_completion_sources, getStatusOpen, oai_settings } from './openai.js';
import { Popup, POPUP_TYPE } from './popup.js';
import { onServerConnectClick } from './server-history.js';
import { SlashCommand } from './slash-commands/SlashCommand.js';
import { ARGUMENT_TYPE, SlashCommandArgument } from './slash-commands/SlashCommandArgument.js';
import { SlashCommandEnumValue } from './slash-commands/SlashCommandEnumValue.js';
import { SlashCommandParser } from './slash-commands/SlashCommandParser.js';
import { getStatusTextgen, getTextGenServer, textgen_types, textgenerationwebui_settings as textgen_settings } from './textgen-settings.js';
import { delay } from './utils.js';

const API_BASE = '/api/backends/text-completions/koboldcpp';
const POLL_INTERVAL_MS = 2000;
// Sized above KoboldCpp's default swap timeout in router mode (--reqtimeout), because a large model on a slow disk
// can take several minutes to load.
const SWITCH_TIMEOUT_MS = 15 * 60 * 1000;

/**
 * KoboldCpp connects as a Text Completion API or as a Chat Completion source, each with its own URL and dropdown.
 * @typedef {'text'|'chat'} SwitcherMode
 */

/** @type {SwitcherMode[]} */
const MODES = ['text', 'chat'];
/** @type {Record<SwitcherMode, { select: string, hint: string }>} */
const MODE_ELEMENTS = {
    text: { select: 'koboldcpp_model', hint: 'koboldcpp_model_hint' },
    chat: { select: 'koboldcpp_chat_model', hint: 'koboldcpp_chat_model_hint' },
};

/**
 * @typedef {object} SwitcherEntry
 * @property {string} name Option string exactly as KoboldCpp listed it
 * @property {'model'|'config'|'action'} type Entry kind
 */

/**
 * @typedef {object} SwitcherState
 * @property {number} admin 0 when admin mode is off, 1 when it is on, 2 when it also needs the admin password
 * @property {SwitcherEntry[]} entries Entries KoboldCpp can load
 * @property {string|null} loadedModel Loaded model as KoboldCpp reports it, "inactive" when no model is loaded
 * @property {string|null} loadedFile Entry of the loaded model, when one matches
 * @property {number|null} contextSize Context size of the loaded model
 * @property {boolean} vision Whether the loaded model accepts images
 * @property {boolean} audio Whether the loaded model accepts audio
 */

/** @type {Record<SwitcherMode, SwitcherState|null>} */
const switcherStates = { text: null, chat: null };
let loadingEntry = '';
/** @type {SwitcherMode} */
let loadingMode = 'text';
/** @type {Record<SwitcherMode, number>} */
const refreshCounters = { text: 0, chat: 0 };

/**
 * @param {SwitcherMode} mode Connection mode
 * @returns {boolean} Whether KoboldCpp is the selected API in this mode
 */
function isActiveConnection(mode) {
    return mode === 'chat'
        ? main_api === 'openai' && oai_settings.chat_completion_source === chat_completion_sources.KOBOLDCPP
        : main_api === 'textgenerationwebui' && textgen_settings.type === textgen_types.KOBOLDCPP;
}

/**
 * @param {SwitcherMode} mode Connection mode
 * @returns {string} KoboldCpp API URL set for this mode
 */
function getServerUrl(mode) {
    return mode === 'chat' ? String(oai_settings.koboldcpp_url ?? '').trim() : getTextGenServer(textgen_types.KOBOLDCPP);
}

/**
 * @returns {SwitcherMode} The selected KoboldCpp connection, or else the first mode with a URL
 */
function getCommandMode() {
    return MODES.find(isActiveConnection) ?? MODES.find(mode => getServerUrl(mode)) ?? 'text';
}

/**
 * @param {string} name Entry name
 * @returns {string} Display label
 */
function getEntryLabel(name) {
    switch (name) {
        case 'initial_model':
            return t`Reload launch model`;
        case 'unload_model':
            return t`Unload model`;
        default:
            return name;
    }
}

/**
 * @param {string} name Entry name
 * @returns {string} Progress message while KoboldCpp loads the entry
 */
function getProgressText(name) {
    switch (name) {
        case 'initial_model':
            return t`Reloading the launch model...`;
        case 'unload_model':
            return t`Unloading the model...`;
        default:
            return t`Loading ${name}...`;
    }
}

/**
 * @returns {[SwitcherEntry['type'], string][]} Entry types with their group labels, in display order
 */
function getEntryGroups() {
    return [
        ['model', t`Models`],
        ['config', t`Configs`],
        ['action', t`Actions`],
    ];
}

/**
 * @param {SwitcherState|null} state Switcher state
 * @param {string} name Entry name
 * @returns {boolean} Whether loading the entry would leave KoboldCpp as it is
 */
function isAlreadyLoaded(state, name) {
    return name === state?.loadedFile || (name === 'unload_model' && state?.loadedModel === 'inactive');
}

/**
 * @param {SwitcherState|null} state Switcher state
 * @returns {string} Why KoboldCpp offers nothing to load, or an empty string when it offers entries
 */
function getUnavailableReason(state) {
    if (!state) {
        return '';
    }
    if (!state.admin) {
        return t`Start KoboldCpp with --admin and --admindir to switch models here.`;
    }
    if (!state.entries.length) {
        return state.admin === 2
            ? t`KoboldCpp needs its admin password. Enter it as the API key above, then click Connect.`
            : t`KoboldCpp listed no files. Check the folder set with --admindir.`;
    }
    return '';
}

/**
 * @param {SwitcherState} state Switcher state
 * @returns {string} Label for the select option that stands for the loaded model
 */
function getLoadedModelLabel(state) {
    if (state.loadedModel === 'inactive') {
        return t`No model loaded`;
    }
    if (state.loadedModel) {
        return t`${state.loadedModel.replace(/^koboldcpp\//, '')} (loaded)`;
    }
    return t`Select a model`;
}

/**
 * @param {SwitcherMode} mode Connection mode
 */
function renderModelSelect(mode) {
    const select = document.getElementById(MODE_ELEMENTS[mode].select);
    if (!(select instanceof HTMLSelectElement)) {
        return;
    }

    const state = switcherStates[mode];
    const reason = getUnavailableReason(state);
    let hint = '';
    select.replaceChildren();

    if (loadingEntry && loadingMode === mode) {
        select.append(new Option(getEntryLabel(loadingEntry), ''));
        hint = t`KoboldCpp restarts to switch models. Generation is unavailable until it is back.`;
    } else if (!state) {
        select.append(new Option(t`-- Connect to the API --`, ''));
    } else if (reason) {
        select.append(new Option(state.admin ? t`No files to load` : t`Admin mode is off`, ''));
        hint = reason;
    } else {
        if (!state.loadedFile) {
            select.append(new Option(getLoadedModelLabel(state), ''));
        }
        for (const [type, label] of getEntryGroups()) {
            const entries = state.entries.filter(entry => entry.type === type);
            if (!entries.length) {
                continue;
            }
            const group = document.createElement('optgroup');
            group.label = label;
            group.append(...entries.map(entry => new Option(getEntryLabel(entry.name), entry.name)));
            select.append(group);
        }
        select.value = state.loadedFile ?? '';
        hint = t`Models load with KoboldCpp's default settings. Configs (.kcpps) load their saved settings.`;
    }

    $(select).trigger('change.select2');
    $(`#${MODE_ELEMENTS[mode].hint}`).text(hint).parent().toggleClass('displayNone', !hint);
}

/**
 * @param {string} serverUrl KoboldCpp API URL
 * @returns {Promise<SwitcherState|null>} Switcher state, or null when KoboldCpp could not be reached
 */
async function fetchSwitcherState(serverUrl) {
    try {
        const response = await fetch(`${API_BASE}/models`, {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ api_server: serverUrl }),
        });
        return response.ok ? await response.json() : null;
    } catch (error) {
        console.error('Could not get the KoboldCpp model list', error);
        return null;
    }
}

/**
 * Updates the model switcher after a KoboldCpp status check.
 * @param {SwitcherMode} [mode] Connection mode that was checked
 * @returns {Promise<SwitcherState|null>} Switcher state after the update
 */
export async function refreshKoboldCppModels(mode = 'text') {
    if (loadingEntry) {
        return switcherStates[mode];
    }

    const requestId = ++refreshCounters[mode];
    const serverUrl = getServerUrl(mode);
    const state = serverUrl && online_status !== 'no_connection' ? await fetchSwitcherState(serverUrl) : null;

    if (requestId !== refreshCounters[mode] || loadingEntry) {
        return switcherStates[mode];
    }
    switcherStates[mode] = state;
    renderModelSelect(mode);
    return state;
}

/**
 * @returns {SwitcherState|null} What KoboldCpp reported at the last Chat Completion status check
 */
export function getKoboldCppChatState() {
    return switcherStates.chat;
}

/**
 * @returns {boolean} Whether KoboldCpp is the selected Chat Completion source
 */
export function isKoboldCppChatCompletion() {
    return isActiveConnection('chat');
}

/**
 * Counts Chat Completion messages with the tokenizer of the model KoboldCpp has loaded.
 * @param {object[]} messages Chat Completion messages
 * @returns {Promise<number|null>} Token count, or null when KoboldCpp could not count them
 */
export async function countKoboldCppChatTokens(messages) {
    const serverUrl = getServerUrl('chat');
    if (!serverUrl || online_status === 'no_connection') {
        return null;
    }

    // Roles and names count as well, in place of the chat template tokens that KoboldCpp puts around each message.
    const text = messages
        .flatMap(message => Object.values(message))
        .map(value => typeof value === 'string' ? value : JSON.stringify(value))
        .join('\n\n');

    try {
        const response = await fetch('/api/tokenizers/remote/textgenerationwebui/encode', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ text, api_type: textgen_types.KOBOLDCPP, url: serverUrl }),
        });
        const data = response.ok ? await response.json() : null;
        return typeof data?.count === 'number' ? data.count : null;
    } catch (error) {
        console.error('Could not count tokens with KoboldCpp', error);
        return null;
    }
}

/**
 * @param {string} serverUrl KoboldCpp API URL
 * @param {string} name Entry name
 * @returns {Promise<boolean>} Whether KoboldCpp accepted the request
 */
async function requestLoad(serverUrl, name) {
    const response = await fetch(`${API_BASE}/load`, {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ api_server: serverUrl, filename: name }),
    });
    if (!response.ok) {
        throw new Error(`${response.status} ${response.statusText}`);
    }
    const data = await response.json();
    return data?.success === true;
}

/**
 * @param {string} serverUrl KoboldCpp API URL
 * @param {number} requestedAt Time of the load request, in milliseconds
 * @param {AbortSignal|null} signal Stops the wait when aborted
 * @returns {Promise<'restarted'|'timeout'|'cancelled'>} How the wait ended
 */
async function waitForRestart(serverUrl, requestedAt, signal) {
    let wentOffline = false;

    while (Date.now() - requestedAt < SWITCH_TIMEOUT_MS) {
        await delay(POLL_INTERVAL_MS);
        if (signal?.aborted) {
            return 'cancelled';
        }

        try {
            const response = await fetch(`${API_BASE}/uptime`, {
                method: 'POST',
                headers: getRequestHeaders(),
                body: JSON.stringify({ api_server: serverUrl }),
                signal,
            });
            const { online, uptime } = response.ok ? await response.json() : { online: false, uptime: null };
            if (!online) {
                wentOffline = true;
                continue;
            }
            // The old worker answers for a short time after the request, so only a worker younger than the request counts.
            // Without an uptime, coming back after being offline is the next best sign of a restart.
            if (typeof uptime === 'number' ? uptime * 1000 < Date.now() - requestedAt : wentOffline) {
                return 'restarted';
            }
        } catch (error) {
            if (signal?.aborted) {
                return 'cancelled';
            }
            console.debug('KoboldCpp restart poll failed', error);
        }
    }

    return 'timeout';
}

/**
 * @param {string} name Entry that was loaded
 * @param {SwitcherState|null} state Switcher state after the restart
 * @returns {boolean} False when KoboldCpp reports a different model than the entry asked for
 */
function reportLoaded(name, state) {
    const title = t`KoboldCpp`;
    const loadedModel = state?.loadedModel;
    const loadedName = state?.loadedFile ?? loadedModel?.replace(/^koboldcpp\//, '');

    if (name === 'unload_model' && loadedModel && loadedModel !== 'inactive') {
        toastr.warning(t`KoboldCpp restarted with ${loadedName} still loaded.`, title, { timeOut: 10000 });
        return false;
    }
    if (/\.gguf$/i.test(name) && loadedModel && state?.loadedFile !== name) {
        toastr.warning(loadedModel === 'inactive'
            ? t`KoboldCpp restarted without a model instead of loading ${name}. Check the KoboldCpp console for load errors.`
            : t`KoboldCpp restarted with ${loadedName} instead of ${name}. Check the KoboldCpp console for load errors.`, title, { timeOut: 10000 });
        return false;
    }

    if (name === 'unload_model') {
        toastr.success(t`Model unloaded.`, title);
    } else if (name === 'initial_model') {
        toastr.success(t`Launch model reloaded.`, title);
    } else {
        toastr.success(t`Loaded ${name}.`, title);
    }
    return true;
}

/**
 * Asks KoboldCpp to load an entry and waits until it has restarted.
 * @param {string} name Entry name as KoboldCpp listed it
 * @param {SwitcherMode} mode Connection mode whose URL and dropdown to use
 * @returns {Promise<boolean>} Whether KoboldCpp restarted with the entry loaded, as far as its reports show
 */
async function switchKoboldCppModel(name, mode) {
    const title = t`KoboldCpp`;
    const serverUrl = getServerUrl(mode);
    const isActive = isActiveConnection(mode);

    if (!serverUrl) {
        toastr.warning(t`Set the KoboldCpp API URL in API Connections first.`, title);
        return false;
    }
    if (loadingEntry) {
        toastr.info(t`KoboldCpp is still restarting.`, title);
        return false;
    }
    // KoboldCpp restarts its worker process to load an entry, which ends any generation in progress.
    if (isActive && is_send_press) {
        toastr.warning(t`Wait for the current generation to finish before switching models.`, title);
        return false;
    }

    const signal = isActive ? abortStatusCheck.signal : null;
    loadingEntry = name;
    loadingMode = mode;
    renderModelSelect(mode);
    if (isActive) {
        startStatusLoading();
    }
    const progressToast = toastr.info(getProgressText(name), title, { timeOut: 0, extendedTimeOut: 0, tapToDismiss: false });

    /** @type {'restarted'|'timeout'|'cancelled'|'rejected'|'failed'} */
    let outcome;
    try {
        const requestedAt = Date.now();
        if (await requestLoad(serverUrl, name)) {
            if (isActive) {
                setOnlineStatus('no_connection');
            }
            outcome = await waitForRestart(serverUrl, requestedAt, signal);
        } else {
            outcome = 'rejected';
        }
    } catch (error) {
        console.error('KoboldCpp model switch failed', error);
        outcome = 'failed';
    }

    toastr.clear(progressToast);
    loadingEntry = '';

    if (outcome !== 'restarted') {
        // KoboldCpp may still be loading after a timeout or cancel, so the old list no longer describes it.
        if (outcome === 'timeout' || outcome === 'cancelled') {
            switcherStates[mode] = null;
        }
        renderModelSelect(mode);
        // The Cancel button already resets the connection status.
        if (isActive && outcome !== 'cancelled') {
            resultCheckStatus();
        }
        switch (outcome) {
            case 'rejected':
                toastr.error(t`KoboldCpp did not accept "${getEntryLabel(name)}". Click Connect to refresh the list.`, title);
                break;
            case 'failed':
                toastr.error(t`Could not reach KoboldCpp.`, title);
                break;
            case 'timeout':
                toastr.warning(t`KoboldCpp did not come back within ${SWITCH_TIMEOUT_MS / 60_000} minutes. Check the KoboldCpp console, then click Connect.`, title);
                break;
            case 'cancelled':
                toastr.info(t`Stopped waiting for KoboldCpp. Click Connect when it has finished loading.`, title);
                break;
        }
        return false;
    }

    const state = await fetchSwitcherState(serverUrl);
    if (state) {
        switcherStates[mode] = state;
    }
    renderModelSelect(mode);
    // Awaited so that a script such as "/kcpp-model name | /gen" generates only after SillyBunny has reconnected.
    if (isActive) {
        await (mode === 'chat' ? getStatusOpen() : getStatusTextgen());
    }
    return reportLoaded(name, state);
}

/**
 * @param {SwitcherEntry[]} entries Switcher entries
 * @param {string} query Entry name, file name, label, or part of one
 * @returns {{ name: string|null, matches: number }} Matching entry, and how many entries contain the query
 */
function findEntry(entries, query) {
    const needle = query.toLowerCase();
    const getNames = (/** @type {SwitcherEntry} */ entry) => {
        const fileName = entry.name.split(/[\\/]/).pop() ?? entry.name;
        return [entry.name, fileName, fileName.replace(/\.[^.]+$/, ''), getEntryLabel(entry.name)].map(name => name.toLowerCase());
    };

    const exact = entries.find(entry => getNames(entry).includes(needle));
    if (exact) {
        return { name: exact.name, matches: 1 };
    }

    // A wrong guess costs a full model reload, so a partial name has to match exactly one entry.
    const partial = entries.filter(entry => getNames(entry).some(name => name.includes(needle)));
    return { name: partial.length === 1 ? partial[0].name : null, matches: partial.length };
}

/**
 * @param {SwitcherState} state Switcher state
 * @returns {Promise<string|null>} Chosen entry name, or null when the picker was closed
 */
async function pickEntry(state) {
    const content = document.createElement('div');
    content.classList.add('flex-container', 'flexFlowColumn', 'flexGap5');

    const heading = document.createElement('h3');
    heading.textContent = t`Load a KoboldCpp model`;
    const search = document.createElement('input');
    search.type = 'search';
    search.classList.add('text_pole');
    search.placeholder = t`Search...`;
    content.append(heading, search);

    for (const [type, label] of getEntryGroups()) {
        const entries = state.entries.filter(entry => entry.type === type);
        if (!entries.length) {
            continue;
        }

        const groupHeading = document.createElement('h4');
        groupHeading.textContent = label;
        groupHeading.dataset.group = type;
        content.append(groupHeading);

        for (const entry of entries) {
            const item = document.createElement('div');
            item.classList.add('menu_button', 'menu_button_icon', 'wide100p', 'justifyLeft');
            item.tabIndex = 0;
            item.dataset.entry = entry.name;
            item.dataset.group = type;
            if (isAlreadyLoaded(state, entry.name)) {
                const icon = document.createElement('i');
                icon.classList.add('fa-solid', 'fa-circle-check', 'toggleEnabled');
                icon.title = t`Loaded`;
                item.append(icon);
            }
            const text = document.createElement('span');
            text.textContent = getEntryLabel(entry.name);
            // Menu buttons do not wrap, so a long file name would overflow the popup on narrow screens.
            text.style.whiteSpace = 'normal';
            text.style.overflowWrap = 'anywhere';
            item.append(text);
            content.append(item);
        }
    }

    const popup = new Popup(content, POPUP_TYPE.TEXT, '', {
        okButton: false,
        cancelButton: t`Cancel`,
        allowVerticalScrolling: true,
        leftAlign: true,
    });
    const items = Array.from(content.querySelectorAll('[data-entry]'));
    const choose = (/** @type {Element|null} */ item) => {
        if (item instanceof HTMLElement && item.dataset.entry) {
            void popup.complete(item.dataset.entry);
        }
    };

    content.addEventListener('click', event => {
        choose(event.target instanceof Element ? event.target.closest('[data-entry]') : null);
    });
    content.addEventListener('keydown', event => {
        if (event.key !== 'Enter' && event.key !== ' ') {
            return;
        }
        if (event.target === search) {
            if (event.key === 'Enter') {
                event.preventDefault();
                choose(items.find(item => !item.classList.contains('displayNone')) ?? null);
            }
            return;
        }
        if (event.target instanceof Element && event.target.closest('[data-entry]')) {
            event.preventDefault();
            choose(event.target.closest('[data-entry]'));
        }
    });
    search.addEventListener('input', () => {
        const query = search.value.trim().toLowerCase();
        for (const item of items) {
            item.classList.toggle('displayNone', Boolean(query) && !item.textContent.toLowerCase().includes(query));
        }
        for (const groupHeading of content.querySelectorAll('h4[data-group]')) {
            const group = /** @type {HTMLElement} */ (groupHeading).dataset.group;
            groupHeading.classList.toggle('displayNone', !items.some(item => /** @type {HTMLElement} */ (item).dataset.group === group && !item.classList.contains('displayNone')));
        }
    });

    const result = await popup.show();
    return typeof result === 'string' ? result : null;
}

/**
 * @param {object} _args Named arguments
 * @param {string} value Entry to load; opens the picker when empty
 * @returns {Promise<string>} Name of the loaded entry, or an empty string
 */
async function koboldCppModelCallback(_args, value) {
    const title = t`KoboldCpp`;
    const mode = getCommandMode();
    const serverUrl = getServerUrl(mode);
    if (!serverUrl) {
        toastr.warning(t`Set the KoboldCpp API URL in API Connections first.`, title);
        return '';
    }

    const state = await fetchSwitcherState(serverUrl);
    if (!state) {
        toastr.error(t`Could not reach KoboldCpp.`, title);
        return '';
    }
    if (!loadingEntry) {
        refreshCounters[mode]++;
        switcherStates[mode] = state;
        renderModelSelect(mode);
    }

    const reason = getUnavailableReason(state);
    if (reason) {
        toastr.warning(reason, title);
        return '';
    }

    const query = String(value ?? '').trim();
    let name = null;
    if (query) {
        const match = findEntry(state.entries, query);
        name = match.name;
        if (!name) {
            toastr.warning(match.matches > 1
                ? t`${match.matches} KoboldCpp files match "${query}". Use a longer part of the name.`
                : t`No KoboldCpp file matches "${query}".`, title);
            return '';
        }
    } else {
        name = await pickEntry(state);
        if (!name) {
            return '';
        }
    }

    if (isAlreadyLoaded(state, name)) {
        return name;
    }
    return await switchKoboldCppModel(name, mode) ? name : '';
}

/**
 * @param {SwitcherMode} mode Connection mode of the dropdown that changed
 */
function onModelSelectChange(mode) {
    const name = String($(`#${MODE_ELEMENTS[mode].select}`).val() ?? '');
    if (!name) {
        return;
    }
    if (isAlreadyLoaded(switcherStates[mode], name)) {
        renderModelSelect(mode);
        return;
    }
    void switchKoboldCppModel(name, mode).finally(() => renderModelSelect(mode));
}

/**
 * @param {string} status New online status
 */
function onOnlineStatusChanged(status) {
    if (status !== 'no_connection' || loadingEntry) {
        return;
    }
    for (const mode of MODES.filter(isActiveConnection)) {
        refreshCounters[mode]++;
        switcherStates[mode] = null;
        renderModelSelect(mode);
    }
}

export function initKoboldCppModels() {
    for (const mode of MODES) {
        renderModelSelect(mode);
        $(`#${MODE_ELEMENTS[mode].select}`).on('change', () => onModelSelectChange(mode));
    }
    eventSource.on(event_types.ONLINE_STATUS_CHANGED, onOnlineStatusChanged);
    // A click on this button stops before it reaches the document, where the URL history listens for connect clicks.
    $('#api_button_openai').on('click', function () {
        if (isActiveConnection('chat')) {
            onServerConnectClick.call(this);
        }
    });

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'kcpp-model',
        callback: koboldCppModelCallback,
        returns: t`name of the loaded KoboldCpp model or config, or an empty string`,
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: t`model or config to load`,
                typeList: [ARGUMENT_TYPE.STRING],
                enumProvider: () => (switcherStates[getCommandMode()]?.entries ?? []).map(entry => new SlashCommandEnumValue(entry.name, entry.type === 'action' ? getEntryLabel(entry.name) : null)),
            }),
        ],
        helpString: t`Loads a model or config in KoboldCpp, which must run in admin mode. Without an argument, opens a picker. Waits until KoboldCpp has restarted.`,
    }));
}
