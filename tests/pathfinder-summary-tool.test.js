import { beforeEach, describe, expect, jest, test } from '@jest/globals';

let mockWritableBooks;
let mockCreatedEntries;
let mockSummaryState;

await jest.unstable_mockModule('../public/scripts/extensions/in-chat-agents/pathfinder/tree-store.js', () => ({
    createTreeNode: jest.fn((name, description, entries = [], children = []) => ({ name, description, entries, children })),
    getTree: jest.fn(() => null),
    saveTree: jest.fn(),
}));

await jest.unstable_mockModule('../public/scripts/extensions/in-chat-agents/pathfinder/entry-manager.js', () => ({
    createEntry: jest.fn(async (bookName, title, content, keys = []) => {
        const entry = {
            uid: mockCreatedEntries.length + 1,
            bookName,
            title,
            content,
            keys,
        };
        mockCreatedEntries.push(entry);
        return { uid: entry.uid, title, bookName };
    }),
}));

await jest.unstable_mockModule('../public/scripts/extensions/in-chat-agents/pathfinder/pathfinder-tool-bridge.js', () => ({
    TOOL_NAMES: { SUMMARIZE: 'Pathfinder_Summarize' },
    getWritableBooks: jest.fn(() => mockWritableBooks),
    getActiveTunnelVisionBooks: jest.fn(() => mockWritableBooks),
    resolveTargetBook: jest.fn((requestedBook, writableBooks) => {
        if (requestedBook && writableBooks.includes(requestedBook)) {
            return requestedBook;
        }

        return writableBooks[0] ?? null;
    }),
}));

await jest.unstable_mockModule('../public/scripts/extensions/in-chat-agents/tool-action-registry.js', () => ({
    registerToolAction: jest.fn(),
    registerToolFormatter: jest.fn(),
}));

await jest.unstable_mockModule('../public/scripts/extensions/in-chat-agents/pathfinder/activity-feed.js', () => ({
    logToolCallStarted: jest.fn(),
    logToolCallCompleted: jest.fn(),
    logToolCallError: jest.fn(),
}));

await jest.unstable_mockModule('../public/scripts/extensions/in-chat-agents/pathfinder/summary-memory-store.js', () => ({
    setSummaryMemoryCreated: jest.fn(payload => {
        mockSummaryState = payload;
    }),
}));

await jest.unstable_mockModule('../public/scripts/extensions/in-chat-agents/pathfinder/auto-summary.js', () => ({
    markAutoSummaryComplete: jest.fn(),
}));
await jest.unstable_mockModule('../public/scripts/utils.js', () => ({
    escapeRegex: value => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
}));

const {
    createSeparateSummaryMemoryEntry,
    createSummaryMemoryEntry,
    deriveSummaryLorebookTitle,
} = await import('../public/scripts/extensions/in-chat-agents/pathfinder/tools/summarize.js');

describe('Pathfinder summary lorebook entries', () => {
    beforeEach(() => {
        mockWritableBooks = ['Memory Book'];
        mockCreatedEntries = [];
        mockSummaryState = null;
    });

    test('derives a specific title when the tracked summary title is generic', () => {
        expect(deriveSummaryLorebookTitle({
            title: '[Summary] Recent scene summary',
            content: 'Significance: high\n\nMira discovered the hidden observatory beneath the old chapel. The party still needs the moon key.',
        })).toBe('Mira discovered the hidden observatory beneath the old chapel');
    });

    test('creates a separate summary entry without replacing the tracked latest summary', async () => {
        const tracked = await createSummaryMemoryEntry({
            title: 'First tracked summary',
            content: 'The original tracked summary remains selected.',
            significance: 'medium',
        });

        expect(mockSummaryState.title).toBe('[Summary] First tracked summary');

        const archived = await createSeparateSummaryMemoryEntry({
            title: '[Summary] Recent scene summary',
            content: 'Rin promised to return the stolen map before dawn. The guard captain suspects her.',
            significance: 'high',
        });

        expect(archived.uid).not.toBe(tracked.uid);
        expect(mockCreatedEntries).toHaveLength(2);
        expect(mockCreatedEntries[1].title).toBe('[Summary] Rin promised to return the stolen map before dawn');
        expect(mockCreatedEntries[1].content).toContain('Significance: high');
        expect(mockSummaryState.title).toBe('[Summary] First tracked summary');
    });
});
