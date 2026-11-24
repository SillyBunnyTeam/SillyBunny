/**
 * The conversation data module of this page: `createConversationData()` on the browser's `fetch`, the clock and the
 * page's reload, and the hooks that start it and write what it holds when the page is left.
 */

import { createConversationData } from './conversation-data.js';

const API_PREFIX = '/api/sillybunny-conversation';
// The browser keeps at most 64 KiB of request bodies alive for a page that is closing, so a body is sent with the flag
// only when it is well under that.
const KEEPALIVE_MAX_CHARACTERS = 60_000;
const RELOAD_FLAG = 'sb_conversation_reloaded_after_migration';
const TOAST_OPTIONS = Object.freeze({ escapeHtml: true });
const LEGACY_STORE_PARTS = ['characters', 'groups', 'reminders', 'legacyThreadPersonaAssignments'];

async function fetchJson(path, body, { keepalive = false } = {}) {
    // Loaded when the first request goes out, so that this module can be imported before the page's own modules are.
    const [{ getRequestHeaders }, { compressRequest }] = await Promise.all([import('../../script.js'), import('../request-compression.js')]);
    const text = JSON.stringify(body ?? {});
    const init = { method: 'POST', headers: getRequestHeaders(), body: text, cache: 'no-cache' };
    const request = keepalive && text.length < KEEPALIVE_MAX_CHARACTERS ? { ...init, keepalive: true } : await compressRequest(init);
    const response = await fetch(`${API_PREFIX}${path}`, request);
    const json = await response.json().catch(() => null);
    return { status: response.status, json };
}

// The page gives the module how to read its settings when the hooks are installed, so that this file imports nothing from the page.
let readModeObject = () => null;

/** Whether the settings that this page loaded still hold the old store, because the server moved it afterwards. */
function isSettingsStale() {
    const store = readModeObject();
    if (!store || typeof store !== 'object') {
        return false;
    }
    const hasOldParts = LEGACY_STORE_PARTS.some((part) => {
        const value = store[part];
        return Array.isArray(value) ? value.length > 0 : Boolean(value) && typeof value === 'object' && Object.keys(value).length > 0;
    });
    return hasOldParts || Number(store.version) < 2;
}

/** Reloads the page, once per tab session, so that a cause that the reload cannot fix does not loop. */
export function reloadPageOnce(flag = RELOAD_FLAG) {
    try {
        if (sessionStorage.getItem(flag)) {
            return;
        }
        sessionStorage.setItem(flag, '1');
    } catch {
        return;
    }
    window.location.reload();
}

export const conversationData = createConversationData({
    fetchJson,
    now: () => Date.now(),
    setTimer: (callback, delay) => setTimeout(callback, delay),
    clearTimer: handle => clearTimeout(handle),
    random: () => Math.random().toString(36).slice(2, 8).padEnd(6, '0'),
    isSettingsStale,
    reloadPage: () => reloadPageOnce(),
});

function showDataEvent(event) {
    const toastr = globalThis.toastr;
    if (!toastr) {
        return;
    }
    if (event.type === 'status' && event.status.state === 'failed') {
        // TODO(copy): the body of this alert is a placeholder.
        toastr.error('TODO(copy)', 'Conversations are not available', { ...TOAST_OPTIONS, preventDuplicates: true, timeOut: 0, extendedTimeOut: 0 });
    } else if (event.type === 'error') {
        toastr.error('TODO(copy)', 'A conversation change was not saved', { ...TOAST_OPTIONS, preventDuplicates: true });
    } else if (event.type === 'conflict' && (event.lostEdits > 0 || event.lostDeletes > 0)) {
        toastr.warning('TODO(copy)', 'The chat changed elsewhere', { ...TOAST_OPTIONS, preventDuplicates: true });
    }
}

let hooksInstalled = false;

/**
 * Starts the module when the settings are loaded and writes what waits when the page goes away. Runs once.
 * @param {{ eventSource: { on: Function }, settingsLoaded: string, getModeObject: () => any }} page
 * `getModeObject` returns the mode's object in `settings.json`.
 */
export function installConversationDataHooks({ eventSource, settingsLoaded, getModeObject }) {
    if (hooksInstalled || typeof window === 'undefined') {
        return;
    }
    hooksInstalled = true;
    readModeObject = getModeObject;
    eventSource.on(settingsLoaded, () => {
        void conversationData.start();
    });
    conversationData.subscribe(showDataEvent);
    const flushForLeaving = () => {
        void conversationData.flush({ keepalive: true });
    };
    window.addEventListener('pagehide', flushForLeaving);
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') {
            flushForLeaving();
        }
    });
    window.addEventListener('beforeunload', (event) => {
        if (conversationData.hasPendingWrites()) {
            event.preventDefault();
            event.returnValue = true;
        }
    });
}
