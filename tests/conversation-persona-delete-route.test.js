/* global globalThis */
import fs from 'node:fs';
import path from 'node:path';

import express from 'express';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';

import { header, line } from './util/conversation-store-sandbox.js';
import { nativeTmpDir } from './util/platform-capabilities.js';

const { createConversation, readConversationFolders, updateConversationFolders } = await import('../src/conversation-store.js');
const { conversationIndex } = await import('../src/conversation-index.js');

const PERSONA = 'persona-one.png';
const PERSONA_TWO = 'persona-two.png';

/** Seeds one conversation with one chat of two lines. */
function seed(user, id, kind, characters, extra = {}) {
    return createConversation(user, {
        id,
        kind,
        personaId: PERSONA,
        characters,
        chats: [{ id: 'main', name: 'Main', records: [header(), line('u1', 'Hello', { user: true }), line('c1', 'Hi', { minute: 1 })] }],
        ...extra,
    }).conversation;
}

describe('POST /api/avatars/delete calls the conversation store', () => {
    let server;
    let baseUrl;
    let user;
    let root;
    let previousDataRoot;

    beforeAll(async () => {
        const { router } = await import('../src/endpoints/avatars.js');
        const app = express();
        app.use(express.json());
        app.use((request, _response, next) => {
            request.user = user;
            next();
        });
        app.use('/api/avatars', router);
        server = await new Promise((resolve) => {
            const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
        });
        baseUrl = `http://127.0.0.1:${server.address().port}`;
    });

    afterAll(async () => {
        await new Promise(resolve => server.close(resolve));
    });

    beforeEach(() => {
        root = fs.mkdtempSync(path.join(nativeTmpDir(), 'sillybunny-persona-delete-'));
        previousDataRoot = globalThis.DATA_ROOT;
        globalThis.DATA_ROOT = root;
        const directories = {
            root,
            conversations: path.join(root, 'conversations'),
            avatars: path.join(root, 'User Avatars'),
            backups: path.join(root, 'backups'),
            thumbnailsPersona: path.join(root, 'thumbnails', 'persona'),
            thumbnailsPersonaMobile: path.join(root, 'thumbnails', 'persona', 'mobile'),
        };
        for (const directory of Object.values(directories)) {
            fs.mkdirSync(directory, { recursive: true });
        }
        user = { profile: { handle: 'persona-delete-user' }, directories };
        fs.writeFileSync(path.join(directories.avatars, PERSONA), 'png');
        fs.writeFileSync(path.join(directories.avatars, PERSONA_TWO), 'png');
        for (const method of ['debug', 'error', 'info', 'log', 'warn']) {
            jest.spyOn(console, method).mockImplementation(() => {});
        }
    });

    afterEach(() => {
        jest.restoreAllMocks();
        conversationIndex.close();
        globalThis.DATA_ROOT = previousDataRoot;
        if (root) {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    const remove = async (avatar) => {
        const response = await fetch(`${baseUrl}/api/avatars/delete`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ avatar }) });
        return { status: response.status, text: await response.text() };
    };
    const folders = () => fs.readdirSync(user.directories.conversations).filter(name => name.startsWith('conv_')).sort();

    test('deletes the conversations of the persona, direct and group, and keeps those of the other persona', async () => {
        seed(user, 'conv_1_direct', 'direct', ['Probe.png']);
        seed(user, 'conv_2_group', 'group', ['Probe.png', 'Other.png']);
        seed(user, 'conv_3_other', 'direct', ['Probe.png'], { personaId: PERSONA_TWO });

        const answer = await remove(PERSONA);

        expect(answer.status).toBe(200);
        expect(JSON.parse(answer.text)).toEqual({ result: 'ok' });
        expect(fs.existsSync(path.join(user.directories.avatars, PERSONA))).toBe(false);
        expect(folders()).toEqual(['conv_3_other']);
    });

    test('deletes the folders of the persona with its conversations, and keeps those of the other persona', async () => {
        seed(user, 'conv_1_direct', 'direct', ['Probe.png']);
        seed(user, 'conv_3_other', 'direct', ['Probe.png'], { personaId: PERSONA_TWO });
        updateConversationFolders(user, PERSONA, [{ op: 'createFolder', id: 'fld_1_aaaaaaaa', name: 'Mine' }, { op: 'setMembers', ids: ['conv_1_direct'], folderId: 'fld_1_aaaaaaaa' }]);
        updateConversationFolders(user, PERSONA_TWO, [{ op: 'createFolder', id: 'fld_1_bbbbbbbb', name: 'Theirs' }, { op: 'setMembers', ids: ['conv_3_other'], folderId: 'fld_1_bbbbbbbb' }]);

        expect((await remove(PERSONA)).status).toBe(200);

        expect(Object.keys(readConversationFolders(user).personas)).toEqual([PERSONA_TWO]);
        expect(readConversationFolders(user).personas[PERSONA_TWO].members).toEqual({ conv_3_other: 'fld_1_bbbbbbbb' });
    });

    test('deletes nothing when the persona file does not exist', async () => {
        seed(user, 'conv_1_direct', 'direct', ['Probe.png'], { personaId: 'ghost.png' });

        expect((await remove('ghost.png')).status).toBe(404);

        expect(folders()).toEqual(['conv_1_direct']);
    });

    test.each(['../persona-one.png', 'a/b.png', '..'])('deletes nothing for the name %s', async (name) => {
        seed(user, 'conv_1_direct', 'direct', ['Probe.png']);

        const answer = await remove(name);

        expect(answer.status).toBeGreaterThanOrEqual(400);
        expect(folders()).toEqual(['conv_1_direct']);
        expect(fs.existsSync(path.join(user.directories.avatars, PERSONA))).toBe(true);
    });

    test('still answers ok when a conversation cannot be deleted', async () => {
        seed(user, 'conv_1_direct', 'direct', ['Probe.png']);
        const rm = fs.rmSync;
        jest.spyOn(fs, 'rmSync').mockImplementation((target, ...rest) => {
            if (String(target).endsWith('conv_1_direct')) {
                throw new Error('disk exploded');
            }
            return rm(target, ...rest);
        });

        const answer = await remove(PERSONA);

        expect(answer.status).toBe(200);
        expect(fs.existsSync(path.join(user.directories.avatars, PERSONA))).toBe(false);
    });
});
