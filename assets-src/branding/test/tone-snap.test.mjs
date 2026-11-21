import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findTones, pinTone, snapToTones } from '../scripts/lib/tone-snap.mjs';
import { addNoise, createRaster, getPixel, setPixel } from '../test-support/synthetic.mjs';

const DARK = [89, 60, 103];
const MID = [136, 99, 158];
const hexOf = (rgb) => `#${rgb.map((channel) => channel.toString(16).padStart(2, '0')).join('')}`;

/** Two tones side by side with a two pixel antialiased seam, on a transparent border with a faint halo of nearly invisible pixels. */
function seamPicture() {
    const raster = createRaster(60, 40);
    for (let y = 5; y < 35; y++) {
        for (let x = 5; x < 55; x++) {
            const mixed = x === 29 || x === 30;
            const colour = mixed ? MID.map((channel, at) => Math.round(channel * (x === 29 ? 0.67 : 0.33) + DARK[at] * (x === 29 ? 0.33 : 0.67))) : (x < 29 ? MID : DARK);
            setPixel(raster, x, y, colour);
        }
    }
    for (let x = 0; x < 60; x++) {
        setPixel(raster, x, 2, [200, 200, 200, 30]);
    }
    return raster;
}

test('the tones of a picture are the colours its pixels sit on, with antialiasing and faint pixels left out', () => {
    const tones = findTones(seamPicture());
    assert.equal(tones.length, 2);
    assert.deepEqual(tones.map(({ rgb }) => rgb).sort(), [DARK, MID].sort());
    assert.ok(tones[0].share > 0.45 && tones[0].share < 0.55);
    assert.equal(tones[0].hex, hexOf(tones[0].rgb));
});

test('small jitter inside a tone does not make new tones, and the tone is the middle of the jitter', () => {
    const noisy = addNoise(seamPicture(), 2);
    const tones = findTones(noisy);
    assert.equal(tones.length, 2);
    for (const { rgb } of tones) {
        assert.ok([MID, DARK].some((real) => real.every((channel, at) => Math.abs(channel - rgb[at]) <= 1)), `${rgb}`);
    }
});

test('a picture with nothing opaque has no tones', () => {
    assert.throws(() => findTones(createRaster(5, 5)), /no opaque pixels/);
});

test('snapping gives every opaque pixel one tone at full opacity, sends the seam to a tone and leaves the rest transparent', () => {
    const picture = seamPicture();
    const tones = findTones(picture);
    const { raster, toneIndex } = snapToTones(picture, tones);
    const colours = new Set();
    for (let at = 0; at < raster.data.length; at += 4) {
        if (raster.data[at + 3] !== 0) {
            assert.equal(raster.data[at + 3], 255);
            colours.add(hexOf([...raster.data.subarray(at, at + 3)]));
        }
    }
    assert.equal(colours.size, 2, 'no third colour from the antialiased seam');
    assert.deepEqual(getPixel(raster, 10, 10).slice(3), [255]);
    assert.deepEqual(getPixel(raster, 10, 2), [0, 0, 0, 0], 'the faint halo is background');
    assert.equal(toneIndex[2 * 60 + 10], -1);
    assert.ok(toneIndex[10 * 60 + 10] >= 0);
});

test('the tone nearest the brand colour is set to it exactly, and the others are untouched', () => {
    const tones = findTones(seamPicture());
    const pinned = pinTone(tones, '#8b64aa');
    assert.deepEqual(pinned.map(({ hex }) => hex).sort(), ['#593c67', '#8b64aa']);
    assert.equal(pinned.find(({ hex }) => hex === '#8b64aa').rgb.join(), '139,100,170');
    assert.equal(tones.find(({ hex }) => hex === hexOf(MID)).hex, hexOf(MID), 'the input is not changed');
});

test('a picture with no tone near the brand colour is refused, and so is a malformed colour', () => {
    const tones = findTones(seamPicture());
    assert.throws(() => pinTone(tones, '#20c020'), /No tone of the picture is near #20c020/);
    assert.throws(() => pinTone(tones, 'purple'), /must be a colour like #8b64aa/);
    assert.throws(() => snapToTones(seamPicture(), []), /no tones/);
});
