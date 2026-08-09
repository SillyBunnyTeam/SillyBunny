import { mergeEntries, splitEntry } from '../entry-manager.js';
import { getUnknownBookError, getWritableBooks, resolveTargetBook, TOOL_NAMES } from '../pathfinder-tool-bridge.js';
import { registerToolAction, registerToolFormatter } from '../../tool-action-registry.js';
import { logToolCallStarted, logToolCallCompleted, logToolCallError } from '../activity-feed.js';

const COMPACT_DESCRIPTION = 'Merge related entries together or split a long entry into two.';

async function mergeSplitAction(args) {
    const action = String(args.action || '').trim().toLowerCase();
    const bookName = String(args.book || '').trim();

    logToolCallStarted(TOOL_NAMES.MERGE_SPLIT, { action, bookName });

    if (!action) {
        logToolCallError(TOOL_NAMES.MERGE_SPLIT, 'Missing action');
        return 'Error: "action" is required. Use "merge" or "split".';
    }

    const writableBooks = getWritableBooks();
    const bookError = getUnknownBookError(bookName, writableBooks);
    if (bookError) {
        logToolCallError(TOOL_NAMES.MERGE_SPLIT, `Unknown book: ${bookName}`);
        return bookError;
    }

    const targetBook = resolveTargetBook(bookName, writableBooks);
    if (!targetBook) {
        logToolCallError(TOOL_NAMES.MERGE_SPLIT, 'No writable lorebooks');
        return 'No Pathfinder-enabled lorebooks available.';
    }

    try {
        if (action === 'merge') {
            const uid1 = Number(args.uid1);
            const uid2 = Number(args.uid2);
            const mergedTitle = String(args.merged_title || '').trim();
            if ((!uid1 && uid1 !== 0) || (!uid2 && uid2 !== 0)) {
                return 'Error: "uid1" and "uid2" required for merge.';
            }
            const result = await mergeEntries(targetBook, uid1, uid2, mergedTitle || undefined);
            logToolCallCompleted(TOOL_NAMES.MERGE_SPLIT, `Merged UID:${uid1} + UID:${uid2}`);
            return `✂️ Merged UID:${uid1} and UID:${uid2} into "${result.mergedUid}" in "${targetBook}". UID:${uid2} removed.`;
        }

        if (action === 'split') {
            const uid = Number(args.uid);
            const title1 = String(args.title1 || '').trim();
            const content1 = String(args.content1 || '').trim();
            const title2 = String(args.title2 || '').trim();
            const content2 = String(args.content2 || '').trim();
            if (!uid && uid !== 0) return 'Error: "uid" required for split.';
            if (!content1 || !content2) return 'Error: "content1" and "content2" required for split.';
            const result = await splitEntry(targetBook, uid, title1, content1, title2, content2);
            logToolCallCompleted(TOOL_NAMES.MERGE_SPLIT, `Split UID:${uid}`);
            return `✂️ Split UID:${uid} into UID:${result.originalUid} and UID:${result.newUid} in "${targetBook}".`;
        }

        logToolCallError(TOOL_NAMES.MERGE_SPLIT, `Unknown action: ${action}`);
        return `Unknown action: "${action}". Use "merge" or "split".`;
    } catch (err) {
        logToolCallError(TOOL_NAMES.MERGE_SPLIT, err.message);
        return `❌ Failed: ${err.message}`;
    }
}

async function mergeSplitFormatter(args) {
    return `✂️ Pathfinder: ${args.action === 'merge' ? 'Merging' : 'Splitting'} entries...`;
}

export function getDefinition() {
    return {
        name: TOOL_NAMES.MERGE_SPLIT,
        displayName: 'Pathfinder Merge/Split',
        description: COMPACT_DESCRIPTION,
        parameters: {
            type: 'object',
            required: ['action'],
            properties: {
                action: { type: 'string', enum: ['merge', 'split'], description: '"merge" to combine entries, "split" to divide one' },
                uid1: { type: 'number', description: 'First entry UID (for merge)' },
                uid2: { type: 'number', description: 'Second entry UID (for merge)' },
                merged_title: { type: 'string', description: 'Title for the merged entry (optional)' },
                uid: { type: 'number', description: 'Entry UID to split (for split)' },
                title1: { type: 'string', description: 'Title for first part (for split)' },
                content1: { type: 'string', description: 'Content for first part (for split)' },
                title2: { type: 'string', description: 'Title for second part (for split)' },
                content2: { type: 'string', description: 'Content for second part (for split)' },
                book: { type: 'string', description: 'Lorebook name. Omit for default.' },
            },
        },
        actionKey: 'pathfinder_merge_split',
        formatMessageKey: 'pathfinder_merge_split_fmt',
        shouldRegister: true,
        stealth: false,
        enabled: true,
    };
}

export function registerActions() {
    registerToolAction('pathfinder_merge_split', mergeSplitAction);
    registerToolFormatter('pathfinder_merge_split_fmt', mergeSplitFormatter);
}
