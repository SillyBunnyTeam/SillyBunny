import { t } from './i18n.js';
import { createEntryRow, createSpinRow, createSwitchRow } from './sillybunny-editor/rows.js';

/**
 * Backend ▸ Presets: the `config.yaml` settings that the server reads for each Chat Completion request. A change saves at
 * once and applies at once, so there is no Save button and no restart. The settings belong to the server and not to a
 * preset or to this browser: nothing here reaches a preset, a connection profile or the settings store.
 *
 * The Prompt Caching group holds one switch and the two rows that depend on it. `config.yaml` keeps the keys that upstream
 * reads, one switch for each provider and a depth, so the switch is a view over them (see `isPromptCachingOn`).
 */

const GET_ENDPOINT = '/api/server-admin/config/chat-completions/get';
const SAVE_ENDPOINT = '/api/server-admin/config/chat-completions/save';
const TOAST_TITLE = 'Server config';
const GROUP_ID = 'sb-openai-prompt-caching';

export const SETTING_KEYS = Object.freeze({
    claudeSystemPromptCache: 'claude.enableSystemPromptCache',
    geminiSystemPromptCache: 'gemini.enableSystemPromptCache',
    cachingAtDepth: 'claude.cachingAtDepth',
    extendedTtl: 'claude.extendedTTL',
    adaptiveThinking: 'claude.enableAdaptiveThinking',
    apiVersion: 'gemini.apiVersion',
    thoughtSignatures: 'gemini.thoughtSignatures',
});

export const DEFAULT_SETTINGS = Object.freeze({
    claude: Object.freeze({ enableSystemPromptCache: false, cachingAtDepth: -1, extendedTTL: false, enableAdaptiveThinking: true }),
    gemini: Object.freeze({ apiVersion: 'v1beta', thoughtSignatures: true, enableSystemPromptCache: false }),
});

/**
 * The providers that read each of the three settings that are not cache controls. A row shows for these only; the list
 * follows the server code that reads the key (`sendClaudeRequest`, `sendMakerSuiteRequest`, `addOpenRouterSignatures`).
 */
export const ROW_SOURCES = Object.freeze({
    adaptiveThinking: 'claude,linkapi',
    apiVersion: 'makersuite,linkapi',
    thoughtSignatures: 'makersuite,vertexai,openrouter,linkapi',
});

/** @param {unknown} value @param {boolean} fallback */
const toBoolean = (value, fallback) => (typeof value === 'boolean' ? value : fallback);

/**
 * The settings object of a reply, with every key present and of its own type.
 * @param {any} raw
 * @returns {typeof DEFAULT_SETTINGS}
 */
export function normalizeSettings(raw) {
    const claude = raw?.claude ?? {};
    const gemini = raw?.gemini ?? {};
    const depth = Number.parseInt(String(claude.cachingAtDepth ?? DEFAULT_SETTINGS.claude.cachingAtDepth), 10);
    return {
        claude: {
            enableSystemPromptCache: toBoolean(claude.enableSystemPromptCache, DEFAULT_SETTINGS.claude.enableSystemPromptCache),
            cachingAtDepth: Number.isInteger(depth) ? Math.max(depth, -1) : DEFAULT_SETTINGS.claude.cachingAtDepth,
            extendedTTL: toBoolean(claude.extendedTTL, DEFAULT_SETTINGS.claude.extendedTTL),
            enableAdaptiveThinking: toBoolean(claude.enableAdaptiveThinking, DEFAULT_SETTINGS.claude.enableAdaptiveThinking),
        },
        gemini: {
            apiVersion: String(gemini.apiVersion ?? '').trim() || DEFAULT_SETTINGS.gemini.apiVersion,
            thoughtSignatures: toBoolean(gemini.thoughtSignatures, DEFAULT_SETTINGS.gemini.thoughtSignatures),
            enableSystemPromptCache: toBoolean(gemini.enableSystemPromptCache, DEFAULT_SETTINGS.gemini.enableSystemPromptCache),
        },
    };
}

/**
 * Whether Prompt Caching reads as on. The server honours each of the three keys on its own, so the switch is on while any of
 * them still places a cache marker; a switch that read "off" then would hide a marker that is still sent.
 * @param {typeof DEFAULT_SETTINGS} settings
 */
export function isPromptCachingOn(settings) {
    return settings.claude.enableSystemPromptCache || settings.gemini.enableSystemPromptCache || settings.claude.cachingAtDepth >= 0;
}

/**
 * The depth that turning the switch on writes when there is none to write back. Depth 0 marks the last message of the
 * chat, so the cache reaches as far as it can; `config.yaml` names the same value as the one that suits most chats.
 */
