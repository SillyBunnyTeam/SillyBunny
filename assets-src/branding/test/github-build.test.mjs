import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import sharp from 'sharp';
import { drawArt, findArtProblems, findStrayPieces, loadArt, makePlaceholderArt } from '../scripts/lib/github-art.mjs';
import { buildLayout, placeBox } from '../scripts/lib/github-build.mjs';
import { parseGithubConfig } from '../scripts/lib/github-config.mjs';
import { countColours, isLossless, optimisePng } from '../scripts/lib/github-png.mjs';
import { titleSize } from '../scripts/lib/github-text.mjs';
import { readRaster, writeRaster } from '../scripts/lib/raster.mjs';
import { createRaster, getPixel, nativeSprite, setPixel } from '../test-support/synthetic.mjs';
import { tempDir } from '../test-support/temp-dir.mjs';

const COLOURS = [[200, 40, 50], [40, 60, 200], [230, 210, 90], [60, 160, 90], [250, 250, 250]];
const PLATE = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" rx="24" fill="#f5e9ff"/><circle cx="50" cy="55" r="22" fill="#8b64aa"/></svg>';
// The drawing sits inside a larger viewBox, as the real emblem does, so the cut of the empty margin is exercised.
const EMBLEM = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200"><rect x="60" y="40" width="80" height="120" fill="#8b64aa"/></svg>';
const SCENE_COLOURS = { lavender: '#b99bf2', logo: '#8b64aa', plum: '#5b3c6b', ink: '#24152f', pale: '#f5e9ff', night: '#1c1228', moon: '#e4d2f5', star: '#b99bf2' };

const art = () => nativeSprite(20, 24, COLOURS, { seed: 5, margin: 3 });
const sources = (picture = art(), placeholders = []) => ({ plateSvg: PLATE, emblemSvg: EMBLEM, art: { day: picture }, placeholders });

/** A layout through the config parser, so the tests use the same checked shapes as the real run. */
function layoutOf({ background = 'pale', width = 400, height = 300, elements }) {
    const config = parseGithubConfig({
        colours: SCENE_COLOURS,
        sources: { plate: 'p.svg', emblem: 'e.svg', art: { day: 'd.png' }, placeholders: { day: { width: 30, height: 30 } } },
        assets: { avatar: { width, height, maxBytes: 1000000 }, social: { width: 1280, height: 640, maxBytes: 1000000 }, banner: { width: 2560, height: 800, maxBytes: 1000000 } },
        final: {},
        layouts: [{ id: 'test', asset: 'avatar', background, width, height, elements }],
    });
    return config.layouts[0];
}

const context = (picture, placeholders) => ({ colours: SCENE_COLOURS, sources: sources(picture, placeholders) });

test('a box is pinned by one horizontal and one vertical anchor, and a distance from the right or bottom may be negative', () => {
    const canvas = { width: 400, height: 300 };
    assert.deepEqual(placeBox({ left: 10, top: 20 }, { width: 50, height: 40 }, canvas), { x: 10, y: 20 });
    assert.deepEqual(placeBox({ right: 10, bottom: 20 }, { width: 50, height: 40 }, canvas), { x: 340, y: 240 });
    assert.deepEqual(placeBox({ centerX: 200, centerY: 150 }, { width: 50, height: 41 }, canvas), { x: 175, y: 130 });
    assert.deepEqual(placeBox({ right: -30, bottom: -10 }, { width: 50, height: 40 }, canvas), { x: 380, y: 270 });
});

test('art is cut to its drawn pixels, and a picture with soft edges is refused because it was never snapped', async () => {
    const dir = tempDir('sb-github-art-');
    await writeRaster(join(dir, 'snapped.png'), art());
    const loaded = await loadArt(join(dir, 'snapped.png'));
    assert.deepEqual([loaded.width, loaded.height], [14, 18], 'the 3 empty pixels around the figure are cut');

    const soft = art();
    setPixel(soft, 10, 10, [10, 10, 10, 120]);
    await writeRaster(join(dir, 'soft.png'), soft);
    await assert.rejects(loadArt(join(dir, 'soft.png')), /not a snapped picture/);
    await writeRaster(join(dir, 'empty.png'), createRaster(4, 4));
    await assert.rejects(loadArt(join(dir, 'empty.png')), /no opaque pixels/);
});

