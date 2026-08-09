import { updateEntry } from '../entry-manager.js';
import { getUnknownBookError, getWritableBooks, resolveTargetBook, TOOL_NAMES } from '../pathfinder-tool-bridge.js';
import { registerToolAction, registerToolFormatter } from '../../tool-action-registry.js';
import { logToolCallStarted, logToolCallCompleted, logToolCallError } from '../activity-feed.js';

const COMPACT_DESCRIPTION = 'Edit an existing lorebook entry when information changes.';

async function updateAction(args) {
    const uid = Number(args.uid);
    const newContent = String(args.content || '').trim();
    const newTitle = String(args.title || '').trim();
    const bookName = String(args.book || '').trim();

    logToolCallStarted(TOOL_NAMES.UPDATE, { uid, bookName });

    if (!uid && uid !== 0) {
        logToolCallError(TOOL_NAMES.UPDATE, 'Missing UID');
        return 'Error: "uid" is required. Use Search first to find the entry UID.';
    }

    if (!newContent && !newTitle) {
        logToolCallError(TOOL_NAMES.UPDATE, 'Nothing to update');
        return 'Error: Provide at least "content" or "title" to update.';
    }

    const writableBooks = getWritableBooks();
    const bookError = getUnknownBookError(bookName, writableBooks);
    if (bookError) {
        logToolCallError(TOOL_NAMES.UPDATE, `Unknown book: ${bookName}`);
        return bookError;
    }

    const targetBook = resolveTargetBook(bookName, writableBooks);
    if (!targetBook) {
        logToolCallError(TOOL_NAMES.UPDATE, 'No writable lorebooks');
        return 'No Pathfinder-enabled lorebooks available for writing.';
    }

    try {
        await updateEntry(targetBook, uid, newContent || undefined, newTitle || undefined);
        logToolCallCompleted(TOOL_NAMES.UPDATE, `Updated UID:${uid}`);
        return `✏️ Updated entry UID:${uid} in "${targetBook}".`;
    } catch (err) {
        logToolCallError(TOOL_NAMES.UPDATE, err.message);
        return `❌ Failed to update: ${err.message}`;
    }
}

async function updateFormatter(args) {
    return `✏️ Pathfinder: Updating entry UID:${args.uid}...`;
}

export function getDefinition() {
    return {
        name: TOOL_NAMES.UPDATE,
        displayName: 'Pathfinder Update',
        description: COMPACT_DESCRIPTION,
        parameters: {
            type: 'object',
            required: ['uid'],
            properties: {
                uid: { type: 'number', description: 'UID of the entry to update (found via Search)' },
                content: { type: 'string', description: 'New content for the entry. Omit to keep existing.' },
                title: { type: 'string', description: 'New title for the entry. Omit to keep existing.' },
                book: { type: 'string', description: 'Lorebook name. Omit for default.' },
            },
        },
        actionKey: 'pathfinder_update',
        formatMessageKey: 'pathfinder_update_fmt',
        shouldRegister: true,
        stealth: false,
        enabled: true,
    };
}

export function registerActions() {
    registerToolAction('pathfinder_update', updateAction);
    registerToolFormatter('pathfinder_update_fmt', updateFormatter);
}
