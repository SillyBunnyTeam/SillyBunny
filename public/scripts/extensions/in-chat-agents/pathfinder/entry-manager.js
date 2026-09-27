import { createWorldInfoEntry as createWorldInfoEntryFallback, syncWIOriginalDataEntry, deleteWIOriginalDataValue, reloadEditor } from '../../../world-info.js';
import { getTree, saveTree, deleteTree, renameTree, findNodeById, isEntryEligible, parseEntryUid, syncTrackerUidsForLorebook, beginPathfinderSelfWrite, endPathfinderSelfWrite, isPathfinderSelfWrite } from './tree-store.js';
import { deriveTreeFromMetadata } from './tree-builder.js';
import { createLayoutNode, readTreeLayout, setEntryPlacement, syncBookLayoutMetadata, writeTreeLayout } from './tree-layout.js';
import { getSummaryMemoryState, renameSummaryMemoryBook, detachSummaryMemoryBook, syncSummaryMemoryForBook } from './summary-memory-store.js';

let _loadWorldInfo = null;
let _createWorldInfoEntry = null;
let _saveWorldInfo = null;

export function initEntryManagerAPIs(loadWI, createWIE, saveWI) {
    _loadWorldInfo = loadWI;
    _createWorldInfoEntry = createWIE;
    _saveWorldInfo = saveWI;
}

async function loadWI(name) {
    if (_loadWorldInfo) return _loadWorldInfo(name);
    const ctx = window?.SillyTavern?.getContext?.();
    return ctx?.loadWorldInfo?.(name);
}

async function createWIE(name, data) {
    if (_createWorldInfoEntry) return _createWorldInfoEntry(name, data);
    const ctx = window?.SillyTavern?.getContext?.();
    if (ctx?.createWorldInfoEntry) return ctx.createWorldInfoEntry(name, data);
    return createWorldInfoEntryFallback(name, data);
}

function assertCreatedEntry(newEntry, bookName) {
    if (!newEntry || parseEntryUid(newEntry.uid) === null) {
        throw new Error(`Could not create a new entry in "${bookName}". Lorebook may be missing or unwritable.`);
    }
}

async function saveWI(name, data, immediate) {
    beginPathfinderSelfWrite(name);
    try {
        if (_saveWorldInfo) return await _saveWorldInfo(name, data, immediate);
        const ctx = window?.SillyTavern?.getContext?.();
        return await ctx?.saveWorldInfo?.(name, data, immediate);
    } finally {
        endPathfinderSelfWrite();
    }
}

// Each queued operation loads its own private snapshot before mutating it.
// ponytail: global lock; per-book locks if tool-call throughput ever matters
let writeChain = Promise.resolve();

function writeBook(bookName, mutate, { signal, isCurrent } = {}) {
    const assertCurrent = () => {
        signal?.throwIfAborted();
        if (isCurrent && !isCurrent()) throw new DOMException('Cancelled', 'AbortError');
    };
    const run = writeChain.then(async () => {
        // The host returns a private copy and tracks its identity for stale-editor merges.
        const bookData = await loadWI(bookName);
        assertCurrent();
        if (!bookData) throw new Error(`Lorebook "${bookName}" not found.`);
        const summary = getSummaryMemoryState();
        const previousSummaryEntry = summary.bookName === bookName
            ? structuredClone(findEntryByUid(bookData.entries, summary.uid)) : null;
        const result = await mutate(bookData);
        syncBookLayoutMetadata(bookData);
        assertCurrent();
        // Cancellation cannot undo a save once the request has been sent.
        const committedName = await saveWI(bookName, bookData, true);
        if (typeof committedName !== 'string' || !committedName) throw new Error('The lorebook save did not complete.');
        if (committedName !== bookName) onPathfinderWorldInfoRenamed(bookName, committedName);
        let committedData;
        try {
            committedData = await loadWI(committedName);
        } catch (error) {
            console.warn(error);
        }
        // A failed refresh must not retry an already committed entry creation.
        deleteTree(committedName);
        if (committedData) saveTree(committedName, deriveTreeFromMetadata(committedName, committedData));
        syncTrackerUidsForLorebook(committedName, committedData);
        const currentSummary = getSummaryMemoryState();
        if (currentSummary.uid === summary.uid && currentSummary.title === summary.title && currentSummary.content === summary.content) {
            syncSummaryMemoryForBook(committedName, committedData, previousSummaryEntry);
        }
        try {
            reloadEditor(committedName);
        } catch (error) {
            // An editor refresh failure must not report an already committed write as failed.
            console.warn(error);
        }
        return { ...result, bookName: committedName };
    });
    writeChain = run.then(() => {}, () => {});
    return run;
}

