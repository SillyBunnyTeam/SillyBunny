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

    function saveCharacter(character) {
        return postJson('/api/characters/edit', {
            avatar_url: 'Alice.png',
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
        const response = await postJson('/api/characters/create', {
            ch_name: 'Alice',
            file_name: 'Alice',
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
