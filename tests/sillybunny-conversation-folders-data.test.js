import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';

import {
    createConversationFolders,
    FOLDER_FREQUENT_DELAY_MS,
    FOLDER_FREQUENT_MAX_WAIT_MS,
    FOLDER_RETRY_DELAYS_MS,
} from '../public/scripts/sillybunny-conversation/conversation-folders.js';
import { createConversationData } from '../public/scripts/sillybunny-conversation/conversation-data.js';
import { FolderInputError } from '../public/scripts/sillybunny-conversation/folder-model.js';
import { PERSONA, recordCalls, scriptedAdapter, seedConversations, settle, startConversationServer } from './util/conversation-data-fixture.js';

const { readConversationFolders, updateConversationFolders } = await import('../src/conversation-store.js');

const OTHER = 'persona-two.png';
const FOLDER_A = 'fld_1764000000000_a1b2c3d4e5f6';
const FOLDER_B = 'fld_1764000000001_b1b2c3d4e5f6';
const DIRECT = { id: 'conv_1_direct01', characters: ['Nova.png'] };
const GROUP = { id: 'conv_2_group001', characters: ['Nova.png', 'Orion.png'], name: 'Trip' };

let server;
let adapter;
let folders;
let events;

beforeEach(async () => {
    server = await startConversationServer();
    events = [];
});

afterEach(async () => {
    folders?.destroy();
    await server.stop();
    jest.restoreAllMocks();
});

let counter = 0;
function withAdapter(base, overrides = {}) {
    return recordCalls({ ...base, randomHex: length => String(++counter).padStart(length, '0'), ...overrides });
}

async function started(descriptors = [], overrides = {}) {
    seedConversations(server, descriptors);
    adapter = withAdapter(server.adapter(), overrides);
    folders = createConversationFolders(adapter);
    folders.subscribe(event => events.push(event));
    await folders.load();
    return folders;
}

const stored = () => readConversationFolders(server.user);
const sent = () => adapter.callsTo('/folders/update').map(call => call.body);

describe('load', () => {
    test('reads the whole file once and is ready, with no folder for a user who has none', async () => {
        await started();

        expect(adapter.paths()).toEqual(['/folders/get']);
        expect(folders.status()).toBe('ready');
        expect(folders.layout(PERSONA)).toMatchObject({ folders: [], favoritesExpanded: true });
        expect(folders.folderOf(PERSONA, DIRECT.id)).toBe('');
    });

    test('answers the same promise to a second call and reads once', async () => {
        await started();

        await Promise.all([folders.load(), folders.load()]);

        expect(adapter.callsTo('/folders/get')).toHaveLength(1);
    });

    test('shows the folders of the persona that were stored, and none of another persona', async () => {
        seedConversations(server, [DIRECT]);
        updateConversationFolders(server.user, PERSONA, [{ op: 'createFolder', id: FOLDER_A, name: 'Work', color: '#abc', expanded: false }, { op: 'setMembers', ids: [DIRECT.id], folderId: FOLDER_A }]);
        updateConversationFolders(server.user, OTHER, [{ op: 'createFolder', id: FOLDER_B, name: 'Theirs' }]);
        await started();

        expect(folders.layout(PERSONA).folders).toEqual([{ id: FOLDER_A, name: 'Work', color: '#abc', expanded: false }]);
        expect(folders.folderOf(PERSONA, DIRECT.id)).toBe(FOLDER_A);
        expect(folders.membersOf(PERSONA, FOLDER_A)).toEqual([DIRECT.id]);
        expect(folders.layout(OTHER).folders.map(folder => folder.name)).toEqual(['Theirs']);
        expect(folders.folderOf(OTHER, DIRECT.id)).toBe('');
    });

    test('is not ready while the first read waits, and a change before then is refused', async () => {
        let release;
        const gate = new Promise((resolve) => {
            release = resolve;
        });
        adapter = withAdapter(server.adapter(), { fetchJson: async (path, body) => { await gate; return server.adapter().fetchJson(path, body); } });
        folders = createConversationFolders(adapter);
        const loading = folders.load();

        expect(folders.status()).toBe('loading');
        expect(() => folders.createFolder(PERSONA, 'Early')).toThrow(FolderInputError);
        release();
        await loading;
        expect(folders.status()).toBe('ready');
    });

    test('fails when the server answers an error, tells the listeners, and reads again by itself after a delay', async () => {
        let answers = 0;
        adapter = scriptedAdapter(async (path) => {
            answers++;
            return answers === 1 ? { status: 503, json: { error: 'migration_failed' } } : { status: 200, json: { version: 1, personas: { [PERSONA]: { folders: [{ id: FOLDER_A, name: 'Work' }], members: {} } } } };
        }, { randomHex: length => 'a'.repeat(length) });
        folders = createConversationFolders(adapter);
        folders.subscribe(event => events.push(event));

        await folders.load();
        await settle(2);
        expect(folders.status()).toBe('failed');
        expect(events.some(event => event.type === 'status' && event.status === 'failed')).toBe(true);

        await adapter.clock.advance(5000);
        await settle();

        expect(folders.status()).toBe('ready');
        expect(folders.layout(PERSONA).folders.map(folder => folder.name)).toEqual(['Work']);
    });

    test('a call to load after a failure tries again at once', async () => {
        let ok = false;
        adapter = scriptedAdapter(async () => (ok ? { status: 200, json: { version: 1, personas: {} } } : { status: 500, json: { error: 'internal' } }), { randomHex: length => 'a'.repeat(length) });
        folders = createConversationFolders(adapter);
        await folders.load();
        expect(folders.status()).toBe('failed');

        ok = true;
        await folders.load();

        expect(folders.status()).toBe('ready');
    });
});

