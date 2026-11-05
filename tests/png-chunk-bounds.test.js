import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import fs from 'node:fs';

import { read, write } from '../src/character-card-parser.js';
import { createCardPng, createV2Card } from './util/card-corpus.js';
import { startCharacterRouter } from './util/character-router-harness.js';

const CARD = createV2Card();
const CARD_PNG = createCardPng(CARD);
const CARD_TEXT = JSON.stringify(CARD);

/**
 * A text chunk is listed under its keyword instead of its type.
 */
function chunkStarts(png) {
    const starts = {};
    for (let offset = 8; offset < png.length;) {
        const type = png.toString('latin1', offset + 4, offset + 8);
        starts[type === 'tEXt' ? png.toString('latin1', offset + 8, png.indexOf(0, offset + 8)) : type] = offset;
        offset += 12 + png.readUInt32BE(offset);
    }
    return starts;
}

function withDeclaredLength(png, offset, length) {
    const copy = Buffer.from(png);
    copy.writeUInt32BE(length, offset);
    return copy;
}

const starts = chunkStarts(CARD_PNG);
const pastTheEnd = offset => `PNG chunk at byte ${offset} runs past the end of the file`;

const sixteenBytes = Buffer.alloc(16);
Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]).copy(sixteenBytes, 0);
sixteenBytes.writeUInt32BE(256 * 1024 * 1024, 8);
sixteenBytes.write('IHDR', 12, 'latin1');

const OVERRUNS = [
    ['the IHDR chunk of a 16-byte file declares 256 MiB', sixteenBytes, 8],
    ['the card text chunk declares 1 MiB', withDeclaredLength(CARD_PNG, starts.chara, 1024 * 1024), starts.chara],
    ['the IEND chunk declares more bytes than the file holds', withDeclaredLength(CARD_PNG, starts.IEND, CARD_PNG.length), starts.IEND],
    ['the file ends inside the data of the card text chunk', CARD_PNG.subarray(0, starts.chara + 100), starts.chara],
    ['the file ends inside the 8-byte header of the IDAT chunk', CARD_PNG.subarray(0, starts.IDAT + 6), starts.IDAT],
    ['the file ends inside the 8-byte header of the IEND chunk', CARD_PNG.subarray(0, starts.IEND + 2), starts.IEND],
];

describe('PNG chunk bounds', () => {
    beforeEach(() => {
        jest.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    test.each(OVERRUNS)('read rejects a PNG where %s', (_label, png, offset) => {
        expect(() => read(png)).toThrow(pastTheEnd(offset));
    });

    test('write rejects a PNG whose card text chunk declares 1 MiB', () => {
        expect(() => write(withDeclaredLength(CARD_PNG, starts.chara, 1024 * 1024), CARD_TEXT)).toThrow(pastTheEnd(starts.chara));
    });

    describe('chunks inside the file', () => {
        test('read ignores bytes after the IEND chunk', () => {
            expect(read(Buffer.concat([CARD_PNG, Buffer.alloc(64, 0xFF)]))).toBe(CARD_TEXT);
        });

        test('read still reports a CRC error for a file that ends inside the CRC of the card text chunk', () => {
            expect(() => read(CARD_PNG.subarray(0, starts.IEND - 2))).toThrow(/^CRC values for tEXt header do not match/);
        });

        test('read still accepts a file that ends inside the CRC of the IEND chunk', () => {
            expect(read(CARD_PNG.subarray(0, CARD_PNG.length - 2))).toBe(CARD_TEXT);
        });

        test('read still reports a header error for data without the PNG signature', () => {
            expect(() => read(Buffer.from(CARD_TEXT))).toThrow(/^Invalid \.png file header/);
        });
    });

    describe('import route', () => {
        let harness;

        beforeAll(async () => {
            harness = await startCharacterRouter('sillybunny-png-chunk-bounds-');
        });

        beforeEach(() => {
            harness.reset();
            for (const method of ['info', 'log', 'warn']) {
                jest.spyOn(console, method).mockImplementation(() => {});
            }
        });

        afterEach(() => {
            harness.remove();
        });

        afterAll(async () => {
            await harness.close();
        });

        test('a PNG whose IEND chunk declares more bytes than the file holds gets the handled import error and stores no card', async () => {
            const answer = await harness.importCard(withDeclaredLength(CARD_PNG, starts.IEND, CARD_PNG.length), 'png');

            expect(answer).toEqual({ status: 200, body: { error: true } });
            expect(fs.readdirSync(harness.directories.characters)).toEqual([]);
        });
    });
});