export const FIRST_ENABLE_DEPTH = 0;

/**
 * The keys that the master switch writes. Turning it on leaves the Gemini flag as it is: on OpenRouter a Gemini marker
 * caches the system prompt only and stops Gemini's own caching of the chat history, which costs more in a long chat.
 * Turning it off clears the flag, so that no marker stays behind a switch that reads off.
 * @param {boolean} on
 * @param {number|null} [restoredDepth]  The depth to write back when the switch turns on again.
 */
export function masterSwitchPatch(on, restoredDepth = null) {
    if (!on) {
        return { claude: { enableSystemPromptCache: false, cachingAtDepth: -1 }, gemini: { enableSystemPromptCache: false } };
    }
    const depth = Number.isInteger(restoredDepth) && /** @type {number} */ (restoredDepth) >= 0 ? restoredDepth : FIRST_ENABLE_DEPTH;
    return { claude: { enableSystemPromptCache: true, cachingAtDepth: depth } };
}

/**
 * What a change of the master switch writes, and the depth to keep in memory for the next time it turns on. Turning the
 * switch off writes -1 to the depth key, so the row shows the depth it had from memory until the switch turns on again.
 * @param {{on: boolean, depthShown: number, rememberedDepth: number|null}} state
 * @returns {{patch: object, rememberedDepth: number|null}}
 */
export function planMasterChange({ on, depthShown, rememberedDepth }) {
    if (on) return { patch: masterSwitchPatch(true, rememberedDepth), rememberedDepth };
    return { patch: masterSwitchPatch(false), rememberedDepth: depthShown >= 0 ? depthShown : null };
}

/**
 * What each control shows for the settings the server last reported.
 * @param {typeof DEFAULT_SETTINGS} settings
 * @param {number|null} rememberedDepth
 */
export function describeControls(settings, rememberedDepth) {
    const caching = isPromptCachingOn(settings);
    return {
        caching,
        depth: caching || rememberedDepth === null ? settings.claude.cachingAtDepth : rememberedDepth,
        extendedTtl: settings.claude.extendedTTL,
        adaptiveThinking: settings.claude.enableAdaptiveThinking,
        apiVersion: settings.gemini.apiVersion,
        thoughtSignatures: settings.gemini.thoughtSignatures,
    };
}

/**
 * Joins patches in order, so a later value of a key wins and the keys of every patch are kept.
 * @param {...any} patches
 */
export function mergePatches(...patches) {
    const merged = {};
    for (const patch of patches) {
        for (const [group, values] of Object.entries(patch ?? {})) merged[group] = { ...merged[group], ...values };
    }
    return merged;
}

/**
 * Which rows the server leaves alone because an environment variable sets their value. A key of the master switch locks the
 * switch, because it could not turn the key it names.
 * @param {unknown} envManaged  Dotted keys, such as `claude.extendedTTL`.
 */
export function describeLocks(envManaged) {
    const keys = new Set((Array.isArray(envManaged) ? envManaged : []).map(key => String(key).toLowerCase()));
    const locked = (/** @type {string} */ key) => keys.has(key.toLowerCase());
    return {
        caching: [SETTING_KEYS.claudeSystemPromptCache, SETTING_KEYS.geminiSystemPromptCache, SETTING_KEYS.cachingAtDepth].some(locked),
        depth: locked(SETTING_KEYS.cachingAtDepth),
        extendedTtl: locked(SETTING_KEYS.extendedTtl),
        adaptiveThinking: locked(SETTING_KEYS.adaptiveThinking),
        apiVersion: locked(SETTING_KEYS.apiVersion),
        thoughtSignatures: locked(SETTING_KEYS.thoughtSignatures),
    };
}

/**
 * Whether a row that lists providers shows for the chosen one. A source that borrows the form of another one matches that
 * one's list, as `toggleChatCompletionForms` in openai.js does for every `data-source` node.
 * @param {string} sources  Comma-separated providers.
 * @param {string} source
 */
export function matchesSource(sources, source) {
    const effective = source === 'openai_responses' ? 'openai' : source === 'gemini_interactions' ? 'makersuite' : source;
    const valid = sources.split(',');
    return valid.includes(source) || valid.includes(effective);
}

/**
 * Sends changes one after another. A change that arrives while a save is running joins the one that waits, so no two saves
 * run at once and no change is lost. A failed save drops what waits, because the caller restores its controls from the last
 * settings it knows.
 * @param {{send: (patch: any) => Promise<any>, onSaved: (reply: any, state: {queued: boolean}) => void, onFailed: (error: Error) => void}} handlers
 */