describe('layout', () => {
    test('is the same object until the persona\'s folders change, and a new one with a new signature after', async () => {
        await started();
        folders.createFolder(PERSONA, 'Work');
        const first = folders.layout(PERSONA);

        expect(folders.layout(PERSONA)).toBe(first);
        folders.updateFolder(PERSONA, first.folders[0].id, { name: 'Renamed' });

        const second = folders.layout(PERSONA);
        expect(second).not.toBe(first);
        expect(second.signature).not.toBe(first.signature);
        expect(folders.layout(OTHER).signature).toBe('');
    });

    test('has a signature that moves with the open state of Favorites and of a folder, and not with the filing of a conversation', async () => {
        await started([DIRECT]);
        const { id } = folders.createFolder(PERSONA, 'Work');
        const base = folders.layout(PERSONA).signature;

        folders.setMembers(PERSONA, [DIRECT.id], id);
        expect(folders.layout(PERSONA).signature).toBe(base);
        folders.setFavoritesExpanded(PERSONA, false);
        const closedFavorites = folders.layout(PERSONA);
        expect(closedFavorites.signature).not.toBe(base);
        expect(closedFavorites.favoritesExpanded).toBe(false);
        folders.updateFolder(PERSONA, id, { expanded: false });
        expect(folders.layout(PERSONA).signature).not.toBe(closedFavorites.signature);
    });
});

