/* eslint-disable playwright/no-standalone-expect -- Jest contracts for the shipped art files. */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from '@jest/globals';
import { getPixelArt, listPixelArtIds } from '../../public/scripts/sillybunny-home/art-sources.js';

const IMAGES = fileURLToPath(new URL('../../public/img/sillybunny/', import.meta.url));
const SPEC = fileURLToPath(new URL('../../assets-src/branding/export-specs/shell.json', import.meta.url));

/** The size in pixels that the header of a PNG or a WebP file states. */
function readImageSize(bytes) {
    if (bytes.subarray(1, 4).toString('latin1') === 'PNG') {
        return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
    }
    expect(bytes.subarray(0, 4).toString('latin1')).toBe('RIFF');
    expect(bytes.subarray(8, 12).toString('latin1')).toBe('WEBP');
    const kind = bytes.subarray(12, 16).toString('latin1');
    if (kind === 'VP8L') {
        const bits = bytes.readUInt32LE(21);
        return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
    if (kind === 'VP8X') {
        return { width: bytes.readUIntLE(24, 3) + 1, height: bytes.readUIntLE(27, 3) + 1 };
    }
    return { width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff };
}

function fileOf(id) {
    return decodeURIComponent(new URL(getPixelArt(id).url, 'http://localhost').pathname.replace('/img/sillybunny/', ''));
}

describe('the pixel art table', () => {
    const spec = JSON.parse(readFileSync(SPEC, 'utf8'));

    test.each(listPixelArtIds())('%s names a file whose size is the size in the table', (id) => {
        const art = getPixelArt(id);
        const size = readImageSize(readFileSync(`${IMAGES}${fileOf(id)}`));

        expect(size).toEqual({ width: art.width, height: art.height });
    });

    test.each(listPixelArtIds())('%s is a pixel placement in the export spec, from the snapped pictures', (id) => {
        expect(spec.assets[id]).toMatchObject({ pixel: true, master: `approved/pixel/${id}.png` });
    });

    test('the URL carries the version of the picture set, so the service worker fetches a changed file', () => {
        for (const id of listPixelArtIds()) {
            expect(getPixelArt(id).url).toMatch(/\?v=\d{8}[a-z]$/);
        }
    });

    test('the assistant card portraits stay smooth pictures at 1x, 2x and 3x', () => {
        for (const id of ['row-reisen', 'row-tewi']) {
            expect(spec.assets[id].pixel).toBeUndefined();
            expect(spec.assets[id].css).toEqual([128, 64]);
        }
    });

    test('asking for art that is not in the export fails with its name', () => {
        expect(() => getPixelArt('not-art')).toThrow('not-art');
    });
});
