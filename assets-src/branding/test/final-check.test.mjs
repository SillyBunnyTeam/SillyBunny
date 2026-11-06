import assert from 'node:assert/strict';
import { test } from 'node:test';
import sharp from 'sharp';
import { enlarge } from '../scripts/lib/plate-sheet.mjs';
import { DARK_BACKGROUND, LIGHT_BACKGROUND } from '../scripts/lib/logo-sheet.mjs';
import { CHECK_SIZE, FAVICON_ENLARGEMENT, FAVICON_SIZES, PLATE_SIZES, buildFinalCheck } from '../scripts/lib/final-check.mjs';

const svgOf = (fill) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect x="10" y="10" width="80" height="80" fill="${fill}"/></svg>\n`;
const FILES = { emblem: svgOf('#8b64aa'), emblemNolines: svgOf('#5b3c6b'), plate: svgOf('#f5e9ff'), plateNolines: svgOf('#240f33') };

const hasColour = (data, channels, hex) => {
    const [r, g, b] = [1, 3, 5].map((start) => Number.parseInt(hex.slice(start, start + 2), 16));
    for (let at = 0; at < data.length; at += channels) {
        if (data[at] === r && data[at + 1] === g && data[at + 2] === b) {
            return true;
        }
    }
    return false;
};

test('the check sheet shows every file on both pages, from the files it is given', async () => {
    const png = await buildFinalCheck(FILES);
    const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
    for (const colour of [LIGHT_BACKGROUND, DARK_BACKGROUND, '#8b64aa', '#5b3c6b', '#f5e9ff', '#240f33']) {
        assert.ok(hasColour(data, info.channels, colour), `${colour} is on the sheet`);
    }
});

test('the sheet is wide enough for four files at 512 px and tall enough for all three sections on two pages', async () => {
    const { width, height } = await sharp(await buildFinalCheck(FILES)).metadata();
    assert.ok(width >= 4 * CHECK_SIZE, `${width} px wide`);
    const faviconStrip = FAVICON_SIZES.reduce((total, size) => total + size * (1 + FAVICON_ENLARGEMENT), 0);
    assert.ok(width >= faviconStrip);
    assert.ok(height > 2 * CHECK_SIZE + 2 * Math.max(...PLATE_SIZES) + 2 * Math.max(...FAVICON_SIZES) * FAVICON_ENLARGEMENT, `${height} px tall`);
});

test('the enlarged copy of a small size keeps hard pixel edges', async () => {
    const small = await sharp(Buffer.from([255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 0]), { raw: { width: 2, height: 2, channels: 3 } }).png().toBuffer();
    const { data, info } = await sharp(await enlarge(small, 2, FAVICON_ENLARGEMENT)).raw().toBuffer({ resolveWithObject: true });
    assert.equal(info.width, 2 * FAVICON_ENLARGEMENT);
    const colours = new Set();
    for (let at = 0; at < data.length; at += info.channels) {
        colours.add(`${data[at]},${data[at + 1]},${data[at + 2]}`);
    }
    assert.equal(colours.size, 4);
});
