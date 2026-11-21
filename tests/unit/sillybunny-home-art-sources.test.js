/* eslint-disable playwright/no-standalone-expect -- Jest contracts for the shipped art files. */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from '@jest/globals';
import { getPixelArt, getPixelMotionFile, listPixelArtIds } from '../../public/scripts/sillybunny-home/art-sources.js';
import { readArtManifest } from '../helpers/art-manifest.js';
import { readImageSize } from '../helpers/image-size.js';

const IMAGES = fileURLToPath(new URL('../../public/img/sillybunny/', import.meta.url));
const PLACEMENT_TYPES = ['still', 'scene'];

function fileOf(id) {
    return decodeURIComponent(new URL(getPixelArt(id).url, 'http://localhost').pathname.replace('/img/sillybunny/', ''));
}

describe('the pixel art table', () => {
    const { assets } = readArtManifest();

    test.each(listPixelArtIds())('%s names a file whose size is the size in the table', (id) => {
        const art = getPixelArt(id);
        const size = readImageSize(readFileSync(`${IMAGES}${fileOf(id)}`));

        expect(size).toEqual({ width: art.width, height: art.height });
    });

    test.each(listPixelArtIds())('%s is a Home placement of the art manifest, on the grid of the table, with the motion of the table', (id) => {
        const art = getPixelArt(id);
        const motion = getPixelMotionFile(id);

        expect(PLACEMENT_TYPES).toContain(assets[id].type);
        expect(assets[id]).toMatchObject({ key: 'home', grid: [art.width, art.height] });
        expect(assets[id].outputs[0].path).toBe(`public/img/sillybunny/${fileOf(id)}`);
        expect(assets[id].motion?.output ?? null).toBe(motion === null ? null : `public/img/sillybunny/${motion}`);
    });

    test('lists every Home placement of the art manifest', () => {
        const placements = Object.keys(assets).filter(id => assets[id].key === 'home' && PLACEMENT_TYPES.includes(assets[id].type));

        expect(listPixelArtIds().sort()).toEqual(placements.sort());
    });

    test('the URL carries the version of the picture set, so the service worker fetches a changed file', () => {
        for (const id of listPixelArtIds()) {
            expect(getPixelArt(id).url).toMatch(/\?v=\d{8}[a-z]$/);
        }
    });

    test('asking for art that is not in the table fails with its name', () => {
        expect(() => getPixelArt('not-art')).toThrow('not-art');
    });
});
