/**
 * The folders of the conversations of one user, as the browser holds them: the whole `folders.json` that
 * `/api/sillybunny-conversation/folders/get` answers, and the queue that writes changes back through
 * `/folders/update`.
 *
 * Readers get the copy synchronously, per persona. A writer changes the copy first, with the same `applyFolderOps()` that
 * the server runs, and the server after: operations of one persona wait together, are sent one request at a time, and
 * the answer replaces the persona's record with the server's, with the operations that are not sent yet applied on top.
 * The open and closed state of a folder is written often, so a request that holds nothing else waits 400 ms for more.
 * A refused request is reported and the file is read again, so the page never keeps a state that the server refused.
 *
 * The module imports nothing from the page: the adapter gives it the request, the clock and the random bytes of a new
 * folder id, so that tests run it on a fake clock and the real routes.
 *
 * @typedef {object} FoldersAdapter
 * @property {(path: string, body: object, options?: { keepalive?: boolean }) => Promise<{ status: number, json: any }>} fetchJson
 * POST to a route under `/api/sillybunny-conversation`. Resolves for every HTTP status; rejects for a network failure.
 * @property {() => number} now
 * @property {(callback: () => void, delay: number) => any} setTimer
 * @property {(handle: any) => void} clearTimer
 * @property {(length: number) => string} randomHex `length` characters of `[0-9a-f]`, from a strong source.
 */

import { createSerialQueue } from './conversation-data-queue.js';
import {
    FolderInputError,
    MAX_FOLDER_OPS,
    applyFolderOps,
    normalizeFolderFile,
    normalizeFolderRecord,
    getPersonaFolders,
    parseFolderOps,
    withPersonaFolders,
} from './folder-model.js';

export const FOLDER_FREQUENT_DELAY_MS = 400;
export const FOLDER_FREQUENT_MAX_WAIT_MS = 3000;
export const FOLDER_RETRY_DELAYS_MS = Object.freeze([2000, 5000, 15000]);
const LOAD_RETRY_MS = 5000;

/**
 * @typedef {import('./folder-model.js').Folder} Folder
 * @typedef {{ folders: readonly Folder[], favoritesExpanded: boolean, signature: string }} FolderLayout
 * `signature` changes whenever a folder is made, renamed, recoloured, moved, opened, closed or deleted, or Favorites is.
 */

const EMPTY_LAYOUT = Object.freeze({ folders: Object.freeze([]), favoritesExpanded: true, signature: '' });

function isFrequent(op) {
    return op.op === 'setFavoritesExpanded' || (op.op === 'updateFolder' && Object.keys(op).every(key => key === 'op' || key === 'id' || key === 'expanded'));
}

/** Of two operations that only set an open state, the later one wins, so the earlier is dropped. */
function compact(ops) {
    return ops.filter((op, index) => !isFrequent(op) || !ops.slice(index + 1).some(later => later.op === op.op && later.id === op.id && isFrequent(later)));
}

/**
 * @param {FoldersAdapter} adapter
 */
