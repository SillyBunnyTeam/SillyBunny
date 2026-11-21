import assert from 'node:assert/strict';
import { test } from 'node:test';
import { detectAxes } from '../scripts/lib/pixel-grid.mjs';
import { chooseGrid, countColours, measureRings, reduceColours, repairRings, reprojectionError, sampleGrid, snapRaster } from '../scripts/lib/pixel-snap.mjs';
import { opaqueBox } from '../scripts/lib/raster.mjs';
import { measureFigureScaled } from '../scripts/lib/scene-measure.mjs';
import { addNoise, blur, createRaster, getPixel, nativeSprite, setPixel } from '../test-support/synthetic.mjs';
import { figure } from '../test-support/figure.mjs';

const COLOURS = [[200, 40, 50], [40, 60, 200], [230, 210, 90], [60, 160, 90], [250, 250, 250], [40, 20, 50]];
const RIM = [185, 155, 242];
const BAND = [255, 255, 255];

/** Nearest-neighbour enlargement with a different factor across and down, the way a model's drawing is rarely square. */
function stretch(raster, factorX, factorY) {
    const width = Math.round(raster.width * factorX);
    const height = Math.round(raster.height * factorY);
    const out = createRaster(width, height);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const from = (Math.min(raster.height - 1, Math.floor(y / factorY)) * raster.width + Math.min(raster.width - 1, Math.floor(x / factorX))) * 4;
            out.data.set(raster.data.subarray(from, from + 4), (y * width + x) * 4);
        }
    }
    return out;
}

const sprite = nativeSprite(50, 60, COLOURS, { seed: 5, margin: 4 });
const same = (a, b, tolerance) => Math.abs(a - b) <= tolerance;

test('each axis is detected on its own: the pitch across and the pitch down can differ', () => {
    const picture = stretch(sprite, 3.2, 3.6);
    const box = opaqueBox(picture, 128);
    const found = detectAxes(picture, box, { minCell: 2.4, maxCell: 4.6 });
    assert.ok(same(found.across.cell, 3.2, 0.05), `across ${found.across.cell}`);
    assert.ok(same(found.down.cell, 3.6, 0.05), `down ${found.down.cell}`);
    assert.ok(found.across.strength > 2 && found.down.strength > 2, 'a clean grid scores several times chance');
});

test('with no cell given, the square cell is the mean of the two pitches, and both pitches and strengths are reported', () => {
    const picture = stretch(sprite, 3.2, 3.6);
    const grid = chooseGrid(picture);
    assert.equal(grid.cellSource, 'detected');
    assert.ok(same(grid.cell, 3.4, 0.05), `cell ${grid.cell}`);
    assert.ok(same(grid.pitchAcross, 3.2, 0.05) && same(grid.pitchDown, 3.6, 0.05));
    assert.ok(grid.strengthAcross > 2 && grid.strengthDown > 2);
});

test('--cell takes the cell as given and only searches the offsets', () => {
    const picture = stretch(sprite, 3.4, 3.4);
    const grid = chooseGrid(picture, { cell: 3.4 });
    assert.equal(grid.cell, 3.4);
    assert.equal(grid.cellSource, 'manual');
    assert.ok(grid.fitAcross > 2 && grid.fitDown > 2, 'the grid at the given cell fits');
    const off = chooseGrid(picture, { cell: 3.0 });
    assert.ok(off.fitAcross < grid.fitAcross, 'a wrong cell fits worse');
});

test('--figure-height picks the cell that makes the opaque figure that many art pixels tall', () => {
    const picture = stretch(sprite, 3.4, 3.4);
    const box = opaqueBox(picture, 128);
    const grid = chooseGrid(picture, { figureHeight: 40 });
    assert.equal(grid.cellSource, 'figure-height');
    assert.ok(same(grid.cell, box.height / 40, 1e-9));
    assert.ok(same(grid.pitchAcross, 3.4, 0.05), 'the detected pitch is still reported next to the target');
});

test('a cell and a figure height together, a cell of 1 or less, and a figure under 8 art pixels are refused', () => {
    const picture = stretch(sprite, 3.4, 3.4);
    assert.throws(() => chooseGrid(picture, { cell: 3, figureHeight: 40 }), /not more than one/);
    assert.throws(() => chooseGrid(picture, { cell: 3, bodyHeight: 40 }), /not more than one/);
    assert.throws(() => chooseGrid(picture, { bodyHeight: 4 }), /body height must be at least 8/);
    assert.throws(() => chooseGrid(picture, { cell: 1 }), /more than 1/);
    assert.throws(() => chooseGrid(picture, { figureHeight: 4 }), /at least 8/);
    assert.throws(() => chooseGrid(createRaster(20, 20)), /nothing opaque/);
});

