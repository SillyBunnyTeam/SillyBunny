import { getActiveTunnelVisionBooks, TOOL_NAMES } from '../pathfinder-tool-bridge.js';
import { registerToolAction, registerToolFormatter } from '../../tool-action-registry.js';
import { logToolCallStarted, logToolCallCompleted, logToolCallError } from '../activity-feed.js';

const NOTEBOOK_KEY = 'pathfinder_notebook';

const COMPACT_DESCRIPTION = 'Write to or read from a private AI scratchpad for plans, follow-ups, and narrative threads.';

function getNotebookData() {
    const ctx = window?.SillyTavern?.getContext?.();
    const metadata = ctx?.chatMetadata ?? ctx?.chat_metadata;
    if (!metadata) return null;
    if (!metadata[NOTEBOOK_KEY]) {
        metadata[NOTEBOOK_KEY] = { entries: [], updated: Date.now() };
    }
    return metadata[NOTEBOOK_KEY];
}

function saveNotebookData() {
    const ctx = window?.SillyTavern?.getContext?.();
    if (ctx?.saveMetadataDebounced) ctx.saveMetadataDebounced();
}

async function notebookAction(args) {
    const action = String(args.action || '').trim().toLowerCase();
    const key = String(args.key || '').trim();
    const content = String(args.content || '').trim();

    logToolCallStarted(TOOL_NAMES.NOTEBOOK, { action, key });

    const books = getActiveTunnelVisionBooks();
    if (books.length === 0 && action !== 'read') {
        logToolCallError(TOOL_NAMES.NOTEBOOK, 'No active lorebooks');
        return 'No Pathfinder-enabled lorebooks active. Notebook is still available for reading.';
    }

    const notebook = getNotebookData();
    if (!notebook) {
        logToolCallError(TOOL_NAMES.NOTEBOOK, 'No chat metadata');
        return 'Error: Could not access chat metadata for notebook storage.';
    }

    try {
        if (action === 'read') {
            const entries = notebook.entries || [];
            if (entries.length === 0) {
                logToolCallCompleted(TOOL_NAMES.NOTEBOOK, 'Notebook is empty');
                return '📓 Notebook is empty. Use "write" to add entries.';
            }
            const formatted = entries.map((e, i) => `**${e.key}** (updated: ${new Date(e.updated).toLocaleString()}):\n${e.content}`).join('\n\n---\n\n');
            logToolCallCompleted(TOOL_NAMES.NOTEBOOK, `${entries.length} entries`);
            return `📓 Notebook (${entries.length} entries):\n\n${formatted}`;
        }

        if (action === 'write') {
            if (!key || !content) {
                logToolCallError(TOOL_NAMES.NOTEBOOK, 'Missing key or content');
                return 'Error: "key" and "content" required for writing.';
            }
            const existing = notebook.entries.findIndex(e => e.key === key);
            if (existing >= 0) {
                notebook.entries[existing].content = content;
                notebook.entries[existing].updated = Date.now();
            } else {
                notebook.entries.push({ key, content, updated: Date.now() });
            }
            notebook.updated = Date.now();
            saveNotebookData();
            logToolCallCompleted(TOOL_NAMES.NOTEBOOK, `Wrote: ${key}`);
            return `📓 Wrote "${key}" to notebook.`;
        }

        if (action === 'delete') {
            if (!key) {
                logToolCallError(TOOL_NAMES.NOTEBOOK, 'Missing key');
                return 'Error: "key" required for deletion.';
            }
            const idx = notebook.entries.findIndex(e => e.key === key);
            if (idx < 0) {
                return `📓 No notebook entry "${key}" found.`;
            }
            notebook.entries.splice(idx, 1);
            notebook.updated = Date.now();
            saveNotebookData();
            logToolCallCompleted(TOOL_NAMES.NOTEBOOK, `Deleted: ${key}`);
            return `📓 Deleted "${key}" from notebook.`;
        }

        logToolCallError(TOOL_NAMES.NOTEBOOK, `Unknown action: ${action}`);
        return `Unknown action: "${action}". Use "read", "write", or "delete".`;
    } catch (err) {
        logToolCallError(TOOL_NAMES.NOTEBOOK, err.message);
        return `❌ Notebook error: ${err.message}`;
    }
}

async function notebookFormatter(args) {
    return `📓 Pathfinder: ${args.action === 'write' ? 'Writing to' : args.action === 'delete' ? 'Deleting from' : 'Reading'} notebook...`;
}

export function resetNotebookWriteGuard() {
    // Retained for compatibility with existing call sites.
}

export function buildNotebookPrompt() {
    const notebook = getNotebookData();
    if (!notebook || !notebook.entries?.length) return '';
    const lines = notebook.entries.map(e => `- **${e.key}**: ${e.content}`).join('\n');
    return `📓 **Pathfinder Notebook** (private AI notes):\n${lines}`;
}

export function getDefinition() {
    return {
        name: TOOL_NAMES.NOTEBOOK,
        displayName: 'Pathfinder Notebook',
        description: COMPACT_DESCRIPTION,
        parameters: {
            type: 'object',
            required: ['action'],
            properties: {
                action: { type: 'string', enum: ['read', 'write', 'delete'], description: '"read" all entries, "write" a new entry, "delete" an entry' },
                key: { type: 'string', description: 'Note key/title (for write and delete)' },
                content: { type: 'string', description: 'Note content (for write)' },
            },
        },
        actionKey: 'pathfinder_notebook',
        formatMessageKey: 'pathfinder_notebook_fmt',
        shouldRegister: true,
        stealth: false,
        enabled: true,
    };
}

export function registerActions() {
    registerToolAction('pathfinder_notebook', notebookAction);
    registerToolFormatter('pathfinder_notebook_fmt', notebookFormatter);
}