test('every art pixel is drawn as one even block of the whole step, and what is not drawn stays the background', () => {
    const picture = nativeSprite(12, 10, COLOURS, { seed: 3, margin: 2 });
    for (const step of [1, 2, 3, 5]) {
        const canvas = createRaster(12 * step + 20, 10 * step + 20, [245, 233, 255, 255]);
        const placement = drawArt(canvas, picture, { step, x: 7, y: 9 });
        assert.deepEqual([placement.width, placement.height], [12 * step, 10 * step]);
        assert.deepEqual(findArtProblems(canvas, placement, picture, [245, 233, 255, 255]), []);
        assert.deepEqual(getPixel(canvas, 0, 0), [245, 233, 255, 255]);
    }
});

test('a block that is not even, a smeared edge and a half step are all found or refused', () => {
    const picture = nativeSprite(12, 10, COLOURS, { seed: 3, margin: 2 });
    const background = [245, 233, 255, 255];
    const canvas = createRaster(60, 50, background);
    const placement = drawArt(canvas, picture, { step: 3, x: 5, y: 5 });

    setPixel(canvas, placement.x + 4 * 3 + 1, placement.y + 4 * 3 + 2, [1, 2, 3, 255]);
    const problems = findArtProblems(canvas, placement, picture, background);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /art pixel 4,4 is not an even 3x3 block/);

    for (const step of [0, 1.5, -2, '2']) {
        assert.throws(() => drawArt(createRaster(60, 50, background), picture, { step, x: 0, y: 0 }), /whole number of 1 or more/);
    }
    assert.throws(() => drawArt(createRaster(60, 50, background), picture, { step: 2, x: 0.5, y: 0 }), /whole pixels/);
});

test('art that runs off an edge keeps even blocks where the edge cuts it', () => {
    const picture = nativeSprite(12, 10, COLOURS, { seed: 3, margin: 2 });
    const background = [245, 233, 255, 255];
    const canvas = createRaster(40, 30, background);
    const placement = drawArt(canvas, picture, { step: 4, x: 25, y: 18 });
    assert.ok(placement.x + placement.width > canvas.width && placement.y + placement.height > canvas.height);
    assert.deepEqual(findArtProblems(canvas, placement, picture, background), []);
});

test('a layout is built crisp and exact: the same input is the same bytes, the art is even blocks, and the size is the canvas', async () => {
    const layout = layoutOf({
        elements: [
            { type: 'emblem', height: 120, at: { left: 20, top: 20 } },
            { type: 'wordmark', size: 40, colour: 'ink', at: { left: 20, bottom: 30 } },
            { type: 'art', source: 'day', step: 4, at: { right: 20, bottom: 20 } },
        ],
    });
    const trimmed = await loadArtFrom(art());
    const first = await buildLayout(layout, context(trimmed));
    const second = await buildLayout(layout, context(trimmed));
    assert.equal(Buffer.compare(first.png, second.png), 0);

    const decoded = await readRaster(first.png);
    assert.deepEqual([decoded.width, decoded.height], [400, 300]);
    const [emblem, wordmark, artPlacement] = first.placements;
    assert.deepEqual([emblem.type, wordmark.type, artPlacement.type], ['emblem', 'wordmark', 'art']);
    assert.equal(emblem.height, 120);
    assert.equal(emblem.width, Math.round((120 * 80) / 120), 'the emblem is cut to its drawing: 80 by 120 units of its 200 by 200 view');
    assert.equal(artPlacement.step, 4);
    assert.deepEqual(findArtProblems(decoded, artPlacement, trimmed, [245, 233, 255, 255]), []);
    assert.equal(decoded.data[3], 255, 'a solid background has no transparency');
});

async function loadArtFrom(picture) {
    const dir = tempDir('sb-github-art-');
    await writeRaster(join(dir, 'a.png'), picture);
    return loadArt(join(dir, 'a.png'));
}

