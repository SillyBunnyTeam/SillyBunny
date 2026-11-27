import fs from 'node:fs';
import path from 'node:path';

import express from 'express';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';

import { createSandboxUser, PERSONA, PERSONA_TWO } from './util/conversation-store-sandbox.js';
import { canCreateFileSymlinks } from './util/platform-capabilities.js';

const describeWithFileSymlinks = canCreateFileSymlinks() ? describe : describe.skip;

const { router } = await import('../src/endpoints/sillybunny-conversation.js');
const { createConversation } = await import('../src/conversation-store.js');

const PREFIX = '/api/sillybunny-conversation';
const FOLDER_A = 'fld_1764000000000_a1b2c3d4e5f6';
const FOLDER_B = 'fld_1764000000001_b1b2c3d4e5f6';

let server;
let baseUrl;
let sandbox;
let user;

beforeAll(async () => {
    const app = express();
    app.use(express.json({ limit: '50mb' }));
    app.use((request, _response, next) => {
        request.user = user;
        next();
    });
    app.use(PREFIX, router);
    await new Promise((resolve) => {
        server = app.listen(0, '127.0.0.1', resolve);
    });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
    await new Promise(resolve => server.close(resolve));
});

beforeEach(() => {
    sandbox = createSandboxUser();
    user = sandbox.user;
});

afterEach(() => {
    sandbox.cleanup();
});