describe('a change', () => {
    test('shows in the copy at once, and reaches the file in one request', async () => {
        await started([DIRECT]);

        const folder = folders.createFolder(PERSONA, 'Work', { color: '#abc' });
        folders.setMembers(PERSONA, [DIRECT.id], folder.id);
        expect(folders.folderOf(PERSONA, DIRECT.id)).toBe(folder.id);
        expect(stored().personas).toEqual({});

        await folders.flush();

        expect(stored().personas[PERSONA]).toEqual({ folders: [{ ...folder }], members: { [DIRECT.id]: folder.id } });
        expect(sent()).toHaveLength(1);
        expect(sent()[0].ops.map(op => op.op)).toEqual(['createFolder', 'setMembers']);
    });

    test('is made by the page with an id of its own, which the server keeps', async () => {
        await started();

        const folder = folders.createFolder(PERSONA, '  Work  ');
        await folders.flush();

        expect(folder.name).toBe('Work');
        expect(folder.id).toMatch(/^fld_\d+_[0-9a-f]{12}$|^fld_\d+_0+\d+$/);
        expect(stored().personas[PERSONA].folders[0].id).toBe(folder.id);
    });

    test('keeps the folders of two personas apart and sends each persona in its own request', async () => {
        await started();
        folders.createFolder(PERSONA, 'One');
        folders.createFolder(OTHER, 'Two');
        await folders.flush();

        expect(sent().map(body => body.personaId).sort()).toEqual([OTHER, PERSONA].sort());
        expect(stored().personas[OTHER].folders.map(folder => folder.name)).toEqual(['Two']);
    });

    test('is refused in the page, with nothing queued, for a name that is blank and for the 51st folder', async () => {
        await started();

        expect(() => folders.createFolder(PERSONA, '   ')).toThrow(FolderInputError);
        for (let index = 0; index < 50; index++) {
            folders.createFolder(PERSONA, `Folder ${index}`);
        }
        expect(() => folders.createFolder(PERSONA, 'One too many')).toThrow(/at most 50/);
        await folders.flush();

        expect(stored().personas[PERSONA].folders).toHaveLength(50);
        expect(adapter.callsTo('/folders/update').length).toBeGreaterThan(0);
    });

    test('sends nothing for a change that changes nothing', async () => {
        await started([DIRECT]);
        const { id } = folders.createFolder(PERSONA, 'Work');
        await folders.flush();
        const requests = adapter.callsTo('/folders/update').length;

        expect(folders.updateFolder(PERSONA, id, { name: 'Work' })).toBe(false);
        expect(folders.setMembers(PERSONA, [DIRECT.id], null)).toBe(false);
        expect(folders.setFavoritesExpanded(PERSONA, true)).toBe(false);
        await folders.flush();

        expect(adapter.callsTo('/folders/update')).toHaveLength(requests);
    });

    test('creates a folder and files conversations in it as one request', async () => {
        await started([DIRECT, GROUP]);

        const folder = folders.createFolderWith(PERSONA, 'Trips', [DIRECT.id, GROUP.id]);
        await folders.flush();

        expect(sent()).toHaveLength(1);
        expect(stored().personas[PERSONA].members).toEqual({ [DIRECT.id]: folder.id, [GROUP.id]: folder.id });
    });

    test('moves a folder, and a deleted folder takes its members with it', async () => {
        await started([DIRECT]);
        const first = folders.createFolder(PERSONA, 'First');
        const second = folders.createFolder(PERSONA, 'Second');
        folders.setMembers(PERSONA, [DIRECT.id], first.id);
        folders.moveFolder(PERSONA, second.id, 0);
        expect(folders.layout(PERSONA).folders.map(folder => folder.name)).toEqual(['Second', 'First']);
        folders.deleteFolder(PERSONA, first.id);

        expect(folders.folderOf(PERSONA, DIRECT.id)).toBe('');
        await folders.flush();

        expect(stored().personas[PERSONA].folders.map(folder => folder.name)).toEqual(['Second']);
        expect(stored().personas[PERSONA].members).toEqual({});
    });

    test('tells the listeners once per tick which persona changed', async () => {
        await started();
        events.length = 0;

        folders.createFolder(PERSONA, 'A');
        folders.createFolder(PERSONA, 'B');
        await settle(1);

        expect(events.filter(event => event.type === 'folders')).toEqual([{ type: 'folders', personaId: PERSONA }]);
    });
});

