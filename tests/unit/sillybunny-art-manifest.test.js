/* eslint-disable playwright/no-standalone-expect -- Jest contracts for the shipped art files. */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from '@jest/globals';
import { ASSISTANTS } from '../../public/scripts/sillybunny-home/assistant-registry.js';
import { picturesWithSizes, readArtManifest, shippedFilesOf } from '../helpers/art-manifest.js';
import { readImageSize } from '../helpers/image-size.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SHIPPED_ART_FOLDER = 'public/img/sillybunny';
const { assets } = readArtManifest();
const sizedPictures = Object.entries(assets).flatMap(([id, asset]) => picturesWithSizes(asset).map(picture => [picture.path, id, picture]));

describe('the art manifest', () => {
    test('lists every file of the shipped art folder, and every file it lists exists', () => {
        const listed = new Set(Object.values(assets).flatMap(shippedFilesOf));
        const shipped = readdirSync(`${ROOT}${SHIPPED_ART_FOLDER}`).map(name => `${SHIPPED_ART_FOLDER}/${name}`);

        expect(shipped.filter(path => !listed.has(path))).toEqual([]);
        expect([...listed].filter(path => !existsSync(`${ROOT}${path}`))).toEqual([]);
    });

    test.each(sizedPictures)('%s has the size that its placement in %s gives it', (path, id, { width, height }) => {
        expect(readImageSize(readFileSync(`${ROOT}${path}`))).toEqual({ width, height });
    });

    test('a pair is a picture and the same picture at twice its size', () => {
        const pairs = Object.values(assets).filter(asset => asset.type === 'pair');

        expect(pairs.length).toBeGreaterThan(0);
        for (const asset of pairs) {
            const [one, two] = asset.outputs.map(({ path }) => readImageSize(readFileSync(`${ROOT}${path}`)));
            expect(two).toEqual({ width: one.width * 2, height: one.height * 2 });
        }
    });

    test.each(ASSISTANTS.filter(assistant => assistant.greetingArt))('gives the greeting picture of $id the files and the size that the registry names', ({ id, greetingArt }) => {
        const pair = assets[`greeting-${id}`];

        expect(pair.type).toBe('pair');
        expect(pair.grid).toEqual([greetingArt.width, greetingArt.height]);
        expect(pair.outputs.map(({ path }) => path)).toEqual([`public${greetingArt.src}`, `public${greetingArt.src2x}`]);
    });
});
