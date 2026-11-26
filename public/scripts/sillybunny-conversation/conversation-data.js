/**
 * The conversations of one user, as the browser holds them: a cache of the list, the chats that are loaded, and the
 * queues that write both back to `/api/sillybunny-conversation/`.
 *
 * Readers get the cache synchronously. A chat is loaded once, when it is opened (`loadChat`), and stays until the
 * cache needs room. Writers change the cache first and the server after: `patchConversation` merges what changes
 * often into one request, and `commitChat` saves the whole chat at once, one request at a time per chat. The module
 * imports nothing from the page; everything it needs from the browser comes in through the adapter, so that tests
 * run it on a fake clock and the real routes.
 *
 * @typedef {{ conversationId: string, chatId: string }} ChatAddress
 * @typedef {{ address: ChatAddress, header: Record<string, any>, messages: Record<string, any>[] }} LoadedChat
 * @typedef {object} DataAdapter
 * @property {(path: string, body: object, options?: { keepalive?: boolean }) => Promise<{ status: number, json: any }>} fetchJson
 * POST to a route under `/api/sillybunny-conversation`. Resolves for every HTTP status; rejects for a network failure.
 * @property {() => number} now
 * @property {(callback: () => void, delay: number) => any} setTimer
 * @property {(handle: any) => void} clearTimer
 * @property {() => string} random Six characters of `[a-z0-9]` for a new chat id.
 * @property {() => boolean} isSettingsStale Whether the settings that the page loaded still hold the old store.
 * @property {() => void} reloadPage Reloads the page, at most once for this cause.
 * @property {(path: string, body: object) => Promise<{ status: number, text: string, fileName: string }>} [fetchText]
 * POST to a route that answers a file instead of JSON. `text` holds the JSON of the error for a status other than 200.
 * Only `exportChat` needs it.
 */

import { rebaseChat, describeSyncedMessages } from './conversation-data-merge.js';
import { createSerialQueue } from './conversation-data-queue.js';
import { isPendingServerReply } from './pending-reply.js';
import { getReminderState } from './reminders.js';
import { summarizeChat } from './conversation-summary.js';

export const CHAT_STATE_FIELDS = Object.freeze(['readThrough', 'lastActivity', 'followupCount', 'lastAutoMessageAt', 'sessionMarkers']);
const SUMMARY_FIELDS = Object.freeze(['messageCount', 'lastMessageAt', 'preview', 'unread', 'lastMessageRole', 'hasUserMessage']);
const EMPTY_SUMMARY = Object.freeze({ messageCount: 0, lastMessageAt: 0, preview: '', unread: 0, lastMessageRole: '', hasUserMessage: false });

export const FREQUENT_DELAY_MS = 400;
export const FREQUENT_MAX_WAIT_MS = 3000;
export const RETRY_DELAYS_MS = Object.freeze([2000, 5000, 15000]);
export const MAX_LOADED_CHATS = 8;
const MAX_RELOAD_ATTEMPTS = 3;
const MIGRATION_RETRY_FALLBACK_MS = 60_000;

export class ChatNotLoadedError extends Error {
    constructor(address) {
        super(`The chat ${address?.conversationId}/${address?.chatId} is not loaded.`);
        this.name = 'ChatNotLoadedError';
        this.address = address;
    }
}

/** `code` is the error code of the route (`not_found`, `integrity`, `destructive`, `migration_failed`...), or `network`. */
export class ConversationDataError extends Error {
    constructor(code, message, { status = 0, details = null } = {}) {
        super(message || code);
        this.name = 'ConversationDataError';
        this.code = code;
        this.status = status;
        this.details = details;
    }
}

const keyOf = address => `${address.conversationId}/${address.chatId}`;

function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function replaceContents(target, source) {
    for (const key of Object.keys(target)) {
        if (!Object.hasOwn(source, key)) {
            delete target[key];
        }
    }
    Object.assign(target, source);
    return target;
}

function pickSummary(entry) {
    return Object.fromEntries(SUMMARY_FIELDS.map(field => [field, entry?.[field] ?? EMPTY_SUMMARY[field]]));
}

function blankHeader() {
    return { chat_metadata: {}, user_name: 'unused', character_name: 'unused' };
}

/**
 * Merges a newer patch into an older one that was not sent yet. A scalar or an array of the newer patch replaces; the
 * settings and the chat states merge field by field.
 */
export function mergePatches(older, newer) {
    const merged = { ...older };
    for (const [key, value] of Object.entries(newer)) {
        if (key === 'settings' && isObject(value)) {
            merged.settings = { ...older.settings, ...value };
        } else if (key === 'chats' && isObject(value)) {
            merged.chats = { ...older.chats };
            for (const [chatId, state] of Object.entries(value)) {
                merged.chats[chatId] = { ...merged.chats[chatId], ...state };
            }
        } else {
            merged[key] = value;
        }
    }
    return merged;
}

/**
 * What is left of an older patch after the fields that later patches write: a field that both name keeps the later value.
 * A field is a top-level key, a key of `settings`, or one field of one chat in `chats`, as `mergePatches()` merges them.
 * A patch that is sent again after a failure is cut down with this, so that it cannot undo an edit that was sent after it.
 * @param {object} patch
 * @param {object[]} laterPatches
 * @returns {object} A new patch, empty when nothing is left.
 */
export function withoutFieldsOf(patch, laterPatches) {
    const result = {};
    for (const [key, value] of Object.entries(patch)) {
        if (key === 'settings' && isObject(value)) {
            const rest = Object.fromEntries(Object.entries(value).filter(([name]) => !laterPatches.some(later => isObject(later.settings) && Object.hasOwn(later.settings, name))));
            if (Object.keys(rest).length) {
                result.settings = rest;
            }
        } else if (key === 'chats' && isObject(value)) {
            const chats = {};
            for (const [chatId, state] of Object.entries(value)) {
                const rest = Object.fromEntries(Object.entries(state).filter(([field]) => !laterPatches.some(later => isObject(later.chats?.[chatId]) && Object.hasOwn(later.chats[chatId], field))));
                if (Object.keys(rest).length) {
                    chats[chatId] = rest;
                }
            }
            if (Object.keys(chats).length) {
                result.chats = chats;
            }
        } else if (!laterPatches.some(later => Object.hasOwn(later, key))) {
            result[key] = value;
        }
    }
    return result;
}

function isFrequentOnly(patch) {
    return Object.keys(patch).every(key => key === 'chats')
        && Object.values(patch.chats ?? {}).every(state => Object.keys(state).every(field => CHAT_STATE_FIELDS.includes(field)));
}

/**
 * @param {DataAdapter} adapter
 */
