import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { encode } from '../lib/codec.js';
import { encodeIco, readIco, readPngSize } from '../lib/ico.js';
import { sha256 } from '../lib/raster.js';
import { REPO_ROOT, paint } from '../test-support/pictures.js';

const square = (size) => encode(paint(size, size, (x, y) => [x * 9, y * 9, 120, 255]), 'png');

test('an ICO holds its PNG entries in order and gives them back', async () => {
    const entries = [{ size: 16, png: await square(16) }, { size: 256, png: await square(256) }];

    const ico = encodeIco(entries);

    assert.deepEqual(readIco(ico), entries.map(({ png }) => png));
    assert.equal(ico[6 + 16], 0, 'a side of 256 is stored as 0');
});

test('an entry of another size or a non-PNG is refused', async () => {
    const sixteen = await square(16);

    assert.throws(() => encodeIco([{ size: 32, png: sixteen }]), /holds a 16x16 picture/);
    assert.throws(() => readPngSize(Buffer.from('not a picture at all')), /not a PNG/);
    assert.throws(() => encodeIco([]), /between 1 and 65535 entries/);
    assert.throws(() => readIco(Buffer.from('nope')), /not an ICO/);
});

test('the shipped favicon is the plate icons packed in order', () => {
    const entries = [16, 24, 32, 48, 64, 128, 256].map((size) => ({ size, png: readFileSync(join(REPO_ROOT, `public/img/icon-${size}x${size}.png`)) }));

    assert.equal(sha256(encodeIco(entries)), sha256(readFileSync(join(REPO_ROOT, 'public/favicon.ico'))));
});
