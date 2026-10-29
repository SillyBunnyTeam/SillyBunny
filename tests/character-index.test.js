/* global globalThis */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import '../src/fetch-patch.js';
import { setConfigFilePath } from '../src/util.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const originalWorkingDirectory = process.cwd();
const originalDataRoot = globalThis.DATA_ROOT;
const environment = {
    SILLYTAVERN_PERFORMANCE_USEDISKCACHE: 'true',
    // A capacity of 0 turns off the memory cache, so every card read goes through the index.
    SILLYTAVERN_PERFORMANCE_MEMORYCACHECAPACITY: '0',
};
const originalEnvironment = Object.fromEntries(Object.keys(environment).map(key => [key, process.env[key]]));
Object.assign(process.env, environment);
process.chdir(repoRoot);
setConfigFilePath(path.join(repoRoot, 'default', 'config.yaml'));

const { CharacterIndex } = await import('../src/character-index.js');
const { characterIndex, router: charactersRouter } = await import('../src/endpoints/characters.js');

afterAll(() => {
    globalThis.DATA_ROOT = originalDataRoot;
    for (const [key, value] of Object.entries(originalEnvironment)) {
        if (value === undefined) {
            delete process.env[key];
        } else {
            process.env[key] = value;
        }
    }
    process.chdir(originalWorkingDirectory);
});

describe('character index', () => {
    let index;
    let tempRoot;

    beforeEach(() => {
        tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sillybunny-character-index-'));
        globalThis.DATA_ROOT = tempRoot;
        index = new CharacterIndex({ enabled: true });
    });

    afterEach(() => {
        index.close();
        jest.restoreAllMocks();
        fs.rmSync(tempRoot, { recursive: true, force: true });
    });

    test('returns a card only while its file has the stored size and modification time', () => {
        const cardPath = writeFile(path.join(tempRoot, 'characters', 'Alice.png'), 'alice');
        const stat = fs.statSync(cardPath);
        index.set(cardPath, stat, 'alice data');

        expect(index.get(cardPath, stat)).toBe('alice data');
        expect(index.get(cardPath, { size: stat.size + 1, mtimeMs: stat.mtimeMs })).toBeUndefined();
        expect(index.get(cardPath, { size: stat.size, mtimeMs: stat.mtimeMs + 1 })).toBeUndefined();
    });

    test('keeps cards when it is opened again', () => {
        const cardPath = writeFile(path.join(tempRoot, 'characters', 'Alice.png'), 'alice');
        const stat = fs.statSync(cardPath);
        index.set(cardPath, stat, 'alice data');
        index.close();

        const reopened = new CharacterIndex({ enabled: true });
        try {
            expect(reopened.get(cardPath, stat)).toBe('alice data');
        } finally {
            reopened.close();
        }
    });

    test('delete removes a card', () => {
        const cardPath = writeFile(path.join(tempRoot, 'characters', 'Alice.png'), 'alice');
        const stat = fs.statSync(cardPath);
        index.set(cardPath, stat, 'alice data');

        index.delete(cardPath);

        expect(index.get(cardPath, stat)).toBeUndefined();
    });

    test('pruneDirectory removes the cards that are not in the directory listing', () => {
        const firstDirectory = path.join(tempRoot, 'first-user', 'characters');
        const secondDirectory = path.join(tempRoot, 'second-user', 'characters');
        const stats = storeCards(index, [
            path.join(firstDirectory, 'Alice.png'),
            path.join(firstDirectory, 'Bob.png'),
            path.join(secondDirectory, 'Carol.png'),
        ]);

        index.pruneDirectory(firstDirectory, ['Alice.png']);

        expect(readCards(index, stats)).toEqual(['Alice.png', 'Carol.png']);
    });

    test('prune keeps the cards of every user and deletes the old disk cache', async () => {
        const firstUser = { characters: path.join(tempRoot, 'first-user', 'characters') };
        const secondUser = { characters: path.join(tempRoot, 'second-user', 'characters') };
        const deletedCard = path.join(firstUser.characters, 'Deleted.png');
        const stats = storeCards(index, [
            path.join(firstUser.characters, 'Alice.png'),
            path.join(secondUser.characters, 'Bob.png'),
            deletedCard,
            path.join(tempRoot, 'removed-user', 'characters', 'Carol.png'),
        ]);
        fs.rmSync(deletedCard);
        const legacyCacheEntry = writeFile(path.join(tempRoot, '_cache', 'characters', 'entry'), '{}');

        await index.prune([firstUser, secondUser]);

        expect(readCards(index, stats)).toEqual(['Alice.png', 'Bob.png']);
        expect(fs.existsSync(path.dirname(legacyCacheEntry))).toBe(false);
    });

    test('replaces an index file that is not a database', () => {
        writeFile(index.filePath, 'not a database');
        const cardPath = writeFile(path.join(tempRoot, 'characters', 'Alice.png'), 'alice');
        const stat = fs.statSync(cardPath);

        index.set(cardPath, stat, 'alice data');
        index.close();

        const reopened = new CharacterIndex({ enabled: true });
        try {
            expect(reopened.get(cardPath, stat)).toBe('alice data');
        } finally {
            reopened.close();
        }
    });

    test('turns off with one warning when the database cannot be opened', () => {
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        globalThis.DATA_ROOT = writeFile(path.join(tempRoot, 'not-a-directory'), '');
        const cardPath = writeFile(path.join(tempRoot, 'characters', 'Alice.png'), 'alice');
        const stat = fs.statSync(cardPath);

        index.set(cardPath, stat, 'alice data');

        expect(index.get(cardPath, stat)).toBeUndefined();
        expect(warn).toHaveBeenCalledTimes(1);
    });

    test('does not create a database file when it is disabled', () => {
        const disabledIndex = new CharacterIndex({ enabled: false });
        const cardPath = writeFile(path.join(tempRoot, 'characters', 'Alice.png'), 'alice');
        const stat = fs.statSync(cardPath);

        disabledIndex.set(cardPath, stat, 'alice data');

        expect(disabledIndex.get(cardPath, stat)).toBeUndefined();
        expect(fs.existsSync(disabledIndex.filePath)).toBe(false);
    });
});