test('--body-height picks the cell at which head top to feet, ears left out, is that many art pixels tall', () => {
    const picture = figure();
    const grid = chooseGrid(picture, { bodyHeight: 100 });
    assert.equal(grid.cellSource, 'body-height');
    assert.equal(grid.body.method, 'head');
    assert.ok(same(grid.cell, grid.body.figureHeight / 100, 1e-9));
    assert.ok(grid.body.figureHeight < grid.box.height, 'the ears stand above the head, so the box is taller than the body');
    const { raster, report } = snapRaster(picture, { bodyHeight: 100, ringRepair: false });
    assert.equal(report.targetBodyHeight, 100);
    assert.equal(report.bodyAtCell.masterHeight, grid.body.figureHeight);
    assert.ok(same(measureFigureScaled(raster).figureHeight, 100, 4), `the snapped figure is ${measureFigureScaled(raster).figureHeight} art pixels from head to feet`);
});

test('a body height is refused, saying why, when the head top is not found, while a cell still works', () => {
    const fur = createRaster(200, 400, [252, 250, 252, 255]);
    assert.throws(() => chooseGrid(fur, { bodyHeight: 100 }), /head top of this figure could not be found/);
    assert.equal(chooseGrid(fur, { cell: 4 }).body.method, 'box');
});

test('snapping a clean enlargement gives back the native picture, one pixel per cell', () => {
    const picture = stretch(sprite, 3.4, 3.4);
    const { raster, report } = snapRaster(picture, { ringRepair: false });
    assert.ok(same(report.cell, 3.4, 0.05));
    assert.ok(Math.abs(raster.width - 50) <= 1 && Math.abs(raster.height - 60) <= 1, `${raster.width}x${raster.height}`);
    assert.ok(report.reprojectionError < 3, `error ${report.reprojectionError}`);
});

/** One cell of 10 pixels whose middle (6 x 6) holds three colours: A in 14 pixels, B in 11 and C in 11. */
function cellOfThreeColours() {
    const cell = createRaster(10, 10, [0, 0, 0, 255]);
    const A = [200, 0, 0];
    const B = [0, 200, 0];
    const C = [0, 0, 200];
    const middle = [];
    for (let y = 2; y < 8; y++) {
        for (let x = 2; x < 8; x++) {
            middle.push([x, y]);
        }
    }
    middle.forEach(([x, y], at) => setPixel(cell, x, y, at < 14 ? A : at < 25 ? B : C));
    return { cell, A };
}

test('the mode keeps the commonest colour of the cell, while the median of each channel can land on a colour that is not in the cell', () => {
    const { cell, A } = cellOfThreeColours();
    const grid = { cell: 10, offsetX: 0, offsetY: 0 };
    const mode = getPixel(sampleGrid(cell, grid, 'mode'), 0, 0);
    const median = getPixel(sampleGrid(cell, grid, 'median'), 0, 0);
    assert.deepEqual(mode, [...A, 255]);
    assert.notDeepEqual(median.slice(0, 3), A);
    assert.deepEqual(median, [0, 0, 0, 255], 'each channel is 0 in most of the cell, so the median is black, which the cell does not hold');
});

test('only the middle of a cell votes, so the blur from a neighbour does not', () => {
    const cell = createRaster(10, 10, [10, 20, 30, 255]);
    for (let y = 0; y < 10; y++) {
        setPixel(cell, 0, y, [250, 250, 250]);
        setPixel(cell, 9, y, [250, 250, 250]);
    }
    assert.deepEqual(getPixel(sampleGrid(cell, { cell: 10, offsetX: 0, offsetY: 0 }, 'median'), 0, 0), [10, 20, 30, 255]);
});

test('alpha is binary: a cell is opaque when at least half of its middle is visible, and fully so', () => {
    const picture = createRaster(20, 10, [90, 90, 90, 255]);
    for (let y = 0; y < 10; y++) {
        for (let x = 12; x < 18; x++) {
            setPixel(picture, x, y, [90, 90, 90, 100]);
        }
    }
    const native = sampleGrid(picture, { cell: 10, offsetX: 0, offsetY: 0 }, 'median');
    assert.equal(getPixel(native, 0, 0)[3], 255);
    assert.equal(getPixel(native, 1, 0)[3], 0, 'the faint half is transparent, not translucent');
    assert.throws(() => sampleGrid(picture, { cell: 10, offsetX: 0, offsetY: 0 }, 'centre'), /sample must be one of median, mode/);
});