test('the emblem keeps its flat colour: a straight edge of the drawing is on whole pixels', async () => {
    const layout = layoutOf({ elements: [{ type: 'emblem', height: 120, at: { left: 20, top: 20 } }] });
    const built = await buildLayout(layout, context());
    const decoded = await readRaster(built.png);
    assert.deepEqual(getPixel(decoded, 60, 80), [139, 100, 170, 255]);
    assert.deepEqual(getPixel(decoded, 19, 80), [245, 233, 255, 255]);
    assert.deepEqual(getPixel(decoded, 20, 80), [139, 100, 170, 255]);
});

test('a layout that puts two things on each other, leaves the canvas, or reads badly is refused before it is drawn', async () => {
    const overlapping = layoutOf({ elements: [{ type: 'plate', size: 100, at: { left: 10, top: 10 } }, { type: 'emblem', height: 100, at: { left: 50, top: 20 } }] });
    await assert.rejects(buildLayout(overlapping, context()), /emblem and the plate overlap/);

    const leaving = layoutOf({ elements: [{ type: 'art', source: 'day', step: 4, at: { right: -20, top: 10 } }] });
    await assert.rejects(buildLayout(leaving, context()), /leaves the 400x300 canvas.*"bleed": true/);
    const bleeding = layoutOf({ elements: [{ type: 'art', source: 'day', step: 4, bleed: true, at: { right: -20, top: 10 } }] });
    await buildLayout(bleeding, context());

    const faint = layoutOf({ background: 'lavender', elements: [{ type: 'wordmark', size: 40, colour: 'pale', at: { left: 10, top: 10 } }] });
    await assert.rejects(buildLayout(faint, context()), /wordmark in pale on lavender has a contrast of .*under 4.5/);
    const badEmblem = layoutOf({ background: 'lavender', elements: [{ type: 'emblem', height: 100, at: { left: 10, top: 10 } }] });
    await assert.rejects(buildLayout(badEmblem, context()), /emblem on lavender has a contrast of .*under 3/);
});

test('a transparent avatar keeps the corners of its plate transparent, and a solid one has none', async () => {
    const bare = await buildLayout(layoutOf({ background: null, width: 100, height: 100, elements: [{ type: 'plate', size: 100, at: { left: 0, top: 0 } }] }), context());
    const bareDecoded = await readRaster(bare.png);
    assert.equal(bareDecoded.data[3], 0, 'the corner pixel is clear');
    assert.equal(getPixel(bareDecoded, 50, 10)[3], 255);

    const solid = await buildLayout(layoutOf({ background: 'lavender', width: 100, height: 100, elements: [{ type: 'plate', size: 100, at: { left: 0, top: 0 } }] }), context());
    assert.deepEqual(getPixel(await readRaster(solid.png), 0, 0), [185, 155, 242, 255]);
});

const COLOUR_TYPES = { 0: 'grey', 2: 'rgb', 3: 'palette', 4: 'grey+alpha', 6: 'rgba' };
/** The colour type that a PNG declares in its header, which is what a viewer decodes it as. */
const colourTypeOf = (png) => COLOUR_TYPES[png[25]];
const rawOf = (raster) => sharp(raster.data, { raw: { width: raster.width, height: raster.height, channels: 4 } });
const gradient = (alphaAt = () => 255) => {
    const raster = createRaster(32, 32);
    for (let y = 0; y < 32; y++) {
        for (let x = 0; x < 32; x++) {
            setPixel(raster, x, y, [x * 8, y * 8, (x * y) % 256, alphaAt(x, y)]);
        }
    }
    return raster;
};

