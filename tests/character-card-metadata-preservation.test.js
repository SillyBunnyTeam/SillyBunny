import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import extract from 'png-chunks-extract';
import PNGtext from 'png-chunk-text';

import '../src/fetch-patch.js';
import { AVATAR_HEIGHT, AVATAR_WIDTH } from '../src/constants.js';
import { Jimp } from '../src/jimp.js';
import { setConfigFilePath } from '../src/util.js';
import encode from '../src/png/encode.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const originalWorkingDirectory = process.cwd();
const diskCacheEnvironmentKey = 'SILLYTAVERN_PERFORMANCE_USEDISKCACHE';
const originalDiskCacheSetting = process.env[diskCacheEnvironmentKey];
process.env[diskCacheEnvironmentKey] = 'false';
process.chdir(repoRoot);
setConfigFilePath(path.join(repoRoot, 'default', 'config.yaml'));

const { router: charactersRouter } = await import('../src/endpoints/characters.js');

describe('character card metadata preservation', () => {
    let baseUrl;
    let directories;
    let server;
    let tempRoot;

    beforeAll(async () => {
        const app = express();
        app.use(express.json({ limit: '10mb' }));
        app.use((request, _response, next) => {
            request.user = {
                profile: { handle: 'card-metadata-test-user' },
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

    beforeEach(() => {
        tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sillybunny-card-metadata-'));
        directories = {
            root: tempRoot,
            backups: path.join(tempRoot, 'backups'),
            chats: path.join(tempRoot, 'chats'),
            characters: path.join(tempRoot, 'characters'),
            groupChats: path.join(tempRoot, 'group chats'),
            groups: path.join(tempRoot, 'groups'),
            thumbnailsAvatar: path.join(tempRoot, 'thumbnails', 'avatar'),
            thumbnailsAvatarMobile: path.join(tempRoot, 'thumbnails', 'avatar', 'mobile'),
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

    test('keeps the PNG container and file identity during a metadata edit', async () => {
        jest.spyOn(console, 'error').mockImplementation(() => {});
        jest.spyOn(console, 'info').mockImplementation(() => {});
        await createAlice();
        const cardPath = path.join(directories.characters, 'Alice.png');
        addAncillaryChunks(cardPath);
        const cardBefore = fs.readFileSync(cardPath);
        const statBefore = fs.statSync(cardPath);

        await delay();
        const response = await postJson('/api/characters/merge-attributes', {
            avatar: 'Alice.png',
            creator: 'Somebody',
        });
        expect(response.status).toBe(200);

        const cardAfter = fs.readFileSync(cardPath);
        const statAfter = fs.statSync(cardPath);
        const decodedImage = await Jimp.fromBuffer(cardAfter);
        expect(decodedImage.bitmap.width).toBe(AVATAR_WIDTH);
        expect(decodedImage.bitmap.height).toBe(AVATAR_HEIGHT);
        expect(nonCardChunks(cardAfter)).toEqual(nonCardChunks(cardBefore));
        expect(statAfter.ino).toBe(statBefore.ino);
        expect(statAfter.birthtimeMs).toBe(statBefore.birthtimeMs);
        expect(statAfter.mtimeMs).toBeGreaterThan(statBefore.mtimeMs);

        const cardChunks = decodeCardChunks(cardAfter);
        expect(cardChunks.map(chunk => chunk.keyword)).toEqual(['chara', 'ccv3']);
        expect(cardChunks[0].card.spec).toBe('chara_card_v2');
        expect(cardChunks[1].card.spec).toBe('chara_card_v3');
        expect(cardChunks.every(chunk => chunk.card.creator === 'Somebody')).toBe(true);
    });

    test('leaves the card untouched when a full editor save changes nothing', async () => {
        jest.spyOn(console, 'error').mockImplementation(() => {});
        jest.spyOn(console, 'info').mockImplementation(() => {});
        await createAlice();
        const initialCharacter = await getCharacter('Alice.png');
        expect((await saveCharacter(initialCharacter)).status).toBe(200);
        const character = await getCharacter('Alice.png');
        const cardPath = path.join(directories.characters, 'Alice.png');
        const cardBefore = fs.readFileSync(cardPath);
        const statBefore = fs.statSync(cardPath);

        await delay();
        const response = await saveCharacter(character);
        expect(response.status).toBe(200);
        const cardAfter = fs.readFileSync(cardPath);
        expect(decodeCardChunks(cardAfter)).toEqual(decodeCardChunks(cardBefore));
        expect(cardAfter.equals(cardBefore)).toBe(true);

        const statAfter = fs.statSync(cardPath);
        expect(statAfter.ino).toBe(statBefore.ino);
        expect(statAfter.birthtimeMs).toBe(statBefore.birthtimeMs);
        expect(statAfter.mtimeMs).toBe(statBefore.mtimeMs);
    });

    test('does not persist the routing-only avatar field during a merge', async () => {
        jest.spyOn(console, 'error').mockImplementation(() => {});
        jest.spyOn(console, 'info').mockImplementation(() => {});
        await createAlice();
        const cardPath = path.join(directories.characters, 'Alice.png');
        const cardBefore = fs.readFileSync(cardPath);
        const statBefore = fs.statSync(cardPath);

        await delay();
        const response = await postJson('/api/characters/merge-attributes', { avatar: 'Alice.png' });

        expect(response.status).toBe(200);
        expect(fs.readFileSync(cardPath).equals(cardBefore)).toBe(true);
        expect(fs.statSync(cardPath).mtimeMs).toBe(statBefore.mtimeMs);
    });

    test('updates the original card when its filename stem contains .png', async () => {
        jest.spyOn(console, 'error').mockImplementation(() => {});
        jest.spyOn(console, 'info').mockImplementation(() => {});
        await createCharacter('Alice.png.backup');
        const cardPath = path.join(directories.characters, 'Alice.png.backup.png');

        const response = await postJson('/api/characters/merge-attributes', {
            avatar: 'Alice.png.backup.png',
            creator: 'Somebody',
        });

        expect(response.status).toBe(200);
        expect(fs.existsSync(cardPath)).toBe(true);
        expect(fs.existsSync(path.join(directories.characters, 'Alice.backup.png.png'))).toBe(false);
        expect(decodeCardChunks(fs.readFileSync(cardPath)).every(chunk => chunk.card.creator === 'Somebody')).toBe(true);
    });

    test('replaces only the selected path when a card has a hard-link alias', async () => {
        jest.spyOn(console, 'error').mockImplementation(() => {});
        jest.spyOn(console, 'info').mockImplementation(() => {});
        await createAlice();
        const cardPath = path.join(directories.characters, 'Alice.png');
        const aliasPath = path.join(directories.characters, 'Alice-alias.png');
        fs.linkSync(cardPath, aliasPath);
        const aliasBefore = fs.readFileSync(aliasPath);

        const response = await postJson('/api/characters/merge-attributes', {
            avatar: 'Alice.png',
            creator: 'Somebody',
        });

        expect(response.status).toBe(200);
        expect(fs.readFileSync(aliasPath).equals(aliasBefore)).toBe(true);
        expect(decodeCardChunks(fs.readFileSync(cardPath)).every(chunk => chunk.card.creator === 'Somebody')).toBe(true);
        expect(fs.statSync(cardPath).ino).not.toBe(fs.statSync(aliasPath).ino);
    });

    test('keeps dotted filename stems on full and single-attribute edits', async () => {
        jest.spyOn(console, 'error').mockImplementation(() => {});
        jest.spyOn(console, 'info').mockImplementation(() => {});
        const avatar = 'Alice.png.backup.png';
        await createCharacter('Alice.png.backup');
        const character = await getCharacter(avatar);

        expect((await saveCharacter(character, avatar)).status).toBe(200);
        const attributeResponse = await postJson('/api/characters/edit-attribute', {
            avatar_url: avatar,
            ch_name: character.name,
            field: 'creator',
            value: 'Somebody',
        });

        expect(attributeResponse.status).toBe(200);
        expect(fs.existsSync(path.join(directories.characters, avatar))).toBe(true);
        expect(fs.existsSync(path.join(directories.characters, 'Alice.backup.png.png'))).toBe(false);
        expect(decodeCardChunks(fs.readFileSync(path.join(directories.characters, avatar))).every(chunk => chunk.card.creator === 'Somebody')).toBe(true);
    });

    test('does not alias a non-PNG filename onto another card', async () => {
        jest.spyOn(console, 'error').mockImplementation(() => {});
        jest.spyOn(console, 'info').mockImplementation(() => {});
        jest.spyOn(console, 'warn').mockImplementation(() => {});
        await createAlice();
        const alicePath = path.join(directories.characters, 'Alice.png');
        const aliceBefore = fs.readFileSync(alicePath);
        fs.copyFileSync(alicePath, path.join(directories.characters, 'Alice.jpg'));

        const response = await postJson('/api/characters/merge-attributes', {
            avatar: 'Alice.jpg',
            creator: 'Somebody',
        });

        expect(response.status).toBe(400);
        expect(fs.readFileSync(alicePath).equals(aliceBefore)).toBe(true);
    });

    test('replaces a symlinked card path without modifying its target', async () => {
        jest.spyOn(console, 'error').mockImplementation(() => {});
        jest.spyOn(console, 'info').mockImplementation(() => {});
        await createAlice();
        const cardPath = path.join(directories.characters, 'Alice.png');
        const outsidePath = path.join(tempRoot, 'outside.png');
        fs.copyFileSync(cardPath, outsidePath);
        const outsideBefore = fs.readFileSync(outsidePath);
        fs.unlinkSync(cardPath);
        fs.symlinkSync(outsidePath, cardPath);

        const response = await postJson('/api/characters/merge-attributes', {
            avatar: 'Alice.png',
            creator: 'Somebody',
        });

        expect(response.status).toBe(200);
        expect(fs.lstatSync(cardPath).isSymbolicLink()).toBe(false);
        expect(fs.readFileSync(outsidePath).equals(outsideBefore)).toBe(true);
        expect(decodeCardChunks(fs.readFileSync(cardPath)).every(chunk => chunk.card.creator === 'Somebody')).toBe(true);
    });

    test('deletes chats under the existing dotted-card owner name', async () => {
        jest.spyOn(console, 'error').mockImplementation(() => {});
        jest.spyOn(console, 'info').mockImplementation(() => {});
        const avatar = 'Alice.png.backup.png';
        await createCharacter('Alice.png.backup');
        const chatDirectory = path.join(directories.chats, 'Alice.backup.png');
        fs.mkdirSync(chatDirectory, { recursive: true });
        fs.writeFileSync(path.join(chatDirectory, 'chat.jsonl'), '{}\n');

        const response = await postJson('/api/characters/delete', {
            avatar_url: avatar,
            delete_chats: true,
        });

        expect(response.status).toBe(200);
        expect(fs.existsSync(path.join(directories.characters, avatar))).toBe(false);
        expect(fs.existsSync(chatDirectory)).toBe(false);
    });

    function saveCharacter(character, avatarUrl = 'Alice.png') {
        return postJson('/api/characters/edit', {
            avatar_url: avatarUrl,
            ch_name: character.name,
            description: character.description,
            personality: character.personality,
            scenario: character.scenario,
            first_mes: character.first_mes,
            mes_example: character.mes_example,
            creator_notes: character.data.creator_notes,
            system_prompt: character.data.system_prompt,
            post_history_instructions: character.data.post_history_instructions,
            creator: character.data.creator,
            character_version: character.data.character_version,
            alternate_greetings: character.data.alternate_greetings,
            tags: character.tags.join(','),
            talkativeness: character.talkativeness,
            fav: String(character.fav),
            world: character.data.extensions.world,
            depth_prompt_prompt: character.data.extensions.depth_prompt.prompt,
            depth_prompt_depth: character.data.extensions.depth_prompt.depth,
            depth_prompt_role: character.data.extensions.depth_prompt.role,
            chat: character.chat,
            create_date: character.create_date,
            json_data: character.json_data,
        });
    }

    async function createAlice() {
        return createCharacter('Alice');
    }

    async function createCharacter(name) {
        const response = await postJson('/api/characters/create', {
            ch_name: name,
            file_name: name,
        });
        expect(response.status).toBe(200);
    }

    function postJson(resource, body = {}) {
        return fetch(`${baseUrl}${resource}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
    }

    async function getCharacter(avatarUrl) {
        const response = await postJson('/api/characters/get', { avatar_url: avatarUrl });
        expect(response.status).toBe(200);
        return response.json();
    }

    function addAncillaryChunks(cardPath) {
        const chunks = extract(new Uint8Array(fs.readFileSync(cardPath)));
        const firstImageDataChunk = chunks.findIndex(chunk => chunk.name === 'IDAT');
        chunks.splice(firstImageDataChunk, 0, PNGtext.encode('Comment', 'preserve this metadata'));
        fs.writeFileSync(cardPath, Buffer.from(encode(chunks)));
    }

    function nonCardChunks(image) {
        return extract(new Uint8Array(image))
            .filter(chunk => !isCardChunk(chunk))
            .map(chunk => ({ name: chunk.name, data: Buffer.from(chunk.data) }));
    }

    function decodeCardChunks(image) {
        return extract(new Uint8Array(image))
            .filter(isCardChunk)
            .map(chunk => {
                const decoded = PNGtext.decode(chunk.data);
                return {
                    keyword: decoded.keyword.toLowerCase(),
                    card: JSON.parse(Buffer.from(decoded.text, 'base64').toString('utf8')),
                };
            });
    }

    function isCardChunk(chunk) {
        if (chunk.name !== 'tEXt') {
            return false;
        }
        const keyword = PNGtext.decode(chunk.data).keyword.toLowerCase();
        return keyword === 'chara' || keyword === 'ccv3';
    }

    function delay() {
        return new Promise(resolve => setTimeout(resolve, 25));
    }
});