async function post(route, body) {
    const response = await fetch(`${baseUrl}${PREFIX}${route}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: typeof body === 'string' ? body : JSON.stringify(body),
    });
    const text = await response.text();
    let json = null;
    try {
        json = JSON.parse(text);
    } catch {
        // The body is not JSON; the test reads `text`.
    }
    return { status: response.status, json, text };
}

const update = (ops, personaId = PERSONA) => post('/folders/update', { personaId, ops });
const create = (id = FOLDER_A, name = 'Work') => ({ op: 'createFolder', id, name });
const foldersFile = () => path.join(user.directories.conversations, 'folders.json');
const directConversation = (personaId = PERSONA) => createConversation(user, { kind: 'direct', personaId, characters: ['Nova.png'] }).conversation;

describe('POST /folders/update and /folders/get', () => {
    test('update stores the folders of a persona and answers its record, and get reads the whole file', async () => {
        const answer = await update([create(FOLDER_A, 'Work'), create(FOLDER_B, 'Friends'), { op: 'setFavoritesExpanded', expanded: false }]);

        expect(answer.status).toBe(200);
        expect(answer.json).toEqual({
            personaId: PERSONA,
            folders: {
                favoritesExpanded: false,
                folders: [
                    { id: FOLDER_A, name: 'Work', color: '', expanded: true },
                    { id: FOLDER_B, name: 'Friends', color: '', expanded: true },
                ],
                members: {},
            },
        });
        expect((await post('/folders/get', {})).json).toEqual({
            version: 1,
            personas: { [PERSONA]: { favoritesExpanded: false, folders: answer.json.folders.folders, members: {} } },
        });
    });

    test('get answers an empty file for a user with no folders', async () => {
        expect(await post('/folders/get', {})).toMatchObject({ status: 200, json: { version: 1, personas: {} } });
    });

    test('files a conversation, and answers where it is', async () => {
        const conversation = directConversation();
        await update([create()]);

        const { status, json } = await update([{ op: 'setMembers', ids: [conversation.id], folderId: FOLDER_A }]);

        expect(status).toBe(200);
        expect(json.folders.members).toEqual({ [conversation.id]: FOLDER_A });
    });

    test('keeps two personas apart', async () => {
        await update([create(FOLDER_A, 'One')], PERSONA);
        await update([create(FOLDER_B, 'Two')], PERSONA_TWO);

        const { json } = await post('/folders/get', {});

        expect(json.personas[PERSONA].folders.map(folder => folder.name)).toEqual(['One']);
        expect(json.personas[PERSONA_TWO].folders.map(folder => folder.name)).toEqual(['Two']);
    });

    test.each([
        ['an operation list that is empty', { personaId: PERSONA, ops: [] }, 400, 'invalid_input'],
        ['ops that is not a list', { personaId: PERSONA, ops: { op: 'createFolder' } }, 400, 'invalid_input'],
        ['no ops', { personaId: PERSONA }, 400, 'invalid_input'],
        ['a field that the route does not have', { personaId: PERSONA, ops: [create()], force: true }, 400, 'invalid_input'],
        ['an operation that does not exist', { personaId: PERSONA, ops: [{ op: 'rename', id: FOLDER_A, name: 'x' }] }, 400, 'invalid_input'],
        ['a prototype name as the operation', { personaId: PERSONA, ops: [{ op: '__proto__' }] }, 400, 'invalid_input'],
        ['a folder name that is blank', { personaId: PERSONA, ops: [create(FOLDER_A, '   ')] }, 400, 'invalid_input'],
        ['a folder name past 100 characters', { personaId: PERSONA, ops: [create(FOLDER_A, 'x'.repeat(101))] }, 400, 'invalid_input'],
        ['a folder name with a NUL', { personaId: PERSONA, ops: [create(FOLDER_A, 'a\u0000b')] }, 400, 'invalid_input'],
        ['a folder name with a new line', { personaId: PERSONA, ops: [create(FOLDER_A, 'a\nb')] }, 400, 'invalid_input'],
        ['a name that is a number', { personaId: PERSONA, ops: [{ op: 'createFolder', id: FOLDER_A, name: 5 }] }, 400, 'invalid_input'],
        ['a colour that is a url', { personaId: PERSONA, ops: [{ op: 'createFolder', id: FOLDER_A, name: 'x', color: 'url(https://example.test/x)' }] }, 400, 'invalid_input'],
        ['a folder id that is a path', { personaId: PERSONA, ops: [create('../../etc/passwd')] }, 400, 'invalid_id'],
        ['a folder id that is an object with a toString', { personaId: PERSONA, ops: [{ op: 'createFolder', id: { toString: () => FOLDER_A }, name: 'x' }] }, 400, 'invalid_id'],
        ['a folder id that is __proto__', { personaId: PERSONA, ops: [{ op: 'deleteFolder', id: '__proto__' }] }, 400, 'invalid_id'],
        ['a conversation id that is a path', { personaId: PERSONA, ops: [{ op: 'setMembers', ids: ['../x'], folderId: null }] }, 400, 'invalid_id'],
        ['a conversation id that is the folder file', { personaId: PERSONA, ops: [{ op: 'setMembers', ids: ['folders.json'], folderId: null }] }, 400, 'invalid_id'],
        ['a persona id that is a path', { personaId: '../x', ops: [create()] }, 400, 'invalid_id'],
        ['a persona id that is a prototype key', { personaId: 'constructor', ops: [create()] }, 400, 'invalid_id'],
        ['a persona id that is a number', { personaId: 5, ops: [create()] }, 400, 'invalid_id'],
        ['no persona id', { ops: [create()] }, 400, 'invalid_id'],
        ['a persona id that is an array', { personaId: [PERSONA], ops: [create()] }, 400, 'invalid_id'],
        ['a folder that does not exist', { personaId: PERSONA, ops: [{ op: 'deleteFolder', id: FOLDER_B }] }, 404, 'not_found'],
        ['a conversation that does not exist, filed in a folder', { personaId: PERSONA, ops: [create(), { op: 'setMembers', ids: ['conv_1_abcdefgh'], folderId: FOLDER_A }] }, 404, 'not_found'],
        ['33 operations', { personaId: PERSONA, ops: Array.from({ length: 33 }, () => create()) }, 400, 'invalid_input'],
    ])('update refuses %s and writes nothing', async (_name, body, status, code) => {
        const answer = await post('/folders/update', body);

        expect(answer.status).toBe(status);
        expect(answer.json.error).toBe(code);
        expect(fs.existsSync(foldersFile())).toBe(false);
    });

    test('update refuses a conversation of another persona, with 400', async () => {
        const foreign = directConversation(PERSONA_TWO);
        await update([create()]);

        const answer = await update([{ op: 'setMembers', ids: [foreign.id], folderId: FOLDER_A }]);

        expect(answer).toMatchObject({ status: 400, json: { error: 'invalid_input' } });
    });

    test('update refuses a folder id that exists already with 409', async () => {
        await update([create()]);

        expect(await update([create(FOLDER_A, 'Again')])).toMatchObject({ status: 409, json: { error: 'exists' } });
    });

    test('update refuses the 51st folder with 400, and keeps the 50', async () => {
        const ids = Array.from({ length: 51 }, (_, index) => `fld_1764000000000_${String(index).padStart(12, 'a')}`);
        expect((await update(ids.slice(0, 25).map(id => create(id)))).status).toBe(200);
        expect((await update(ids.slice(25, 50).map(id => create(id)))).status).toBe(200);

        expect(await update([create(ids[50])])).toMatchObject({ status: 400, json: { error: 'invalid_input' } });
        expect((await post('/folders/get', {})).json.personas[PERSONA].folders).toHaveLength(50);
    });

    test('update puts the message of an invalid_input in the answer and no path of the server', async () => {
        const { json } = await update([create(FOLDER_A, '')]);

        expect(json.error).toBe('invalid_input');
        expect(json.message).toMatch(/name/);
        expect(JSON.stringify(json)).not.toContain(sandbox.root);
    });

    test('every folder route refuses a body that is an array, and a body that is not JSON never reaches it', async () => {
        for (const route of ['/folders/get', '/folders/update']) {
            expect({ route, status: (await post(route, [])).status }).toEqual({ route, status: 400 });
            expect({ route, status: (await post(route, '{ not json')).status }).toEqual({ route, status: 400 });
        }
        expect(fs.existsSync(foldersFile())).toBe(false);
    });

    test('a failure that is not the caller\'s answers 500 with no detail', async () => {
        jest.spyOn(console, 'error').mockImplementation(() => {});
        const read = fs.readFileSync;
        const write = jest.spyOn(fs, 'readFileSync').mockImplementation((file, ...rest) => {
            if (String(file).endsWith('folders.json')) {
                throw new Error('disk exploded at /secret/path');
            }
            return read(file, ...rest);
        });
        try {
            fs.writeFileSync(foldersFile(), '{}');
            const { status, json, text } = await update([create()]);

            expect(status).toBe(500);
            expect(json).toEqual({ error: 'internal' });
            expect(text).not.toContain('/secret/path');
        } finally {
            write.mockRestore();
            jest.restoreAllMocks();
        }
    });

    describeWithFileSymlinks('when file symbolic links can be created', () => {
        test('a folders.json that is a link out of the conversations folder is not followed, and the answer names no path', async () => {
            const outside = path.join(sandbox.root, 'outside.json');
            fs.writeFileSync(outside, '{"version":1,"personas":{}}');
            fs.symlinkSync(outside, foldersFile());

            const written = await update([create()]);
            const read = await post('/folders/get', {});

            expect(written).toMatchObject({ status: 400, json: { error: 'invalid_id' } });
            expect(read).toMatchObject({ status: 400, json: { error: 'invalid_id' } });
            expect(written.text + read.text).not.toContain(sandbox.root);
            expect(fs.readFileSync(outside, 'utf8')).toBe('{"version":1,"personas":{}}');
        });
    });
});