describe('the open and closed state, which changes often', () => {
    test('waits for the delay, and a second change inside it makes one request with the last state', async () => {
        await started();
        const { id } = folders.createFolder(PERSONA, 'Work');
        await folders.flush();
        adapter.calls.length = 0;

        folders.updateFolder(PERSONA, id, { expanded: false });
        folders.updateFolder(PERSONA, id, { expanded: true });
        folders.updateFolder(PERSONA, id, { expanded: false });
        folders.setFavoritesExpanded(PERSONA, false);
        expect(adapter.callsTo('/folders/update')).toHaveLength(0);
        await adapter.clock.advance(FOLDER_FREQUENT_DELAY_MS);
        await settle();

        expect(sent()).toHaveLength(1);
        expect(sent()[0].ops).toEqual([{ op: 'updateFolder', id, expanded: false }, { op: 'setFavoritesExpanded', expanded: false }]);
        expect(stored().personas[PERSONA].folders[0].expanded).toBe(false);
    });

    test('is sent at the latest after the longest wait, however often it changes', async () => {
        await started();
        const { id } = folders.createFolder(PERSONA, 'Work');
        await folders.flush();
        adapter.calls.length = 0;

        for (let step = 0; step < 10; step++) {
            folders.updateFolder(PERSONA, id, { expanded: step % 2 === 1 });
            await adapter.clock.advance(FOLDER_FREQUENT_DELAY_MS - 50);
        }
        await adapter.clock.advance(FOLDER_FREQUENT_MAX_WAIT_MS);
        await settle();

        expect(adapter.callsTo('/folders/update').length).toBeGreaterThanOrEqual(1);
    });

    test('goes out at once, together with what was waiting, when a change that is not an open state follows', async () => {
        await started();
        const { id } = folders.createFolder(PERSONA, 'Work');
        await folders.flush();
        adapter.calls.length = 0;

        folders.updateFolder(PERSONA, id, { expanded: false });
        folders.updateFolder(PERSONA, id, { name: 'Renamed' });
        await adapter.clock.advance(0);
        await settle();

        expect(sent()).toHaveLength(1);
        expect(sent()[0].ops.map(op => op.op)).toEqual(['updateFolder', 'updateFolder']);
        expect(stored().personas[PERSONA].folders[0]).toMatchObject({ name: 'Renamed', expanded: false });
    });

    test('is sent by flush without waiting for the delay', async () => {
        await started();
        folders.setFavoritesExpanded(PERSONA, false);

        expect(folders.hasPendingWrites()).toBe(true);
        await folders.flush();

        expect(folders.hasPendingWrites()).toBe(false);
        expect(stored().personas[PERSONA].favoritesExpanded).toBe(false);
    });
});

describe('what the server answers', () => {
    test('replaces the copy of the persona with the server\'s record, and keeps the changes that were not sent yet on top', async () => {
        await started();
        const { id } = folders.createFolder(PERSONA, 'Work');
        await folders.flush();
        updateConversationFolders(server.user, PERSONA, [{ op: 'createFolder', id: FOLDER_B, name: 'From another tab' }]);

        folders.updateFolder(PERSONA, id, { name: 'Renamed' });
        await folders.flush();

        expect(folders.layout(PERSONA).folders.map(folder => folder.name)).toEqual(['Renamed', 'From another tab']);
    });

    test('keeps a change that is made while the request is in flight', async () => {
        await started();
        const { id } = folders.createFolder(PERSONA, 'Work');
        let release;
        const gate = new Promise((resolve) => {
            release = resolve;
        });
        const base = adapter.fetchJson;
        adapter.fetchJson = async (path, body, options) => {
            if (path === '/folders/update') {
                await gate;
            }
            return base(path, body, options);
        };
        const flushing = folders.flush();
        await settle(2);

        folders.updateFolder(PERSONA, id, { color: '#fff' });
        release();
        await flushing;
        await folders.flush();

        expect(folders.layout(PERSONA).folders[0].color).toBe('#fff');
        expect(stored().personas[PERSONA].folders[0].color).toBe('#fff');
    });

    test('refused with a 4xx: the listeners hear of it and the copy is read again from the file', async () => {
        await started([DIRECT]);
        const { id } = folders.createFolder(PERSONA, 'Work');
        await folders.flush();
        // The conversation is gone on the server, which the page has not heard of.
        folders.setMembers(PERSONA, ['conv_9_missing01'], id);
        events.length = 0;

        await folders.flush();

        expect(events.find(event => event.type === 'error')).toMatchObject({ code: 'not_found' });
        expect(folders.folderOf(PERSONA, 'conv_9_missing01')).toBe('');
        expect(folders.layout(PERSONA).folders.map(folder => folder.name)).toEqual(['Work']);
    });

    test('a 5xx is sent again after the delays, and reported when they are spent', async () => {
        let attempts = 0;
        const answerers = [];
        adapter = scriptedAdapter(async (path, body) => {
            if (path === '/folders/get') {
                return { status: 200, json: { version: 1, personas: {} } };
            }
            attempts++;
            answerers.push(body);
            return { status: 500, json: { error: 'internal' } };
        }, { randomHex: length => 'b'.repeat(length) });
        folders = createConversationFolders(adapter);
        folders.subscribe(event => events.push(event));
        await folders.load();
        folders.createFolder(PERSONA, 'Work');

        await adapter.clock.advance(0);
        await settle();
        expect(attempts).toBe(1);
        for (const delay of FOLDER_RETRY_DELAYS_MS) {
            await adapter.clock.advance(delay);
            await settle();
        }

        expect(attempts).toBe(1 + FOLDER_RETRY_DELAYS_MS.length);
        expect(events.filter(event => event.type === 'error')).toEqual([{ type: 'error', code: 'internal', message: 'A change to the folders could not be saved.' }]);
        expect(new Set(answerers.map(body => JSON.stringify(body))).size).toBe(1);
    });

    test('a network failure is sent again, and lands once the network is back', async () => {
        await started();
        const base = adapter.fetchJson;
        let down = true;
        adapter.fetchJson = async (path, body, options) => {
            if (down && path === '/folders/update') {
                throw new Error('offline');
            }
            return base(path, body, options);
        };
        folders.createFolder(PERSONA, 'Work');
        await adapter.clock.advance(0);
        await settle();
        expect(stored().personas).toEqual({});

        down = false;
        await adapter.clock.advance(FOLDER_RETRY_DELAYS_MS[0]);
        await settle();

        expect(stored().personas[PERSONA].folders.map(folder => folder.name)).toEqual(['Work']);
    });
});

