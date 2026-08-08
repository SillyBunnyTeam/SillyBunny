import { createWorldInfoEntry as createWorldInfoEntryFallback } from '../../../world-info.js';
import { getTree, saveTree, findNodeById, addEntryToNode, removeEntryFromTree, createTreeNode, isTrackerTitle, setTrackerUid, beginPathfinderSelfWrite, endPathfinderSelfWrite } from './tree-store.js';

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
    if (!newEntry || newEntry.uid === undefined) {
        throw new Error(`Could not create a new entry in "${bookName}". Lorebook may be missing or unwritable.`);
    }
}

async function saveWI(name, data, immediate) {
    beginPathfinderSelfWrite();
    try {
        if (_saveWorldInfo) return await _saveWorldInfo(name, data, immediate);
        const ctx = window?.SillyTavern?.getContext?.();
        return await ctx?.saveWorldInfo?.(name, data, immediate);
    } finally {
        endPathfinderSelfWrite();
    }
}

// Serializes all lorebook writes: each operation does an independent
// load → mutate → save, so two concurrent tool calls in one round would
// clobber each other's snapshot without this.
// ponytail: global lock; per-book locks if tool-call throughput ever matters
let writeChain = Promise.resolve();
function withWriteLock(fn) {
    const run = writeChain.then(fn, fn);
    writeChain = run.then(() => {}, () => {});
    return run;
}

export function createEntry(bookName, title, content, keys = []) {
    return withWriteLock(() => createEntryUnlocked(bookName, title, content, keys));
}

async function createEntryUnlocked(bookName, title, content, keys = []) {
    const bookData = await loadWI(bookName);
    if (!bookData) throw new Error(`Lorebook "${bookName}" not found.`);
    const newEntry = await createWIE(bookName, bookData);
    assertCreatedEntry(newEntry, bookName);
    newEntry.content = content;
    newEntry.comment = title;
    newEntry.key = keys.length > 0 ? keys : [title.replace(/^\[.*?\]\s*/, '').split(/[:|]/)[0].trim().toLowerCase()];
    newEntry.selective = false;
    newEntry.constant = false;
    newEntry.disable = false;
    await saveWI(bookName, bookData, true);

    const tree = getTree(bookName);
    if (tree && newEntry.uid !== undefined) {
        const targetNodeId = findBestNodeForTitle(tree, title);
        const targetNode = targetNodeId ? findNodeById(tree, targetNodeId) : tree;
        if (targetNode) addEntryToNode(targetNode, newEntry.uid);
        if (isTrackerTitle(title)) setTrackerUid(bookName, newEntry.uid);
        saveTree(bookName, tree);
    }

    return { uid: newEntry.uid, title, bookName };
}

function findBestNodeForTitle(tree, title) {
    if (!tree) return null;
    const lower = (title || '').toLowerCase();
    const waypointKeywords = {
        character: ['character', 'npc', 'person', 'protagonist', 'antagonist'],
        location: ['location', 'place', 'city', 'town', 'room', 'area', 'dungeon'],
        tracker: ['tracker', 'status', 'inventory', 'mood', 'state'],
        summary: ['summary', 'recap', 'event', 'scene', 'arc'],
        rule: ['rule', 'mechanic', 'system', 'magic', 'combat', 'skill'],
    };
    for (const child of tree.children || []) {
        const childLower = child.name.toLowerCase();
        for (const [prefix, keywords] of Object.entries(waypointKeywords)) {
            if (keywords.some(kw => lower.includes(kw)) && childLower.includes(prefix)) {
                return child.id;
            }
        }
    }
    return null;
}

export function updateEntry(bookName, uid, newContent, newTitle) {
    return withWriteLock(async () => {
        const bookData = await loadWI(bookName);
        if (!bookData) throw new Error(`Lorebook "${bookName}" not found.`);
        const entry = findEntryByUid(bookData.entries, uid);
        if (!entry) throw new Error(`Entry UID ${uid} not found in "${bookName}".`);
        if (typeof newContent === 'string') entry.content = newContent;
        if (typeof newTitle === 'string') entry.comment = newTitle;
        await saveWI(bookName, bookData, true);
        return { uid, bookName };
    });
}

