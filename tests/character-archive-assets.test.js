import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';

import { createByafArchive, createByafParts, createImagePng, createV2Card, createV3Card, createZip } from './util/card-corpus.js';
import { startCharacterRouter } from './util/character-router-harness.js';

const SPRITE = createImagePng({ rgba: [10, 200, 10, 255] });
const BACKGROUND = createImagePng({ rgba: [10, 10, 200, 255] });
const POSTER = createImagePng({ rgba: [90, 90, 90, 255] });

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
});
