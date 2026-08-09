import { getTree, findNodeById, getSettings } from '../tree-store.js';
import { getReadableBooks, TOOL_NAMES, getBookListWithDescriptions } from '../pathfinder-tool-bridge.js';
import { buildTreeFromMetadata } from '../tree-builder.js';
import { registerToolAction, registerToolFormatter } from '../../tool-action-registry.js';
import { logToolCallStarted, logToolCallCompleted, logToolCallError } from '../activity-feed.js';

const COMPACT_DESCRIPTION = 'Navigate the lorebook waypoint map and retrieve relevant entries for the current scene.';

function getTreeOverview(tree, bookName, searchMode = 'traversal') {
    if (!tree) return `No tree built for "${bookName}".`;
    if (searchMode === 'collapsed') {
        return formatCollapsed(tree, 0);
    }
    return formatTopLevel(tree);
}

function formatTopLevel(tree) {
    if (!tree) return '';
    const lines = [];
    for (const child of tree.children || []) {
        const entries = (child.entries || []).length;
        const subWaypoints = (child.children || []).length;
        let line = `🧭 ${child.name}`;
        if (entries) line += ` (${entries} entries)`;
        if (subWaypoints) line += ` [${subWaypoints} sub-waypoints]`;
        if (child.id) line += ` [id: ${child.id}]`;
        lines.push(line);
    }
    return lines.join('\n') || 'No waypoints found.';
}

function formatCollapsed(tree, depth = 0) {
    if (!tree) return '';
    const indent = '  '.repeat(depth);
    const entries = (tree.entries || []).length;
    const subWaypoints = (tree.children || []).length;
    let line = `${indent}${tree.name}`;
    if (entries) line += ` (${entries} entries)`;
    if (subWaypoints) line += ` [${subWaypoints} sub-waypoints]`;
    if (tree.id && depth > 0) line += ` [id: ${tree.id}]`;
    let result = line + '\n';
    for (const child of tree.children || []) {
        result += formatCollapsed(child, depth + 1);
    }
    return result;
}

function formatNodeChildren(node) {
    if (!node) return 'Not found.';
    const lines = [];
    for (const child of node.children || []) {
        const entries = (child.entries || []).length;
        const subWaypoints = (child.children || []).length;
        let line = `🧭 ${child.name}`;
        if (entries) line += ` (${entries} entries)`;
        if (subWaypoints) line += ` [${subWaypoints} sub-waypoints]`;
        if (child.id) line += ` [id: ${child.id}]`;
        lines.push(line);
    }
    for (const uid of node.entries || []) {
        lines.push(`📄 Entry UID:${uid}`);
    }
    return lines.join('\n') || 'No content at this waypoint.';
}

async function searchAction(args) {
    const s = getSettings();
    const nodeId = args.node_id;
    const books = getReadableBooks();

    logToolCallStarted(TOOL_NAMES.SEARCH, args);

    if (books.length === 0) {
        logToolCallError(TOOL_NAMES.SEARCH, 'No readable lorebooks');
        return 'No Pathfinder-enabled lorebooks are available. Enable at least one lorebook in Pathfinder settings.';
    }

    if (!nodeId) {
        const results = [];
        for (const bookName of books) {
            const tree = await getTreeWithAutoBuild(bookName);
            if (!tree) continue;
            results.push(`=== ${bookName} ===\n${getTreeOverview(tree, bookName, s.searchMode)}`);
        }
        const bookList = getBookListWithDescriptions();
        const output = `📊 Pathfinder Waypoint Map\n\n${bookList}\n\n${results.join('\n\n')}\n\nCall this tool again with a specific node_id to drill deeper into a waypoint.`;
        logToolCallCompleted(TOOL_NAMES.SEARCH, output);
        return output;
    }

    let childListing = '';
    let allEntries = [];
    for (const bookName of books) {
        const tree = await getTreeWithAutoBuild(bookName);
        if (!tree) continue;
        const node = findNodeById(tree, nodeId);
        if (!node) continue;

        // A node can hold both sub-waypoints and entries: list the children
        // for navigation AND return the entry contents below.
        if (node.children?.length > 0) {
            childListing = `🧭 ${node.name}\n\n${formatNodeChildren(node)}\n\nDrill further by calling with one of the sub-waypoint IDs.`;
            if (!node.entries?.length) {
                logToolCallCompleted(TOOL_NAMES.SEARCH, childListing);
                return childListing;
            }
        }

        const bookData = await loadWorldInfoSafe(bookName);
        if (!bookData) continue;

        for (const uid of node.entries || []) {
            const entry = findEntrySafe(bookData.entries, uid);
            if (entry) {
                allEntries.push({ bookName, uid, title: entry.comment || entry.key?.[0] || '', content: entry.content || '' });
            }
        }
    }

    if (allEntries.length === 0) {
        if (childListing) {
            logToolCallCompleted(TOOL_NAMES.SEARCH, childListing);
            return childListing;
        }
        logToolCallCompleted(TOOL_NAMES.SEARCH, 'No entries found at this waypoint.');
        return 'No entries found at this waypoint. Try navigating to a different node.';
    }

    const contents = allEntries.map(e => `--- ${e.title} (UID:${e.uid}) [${e.bookName}] ---\n${e.content}`).join('\n\n');
    const output = childListing ? `${childListing}\n\n${contents}` : contents;
    logToolCallCompleted(TOOL_NAMES.SEARCH, output);
    return output;
}

async function loadWorldInfoSafe(name) {
    try {
        const ctx = window?.SillyTavern?.getContext?.();
        // await inside the try: a rejected promise returned without await
        // would bypass this catch entirely
        return await ctx?.loadWorldInfo?.(name);
    } catch {
        return null;
    }
}

async function getTreeWithAutoBuild(bookName) {
    const cachedTree = getTree(bookName);
    if (cachedTree) {
        return cachedTree;
    }

    const bookData = await loadWorldInfoSafe(bookName);
    if (!bookData?.entries) {
        return null;
    }

    return await buildTreeFromMetadata(bookName, bookData);
}

function findEntrySafe(entries, uid) {
    if (!entries) return null;
    for (const [, entry] of Object.entries(entries)) {
        if (entry && entry.uid === uid) return entry;
    }
    return null;
}

async function searchFormatter(args) {
    return '🔍 Pathfinder: Searching lorebook waypoints...';
}

export function getDefinition() {
    return {
        name: TOOL_NAMES.SEARCH,
        displayName: 'Pathfinder Search',
        description: COMPACT_DESCRIPTION,
        parameters: {
            type: 'object',
            properties: {
                node_id: {
                    type: 'string',
                    description: 'ID of the waypoint/node to navigate into. Omit to see the top-level waypoint map.',
                },
            },
        },
        actionKey: 'pathfinder_search',
        formatMessageKey: 'pathfinder_search_fmt',
        shouldRegister: true,
        stealth: false,
        enabled: true,
    };
}

export function registerActions() {
    registerToolAction('pathfinder_search', searchAction);
    registerToolFormatter('pathfinder_search_fmt', searchFormatter);
}