export function forgetEntry(bookName, uid, hardDelete = false) {
    return withWriteLock(async () => {
        const bookData = await loadWI(bookName);
        if (!bookData) throw new Error(`Lorebook "${bookName}" not found.`);
        const entry = findEntryByUid(bookData.entries, uid);
        if (!entry) throw new Error(`Entry UID ${uid} not found in "${bookName}".`);
        if (hardDelete) {
            const key = Object.keys(bookData.entries).find(k => bookData.entries[k] === entry);
            if (key) delete bookData.entries[key];
        } else {
            entry.disable = true;
        }
        await saveWI(bookName, bookData, true);
        const tree = getTree(bookName);
        if (tree) {
            removeEntryFromTree(tree, uid);
            saveTree(bookName, tree);
        }
        return { uid, bookName, deleted: hardDelete, disabled: !hardDelete };
    });
}

export async function moveEntry(bookName, uid, targetNodeId) {
    const tree = getTree(bookName);
    if (!tree) throw new Error(`No tree for "${bookName}".`);
    const targetNode = findNodeById(tree, targetNodeId);
    if (!targetNode) throw new Error(`Waypoint ${targetNodeId} not found in "${bookName}". Use Search to list valid waypoint IDs.`);
    removeEntryFromTree(tree, uid);
    addEntryToNode(targetNode, uid);
    saveTree(bookName, tree);
    return { uid, targetNodeId, bookName };
}

export async function createCategory(bookName, parentNodeId, name, description = '') {
    const tree = getTree(bookName);
    if (!tree) throw new Error(`No tree for "${bookName}".`);
    const newNode = createTreeNode(name, description);
    const parent = parentNodeId ? findNodeById(tree, parentNodeId) : tree;
    if (!parent) throw new Error(`Parent node ${parentNodeId} not found.`);
    if (!Array.isArray(parent.children)) parent.children = [];
    parent.children.push(newNode);
    saveTree(bookName, tree);
    return { nodeId: newNode.id, name, bookName };
}

export function findEntry(entries, uid) {
    if (!entries) return null;
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
        .filter(Boolean)
        .map(e => ({ uid: e.uid, title: e.comment || e.key?.[0] || '', content: e.content || '' }));
}

export function mergeEntries(bookName, uid1, uid2, mergedTitle) {
    return withWriteLock(async () => {
        if (uid1 === uid2) throw new Error('Cannot merge an entry with itself: "uid1" and "uid2" must differ.');
        const bookData = await loadWI(bookName);
        if (!bookData) throw new Error(`Lorebook "${bookName}" not found.`);
        const e1 = findEntryByUid(bookData.entries, uid1);
        const e2 = findEntryByUid(bookData.entries, uid2);
        if (!e1 || !e2) throw new Error('One or both entries not found.');
        e1.content = `${e1.content}\n\n---\n\n${e2.content}`;
        if (mergedTitle) e1.comment = mergedTitle;
        else e1.comment = (e1.comment || '') + ' + ' + (e2.comment || '');
        const key2 = Object.keys(bookData.entries).find(k => bookData.entries[k] === e2);
        if (key2) delete bookData.entries[key2];
        await saveWI(bookName, bookData, true);
        const tree = getTree(bookName);
        if (tree) {
            removeEntryFromTree(tree, uid2);
            saveTree(bookName, tree);
        }
        return { mergedUid: uid1, removedUid: uid2, bookName };
    });
}

export function splitEntry(bookName, uid, splitTitle1, content1, splitTitle2, content2) {
    return withWriteLock(async () => {
        const bookData = await loadWI(bookName);
        if (!bookData) throw new Error(`Lorebook "${bookName}" not found.`);
        const original = findEntryByUid(bookData.entries, uid);
        if (!original) throw new Error(`Entry UID ${uid} not found.`);
        original.content = content1;
        original.comment = splitTitle1 || original.comment;
        const newEntry = await createWIE(bookName, bookData);
        assertCreatedEntry(newEntry, bookName);
        newEntry.content = content2;
        newEntry.comment = splitTitle2 || 'Split entry';
        newEntry.key = original.key ? [...original.key] : [splitTitle2?.toLowerCase() || 'split'];
        newEntry.selective = false;
        newEntry.constant = false;
        newEntry.disable = false;
        await saveWI(bookName, bookData, true);
        const tree = getTree(bookName);
        if (tree) {
            const parent = findParentOfEntry(tree, uid);
            if (parent) addEntryToNode(parent, newEntry.uid);
            saveTree(bookName, tree);
        }
        return { originalUid: uid, newUid: newEntry.uid, bookName };
    });
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
