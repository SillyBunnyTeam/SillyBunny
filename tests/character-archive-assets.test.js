import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';

import { createByafArchive, createByafParts, createImagePng, createV2Card, createV3Card, createZip } from './util/card-corpus.js';
import { startCharacterRouter } from './util/character-router-harness.js';
import { Jimp, JimpMime } from '../src/jimp.js';

const SPRITE = createImagePng({ rgba: [10, 200, 10, 255] });
const BACKGROUND = createImagePng({ rgba: [10, 10, 200, 255] });
const POSTER = createImagePng({ rgba: [90, 90, 90, 255] });
const PHOTO = await new Jimp({ width: 3, height: 2, color: 0x336699ff }).getBuffer(JimpMime.jpeg, { quality: 90, jpegColorSpace: 'ycbcr' });
const ANIMATION = await new Jimp({ width: 2, height: 2, color: 0xcc8800ff }).getBuffer(JimpMime.gif);
const PAGE = '<!doctype html><title>Page</title><p>Text</p>';
const VECTOR = '<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"><rect width="2" height="2"/></svg>';

function createCharxArchiveNamed(name) {
    const card = createV3Card();
    card.data.name = name;
    card.data.assets = [
        { type: 'emotion', uri: 'embeded://assets/emotion/sprite.png', name: 'existing', ext: 'png' },
        { type: 'background', uri: 'embeded://assets/background/beach.png', name: 'beach', ext: 'png' },
        { type: 'other', uri: 'embeded://assets/other/poster.png', name: 'poster', ext: 'png' },
    ];
    return createZip([
        { name: 'card.json', content: JSON.stringify(card) },
        { name: 'assets/emotion/sprite.png', content: SPRITE },
        { name: 'assets/background/beach.png', content: BACKGROUND },
        { name: 'assets/other/poster.png', content: POSTER },
    ]);
}