function getEditableTree(bookName, bookData) {
    if (readTreeLayout(bookData) === null) throw new Error('The saved waypoint layout is damaged or uses an unsupported format and will not be overwritten.');
    return deriveTreeFromMetadata(bookName, bookData, getTree(bookName));
}

function requireEntry(bookName, bookData, uid, eligibleOnly = false) {
    const entry = findEntryByUid(bookData.entries, uid);
    if (!entry || entry.agentBlacklisted || (eligibleOnly && !isEntryEligible(entry))) throw new Error(`Entry UID ${uid} not found in "${bookName}".`);
    return entry;
}

export function createEntry(bookName, title, content, keys = [], { arc = '', signal, isCurrent } = {}) {
    return writeBook(bookName, async bookData => {
        const newEntry = await createWIE(bookName, bookData);
        assertCreatedEntry(newEntry, bookName);
        newEntry.content = content;
        newEntry.comment = title;
        newEntry.key = keys.length > 0 ? [...keys] : [title.replace(/^\[.*?\]\s*/, '').split(/[:|]/)[0].trim().toLowerCase()];
        newEntry.selective = false;
        newEntry.constant = false;
        newEntry.disable = false;
        if (arc) {
            const tree = getEditableTree(bookName, bookData);
            const summaryWaypoint = findParentOfEntry(tree, newEntry.uid);
            let arcNode = summaryWaypoint.children.find(node => node.name.replace(/^Arc:\s*/i, '').toLowerCase() === arc.toLowerCase());
            if (!arcNode) {
                arcNode = createLayoutNode(bookName, `Arc: ${arc}`, `Narrative arc: ${arc}`);
                summaryWaypoint.children.push(arcNode);
            }
            setEntryPlacement(newEntry, arcNode);
            writeTreeLayout(bookData, tree);
        }
        syncWIOriginalDataEntry(bookData, newEntry.uid);
        return { uid: newEntry.uid, title };
    }, { signal, isCurrent });
}

export function updateEntry(bookName, uid, newContent, newTitle, expectedEntry = null, options = {}) {
    return writeBook(bookName, bookData => {
        const entry = findEntryByUid(bookData.entries, uid);
        if (expectedEntry && (!isEntryEligible(entry) || entry.comment !== expectedEntry.title || String(entry.content || '').trim() !== expectedEntry.content)) {
            const error = new Error('The summary or its linked entry changed while the user was editing. Saves are blocked to prevent overwriting.');
            error.code = 'PATHFINDER_ENTRY_CHANGED';
            throw error;
        }
        requireEntry(bookName, bookData, uid);
        if (typeof newContent === 'string') entry.content = newContent;
        if (typeof newTitle === 'string') entry.comment = newTitle;
        syncWIOriginalDataEntry(bookData, entry.uid);
        return { uid: entry.uid };
    }, options);
}

export function forgetEntry(bookName, uid, hardDelete = false, options = {}) {
    return writeBook(bookName, bookData => {
        if (typeof hardDelete !== 'boolean') throw new Error('Permanent deletion request refused; the tool supplied an invalid permanent deletion choice.');
        const entry = requireEntry(bookName, bookData, uid);
        if (hardDelete) {
            const key = Object.keys(bookData.entries).find(k => bookData.entries[k] === entry);
            deleteWIOriginalDataValue(bookData, entry.uid);
            delete bookData.entries[key];
        } else {
            entry.disable = true;
            syncWIOriginalDataEntry(bookData, entry.uid);
        }
        return { uid: entry.uid, deleted: hardDelete, disabled: !hardDelete };
    }, options);
}

export function moveEntry(bookName, uid, targetNodeId, options = {}) {
    return writeBook(bookName, bookData => {
        const entry = requireEntry(bookName, bookData, uid, true);
        const tree = getEditableTree(bookName, bookData);
        const targetNode = findNodeById(tree, targetNodeId);
        if (!targetNode) throw new Error(`Waypoint ${targetNodeId} not found in "${bookName}". Use Search to list valid waypoint IDs.`);
        setEntryPlacement(entry, targetNode);
        writeTreeLayout(bookData, tree);
        syncWIOriginalDataEntry(bookData, entry.uid);
        return { uid: entry.uid, targetNodeId };
    }, options);
}

export function createCategory(bookName, parentNodeId, name, description = '', options = {}) {
    return writeBook(bookName, bookData => {
        const tree = getEditableTree(bookName, bookData);
        const newNode = createLayoutNode(bookName, name, description);
        const parent = parentNodeId ? findNodeById(tree, parentNodeId) : tree;
        if (!parent) throw new Error(`Parent node ${parentNodeId} not found.`);
        parent.children.push(newNode);
        writeTreeLayout(bookData, tree);
        return { nodeId: newNode.id, name };
    }, options);
}

