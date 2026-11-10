import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';

import { createImagePng, createZip } from './util/card-corpus.js';
import { startCharacterRouter } from './util/character-router-harness.js';
import { Jimp, JimpMime } from '../src/jimp.js';

const SPRITE = createImagePng({ rgba: [10, 200, 10, 255] });
const OTHER_SPRITE = createImagePng({ rgba: [200, 10, 10, 255] });
const PHOTO = await new Jimp({ width: 3, height: 2, color: 0x336699ff }).getBuffer(JimpMime.jpeg, { quality: 90, jpegColorSpace: 'ycbcr' });
const PAGE = '<!doctype html><title>Page</title><p>Text</p>';
const VECTOR = '<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"><rect width="2" height="2"/></svg>';
// sanitize-filename keeps the first 255 bytes of a name, so it cuts off an extension added after this one.
const LONG_NAME = `${'a'.repeat(250)}.html`;

describe('sprite uploads', () => {
    let harness;

    beforeAll(async () => {
        harness = await startCharacterRouter('sillybunny-sprite-upload-images-');
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

    const spriteFolder = name => path.join(harness.directories.characters, name);
    const storedFiles = name => fs.readdirSync(spriteFolder(name)).sort();
    const storedBytes = (name, file) => fs.readFileSync(path.join(spriteFolder(name), file));
    const uploadSprite = (content, fileName, label) => harness.upload('/api/sprites/upload', content, fileName, { name: 'Single', label });

    test('a sprite pack stores only the entries that are images of their type, with their bytes unchanged', async () => {
        const pack = await createZip([
            { name: 'joy.png', content: SPRITE },
            { name: 'grin.PNG', content: OTHER_SPRITE },
            { name: 'calm.jpg', content: PHOTO },
            { name: 'love.svg', content: VECTOR },
            { name: 'fear.png', content: PAGE },
            { name: 'anger.png', content: PHOTO },
            { name: 'page.html', content: PAGE },
        ]);

        const answer = await harness.upload('/api/sprites/upload-zip', pack, 'pack.zip', { name: 'Packed' });

        expect(answer).toEqual({ status: 200, body: { ok: true, count: 3 } });
        expect(storedFiles('Packed')).toEqual(['calm.jpg', 'grin.PNG', 'joy.png']);
        expect(storedBytes('Packed', 'joy.png').equals(SPRITE)).toBe(true);
        expect(storedBytes('Packed', 'grin.PNG').equals(OTHER_SPRITE)).toBe(true);
        expect(storedBytes('Packed', 'calm.jpg').equals(PHOTO)).toBe(true);
    });

    test('a sprite pack entry that is not an image of its type leaves the existing sprite of its label in place', async () => {
        fs.mkdirSync(spriteFolder('Packed'), { recursive: true });
        fs.writeFileSync(path.join(spriteFolder('Packed'), 'fear.png'), SPRITE);

        const answer = await harness.upload('/api/sprites/upload-zip', await createZip([{ name: 'fear.svg', content: VECTOR }]), 'pack.zip', { name: 'Packed' });

        expect(answer).toEqual({ status: 200, body: { ok: true, count: 0 } });
        expect(storedFiles('Packed')).toEqual(['fear.png']);
        expect(storedBytes('Packed', 'fear.png').equals(SPRITE)).toBe(true);
    });

    test('a sprite pack entry whose sanitized name ends in another extension is not stored', async () => {
        const answer = await harness.upload('/api/sprites/upload-zip', await createZip([{ name: `${LONG_NAME}.png`, content: SPRITE }]), 'pack.zip', { name: 'Packed' });

        expect(answer).toEqual({ status: 200, body: { ok: true, count: 0 } });
        expect(storedFiles('Packed')).toEqual([]);
    });

    test('a sprite upload keeps an image under its own extension, and stores an image with the wrong extension under the extension of its type', async () => {
        expect(await uploadSprite(SPRITE, 'joy.png', 'joy')).toEqual({ status: 200, body: { ok: true } });
        expect(await uploadSprite(PHOTO, 'image.png', 'calm')).toEqual({ status: 200, body: { ok: true } });

        expect(storedFiles('Single')).toEqual(['calm.jpg', 'joy.png']);
        expect(storedBytes('Single', 'joy.png').equals(SPRITE)).toBe(true);
        expect(storedBytes('Single', 'calm.jpg').equals(PHOTO)).toBe(true);
    });

    test.each([
        ['an HTML page', 'page.html', PAGE],
        ['an SVG image', 'vector.svg', VECTOR],
        ['an HTML page named as a PNG', 'page.png', PAGE],
    ])('a sprite upload of %s is refused and leaves the existing sprite of its label in place', async (_label, fileName, content) => {
        expect(await uploadSprite(SPRITE, 'joy.png', 'joy')).toEqual({ status: 200, body: { ok: true } });

        const answer = await uploadSprite(content, fileName, 'joy');

        expect(answer.status).toBe(400);
        expect(storedFiles('Single')).toEqual(['joy.png']);
        expect(storedBytes('Single', 'joy.png').equals(SPRITE)).toBe(true);
        expect(fs.readdirSync(path.join(harness.root, '_uploads'))).toEqual([]);
    });

    test('a sprite upload whose sanitized name ends in another extension is refused', async () => {
        const answer = await harness.upload('/api/sprites/upload', SPRITE, 'joy.png', { name: 'Single', label: 'joy', spriteName: LONG_NAME });

        expect(answer.status).toBe(400);
        expect(fs.existsSync(spriteFolder('Single'))).toBe(false);
    });
});
