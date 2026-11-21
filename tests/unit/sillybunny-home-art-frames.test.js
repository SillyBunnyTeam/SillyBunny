/* eslint-disable playwright/no-standalone-expect -- Jest contracts for the shipped motion files. */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from '@jest/globals';
import { parseBreathScene } from '../../public/scripts/sillybunny-home/art-motion.js';
import { getPixelArt, getPixelMotionFile, listPixelArtIds } from '../../public/scripts/sillybunny-home/art-sources.js';
import { readImageSize } from '../helpers/image-size.js';

const IMAGES = fileURLToPath(new URL('../../public/img/sillybunny/', import.meta.url));

const movingIds = listPixelArtIds().filter(id => getPixelMotionFile(id) !== null);

const readScene = id => parseBreathScene(JSON.parse(readFileSync(`${IMAGES}${getPixelMotionFile(id)}`, 'utf8')));

/** Every picture of a scene as `{ file, width, height }`: what the player will ask for and the size it will draw each at. */
function picturesOf(scene) {
    const pictures = scene.backdrop ? [{ file: scene.backdrop, width: scene.width, height: scene.height }] : [];
    for (const layer of scene.layers) {
        for (const pose of Object.values(layer.images)) {
            for (const file of Object.values(pose)) {
                pictures.push({ file, width: layer.width, height: layer.height });
            }
        }
    }
    return pictures;
}

describe('the art that moves', () => {
    test('is more than nothing, so the tests below are not empty', () => {
        expect(movingIds.length).toBeGreaterThan(0);
    });

    test.each(movingIds)('%s has a description in the picture folder that the player accepts, named after the art', (id) => {
        expect(getPixelMotionFile(id)).toBe(`${id}--breath.json`);
        expect(existsSync(`${IMAGES}${getPixelMotionFile(id)}`)).toBe(true);

        const scene = readScene(id);

        expect(scene.scene).toBe(id);
    });

    test.each(movingIds)('%s describes a scene of the size of its still, so the layers lie on the pixels of the still', (id) => {
        const scene = readScene(id);
        const still = getPixelArt(id);

        expect([scene.width, scene.height]).toEqual([still.width, still.height]);
    });

    test.each(movingIds)('%s has every picture that its description names, each at the size that its layer draws it', (id) => {
        const wrong = picturesOf(readScene(id)).filter(({ file, width, height }) => {
            if (!existsSync(`${IMAGES}${file}`)) {
                return true;
            }
            const size = readImageSize(readFileSync(`${IMAGES}${file}`));
            return size.width !== width || size.height !== height;
        }).map(({ file }) => file);

        expect(wrong).toEqual([]);
    });

    test.each(movingIds)('%s keeps every layer inside its still', (id) => {
        const scene = readScene(id);

        const outside = scene.layers
            .filter(layer => layer.left + layer.width > scene.width || layer.top + layer.height > scene.height)
            .map(layer => layer.id);

        expect(outside).toEqual([]);
    });

    test.each(movingIds)('%s has a neutral picture that is its still, for a figure that is alone in its scene', (id) => {
        const scene = readScene(id);
        const alone = scene.layers.length === 1 && scene.layers[0].width === scene.width && scene.layers[0].height === scene.height;
        if (!alone) {
            return;
        }

        expect(scene.layers[0].images.c.base).toBe(decodeURIComponent(new URL(getPixelArt(id).url, 'http://localhost').pathname.replace('/img/sillybunny/', '')));
    });
});
