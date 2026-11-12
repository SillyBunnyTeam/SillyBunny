import assert from 'node:assert/strict';
import { test } from 'node:test';
import sharp from 'sharp';
import { encodeIco, readIco, readPngHeader } from '../scripts/lib/ico.mjs';

const solid = (size, background = '#8b64aa') => sharp({ create: { width: size, height: size, channels: 4, background } }).png().toBuffer();

test('an ICO lists its entries in the order given, with 0 for a side of 256, and gives each entry back as the same PNG', async () => {
    const pngs = await Promise.all([16, 48, 256].map((size) => solid(size)));
    const ico = encodeIco([16, 48, 256].map((size, at) => ({ size, png: pngs[at] })));
    assert.equal(ico.readUInt16LE(2), 1, 'type 1 is an icon');
    assert.equal(ico.readUInt16LE(4), 3);
    assert.deepEqual([6, 22, 38].map((at) => ico[at]), [16, 48, 0], 'the 256 entry stores 0');
    const entries = readIco(ico);
    assert.deepEqual(entries.map(({ width, height, bitCount, format }) => [width, height, bitCount, format]), [[16, 16, 32, 'png'], [48, 48, 32, 'png'], [256, 256, 32, 'png']]);
    entries.forEach((entry, at) => assert.deepEqual(entry.data, pngs[at]));
});

test('an entry whose picture is not the stated size, is not a PNG, or is too large is refused, and so is an empty list', async () => {
    const png = await solid(16);
    assert.throws(() => encodeIco([{ size: 32, png }]), /32 px ICO entry holds a 16x16 picture/);
    assert.throws(() => encodeIco([{ size: 16, png: Buffer.from('not a png at all, just text') }]), /not a PNG/);
    assert.throws(() => encodeIco([{ size: 512, png }]), /1 to 256 pixels/);
    assert.throws(() => encodeIco([]), /between 1 and 65535 entries/);
});

test('bytes that are not an ICO, or an ICO cut short, are refused', async () => {
    const ico = encodeIco([{ size: 16, png: await solid(16) }]);
    assert.throws(() => readIco(Buffer.from('GIF89a......')), /not an ICO/);
    assert.throws(() => readIco(ico.subarray(0, 10)), /directory is cut short/);
    assert.throws(() => readIco(ico.subarray(0, ico.length - 5)), /reaches past the end/);
});

test('a PNG header gives the size and the colour type, so opaque pictures can be told from ones with alpha', async () => {
    const withAlpha = await solid(8);
    const withoutAlpha = await sharp(withAlpha).removeAlpha().png().toBuffer();
    assert.deepEqual(readPngHeader(withAlpha), { width: 8, height: 8, colourType: 6 });
    assert.deepEqual(readPngHeader(withoutAlpha), { width: 8, height: 8, colourType: 2 });
});