/** The server has a request when it reaches it, and its answer waits for `release()`; the queue sends the next request after the answer. */
function holdFolderUpdates() {
    const gates = [];
    const original = adapter.fetchJson;
    adapter.fetchJson = async (path, body, options) => {
        if (path !== '/folders/update') {
            return original(path, body, options);
        }
        let release;
        const gate = new Promise((resolve) => {
            release = resolve;
        });
        gates.push(release);
        const answer = await original(path, body, options);
        await gate;
        return answer;
    };
    return {
        release: index => gates[index](),
        get requests() {
            return gates.length;
        },
    };
}

describe('changes that are made while an earlier request is out', () => {
    test('the answer to a request does not undo a change that was sent behind it', async () => {
        await started([DIRECT]);
        const held = holdFolderUpdates();

        folders.createFolder(PERSONA, 'One');
        await adapter.clock.advance(0);
        const second = folders.createFolder(PERSONA, 'Two');
        folders.setMembers(PERSONA, [DIRECT.id], second.id);
        await adapter.clock.advance(0);
        expect(held.requests).toBe(1);

        held.release(0);
        await settle(5);

        // The request with the second folder is out now, and its answer has not come.
        expect(held.requests).toBe(2);
        expect(folders.layout(PERSONA).folders.map(folder => folder.name)).toEqual(['One', 'Two']);
        expect(folders.folderOf(PERSONA, DIRECT.id)).toBe(second.id);
        held.release(1);
        await folders.flush();
        expect(folders.folderOf(PERSONA, DIRECT.id)).toBe(second.id);
        expect(stored().personas[PERSONA].members).toEqual({ [DIRECT.id]: second.id });
    });

    test('a conversation that goes back to the folder it was in is filed again, not taken as filed already', async () => {
        await started([DIRECT]);
        const { id } = folders.createFolder(PERSONA, 'One');
        await folders.flush();
        const held = holdFolderUpdates();

        folders.setMembers(PERSONA, [DIRECT.id], id);
        await adapter.clock.advance(0);
        folders.setMembers(PERSONA, [DIRECT.id], null);
        await adapter.clock.advance(0);
        held.release(0);
        await settle(5);
        expect(folders.folderOf(PERSONA, DIRECT.id)).toBe('');

        folders.setMembers(PERSONA, [DIRECT.id], id);
        await adapter.clock.advance(0);
        held.release(1);
        await settle(5);
        held.release(2);
        await folders.flush();

        expect(held.requests).toBe(3);
        expect(folders.folderOf(PERSONA, DIRECT.id)).toBe(id);
        expect(stored().personas[PERSONA].members).toEqual({ [DIRECT.id]: id });
    });

    test('the open state of a section that was sent behind an earlier request stays when its answer comes', async () => {
        await started();
        const { id } = folders.createFolder(PERSONA, 'One');
        await folders.flush();
        const held = holdFolderUpdates();

        folders.updateFolder(PERSONA, id, { name: 'Renamed' });
        await adapter.clock.advance(0);
        folders.updateFolder(PERSONA, id, { expanded: false });
        folders.setFavoritesExpanded(PERSONA, false);
        await adapter.clock.advance(FOLDER_FREQUENT_DELAY_MS);
        held.release(0);
        await settle(5);

        expect(folders.layout(PERSONA)).toMatchObject({ favoritesExpanded: false, folders: [{ name: 'Renamed', expanded: false }] });
        held.release(1);
        await folders.flush();
        expect(stored().personas[PERSONA]).toMatchObject({ favoritesExpanded: false, folders: [{ name: 'Renamed', expanded: false }] });
    });
});

