import { getTree, createTreeNode, saveTree } from '../tree-store.js';
import { createEntry } from '../entry-manager.js';
import { getWritableBooks, resolveTargetBook, TOOL_NAMES } from '../pathfinder-tool-bridge.js';
import { registerToolAction, registerToolFormatter } from '../../tool-action-registry.js';
import { logToolCallStarted, logToolCallCompleted, logToolCallError } from '../activity-feed.js';
import { setSummaryMemoryCreated } from '../summary-memory-store.js';
import { markAutoSummaryComplete } from '../auto-summary.js';
import { escapeRegex } from '../../../../util/escape-regex.js';

const COMPACT_DESCRIPTION = 'Create a scene or event summary with significance level and optional narrative arc.';
const GENERIC_SUMMARY_TITLE_PATTERN = /^(recent scene summary|scene summary|memory summary|summary|untitled summary)$/i;
const MAX_DERIVED_TITLE_LENGTH = 64;
const MAX_DERIVED_TITLE_WORDS = 9;

function normalizeTitle(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
}

function trimDerivedTitle(value) {
    const normalized = normalizeTitle(value);
    if (normalized.length <= MAX_DERIVED_TITLE_LENGTH) {
        return normalized;
    }

    const clipped = normalized.slice(0, MAX_DERIVED_TITLE_LENGTH);
    return clipped.replace(/\s+\S*$/, '').trim() || clipped.trim();
}

function stripSummaryTitle(title, arc = '') {
    let normalized = normalizeTitle(title).replace(/^\[Summary\]\s*/i, '');
    const arcName = normalizeTitle(arc);
    if (arcName) {
        normalized = normalized.replace(new RegExp(`\\s+(?:\\u2014|-|:)\\s*${escapeRegex(arcName)}$`, 'i'), '').trim();
    }

    return normalized;
}

function stripSummaryMetadata(content) {
    return String(content || '').replace(/^Significance:\s*[^\n]*\n+/i, '').trim();
}

