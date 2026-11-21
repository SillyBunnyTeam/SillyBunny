import assert from 'node:assert/strict';
import { test } from 'node:test';
import sharp from 'sharp';
import { DARK_BACKGROUND, LIGHT_BACKGROUND } from '../scripts/lib/logo-sheet.mjs';
import { SMALL_ENLARGEMENT, SMALL_SIZES, TILE_SIZE, buildPlateSheet } from '../scripts/lib/plate-sheet.mjs';

const svgOf = (fill) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect x="10" y="10" width="80" height="80" fill="${fill}"/></svg>\n`;
const plate = (id, fill) => ({ id, label: id, withLines: svgOf(fill), withoutLines: svgOf(fill) });
const PLATES = [plate('S-L', '#f5e9ff'), plate('S-D', '#240f33'), plate('C-L', '#f5e9ff'), plate('C-D', '#240f33')];

const hasColour = (data, channels, hex) => {
    const [r, g, b] = [1, 3, 5].map((start) => Number.parseInt(hex.slice(start, start + 2), 16));
    for (let at = 0; at < data.length; at += channels) {
        if (data[at] === r && data[at + 1] === g && data[at + 2] === b) {
            return true;
        }
    }
    return false;
};

test('the sheet holds the reference and every plate on a light and a dark page, in the sizes asked for', async () => {
    const notes = ['plate L #f5e9ff', 'S: scale 0.8743'];
    const png = await buildPlateSheet({ reference: svgOf('#8b64aa'), plates: PLATES, notes });
    const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
    for (const colour of [LIGHT_BACKGROUND, DARK_BACKGROUND, '#f5e9ff', '#240f33', '#8b64aa']) {
        assert.ok(hasColour(data, info.channels, colour), `${colour} is on the sheet`);
    }
    // Four plates of the tile size side by side with their gaps, and the strip of small sizes: 64 and 32 with a 4x copy of each, for each plate.
    const smallStrip = PLATES.length * SMALL_SIZES.reduce((total, size) => total + size * (1 + SMALL_ENLARGEMENT), 0);
    assert.ok(info.width >= Math.max(PLATES.length * TILE_SIZE, smallStrip), `${info.width} px wide`);
    // The reference row, two rows of tiles on each page and a strip of small sizes on each page.
    assert.ok(info.height > 5 * TILE_SIZE + 2 * SMALL_SIZES[0] * SMALL_ENLARGEMENT, `${info.height} px tall`);
});

test('the sheet is no taller than what is asked for a sheet that is reviewed in sections', async () => {
    const png = await buildPlateSheet({ reference: svgOf('#8b64aa'), plates: PLATES, notes: [] });
    assert.ok((await sharp(png).metadata()).height < 3000);
});

test('a sheet needs plates', async () => {
    await assert.rejects(buildPlateSheet({ reference: svgOf('#000000'), plates: [], notes: [] }), /no plates/);
});
