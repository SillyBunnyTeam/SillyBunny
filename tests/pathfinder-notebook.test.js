/* eslint-disable playwright/no-standalone-expect, playwright/no-duplicate-hooks */
/* global globalThis */
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';

await jest.unstable_mockModule('../public/scripts/extensions.js', () => ({ getContext: () => null }));
await jest.unstable_mockModule('../public/scripts/extensions/in-chat-agents/agent-store.js', () => ({ isPathfinderSubmoduleEnabled: () => true }));
const { replaceSettings } = await import('../public/scripts/extensions/in-chat-agents/pathfinder/tree-store.js');
const { buildNotebookPrompt, registerActions, resetNotebookWriteGuard } = await import('../public/scripts/extensions/in-chat-agents/pathfinder/tools/notebook.js');
const { getToolAction } = await import('../public/scripts/extensions/in-chat-agents/tool-action-registry.js');
registerActions();

describe('Pathfinder notebook baseline', () => {
    let context;

    beforeEach(() => {
        replaceSettings({ enabledLorebooks: ['Book'], includeContextualLorebooks: false });
        context = { chatMetadata: { unrelated: 'retained' }, saveMetadataDebounced: jest.fn() };
        globalThis.window = { SillyTavern: { getContext: () => context } };
    });

    afterEach(() => { delete globalThis.window; });

    test.each(['chatMetadata', 'chat_metadata'])('reads, updates and deletes notes using %s without changing other metadata', async key => {
        context = { [key]: { unrelated: 'retained' }, saveMetadataDebounced: jest.fn() };
        const action = getToolAction('pathfinder_notebook');
        await action({ action: 'write', key: 'Plan', content: 'first' });
        await action({ action: 'write', key: 'Plan', content: 'revised' });
        expect(context[key].pathfinder_notebook.entries).toHaveLength(1);
        expect(await action({ action: 'read' })).toContain('revised');
        expect(buildNotebookPrompt()).toContain('revised');
        await action({ action: 'delete', key: 'Plan' });
        expect(context[key].pathfinder_notebook.entries).toEqual([]);
        expect(context[key].unrelated).toBe('retained');
        expect(context.saveMetadataDebounced).toHaveBeenCalledTimes(3);
    });

    test('chat switches isolate notebook contents and allow a fresh write in each chat', async () => {
        const action = getToolAction('pathfinder_notebook');
        const first = context;
        await action({ action: 'write', key: 'First', content: 'first chat only' });
        context = { chatMetadata: {}, saveMetadataDebounced: jest.fn() };
        resetNotebookWriteGuard();
        expect(await action({ action: 'read' })).not.toContain('first chat only');
        await action({ action: 'write', key: 'Second', content: 'second chat only' });
        expect(buildNotebookPrompt()).toContain('second chat only');
        expect(first.chatMetadata.pathfinder_notebook.entries).toHaveLength(1);
        context = first;
        expect(buildNotebookPrompt()).toContain('first chat only');
        expect(buildNotebookPrompt()).not.toContain('second chat only');
    });

    test('continues allowing reads but blocks writes without an active book', async () => {
        const action = getToolAction('pathfinder_notebook');
        await action({ action: 'write', key: 'Saved', content: 'retained note' });
        replaceSettings({ enabledLorebooks: [], includeContextualLorebooks: false });
        expect(await action({ action: 'read' })).toContain('retained note');
        expect(await action({ action: 'write', key: 'Blocked', content: 'not saved' })).toContain('Notebook is still available for reading');
        expect(context.chatMetadata.pathfinder_notebook.entries).toHaveLength(1);
    });
});