test('reducing to k colours removes sampling noise and keeps a small distinct detail', () => {
    const base = createRaster(40, 10, [0, 0, 0, 0]);
    for (let y = 0; y < 10; y++) {
        for (let x = 0; x < 40; x++) {
            setPixel(base, x, y, x < 20 ? [200, 60, 60] : [60, 60, 200]);
        }
    }
    setPixel(base, 30, 5, [250, 240, 60]);
    const noisy = addNoise(base, 6);
    assert.ok(countColours(noisy) > 50);
    const { raster, colours } = reduceColours(noisy, 3);
    assert.equal(colours, 3);
    assert.equal(countColours(raster), 3);
    const [detail] = getPixel(raster, 30, 5);
    assert.ok(detail > 200, 'the yellow detail keeps a colour of its own');
    assert.equal(reduceColours(base, 8).colours, 3, 'a picture with fewer colours than asked for is left alone');
    assert.throws(() => reduceColours(base, 1), /2 or more/);
});

test('the error against the master is the mean colour difference of its solid pixels and their cells', () => {
    const picture = stretch(sprite, 4, 4);
    const exact = sampleGrid(picture, { cell: 4, offsetX: 0, offsetY: 0 }, 'median');
    assert.ok(reprojectionError(picture, exact, { cell: 4, offsetX: 0, offsetY: 0 }) < 0.5);
    const wrong = { ...exact, data: Buffer.from(exact.data) };
    for (let at = 0; at < wrong.data.length; at += 4) {
        wrong.data[at] = 255 - wrong.data[at];
    }
    assert.ok(reprojectionError(picture, wrong, { cell: 4, offsetX: 0, offsetY: 0 }) > 20);
});

/** A snapped figure from the sticker figure fixture: rim 6 pixels and white band 6 pixels in the master, so 2 and 2 art pixels at a cell of 3. */
const snappedFigure = () => snapRaster(figure(), { cell: 3 });

const distanceToClear = (raster) => {
    const { width, height, data } = raster;
    const depth = new Float64Array(width * height).fill(Infinity);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            if (data[(y * width + x) * 4 + 3] !== 0) {
                continue;
            }
            for (let dy = -3; dy <= 3; dy++) {
                for (let dx = -3; dx <= 3; dx++) {
                    const nx = x + dx;
                    const ny = y + dy;
                    if (nx >= 0 && ny >= 0 && nx < width && ny < height) {
                        depth[ny * width + nx] = Math.min(depth[ny * width + nx], Math.hypot(dx, dy));
                    }
                }
            }
        }
    }
    return depth;
};

test('the rim and the white band are rebuilt as exact, continuous rings of the master\'s width in art pixels', () => {
    const { raster, report } = snappedFigure();
    assert.equal(report.rings.rimWidth, 2);
    assert.equal(report.rings.bandWidth, 2);
    const depth = distanceToClear(raster);
    for (let at = 0; at < depth.length; at++) {
        const pixel = [...raster.data.subarray(at * 4, at * 4 + 3)];
        if (raster.data[at * 4 + 3] === 0) {
            continue;
        }
        if (depth[at] <= 2) {
            assert.deepEqual(pixel, RIM, `pixel ${at} at depth ${depth[at]} is in the rim`);
        } else if (depth[at] <= 4) {
            assert.deepEqual(pixel, BAND, `pixel ${at} at depth ${depth[at]} is in the white band`);
        }
    }
    assert.equal(report.rings.rimShape.isolated + report.rings.bandShape.isolated, 0);
    assert.ok(raster.data.every((value, at) => at % 4 !== 3 || value === 0 || value === 255), 'alpha is binary');
});

test('a ring the snap broke (a gap in the rim, a stray colour in the band) is repaired, and the repair is counted', () => {
    const { raster } = snappedFigure();
    const damaged = { ...raster, data: Buffer.from(raster.data) };
    const depth = distanceToClear(damaged);
    let rimGap;
    let bandSpeck;
    for (let at = 0; at < depth.length; at++) {
        if (damaged.data[at * 4 + 3] === 255 && depth[at] === 1 && rimGap === undefined && at > damaged.width * 60) {
            rimGap = at;
        }
        if (damaged.data[at * 4 + 3] === 255 && depth[at] === 3 && bandSpeck === undefined && at > damaged.width * 60) {
            bandSpeck = at;
        }
    }
    damaged.data.set([20, 20, 20, 255], rimGap * 4);
    damaged.data.set([200, 30, 30, 255], bandSpeck * 4);
    const repaired = repairRings(damaged, { rimWidth: 2, bandWidth: 2, rim: RIM, band: BAND });
    assert.deepEqual([...repaired.raster.data.subarray(rimGap * 4, rimGap * 4 + 4)], [...RIM, 255]);
    assert.deepEqual([...repaired.raster.data.subarray(bandSpeck * 4, bandSpeck * 4 + 4)], [...BAND, 255]);
    assert.deepEqual(repaired.raster.data, raster.data, 'the repaired picture is the one that was damaged');
    assert.equal(repaired.broken, 2);
});