describe('character routes with the index', () => {
    let baseUrl;
    let directories;
    let server;
    let tempRoot;

    beforeAll(async () => {
        tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sillybunny-character-index-routes-'));
        globalThis.DATA_ROOT = tempRoot;
        const userRoot = path.join(tempRoot, 'index-test-user');
        directories = {
            root: userRoot,
            backups: path.join(userRoot, 'backups'),
            chats: path.join(userRoot, 'chats'),
            characters: path.join(userRoot, 'characters'),
            groupChats: path.join(userRoot, 'group chats'),
            groups: path.join(userRoot, 'groups'),
            thumbnailsAvatar: path.join(userRoot, 'thumbnails', 'avatar'),
            thumbnailsAvatarMobile: path.join(userRoot, 'thumbnails', 'avatar', 'mobile'),
            worlds: path.join(userRoot, 'worlds'),
        };
        for (const directory of Object.values(directories)) {
            fs.mkdirSync(directory, { recursive: true });
        }

        const app = express();
        app.use(express.json());
        app.use((request, _response, next) => {
            request.user = {
                profile: { handle: 'index-test-user' },
                directories,
            };
            next();
        });
        app.use('/api/characters', charactersRouter);
        await new Promise(resolve => {
            server = app.listen(0, '127.0.0.1', resolve);
        });
        baseUrl = `http://127.0.0.1:${server.address().port}`;
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    afterAll(async () => {
        if (server) {
            await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        }
        characterIndex.close();
        fs.rmSync(tempRoot, { recursive: true, force: true });
    });

    test('serves stored cards, drops edited cards, and forgets deleted cards', async () => {
        jest.spyOn(console, 'debug').mockImplementation(() => {});
        jest.spyOn(console, 'error').mockImplementation(() => {});
        const warn = jest.spyOn(console, 'warn');
        const createResponse = await postJson('/api/characters/create', { ch_name: 'Alice', file_name: 'Alice' });
        expect(createResponse.status).toBe(200);
        const cardPath = path.join(directories.characters, 'Alice.png');

        const [listed] = await listCharacters();
        const stat = fs.statSync(cardPath);
        expect(characterIndex.get(cardPath, stat)).toBe(listed.json_data);

        const storedCard = JSON.parse(listed.json_data);
        storedCard.description = 'From the index';
        storedCard.data.description = 'From the index';
        characterIndex.set(cardPath, stat, JSON.stringify(storedCard));
        expect((await listCharacters())[0].description).toBe('From the index');

        const editResponse = await postJson('/api/characters/edit-attribute', {
            avatar_url: 'Alice.png',
            ch_name: 'Alice',
            field: 'description',
            value: 'Edited',
        });
        expect(editResponse.status).toBe(200);
        expect(characterIndex.get(cardPath, stat)).toBeUndefined();
        expect((await listCharacters())[0].description).toBe('Edited');

        const editedStat = fs.statSync(cardPath);
        expect(characterIndex.get(cardPath, editedStat)).toEqual(expect.any(String));
        fs.rmSync(cardPath);
        expect(await listCharacters()).toEqual([]);
        expect(characterIndex.get(cardPath, editedStat)).toBeUndefined();
        expect(warn).not.toHaveBeenCalled();
    });

    async function listCharacters() {
        const response = await postJson('/api/characters/all');
        expect(response.status).toBe(200);
        return response.json();
    }

    function postJson(resource, body = {}) {
        return fetch(`${baseUrl}${resource}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
    }
});

function writeFile(filePath, content) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content);
    return filePath;
}

function storeCards(index, cardPaths) {
    const stats = new Map();
    for (const cardPath of cardPaths) {
        writeFile(cardPath, path.basename(cardPath));
        stats.set(cardPath, fs.statSync(cardPath));
        index.set(cardPath, stats.get(cardPath), path.basename(cardPath));
    }
    return stats;
}

function readCards(index, stats) {
    return [...stats].map(([cardPath, stat]) => index.get(cardPath, stat)).filter(Boolean);
}