describe('refresh', () => {
    test('reads the file again and keeps the changes that wait to be sent', async () => {
        await started();
        updateConversationFolders(server.user, PERSONA, [{ op: 'createFolder', id: FOLDER_A, name: 'Server side' }]);
        folders.createFolder(PERSONA, 'Waiting');

        await folders.refresh();

        expect(folders.layout(PERSONA).folders.map(folder => folder.name)).toEqual(['Server side', 'Waiting']);
        await folders.flush();
        expect(stored().personas[PERSONA].folders.map(folder => folder.name)).toEqual(['Server side', 'Waiting']);
    });

    test('tells the listeners that the whole file changed', async () => {
        await started();
        events.length = 0;

        await folders.refresh();
        await settle(1);

        expect(events).toContainEqual({ type: 'folders', personaId: null });
    });

    test('shows a membership that the server moved, such as the folder of a converted group', async () => {
        await started([DIRECT]);
        const { id } = folders.createFolder(PERSONA, 'Work');
        await folders.flush();
        updateConversationFolders(server.user, PERSONA, [{ op: 'setMembers', ids: [DIRECT.id], folderId: id }]);
        expect(folders.folderOf(PERSONA, DIRECT.id)).toBe('');

        await folders.refresh();

        expect(folders.folderOf(PERSONA, DIRECT.id)).toBe(id);
    });
});

describe('flush and destroy', () => {
    test('flush with keepalive passes the flag to the request', async () => {
        await started();
        folders.setFavoritesExpanded(PERSONA, false);

        await folders.flush({ keepalive: true });

        expect(adapter.callsTo('/folders/update')[0].options).toEqual({ keepalive: true });
    });

    test('destroy drops the timers, so that nothing is sent afterwards', async () => {
        await started();
        folders.setFavoritesExpanded(PERSONA, false);

        folders.destroy();
        await adapter.clock.advance(10_000);
        await settle();

        expect(adapter.callsTo('/folders/update')).toHaveLength(0);
    });
});

describe('onLoad of the data module, which keeps the folders in step', () => {
    test('runs for every read of the list: the start, a refresh and the read after a conversion, and stops when it is removed', async () => {
        seedConversations(server, [DIRECT]);
        const data = createConversationData(server.adapter());
        const calls = [];
        const stop = data.onLoad(() => calls.push('load'));
        data.onLoad(() => {
            throw new Error('a listener that fails');
        });
        jest.spyOn(console, 'error').mockImplementation(() => {});

        await data.start();
        expect(calls).toEqual(['load']);
        await data.refresh();
        expect(calls).toEqual(['load', 'load']);
        stop();
        await data.refresh();
        expect(calls).toEqual(['load', 'load']);
        data.destroy();
    });

    test('lets the folders read the file again when a conversion moved a folder entry on the server', async () => {
        seedConversations(server, [{ ...GROUP, favorite: false, id: 'conv_3_trip00001' }]);
        const data = createConversationData(server.adapter());
        adapter = withAdapter(server.adapter());
        folders = createConversationFolders(adapter);
        data.onLoad(() => {
            void folders.refresh();
        });
        await data.start();
        await folders.load();
        const { id } = folders.createFolder(PERSONA, 'Trips');
        folders.setMembers(PERSONA, ['conv_3_trip00001'], id);
        await folders.flush();

        const result = await data.removeMember('conv_3_trip00001', 'Orion.png');
        await settle();

        expect(result.converted).toBe(true);
        expect(folders.folderOf(PERSONA, 'conv_3_trip00001')).toBe('');
        expect(folders.folderOf(PERSONA, result.conversation.id)).toBe(id);
        data.destroy();
    });
});