describe('character archive assets', () => {
    let harness;

    beforeAll(async () => {
        harness = await startCharacterRouter('sillybunny-character-archive-assets-');
    });

    beforeEach(() => {
        harness.reset();
        for (const method of ['error', 'info', 'log', 'warn']) {
            jest.spyOn(console, method).mockImplementation(() => {});
        }
    });

    afterEach(() => {
        jest.restoreAllMocks();
        harness.remove();
    });

    afterAll(async () => {
        await harness.close();
    });

    const addedSince = before => harness.entries().filter(entry => !before.includes(entry));

    async function importExistingCard() {
        const existing = createV2Card();
        existing.data.name = 'existing';
        expect(await harness.importCard(Buffer.from(JSON.stringify(existing)), 'json')).toEqual({ status: 200, body: { file_name: 'existing' } });
        return path.join(harness.directories.characters, 'existing.png');
    }

    describe('asset folders', () => {
        test.each([['..'], ['.'], ['<>']])('a CHARX card named %j keeps its assets in folders named after its file', async name => {
            const existingPath = await importExistingCard();
            const existingCard = fs.readFileSync(existingPath);
            const before = harness.entries();

            const answer = await harness.importCard(await createCharxArchiveNamed(name), 'charx');

            expect(answer).toEqual({ status: 200, body: { file_name: 'character' } });
            expect(fs.readFileSync(existingPath).equals(existingCard)).toBe(true);
            expect(addedSince(before)).toEqual([
                'characters/character.png',
                'characters/character/',
                'characters/character/backgrounds/',
                'characters/character/backgrounds/beach.png',
                'characters/character/existing.png',
                'user/images/character/',
                'user/images/character/poster.png',
            ]);
            expect(fs.readFileSync(path.join(harness.directories.characters, 'character', 'existing.png')).equals(SPRITE)).toBe(true);
        });

        test('a CHARX import with the preserved name ...png stores assets only in folders named after the card file', async () => {
            const existingPath = await importExistingCard();
            const existingCard = fs.readFileSync(existingPath);
            const before = harness.entries();

            const answer = await harness.importCard(await createCharxArchiveNamed('..'), 'charx', { preserved_name: '...png' });

            expect(answer.status).toBe(200);
            expect(fs.readFileSync(existingPath).equals(existingCard)).toBe(true);
            const fileName = answer.body.file_name;
            const insideCardFolders = entry => [`characters/${fileName}/`, `user/images/${fileName}/`].some(folder => entry.startsWith(folder));
            expect(addedSince(before).filter(entry => entry !== `characters/${fileName}.png` && !insideCardFolders(entry))).toEqual([]);
        });

        test('a BYAF card named .. keeps its alternate icons in a folder named after its file', async () => {
            const parts = createByafParts();
            parts.character.name = '..';
            parts.character.displayName = '..';
            const before = harness.entries();

            const answer = await harness.importCard(await createByafArchive(parts), 'byaf');

            expect(answer).toEqual({ status: 200, body: { file_name: '_' } });
            expect(addedSince(before).filter(entry => entry.startsWith('characters/'))).toEqual([
                'characters/_.png',
                'characters/_/',
                'characters/_/smile (1).png',
            ]);
        });
    });

    describe('archive files that are not images of their type', () => {
        function createByafArchiveWith(parts, files) {
            return createZip([
                { name: 'manifest.json', content: JSON.stringify(parts.manifest) },
                { name: parts.manifest.characters[0], content: JSON.stringify(parts.character) },
                { name: 'characters/character-1/images/main.png', content: createImagePng({ width: 5, height: 7 }) },
                ...parts.manifest.scenarios.map((name, index) => ({ name, content: JSON.stringify(parts.scenarios[index]) })),
                ...files,
            ]);
        }

        test('a BYAF import stores only the backgrounds that are images of their type, and only their chats name them', async () => {
            const parts = createByafParts();
            parts.scenarios.push({ ...parts.scenarios[1], title: 'Spring' });
            parts.manifest.scenarios.push('scenarios/third.json');
            parts.scenarios[0].backgroundImage = 'backgrounds/page.html';
            parts.scenarios[1].backgroundImage = 'backgrounds/fake.png';
            parts.scenarios[2].backgroundImage = 'backgrounds/garden.png';
            const archive = await createByafArchiveWith(parts, [
                { name: 'scenarios/backgrounds/page.html', content: PAGE },
                { name: 'scenarios/backgrounds/fake.png', content: `${PAGE}<p>Other text</p>` },
                { name: 'scenarios/backgrounds/garden.png', content: BACKGROUND },
            ]);

            const answer = await harness.importCard(archive, 'byaf');

            expect(answer).toEqual({ status: 200, body: { file_name: 'Søren 桜' } });
            const backgroundFolder = path.join(harness.directories.userImages, 'Søren 桜');
            expect(fs.readdirSync(backgroundFolder)).toEqual(['Søren 桜_bg (1).png']);
            expect(fs.readFileSync(path.join(backgroundFolder, 'Søren 桜_bg (1).png')).equals(BACKGROUND)).toBe(true);
            const chatFolder = path.join(harness.directories.chats, 'Søren 桜');
            const chatBackgrounds = Object.fromEntries(fs.readdirSync(chatFolder).map(file => {
                const header = JSON.parse(fs.readFileSync(path.join(chatFolder, file), 'utf8').split('\n')[0]);
                return [file.split(' - ')[0], [header.chat_metadata.chat_backgrounds, header.chat_metadata.custom_background]];
            }));
            expect(chatBackgrounds).toEqual({
                Sunday: [[], ''],
                Winter: [[], ''],
                Spring: [[expect.stringMatching(/\/Søren 桜_bg \(1\)\.png$/)], expect.stringContaining(encodeURI('Søren 桜_bg (1).png'))],
            });
        });

        test('a BYAF import stores only the alternate icons that are images of their type, with their bytes unchanged', async () => {
            const parts = createByafParts();
            parts.character.images = [
                { path: 'images/main.png', label: '' },
                { path: 'images/smile.png', label: 'smile' },
                { path: 'images/grin.PNG', label: 'grin' },
                { path: 'images/photo.jpg', label: 'photo' },
                { path: 'images/page.html', label: 'page' },
                { path: 'images/fake.png', label: 'fake' },
                { path: 'images/vector.svg', label: 'vector' },
            ];
            const archive = await createByafArchiveWith(parts, [
                { name: 'characters/character-1/images/smile.png', content: SPRITE },
                { name: 'characters/character-1/images/grin.PNG', content: POSTER },
                { name: 'characters/character-1/images/photo.jpg', content: PHOTO },
                { name: 'characters/character-1/images/page.html', content: PAGE },
                { name: 'characters/character-1/images/fake.png', content: PAGE },
                { name: 'characters/character-1/images/vector.svg', content: VECTOR },
            ]);

            const answer = await harness.importCard(archive, 'byaf');

            expect(answer).toEqual({ status: 200, body: { file_name: 'Søren 桜' } });
            const iconFolder = path.join(harness.directories.characters, 'soren');
            expect(fs.readdirSync(iconFolder).sort()).toEqual(['grin (1).PNG', 'photo (1).jpg', 'smile (1).png']);
            expect(fs.readFileSync(path.join(iconFolder, 'smile (1).png')).equals(SPRITE)).toBe(true);
            expect(fs.readFileSync(path.join(iconFolder, 'grin (1).PNG')).equals(POSTER)).toBe(true);
            expect(fs.readFileSync(path.join(iconFolder, 'photo (1).jpg')).equals(PHOTO)).toBe(true);
        });

        test('a CHARX import stores only the assets that are images of their type, with their bytes unchanged', async () => {
            const card = createV3Card();
            card.data.name = 'Keeper';
            card.data.assets = [
                { type: 'emotion', uri: 'embeded://assets/emotion/joy.png', name: 'joy', ext: 'png' },
                { type: 'emotion', uri: 'embeded://assets/emotion/fake.png', name: 'fake', ext: 'png' },
                { type: 'background', uri: 'embeded://assets/background/dusk.png', name: 'dusk', ext: 'png' },
                { type: 'other', uri: 'embeded://assets/other/poster.gif', name: 'poster', ext: 'gif' },
                { type: 'other', uri: 'embeded://assets/other/photo.jpg', name: 'photo', ext: 'jpg' },
            ];
            const archive = await createZip([
                { name: 'card.json', content: JSON.stringify(card) },
                { name: 'assets/emotion/joy.png', content: SPRITE },
                { name: 'assets/emotion/fake.png', content: PAGE },
                { name: 'assets/background/dusk.png', content: ANIMATION },
                { name: 'assets/other/poster.gif', content: ANIMATION },
                { name: 'assets/other/photo.jpg', content: PHOTO },
            ]);
            const before = harness.entries();

            const answer = await harness.importCard(archive, 'charx');

            expect(answer).toEqual({ status: 200, body: { file_name: 'Keeper' } });
            expect(addedSince(before).filter(entry => entry !== 'entity-date-added.json')).toEqual([
                'characters/Keeper.png',
                'characters/Keeper/',
                'characters/Keeper/joy.png',
                'user/images/Keeper/',
                'user/images/Keeper/photo.jpg',
                'user/images/Keeper/poster.gif',
            ]);
            expect(fs.readFileSync(path.join(harness.directories.characters, 'Keeper', 'joy.png')).equals(SPRITE)).toBe(true);
            expect(fs.readFileSync(path.join(harness.directories.userImages, 'Keeper', 'poster.gif')).equals(ANIMATION)).toBe(true);
            expect(fs.readFileSync(path.join(harness.directories.userImages, 'Keeper', 'photo.jpg')).equals(PHOTO)).toBe(true);
        });
    });
});