test('the PNG is lossless, never larger than the plain truecolour file, a palette only for 256 colours or fewer, and has no alpha channel when nothing is transparent', async () => {
    const flat = createRaster(64, 64, [10, 20, 30, 255]);
    setPixel(flat, 3, 3, [200, 100, 50, 255]);
    assert.equal(countColours(flat), 2);
    const flatPng = await optimisePng(flat);
    assert.equal(await isLossless(flatPng, flat), true);
    assert.ok(['palette', 'rgb'].includes(colourTypeOf(flatPng)), `an opaque picture is a palette or an RGB file, got ${colourTypeOf(flatPng)}`);
    assert.equal((await sharp(flatPng).metadata()).hasAlpha, false, 'no alpha channel when nothing is transparent');
    const plain = await rawOf(flat).removeAlpha().png({ compressionLevel: 9, adaptiveFiltering: true }).toBuffer();
    assert.ok(flatPng.length <= plain.length, `${flatPng.length} bytes against ${plain.length} for the plain RGB file`);

    const many = gradient();
    assert.ok(countColours(many) > 256);
    const manyPng = await optimisePng(many);
    assert.equal(colourTypeOf(manyPng), 'rgb', 'more than 256 colours stay truecolour, with no alpha channel, and are never reduced to a palette');
    assert.equal(await isLossless(manyPng, many), true);

    const holed = gradient((x, y) => (x === 0 && y === 0 ? 0 : 255));
    const holedPng = await optimisePng(holed);
    assert.equal(colourTypeOf(holedPng), 'rgba', 'one transparent pixel keeps the alpha channel');
    assert.equal(await isLossless(holedPng, holed), true);

    const clear = createRaster(16, 16);
    setPixel(clear, 5, 5, [9, 9, 9, 255]);
    const clearPng = await optimisePng(clear);
    assert.ok(['palette', 'rgba'].includes(colourTypeOf(clearPng)));
    assert.equal((await sharp(clearPng).metadata()).hasAlpha, true, 'a picture with transparency keeps it');
    assert.equal(await isLossless(clearPng, clear), true);
});

test('the lossless gate refuses a PNG that decodes to other pixels: a palette made by reducing the colours, a changed pixel, another size', async () => {
    const many = gradient();
    const reduced = await rawOf(many).png({ palette: true, colours: 16, dither: 0 }).toBuffer();
    assert.equal(colourTypeOf(reduced), 'palette');
    assert.equal(await isLossless(reduced, many), false, '16 colours for a picture of 1000');
    assert.equal(await isLossless(await optimisePng(many), many), true, 'and the file that optimisePng makes is let through');

    const changed = gradient();
    setPixel(changed, 31, 31, [1, 2, 3, 255]);
    assert.equal(await isLossless(await optimisePng(changed), many), false, 'one pixel that differs');
    const smaller = createRaster(31, 32);
    assert.equal(await isLossless(await optimisePng(smaller), createRaster(32, 31)), false, 'the same count of pixels in another shape');
});

test('optimisePng never returns the smaller palette file when it is not lossless: the colours that hide under a transparent pixel are kept', async () => {
    // 21 colours, so a palette is tried. Most pixels are transparent, each with a colour of its own under the transparency.
    const hidden = createRaster(64, 64);
    for (let at = 0; at < 64 * 64; at++) {
        const hiding = at % 20;
        setPixel(hidden, at % 64, Math.floor(at / 64), at % 7 === 0 ? [200, 100, 50, 255] : [hiding * 3, hiding * 5, hiding, 0]);
    }
    assert.ok(countColours(hidden) <= 256);
    const palette = await rawOf(hidden).png({ compressionLevel: 9, adaptiveFiltering: true, palette: true, effort: 10, colours: 256, dither: 0 }).toBuffer();
    assert.equal(await isLossless(palette, hidden), false, 'the palette encoder drops the colours under the transparency');
    const chosen = await optimisePng(hidden);
    assert.equal(await isLossless(chosen, hidden), true, 'what optimisePng returns holds every pixel, the hidden colours too');
    assert.ok(palette.length < chosen.length, `the palette (${palette.length} bytes) is the smaller of the two, so only the gate keeps it out`);
    assert.equal(colourTypeOf(chosen), 'rgba');
});