export function createSaveQueue({ send, onSaved, onFailed }) {
    let waiting = null;
    let running = false;
    async function drain() {
        if (running) return;
        running = true;
        try {
            while (waiting) {
                const patch = waiting;
                waiting = null;
                let reply;
                try {
                    reply = await send(patch);
                } catch (error) {
                    waiting = null;
                    onFailed(error instanceof Error ? error : new Error(String(error)));
                    return;
                }
                onSaved(reply, { queued: waiting !== null });
            }
        } finally {
            running = false;
        }
    }
    return {
        push(patch) {
            waiting = mergePatches(waiting, patch);
            void drain();
        },
        get busy() {
            return running || waiting !== null;
        },
    };
}

/**
 * @param {string} endpoint
 * @param {object} body
 * @param {{fetch: typeof fetch, getHeaders: () => Promise<Record<string, string>>}} transport
 */
async function post(endpoint, body, { fetch: send, getHeaders }) {
    const response = await send(endpoint, { method: 'POST', headers: await getHeaders(), body: JSON.stringify(body) });
    const text = await response.text();
    let data = {};
    try {
        data = text ? JSON.parse(text) : {};
    } catch {
        data = { message: text };
    }
    if (!response.ok) {
        const error = /** @type {Error & {status?: number}} */ (new Error(data?.error || data?.message || text || `Request failed with status ${response.status}`));
        error.status = response.status;
        throw error;
    }
    return data;
}

/** The child of `body` that holds the node a selector finds. @param {HTMLElement} body @param {string} selector */
function directChild(body, selector) {
    let top = body.querySelector(selector);
    while (top && top.parentElement !== body) top = top.parentElement;
    return top instanceof HTMLElement ? top : null;
}

/**
 * Builds the Prompt Caching group and the three rows that belong in Request Options, reads the settings and keeps the rows
 * in step with the server. Nothing shows until the first read has succeeded, and nothing shows when the read is refused.
 * @param {object} options
 * @param {HTMLElement} options.request  The Request Options group.
 * @param {HTMLElement} options.body  Its box of rows.
 * @param {(options: {id: string, title: string}) => {section: HTMLElement, body: HTMLElement}} options.createGroup
 * @param {() => void} [options.onPlacementChange]  Called after the rows were placed or taken out, so the page can update its groups and its search index.
 * @param {typeof fetch} [options.fetch]
 * @param {() => Promise<Record<string, string>>} [options.getHeaders]
 * @param {(message: string, title: string) => void} [options.notify]
 * @param {() => string} [options.getSource]  The chosen Chat Completion source.
 * @param {() => boolean} [options.isShown]  Whether the Presets page is on screen. The first read waits for it, so that a search which builds the page reaches no admin route.
 * @param {() => Promise<boolean>} [options.isAdmin]  Whether the user may read the server config. The routes are for admins only, and the server logs every request that it refuses.
 */