export function createConversationFolders(adapter) {
    let file = normalizeFolderFile(null);
    /** @type {'idle'|'loading'|'ready'|'failed'} */
    let status = 'idle';
    /** @type {Map<string, { ops: object[], firstAt: number, timer: any, attempts: number }>} */
    const pending = new Map();
    /**
     * The batches of operations that left `pending` for the network and are not answered yet, per persona, oldest first.
     * An answer holds only the batches up to the one it answers, so what is read from the server has these put over it, and
     * then the operations that wait in `pending`: a change that is newer than an answer is never undone by it.
     * @type {Map<string, object[][]>}
     */
    const inFlight = new Map();
    const queue = createSerialQueue();
    const listeners = new Set();
    const layouts = new WeakMap();
    let loadPromise = null;
    let retryTimer = null;
    let eventScheduled = false;
    let changedPersonas = new Set();
    let wholeFileChanged = false;
    let statusChanged = false;
    let destroyed = false;

    // ------------------------------------------------------------------------------------------------------------
    // Events

    function schedule(personaId, { forStatus = false } = {}) {
        if (forStatus) {
            statusChanged = true;
        } else if (personaId === null) {
            wholeFileChanged = true;
        } else {
            changedPersonas.add(personaId);
        }
        if (eventScheduled) {
            return;
        }
        eventScheduled = true;
        queueMicrotask(() => {
            eventScheduled = false;
            const events = [
                ...(wholeFileChanged ? [{ type: 'folders', personaId: null }] : []),
                ...[...changedPersonas].map(personaId => ({ type: 'folders', personaId })),
                ...(statusChanged ? [{ type: 'status', status }] : []),
            ];
            changedPersonas = new Set();
            wholeFileChanged = false;
            statusChanged = false;
            for (const event of events) {
                for (const listener of [...listeners]) {
                    try {
                        listener(event);
                    } catch (error) {
                        console.error('Conversation folders listener failed:', error);
                    }
                }
            }
        });
    }

    /**
     * Listeners hear `{ type: 'folders', personaId }` for a change (`personaId` is null when the whole file was read
     * again), `{ type: 'status', status }` when the load starts, ends or fails, and `{ type: 'error', code, message }`
     * for a change that the server refused.
     * @param {(event: object) => void} listener
     * @returns {() => void} Unsubscribe.
     */
    function subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
    }

    function reportError(code, message) {
        for (const listener of [...listeners]) {
            try {
                listener({ type: 'error', code, message });
            } catch (error) {
                console.error('Conversation folders listener failed:', error);
            }
        }
    }

    function setStatus(next) {
        if (status !== next) {
            status = next;
            schedule(null, { forStatus: true });
        }
    }

    // ------------------------------------------------------------------------------------------------------------
    // Reads

    function getStatus() {
        return status;
    }

    /**
     * What the list draws for one persona: its folders in order and whether Favorites is open. The same object comes back
     * until the persona's folders change, so a caller can compare the result with the last one.
     * @param {string} personaId
     * @returns {FolderLayout}
     */
    function layout(personaId) {
        if (!Object.hasOwn(file.personas, personaId)) {
            return EMPTY_LAYOUT;
        }
        const stored = file.personas[personaId];
        let cached = layouts.get(stored);
        if (!cached) {
            const favoritesExpanded = stored.favoritesExpanded !== false;
            const folders = Object.freeze(stored.folders.map(folder => Object.freeze({ ...folder })));
            cached = Object.freeze({ folders, favoritesExpanded, signature: JSON.stringify([favoritesExpanded, stored.folders]) });
            layouts.set(stored, cached);
        }
        return cached;
    }

    /** @returns {string} The id of the folder that holds the conversation, or an empty string. */
    function folderOf(personaId, conversationId) {
        if (!Object.hasOwn(file.personas, personaId)) {
            return '';
        }
        const { members } = file.personas[personaId];
        return Object.hasOwn(members, conversationId) ? members[conversationId] : '';
    }

    /** @returns {string[]} The ids of the conversations filed in a folder, in the file's order. */
    function membersOf(personaId, folderId) {
        if (!Object.hasOwn(file.personas, personaId)) {
            return [];
        }
        return Object.entries(file.personas[personaId].members).filter(([, id]) => id === folderId).map(([conversationId]) => conversationId);
    }

    // ------------------------------------------------------------------------------------------------------------
    // Requests

    async function request(path, body, options) {
        return adapter.fetchJson(path, body, options);
    }

    /** Puts the changes that the server has not answered over the record of a persona that was just read: the batches that are out, then the ones that wait. */
    function applyPending(personaId) {
        const batches = [...(inFlight.get(personaId) ?? []), pending.get(personaId)?.ops ?? []];
        if (!batches.some(batch => batch.length)) {
            return;
        }
        let record = getPersonaFolders(file, personaId);
        for (const op of batches.flat()) {
            try {
                record = applyFolderOps(record, [op]);
            } catch {
                // An operation that no longer applies to what the server holds is dropped by the server too.
            }
        }
        file = withPersonaFolders(file, personaId, record);
    }

    function leaveInFlight(personaId, batch) {
        const list = inFlight.get(personaId);
        const index = list?.indexOf(batch) ?? -1;
        if (index >= 0) {
            list.splice(index, 1);
        }
        if (list && !list.length) {
            inFlight.delete(personaId);
        }
    }

    /** Reads the file and puts it in place of the copy, keeping the operations that are not sent yet. */
    async function readFile() {
        let answer;
        try {
            answer = await request('/folders/get', {});
        } catch {
            return false;
        }
        if (answer.status !== 200) {
            return false;
        }
        file = normalizeFolderFile(answer.json);
        for (const personaId of new Set([...inFlight.keys(), ...pending.keys()])) {
            applyPending(personaId);
        }
        return true;
    }

    function scheduleLoadRetry() {
        if (retryTimer !== null || destroyed) {
            return;
        }
        retryTimer = adapter.setTimer(() => {
            retryTimer = null;
            loadPromise = null;
            void load();
        }, LOAD_RETRY_MS);
    }

    /**
     * Reads the folders the first time. Called again, it answers the same promise; after a failure the next call, and a
     * timer, try again. The list waits for it to leave `loading`.
     * @returns {Promise<void>}
     */
    function load() {
        if (status === 'failed' && loadPromise) {
            adapter.clearTimer(retryTimer);
            retryTimer = null;
            loadPromise = null;
        }
        loadPromise ??= (async () => {
            setStatus(status === 'ready' ? 'ready' : 'loading');
            const ok = await queue.run(readFile);
            if (!ok) {
                setStatus('failed');
                scheduleLoadRetry();
                return;
            }
            setStatus('ready');
            schedule(null);
        })();
        return loadPromise;
    }

    /** Reads the file again, after the server changed it behind the page's back or refused a change. */
    async function refresh() {
        if (status !== 'ready') {
            return load();
        }
        const ok = await queue.run(readFile);
        if (ok) {
            schedule(null);
        }
        return undefined;
    }

    function whenReady() {
        return loadPromise ?? Promise.resolve();
    }

    function ingest(personaId, record) {
        file = withPersonaFolders(file, personaId, normalizeFolderRecord(record));
        applyPending(personaId);
        schedule(personaId);
    }

    /**
     * Sends one batch of operations. A batch that could not reach the server for a reason that may pass (the network, a 5xx)
     * goes back to the front of the persona's queue and waits for the next delay, so that no later batch overtakes it.
     * @returns {Promise<boolean>} False when the batch waits for a new attempt.
     */
    async function send(personaId, ops, options, attempt) {
        let answer;
        try {
            answer = await request('/folders/update', { personaId, ops }, options);
        } catch {
            leaveInFlight(personaId, ops);
            return requeue(personaId, ops, attempt, 'network');
        }
        // The batch is answered, or it goes back to `pending`, or it is given up: it is no longer one that is out.
        leaveInFlight(personaId, ops);
        if (destroyed) {
            return false;
        }
        if (answer.status === 200) {
            const entry = pending.get(personaId);
            if (entry) {
                entry.attempts = 0;
            }
            ingest(personaId, answer.json?.folders);
            return true;
        }
        if (answer.status >= 500) {
            return requeue(personaId, ops, attempt, answer.json?.error ?? `http_${answer.status}`);
        }
        reportError(answer.json?.error ?? 'update_rejected', 'A change to the folders was refused.');
        await readFile();
        if (!destroyed) {
            schedule(personaId);
        }
        return true;
    }

    async function requeue(personaId, ops, attempt, code) {
        if (destroyed) {
            return false;
        }
        const delay = FOLDER_RETRY_DELAYS_MS[attempt];
        if (delay === undefined) {
            reportError(code, 'A change to the folders could not be saved.');
            await readFile();
            if (!destroyed) {
                schedule(personaId);
            }
            return true;
        }
        const entry = pending.get(personaId) ?? { ops: [], firstAt: adapter.now(), timer: null, attempts: 0 };
        adapter.clearTimer(entry.timer);
        entry.ops = [...ops, ...entry.ops];
        entry.attempts = attempt + 1;
        entry.timer = adapter.setTimer(() => {
            void flushPersona(personaId);
        }, delay);
        pending.set(personaId, entry);
        return false;
    }

    /** Sends up to one request's worth of the operations that wait for a persona, and goes on while some remain. */
    async function flushPersona(personaId, options) {
        const entry = pending.get(personaId);
        if (!entry || destroyed) {
            return;
        }
        adapter.clearTimer(entry.timer);
        const attempt = entry.attempts ?? 0;
        const batch = entry.ops.splice(0, MAX_FOLDER_OPS);
        if (entry.ops.length === 0) {
            pending.delete(personaId);
        }
        inFlight.set(personaId, [...(inFlight.get(personaId) ?? []), batch]);
        const done = await queue.run(() => send(personaId, batch, options, attempt));
        if (done && !destroyed && pending.has(personaId)) {
            await flushPersona(personaId, options);
        }
    }

    function enqueue(personaId, ops) {
        const entry = pending.get(personaId);
        if (entry) {
            adapter.clearTimer(entry.timer);
        }
        const firstAt = entry?.firstAt ?? adapter.now();
        const merged = compact([...(entry?.ops ?? []), ...ops]);
        const delay = merged.every(isFrequent)
            ? Math.max(0, Math.min(FOLDER_FREQUENT_DELAY_MS, firstAt + FOLDER_FREQUENT_MAX_WAIT_MS - adapter.now()))
            : 0;
        const timer = adapter.setTimer(() => {
            void flushPersona(personaId);
        }, delay);
        pending.set(personaId, { ops: merged, firstAt, timer, attempts: entry?.attempts ?? 0 });
    }

    // ------------------------------------------------------------------------------------------------------------
    // Writes

    /**
     * Applies operations to the copy, then queues them for the server.
     * @param {string} personaId
     * @param {object[]} ops See `folder-model.js`.
     * @returns {import('./folder-model.js').FolderRecord} The persona's record after the change.
     * @throws {FolderInputError} For an operation that cannot apply, such as the 51st folder; nothing changed then.
     */
    function change(personaId, ops) {
        if (status !== 'ready') {
            throw new FolderInputError('invalid_input', 'The folders are not loaded yet.');
        }
        const parsed = parseFolderOps(ops);
        const before = getPersonaFolders(file, personaId);
        const after = applyFolderOps(before, parsed);
        if (JSON.stringify(after) === JSON.stringify(before)) {
            return before;
        }
        file = withPersonaFolders(file, personaId, after);
        enqueue(personaId, parsed);
        schedule(personaId);
        return after;
    }

    function makeFolderId() {
        return `fld_${adapter.now()}_${adapter.randomHex(12)}`;
    }

    /**
     * @param {string} personaId
     * @param {string} name
     * @param {{ color?: string, expanded?: boolean, id?: string }} [options]
     * @returns {Folder} The new folder, at the end of the persona's folders.
     * @throws {FolderInputError} For a name that is not 1 to 100 characters of one line, or the 51st folder.
     */
    function createFolder(personaId, name, { color = '', expanded = true, id = makeFolderId() } = {}) {
        const record = change(personaId, [{ op: 'createFolder', id, name, color, expanded }]);
        return { ...record.folders.find(folder => folder.id === id) };
    }

    /** @returns {boolean} Whether the folder changed. */
    function updateFolder(personaId, id, fields) {
        const before = getPersonaFolders(file, personaId);
        return JSON.stringify(change(personaId, [{ op: 'updateFolder', id, ...fields }])) !== JSON.stringify(before);
    }

    /** @param {number} to The place from 0, as `moveFolder` of the model takes it. @returns {boolean} Whether the folder moved. */
    function moveFolder(personaId, id, to) {
        const before = getPersonaFolders(file, personaId);
        return JSON.stringify(change(personaId, [{ op: 'moveFolder', id, to }])) !== JSON.stringify(before);
    }

    /** Deletes a folder; the conversations filed in it are in no folder after. @returns {boolean} Whether there was a folder. */
    function deleteFolder(personaId, id) {
        const before = getPersonaFolders(file, personaId);
        return JSON.stringify(change(personaId, [{ op: 'deleteFolder', id }])) !== JSON.stringify(before);
    }

    /** @param {string|null} folderId A folder, or null to take the conversations out of their folders. @returns {boolean} Whether any entry changed. */
    function setMembers(personaId, conversationIds, folderId) {
        const before = getPersonaFolders(file, personaId);
        return JSON.stringify(change(personaId, [{ op: 'setMembers', ids: conversationIds, folderId }])) !== JSON.stringify(before);
    }

    /** Creates a folder and files conversations in it, as one request. @returns {Folder} */
    function createFolderWith(personaId, name, conversationIds, options = {}) {
        const id = options.id ?? makeFolderId();
        const record = change(personaId, [
            { op: 'createFolder', id, name, color: options.color ?? '', expanded: options.expanded ?? true },
            ...(conversationIds.length ? [{ op: 'setMembers', ids: conversationIds, folderId: id }] : []),
        ]);
        return { ...record.folders.find(folder => folder.id === id) };
    }

    function setFavoritesExpanded(personaId, expanded) {
        const before = getPersonaFolders(file, personaId);
        return JSON.stringify(change(personaId, [{ op: 'setFavoritesExpanded', expanded }])) !== JSON.stringify(before);
    }

    // ------------------------------------------------------------------------------------------------------------
    // Leaving

    function hasPendingWrites() {
        return pending.size > 0 || queue.size > 0;
    }

    /** Sends everything that waits, now, and resolves when the server has answered all of it. */
    async function flush({ keepalive = false } = {}) {
        const options = keepalive ? { keepalive: true } : undefined;
        await Promise.all([...pending.keys()].map(personaId => flushPersona(personaId, options)));
        await queue.idle();
    }

    function destroy() {
        destroyed = true;
        adapter.clearTimer(retryTimer);
        for (const entry of pending.values()) {
            adapter.clearTimer(entry.timer);
        }
        listeners.clear();
    }

    return Object.freeze({
        load,
        whenReady,
        status: getStatus,
        refresh,
        subscribe,
        layout,
        folderOf,
        membersOf,
        createFolder,
        createFolderWith,
        updateFolder,
        moveFolder,
        deleteFolder,
        setMembers,
        setFavoritesExpanded,
        hasPendingWrites,
        flush,
        destroy,
    });
}
