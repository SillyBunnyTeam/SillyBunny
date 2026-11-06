import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { readPngHeader } from '../scripts/lib/ico.mjs';
import { SAFE_ZONE_DIAMETER, coverageDraft, plateColour, platformSvg, reachFromCentre, renderPng } from '../scripts/lib/icon-render.mjs';
import { getPixel } from '../test-support/synthetic.mjs';

const APPROVED = join(dirname(fileURLToPath(import.meta.url)), '..', 'approved');
const approved = (name) => readFileSync(join(APPROVED, name), 'utf8');
const decode = async (png) => {
    const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    return { width: info.width, height: info.height, data };
};

// Three columns of a 4 px wide picture are covered: the first two fully, the third by a quarter, the fourth not at all.
const EDGE_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 4 4"><rect width="2.25" height="4" fill="#8b64aa"/></svg>';

test('a draft pixel is the mean of what it covers: the shape colour at an alpha that is the covered share', async () => {
    const draft = await coverageDraft(EDGE_SVG, 4, 8);
    assert.deepEqual(getPixel(draft, 0, 1), [139, 100, 170, 255]);
    assert.deepEqual(getPixel(draft, 1, 3), [139, 100, 170, 255]);
    assert.deepEqual(getPixel(draft, 2, 2), [139, 100, 170, 64], 'a quarter covered keeps the colour and has a quarter of the alpha');
    assert.equal(getPixel(draft, 3, 0)[3], 0);
});

test('a pixel covered by two tones takes their mean weighted by area, not a blend with the empty part', async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 2 2"><rect width="1" height="2" fill="#ff0000"/><rect x="1" width="0.5" height="2" fill="#0000ff"/></svg>';
    const draft = await coverageDraft(svg, 1, 16);
    const [red, green, blue, alpha] = getPixel(draft, 0, 0);
    assert.deepEqual([red, green, blue], [170, 0, 85], 'two parts red to one part blue');
    assert.equal(alpha, 191, 'three quarters of the pixel is covered');
});

test('a draft needs whole numbers for its size and its supersample', async () => {
    await assert.rejects(coverageDraft(EDGE_SVG, 2.5), /whole size/);
    await assert.rejects(coverageDraft(EDGE_SVG, 4, 0), /whole size/);
});

test('the plate colour is the fill inside the clip group, not the lip, and a plate without one is refused', () => {
    assert.equal(plateColour(approved('logo-plate.svg')), '#f5e9ff');
    assert.equal(plateColour(approved('logo-plate-nolines.svg')), '#f5e9ff');
    assert.throws(() => plateColour(approved('logo-emblem.svg')), /no plate fill/);
});

test('a plate is drawn with transparent corners and an opaque picture has no alpha channel', async () => {
    const plate = await renderPng(approved('logo-plate.svg'), 64);
    assert.equal(readPngHeader(plate).colourType, 6);
    const { data, width } = await decode(plate);
    assert.equal(data[3], 0, 'the corner pixel is empty');
    assert.equal(data[(32 * width + 32) * 4 + 3], 255, 'the middle is solid');
    const opaque = await renderPng(approved('logo-plate.svg'), 64, { opaque: true });
    assert.equal(readPngHeader(opaque).colourType, 2);
});

for (const [name, plate, emblem] of [['with lines', 'logo-plate.svg', 'logo-emblem.svg'], ['without lines', 'logo-plate-nolines.svg', 'logo-emblem-nolines.svg']]) {
    test(`the platform icon ${name} is the plate colour edge to edge with the whole emblem inside the central 80% circle, and fills most of it`, async () => {
        const svg = platformSvg({ plate: approved(plate), emblem: approved(emblem), reach: await reachFromCentre(approved(emblem)) });
        const size = 512;
        const { data } = await decode(await renderPng(svg, size, { opaque: true }));
        const [pr, pg, pb] = [0xf5, 0xe9, 0xff];
        assert.deepEqual([...data.subarray(0, 3)], [pr, pg, pb], 'the corner is the plate colour');
        assert.deepEqual([...data.subarray((size * size - 1) * 4, (size * size - 1) * 4 + 3)], [pr, pg, pb]);
        const safeRadius = (size * SAFE_ZONE_DIAMETER) / 2;
        let farthest = 0;
        for (let y = 0; y < size; y++) {
            for (let x = 0; x < size; x++) {
                const at = (y * size + x) * 4;
                if (data[at] === pr && data[at + 1] === pg && data[at + 2] === pb) {
                    continue;
                }
                farthest = Math.max(farthest, Math.hypot(Math.max(Math.abs(x - size / 2), Math.abs(x + 1 - size / 2)), Math.max(Math.abs(y - size / 2), Math.abs(y + 1 - size / 2))));
            }
        }
        assert.ok(farthest <= safeRadius, `a pixel of the emblem is ${farthest.toFixed(1)} px from the centre; the safe radius is ${safeRadius}`);
        assert.ok(farthest >= safeRadius * 0.95, `the emblem only reaches ${farthest.toFixed(1)} px of ${safeRadius}, so it is smaller than it can be`);
    });
}

test('the reach of an emblem is the distance to its farthest pixel corner, measured on a 1:1 render', async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect x="0" y="0" width="3" height="3" fill="#000000"/></svg>';
    assert.ok(Math.abs((await reachFromCentre(svg)) - Math.hypot(5, 5)) < 1e-9);
});