export function createServerRequestSettings({
    request,
    body,
    createGroup,
    onPlacementChange = () => {},
    fetch: fetchImpl = (...args) => globalThis.fetch(...args),
    getHeaders = async () => (await import('../script.js')).getRequestHeaders(),
    notify = (message, title) => globalThis.toastr?.error(message, title),
    getSource = () => /** @type {HTMLSelectElement|null} */ (document.getElementById('chat_completion_source'))?.value ?? '',
    isAdmin = async () => (await import('./user.js')).isAdmin(),
    isShown = () => {
        const panel = request.closest('[data-sb-panel]');
        return panel?.getAttribute('aria-hidden') === 'false' && panel.checkVisibility();
    },
}) {
    const transport = { fetch: fetchImpl, getHeaders };
    const state = {
        known: normalizeSettings(null),
        locks: describeLocks([]),
        rememberedDepth: /** @type {number|null} */ (null),
        available: false,
        reading: false,
        readFailureShown: false,
    };

    const masterId = 'sb-config-prompt-caching-enabled';
    const master = createSwitchRow({
        label: t`Enable Prompt Caching`,
        subtitle: t`Reuse repeated prompt prefixes across supported providers`,
        field: 'sb-config-prompt-caching-enabled',
        id: masterId,
        onChange: on => changeMaster(on),
    });
    const depth = createSpinRow({
        label: t`Caching at Depth`,
        subtitle: t`Higher values place Claude cache markers earlier in chat. Set to -1 to disable.`,
        field: 'sb-config-claude-caching-depth',
        id: 'sb-config-claude-caching-depth',
        min: -1,
        step: 1,
        value: DEFAULT_SETTINGS.claude.cachingAtDepth,
        onChange: value => changeDepth(value),
    });
    const extendedTtl = createSwitchRow({
        label: t`Extended Cache TTL`,
        subtitle: t`Extend Claude cache lifetime from five minutes to one hour. Cache writes cost more.`,
        field: 'sb-config-claude-extended-ttl',
        id: 'sb-config-claude-extended-ttl',
        onChange: checked => save({ claude: { extendedTTL: checked } }),
    });
    const adaptiveThinking = createSwitchRow({
        label: t`Adaptive Thinking`,
        subtitle: t`Let supported Claude models adjust thinking based on your reasoning effort`,
        field: 'sb-config-claude-adaptive-thinking',
        id: 'sb-config-claude-adaptive-thinking',
        onChange: checked => save({ claude: { enableAdaptiveThinking: checked } }),
    });
    const apiVersion = createEntryRow({
        label: t`API Version`,
        subtitle: t`Set the Google AI Studio API version. Leave blank to use v1beta.`,
        field: 'sb-config-gemini-api-version',
        id: 'sb-config-gemini-api-version',
        placeholder: DEFAULT_SETTINGS.gemini.apiVersion,
        floating: true,
        onChange: value => {
            const next = value.trim();
            if (next !== state.known.gemini.apiVersion) save({ gemini: { apiVersion: next } });
        },
    });
    const thoughtSignatures = createSwitchRow({
        label: t`Thought Signatures`,
        subtitle: t`Send saved thought signatures back to Gemini to preserve reasoning context`,
        field: 'sb-config-gemini-thought-signatures',
        id: 'sb-config-gemini-thought-signatures',
        onChange: checked => save({ gemini: { thoughtSignatures: checked } }),
    });

    // The captions keep the English text as their translation key, as the rest of the page does.
    for (const [row, key] of [
        [master.row, 'Reuse repeated prompt prefixes across supported providers'],
        [depth.row, 'Higher values place Claude cache markers earlier in chat. Set to -1 to disable.'],
        [extendedTtl.row, 'Extend Claude cache lifetime from five minutes to one hour. Cache writes cost more.'],
        [adaptiveThinking.row, 'Let supported Claude models adjust thinking based on your reasoning effort'],
        [apiVersion.row, 'Set the Google AI Studio API version. Leave blank to use v1beta.'],
        [thoughtSignatures.row, 'Send saved thought signatures back to Gemini to preserve reasoning context'],
    ]) {
        const caption = row.querySelector('.ds-row-subtitle');
        if (caption instanceof HTMLElement) caption.dataset.i18n = key;
    }

    for (const [row, sources] of [
        [adaptiveThinking.row, ROW_SOURCES.adaptiveThinking],
        [apiVersion.row, ROW_SOURCES.apiVersion],
        [thoughtSignatures.row, ROW_SOURCES.thoughtSignatures],
    ]) {
        row.dataset.source = sources;
    }

    const group = createGroup({ id: GROUP_ID, title: t`Prompt Caching` });
    group.section.dataset.sbRequestSet = '';
    group.body.dataset.sbEnabledBy = `#${masterId}`;
    // This module sets the sensitivity of the two rows, because an environment variable can hold one insensitive while the switch is on.
    depth.row.dataset.sbSensitivityOwned = '';
    extendedTtl.row.dataset.sbSensitivityOwned = '';
    group.body.append(master.row, depth.row, extendedTtl.row);

    const save = patch => queue.push(patch);
    const queue = createSaveQueue({
        send: patch => post(SAVE_ENDPOINT, { settings: patch }, transport),
        onSaved(reply, { queued }) {
            adopt(reply);
            // A reply that more changes follow would draw over what the user has just done.
            if (!queued) render();
        },
        onFailed(error) {
            render();
            notify(error.message, TOAST_TITLE);
        },
    });

    /** @param {any} reply */
    function adopt(reply) {
        state.known = normalizeSettings(reply?.settings);
        state.locks = describeLocks(reply?.envManaged);
    }

    function changeMaster(on) {
        const plan = planMasterChange({ on, depthShown: depth.getValue() ?? -1, rememberedDepth: state.rememberedDepth });
        state.rememberedDepth = plan.rememberedDepth;
        if (on) depth.setValue(plan.patch.claude.cachingAtDepth);
        syncSensitivity();
        save(plan.patch);
    }

    function changeDepth(value) {
        const whole = Math.round(value ?? DEFAULT_SETTINGS.claude.cachingAtDepth);
        if (whole !== value) depth.setValue(whole);
        save({ claude: { cachingAtDepth: whole } });
    }

    function syncSensitivity() {
        const on = master.getValue();
        master.setDisabled(state.locks.caching);
        depth.setDisabled(!on || state.locks.depth);
        extendedTtl.setDisabled(!on || state.locks.extendedTtl);
        adaptiveThinking.setDisabled(state.locks.adaptiveThinking);
        apiVersion.setDisabled(state.locks.apiVersion);
        thoughtSignatures.setDisabled(state.locks.thoughtSignatures);
    }

    function render() {
        const shown = describeControls(state.known, state.rememberedDepth);
        if (shown.caching) state.rememberedDepth = null;
        master.setValue(shown.caching);
        depth.setValue(shown.depth);
        extendedTtl.setValue(shown.extendedTtl);
        adaptiveThinking.setValue(shown.adaptiveThinking);
        apiVersion.setValue(shown.apiVersion);
        thoughtSignatures.setValue(shown.thoughtSignatures);
        syncSensitivity();
    }

    function applySourceVisibility() {
        const source = getSource();
        for (const row of [adaptiveThinking.row, apiVersion.row, thoughtSignatures.row]) {
            row.style.display = matchesSource(row.dataset.source ?? '', source) ? '' : 'none';
        }
    }

    /** Puts the rows where they belong, and leaves the ones that are already there untouched. @returns {boolean} Whether anything moved. */
    function place() {
        let moved = false;
        const insertAfter = (anchor, ...nodes) => {
            let previous = anchor;
            for (const node of nodes) {
                if (node.parentElement !== previous.parentElement || node.previousElementSibling !== previous) {
                    previous.after(node);
                    moved = true;
                }
                previous = node;
            }
        };
        const reasoning = directChild(body, '[data-sb-editor-field="openai_reasoning_effort"]');
        if (reasoning) insertAfter(reasoning, adaptiveThinking.row);
        else if (adaptiveThinking.row.parentElement !== body) { body.append(adaptiveThinking.row); moved = true; }
        const verbosity = directChild(body, '[data-sb-editor-field="openai_verbosity"]');
        if (verbosity) insertAfter(verbosity, apiVersion.row, thoughtSignatures.row);
        else for (const row of [apiVersion.row, thoughtSignatures.row]) {
            if (row.parentElement !== body) { body.append(row); moved = true; }
        }
        let anchor = request;
        for (const set of request.parentElement?.querySelectorAll(':scope > [data-sb-request-set]') ?? []) {
            if (set !== group.section && set instanceof HTMLElement) anchor = set;
        }
        insertAfter(anchor, group.section);
        applySourceVisibility();
        return moved;
    }

    /** Takes every row out of the page. @returns {boolean} Whether anything was in it. */
    function unplace() {
        const nodes = [adaptiveThinking.row, apiVersion.row, thoughtSignatures.row, group.section].filter(node => node.isConnected);
        for (const node of nodes) node.remove();
        return nodes.length > 0;
    }

    async function refresh() {
        // A save in flight ends with a reply that carries the settings, which is newer than a read that started before it.
        if (state.reading || queue.busy) return;
        state.reading = true;
        try {
            if (!await isAdmin()) {
                state.available = false;
                if (unplace()) onPlacementChange();
                return;
            }
            const reply = await post(GET_ENDPOINT, {}, transport);
            if (queue.busy) return;
            adopt(reply);
            state.available = true;
            render();
            if (place()) onPlacementChange();
        } catch (error) {
            state.available = false;
            if (unplace()) onPlacementChange();
            // A user who is not an admin is refused, which is how the server says that these settings are not theirs.
            if (/** @type {any} */ (error)?.status !== 403) {
                console.warn('[SillyBunny] Could not read the server config for Chat Completions:', error);
                if (!state.readFailureShown) {
                    state.readFailureShown = true;
                    notify(/** @type {Error} */ (error).message, TOAST_TITLE);
                }
            }
        } finally {
            state.reading = false;
        }
    }

    const onTabActivated = event => {
        const detail = /** @type {CustomEvent} */ (event).detail;
        if (detail?.shellKey === 'left' && detail?.tabId === 'prompting') void refresh();
    };
    document.addEventListener('sb:shell-tab-activated', onTabActivated);

    // The group and the rows are built but not in the page: the first successful read puts them there.
    if (isShown()) void refresh();

    return {
        group,
        rows: { master, depth, extendedTtl, adaptiveThinking, apiVersion, thoughtSignatures },
        state,
        refresh,
        applySourceVisibility,
        destroy() {
            document.removeEventListener('sb:shell-tab-activated', onTabActivated);
            unplace();
        },
    };
}