function deriveTitleFromContent(content) {
    const body = stripSummaryMetadata(content);
    const firstSentence = body.split(/[.!?]\s+|\n+/).find(part => part.trim()) || body;
    const withoutSpeaker = firstSentence.replace(/^[\w .'-]{1,32}:\s+/, '').trim();
    const words = withoutSpeaker
        .replace(/[^\w\s'-]/g, ' ')
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, MAX_DERIVED_TITLE_WORDS);

    return trimDerivedTitle(words.join(' '));
}

export function deriveSummaryLorebookTitle({ title = '', content = '', arc = '' } = {}) {
    const existingTitle = stripSummaryTitle(title, arc);
    if (existingTitle && !GENERIC_SUMMARY_TITLE_PATTERN.test(existingTitle)) {
        return trimDerivedTitle(existingTitle);
    }

    return deriveTitleFromContent(content) || 'Summary note';
}

export async function createSummaryMemoryEntry(args = {}, options = {}) {
    const title = String(args.title || '').trim();
    const content = String(args.content || '').trim();
    const arc = String(args.arc || '').trim();
    const significance = String(args.significance || 'medium').trim();
    const bookName = String(args.book || '').trim();
    const trackLatest = options.trackLatest !== false;

    logToolCallStarted(TOOL_NAMES.SUMMARIZE, { title, arc, bookName });

    if (!title || !content) {
        logToolCallError(TOOL_NAMES.SUMMARIZE, 'Missing title or content');
        throw new Error('"title" and "content" are required.');
    }

    const writableBooks = getWritableBooks();
    const targetBook = resolveTargetBook(bookName, writableBooks);
    if (!targetBook) {
        logToolCallError(TOOL_NAMES.SUMMARIZE, 'No writable lorebooks');
        throw new Error('No Pathfinder-enabled lorebooks available for writing.');
    }

    const summaryTitle = `[Summary] ${title}${arc ? ` — ${arc}` : ''}`;
    const formattedContent = `Significance: ${significance}\n\n${content}`;

    try {
        const result = await createEntry(targetBook, summaryTitle, formattedContent, ['summary', significance.toLowerCase()]);
        if (trackLatest) {
            setSummaryMemoryCreated({
                title: summaryTitle,
                content,
                significance,
                arc,
                bookName: targetBook,
                uid: result.uid,
            });
        }

        const tree = getTree(targetBook);
        if (tree && arc) {
            let summaryWaypoint = (tree.children || []).find(c => /summar/i.test(c.name));
            if (!summaryWaypoint) {
                summaryWaypoint = createTreeNode('Summaries', 'Event summaries and recaps');
                tree.children.push(summaryWaypoint);
            }

            if (arc) {
                let arcNode = (summaryWaypoint.children || []).find(c => c.name.toLowerCase() === arc.toLowerCase());
                if (!arcNode) {
                    arcNode = createTreeNode(`Arc: ${arc}`, `Narrative arc: ${arc}`);
                    if (!summaryWaypoint.children) summaryWaypoint.children = [];
                    summaryWaypoint.children.push(arcNode);
                }
                if (arcNode.entries && !arcNode.entries.includes(result.uid)) {
                    arcNode.entries.push(result.uid);
                }
            }

            saveTree(targetBook, tree);
        }

        logToolCallCompleted(TOOL_NAMES.SUMMARIZE, `Summarized: ${title}`);
        return {
            title,
            summaryTitle,
            targetBook,
            uid: result.uid,
            significance,
            arc,
        };
    } catch (err) {
        logToolCallError(TOOL_NAMES.SUMMARIZE, err.message);
        throw err;
    }
}

export async function createSeparateSummaryMemoryEntry(args = {}) {
    const content = String(args.content || '').trim();
    if (!content) {
        throw new Error('No summary text is available to save as a lorebook entry.');
    }

    return await createSummaryMemoryEntry({
        ...args,
        title: deriveSummaryLorebookTitle({
            title: args.title,
            content,
            arc: args.arc,
        }),
        content,
    }, { trackLatest: false });
}

async function summarizeAction(args) {
    try {
        const result = await createSummaryMemoryEntry(args);
        // SillyBunny: reset the auto-summary counter only after a summary is
        // successfully written, not when the prompt is injected. This ensures
        // the interval is not consumed when the model skips or fails the tool
        // call. (#530)
        markAutoSummaryComplete();
        return `📝 Summary "${result.title}" saved in "${result.targetBook}" (UID: ${result.uid}). Significance: ${result.significance}. ${result.arc ? `Filed under arc "${result.arc}".` : ''}`;
    } catch (err) {
        return `❌ Failed to summarize: ${err.message}`;
    }
}

async function summarizeFormatter(args) {
    return `📝 Pathfinder: Writing summary "${args.title || 'untitled'}"...`;
}

export function getDefinition() {
    return {
        name: TOOL_NAMES.SUMMARIZE,
        displayName: 'Pathfinder Summarize',
        description: COMPACT_DESCRIPTION,
        parameters: {
            type: 'object',
            required: ['title', 'content'],
            properties: {
                title: { type: 'string', description: 'Short title for the event/scene' },
                content: { type: 'string', description: 'Full summary of what happened' },
                arc: { type: 'string', description: 'Optional narrative arc name to file this under' },
                significance: { type: 'string', enum: ['low', 'medium', 'high', 'critical'], description: 'How important this event is. Default: medium.' },
                book: { type: 'string', description: 'Lorebook name. Omit for default.' },
            },
        },
        actionKey: 'pathfinder_summarize',
        formatMessageKey: 'pathfinder_summarize_fmt',
        shouldRegister: true,
        stealth: false,
        enabled: true,
    };
}

export function registerActions() {
    registerToolAction('pathfinder_summarize', summarizeAction);
    registerToolFormatter('pathfinder_summarize_fmt', summarizeFormatter);
}
