import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { setConfigFilePath } from '../src/util.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const originalWorkingDirectory = process.cwd();
const diskCacheEnvironmentKey = 'SILLYTAVERN_PERFORMANCE_USEDISKCACHE';
const originalDiskCacheSetting = process.env[diskCacheEnvironmentKey];
process.env[diskCacheEnvironmentKey] = 'false';
process.chdir(repoRoot);
setConfigFilePath(path.join(repoRoot, 'default', 'config.yaml'));

const { router: charactersRouter } = await import('../src/endpoints/characters.js');
const { migrateGroupChatsMetadataFormat, router: groupsRouter } = await import('../src/endpoints/groups.js');

describe('entity date added endpoints', () => {
    let baseUrl;
    let directories;
    let server;
    let tempRoot;

    beforeAll(async () => {
        const app = express();
        app.use(express.json({ limit: '10mb' }));
        app.use((request, _response, next) => {
            request.user = {
                profile: { handle: 'date-added-test-user' },
                directories,
            };
            next();
        });
        app.use('/api/characters', charactersRouter);
        app.use('/api/groups', groupsRouter);

        await new Promise(resolve => {
            server = app.listen(0, '127.0.0.1', resolve);
        });
        baseUrl = `http://127.0.0.1:${server.address().port}`;
    });

    beforeEach(() => {
        tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sillybunny-date-added-endpoints-'));
        directories = {
            root: tempRoot,
            backups: path.join(tempRoot, 'backups'),
            chats: path.join(tempRoot, 'chats'),
            characters: path.join(tempRoot, 'characters'),
            groupChats: path.join(tempRoot, 'group chats'),
            groups: path.join(tempRoot, 'groups'),
            thumbnailsAvatar: path.join(tempRoot, 'thumbnails', 'avatar'),
            worlds: path.join(tempRoot, 'worlds'),
        };
        for (const directory of Object.values(directories)) {
            fs.mkdirSync(directory, { recursive: true });
        }
    });

    afterEach(() => {
        jest.restoreAllMocks();
        fs.rmSync(tempRoot, { recursive: true, force: true });
    });

    afterAll(async () => {
        if (server) {
            await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        }
        if (originalDiskCacheSetting === undefined) {
            delete process.env[diskCacheEnvironmentKey];
        } else {
            process.env[diskCacheEnvironmentKey] = originalDiskCacheSetting;
        }
        process.chdir(originalWorkingDirectory);
    });

    test('preserves character addition time across edits and renames while treating copies as new', async () => {
        jest.spyOn(console, 'error').mockImplementation(() => {});
        jest.spyOn(console, 'info').mockImplementation(() => {});
        const createResponse = await postJson('/api/characters/create', {
            ch_name: 'Alice',
            file_name: 'Alice',
        });
        expect(createResponse.status).toBe(200);
        expect(await createResponse.text()).toBe('Alice.png');

        const [created] = await getCharacters();
        const originalDateAdded = created.date_added;

        await delay();
        const editResponse = await postJson('/api/characters/edit', {
            avatar_url: 'Alice.png',
            ch_name: 'Alice',
            chat: created.chat,
            create_date: created.create_date,
            json_data: created.json_data,
        });
        expect(editResponse.status).toBe(200);

        const [edited] = await getCharacters();
        expect(edited.date_added).toBe(originalDateAdded);

        await delay();
        const renameResponse = await postJson('/api/characters/rename', {
            avatar_url: 'Alice.png',
            new_name: 'Alicia',
        });
        expect(renameResponse.status).toBe(200);
        const renamedAvatar = (await renameResponse.json()).avatar;
        const renamed = (await getCharacters()).find(character => character.avatar === renamedAvatar);
        expect(renamed.date_added).toBe(originalDateAdded);

        await delay();
        const duplicateResponse = await postJson('/api/characters/duplicate', { avatar_url: renamedAvatar });
        expect(duplicateResponse.status).toBe(200);
        const duplicateAvatar = (await duplicateResponse.json()).path;
        const duplicated = (await getCharacters()).find(character => character.avatar === duplicateAvatar);
        expect(duplicated.date_added).toBeGreaterThan(originalDateAdded);

        const deleteResponse = await postJson('/api/characters/delete', {
            avatar_url: renamedAvatar,
            delete_chats: false,
        });
        expect(deleteResponse.status).toBe(200);

        await delay();
        const recreateResponse = await postJson('/api/characters/create', {
            ch_name: 'Alicia',
            file_name: path.parse(renamedAvatar).name,
        });
        expect(recreateResponse.status).toBe(200);
        const recreated = (await getCharacters()).find(character => character.avatar === renamedAvatar);
        expect(recreated.date_added).toBeGreaterThan(originalDateAdded);
    });

    test('restores character chats when a rename cannot remove the old avatar', async () => {
        jest.spyOn(console, 'error').mockImplementation(() => {});
        jest.spyOn(console, 'info').mockImplementation(() => {});
        const createResponse = await postJson('/api/characters/create', {
            ch_name: 'Alice',
            file_name: 'Alice',
        });
        expect(createResponse.status).toBe(200);
        const [created] = await getCharacters();
        const oldAvatarPath = path.join(directories.characters, 'Alice.png');
        const newAvatarPath = path.join(directories.characters, 'Alicia.png');
        const oldChatsPath = path.join(directories.chats, 'Alice');
        const newChatsPath = path.join(directories.chats, 'Alicia');
        fs.mkdirSync(oldChatsPath, { recursive: true });
        fs.writeFileSync(path.join(oldChatsPath, 'Chat.jsonl'), '{}\n');
        const unlinkSync = fs.unlinkSync.bind(fs);
        jest.spyOn(fs, 'unlinkSync').mockImplementation(filePath => {
            if (path.resolve(String(filePath)) === path.resolve(oldAvatarPath)) {
                const error = new Error('The old avatar is locked.');
                error.code = 'EBUSY';
                throw error;
            }
            return unlinkSync(filePath);
        });

        const renameResponse = await postJson('/api/characters/rename', {
            avatar_url: 'Alice.png',
            new_name: 'Alicia',
        });

        expect(renameResponse.status).toBe(500);
        expect(fs.existsSync(oldAvatarPath)).toBe(true);
        expect(fs.existsSync(newAvatarPath)).toBe(false);
        expect(fs.existsSync(path.join(oldChatsPath, 'Chat.jsonl'))).toBe(true);
        expect(fs.existsSync(newChatsPath)).toBe(false);
        const [restored] = await getCharacters();
        expect(restored.avatar).toBe('Alice.png');
        expect(restored.date_added).toBe(created.date_added);
    });

    test('restores a complete chat snapshot after partial rename cleanup', async () => {
        jest.spyOn(console, 'error').mockImplementation(() => {});
        const createResponse = await postJson('/api/characters/create', {
            ch_name: 'Alice',
            file_name: 'Alice',
        });
        expect(createResponse.status).toBe(200);
        const oldAvatarPath = path.join(directories.characters, 'Alice.png');
        const newAvatarPath = path.join(directories.characters, 'Alicia.png');
        const oldChatsPath = path.join(directories.chats, 'Alice');
        const newChatsPath = path.join(directories.chats, 'Alicia');
        fs.mkdirSync(oldChatsPath, { recursive: true });
        fs.writeFileSync(path.join(oldChatsPath, 'First.jsonl'), '{}\n');
        fs.writeFileSync(path.join(oldChatsPath, 'Second.jsonl'), '{}\n');
        const rmSync = fs.rmSync.bind(fs);
        let removalFailed = false;
        jest.spyOn(fs, 'rmSync').mockImplementation((targetPath, options) => {
            if (!removalFailed && path.resolve(String(targetPath)) === path.resolve(oldChatsPath)) {
                removalFailed = true;
                rmSync(path.join(oldChatsPath, 'First.jsonl'), { force: true });
                const error = new Error('Chat directory cleanup was interrupted.');
                error.code = 'EBUSY';
                throw error;
            }
            return rmSync(targetPath, options);
        });

        const renameResponse = await postJson('/api/characters/rename', {
            avatar_url: 'Alice.png',
            new_name: 'Alicia',
        });

        expect(renameResponse.status).toBe(500);
        expect(fs.existsSync(oldAvatarPath)).toBe(true);
        expect(fs.existsSync(newAvatarPath)).toBe(false);
        expect(fs.existsSync(path.join(oldChatsPath, 'First.jsonl'))).toBe(true);
        expect(fs.existsSync(path.join(oldChatsPath, 'Second.jsonl'))).toBe(true);
        expect(fs.existsSync(newChatsPath)).toBe(false);
    });

    test('preserves group addition time across atomic edits', async () => {
        const createResponse = await postJson('/api/groups/create', {
            name: 'Test Group',
            members: [],
        });
        expect(createResponse.status).toBe(200);
        const createdGroup = await createResponse.json();
        const [listedGroup] = await getGroups();
        const originalDateAdded = listedGroup.date_added;

        await delay();
        const editResponse = await postJson('/api/groups/edit', {
            ...createdGroup,
            name: 'Updated Group',
        });
        expect(editResponse.status).toBe(200);

        const [editedGroup] = await getGroups();
        expect(editedGroup.name).toBe('Updated Group');
        expect(editedGroup.date_added).toBe(originalDateAdded);
    });

    test('freezes group addition time before startup metadata migrations rewrite files', async () => {
        jest.spyOn(console, 'log').mockImplementation(() => {});
        jest.spyOn(console, 'error').mockImplementation(() => {});
        const groupPath = path.join(directories.groups, 'legacy-group.json');
        const unstatableGroupPath = path.join(directories.groups, 'unstatable-group.json');
        fs.writeFileSync(groupPath, JSON.stringify({
            id: 'legacy-group',
            name: 'Legacy Group',
            members: [],
            chats: [],
            chat_id: '',
            chat_metadata: {},
            past_metadata: {},
        }));
        fs.writeFileSync(unstatableGroupPath, JSON.stringify({
            id: 'unstatable-group',
            name: 'Unstatable Group',
            members: [],
            chats: [],
            chat_id: '',
        }));
        const initialStat = fs.statSync(groupPath);
        const expectedDateAdded = [initialStat.birthtimeMs, initialStat.ctimeMs, initialStat.mtimeMs]
            .find(timestamp => Number.isFinite(timestamp) && timestamp > 0);
        const statSync = fs.statSync.bind(fs);
        jest.spyOn(fs, 'statSync').mockImplementation(filePath => {
            if (path.resolve(String(filePath)) === path.resolve(unstatableGroupPath)) {
                const error = new Error('File disappeared during startup migration.');
                error.code = 'ENOENT';
                throw error;
            }
            return statSync(filePath);
        });

        await delay();
        await migrateGroupChatsMetadataFormat([directories]);

        const migratedGroup = (await getGroups()).find(group => group.id === 'legacy-group');
        expect(migratedGroup.date_added).toBe(expectedDateAdded);
        const migratedData = JSON.parse(fs.readFileSync(groupPath, 'utf8'));
        expect(migratedData).not.toHaveProperty('chat_metadata');
        expect(migratedData).not.toHaveProperty('past_metadata');
    });

    function postJson(resource, body = {}) {
        return fetch(`${baseUrl}${resource}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
    }

    async function getCharacters() {
        const response = await postJson('/api/characters/all');
        expect(response.status).toBe(200);
        return response.json();
    }

    async function getGroups() {
        const response = await postJson('/api/groups/all');
        expect(response.status).toBe(200);
        return response.json();
    }

    function delay() {
        return new Promise(resolve => setTimeout(resolve, 25));
    }
});
