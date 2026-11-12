import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parsePalette, srgbToOklab } from '../scripts/lib/pixel-colour.mjs';
import { paletteToGpl, paletteToHex, proposePalette, renderPalettePreview } from '../scripts/lib/palette-extract.mjs';
import { createRaster, setPixel } from '../test-support/synthetic.mjs';

const BACKGROUND = [244, 241, 251];
const TEN_HUES = [[170, 150, 210], [200, 40, 60], [50, 30, 40], [240, 200, 170], [60, 160, 90], [230, 190, 40], [40, 90, 200], [230, 120, 40], [120, 70, 40], [30, 170, 190]];

/** A 400x400 sheet: lavender background, ten flat blocks of very different size, a white ring round one, and a tiny vivid magenta block. */
function sheet({ colours = TEN_HUES, tiny = [230, 40, 200] } = {}) {
    const raster = createRaster(400, 400, [...BACKGROUND, 255]);
    colours.forEach((colour, index) => {
        const left = 10 + (index % 5) * 76;
        const top = 10 + Math.floor(index / 5) * 120;
        const size = 30 + ((index * 7) % 5) * 9;
        for (let y = top - 2; y < top + size + 2; y++) {
            for (let x = left - 2; x < left + size + 2; x++) {
                const inside = x >= left && y >= top && x < left + size && y < top + size;
                setPixel(raster, x, y, inside ? colour : [255, 255, 255]);
            }
        }
    });
    for (let y = 300; y < 304; y++) {
        for (let x = 300; x < 304; x++) {
            setPixel(raster, x, y, tiny);
        }
    }
    return raster;
}

const distance = (a, b) => {
    const [l1, a1, b1] = srgbToOklab(a);
    const [l2, a2, b2] = srgbToOklab(b);
    return Math.hypot(l1 - l2, a1 - a2, b1 - b2);
};
const hueOf = (rgb) => {
    const [, a, b] = srgbToOklab(rgb);
    return ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360;
};
const chromaOf = (rgb) => Math.hypot(srgbToOklab(rgb)[1], srgbToOklab(rgb)[2]);
const lightnessOf = (rgb) => srgbToOklab(rgb)[0];
const angle = (a, b) => Math.abs(((a - b + 540) % 360) - 180);

test('the proposal has the requested number of colours, all different, with white and the sticker rim first', () => {
    const { colours, warnings } = proposePalette(sheet(), { colours: 28 });
    assert.equal(colours.length, 28);
    assert.deepEqual(warnings, []);
    assert.equal(new Set(colours.map((c) => c.hex)).size, 28);
    assert.deepEqual(colours.slice(0, 2).map((c) => [c.hex, c.role]), [['#ffffff', 'sticker outline'], ['#d9d4e8', 'sticker rim']]);
    for (const { rgb } of colours) {
        assert.ok(rgb.every((channel) => Number.isInteger(channel) && channel >= 0 && channel <= 255));
    }
});

test('the page background is not a palette colour', () => {
    const { colours } = proposePalette(sheet(), { colours: 28 });
    assert.ok(colours.every((c) => distance(c.rgb, BACKGROUND) > 0.02), 'a colour sits on the background');
});

test('every colour family is a ramp: a darker, violet-leaning shadow and a lighter, yellow-leaning highlight around the base', () => {
    const { families } = proposePalette(sheet(), { colours: 28 });
    assert.ok(families.length >= 8);
    let checkedShadow = 0;
    let checkedLight = 0;
    for (const { base, shadow, highlight } of families) {
        assert.ok(lightnessOf(shadow) < lightnessOf(base) - 0.05, 'shadow is darker');
        assert.ok(lightnessOf(highlight) > lightnessOf(base) + 0.03 || lightnessOf(highlight) > 0.95, 'highlight is lighter');
        if (chromaOf(base) > 0.05 && angle(hueOf(base), 285) > 8) {
            assert.ok(angle(hueOf(shadow), 285) <= angle(hueOf(base), 285) + 0.5, `shadow of hue ${hueOf(base).toFixed(0)} leans away from violet`);
            checkedShadow++;
        }
        if (chromaOf(base) > 0.05 && angle(hueOf(base), 95) > 8) {
            assert.ok(angle(hueOf(highlight), 95) <= angle(hueOf(base), 95) + 0.5, `highlight of hue ${hueOf(base).toFixed(0)} leans away from yellow`);
            checkedLight++;
        }
    }
    assert.ok(checkedShadow >= 6 && checkedLight >= 6, 'the check should run on most families');
});

test('a small vivid colour is not lost to the large areas, and the output does not change between runs', () => {
    const first = proposePalette(sheet(), { colours: 28 });
    assert.ok(first.colours.some((c) => distance(c.rgb, [230, 40, 200]) < 0.08), 'the tiny magenta block has a palette colour');
    assert.deepEqual(proposePalette(sheet(), { colours: 28 }).colours, first.colours);
});

test('transparent pixels are ignored, whatever colour they hold', () => {
    const plain = sheet();
    const withJunk = sheet();
    for (let y = 340; y < 400; y++) {
        for (let x = 0; x < 400; x++) {
            setPixel(withJunk, x, y, [255, 0, 255, 0]);
        }
    }
    assert.deepEqual(proposePalette(withJunk, { colours: 28 }).colours, proposePalette(plain, { colours: 28 }).colours);
});

test('a sheet with few distinct colours gives fewer colours than asked, with a warning that says so', () => {
    const { colours, warnings } = proposePalette(sheet({ colours: TEN_HUES.slice(0, 3), tiny: TEN_HUES[0] }), { colours: 28 });
    assert.ok(colours.length < 24);
    assert.match(warnings[0], /fewer colours than the 28 asked for/);
});

test('the colour count must be inside the 24 to 32 range of the style guide', () => {
    assert.throws(() => proposePalette(sheet(), { colours: 23 }), /24 to 32/);
    assert.throws(() => proposePalette(sheet(), { colours: 33 }), /24 to 32/);
    assert.equal(proposePalette(sheet(), { colours: 32 }).colours.length, 32);
    assert.equal(proposePalette(sheet(), { colours: 24 }).colours.length, 24);
});

test('the .hex and .gpl texts read back as the same palette', () => {
    const { colours } = proposePalette(sheet(), { colours: 28 });
    const expected = colours.map((c) => c.rgb);
    assert.deepEqual(parsePalette(paletteToHex(colours), 'x.hex'), expected);
    const gpl = paletteToGpl('reisen-draft', colours);
    assert.match(gpl, /^GIMP Palette\nName: reisen-draft\n/);
    assert.deepEqual(parsePalette(gpl, 'x.gpl'), expected);
});

test('the preview is one row for the reserved colours and one row per family', () => {
    const proposal = proposePalette(sheet(), { colours: 28 });
    const preview = renderPalettePreview(proposal, { swatch: 16, gap: 4 });
    assert.equal(preview.height, 4 + (1 + proposal.families.length) * (16 + 4));
    assert.equal(preview.width, 4 + 4 * (16 + 4));
});