test('a picture whose drawing reaches its edge is refused, because the sticker may have been cut off there', async () => {
    const dir = tempDir('sb-github-edge-');
    const sticker = (margin) => nativeSprite(16, 16, COLOURS, { seed: 9, margin });
    await writeRaster(join(dir, 'whole.png'), sticker(1));
    assert.deepEqual([(await loadArt(join(dir, 'whole.png'))).width, 14].map(Number), [14, 14]);
    await writeRaster(join(dir, 'cut.png'), sticker(0));
    await assert.rejects(loadArt(join(dir, 'cut.png')), /drawn pixels on the edge of the picture.*all round it/);

    const touchesRight = createRaster(16, 16);
    for (let y = 4; y < 12; y++) {
        for (let x = 6; x < 16; x++) {
            setPixel(touchesRight, x, y, COLOURS[0]);
        }
    }
    await writeRaster(join(dir, 'right.png'), touchesRight);
    await assert.rejects(loadArt(join(dir, 'right.png')), /edge of the picture/);
});

test('a title is drawn from its words at the size it promises, and wraps at its maximum width', async () => {
    const layout = layoutOf({ width: 2560, height: 800, elements: [{ type: 'title', title: 'features', size: 136, colour: 'plum', maxWidth: 1400, at: { left: 200, centerY: 400 } }] });
    const built = await buildLayout(layout, context());
    const [title] = built.placements;
    const promised = titleSize('features', { size: 136, maxWidth: 1400 });
    assert.deepEqual([title.width, title.height], [promised.width, promised.height]);
    assert.ok(title.height > 2 * 100, 'two lines');
    assert.equal(title.y, 400 - Math.floor(title.height / 2));
    const decoded = await readRaster(built.png);
    assert.ok(decoded.data.some((value, at) => at % 4 === 0 && value === 0x5b), 'the title is drawn in the plum');
});

test('a title is held to the contrast of text, and may not lie on the logo', async () => {
    const faint = layoutOf({ background: 'lavender', elements: [{ type: 'title', title: 'credits', size: 40, colour: 'pale', at: { left: 10, top: 10 } }] });
    await assert.rejects(buildLayout(faint, context()), /title in pale on lavender has a contrast of .*under 4.5/);
    const clashing = layoutOf({ elements: [{ type: 'emblem', height: 100, at: { left: 10, top: 10 } }, { type: 'title', title: 'credits', size: 40, colour: 'ink', at: { left: 30, top: 30 } }] });
    await assert.rejects(buildLayout(clashing, context()), /title and the emblem overlap/);
    assert.throws(() => layoutOf({ elements: [{ type: 'title', title: 'credits', size: 40, colour: 'ink', at: { left: 0, top: 0 }, text: 'Hello' }] }), /unknown key "text"/);
});

test('decoration is painted behind the art and may lie under it, but never under the logo or the text', async () => {
    const moon = { type: 'moon', colour: 'moon', unit: 6, diameter: 12, bite: 4, lift: 1, at: { left: 150, top: 40 } };
    const behind = layoutOf({ width: 400, height: 300, elements: [moon, { type: 'art', source: 'day', step: 4, at: { left: 150, top: 40 } }] });
    const withGap = await loadArtFrom(art());
    for (let row = 2; row < 12; row++) {
        for (let column = 0; column < 10; column++) {
            setPixel(withGap, column, row, [0, 0, 0, 0]);
        }
    }
    const built = await buildLayout(behind, context(withGap));
    const decoded = await readRaster(built.png);
    const solid = getPixel(decoded, 150 + 12 * 4, 40 + 13 * 4);
    assert.deepEqual(solid, [...withGap.data.subarray((13 * withGap.width + 12) * 4, (13 * withGap.width + 12) * 4 + 4)], 'the art covers the moon where it is drawn');
    assert.ok(decoded.data.some((value, at) => at % 4 === 0 && value === 0xe4 && decoded.data[at + 1] === 0xd2 && decoded.data[at + 2] === 0xf5), 'the moon shows where the art has gaps');
    const [moonPlacement, artPlacement] = built.placements;
    assert.deepEqual([moonPlacement.type, artPlacement.type], ['moon', 'art'], 'decoration is listed before the picture it lies under');

    const underLogo = layoutOf({ elements: [{ ...moon, at: { left: 20, top: 20 } }, { type: 'emblem', height: 100, at: { left: 30, top: 30 } }] });
    await assert.rejects(buildLayout(underLogo, context()), /emblem and the moon overlap/);
    const underText = layoutOf({ elements: [{ type: 'wordmark', size: 60, colour: 'ink', at: { left: 20, top: 20 } }, { ...moon, at: { left: 40, top: 20 } }] });
    await assert.rejects(buildLayout(underText, context()), /moon and the wordmark overlap/);
});

