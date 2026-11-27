/** @jest-environment jsdom */
import { beforeEach, describe, expect, jest, test } from '@jest/globals';

await jest.unstable_mockModule('../public/script.js', () => ({ eventSource: { on: jest.fn(), removeListener: jest.fn() }, event_types: { PERSONA_CHANGED: 'persona_changed' } }));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/context.js', () => ({ getConversationPersonaId: () => 'persona.png' }));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/conversation-folders-browser.js', () => ({ conversationFolders: {} }));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/interface.js', () => ({ getConversationListEntries: () => [] }));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/media.js', () => ({
    renderConversationParticipantStack: jest.fn((container, participants) => {
        container.textContent = participants.map(participant => participant.name).join('+');
    }),
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-editor/folder-popovers.js', () => ({ PLACEHOLDER_COPY: 'TODO(copy)' }));

const { createConversationFolders } = await import('../public/scripts/sillybunny-conversation/conversation-folders.js');
const { createConversationFolderAdapter } = await import('../public/scripts/sillybunny-conversation/conversation-folder-manager.js');
const { MAX_FOLDERS_PER_PERSONA } = await import('../public/scripts/sillybunny-conversation/folder-model.js');

const PERSONA = 'persona.png';
const OTHER = 'other.png';

/** The folders module over a server that is a plain object: `/folders/get` answers it and `/folders/update` applies the ops to it. */
async function readyFolders() {
    const { applyFolderOps, getPersonaFolders, normalizeFolderFile, parseFolderOps, withPersonaFolders } = await import('../public/scripts/sillybunny-conversation/folder-model.js');
    let file = normalizeFolderFile(null);
    let counter = 0;
    const requests = [];
    const folders = createConversationFolders({
        fetchJson: async (path, body) => {
            requests.push({ path, body });
            if (path === '/folders/get') {
                return { status: 200, json: file };
            }
            const next = applyFolderOps(getPersonaFolders(file, body.personaId), parseFolderOps(body.ops));
            file = withPersonaFolders(file, body.personaId, next);
            return { status: 200, json: { personaId: body.personaId, folders: next } };
        },
        now: () => 1_764_000_000_000,
        setTimer: (callback, delay) => setTimeout(callback, delay),
        clearTimer: handle => clearTimeout(handle),
        randomHex: length => String(++counter).padStart(length, '0'),
    });
    await folders.load();
    return { folders, requests };
}

const CONV_1 = 'conv_1700000000000_aaaa1111';
const CONV_2 = 'conv_1700000000001_bbbb2222';

let folders;
let personaId;
let adapter;

beforeEach(async () => {
    ({ folders } = await readyFolders());
    personaId = PERSONA;
    adapter = createConversationFolderAdapter({
        folders,
        getPersonaId: () => personaId,
        getEntries: () => [{ id: CONV_1, name: 'Seraphina', participants: [{ name: 'Seraphina' }], status: 'online', groupId: '' }, { id: CONV_2, name: 'Weekend plans', participants: [{ name: 'A' }, { name: 'B' }], status: 'online', groupId: 'g' }],
    });
});

describe('the store that the Folder Manager gets for the conversations', () => {
    test('makes, renames, recolours, opens, closes and deletes folders of the persona through the folders module', () => {
        const folder = adapter.store.createFolder('conversations', '  Work  ', { color: '#abc' });
        expect(folder).toMatchObject({ name: 'Work', color: '#abc', expanded: true });
        expect(adapter.store.getFolders('conversations').map(item => item.name)).toEqual(['Work']);

        expect(adapter.store.renameFolder('conversations', folder.id, 'Renamed')).toBe(true);
        expect(adapter.store.setFolderColor('conversations', folder.id, '#fff')).toBe(true);
        expect(adapter.store.setFolderExpanded('conversations', folder.id, false)).toBe(true);
        expect(adapter.store.getFolders('conversations')).toEqual([{ id: folder.id, name: 'Renamed', color: '#fff', expanded: false }]);
        expect(adapter.store.deleteFolder('conversations', folder.id)).toBe(true);
        expect(adapter.store.getFolders('conversations')).toEqual([]);
    });

    test('reads the persona at each call, so a persona that changes has its own folders', () => {
        adapter.store.createFolder('conversations', 'Mine');
        personaId = OTHER;

        expect(adapter.store.getFolders('conversations')).toEqual([]);
        adapter.store.createFolder('conversations', 'Theirs');
        personaId = PERSONA;
        expect(adapter.store.getFolders('conversations').map(item => item.name)).toEqual(['Mine']);
    });

    test('moves a folder by a delta from where it is, and not past the ends', () => {
        const first = adapter.store.createFolder('conversations', 'First');
        const second = adapter.store.createFolder('conversations', 'Second');
        const third = adapter.store.createFolder('conversations', 'Third');
        const names = () => adapter.store.getFolders('conversations').map(item => item.name);

        expect(adapter.store.moveFolder('conversations', third.id, -2)).toBe(true);
        expect(names()).toEqual(['Third', 'First', 'Second']);
        expect(adapter.store.moveFolder('conversations', first.id, 1)).toBe(true);
        expect(names()).toEqual(['Third', 'Second', 'First']);
        expect(adapter.store.moveFolder('conversations', second.id, 5)).toBe(false);
        expect(adapter.store.moveFolder('conversations', 'fld_1_nothere00', 1)).toBe(false);
    });

    test('keeps a name to the 100 characters of one line, so that the Manager\'s field cannot make a folder that the file refuses', () => {
        const folder = adapter.store.createFolder('conversations', 'x'.repeat(150));
        expect(folder.name).toHaveLength(100);
        adapter.store.renameFolder('conversations', folder.id, `${'y'.repeat(150)}   `);
        expect(adapter.store.getFolders('conversations')[0].name).toBe('y'.repeat(100));
    });

    test('refuses the 51st folder with the placeholder copy, which the popover marks in markup', () => {
        for (let index = 0; index < MAX_FOLDERS_PER_PERSONA; index++) {
            adapter.store.createFolder('conversations', `Folder ${index}`);
        }

        expect(() => adapter.store.createFolder('conversations', 'One too many')).toThrow('TODO(copy)');
    });

    test('files conversations, lists the members of a folder, and takes one out of that folder only', () => {
        const work = adapter.store.createFolder('conversations', 'Work');
        const friends = adapter.store.createFolder('conversations', 'Friends');
        expect(adapter.store.setFolder('conversations', [CONV_1], work.id)).toBe(true);
        adapter.store.setFolder('conversations', [CONV_2], friends.id);

        expect(adapter.store.getFolderMembers('conversations', work.id)).toEqual([CONV_1]);
        expect(adapter.store.removeFromFolder('conversations', [CONV_1, CONV_2], work.id)).toBe(true);
        expect(adapter.store.getFolderMembers('conversations', work.id)).toEqual([]);
        expect(adapter.store.getFolderMembers('conversations', friends.id)).toEqual([CONV_2]);
        expect(adapter.store.removeFromFolder('conversations', [CONV_1], work.id)).toBe(false);
        expect(adapter.store.setFolder('conversations', [CONV_2], null)).toBe(true);
        expect(adapter.store.getFolderMembers('conversations', friends.id)).toEqual([]);
    });

    test('answers false and does not throw for a change that the folders module refuses', () => {
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        const folder = adapter.store.createFolder('conversations', 'Work');

        expect(adapter.store.setFolderColor('conversations', folder.id, 'url(https://example.test/x)')).toBe(false);
        expect(adapter.store.setFolder('conversations', [CONV_1], 'fld_1_nothere00')).toBe(false);
        expect(warn).toHaveBeenCalled();
        warn.mockRestore();
    });

    test('tells the Manager that its scope changed when the folders change, and only then', async () => {
        const listener = jest.fn();
        const stop = adapter.store.subscribe(listener);

        adapter.store.createFolder('conversations', 'Work');
        await Promise.resolve();
        expect(listener).toHaveBeenCalledWith({ scope: 'conversations' });
        listener.mockClear();
        stop();
        adapter.store.createFolder('conversations', 'More');
        await Promise.resolve();
        expect(listener).not.toHaveBeenCalled();
    });
});

describe('the items of the Folder Manager for the conversations', () => {
    test('are the conversations of the persona, keyed by their id and named by the name of the row, with the stack of their participants as the avatar', () => {
        const [first, second] = adapter.getItems();

        expect(adapter.getKey(first)).toBe(CONV_1);
        expect(adapter.getName(second)).toBe('Weekend plans');
        expect(adapter.getAvatar(second).textContent).toBe('A+B');
    });
});
