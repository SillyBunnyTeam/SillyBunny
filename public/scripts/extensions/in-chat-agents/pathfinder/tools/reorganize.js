import { moveEntry, createCategory } from '../entry-manager.js';
import { getUnknownBookError, getWritableBooks, resolveTargetBook, TOOL_NAMES } from '../pathfinder-tool-bridge.js';
import { registerToolAction, registerToolFormatter } from '../../tool-action-registry.js';
import { logToolCallStarted, logToolCallCompleted, logToolCallError } from '../activity-feed.js';

const COMPACT_DESCRIPTION = 'Move entries between waypoints or create new waypoints to reorganize the lorebook.';

async function reorganizeAction(args) {
    const action = String(args.action || '').trim().toLowerCase();
    const bookName = String(args.book || '').trim();

    logToolCallStarted(TOOL_NAMES.REORGANIZE, { action, bookName });

    if (!action) {
        logToolCallError(TOOL_NAMES.REORGANIZE, 'Missing action');
        return 'Error: "action" is required. Use "move" or "create_waypoint".';
    }

    const writableBooks = getWritableBooks();
    const bookError = getUnknownBookError(bookName, writableBooks);
    if (bookError) {
        logToolCallError(TOOL_NAMES.REORGANIZE, `Unknown book: ${bookName}`);
        return bookError;
    }

    const targetBook = resolveTargetBook(bookName, writableBooks);
    if (!targetBook) {
        logToolCallError(TOOL_NAMES.REORGANIZE, 'No writable lorebooks');
        return 'No Pathfinder-enabled lorebooks available.';
    }

    try {
        if (action === 'move') {
            const uid = Number(args.uid);
            const targetNodeId = String(args.target_node_id || '').trim();
            if (!uid && uid !== 0) return 'Error: "uid" required for move.';
            if (!targetNodeId) return 'Error: "target_node_id" required for move.';
            await moveEntry(targetBook, uid, targetNodeId);
            logToolCallCompleted(TOOL_NAMES.REORGANIZE, `Moved UID:${uid} to ${targetNodeId}`);
            return `🔀 Moved entry UID:${uid} to waypoint ${targetNodeId} in "${targetBook}".`;
        }

        if (action === 'create_waypoint') {
            const name = String(args.name || '').trim();
            const parentNodeId = String(args.parent_node_id || '').trim() || null;
            const description = String(args.description || '').trim();
            if (!name) return 'Error: "name" required for create_waypoint.';
            const result = await createCategory(targetBook, parentNodeId, name, description);
            logToolCallCompleted(TOOL_NAMES.REORGANIZE, `Created waypoint: ${name}`);
            return `🔀 Created waypoint "${name}" (ID: ${result.nodeId}) in "${targetBook}".${parentNodeId ? ` Under node ${parentNodeId}.` : ' At top level.'}`;
        }

        logToolCallError(TOOL_NAMES.REORGANIZE, `Unknown action: ${action}`);
        return `Unknown action: "${action}". Use "move" or "create_waypoint".`;
    } catch (err) {
        logToolCallError(TOOL_NAMES.REORGANIZE, err.message);
        return `❌ Failed to reorganize: ${err.message}`;
    }
}

async function reorganizeFormatter(args) {
    return '🔀 Pathfinder: Reorganizing lorebook...';
}

export function getDefinition() {
    return {
        name: TOOL_NAMES.REORGANIZE,
        displayName: 'Pathfinder Reorganize',
        description: COMPACT_DESCRIPTION,
        parameters: {
            type: 'object',
            required: ['action'],
            properties: {
                action: { type: 'string', enum: ['move', 'create_waypoint'], description: '"move" to relocate an entry, "create_waypoint" to make a new waypoint' },
                uid: { type: 'number', description: 'Entry UID to move (for "move" action)' },
                target_node_id: { type: 'string', description: 'Target waypoint node ID (for "move" action)' },
                name: { type: 'string', description: 'New waypoint name (for "create_waypoint" action)' },
                parent_node_id: { type: 'string', description: 'Parent waypoint ID. Omit for top level.' },
                description: { type: 'string', description: 'Description for new waypoint.' },
                book: { type: 'string', description: 'Lorebook name. Omit for default.' },
            },
        },
        actionKey: 'pathfinder_reorganize',
        formatMessageKey: 'pathfinder_reorganize_fmt',
        shouldRegister: true,
        stealth: false,
        enabled: true,
    };
}

export function registerActions() {
    registerToolAction('pathfinder_reorganize', reorganizeAction);
    registerToolFormatter('pathfinder_reorganize_fmt', reorganizeFormatter);
}