export function createConversationData(adapter) {
    /** @type {Map<string, Record<string, any>>} */
    const views = new Map();
    /** @type {Map<string, any>} */
    const sessions = new Map();
    /** @type {Map<string, { patch: object, firstAt: number, timer: any }>} */
    const pendingPatches = new Map();
    /**
     * The patches of a conversation that left `pendingPatches` for the network, oldest first, until the server has answered
     * each of them (`confirmed`) or the module gave it up. A server answer describes the conversation as it was after the
     * patches up to the one it answers, so every read of the server puts these (and the pending patch) over what it read:
     * an edit that is newer than the answer is never undone by it. An answered patch stays while an older one is still out,
     * so that the older one is not applied over it.
     * @type {Map<string, { patch: object, confirmed: boolean, attempt: number, timer: any }[]>}
     */
    const sentPatches = new Map();
    /** @type {Map<string, ReturnType<typeof createSerialQueue>>} */
    const conversationQueues = new Map();
    const characterQueue = createSerialQueue();
    /** @type {Map<string, { patch: object, scheduled: boolean }>} */
    const pendingCharacters = new Map();
    let characterState = { version: 1, characters: {} };
    const listeners = new Set();
    const removalListeners = new Set();
    const chatReadListeners = new Set();
    const loadListeners = new Set();
    const queuedEvents = new Map();
    let eventScheduled = false;
    let status = { state: 'idle', code: '', retryAt: 0 };
    let startPromise = null;
    let readyPromise = null;
    let resolveReady = null;
    let retryTimer = null;
    let openKey = '';
    let useCounter = 0;

    // ------------------------------------------------------------------------------------------------------------
    // Events

    function emit(type, detail = {}) {
        queuedEvents.set(type === 'error' || type === 'conflict' ? `${type}:${queuedEvents.size}` : type, { type, ...detail });
        if (eventScheduled) {
            return;
        }
        eventScheduled = true;
        queueMicrotask(() => {
            eventScheduled = false;
            const events = [...queuedEvents.values()];
            queuedEvents.clear();
            for (const event of events) {
                for (const listener of [...listeners]) {
                    try {
                        listener(event);
                    } catch (error) {
                        console.error('Conversation data listener failed:', error);
                    }
                }
            }
        });
    }

    function subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
    }

    function reportError(code, message, detail = {}) {
        emit('error', { code, message, ...detail });
    }

    /**
     * Listeners run at once, not at the end of the tick, because what they cancel (a reply in progress, a queued reply)
     * must stop before the target is gone. A conversation or a chat is announced as soon as the module knows that it
     * goes, which can be before the server has answered, and again when it leaves the cache, so a listener has to
     * accept the same target twice.
     * @param {(target: { conversationId: string, chatId?: string }) => void} listener `chatId` is missing when the whole conversation goes.
     */
    function onRemoval(listener) {
        removalListeners.add(listener);
        return () => removalListeners.delete(listener);
    }

    function announceRemoval(target) {
        for (const listener of [...removalListeners]) {
            try {
                listener(target);
            } catch (error) {
                console.error('Conversation data removal listener failed:', error);
            }
        }
    }

    /**
     * Listeners run at once, not at the end of the tick, each time the messages of a chat were read from the server
     * (a load, a reload, a merge after a conflict). The `chat` events cannot say this: they are merged by type within a
     * tick, and the one of a local change can replace the one of a load. What the server wrote into a chat that the
     * page did not write, such as a pending reply, is found through this.
     * @param {(address: ChatAddress) => void} listener
     */
    function onChatRead(listener) {
        chatReadListeners.add(listener);
        return () => chatReadListeners.delete(listener);
    }

    function announceChatRead(address) {
        for (const listener of [...chatReadListeners]) {
            try {
                listener(address);
            } catch (error) {
                console.error('Conversation data chat listener failed:', error);
            }
        }
    }

    /**
     * Listeners run at once, each time the list and the state of the characters were read from the server (the start, a
     * refresh, the read after a group was converted). What else the server changed with it, such as the folders that a
     * conversion moved, is read again through this.
     * @param {() => void} listener
     */
    function onLoad(listener) {
        loadListeners.add(listener);
        return () => loadListeners.delete(listener);
    }

    function announceLoad() {
        for (const listener of [...loadListeners]) {
            try {
                listener();
            } catch (error) {
                console.error('Conversation data load listener failed:', error);
            }
        }
    }

    // ------------------------------------------------------------------------------------------------------------
    // Requests

    async function request(path, body, options) {
        let answer;
        try {
            answer = await adapter.fetchJson(path, body, options);
        } catch (error) {
            throw new ConversationDataError('network', error?.message ?? 'The request failed.', { details: error });
        }
        return answer;
    }

    function failureOf(answer) {
        return new ConversationDataError(answer.json?.error ?? `http_${answer.status}`, answer.json?.message ?? answer.json?.error ?? `HTTP ${answer.status}`, { status: answer.status, details: answer.json });
    }

    async function requestOk(path, body, options) {
        const answer = await request(path, body, options);
        if (answer.status !== 200) {
            throw failureOf(answer);
        }
        return answer.json;
    }

    function queueOf(conversationId) {
        let queue = conversationQueues.get(conversationId);
        if (!queue) {
            queue = createSerialQueue();
            conversationQueues.set(conversationId, queue);
        }
        return queue;
    }

    // ------------------------------------------------------------------------------------------------------------
    // The cache of conversations

    function recomputeAggregates(view) {
        const chats = view.chats ?? [];
        const latest = chats.reduce((best, entry) => ((entry.lastMessageAt ?? 0) > (best.lastMessageAt ?? 0) ? entry : best), { lastMessageAt: 0, preview: '', lastMessageRole: '' });
        view.messageCount = chats.reduce((sum, entry) => sum + (entry.messageCount ?? 0), 0);
        view.unread = chats.reduce((sum, entry) => sum + (entry.unread ?? 0), 0);
        view.lastMessageAt = latest.lastMessageAt ?? 0;
        view.preview = latest.preview ?? '';
        view.lastMessageRole = latest.lastMessageRole ?? '';
        view.hasUserMessage = chats.some(entry => entry.hasUserMessage);
    }

    function refreshEntrySummary(view, entry) {
        const session = sessions.get(keyOf({ conversationId: view.id, chatId: entry.id }));
        if (session?.chat) {
            Object.assign(entry, summarizeChat(session.chat.messages, entry.readThrough ?? ''));
        }
    }

    /**
     * Takes a conversation as the server sends it into the cache, keeping the view object that readers hold. The list
     * carries the summary of every chat; the other routes answer without one, and the chat then keeps the summary it had.
     */
    function ingestConversation(conversation, { withSummaries = false } = {}) {
        const existing = views.get(conversation.id);
        const chats = (conversation.chats ?? []).map((entry) => {
            const previous = existing?.chats?.find(item => item.id === entry.id);
            return { ...entry, ...pickSummary(withSummaries ? entry : previous) };
        });
        const next = { ...conversation, chats, reminders: conversation.reminders ?? [], settings: conversation.settings ?? {} };
        for (const gone of (existing?.chats ?? []).filter(old => !chats.some(entry => entry.id === old.id))) {
            announceRemoval({ conversationId: conversation.id, chatId: gone.id });
        }
        const view = existing ? replaceContents(existing, next) : next;
        if (!existing) {
            views.set(view.id, view);
        }
        for (const entry of view.chats) {
            refreshEntrySummary(view, entry);
        }
        recomputeAggregates(view);
        // What the server has not answered yet is newer than what it sent, so it goes over it, oldest first.
        for (const sent of sentPatches.get(view.id) ?? []) {
            applyPatchLocal(view, sent.patch);
        }
        const pending = pendingPatches.get(view.id);
        if (pending) {
            applyPatchLocal(view, pending.patch);
        }
        return view;
    }

    function ingestList(conversations) {
        const seen = new Set();
        for (const conversation of conversations) {
            seen.add(conversation.id);
            ingestConversation(conversation, { withSummaries: true });
        }
        for (const id of [...views.keys()]) {
            if (!seen.has(id)) {
                dropConversation(id);
            }
        }
    }

    function dropConversation(id) {
        const view = views.get(id);
        announceRemoval({ conversationId: id });
        for (const chat of view?.chats ?? []) {
            const key = keyOf({ conversationId: id, chatId: chat.id });
            const session = sessions.get(key);
            if (session) {
                session.dropped = true;
                adapter.clearTimer(session.retryTimer);
                sessions.delete(key);
            }
        }
        for (const [key, session] of [...sessions]) {
            if (session.address.conversationId === id) {
                session.dropped = true;
                sessions.delete(key);
            }
        }
        const pending = pendingPatches.get(id);
        if (pending) {
            adapter.clearTimer(pending.timer);
            pendingPatches.delete(id);
        }
        for (const sent of sentPatches.get(id) ?? []) {
            adapter.clearTimer(sent.timer);
        }
        sentPatches.delete(id);
        conversationQueues.delete(id);
        views.delete(id);
    }

    // ------------------------------------------------------------------------------------------------------------
    // Reads

    /** The conversations, newest message first. The objects are the cache's own: read them, change them through the module. */
    function list({ personaId } = {}) {
        return [...views.values()]
            .filter(view => personaId === undefined || view.personaId === personaId)
            .sort((left, right) => right.lastMessageAt - left.lastMessageAt || right.createdAt - left.createdAt || String(left.id).localeCompare(String(right.id)));
    }

    function get(id) {
        return views.get(id) ?? null;
    }

    function findDirect(personaId, avatar) {
        for (const view of views.values()) {
            if (view.kind === 'direct' && view.personaId === personaId && view.characters[0] === avatar) {
                return view;
            }
        }
        return null;
    }

    /** Names the chat that a call in the old form (an avatar, a group id and a persona) means. */
    function resolve({ avatar = '', groupId = '', personaId = '', chatId = '' } = {}) {
        const view = groupId
            ? [...views.values()].find(item => item.id === groupId && item.kind === 'group') ?? null
            : findDirect(personaId, avatar);
        if (!view) {
            return null;
        }
        const resolvedChat = chatId && view.chats.some(entry => entry.id === chatId) ? chatId : view.activeChatId;
        return resolvedChat ? { conversationId: view.id, chatId: resolvedChat } : null;
    }

    function chat(address) {
        const session = address ? sessions.get(keyOf(address)) : null;
        if (!session?.chat) {
            return null;
        }
        session.lastUsed = ++useCounter;
        return session.chat;
    }

    function totalUnread(personaId, include = () => true) {
        let total = 0;
        for (const view of views.values()) {
            if (view.personaId === personaId && include(view)) {
                total += view.unread ?? 0;
            }
        }
        return total;
    }

    function getCharacterState(avatar) {
        return characterState.characters[avatar] ?? {};
    }

    // ------------------------------------------------------------------------------------------------------------
    // Metadata: patches of a conversation

    function applyPatchLocal(view, patch) {
        if (patch.name !== undefined) {
            view.name = patch.name;
        }
        if (patch.description !== undefined) {
            view.description = patch.description;
        }
        if (patch.favorite !== undefined) {
            view.favorite = patch.favorite;
        }
        if (patch.activeChatId !== undefined && view.chats.some(entry => entry.id === patch.activeChatId)) {
            view.activeChatId = patch.activeChatId;
        }
        if (patch.characters !== undefined) {
            view.characters = [...patch.characters];
        }
        if (patch.extras !== undefined) {
            view.extras = [...patch.extras];
        }
        if (patch.reminders !== undefined) {
            view.reminders = structuredClone(patch.reminders);
        }
        if (patch.settings !== undefined) {
            const settings = { ...view.settings };
            for (const [key, value] of Object.entries(patch.settings)) {
                if (value === null) {
                    delete settings[key];
                } else {
                    settings[key] = value;
                }
            }
            view.settings = settings;
        }
        if (patch.chats !== undefined) {
            for (const [chatId, state] of Object.entries(patch.chats)) {
                const entry = view.chats.find(item => item.id === chatId);
                if (!entry) {
                    continue;
                }
                Object.assign(entry, structuredClone(state));
                if (state.readThrough !== undefined) {
                    refreshEntrySummary(view, entry);
                }
            }
            recomputeAggregates(view);
        }
    }

    function sameValue(left, right) {
        return JSON.stringify(left) === JSON.stringify(right);
    }

    /** Drops the parts of a patch that the view already has, so that a repeated call sends nothing. */
    function withoutNoOps(view, patch) {
        const result = {};
        for (const [key, value] of Object.entries(patch)) {
            if (key === 'settings') {
                const changed = Object.fromEntries(Object.entries(value).filter(([name, item]) => (item === null ? Object.hasOwn(view.settings, name) : !sameValue(view.settings[name], item))));
                if (Object.keys(changed).length) {
                    result.settings = changed;
                }
            } else if (key === 'chats') {
                const chats = {};
                for (const [chatId, state] of Object.entries(value)) {
                    const entry = view.chats.find(item => item.id === chatId);
                    const changed = Object.fromEntries(Object.entries(state).filter(([field, item]) => !entry || !sameValue(entry[field], item)));
                    if (Object.keys(changed).length) {
                        chats[chatId] = changed;
                    }
                }
                if (Object.keys(chats).length) {
                    result.chats = chats;
                }
            } else if (!sameValue(view[key], value)) {
                result[key] = value;
            }
        }
        return result;
    }

    function patchConversation(id, patch) {
        const view = views.get(id);
        if (!view || !isObject(patch)) {
            return false;
        }
        const effective = withoutNoOps(view, patch);
        if (!Object.keys(effective).length) {
            return true;
        }
        applyPatchLocal(view, effective);
        const pending = pendingPatches.get(id);
        const merged = pending ? mergePatches(pending.patch, effective) : effective;
        const firstAt = pending?.firstAt ?? adapter.now();
        if (pending) {
            adapter.clearTimer(pending.timer);
        }
        const delay = isFrequentOnly(merged)
            ? Math.max(0, Math.min(FREQUENT_DELAY_MS, firstAt + FREQUENT_MAX_WAIT_MS - adapter.now()))
            : 0;
        const timer = adapter.setTimer(() => {
            void flushConversation(id);
        }, delay);
        pendingPatches.set(id, { patch: merged, firstAt, timer });
        emit('list', { id });
        return true;
    }

    // ------------------------------------------------------------------------------------------------------------
    // Reminders of a conversation: the list that the details page shows, and what the worker writes while it delivers one

    /**
     * @param {string} id The conversation.
     * @param {{ state?: 'scheduled'|'delivered'|'invalid'|'given-up' }} [filter]
     * @returns {Record<string, any>[]} Copies of the reminders by time, each with its `state`. A change to a copy is not saved.
     */
    function reminders(id, { state } = {}) {
        const view = views.get(id);
        if (!view) {
            return [];
        }
        return view.reminders
            .map(reminder => ({ ...structuredClone(reminder), state: getReminderState(reminder) }))
            .filter(reminder => !state || reminder.state === state)
            .sort((first, second) => first.triggerAt - second.triggerAt);
    }

    /** Removes a reminder, whatever its state. @returns {boolean} False when the conversation or the reminder is not there. */
    function cancelReminder(id, reminderId) {
        const view = views.get(id);
        if (!view?.reminders.some(reminder => reminder.id === reminderId)) {
            return false;
        }
        return patchConversation(id, { reminders: view.reminders.filter(reminder => reminder.id !== reminderId) });
    }

    /**
     * Changes fields of one reminder. A field given as null is removed. It reads the reminder when it is called, so a
     * worker that holds an older copy does not undo a reminder that was added or cancelled in the meantime.
     * @returns {boolean} False when the conversation or the reminder is not there.
     */
    function patchReminder(id, reminderId, change) {
        const view = views.get(id);
        const current = view?.reminders.find(reminder => reminder.id === reminderId);
        if (!current) {
            return false;
        }
        const next = { ...current };
        for (const [key, value] of Object.entries(change)) {
            if (value === null) {
                delete next[key];
            } else {
                next[key] = value;
            }
        }
        return patchConversation(id, { reminders: view.reminders.map(reminder => (reminder.id === reminderId ? next : reminder)) });
    }

    async function flushConversation(id, options) {
        const pending = pendingPatches.get(id);
        if (!pending) {
            return;
        }
        adapter.clearTimer(pending.timer);
        pendingPatches.delete(id);
        const sent = { patch: pending.patch, confirmed: false, attempt: 0, timer: null };
        let list = sentPatches.get(id);
        if (!list) {
            list = [];
            sentPatches.set(id, list);
        }
        list.push(sent);
        await queueOf(id).run(() => sendPatch(id, sent, options));
    }

    /** Drops answered patches from the front of the list: they were kept only to stay over an older patch that was still out. */
    function trimSent(id) {
        const list = sentPatches.get(id);
        while (list?.length && list[0].confirmed) {
            list.shift();
        }
        if (list && !list.length) {
            sentPatches.delete(id);
        }
    }

    /** The server answered the patch: its answer already holds it. */
    function confirmSent(id, sent) {
        sent.confirmed = true;
        adapter.clearTimer(sent.timer);
        sent.timer = null;
        trimSent(id);
    }

    /** The patch is given up (refused, or not sent after every attempt): what is read from the server no longer has it over it. */
    function forgetSent(id, sent) {
        adapter.clearTimer(sent.timer);
        sent.timer = null;
        const list = sentPatches.get(id);
        const index = list?.indexOf(sent) ?? -1;
        if (index >= 0) {
            list.splice(index, 1);
        }
        trimSent(id);
    }

    async function sendPatch(id, sent, options) {
        const view = views.get(id);
        if (!view) {
            forgetSent(id, sent);
            return;
        }
        let patch = sent.patch;
        if (sent.attempt > 0) {
            // The patches behind this one were sent while it waited, and they win over it: it would undo them on the server.
            const list = sentPatches.get(id) ?? [];
            const later = [...list.slice(list.indexOf(sent) + 1).map(item => item.patch), ...(pendingPatches.has(id) ? [pendingPatches.get(id).patch] : [])];
            patch = withoutFieldsOf(sent.patch, later);
            if (!Object.keys(patch).length) {
                confirmSent(id, sent);
                return;
            }
        }
        let answer;
        try {
            answer = await request('/update', { id, patch }, options);
        } catch (error) {
            retryPatch(id, sent, error);
            return;
        }
        if (answer.status === 200) {
            confirmSent(id, sent);
            const server = answer.json.conversation;
            if (views.has(id) && server) {
                ingestConversation(server);
                emit('list', { id });
            }
            return;
        }
        if (answer.status >= 500) {
            retryPatch(id, sent, failureOf(answer));
            return;
        }
        if (answer.status === 404) {
            dropConversation(id);
            emit('list', { id });
            reportError('not_found', 'The conversation no longer exists.', { id });
            return;
        }
        forgetSent(id, sent);
        reportError(answer.json?.error ?? 'update_rejected', 'A change to a conversation was refused.', { id, status: answer.status });
        await refresh();
    }

    /**
     * Sends a patch again after a delay. The wait does not hold the queue, because a task of the queue that waited for its
     * own retry would wait for itself: the patches behind it go on, and `sendPatch()` cuts out of the retry what they wrote.
     * The patch stays applied to the cache while it waits.
     */
    function retryPatch(id, sent, error) {
        const delay = RETRY_DELAYS_MS[sent.attempt];
        if (delay === undefined || !views.has(id)) {
            forgetSent(id, sent);
            reportError(error.code ?? 'network', 'A change to a conversation could not be saved.', { id });
            return;
        }
        sent.attempt++;
        sent.timer = adapter.setTimer(() => {
            sent.timer = null;
            void queueOf(id).run(() => sendPatch(id, sent));
        }, delay);
    }

    // ------------------------------------------------------------------------------------------------------------
    // Characters (routine and status override)

    function applyCharacterPatchLocal(avatar, patch) {
        const current = characterState.characters[avatar] ?? {};
        const next = { ...current };
        if (patch.routine === null) {
            delete next.routine;
        } else if (patch.routine !== undefined) {
            next.routine = { ...current.routine, ...patch.routine };
        }
        if (patch.statusOverride === null) {
            delete next.statusOverride;
        } else if (patch.statusOverride !== undefined) {
            next.statusOverride = patch.statusOverride;
        }
        characterState = { ...characterState, characters: { ...characterState.characters, [avatar]: next } };
        if (!Object.keys(next).length) {
            delete characterState.characters[avatar];
        }
    }

    function patchCharacter(avatar, patch) {
        if (!avatar || !isObject(patch)) {
            return false;
        }
        applyCharacterPatchLocal(avatar, patch);
        const pending = pendingCharacters.get(avatar);
        pendingCharacters.set(avatar, { patch: pending ? { ...pending.patch, ...patch, ...(patch.routine && pending.patch.routine ? { routine: { ...pending.patch.routine, ...patch.routine } } : {}) } : patch, scheduled: pending?.scheduled ?? false });
        if (!pendingCharacters.get(avatar).scheduled) {
            pendingCharacters.get(avatar).scheduled = true;
            adapter.setTimer(() => {
                void flushCharacter(avatar);
            }, 0);
        }
        emit('characters', { avatar });
        return true;
    }

    async function flushCharacter(avatar, options) {
        const pending = pendingCharacters.get(avatar);
        if (!pending) {
            return;
        }
        pendingCharacters.delete(avatar);
        await characterQueue.run(async () => {
            try {
                await requestOk('/characters/update', { avatar, patch: pending.patch }, options);
            } catch (error) {
                reportError(error.code, 'The state of a character could not be saved.', { avatar });
                await refresh();
            }
        });
    }

    // ------------------------------------------------------------------------------------------------------------
    // Chats: load, commit, save

    function newSession(address, records) {
        const [chatHeader, ...messages] = records;
        return {
            address,
            chat: { address, header: chatHeader ?? blankHeader(), messages },
            synced: describeSyncedMessages(messages),
            dirty: false,
            version: 0,
            shrink: false,
            saving: false,
            dropped: false,
            failed: '',
            lastUsed: ++useCounter,
            created: null,
            retryTimer: null,
            retries: 0,
        };
    }

    function attachSession(session) {
        sessions.set(keyOf(session.address), session);
        const view = views.get(session.address.conversationId);
        const entry = view?.chats.find(item => item.id === session.address.chatId);
        if (view && entry) {
            refreshEntrySummary(view, entry);
            recomputeAggregates(view);
        }
        evict();
    }

    function evict() {
        const loaded = [...sessions.values()].filter(session => session.chat && !session.dirty && !session.saving && !session.created && !session.failed && keyOf(session.address) !== openKey);
        const overflow = loaded.length - MAX_LOADED_CHATS;
        if (overflow <= 0) {
            return;
        }
        for (const session of loaded.sort((left, right) => left.lastUsed - right.lastUsed).slice(0, overflow)) {
            sessions.delete(keyOf(session.address));
        }
    }

    async function loadChat(address) {
        const key = keyOf(address);
        const existing = sessions.get(key);
        if (existing?.chat) {
            existing.lastUsed = ++useCounter;
            return existing.chat;
        }
        if (existing?.loading) {
            return existing.loading;
        }
        const loading = (async () => {
            const json = await requestOk('/chat/get', { id: address.conversationId, chatId: address.chatId });
            const session = newSession(address, json.chat);
            sessions.delete(key);
            attachSession(session);
            announceChatRead(address);
            emit('chat', { address });
            emit('list', { id: address.conversationId });
            return session.chat;
        })();
        sessions.set(key, { address, loading, chat: null });
        try {
            return await loading;
        } catch (error) {
            sessions.delete(key);
            throw error;
        }
    }

    function setOpen(address) {
        openKey = address ? keyOf(address) : '';
    }

    function commitChat(address, edit, { shrink = false } = {}) {
        const session = sessions.get(keyOf(address));
        if (!session?.chat) {
            throw new ChatNotLoadedError(address);
        }
        session.lastUsed = ++useCounter;
        try {
            edit(session.chat);
        } finally {
            markDirty(session, { shrink });
        }
        return session.chat;
    }

    function markDirty(session, { shrink = false } = {}) {
        session.dirty = true;
        session.version++;
        session.failed = '';
        session.shrink = session.shrink || shrink;
        const view = views.get(session.address.conversationId);
        const entry = view?.chats.find(item => item.id === session.address.chatId);
        if (view && entry) {
            refreshEntrySummary(view, entry);
            recomputeAggregates(view);
        }
        // `local` says that the caller made the change itself, so it renders what it changed and a listener need not.
        emit('chat', { address: session.address, local: true });
        emit('list', { id: session.address.conversationId });
        queueMicrotask(() => {
            void saveSession(session);
        });
    }

    function saveSession(session, options) {
        if (session.saving || !session.dirty || session.dropped || session.failed) {
            return session.savePromise ?? Promise.resolve();
        }
        session.saving = true;
        session.savePromise = (async () => {
            try {
                if (session.created) {
                    await session.created;
                }
                while (session.dirty && !session.dropped) {
                    const outcome = await saveOnce(session, options);
                    if (outcome !== 'saved') {
                        break;
                    }
                }
            } finally {
                session.saving = false;
            }
        })();
        return session.savePromise;
    }

    async function saveOnce(session, options) {
        const { conversationId, chatId } = session.address;
        session.dirty = false;
        const allowShrink = session.shrink;
        session.shrink = false;
        const sent = session.chat.messages.slice();
        options ??= session.pendingOptions;
        session.pendingOptions = undefined;
        const body = { id: conversationId, chatId, chat: [session.chat.header, ...sent] };
        if (allowShrink) {
            body.allowShrink = true;
        }
        let answer;
        try {
            answer = await request('/chat/save', body, options);
        } catch (error) {
            return scheduleRetry(session, allowShrink, error);
        }
        if (session.dropped) {
            return 'dropped';
        }
        if (answer.status === 200) {
            session.chat.header.chat_metadata ??= {};
            session.chat.header.chat_metadata.integrity = answer.json.integrity;
            session.synced = describeSyncedMessages(sent);
            session.retries = 0;
            emit('saved', { address: session.address });
            return 'saved';
        }
        if (answer.status === 409 && answer.json?.error === 'integrity') {
            return rebaseSession(session, allowShrink);
        }
        if (answer.status === 409 && answer.json?.error === 'destructive') {
            session.failed = 'destructive';
            reportError('destructive', 'The save would have removed most of the chat, so the file was left unchanged.', { address: session.address });
            await discardLocalChat(session);
            return 'failed';
        }
        if (answer.status === 404) {
            session.failed = 'not_found';
            reportError('not_found', 'The chat no longer exists.', { address: session.address });
            await refresh();
            return 'failed';
        }
        if (answer.status >= 500) {
            return scheduleRetry(session, allowShrink, failureOf(answer));
        }
        // The server refused the chat itself. It stays here, unsaved, until the next change tries again.
        session.failed = answer.json?.error ?? `http_${answer.status}`;
        session.dirty = true;
        session.shrink = session.shrink || allowShrink;
        reportError(session.failed, 'The chat could not be saved.', { address: session.address, status: answer.status });
        return 'failed';
    }

    function scheduleRetry(session, allowShrink, error) {
        session.dirty = true;
        session.shrink = session.shrink || allowShrink;
        const delay = RETRY_DELAYS_MS[session.retries];
        if (delay === undefined) {
            reportError(error.code ?? 'network', 'The chat could not be saved. It stays on this page until the next change.', { address: session.address });
            return 'failed';
        }
        session.retries++;
        session.retryTimer = adapter.setTimer(() => {
            session.retryTimer = null;
            void saveSession(session);
        }, delay);
        return 'retry';
    }

    /**
     * Puts the server's copy of a chat into the session and keeps what only this page wrote: the messages that the
     * server does not have and that were not on it at the last load or save. The session is dirty afterwards when it
     * kept any, so that its next save sends them.
     */
    function adoptServerRecords(session, serverRecords) {
        const { conversationId, chatId } = session.address;
        const result = rebaseChat({ localMessages: session.chat.messages, localHeader: session.chat.header, synced: session.synced, serverRecords });
        session.chat.messages.splice(0, session.chat.messages.length, ...result.messages);
        replaceContents(session.chat.header, result.header);
        session.synced = describeSyncedMessages(serverRecords.slice(1));
        session.dirty = result.appended > 0;
        session.shrink = false;
        const view = views.get(conversationId);
        const entry = view?.chats.find(item => item.id === chatId);
        if (view && entry) {
            refreshEntrySummary(view, entry);
            recomputeAggregates(view);
        }
        announceChatRead(session.address);
        emit('chat', { address: session.address });
        emit('list', { id: conversationId });
        return result;
    }

    /**
     * Sends what waits of one chat and resolves when the server has it.
     * @param {ChatAddress} address
     * @returns {Promise<boolean>} Whether the chat is saved. False when it is not loaded, or when the save failed.
     */
    async function saveChat(address) {
        const session = sessions.get(keyOf(address));
        if (!session?.chat) {
            return false;
        }
        if (session.saving) {
            await session.savePromise;
        }
        if (session.dirty && !session.failed && !session.dropped) {
            adapter.clearTimer(session.retryTimer);
            session.retries = 0;
            await saveSession(session);
        }
        return !session.dirty && !session.saving && !session.failed && !session.dropped;
    }

    /**
     * Reads a chat from the server again, for a change that the page did not make (a reply that the server wrote
     * while the page was frozen, a save of another tab). What waits to be saved goes first, so that the server's copy
     * already has it; a message that the page wrote since stays, merged by id as after a conflict. A chat that is not
     * loaded is loaded.
     *
     * A copy that came back is older than any change that the page made while the request was out: a message that the
     * page deleted or replaced in that time is still in the copy, and adopting it would bring that message back. The
     * page's own change goes first, and the chat is read again. A chat that keeps changing is left to the saves of the
     * page, which settle it through the merge of a conflict.
     * @param {ChatAddress} address
     * @returns {Promise<LoadedChat|null>} Null when the chat was dropped while the request was out.
     */
    async function reloadChat(address) {
        const key = keyOf(address);
        const session = sessions.get(key);
        if (!session?.chat) {
            return loadChat(address);
        }
        for (let attempt = 0; attempt < MAX_RELOAD_ATTEMPTS; attempt++) {
            await saveChat(address);
            const version = session.version;
            const answer = await request('/chat/get', { id: address.conversationId, chatId: address.chatId });
            if (answer.status !== 200) {
                throw failureOf(answer);
            }
            if (session.dropped || sessions.get(key) !== session) {
                return null;
            }
            if (session.version !== version || session.dirty || session.saving) {
                continue;
            }
            const result = adoptServerRecords(session, answer.json.chat);
            if (result.lostEdits > 0 || result.lostDeletes > 0) {
                emit('conflict', { address: session.address, appended: result.appended, lostEdits: result.lostEdits, lostDeletes: result.lostDeletes });
            }
            if (session.dirty) {
                void saveSession(session);
            }
            return session.chat;
        }
        return session.chat;
    }

    async function rebaseSession(session, allowShrink) {
        const { conversationId, chatId } = session.address;
        session.rebases = (session.rebases ?? 0) + 1;
        if (session.rebases > 2) {
            session.rebases = 0;
            session.failed = 'integrity';
            reportError('integrity', 'The chat changed elsewhere again and could not be merged.', { address: session.address });
            return 'failed';
        }
        let answer;
        try {
            answer = await request('/chat/get', { id: conversationId, chatId });
        } catch (error) {
            return scheduleRetry(session, allowShrink, error);
        }
        if (answer.status !== 200) {
            session.failed = answer.json?.error ?? `http_${answer.status}`;
            reportError(session.failed, 'The chat could not be reloaded after it changed elsewhere.', { address: session.address });
            return 'failed';
        }
        const result = adoptServerRecords(session, answer.json.chat);
        emit('conflict', { address: session.address, appended: result.appended, lostEdits: result.lostEdits, lostDeletes: result.lostDeletes });
        if (!session.dirty) {
            session.rebases = 0;
        }
        return session.dirty ? 'saved' : 'merged';
    }

    async function discardLocalChat(session) {
        const { conversationId, chatId } = session.address;
        try {
            const json = await requestOk('/chat/get', { id: conversationId, chatId });
            const [chatHeader, ...messages] = json.chat;
            session.chat.messages.splice(0, session.chat.messages.length, ...messages);
            replaceContents(session.chat.header, chatHeader);
            session.synced = describeSyncedMessages(messages);
            session.dirty = false;
            session.failed = '';
            const view = views.get(conversationId);
            const entry = view?.chats.find(item => item.id === chatId);
            if (view && entry) {
                refreshEntrySummary(view, entry);
                recomputeAggregates(view);
            }
            announceChatRead(session.address);
            emit('chat', { address: session.address });
            emit('list', { id: conversationId });
        } catch {
            sessions.delete(keyOf(session.address));
        }
    }

    /**
     * Sets the read marker of a chat to its last message, loading the chat first when it is not loaded. A reply that
     * the server wrote and no page has landed yet is not a message to read through: the finalizer replaces it with
     * bubbles of other ids, and a marker that names no message counts no unread message for good.
     */
    async function markRead(address) {
        const loaded = chat(address) ?? await loadChat(address);
        let last = null;
        for (let index = loaded.messages.length - 1; index >= 0 && !last; index--) {
            last = isPendingServerReply(loaded.messages[index]) ? null : loaded.messages[index];
        }
        if (!last?.id) {
            return;
        }
        patchConversation(address.conversationId, { chats: { [address.chatId]: { readThrough: last.id } } });
    }

    // ------------------------------------------------------------------------------------------------------------
    // Lifecycle of conversations and chats

    function decorateNew(conversation) {
        return { ...conversation, chats: (conversation.chats ?? []).map(entry => ({ ...entry, ...EMPTY_SUMMARY })) };
    }

    async function createConversation(input) {
        const json = await requestOk('/create', input);
        const existing = views.get(json.conversation.id);
        const view = existing ?? ingestConversation(decorateNew(json.conversation));
        emit('list', { id: view.id });
        return { conversation: view, created: json.created === true };
    }

    /**
     * Deletes the conversation with its chats and reminders. Listeners of `onRemoval` hear of it before the request goes
     * out, so that a reply in progress cannot land in it while the server works.
     */
    async function deleteConversation(id) {
        announceRemoval({ conversationId: id });
        const pending = pendingPatches.get(id);
        if (pending) {
            adapter.clearTimer(pending.timer);
            pendingPatches.delete(id);
        }
        await queueOf(id).idle();
        await requestOk('/delete', { id });
        dropConversation(id);
        emit('list', { id });
    }

    /**
     * Adds a chat. The chat is listed and loaded at once with a chat id that the browser chose; the request that makes
     * it on the server runs before anything else that names the chat.
     */
    function createChat(conversationId, { name = '', activate = false } = {}) {
        const view = views.get(conversationId);
        if (!view) {
            return null;
        }
        const chatId = `chat_${adapter.now()}_${adapter.random()}`;
        const address = { conversationId, chatId };
        const entry = {
            id: chatId,
            name,
            createdAt: adapter.now(),
            readThrough: '',
            followupCount: 0,
            lastAutoMessageAt: 0,
            lastActivity: 0,
            sessionMarkers: {},
            ...EMPTY_SUMMARY,
        };
        view.chats.push(entry);
        if (activate) {
            view.activeChatId = chatId;
        }
        const session = newSession(address, [blankHeader()]);
        session.created = queueOf(conversationId).run(async () => {
            try {
                const json = await requestOk('/chat/create', { id: conversationId, chatId, ...(name ? { name } : {}), ...(activate ? { activate: true } : {}) });
                if (views.has(conversationId) && json.conversation) {
                    ingestConversation(json.conversation);
                }
            } catch (error) {
                session.dropped = true;
                sessions.delete(keyOf(address));
                const current = views.get(conversationId);
                if (current) {
                    current.chats = current.chats.filter(item => item.id !== chatId);
                    if (current.activeChatId === chatId) {
                        current.activeChatId = current.chats[0]?.id ?? '';
                    }
                    recomputeAggregates(current);
                }
                emit('list', { id: conversationId });
                reportError(error.code, 'A chat could not be created.', { id: conversationId });
            } finally {
                session.created = null;
            }
        });
        attachSession(session);
        recomputeAggregates(view);
        emit('list', { id: conversationId });
        emit('chat', { address });
        return { address, entry };
    }

    /**
     * Deletes one chat. The reminders that name it go with it, because the server keeps them in the conversation, which
     * stays. When it was the last chat the server adds an empty one.
     */
    async function deleteChat(address) {
        const view = views.get(address.conversationId);
        if (!view) {
            return null;
        }
        announceRemoval(address);
        const keptReminders = view.reminders.filter(reminder => reminder.chatId !== address.chatId);
        if (keptReminders.length !== view.reminders.length) {
            patchConversation(address.conversationId, { reminders: keptReminders });
        }
        const pending = pendingPatches.get(address.conversationId);
        if (pending) {
            await flushConversation(address.conversationId);
        }
        await queueOf(address.conversationId).idle();
        const json = await requestOk('/chat/delete', { id: address.conversationId, chatId: address.chatId });
        const key = keyOf(address);
        const session = sessions.get(key);
        if (session) {
            session.dropped = true;
            adapter.clearTimer(session.retryTimer);
            sessions.delete(key);
        }
        ingestConversation(json.conversation);
        emit('list', { id: address.conversationId });
        return views.get(address.conversationId);
    }

    /** Sends what waits for a conversation and waits for its requests that are out, so that the next request sees the server as the page does. */
    async function settleConversation(id) {
        await flushConversation(id);
        await queueOf(id).idle();
    }

    function requireView(id) {
        const view = views.get(id);
        if (!view) {
            throw new ConversationDataError('not_found', 'The conversation no longer exists.', { status: 404 });
        }
        return view;
    }

    /**
     * A request about one conversation. A 404 can say that the conversation is gone or that a part of it is not there (a
     * member, a chat), so the module asks for the conversation before it forgets it.
     */
    async function requestAbout(conversationId, path, body) {
        try {
            return await queueOf(conversationId).run(() => requestOk(path, body));
        } catch (error) {
            if (error.status === 404 && error.code === 'not_found' && views.has(conversationId)) {
                const check = await request('/get', { id: conversationId }).catch(() => null);
                if (check?.status === 404) {
                    dropConversation(conversationId);
                    emit('list', { id: conversationId });
                }
            }
            throw error;
        }
    }

    function memoryOf(header) {
        const { memory_summary: summary, memory_message_count: count, memory_updated_at: updatedAt } = header?.chat_metadata?.sb_conversation ?? {};
        if (typeof summary !== 'string' || !summary.trim()) {
            return null;
        }
        return { memory_summary: summary, ...(Number.isFinite(count) ? { memory_message_count: count } : {}), ...(Number.isFinite(updatedAt) ? { memory_updated_at: updatedAt } : {}) };
    }

    /**
     * Branch from Here: a new chat that holds the messages up to and including `messageId`, read, with the memory
     * summary of its source. The server writes the messages as the first save of the chat, so the chat is never listed
     * empty, and the slug that it answers is kept for the first save of the page.
     * @param {ChatAddress} address The chat to branch.
     * @returns {Promise<{ address: ChatAddress, entry: Record<string, any> }>} The new chat, loaded.
     */
    async function branchChat(address, messageId, { name = '', activate = true } = {}) {
        requireView(address.conversationId);
        const source = await loadChat(address);
        const index = source.messages.findIndex(item => item.id === messageId);
        if (index < 0) {
            throw new ConversationDataError('not_found', 'The message is not in the chat.', { details: { messageId } });
        }
        const records = source.messages.slice(0, index + 1).map(item => structuredClone(item));
        const memory = memoryOf(source.header);
        await settleConversation(address.conversationId);
        const json = await requestAbout(address.conversationId, '/chat/create', {
            id: address.conversationId,
            ...(name ? { name } : {}),
            activate,
            readThrough: records.at(-1).id,
            records,
            ...(memory ? { chat_metadata: { sb_conversation: memory } } : {}),
        });
        const created = { conversationId: address.conversationId, chatId: json.chat.id };
        const branchHeader = { ...blankHeader(), chat_metadata: { ...(memory ? { sb_conversation: structuredClone(memory) } : {}), integrity: json.integrity } };
        const view = ingestConversation(json.conversation);
        attachSession(newSession(created, [branchHeader, ...records]));
        emit('chat', { address: created });
        emit('list', { id: view.id });
        return { address: created, entry: view.chats.find(item => item.id === created.chatId) };
    }

    /** Runs a route that answers the conversation it changed, and puts that answer in the cache. */
    async function changeConversation(id, path, body) {
        requireView(id);
        await settleConversation(id);
        const json = await requestAbout(id, path, { id, ...body });
        const view = ingestConversation(json.conversation);
        emit('list', { id });
        return { view, json };
    }

    /** @param {string} image A `data:image/...;base64,` URL of a PNG, JPEG, GIF or WebP file. */
    async function setGroupAvatar(id, image) {
        return (await changeConversation(id, '/avatar/upload', { image })).view;
    }

    async function removeGroupAvatar(id) {
        return (await changeConversation(id, '/avatar/remove', {})).view;
    }

    /**
     * Adds characters to a group, which then read the history as it is. On a direct conversation it makes a new group
     * of that character and the chosen ones and leaves the direct conversation as it is.
     * @param {string[]} characters Avatar file names of cards that exist.
     * @returns {Promise<{ conversation: Record<string, any>, created: boolean }>} The group, and whether it is a new one.
     */
    async function addMembers(id, characters) {
        const { view, json } = await changeConversation(id, '/members/add', { characters });
        return { conversation: view, created: json.created === true };
    }

    /**
     * Takes a member out of a group; the past messages stay. Removing the second-to-last member converts the group: the
     * server moves its chats into the direct conversation of the member that is left and deletes the group, and
     * `conversation` is then that direct conversation, the one to open. The list is read again after a conversion,
     * because the answer carries no summary of the chats that came over.
     * @returns {Promise<{ conversation: Record<string, any>, converted: boolean, removedId?: string }>}
     */
    async function removeMember(id, avatar) {
        requireView(id);
        await settleConversation(id);
        const json = await requestAbout(id, '/members/remove', { id, avatar });
        if (!json.converted) {
            const view = ingestConversation(json.conversation);
            emit('list', { id });
            return { conversation: view, converted: false };
        }
        dropConversation(json.removedId);
        try {
            await load();
        } catch {
            ingestConversation(json.conversation);
        }
        emit('list', {});
        return { conversation: views.get(json.conversation.id), converted: true, removedId: json.removedId };
    }

    /** Takes an extra, a character that the old store listed beside the one of a direct conversation, off the list. */
    async function removeExtra(id, avatar) {
        return (await changeConversation(id, '/extras/remove', { avatar })).view;
    }

    /**
     * The file of a chat as the server stores it, for a download. What waits to be saved is saved first.
     * @returns {Promise<{ fileName: string, text: string }>}
     */
    async function exportChat(address) {
        if (typeof adapter.fetchText !== 'function') {
            throw new ConversationDataError('unavailable', 'This page cannot download files.');
        }
        const session = sessions.get(keyOf(address));
        if (session?.chat && (session.dirty || session.saving)) {
            await saveSession(session);
        }
        let answer;
        try {
            answer = await adapter.fetchText('/chat/export', { id: address.conversationId, chatId: address.chatId });
        } catch (error) {
            throw new ConversationDataError('network', error?.message ?? 'The request failed.', { details: error });
        }
        if (answer.status !== 200) {
            let json = null;
            try {
                json = JSON.parse(answer.text);
            } catch {
                // The body was not JSON; the status says what failed.
            }
            throw failureOf({ status: answer.status, json });
        }
        return { fileName: answer.fileName, text: answer.text };
    }

    async function importLegacy(payload) {
        const json = await requestOk('/import-legacy', payload);
        if (json.state === 'imported') {
            await refresh();
        }
        return json;
    }

    // ------------------------------------------------------------------------------------------------------------
    // Start, refresh, flush

    function ensureReadyPromise() {
        readyPromise ??= new Promise((resolve) => {
            resolveReady = resolve;
        });
        return readyPromise;
    }

    async function load() {
        const [listAnswer, charactersAnswer] = await Promise.all([request('/list', {}), request('/characters/get', {})]);
        if (listAnswer.status !== 200) {
            throw failureOf(listAnswer);
        }
        ingestList(listAnswer.json.conversations ?? []);
        if (charactersAnswer.status === 200) {
            characterState = { version: charactersAnswer.json.version ?? 1, characters: charactersAnswer.json.characters ?? {} };
        }
        announceLoad();
        return listAnswer.json;
    }

    async function waitForMigration(error) {
        const answer = await request('/migration/status', {});
        const state = answer.json ?? {};
        if (state.state === 'failed') {
            status = { state: 'failed', code: state.error?.code ?? error.code, retryAt: adapter.now() + (state.retryAfterMs ?? MIGRATION_RETRY_FALLBACK_MS), message: state.error?.message ?? '' };
            emit('status', { status: getStatus() });
            retryTimer = adapter.setTimer(() => {
                retryTimer = null;
                startPromise = null;
                void start();
            }, Math.max(0, status.retryAt - adapter.now()));
            return false;
        }
        // The migration ran after this page read its settings: the settings it holds are older than the server's.
        if (state.state === 'migrated' && adapter.isSettingsStale()) {
            adapter.reloadPage();
            return false;
        }
        return true;
    }

    function start() {
        ensureReadyPromise();
        if (startPromise) {
            return startPromise;
        }
        status = { state: 'loading', code: '', retryAt: 0 };
        emit('status', { status: getStatus() });
        startPromise = (async () => {
            try {
                await load();
            } catch (error) {
                if (error.code === 'migration_failed') {
                    const retry = await waitForMigration(error);
                    if (!retry) {
                        return;
                    }
                    await load();
                } else {
                    status = { state: 'failed', code: error.code ?? 'network', retryAt: adapter.now() + RETRY_DELAYS_MS[1], message: '' };
                    emit('status', { status: getStatus() });
                    retryTimer = adapter.setTimer(() => {
                        retryTimer = null;
                        startPromise = null;
                        void start();
                    }, RETRY_DELAYS_MS[1]);
                    return;
                }
            }
            status = { state: 'ready', code: '', retryAt: 0 };
            emit('status', { status: getStatus() });
            emit('list', {});
            resolveReady?.();
        })();
        return startPromise;
    }

    function whenReady() {
        return ensureReadyPromise();
    }

    function getStatus() {
        return { ...status };
    }

    /** Reads the list and the characters again. Loaded chats stay; patches that are not sent yet stay applied. */
    async function refresh() {
        try {
            await load();
            emit('list', {});
            emit('characters', {});
        } catch (error) {
            reportError(error.code ?? 'network', 'The conversations could not be read again.');
        }
    }

    function hasPendingWrites() {
        if (pendingPatches.size || pendingCharacters.size || characterQueue.size) {
            return true;
        }
        // A patch that waits for its next attempt is in no queue.
        if ([...sentPatches.values()].some(list => list.some(sent => !sent.confirmed))) {
            return true;
        }
        for (const queue of conversationQueues.values()) {
            if (queue.size) {
                return true;
            }
        }
        return [...sessions.values()].some(session => session.dirty || session.saving || session.created);
    }

    /** Sends everything that waits, now, and resolves when the server has answered all of it. */
    async function flush({ keepalive = false } = {}) {
        const options = keepalive ? { keepalive: true } : undefined;
        for (const session of sessions.values()) {
            if (session.chat && session.dirty && !session.saving) {
                // The save of a change that was just made starts in a microtask, after this call has returned.
                session.pendingOptions = options;
            }
        }
        await Promise.all([
            ...[...pendingPatches.keys()].map(id => flushConversation(id, options)),
            ...[...pendingCharacters.keys()].map(avatar => flushCharacter(avatar, options)),
        ]);
        await Promise.all([...conversationQueues.values()].map(queue => queue.idle()));
        await characterQueue.idle();
        for (const session of [...sessions.values()]) {
            if (!session.chat) {
                continue;
            }
            if (session.saving) {
                await session.savePromise;
            }
            if (session.dirty && !session.failed) {
                adapter.clearTimer(session.retryTimer);
                session.retries = 0;
                await saveSession(session, options);
            }
        }
    }

    function destroy() {
        adapter.clearTimer(retryTimer);
        for (const pending of pendingPatches.values()) {
            adapter.clearTimer(pending.timer);
        }
        for (const list of sentPatches.values()) {
            for (const sent of list) {
                adapter.clearTimer(sent.timer);
            }
        }
        listeners.clear();
    }

    return Object.freeze({
        start,
        whenReady,
        status: getStatus,
        refresh,
        list,
        get,
        findDirect,
        chat,
        totalUnread,
        characterState: getCharacterState,
        resolve,
        loadChat,
        reloadChat,
        saveChat,
        setOpen,
        patchConversation,
        patchCharacter,
        reminders,
        cancelReminder,
        patchReminder,
        commitChat,
        createChat,
        createConversation,
        deleteConversation,
        deleteChat,
        branchChat,
        exportChat,
        setGroupAvatar,
        removeGroupAvatar,
        addMembers,
        removeMember,
        removeExtra,
        onRemoval,
        onLoad,
        onChatRead,
        markRead,
        importLegacy,
        flush,
        hasPendingWrites,
        subscribe,
        destroy,
    });
}