export function findEntry(entries, uid) {
    uid = parseEntryUid(uid);
    if (!entries || uid === null) return null;
    for (const [, entry] of Object.entries(entries)) {
        if (entry && entry.uid === uid) return entry;
    }
    return null;
}

export function findEntryByUid(entries, uid) {
    return findEntry(entries, uid);
}

export async function listNodeEntries(bookName, nodeId) {
    const tree = getTree(bookName);
    if (!tree) return [];
    const node = findNodeById(tree, nodeId);
    if (!node) return [];
    const bookData = await loadWI(bookName);
    if (!bookData) return [];
    return (node.entries || [])
        .map(uid => findEntryByUid(bookData.entries, uid))
        .filter(isEntryEligible)
        .map(e => ({ uid: e.uid, title: e.comment || e.key?.[0] || '', content: e.content || '' }));
}

export function mergeEntries(bookName, uid1, uid2, mergedTitle, options = {}) {
    return writeBook(bookName, bookData => {
        const e1 = requireEntry(bookName, bookData, uid1, true);
        const e2 = requireEntry(bookName, bookData, uid2, true);
        uid1 = e1.uid;
        uid2 = e2.uid;
        if (uid1 === uid2) throw new Error('Cannot merge an entry with itself: "uid1" and "uid2" must differ.');
        const tree = getEditableTree(bookName, bookData);
        setEntryPlacement(e1, findParentOfEntry(tree, uid1));
        writeTreeLayout(bookData, tree);
        e1.content = `${e1.content}\n\n---\n\n${e2.content}`;
        if (mergedTitle) e1.comment = mergedTitle;
        else e1.comment = (e1.comment || '') + ' + ' + (e2.comment || '');
        const key2 = Object.keys(bookData.entries).find(k => bookData.entries[k] === e2);
        deleteWIOriginalDataValue(bookData, uid2);
        delete bookData.entries[key2];
        syncWIOriginalDataEntry(bookData, uid1);
        return { mergedUid: uid1, removedUid: uid2 };
    }, options);
}

export function splitEntry(bookName, uid, splitTitle1, content1, splitTitle2, content2, options = {}) {
    return writeBook(bookName, async bookData => {
        const original = requireEntry(bookName, bookData, uid, true);
        uid = original.uid;
        const tree = getEditableTree(bookName, bookData);
        setEntryPlacement(original, findParentOfEntry(tree, uid));
        writeTreeLayout(bookData, tree);
        const newEntry = await createWIE(bookName, bookData);
        assertCreatedEntry(newEntry, bookName);
        Object.assign(newEntry, structuredClone(original), { uid: newEntry.uid, content: content2, comment: splitTitle2 || 'Split entry' });
        const originals = bookData.originalData?.entries;
        const sourceIndex = bookData.originalDataUidMap?.[uid] ?? originals?.findIndex(entry => String(entry.id ?? entry.uid) === String(uid));
        const targetIndex = bookData.originalDataUidMap?.[newEntry.uid];
        if (originals?.[sourceIndex] && Number.isInteger(targetIndex)) {
            // Copy card-only metadata without replacing the newly allocated card ID.
            originals[targetIndex] = { ...structuredClone(originals[sourceIndex]), id: originals[targetIndex].id };
        }
        original.content = content1;
        original.comment = splitTitle1 || original.comment;
        syncWIOriginalDataEntry(bookData, uid);
        syncWIOriginalDataEntry(bookData, newEntry.uid);
        return { originalUid: uid, newUid: newEntry.uid };
    }, options);
}

function findParentOfEntry(tree, uid) {
    if (!tree) return null;
    if (Array.isArray(tree.entries) && tree.entries.includes(uid)) return tree;
    for (const child of tree.children || []) {
        const found = findParentOfEntry(child, uid);
        if (found) return found;
    }
    return null;
}

export function onPathfinderWorldInfoUpdated(bookName, bookData, { replaced = false } = {}) {
    if (!replaced && isPathfinderSelfWrite(bookName)) return;
    deleteTree(bookName, replaced);
    syncTrackerUidsForLorebook(bookName, bookData);
    if (replaced) detachSummaryMemoryBook(bookName);
    else syncSummaryMemoryForBook(bookName, bookData);
}

export function onPathfinderWorldInfoRenamed(oldName, newName) {
    renameTree(oldName, newName);
    renameSummaryMemoryBook(oldName, newName);
}

export function onPathfinderWorldInfoDeleted(bookName) {
    deleteTree(bookName, true);
    detachSummaryMemoryBook(bookName);
}
