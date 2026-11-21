import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { ENCODER_LIBRARIES, decode, encode, encoderMismatches, encoderVersions } from '../lib/codec.js';
import { samePixels, sha256 } from '../lib/raster.js';
import { REPO_ROOT, paint } from '../test-support/pictures.js';

const pngColourType = (bytes) => bytes[25];

test('every encoding gives back the pixels it was given', async () => {
    const picture = paint(5, 4, (x, y) => (x + y > 3 ? [x * 40, y * 50, 90, 255] : [0, 0, 0, 0]));

    for (const encoding of ['webp-lossless', 'png', 'png-card']) {
        assert.equal(samePixels(await decode(await encode(picture, encoding)), picture), true, encoding);
    }
});

test('a picture read without an alpha channel is written without one', async () => {
    const opaque = paint(3, 3, () => [10, 20, 30, 255], 3);

    const png = await encode(opaque, 'png');

    assert.equal(pngColourType(png), 2);
    assert.equal((await decode(png)).channels, 3);
    assert.equal(pngColourType(await encode({ ...opaque, channels: 4 }, 'png')), 6);
});

test('an unknown encoding is refused with the known names', async () => {
    await assert.rejects(encode(paint(1, 1, () => [0, 0, 0, 255]), 'jpeg'), /Known encodings: webp-lossless, png, png-card/);
});

test('the encodings give the bytes of shipped files from their own pixels', async () => {
    const files = [
        ['public/img/sillybunny/about-tewi@native.webp', 'webp-lossless'],
        ['public/img/apple-icon-57x57.png', 'png'],
        ['public/img/icon-16x16.png', 'png'],
    ];
    for (const [file, encoding] of files) {
        const bytes = readFileSync(join(REPO_ROOT, file));
        assert.equal(sha256(await encode(await decode(bytes), encoding)), sha256(bytes), file);
    }
});

test('the encoder versions name every library that decides the bytes, and a difference is reported', () => {
    const versions = encoderVersions();

    assert.deepEqual(Object.keys(versions), [...ENCODER_LIBRARIES]);
    assert.deepEqual(encoderMismatches(versions), []);
    assert.deepEqual(encoderMismatches({ ...versions, webp: '0.0.1' }), [{ library: 'webp', expected: '0.0.1', actual: versions.webp }]);
});
