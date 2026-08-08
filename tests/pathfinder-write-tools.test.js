/* global globalThis */
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';

let mockSettings;
let mockBookData;
const createEntryMock = jest.fn(async (bookName, title) => ({ uid: 7, title, bookName }));
const updateEntryMock = jest.fn(async (bookName, uid) => ({ uid, bookName }));
const forgetEntryMock = jest.fn(async (bookName, uid, hardDelete) => ({ uid, bookName, deleted: hardDelete, disabled: !hardDelete }));

await jest.unstable_mockModule('../public/scripts/extensions/in-chat-agents/agent-store.js', () => ({
    isPathfinderSubmoduleEnabled: jest.fn(() => true),
}));

await jest.unstable_mockModule('../public/scripts/extensions/in-chat-agents/pathfinder/tree-store.js', () => ({
    getSettings: jest.fn(() => mockSettings),
    getTree: jest.fn(() => null),
    isLorebookEnabled: jest.fn(bookName => mockSettings.enabledLorebooks.includes(bookName)),
    canReadBook: jest.fn(() => true),
    canWriteBook: jest.fn(() => true),
    canDeleteBook: jest.fn(() => true),
}));

await jest.unstable_mockModule('../public/scripts/extensions/in-chat-agents/pathfinder/entry-manager.js', () => ({
    createEntry: createEntryMock,
    updateEntry: updateEntryMock,
    forgetEntry: forgetEntryMock,
}));

const { registerActions: registerRememberActions } = await import('../public/scripts/extensions/in-chat-agents/pathfinder/tools/remember.js');
const { registerActions: registerUpdateActions } = await import('../public/scripts/extensions/in-chat-agents/pathfinder/tools/update.js');
const { registerActions: registerForgetActions } = await import('../public/scripts/extensions/in-chat-agents/pathfinder/tools/forget.js');
const { getToolAction } = await import('../public/scripts/extensions/in-chat-agents/tool-action-registry.js');

registerRememberActions();
registerUpdateActions();
registerForgetActions();

describe('Pathfinder write tool actions', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockSettings = {
            enabledLorebooks: ['Memory Book', 'Second Book'],
            includeContextualLorebooks: false,
            dedupDetection: false,
            dedupThreshold: 0.85,
        };
        mockBookData = { entries: {} };
        globalThis.window = {
            SillyTavern: {
                getContext: () => ({
                    loadWorldInfo: async () => mockBookData,
                }),
            },
        };
    });

    afterEach(() => {
        delete globalThis.window;
    });

    test('forget treats a stringified "false" hard_delete as a soft disable', async () => {
        const result = await getToolAction('pathfinder_forget')({ uid: 3, hard_delete: 'false' });

        expect(forgetEntryMock).toHaveBeenCalledWith('Memory Book', 3, false);
        expect(result).toContain('Disabled');
    });

    test('forget honors a real hard delete request', async () => {
        await getToolAction('pathfinder_forget')({ uid: 3, hard_delete: true });

        expect(forgetEntryMock).toHaveBeenCalledWith('Memory Book', 3, true);
    });

    test('update refuses an explicitly named book that is not available instead of retargeting', async () => {
        const result = await getToolAction('pathfinder_update')({ uid: 3, content: 'new', book: 'Wrong Book' });

        expect(result).toContain('"Wrong Book" is not available');
        expect(result).toContain('Memory Book');
        expect(updateEntryMock).not.toHaveBeenCalled();
    });

    test('update still defaults to the first writable book when no book is named', async () => {
        await getToolAction('pathfinder_update')({ uid: 3, content: 'new' });

        expect(updateEntryMock).toHaveBeenCalledWith('Memory Book', 3, 'new', undefined);
    });

    test('remember reports a skipped save when dedup finds a similar entry', async () => {
        mockSettings.dedupDetection = true;
        mockBookData = {
            entries: {
                '4': { uid: 4, comment: 'Existing note', content: 'The dragon guards the northern pass every night.' },
            },
        };

        const result = await getToolAction('pathfinder_remember')({
            title: 'Dragon',
            content: 'The dragon guards the northern pass every night.',
        });

        expect(result).toContain('Not saved');
        expect(result).toContain('UID: 4');
        expect(createEntryMock).not.toHaveBeenCalled();
    });

    test('remember saves normally when no similar entry exists', async () => {
        mockSettings.dedupDetection = true;
        mockBookData = {
            entries: {
                '4': { uid: 4, comment: 'Existing note', content: 'Completely unrelated topic.' },
            },
        };

        const result = await getToolAction('pathfinder_remember')({
            title: 'Dragon',
            content: 'The dragon guards the northern pass every night.',
        });

        expect(createEntryMock).toHaveBeenCalledWith('Memory Book', 'Dragon', 'The dragon guards the northern pass every night.');
        expect(result).toContain('Remembered');
    });
});