test('snapping the same master with the same options twice gives the same bytes', () => {
    const first = snapRaster(figure(), { cell: 3 });
    const second = snapRaster(figure(), { cell: 3 });
    assert.ok(first.raster.data.equals(second.raster.data));
});

test('orphans are reported as pixelate.mjs reports them, and the snap does not remove them', () => {
    const { raster, report } = snappedFigure();
    assert.ok(Array.isArray(report.orphans));
    assert.equal(report.orphansExact >= report.orphans.length, true);
    assert.equal(opaqueBox(raster) !== undefined, true);
});

test('a master with no sticker to measure fails with the flags that avoid it, unless the rings are skipped', () => {
    const bare = createRaster(80, 80);
    for (let y = 20; y < 60; y++) {
        for (let x = 20; x < 60; x++) {
            setPixel(bare, x, y, COLOURS[(x + y) % 3]);
        }
    }
    assert.throws(() => snapRaster(bare, { cell: 4 }), /--rim-width and --band-width, or --no-ring-repair/);
    const { report } = snapRaster(bare, { cell: 4, ringRepair: false });
    assert.equal(report.rings, null);
    const manual = snapRaster(bare, { cell: 4, rimWidth: 1, bandWidth: 1 });
    assert.equal(manual.report.rings.rimWidth, 1);
});

test('a soft, noisy enlargement is snapped as well as a clean one, with a lower strength', () => {
    const clean = stretch(sprite, 3.4, 3.4);
    const messy = blur(addNoise(clean, 8));
    const cleanGrid = chooseGrid(clean);
    const messyGrid = chooseGrid(messy);
    assert.ok(same(messyGrid.cell, 3.4, 0.08), `cell ${messyGrid.cell}`);
    assert.ok(messyGrid.strengthAcross < cleanGrid.strengthAcross);
});

test('the rings come out at the widths asked for, whatever width the master\'s own rings have, and measureRings reads them off the result', () => {
    const colours = { rim: RIM, band: BAND };
    const widths = [];
    for (const sticker of [3, 6, 12]) {
        const master = figure({ sticker });
        const own = snapRaster(master, { cell: 3 }).report.rings;
        widths.push(own.rimWidth);
        const fixed = snapRaster(master, { cell: 3, rimWidth: 2, bandWidth: 2 });
        assert.deepEqual([fixed.report.rings.rimWidth, fixed.report.rings.bandWidth], [2, 2]);
        assert.deepEqual(measureRings(fixed.raster, colours), { rimWidth: 2, bandWidth: 2 }, `master rings ${sticker} px wide`);
        const wide = snapRaster(master, { cell: 3, rimWidth: 3, bandWidth: 1 });
        assert.deepEqual(measureRings(wide.raster, colours), { rimWidth: 3, bandWidth: 1 });
    }
    assert.ok(widths[0] < widths[2], `the masters' own widths differ (${widths.join(', ')}), so the equal result is the setting's doing`);
});

test('measureRings finds a gap in a ring as a thinner ring, and a picture with no rings as none', () => {
    const { raster } = snapRaster(figure(), { cell: 3, rimWidth: 2, bandWidth: 2 });
    assert.deepEqual(measureRings(raster, { rim: RIM, band: BAND }), { rimWidth: 2, bandWidth: 2 });
    const opaque = opaqueBox(raster);
    const broken = { ...raster, data: Buffer.from(raster.data) };
    setPixel(broken, opaque.x, opaque.y + Math.floor(opaque.height / 2), [10, 10, 10, 255]);
    const edge = [opaque.x, opaque.y + Math.floor(opaque.height / 2)];
    assert.deepEqual(getPixel(broken, ...edge).slice(0, 3), [10, 10, 10]);
    assert.ok(measureRings(broken, { rim: RIM, band: BAND }).rimWidth < 2, 'one wrong pixel on the outer edge leaves no whole rim');
    assert.deepEqual(measureRings(sprite, { rim: RIM, band: BAND }), { rimWidth: 0, bandWidth: 0 });
});
