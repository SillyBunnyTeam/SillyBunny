import { getSettings } from '../tree-store.js';
import { createEntry } from '../entry-manager.js';
import { getWritableBooks, resolveTargetBook, TOOL_NAMES } from '../pathfinder-tool-bridge.js';
import { registerToolAction, registerToolFormatter } from '../../tool-action-registry.js';
import { logToolCallStarted, logToolCallCompleted, logToolCallError } from '../activity-feed.js';

const COMPACT_DESCRIPTION = 'Create a new lorebook entry to remember information for future reference.';

function trigramSimilarity(a, b) {
    const trigrams = (str) => {
        const s = String(str || '').toLowerCase();
        const set = new Set();
        for (let i = 0; i < s.length - 2; i++) set.add(s.slice(i, i + 3));
        return set;
    };
    const ta = trigrams(a);
    const tb = trigrams(b);
    if (ta.size === 0 || tb.size === 0) return 0;
    let intersection = 0;
    for (const t of ta) { if (tb.has(t)) intersection++; }
    return intersection / Math.max(ta.size, tb.size);
}

async function rememberAction(args) {
    const settings = getSettings();
    const title = String(args.title || '').trim();
    const content = String(args.content || '').trim();
    const bookName = String(args.book || '').trim();

    logToolCallStarted(TOOL_NAMES.REMEMBER, { title, bookName });

    if (!title || !content) {
        logToolCallError(TOOL_NAMES.REMEMBER, 'Missing title or content');
        return 'Error: Both "title" and "content" are required.';
    }

    const writableBooks = getWritableBooks();
    const targetBook = resolveTargetBook(bookName, writableBooks);

    if (!targetBook) {
        logToolCallError(TOOL_NAMES.REMEMBER, 'No writable lorebooks');
        return 'No Pathfinder-enabled lorebooks available for writing. Enable at least one lorebook.';
    }

    if (settings.dedupDetection) {
        try {
            const ctx = window?.SillyTavern?.getContext?.();
            const bookData = await ctx?.loadWorldInfo?.(targetBook);
            if (bookData?.entries) {
                for (const [, entry] of Object.entries(bookData.entries)) {
                    if (entry && !entry.disable) {
                        const sim = trigramSimilarity(entry.content || '', content);
                        if (sim >= (settings.dedupThreshold || 0.85)) {
                            logToolCallError(TOOL_NAMES.REMEMBER, `Duplicate of UID ${entry.uid}`);
                            return `⚠️ Not saved: a similar entry already exists — "${entry.comment || entry.key?.[0]}" (UID: ${entry.uid}, similarity: ${(sim * 100).toFixed(0)}%). Use the Update tool with that UID to add the new details instead.`;
                        }
                    }
                }
            }
        } catch (err) {
            console.warn('[Pathfinder] Dedup check failed:', err);
        }
    }

    try {
        const result = await createEntry(targetBook, title, content);
        logToolCallCompleted(TOOL_NAMES.REMEMBER, `Created: ${title}`);
        return `✅ Remembered "${title}" in lorebook "${targetBook}" (UID: ${result.uid}). The entry is filed under the appropriate waypoint.`;
    } catch (err) {
        logToolCallError(TOOL_NAMES.REMEMBER, err.message);
        return `❌ Failed to remember: ${err.message}`;
    }
}

async function rememberFormatter(args) {
    return `💾 Pathfinder: Creating memory "${args.title || 'untitled'}"...`;
}

export function getDefinition() {
    return {
        name: TOOL_NAMES.REMEMBER,
        displayName: 'Pathfinder Remember',
        description: COMPACT_DESCRIPTION,
        parameters: {
            type: 'object',
            required: ['title', 'content'],
            properties: {
                title: { type: 'string', description: 'Title for the new entry (e.g., "Sable - Personality" or "[Tracker] Mood")' },
                content: { type: 'string', description: 'Full content to remember' },
                book: { type: 'string', description: 'Target lorebook name. Omit to use the default.' },
            },
        },
        actionKey: 'pathfinder_remember',
        formatMessageKey: 'pathfinder_remember_fmt',
        shouldRegister: true,
        stealth: false,
        enabled: true,
    };
}

export function registerActions() {
    registerToolAction('pathfinder_remember', rememberAction);
    registerToolFormatter('pathfinder_remember_fmt', rememberFormatter);
}
