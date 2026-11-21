import assert from 'node:assert/strict';
import { test } from 'node:test';
import sharp from 'sharp';
import { BOX_COLOUR, DARK_BACKGROUND, DOME_COLOUR, FRAME_SIZE, LIGHT_BACKGROUND, buildLogoSheet, renderSvg, svgSide } from '../scripts/lib/logo-sheet.mjs';
import { createRaster, setPixel } from '../test-support/synthetic.mjs';

const svgOf = (side, body = '<rect x="30" y="20" width="40" height="60" fill="#8b64aa"/>') => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${side} ${side}">${body}</svg>\n`;
const frame = (label, domeX = 50, boxX = 56) => ({ label, svg: svgOf(100), domeX, boxX });

function pixelPng() {
    const raster = createRaster(16, 16);
    for (let y = 2; y < 14; y++) {
        for (let x = 3; x < 13; x++) {
            setPixel(raster, x, y, [139, 100, 170, 255]);
        }
    }
    return sharp(raster.data, { raw: { width: 16, height: 16, channels: 4 } }).png().toBuffer();
}

const hasColour = (data, channels, hex) => {
    const [r, g, b] = [1, 3, 5].map((start) => parseInt(hex.slice(start, start + 2), 16));
    for (let at = 0; at < data.length; at += channels) {
        if (data[at] === r && data[at + 1] === g && data[at + 2] === b) {
            return true;
        }
    }
    return false;
};

test('the side of a square SVG is read from its viewBox, and anything else is refused', () => {
    assert.equal(svgSide(svgOf(250)), 250);
    assert.equal(svgSide(svgOf(100.5)), 100.5);
    assert.throws(() => svgSide('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50"></svg>'), /square viewBox/);
    assert.throws(() => svgSide('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>'), /square viewBox/);
});

test('an SVG is rendered at the size asked for, with a transparent background', async () => {
    const { data, info } = await sharp(await renderSvg(svgOf(100), 64)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    assert.deepEqual([info.width, info.height], [64, 64]);
    assert.equal(data[3], 0, 'the corner is clear');
    const middle = (32 * 64 + 32) * 4;
    assert.deepEqual([...data.subarray(middle, middle + 4)], [139, 100, 170, 255]);
});

test('the sheet shows the frames on a light and a dark strip with both ticks, and grows with each section', async () => {
    const centring = [frame('base'), frame('bbox', 50, 50)];
    const base = await buildLogoSheet({ centring });
    const { data, info } = await sharp(base).raw().toBuffer({ resolveWithObject: true });
    assert.ok(info.width >= FRAME_SIZE * 2 && info.height > FRAME_SIZE * 2, `${info.width}x${info.height}`);
    for (const colour of [LIGHT_BACKGROUND, DARK_BACKGROUND, DOME_COLOUR, BOX_COLOUR, '#8b64aa']) {
        assert.ok(hasColour(data, info.channels, colour), `${colour} is on the sheet`);
    }

    const heights = {};
    heights.base = info.height;
    const crop = { label: 'close-up', svg: svgOf(100), box: { x: 10, y: 10, width: 60, height: 30 } };
    for (const [name, extra] of [
        ['shading', { shading: [frame('plain'), frame('A'), frame('B')] }],
        ['crops', { crops: [crop, crop] }],
        ['small', { small: [{ label: 'small sizes', svg: svgOf(100) }] }],
        ['drafts', { drafts: [{ label: '16 px', grid: 16, bytes: await pixelPng() }] }],
    ]) {
        heights[name] = (await sharp(await buildLogoSheet({ centring, ...extra })).metadata()).height;
        assert.ok(heights[name] > heights.base, `${name} adds a section`);
    }
});

test('a sheet needs at least one frame, and a crop outside its picture is refused rather than drawn empty', async () => {
    await assert.rejects(buildLogoSheet({ centring: [] }), /no frames/);
    const outside = { label: 'outside', svg: svgOf(100), box: { x: 90, y: 90, width: 60, height: 30 } };
    await assert.rejects(buildLogoSheet({ centring: [frame('base')], crops: [outside] }));
});
