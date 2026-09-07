import { createTreeNode, getRuntimeNodeId } from './tree-store.js';

export const LAYOUT_KEY = 'sillybunny_pathfinder';
const MAX_NODES = 2048;
const MAX_DEPTH = 32;
const MAX_SIZE = 262144;
const ID_PATTERN = /^[a-zA-Z0-9_-]{1,128}$/;

function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function getLayoutData(bookData) {
    const native = bookData?.extensions;
    return native && Object.hasOwn(native, LAYOUT_KEY)
        ? native[LAYOUT_KEY]
        : bookData?.originalData?.extensions?.[LAYOUT_KEY];
}

// Unknown versions/fields remain opaque: reading can fall back, but writing must
// not replace an imported layout we cannot faithfully round-trip.
function isValidLayout(layout) {
    if (!isRecord(layout) || layout.version !== 1 || Object.keys(layout).some(key => !['version', 'tree'].includes(key))) return false;
    const ids = new Set();
    const pending = [[layout.tree, 0]];
    let size = 0;
    while (pending.length) {
        const [node, depth] = pending.pop();
        if (!isRecord(node) || depth > MAX_DEPTH || ids.size >= MAX_NODES
            || typeof node.id !== 'string' || !ID_PATTERN.test(node.id) || ids.has(node.id)
            || typeof node.name !== 'string' || node.name.length > 1024
            || typeof node.description !== 'string' || node.description.length > 4096
            || !Array.isArray(node.children) || node.children.length > MAX_NODES
            || (node.generatedCategory !== undefined && (typeof node.generatedCategory !== 'string' || node.generatedCategory.length > 128))
            || Object.keys(node).some(key => !['id', 'name', 'description', 'children', 'generatedCategory'].includes(key))) return false;
        ids.add(node.id);
        size += node.id.length + node.name.length + node.description.length + 64;
        if (size > MAX_SIZE) return false;
        for (const child of node.children) pending.push([child, depth + 1]);
    }
    return JSON.stringify(layout).length <= MAX_SIZE;
}

// undefined means absent; null means present but unsafe to rewrite.
export function readTreeLayout(bookData) {
    const layout = getLayoutData(bookData);
    if (layout === undefined) return undefined;
    return isValidLayout(layout) ? layout.tree : null;
}

export function createLayoutNode(bookName, name, description = '', localId = null) {
    const node = createTreeNode(name, description);
    node.localId = localId ?? node.id;
    node.id = getRuntimeNodeId(bookName, node.localId);
    return node;
}

export function getEntryPlacement(entry) {
    const placement = entry?.extensions?.[LAYOUT_KEY];
    return isRecord(placement) && placement.version === 1 && typeof placement.nodeId === 'string' && ID_PATTERN.test(placement.nodeId)
        ? placement.nodeId : null;
}

export function setEntryPlacement(entry, node) {
    if ((entry.extensions !== undefined && !isRecord(entry.extensions))
        || (entry.extensions && Object.hasOwn(entry.extensions, LAYOUT_KEY) && !getEntryPlacement(entry))) {
        throw new Error('Cannot move unsupported or invalid waypoint placement.');
    }
    entry.extensions ??= {};
    entry.extensions[LAYOUT_KEY] = { ...entry.extensions[LAYOUT_KEY], version: 1, nodeId: node.localId };
}

export function syncBookLayoutMetadata(bookData) {
    const layout = getLayoutData(bookData);
    if (layout === undefined) return;
    if ((bookData.extensions !== undefined && !isRecord(bookData.extensions))
        || (bookData.originalData?.extensions !== undefined && !isRecord(bookData.originalData.extensions))) {
        throw new Error('Invalid format found inside the lorebook\u2019s additional data; unable to save while preserving.');
    }
    bookData.extensions ??= {};
    bookData.extensions[LAYOUT_KEY] = structuredClone(layout);
    if (bookData.originalData) {
        bookData.originalData.extensions ??= {};
        bookData.originalData.extensions[LAYOUT_KEY] = structuredClone(layout);
    }
}

export function writeTreeLayout(bookData, tree) {
    if (readTreeLayout(bookData) === null) throw new Error('The saved waypoint layout is damaged or uses an unsupported format and will not be overwritten.');
    let count = 0;
    const serialize = (node, depth = 0) => {
        if (depth > MAX_DEPTH || ++count > MAX_NODES) throw new Error('The waypoint layout has too many categories or nested levels.');
        return {
            id: node.localId,
            name: node.name,
            description: node.description || '',
            ...(node.generatedCategory === undefined ? {} : { generatedCategory: node.generatedCategory }),
            children: (node.children || []).map(child => serialize(child, depth + 1)),
        };
    };
    const layout = { version: 1, tree: serialize(tree) };
    if (!isValidLayout(layout) || (bookData.extensions !== undefined && !isRecord(bookData.extensions))) throw new Error('The proposed waypoint layout fails and cannot be saved.');
    bookData.extensions ??= {};
    bookData.extensions[LAYOUT_KEY] = layout;
    syncBookLayoutMetadata(bookData);
}
