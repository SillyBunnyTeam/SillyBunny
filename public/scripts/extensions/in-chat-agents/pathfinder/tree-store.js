import { listConnectionProfiles as listSupportedConnectionProfiles } from '../profile-utils.js';

export const generateNodeId = () => 'node_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

export const createTreeNode = (name = '', description = '', entries = [], children = []) => ({
    id: generateNodeId(),
    name,
    description: description || '',
    entries: entries || [],
    children: children || [],
});

export const createEmptyTree = () => createTreeNode('Root', 'Top-level waypoint map');

export const SETTING_DEFAULTS = {
    globalEnable: false,
    searchMode: 'traversal',
    recurseLimit: 5,
    mandatoryTools: false,
    dedupDetection: false,
    dedupThreshold: 0.85,
    autoSummary: false,
    autoSummaryInterval: 20,
    multiBookMode: 'unified',
    ephemeralResults: true,
    sidecarEnabled: false,
    enabledLorebooks: [],
    includeContextualLorebooks: true,
    autoUseAttachedLorebook: false,
    autoSyncLorebooksOnChatChange: true,
    dedupeNaturalActivation: true,
    toolStates: {},
    bookPermissions: {},
    confirmTools: {},
    // Pipeline settings
    pipelineEnabled: false,
    pipelineId: 'default',
    skipSecondPass: false,
    maxCandidates: 20,
    entryContentMode: 'full',  // 'full' | 'truncated'
    truncateLength: 500,
    retrievalTimeoutSeconds: 8,
    // Per-prompt storage (managed by prompt-store.js)
    pipelinePrompts: {},
    pipelines: {},
};

let settings = { ...SETTING_DEFAULTS };

export function normalizeAutoSummaryInterval(value) {
    return Math.max(2, Math.min(200, parseInt(value, 10) || SETTING_DEFAULTS.autoSummaryInterval));
}

export function getSettings() {
    if (!settings) {
        settings = { ...SETTING_DEFAULTS };
    }
    return settings;
}

export function setSettings(newSettings) {
    const nextSettings = { ...SETTING_DEFAULTS, ...settings, ...(newSettings || {}) };
    for (const key of ['toolStates', 'bookPermissions', 'pipelinePrompts', 'pipelines']) {
        nextSettings[key] = {
            ...(SETTING_DEFAULTS[key] || {}),
            ...(settings?.[key] || {}),
            ...(newSettings?.[key] || {}),
        };
    }
    settings = nextSettings;
}

/**
 * Replace the settings wholesale instead of merging over the previous
 * object. setSettings can never clear a key, so switching Pathfinder
 * agents would leak the previous agent's lorebooks and permissions.
 */
export function replaceSettings(newSettings) {
    settings = { ...SETTING_DEFAULTS };
    setSettings(newSettings);
}

const trees = new Map();

// Lets the WORLDINFO_UPDATED handler distinguish Pathfinder's own saves
// (tree already maintained in place) from external edits (tree must be
// invalidated). Relies on the host emitting the event within the awaited save.
let selfWriteDepth = 0;

export function beginPathfinderSelfWrite() {
    selfWriteDepth++;
}

export function endPathfinderSelfWrite() {
    selfWriteDepth = Math.max(0, selfWriteDepth - 1);
}

export function isPathfinderSelfWrite() {
    return selfWriteDepth > 0;
}

export function getTree(bookName) {
    return trees.get(bookName) ?? null;
}

export function saveTree(bookName, tree) {
    trees.set(bookName, tree);
}

export function deleteTree(bookName) {
    trees.delete(bookName);
}

export function findNodeById(tree, nodeId) {
    if (!tree || !nodeId) return null;
    if (tree.id === nodeId) return tree;
    for (const child of tree.children || []) {
        const found = findNodeById(child, nodeId);
        if (found) return found;
    }
    return null;
}

export function findParentNode(tree, nodeId) {
    if (!tree || !nodeId) return null;
    for (const child of tree.children || []) {
        if (child.id === nodeId) return tree;
        const found = findParentNode(child, nodeId);
        if (found) return found;
    }
    return null;
}

export function removeNode(tree, nodeId) {
    if (!tree || !nodeId) return false;
    const idx = (tree.children || []).findIndex(c => c.id === nodeId);
    if (idx >= 0) {
        tree.children.splice(idx, 1);
        return true;
    }
    for (const child of tree.children || []) {
        if (removeNode(child, nodeId)) return true;
    }
    return false;
}

export function addEntryToNode(node, uid) {
    if (!node) return;
    if (!Array.isArray(node.entries)) node.entries = [];
    if (!node.entries.includes(uid)) node.entries.push(uid);
}

export function removeEntryFromTree(tree, uid) {
    if (!tree) return false;
    let removed = false;
    if (Array.isArray(tree.entries)) {
        const idx = tree.entries.indexOf(uid);
        if (idx >= 0) { tree.entries.splice(idx, 1); removed = true; }
    }
    for (const child of tree.children || []) {
        if (removeEntryFromTree(child, uid)) removed = true;
    }
    return removed;
}

export function getAllEntryUids(tree) {
    if (!tree) return [];
    const uids = [...(tree.entries || [])];
    for (const child of tree.children || []) {
        uids.push(...getAllEntryUids(child));
    }
    return uids;
}

