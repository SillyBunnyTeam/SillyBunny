/* eslint-disable playwright/no-standalone-expect, playwright/no-duplicate-hooks */
/* global globalThis */
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';

await jest.unstable_mockModule('../public/scripts/extensions.js', () => ({ getContext: () => null }));
await jest.unstable_mockModule('../public/scripts/extensions/in-chat-agents/agent-store.js', () => ({ isPathfinderSubmoduleEnabled: () => true }));
await jest.unstable_mockModule('../public/scripts/util/AccountStorage.js', () => ({ accountStorage: { getItem: () => null, setItem: jest.fn() } }));
await jest.unstable_mockModule('../public/scripts/world-info.js', () => ({
    createWorldInfoEntry: jest.fn(), syncWIOriginalDataEntry: jest.fn(), deleteWIOriginalDataValue: jest.fn(), reloadEditor: jest.fn(),
}));
const parser = { commands: {}, addCommandObject(command) { this.commands[command.name] = command; } };
await jest.unstable_mockModule('../public/scripts/slash-commands/SlashCommand.js', () => ({ SlashCommand: { fromProps: props => props } }));
await jest.unstable_mockModule('../public/scripts/slash-commands/SlashCommandArgument.js', () => ({
    ARGUMENT_TYPE: { STRING: 'string' }, SlashCommandArgument: { fromProps: props => props },
}));
await jest.unstable_mockModule('../public/scripts/slash-commands/SlashCommandParser.js', () => ({ SlashCommandParser: parser }));

const { clearAllTrees, getTree, getSettings, getAllEntryUids, replaceSettings, setBookPermission } = await import('../public/scripts/extensions/in-chat-agents/pathfinder/tree-store.js');
const { buildTreeFromMetadata, buildTreeWithLLM } = await import('../public/scripts/extensions/in-chat-agents/pathfinder/tree-builder.js');
const { LAYOUT_KEY } = await import('../public/scripts/extensions/in-chat-agents/pathfinder/tree-layout.js');
const { initEntryManagerAPIs, listNodeEntries } = await import('../public/scripts/extensions/in-chat-agents/pathfinder/entry-manager.js');
const { initCommands, removeCommands } = await import('../public/scripts/extensions/in-chat-agents/pathfinder/commands.js');
const { registerActions } = await import('../public/scripts/extensions/in-chat-agents/pathfinder/tools/search.js');
const { getToolAction } = await import('../public/scripts/extensions/in-chat-agents/tool-action-registry.js');
registerActions();

describe('Pathfinder search and category reads', () => {
    let book;
    let load;
    let save;

    beforeEach(() => {
        clearAllTrees();
        replaceSettings({ enabledLorebooks: ['Book', 'Denied'], includeContextualLorebooks: false });
        setBookPermission('Denied', 'read', false);
        book = {
            extensions: { [LAYOUT_KEY]: { version: 1, tree: {
                id: 'root', name: 'Root', description: '', children: [{ id: 'child', name: 'Child', description: '', children: [] }],
            } } },
            entries: {
                0: { uid: 0, comment: 'Root memory', content: 'root text', extensions: { [LAYOUT_KEY]: { version: 1, nodeId: 'root' } } },
                1: { uid: 1, comment: 'Child memory', content: 'child text', extensions: { [LAYOUT_KEY]: { version: 1, nodeId: 'child' } } },
                2: { uid: 2, comment: 'Disabled secret', content: 'disabled content', disable: true, extensions: { [LAYOUT_KEY]: { version: 1, nodeId: 'root' } } },
                3: { uid: 3, comment: 'Blacklisted secret', content: 'blacklisted content', agentBlacklisted: true, extensions: { [LAYOUT_KEY]: { version: 1, nodeId: 'root' } } },
            },
        };
        load = jest.fn(async () => structuredClone(book));
        save = jest.fn(async name => name);
        initEntryManagerAPIs(load, jest.fn(), save);
        globalThis.window = { SillyTavern: { getContext: () => ({ loadWorldInfo: load }) } };
        initCommands();
    });

    afterEach(() => {
        removeCommands();
        delete globalThis.window;
    });

    test.each(['traversal', 'collapsed'])('root-held entries remain navigable in %s mode', async mode => {
        getSettings().searchMode = mode;
        const overview = await getToolAction('pathfinder_search')({});
        const tree = getTree('Book');
        expect(overview).toContain(`[id: ${tree.id}]`);
        expect(overview).not.toContain('Denied');
        const root = await getToolAction('pathfinder_search')({ node_id: tree.id });
        expect(root).toContain('root text');
        expect(root).toContain(`[id: ${tree.children[0].id}]`);
        expect(root).not.toContain('child text');
        const child = await getToolAction('pathfinder_search')({ node_id: tree.children[0].id });
        expect(child).toContain('child text');
        expect(save).not.toHaveBeenCalled();
    });

    test('actual reads and UID listings recheck exclusions even when the cached tree is stale', async () => {
        book.entries[2].disable = false;
        book.entries[3].agentBlacklisted = false;
        const tree = await buildTreeFromMetadata('Book', book);
        book.entries[2].disable = true;
        book.entries[3].agentBlacklisted = true;
        const result = await getToolAction('pathfinder_search')({ node_id: tree.id });
        expect(result).toContain('root text');
        expect(result).not.toContain('secret');
        expect(result).not.toContain('disabled content');
        expect(result).not.toContain('blacklisted content');
        expect(result).not.toContain('UID:2');
        expect(result).not.toContain('UID:3');
        expect((await listNodeEntries('Book', tree.id)).map(entry => entry.uid)).toEqual([0]);
    });

    test('slash search lazily builds readable books and keeps IDs usable by the tool', async () => {
        expect(getTree('Book')).toBeNull();
        const result = await parser.commands['pf-search'].callback({}, 'Child');
        expect(result).toContain('Book: Child (1 entries)');
        expect(load).toHaveBeenCalledWith('Book');
        expect(load).not.toHaveBeenCalledWith('Denied');
        expect(await getToolAction('pathfinder_search')({ node_id: getTree('Book').children[0].id })).toContain('child text');
        expect(save).not.toHaveBeenCalled();
    });

    test('slash search handles a failed lazy load without a write or an unhandled rejection', async () => {
        load.mockRejectedValueOnce(new Error('offline'));
        expect(await parser.commands['pf-search'].callback({}, 'Child')).toBe('No waypoints found matching query.');
        expect(save).not.toHaveBeenCalled();
    });

    test('metadata and model category building both exclude hidden entries without changing the source book', async () => {
        delete book.extensions;
        const before = structuredClone(book);
        const metadata = await buildTreeFromMetadata('Book', book);
        expect(getAllEntryUids(metadata)).toEqual([0, 1]);
        const generate = jest.fn(async () => 'WAYPOINT: Known\nENTRIES: 0, 1, 2, 3');
        const modelTree = await buildTreeWithLLM('Book', book, generate);
        expect(getAllEntryUids(modelTree)).toEqual([0, 1]);
        expect(generate.mock.calls[0][0]).not.toContain('secret');
        expect(generate.mock.calls[0][0]).not.toContain('disabled content');
        expect(generate.mock.calls[0][0]).not.toContain('blacklisted content');
        expect(book).toEqual(before);
        expect(save).not.toHaveBeenCalled();
    });
});