test('stars are kept clear of the logo one by one, not as a block, and must lie inside the canvas', async () => {
    const stars = (points) => ({ type: 'sparkles', colour: 'star', unit: 6, points });
    const between = layoutOf({ elements: [stars([{ x: 20, y: 150, arm: 2 }, { x: 380, y: 150, arm: 2 }]), { type: 'emblem', height: 100, at: { centerX: 200, centerY: 150 } }] });
    const built = await buildLayout(between, context());
    assert.equal(built.placements.length, 2);
    assert.ok(built.placements[0].width > 300, 'the stars are one picture the width of their box');

    const onLogo = layoutOf({ elements: [stars([{ x: 200, y: 150, arm: 2 }]), { type: 'emblem', height: 100, at: { centerX: 200, centerY: 150 } }] });
    await assert.rejects(buildLayout(onLogo, context()), /emblem and the sparkles overlap/);
    const outside = layoutOf({ elements: [stars([{ x: 5, y: 150, arm: 2 }])] });
    await assert.rejects(buildLayout(outside, context()), /sparkles at .* leaves the 400x300 canvas/);
});

test('a stand-in for art that is not drawn yet is a whole-pixel slab that is placed, scaled and checked like the real picture', async () => {
    const slab = makePlaceholderArt(80, 60);
    assert.deepEqual([slab.width, slab.height], [80, 60]);
    assert.equal(getPixel(slab, 0, 0)[3], 0, 'the corner is rounded off');
    assert.equal(getPixel(slab, 40, 0)[3], 255, 'the edge is drawn');
    assert.equal(slab.data.every((value, at) => at % 4 !== 3 || value === 0 || value === 255), true, 'no half-transparent pixel');
    assert.equal(Buffer.compare(Buffer.from(makePlaceholderArt(80, 60).data), Buffer.from(slab.data)), 0);

    const layout = layoutOf({ elements: [{ type: 'art', source: 'day', step: 3, at: { right: 20, bottom: 20 } }] });
    const standIn = await buildLayout(layout, context(slab, ['day']));
    assert.deepEqual(standIn.placeholders, ['day']);
    assert.deepEqual([standIn.placements[0].width, standIn.placements[0].height], [240, 180]);
    const real = await buildLayout(layout, context(await loadArtFrom(art()), []));
    assert.deepEqual(real.placeholders, []);
});

test('a speck away from the drawing is found and refused, and a prop with its own outline is kept', async () => {
    const dir = tempDir('sb-github-specks-');
    const sticker = createRaster(80, 60);
    const fill = (x0, y0, x1, y1) => {
        for (let y = y0; y < y1; y++) {
            for (let x = x0; x < x1; x++) {
                setPixel(sticker, x, y, COLOURS[1]);
            }
        }
    };
    fill(20, 10, 60, 50);
    fill(5, 20, 12, 30);
    assert.deepEqual(findStrayPieces(sticker), [], 'a piece of 70 pixels is a prop, and a corner-to-corner touch joins pieces');
    await writeRaster(join(dir, 'clean.png'), sticker);
    await loadArt(join(dir, 'clean.png'));

    setPixel(sticker, 70, 5, COLOURS[2]);
    setPixel(sticker, 71, 6, COLOURS[2]);
    assert.deepEqual(findStrayPieces(sticker), [{ pixels: 2, x: 70, y: 5 }]);
    await writeRaster(join(dir, 'speck.png'), sticker);
    await assert.rejects(loadArt(join(dir, 'speck.png')), /1 stray piece of under 40 drawn pixels outside the sticker \(first at 70,5, 2 px\)/);
});