export function buildTreeDescription(tree, depth = 0) {
    if (!tree) return '';
    const indent = '  '.repeat(depth);
    const entries = (tree.entries || []).length;
    const children = (tree.children || []).length;
    let desc = `${indent}${tree.name || 'Untitled'}`;
    if (entries) desc += ` (${entries} entries)`;
    if (children) desc += ` [${children} sub-waypoints]`;
    let result = desc + '\n';
    for (const child of tree.children || []) {
        result += buildTreeDescription(child, depth + 1);
    }
    return result;
}

export function getEntriesForNodes(tree, nodeIds) {
    if (!tree || !Array.isArray(nodeIds)) return [];
    const uids = new Set();
    for (const nodeId of nodeIds) {
        const node = findNodeById(tree, nodeId);
        if (node) {
            for (const uid of node.entries || []) uids.add(uid);
        }
    }
    return [...uids];
}

export function isTrackerTitle(title) {
    return /^\[Tracker\]/i.test(String(title || '').trim());
}

const trackerUids = new Map();

export function getTrackerUids(bookName) {
    return trackerUids.get(bookName) ?? new Set();
}

export function isTrackerUid(bookName, uid) {
    const uids = trackerUids.get(bookName);
    return uids ? uids.has(uid) : false;
}

export function setTrackerUid(bookName, uid) {
    if (!trackerUids.has(bookName)) trackerUids.set(bookName, new Set());
    trackerUids.get(bookName).add(uid);
}

export function syncTrackerUidsForLorebook(bookName, bookData) {
    if (!bookData || !bookData.entries) return;
    const trackerSet = new Set();
    for (const [, entry] of Object.entries(bookData.entries)) {
        if (entry && isTrackerTitle(entry.comment || entry.key?.[0])) {
            trackerSet.add(entry.uid);
        }
    }
    trackerUids.set(bookName, trackerSet);
}

export function getSelectedLorebook() {
    const s = getSettings();
    return s.selectedLorebook ?? '';
}

export function setSelectedLorebook(name) {
    const s = getSettings();
    s.selectedLorebook = name;
}

export function isLorebookEnabled(bookName) {
    const s = getSettings();
    return Array.isArray(s.enabledLorebooks) && s.enabledLorebooks.includes(bookName);
}

export function setLorebookEnabled(bookName, enabled) {
    const s = getSettings();
    if (!Array.isArray(s.enabledLorebooks)) s.enabledLorebooks = [];
    if (enabled && !s.enabledLorebooks.includes(bookName)) {
        s.enabledLorebooks.push(bookName);
    } else if (!enabled) {
        s.enabledLorebooks = s.enabledLorebooks.filter(b => b !== bookName);
    }
}

export function getToolStates() {
    const s = getSettings();
    if (!s.toolStates || typeof s.toolStates !== 'object') {
        s.toolStates = {};
    }
    return s.toolStates;
}

export function isPathfinderToolEnabled(toolName, fallback = true) {
    const states = getToolStates();
    if (!Object.prototype.hasOwnProperty.call(states, toolName)) {
        return fallback;
    }

    return states[toolName] !== false;
}

export function setPathfinderToolEnabled(toolName, enabled) {
    const states = getToolStates();
    states[toolName] = Boolean(enabled);
}

export function getBookDescription(bookName) {
    const tree = getTree(bookName);
    return tree?.description ?? '';
}

export function setBookDescription(bookName, desc) {
    const tree = getTree(bookName);
    if (tree) tree.description = desc;
}

export function getConnectionProfileId() {
    return getSettings().connectionProfile ?? '';
}

export function setConnectionProfileId(id) {
    getSettings().connectionProfile = id ?? '';
}

export function findConnectionProfile(profileId) {
    const profiles = listSupportedConnectionProfiles();
    return profiles.find(p => p.id === profileId) ?? null;
}

export function listConnectionProfiles() {
    return listSupportedConnectionProfiles();
}

export function getBookPermission(bookName, permission) {
    const s = getSettings();
    const perms = s.bookPermissions?.[bookName];
    return perms?.[permission] ?? 'readwrite';
}

export function setBookPermission(bookName, permission, value) {
    const s = getSettings();
    if (!s.bookPermissions) s.bookPermissions = {};
    if (!s.bookPermissions[bookName]) s.bookPermissions[bookName] = {};
    s.bookPermissions[bookName][permission] = value;
}

function isPermissionAllowed(value) {
    if (value === undefined || value === null) {
        return true;
    }

    if (typeof value === 'boolean') {
        return value;
    }

    if (typeof value === 'number') {
        return value !== 0;
    }

    const normalized = String(value).trim().toLowerCase();
    return !['none', 'false', 'off', 'deny', 'denied', 'no', '0', 'disabled'].includes(normalized);
}

export function canReadBook(bookName) {
    const perm = getBookPermission(bookName, 'read');
    return isPermissionAllowed(perm);
}

export function canWriteBook(bookName) {
    const perm = getBookPermission(bookName, 'write');
    return isPermissionAllowed(perm);
}

export function canDeleteBook(bookName) {
    const perm = getBookPermission(bookName, 'delete');
    return isPermissionAllowed(perm);
}
