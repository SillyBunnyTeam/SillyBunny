import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { PLATE_LETTERING_BASELINE, emblemLetteringCentre, opticalCentreY, wordmarkBaseline, wordmarkCapCentre } from '../scripts/lib/github-align.mjs';
import { detectPlateGrid, fitMoon, findPlateShift, loadBackdrop, snapBackdrop } from '../scripts/lib/github-backdrop.mjs';
import { backdropName, comparePlates, loadBackdropConfig, resolvePlate, snapPlate } from '../scripts/lib/github-backdrop-run.mjs';
import { buildLayout, placeBox } from '../scripts/lib/github-build.mjs';
import { contrastRatio, parseHex } from '../scripts/lib/github-colour.mjs';
import { ICON_GRID, MIN_BLOCK_UNIT, MIN_ICON_UNIT, parseGithubConfig } from '../scripts/lib/github-config.mjs';
import { loadGithubConfig } from '../scripts/lib/github-run.mjs';
import { framePicture, iconPicture, steppedPanel } from '../scripts/lib/github-shapes.mjs';
import { paintEdge } from '../scripts/lib/github-edge.mjs';
import { README_WIDTH, buildSheets, readmeImage } from '../scripts/lib/github-sheets.mjs';
import { SUBTITLE_TEXT, subtitleSize, subtitleXHeight } from '../scripts/lib/github-subtitle.mjs';
import { drawTitle, titleCapCentre } from '../scripts/lib/github-text.mjs';
import { drawEmblem, drawPlate, drawWordmark, wordmarkSize } from '../scripts/lib/github-vector.mjs';
import { createRaster, writeRaster } from '../scripts/lib/raster.mjs';
import { getPixel, nativeSprite, setPixel } from '../test-support/synthetic.mjs';
import { tempDir } from '../test-support/temp-dir.mjs';

const REAL_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SLOW = { timeout: 180_000 };
const SPRITE_COLOURS = [[200, 40, 50], [40, 60, 200], [230, 210, 90], [60, 160, 90], [250, 250, 250]];
const PLATE = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" rx="24" fill="#f5e9ff"/></svg>';
const EMBLEM = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200"><rect x="60" y="40" width="80" height="120" fill="#8b64aa"/></svg>';
const REAL_EMBLEM = readFileSync(join(REAL_ROOT, 'approved/logo-emblem.svg'), 'utf8');

const COLOURS = {
    lavender: '#b99bf2', logo: '#8b64aa', plum: '#5b3c6b', ink: '#24152f', pale: '#f5e9ff', night: '#1c1228',
    cream: '#fff1dc', green: '#4fa35a', gold: '#f3c969', faint: '#d9d0e0',
};
const ICONS = {
    palettes: { light: { o: 'plum', l: 'lavender', c: 'cream' }, washed: { o: 'faint', l: 'lavender', c: 'cream' } },
    shapes: {
        leaf: { accent: 'green', rows: ['................', '.oooooooooooooo.', ...Array.from({ length: 12 }, () => '.oaaaalllccccco.'), '.oooooooooooooo.', '................'] },
    },
};
const ORNAMENTS = {
    moon: { rows: ['..ooo..', '.oyyyo.', 'oyyoo..', 'oyyo...', 'oyyoo..', '.oyyyo.', '..ooo..'], colours: { o: 'plum', y: 'gold' } },
    leaf: { rows: ['.g.g.g.', '..ggg..', '..ggg..', '..ggg..', '...g...', '...g...', '...g...'], colours: { g: 'green' } },
};
const FRAME_LAYERS = [{ colour: 'plum', cells: 1 }, { colour: 'lavender', cells: 1 }, { colour: 'pale', cells: 1 }];
const FRAME = { type: 'frame', unit: 8, layers: FRAME_LAYERS, boss: { cells: 13, notch: 3, outside: 'night', ornaments: ['moon', 'leaf', 'leaf', 'moon'] } };
const BAR = { type: 'bar', unit: 8, widthCells: 30, heightCells: 12, layers: [{ colour: 'plum', inset: 0, notch: 2 }, { colour: 'lavender', inset: 1, notch: 1 }, { colour: 'pale', inset: 2, notch: 0 }], at: { left: 56, top: 112 } };

const sprite = () => nativeSprite(20, 24, SPRITE_COLOURS, { seed: 5, margin: 3 });

/** A plate of flat colour columns, as wide as it is tall's worth of art pixels, opaque. */
function plateOf(columns, rows, colourAt) {
    const plate = createRaster(columns, rows);
    for (let y = 0; y < rows; y++) {
        for (let x = 0; x < columns; x++) {
            plate.data.set([...colourAt(x, y), 255], (y * columns + x) * 4);
        }
    }
    return plate;
}

const PALE_PLATE = () => plateOf(240, 160, () => [235, 225, 250]);

function configOf({ background = 'pale', width = 480, height = 320, elements, backdrops = { day: 'd.png' } }) {
    return {
        colours: COLOURS,
        icons: ICONS,
        ornaments: ORNAMENTS,
        sources: { plate: 'p.svg', emblem: 'e.svg', art: { day: 'd.png' }, backdrops },
        assets: { avatar: { width, height, maxBytes: 1000000 }, social: { width: 1280, height: 640, maxBytes: 1000000 }, banner: { width: 2560, height: 800, maxBytes: 1000000 } },
        final: {},
        layouts: [{ id: 'test', asset: 'avatar', background, width, height, elements }],
    };
}

const layoutOf = (options) => parseGithubConfig(configOf(options)).layouts[0];
const contextOf = ({ picture = sprite(), plate = PALE_PLATE(), emblemSvg = EMBLEM } = {}) => {
    const config = parseGithubConfig(configOf({ elements: [{ type: 'plate', size: 10, at: { left: 0, top: 0 } }] }));
    return { colours: COLOURS, icons: config.icons, ornaments: config.ornaments, sources: { plateSvg: PLATE, emblemSvg, art: { day: picture }, backdrops: { day: plate }, placeholders: [] } };
};
const hexOf = (colour) => Object.values(parseHex(colour));
const pixelOf = (raster, x, y) => [...getPixel(raster, x, y)];
const BACKDROP = { type: 'backdrop', source: 'day', step: 2, at: { left: 0, top: 0 } };

test('a frame is bands of layers on all four edges and a boss on each corner with a stepped corner and an ornament, and nothing inside', () => {
    const colour = (name) => COLOURS[name];
    const ornament = (name) => ({ rows: ORNAMENTS[name].rows, colours: Object.fromEntries(Object.entries(ORNAMENTS[name].colours).map(([symbol, key]) => [symbol, colour(key)])) });
    const { picture, boxes } = framePicture({
        widthCells: 40,
        heightCells: 30,
        unit: 8,
        layers: FRAME_LAYERS.map((layer) => ({ colour: colour(layer.colour), cells: layer.cells })),
        boss: { cells: 13, notch: 3, outside: colour('night'), ornaments: [ornament('moon'), ornament('leaf'), ornament('leaf'), ornament('moon')] },
    });
    assert.deepEqual([picture.width, picture.height], [320, 240]);
    assert.equal(boxes.length, 8, 'four bands and four bosses');
    assert.deepEqual(pixelOf(picture, 160, 3), [...hexOf(COLOURS.plum), 255], 'the outermost line of the top band');
    assert.deepEqual(pixelOf(picture, 160, 11), [...hexOf(COLOURS.lavender), 255], 'the line inside it');
    assert.deepEqual(pixelOf(picture, 160, 19), [...hexOf(COLOURS.pale), 255], 'and the inner highlight');
    assert.equal(getPixel(picture, 160, 24)[3], 0, 'the inside of the frame is left transparent');
    assert.equal(getPixel(picture, 160, 120)[3], 0);
    assert.deepEqual(pixelOf(picture, 3, 3), [...hexOf(COLOURS.night), 255], 'the corner of a boss is stepped away and shows the outside colour');
    assert.deepEqual(pixelOf(picture, 3 + 8 * 3, 3), [...hexOf(COLOURS.plum), 255], 'past the step the boss has the outer line of the layers');
    // The ornament lies in the 7x7 blocks inside the three layers of the boss: the moon's outline is its top row's middle blocks.
    assert.deepEqual(pixelOf(picture, (3 + 2) * 8 + 2, 3 * 8 + 2), [...hexOf(COLOURS.plum), 255]);
    assert.deepEqual(pixelOf(picture, 320 - 13 * 8 + (3 + 3) * 8 + 2, 3 * 8 + 2), [...hexOf(COLOURS.green), 255], 'the top right corner has its own ornament, not a mirror of the first');
    assert.throws(() => framePicture({ widthCells: 40, heightCells: 30, unit: 8, layers: FRAME_LAYERS.map((layer) => ({ colour: colour(layer.colour), cells: layer.cells })), boss: { cells: 6, notch: 1, outside: '#000000', ornaments: [] } }), /no room inside layers/);
});

test('a bar is a stepped panel, and an icon is its grid of symbols at a whole number of pixels each', () => {
    const bar = steppedPanel({ widthCells: 12, heightCells: 8, unit: 8, layers: [{ colour: '#5b3c6b', inset: 0, notch: 3 }, { colour: '#b99bf2', inset: 1, notch: 2 }, { colour: '#f8f1ff', inset: 2, notch: 1 }] });
    assert.deepEqual([bar.width, bar.height], [96, 64]);
    assert.equal(getPixel(bar, 2, 2)[3], 0, 'the corner cell is cut away');
    assert.deepEqual(pixelOf(bar, 48, 4), [...hexOf('#5b3c6b'), 255]);
    assert.deepEqual(pixelOf(bar, 48, 28), [...hexOf('#f8f1ff'), 255]);
    const icon = iconPicture({ rows: ['.o', 'lc'], colours: { o: '#5b3c6b', l: '#b99bf2', c: '#fff1dc' }, unit: 4 });
    assert.deepEqual([icon.width, icon.height], [8, 8]);
    assert.equal(getPixel(icon, 1, 1)[3], 0);
    assert.deepEqual(pixelOf(icon, 5, 2), [...hexOf('#5b3c6b'), 255]);
    assert.deepEqual(pixelOf(icon, 7, 7), [...hexOf('#fff1dc'), 255]);
});

test('the parser refuses a frame, a backdrop or an icon that is wrong, and names the rule', () => {
    assert.doesNotThrow(() => layoutOf({ elements: [BACKDROP, FRAME] }));
    assert.throws(() => layoutOf({ elements: [{ ...FRAME, unit: 6 }] }), /element 0\.unit is 6; decoration is built of blocks of 8 pixels or more/);
    assert.throws(() => layoutOf({ elements: [{ ...FRAME, boss: { ...FRAME.boss, ornaments: ['moon', 'leaf'] } }] }), /must name four ornaments/);
    assert.throws(() => layoutOf({ elements: [{ ...FRAME, boss: { ...FRAME.boss, ornaments: ['moon', 'leaf', 'leaf', 'sun'] } }] }), /"sun", which is not an ornament/);
    assert.throws(() => layoutOf({ elements: [{ ...FRAME, boss: { ...FRAME.boss, cells: 11 } }] }), /"moon" is 7 blocks across, but the space inside the boss is 5/);
    assert.throws(() => layoutOf({ elements: [{ ...FRAME, layers: [FRAME_LAYERS[0]] }] }), /at least two layers/);
    assert.throws(() => layoutOf({ elements: [{ ...BACKDROP, source: 'night' }] }), /"night" is not one of the backdrops: day/);
    assert.throws(() => layoutOf({ elements: [{ ...BACKDROP, step: 0 }] }), /step must be a whole number of 1 or more/);
    assert.throws(() => layoutOf({ elements: [{ ...BACKDROP, mirror: 'yes' }] }), /mirror must be true or false/);
    const icon = { type: 'icon', icon: 'leaf', palette: 'light', unit: MIN_ICON_UNIT, at: { left: 0, top: 0 } };
    assert.doesNotThrow(() => layoutOf({ elements: [icon] }));
    assert.throws(() => layoutOf({ elements: [{ ...icon, icon: 'rose' }] }), /"rose" is not an icon/);
    assert.throws(() => layoutOf({ elements: [{ ...icon, unit: 3 }] }), /unit must be a whole number of 4 or more/);
    const shape = ICONS.shapes.leaf;
    const withShape = (changed) => parseGithubConfig({ ...configOf({ elements: [icon] }), icons: { ...ICONS, shapes: { leaf: changed } } });
    assert.throws(() => withShape({ ...shape, rows: shape.rows.slice(1) }), new RegExp(`${ICON_GRID.min} to ${ICON_GRID.max} rows`));
    assert.throws(() => withShape({ ...shape, rows: shape.rows.map((row) => row.replace('l', 'x')) }), /uses the symbol "x"/);
    assert.throws(() => withShape({ rows: shape.rows }), /accent colour exactly when its grid uses the accent symbol/);
    const withOrnament = (changed) => parseGithubConfig({ ...configOf({ elements: [BACKDROP] }), ornaments: { moon: changed } });
    assert.throws(() => withOrnament({ rows: ['ab', 'c'], colours: {} }), /square grid/);
    assert.throws(() => withOrnament({ rows: ['a.', '.b'], colours: { a: 'plum' } }), /no colour for the symbol "b"/);
    assert.equal(MIN_BLOCK_UNIT, 8);
});

/** A grid of `rows` rows and `columns` columns of empty cells with an accent cell in the first, for a shape that has an accent colour. */
const gridOf = (rows, columns, { accent = true } = {}) => Array.from({ length: rows }, (_, y) => (y === 0 && accent ? 'a' : '.').padEnd(columns, '.'));

test('an icon grid is 16 to 20 rows of 16 to 20 symbols, each row as long as the others, made of the known symbols, with an accent colour exactly when it uses the accent', () => {
    const icon = { type: 'icon', icon: 'leaf', palette: 'light', unit: MIN_ICON_UNIT, at: { left: 0, top: 0 } };
    const withShape = (changed) => parseGithubConfig({ ...configOf({ elements: [icon] }), icons: { ...ICONS, shapes: { leaf: changed } } });
    const gridMessage = /icons\.shapes\.leaf\.rows must be 16 to 20 rows of the same length, 16 to 20 symbols wide/;
    for (const [rows, columns] of [[16, 16], [20, 20], [16, 20], [20, 16]]) {
        assert.doesNotThrow(() => withShape({ accent: 'green', rows: gridOf(rows, columns) }), `${rows}x${columns} fits`);
    }
    for (const [rows, columns] of [[15, 16], [21, 16], [16, 15], [16, 21], [1, 1]]) {
        assert.throws(() => withShape({ accent: 'green', rows: gridOf(rows, columns) }), gridMessage, `${rows}x${columns} does not fit`);
    }
    const ragged = gridOf(16, 16);
    ragged[5] = ragged[5].slice(1);
    assert.throws(() => withShape({ accent: 'green', rows: ragged }), gridMessage, 'a row that is shorter than the first');
    assert.throws(() => withShape({ accent: 'green', rows: [...gridOf(16, 16).slice(1), 7] }), gridMessage, 'a row that is not text');
    assert.throws(() => withShape({ accent: 'green', rows: 'a'.repeat(16) }), gridMessage, 'rows that are not a list');
    assert.throws(() => withShape({ accent: 'green' }), gridMessage, 'no rows');

    const stray = gridOf(16, 16);
    stray[7] = stray[7].replace('.', 'x');
    assert.throws(() => withShape({ accent: 'green', rows: stray }), /icons\.shapes\.leaf\.rows uses the symbol "x"; the symbols are \. o l c a/);
    assert.throws(() => withShape({ accent: 'green', rows: gridOf(16, 16, { accent: false }) }), /needs an accent colour exactly when its grid uses the accent symbol "a"/, 'an accent colour that nothing uses');
    assert.throws(() => withShape({ rows: gridOf(16, 16) }), /needs an accent colour exactly when its grid uses the accent symbol "a"/, 'an accent symbol with no colour');
    assert.doesNotThrow(() => withShape({ rows: gridOf(16, 16, { accent: false }) }), 'no accent, no accent colour');
    assert.throws(() => withShape({ accent: 'teal', rows: gridOf(16, 16) }), /icons\.shapes\.leaf\.accent "teal" is not one of the colours/);
    assert.throws(() => withShape({ accent: 'green', rows: gridOf(16, 16), extra: 1 }), /icons\.shapes\.leaf has an unknown key "extra"/);
    const withPalette = (palette) => parseGithubConfig({ ...configOf({ elements: [icon] }), icons: { ...ICONS, palettes: { light: palette } } });
    assert.throws(() => withPalette({ o: 'plum', l: 'lavender' }), /icons\.palettes\.light\.c "undefined" is not one of the colours/);
    assert.throws(() => withPalette({ o: 'plum', l: 'lavender', c: 'cream', a: 'gold' }), /icons\.palettes\.light has an unknown key "a"/);
});

test('an ornament is a square grid of symbols that each have a colour of the palette, and the space inside a frame boss is as wide as the ornament and takes four of them', () => {
    const withOrnament = (changed) => parseGithubConfig({ ...configOf({ elements: [BACKDROP] }), ornaments: { moon: changed } });
    const squareMessage = /ornaments\.moon\.rows must be a square grid of symbols: as many rows as each row is long/;
    assert.doesNotThrow(() => withOrnament({ rows: ['a.', '.a'], colours: { a: 'plum' } }));
    assert.doesNotThrow(() => withOrnament({ rows: ['a'], colours: { a: 'plum' } }));
    for (const rows of [['ab', 'c'], ['abc', 'abc'], ['ab', 'ab', 'ab'], [], 'ab', ['ab', 1]]) {
        assert.throws(() => withOrnament({ rows, colours: { a: 'plum', b: 'plum', c: 'plum' } }), squareMessage, JSON.stringify(rows));
    }
    assert.throws(() => withOrnament({ rows: ['a.', '.b'], colours: { a: 'plum', b: 'teal' } }), /ornaments\.moon\.colours\.b "teal" is not one of the colours/);
    assert.throws(() => withOrnament({ rows: ['a.', '.a'], colours: { a: 'plum' }, extra: 1 }), /ornaments\.moon has an unknown key "extra"/);

    const withBoss = (boss, layers = FRAME_LAYERS) => layoutOf({ elements: [{ ...FRAME, layers, boss: { ...FRAME.boss, ...boss } }] });
    assert.doesNotThrow(() => withBoss({}));
    assert.doesNotThrow(() => withBoss({ cells: 15 }, [...FRAME_LAYERS, { colour: 'night', cells: 1 }]), 'a fourth layer takes two more blocks off the inside, and the boss is two blocks wider');
    assert.throws(() => withBoss({ cells: 15 }), /"moon" is 7 blocks across, but the space inside the boss is 9/, 'a wider boss leaves more room than the ornament fills');
    assert.throws(() => withBoss({ cells: 11 }), /"moon" is 7 blocks across, but the space inside the boss is 5/);
    assert.throws(() => withBoss({}, [...FRAME_LAYERS, { colour: 'night', cells: 1 }]), /"moon" is 7 blocks across, but the space inside the boss is 5/, 'the layers count, not just the boss');
    for (const ornaments of [[], ['moon', 'leaf', 'leaf'], ['moon', 'leaf', 'leaf', 'moon', 'leaf'], 'moon', undefined]) {
        assert.throws(() => withBoss({ ornaments }), /boss\.ornaments must name four ornaments: top left, top right, bottom left, bottom right/, JSON.stringify(ornaments));
    }
    assert.throws(() => withBoss({ cells: 2 }), /boss\.cells must be a whole number of 3 or more/);
    assert.throws(() => withBoss({ notch: -1 }), /boss\.notch must be a whole number of 0 or more/);
    assert.throws(() => withBoss({ outside: 'teal' }), /boss\.outside "teal" is not one of the colours/);
});

test('sparkles are a list of stars, each a whole position and an arm of at least one block, and a moon has a diameter of 3 blocks or more and a bite of at least one', () => {
    const sparkles = { type: 'sparkles', colour: 'gold', unit: 8, points: [{ x: 10, y: 12, arm: 2 }] };
    assert.doesNotThrow(() => layoutOf({ elements: [sparkles] }));
    for (const points of [[], undefined, 'star', { x: 1, y: 1, arm: 1 }]) {
        assert.throws(() => layoutOf({ elements: [{ ...sparkles, points }] }), /element 0\.points must be a list of stars/, JSON.stringify(points));
    }
    const star = (changed) => layoutOf({ elements: [{ ...sparkles, points: [{ x: 10, y: 12, arm: 2 }, { x: 10, y: 12, arm: 2, ...changed }] }] });
    assert.doesNotThrow(() => star({ arm: 1 }), 'an arm of one block is the least');
    assert.throws(() => star({ arm: 0 }), /element 0\.points\[1\]\.arm must be a whole number of 1 or more, got 0/);
    assert.throws(() => star({ arm: 1.5 }), /points\[1\]\.arm must be a whole number of 1 or more/);
    assert.throws(() => star({ x: -1 }), /points\[1\]\.x must be a whole number of 0 or more/);
    assert.throws(() => star({ y: 2.5 }), /points\[1\]\.y must be a whole number of 0 or more/);
    assert.throws(() => star({ size: 3 }), /points\[1\] has an unknown key "size"/);
    assert.throws(() => layoutOf({ elements: [{ ...sparkles, unit: 0 }] }), /element 0\.unit must be a whole number of 1 or more/);
    assert.throws(() => layoutOf({ elements: [{ ...sparkles, colour: 'teal' }] }), /element 0\.colour "teal" is not one of the colours/);

    const moon = { type: 'moon', colour: 'gold', unit: 8, diameter: 9, bite: 3, lift: 1, at: { left: 0, top: 0 } };
    assert.doesNotThrow(() => layoutOf({ elements: [moon] }));
    assert.doesNotThrow(() => layoutOf({ elements: [{ ...moon, bite: 1, diameter: 3 }] }), 'the least moon');
    assert.doesNotThrow(() => layoutOf({ elements: [{ ...moon, lift: -2 }] }), 'a moon may be lifted down');
    const { lift, ...noLift } = moon;
    assert.ok(lift === 1 && layoutOf({ elements: [noLift] }), 'and lift may be left out');
    assert.throws(() => layoutOf({ elements: [{ ...moon, bite: 0 }] }), /element 0\.bite must be a whole number of 1 or more, got 0/);
    assert.throws(() => layoutOf({ elements: [{ ...moon, bite: 2.5 }] }), /element 0\.bite must be a whole number of 1 or more/);
    assert.throws(() => layoutOf({ elements: [noLift].map(({ bite, ...rest }) => rest) }), /element 0\.bite must be a whole number of 1 or more, got undefined/, 'bite is not optional');
    assert.throws(() => layoutOf({ elements: [{ ...moon, diameter: 2 }] }), /element 0\.diameter must be a whole number of 3 or more, got 2/);
    assert.throws(() => layoutOf({ elements: [{ ...moon, lift: 0.5 }] }), /element 0\.lift must be a whole number/);
    assert.throws(() => layoutOf({ elements: [{ ...moon, colour: 'teal' }] }), /element 0\.colour "teal" is not one of the colours/);
});

test('a line is pinned by its optical line: the middle of the capitals of a text, of the lettering of the emblem, else of the box', () => {
    const canvas = { width: 400, height: 300 };
    assert.deepEqual(placeBox({ left: 10, lineY: 100 }, { width: 50, height: 40 }, canvas, 12.4), { x: 10, y: 88 });
    assert.deepEqual(placeBox({ left: 10, lineY: 100 }, { width: 50, height: 40 }, canvas), { x: 10, y: 80 }, 'the middle of the box when no line is given');
    assert.equal(placeBox({ left: 0, centerY: 100 }, { width: 5, height: 40 }, canvas, 3).y, 80, 'a centre is still the middle of the box');
    assert.equal(opticalCentreY({ type: 'plate' }, { width: 10, height: 30 }), 15);
});

test('the capital line of the wordmark and of a title is where the letters really are, measured on what is drawn', async () => {
    const SIZE = 140;
    const wordmark = await drawWordmark({ size: SIZE, colour: '#000000' });
    // The first letter, the S, ends well before the next one starts; its ink is the capital height with an even overshoot above and below.
    const rowsOf = (picture, untilColumn) => {
        const rows = [];
        for (let y = 0; y < picture.height; y++) {
            for (let x = 0; x < untilColumn; x++) {
                if (getPixel(picture, x, y)[3] > 127) {
                    rows.push(y);
                    break;
                }
            }
        }
        return rows;
    };
    const wordmarkRows = rowsOf(wordmark, Math.floor(wordmark.width * 0.1));
    assert.ok(Math.abs((wordmarkRows[0] + wordmarkRows.at(-1) + 1) / 2 - wordmarkCapCentre(SIZE)) <= 1, `the S is centred on ${wordmarkCapCentre(SIZE)}`);
    const title = await drawTitle({ title: 'credits', size: 112, colour: '#000000' });
    const titleRows = rowsOf(title, Math.floor(title.width * 0.18));
    assert.ok(Math.abs((titleRows[0] + titleRows.at(-1) + 1) / 2 - titleCapCentre('credits', { size: 112 })) <= 1, 'the C of the title is centred on its capital line');
    assert.equal(wordmarkSize(SIZE).height, wordmark.height);
});

test('the lettering of the emblem is found as the holes the outside cannot reach, and an emblem without any is refused', async () => {
    const emblem = await drawEmblem(REAL_EMBLEM, { height: 400 });
    const centre = emblemLetteringCentre(emblem);
    assert.ok(centre / emblem.height > 0.8 && centre / emblem.height < 0.92, `the SB is in the badge at the bottom of the emblem, at ${(centre / emblem.height).toFixed(3)} of its height`);
    const solid = await drawEmblem(EMBLEM, { height: 100 });
    assert.throws(() => emblemLetteringCentre(solid), /no enclosed lettering/);
    const ringed = createRaster(20, 20);
    for (let y = 4; y < 16; y++) {
        for (let x = 4; x < 16; x++) {
            setPixel(ringed, x, y, [0, 0, 0, 255]);
        }
    }
    for (let y = 8; y < 11; y++) {
        for (let x = 8; x < 12; x++) {
            setPixel(ringed, x, y, [0, 0, 0, 0]);
        }
    }
    assert.equal(emblemLetteringCentre(ringed), 9.5, 'a hole of rows 8 to 10 has its middle at 9.5');
});

/** The layouts that carry the logo plate, the wordmark and the subtitle: the main banner and the social preview. */
const LOCKUPS = ['banner-main-light', 'banner-main-dark', 'social-grove'];

/** Where the plaque, the logo plate, the wordmark, the separator and the subtitle of a lockup layout are, from the config and the drawn sizes alone. */
async function lockupBoxes(layout) {
    const canvas = { width: layout.width, height: layout.height };
    const [plaque, separator] = layout.elements.filter(({ type }) => type === 'bar');
    const plate = layout.elements.find(({ type }) => type === 'plate');
    const wordmark = layout.elements.find(({ type }) => type === 'wordmark');
    const subtitle = layout.elements.find(({ type }) => type === 'subtitle');
    const size = (element, picture) => ({ ...placeBox(element.at, picture, canvas, 'lineY' in element.at ? opticalCentreY(element, picture) : undefined), width: picture.width, height: picture.height });
    const barSize = (bar) => ({ width: bar.widthCells * bar.unit, height: bar.heightCells * bar.unit });
    return {
        plaque: size(plaque, barSize(plaque)),
        separator: size(separator, barSize(separator)),
        plate: size(plate, { width: plate.size, height: plate.size }),
        wordmark: size(wordmark, wordmarkSize(wordmark.size)),
        subtitle: size(subtitle, subtitleSize(subtitle.lines, { size: subtitle.size })),
        elements: { plaque, separator, plate, wordmark, subtitle },
    };
}

const baselineOfWordmark = ({ wordmark, elements }) => wordmark.y + wordmarkBaseline(elements.wordmark.size);

test('the SB of the logo plate has its baseline where the constant says, measured on the drawing of the SVG, and the wordmark has its baseline where the constant says', async () => {
    const svg = readFileSync(join(REAL_ROOT, 'approved/logo-plate.svg'), 'utf8');
    const plate = await drawPlate(svg, { size: 1024 });
    const holeColour = [0xf5, 0xe9, 0xff];
    // The B is a hole in the body of the emblem, so the plate shows through it. Its foot is the lowest row of that colour along the stem.
    let foot = 0;
    for (let x = 526; x <= 545; x++) {
        for (let y = 700; y < 900; y++) {
            if (getPixel(plate, x, y).slice(0, 3).every((channel, at) => channel === holeColour[at])) {
                foot = Math.max(foot, y + 1);
            }
        }
    }
    assert.ok(Math.abs(foot - PLATE_LETTERING_BASELINE * 1024) <= 1.5, `the foot of the B is at ${foot} of 1024 and the constant says ${(PLATE_LETTERING_BASELINE * 1024).toFixed(1)}`);

    const wordmark = await drawWordmark({ size: 140, colour: '#000000' });
    const lowestInkOfColumn = Array.from({ length: wordmark.width }, (_, x) => {
        for (let y = wordmark.height - 1; y >= 0; y--) {
            if (getPixel(wordmark, x, y)[3] > 127) {
                return y + 1;
            }
        }
        return 0;
    });
    const counts = new Map();
    for (const bottom of lowestInkOfColumn.filter((bottom) => bottom > 0)) {
        counts.set(bottom, (counts.get(bottom) ?? 0) + 1);
    }
    const [baseline] = [...counts].sort((one, two) => two[1] - one[1])[0];
    assert.ok(Math.abs(baseline - wordmarkBaseline(140)) <= 1, `most letters of the wordmark end at ${baseline} and the baseline is ${wordmarkBaseline(140).toFixed(1)}`);
    assert.equal(opticalCentreY({ type: 'wordmark', size: 140, line: 'baseline' }, wordmark), wordmarkBaseline(140));
    assert.equal(opticalCentreY({ type: 'wordmark', size: 140 }, wordmark), wordmarkCapCentre(140), 'the cap centre when no line is named');
});

test('the wordmark stands on the baseline of the SB in the logo plate, to a pixel', async () => {
    const config = loadGithubConfig(REAL_ROOT);
    for (const id of LOCKUPS) {
        const boxes = await lockupBoxes(config.layouts.find((candidate) => candidate.id === id));
        const target = boxes.plate.y + PLATE_LETTERING_BASELINE * boxes.plate.height;
        assert.equal(boxes.elements.wordmark.line, 'baseline', id);
        assert.ok(Math.abs(baselineOfWordmark(boxes) - target) <= 1, `${id}: the wordmark's baseline is at ${baselineOfWordmark(boxes).toFixed(1)}, the target line at ${target.toFixed(1)}`);
        assert.ok(boxes.plate.x + boxes.plate.width < boxes.wordmark.x, `${id}: the plate is left of the wordmark`);
    }
});

test('the plate, the wordmark, the separator and the subtitle are centred in a plaque that is sized to them, and the gaps above and below the separator are equal', async () => {
    const config = loadGithubConfig(REAL_ROOT);
    for (const id of LOCKUPS) {
        const layout = config.layouts.find((candidate) => candidate.id === id);
        const { plaque, separator, plate, wordmark, subtitle, elements } = await lockupBoxes(layout);
        const unit = elements.plaque.unit;
        const parts = [plate, wordmark, separator, subtitle];
        const left = Math.min(plate.x - unit, ...parts.map((box) => box.x));
        const right = Math.max(...parts.map((box) => box.x + box.width));
        const top = Math.min(plate.y - unit, ...parts.map((box) => box.y));
        const bottom = Math.max(...parts.map((box) => box.y + box.height));
        assert.ok(Math.abs((left - plaque.x) - (plaque.x + plaque.width - right)) <= 2 * unit, `${id}: the same room left and right`);
        assert.ok(Math.abs((top - plaque.y) - (plaque.y + plaque.height - bottom)) <= 2, `${id}: the same room above and below`);
        assert.ok(left - plaque.x >= 40 && top - plaque.y >= 28, `${id}: room enough inside the edge of the plaque`);
        const rowBottom = Math.max(plate.y + plate.height + unit, wordmark.y + wordmark.height);
        const above = separator.y - rowBottom;
        const below = subtitle.y - (separator.y + separator.height);
        assert.ok(above >= 8 && Math.abs(above - below) <= 1, `${id}: ${above} px above the separator and ${below} px below`);
        assert.ok(Math.abs(plaque.x + plaque.width / 2 - (subtitle.x + subtitle.width / 2)) <= 2, `${id}: the subtitle is centred in the plaque`);
        assert.ok(Math.abs(plaque.x + plaque.width / 2 - (separator.x + separator.width / 2)) <= 2, `${id}: and so is the separator`);
        const row = (wordmark.x + wordmark.width) - (plate.x - unit);
        assert.ok(Math.abs(separator.width - row) <= 2 * unit, `${id}: the separator is as wide as the row of the plate and the wordmark (${separator.width} against ${row})`);
    }
});

test('the separator is drawn like the edge of the plaque: the same blocks and its first two layers, with a small gold stud at each end', () => {
    const config = loadGithubConfig(REAL_ROOT);
    for (const id of LOCKUPS) {
        const layout = config.layouts.find((candidate) => candidate.id === id);
        const [plaque, separator] = layout.elements.filter(({ type }) => type === 'bar');
        assert.equal(separator.unit, plaque.unit, `${id}: blocks of one size (${plaque.unit})`);
        assert.equal(separator.heightCells, 3, `${id}: three blocks thick, one for each ring of its two layers and the stud between them`);
        assert.deepEqual(separator.layers.map(({ colour }) => colour), plaque.layers.slice(0, 2).map(({ colour }) => colour), `${id}: the colours of the edge of the plaque`);
        assert.deepEqual({ ...separator.studs }, { colour: 'gold', cells: 1, inset: 1 }, `${id}: a stud at each end`);
        assert.equal(layout.elements.indexOf(plaque) < layout.elements.indexOf(separator), true, `${id}: the plaque is under it`);
    }
    assert.equal(config.layouts.find(({ id }) => id === 'banner-main-light').elements.filter(({ type }) => type === 'bar')[1].unit, 8);
    assert.equal(config.layouts.find(({ id }) => id === 'social-grove').elements.filter(({ type }) => type === 'bar')[1].unit, 4, 'half the size on the social preview');
});

test('the logo plate has a keyline where its edge would vanish into the plaque, and none where it reads', () => {
    const config = loadGithubConfig(REAL_ROOT);
    const svg = readFileSync(join(REAL_ROOT, 'approved/logo-plate.svg'), 'utf8');
    const [edgeColour] = /<use href="#o" fill="(#[0-9a-f]{6})"\/>/.exec(svg).slice(1);
    for (const id of LOCKUPS) {
        const layout = config.layouts.find((candidate) => candidate.id === id);
        const plate = layout.elements.find(({ type }) => type === 'plate');
        const plaque = layout.elements.find(({ type }) => type === 'bar');
        const fill = config.colours[plaque.layers.at(-1).colour];
        const ratio = contrastRatio(edgeColour, fill);
        if (ratio >= 3) {
            assert.equal('edge' in plate, false, `${id}: the plate's edge is ${ratio.toFixed(2)}:1 on the fill, so it needs no keyline`);
            continue;
        }
        assert.equal(plate.edge.outline.colour, 'plum', `${id}: the plate's edge is ${ratio.toFixed(2)}:1 on the fill, so it has a plum keyline`);
        assert.equal(plate.edge.outline.width, plaque.unit, `${id}: of one block`);
        assert.ok(contrastRatio(config.colours.plum, fill) >= 3, `${id}: and the keyline reads on the fill`);
    }
    assert.ok(contrastRatio(edgeColour, config.colours.cream) < 3 && contrastRatio(edgeColour, config.colours.night) >= 3, 'the light plaque needs the keyline and the dark one does not');
    assert.equal('edge' in config.layouts.find(({ id }) => id === 'banner-main-dark').elements.find(({ type }) => type === 'plate'), false);
    assert.equal('edge' in config.layouts.find(({ id }) => id === 'social-grove').elements.find(({ type }) => type === 'plate'), true);
});

test('a plate drawn on cells of 3.2 by 4.0 is found with its grid, and a snap takes the colour of the cell under each art pixel', () => {
    const cellsAcross = 120;
    const colourOfCell = (cellX, cellY) => [(cellX * 37 + cellY * 11) % 256, (cellX * 53 + cellY * 29) % 256, (cellX * 7 + cellY * 71) % 256];
    const master = plateOf(Math.round(cellsAcross * 3.2), 400, () => [0, 0, 0]);
    for (let y = 0; y < master.height; y++) {
        for (let x = 0; x < master.width; x++) {
            master.data.set([...colourOfCell(Math.floor(x / 3.2), Math.floor(y / 4)), 255], (y * master.width + x) * 4);
        }
    }
    const grid = detectPlateGrid(master, { x: 0, y: 0, width: master.width, height: master.height }, { across: [2.9, 3.5], down: [3.7, 4.3] });
    assert.ok(Math.abs(grid.across.cell - 3.2) < 0.02 && Math.abs(grid.down.cell - 4) < 0.02, `found ${grid.across.cell} by ${grid.down.cell}`);
    for (const cell of [3.2, 2.4, 1.2]) {
        const columns = Math.floor((master.width - 4) / cell);
        const snapped = snapBackdrop(master, grid, { cell, x: 0, y: 0, columns, rows: Math.floor(300 / cell) });
        assert.deepEqual([snapped.width, snapped.height], [columns, Math.floor(300 / cell)]);
        // The snap averages the middle half of a cell, which on a plate drawn in whole pixels can take in one pixel of a neighbour, so only
        // cells whose middle half is wholly their own are probed. The detected grid offset is found to half a pixel (0.5 here for a plate
        // drawn at 0), which is 0.16 of a cell, so art pixels within a quarter of a cell of an edge are left out.
        const awayFromEdge = (value) => Math.abs(value - Math.round(value)) > 0.25;
        const middleIsOwn = (cellX) => {
            const first = Math.floor(cellX * 3.2 + 0.8);
            const last = Math.ceil(cellX * 3.2 + 2.4) - 1;
            return Math.floor(first / 3.2) === cellX && Math.floor(last / 3.2) === cellX;
        };
        const probes = Array.from({ length: columns * snapped.height }, (_, at) => [at % columns, Math.floor(at / columns)])
            .filter(([column, row]) => awayFromEdge((column + 0.5) * cell / 3.2) && awayFromEdge((row + 0.5) * cell / 4))
            .filter(([column]) => middleIsOwn(Math.floor((column + 0.5) * cell / 3.2)))
            .filter((_, at) => at % 97 === 0);
        assert.ok(probes.length > 20, 'there are art pixels well inside a plate cell to check');
        for (const [column, row] of probes) {
            const wantX = Math.floor((column + 0.5) * cell / 3.2);
            const wantY = Math.floor((row + 0.5) * cell / 4);
            assert.deepEqual(pixelOf(snapped, column, row), [...colourOfCell(wantX, wantY), 255], `cell ${cell}: art pixel ${column},${row} is the plate cell ${wantX},${wantY}`);
        }
    }
    assert.throws(() => snapBackdrop(master, grid, { cell: 3.2, x: 0, y: 0, columns: 1000, rows: 10 }), /is not inside the/);
    assert.throws(() => snapBackdrop(master, grid, { cell: 3.2, x: 0, y: 0, columns: 1.5, rows: 10 }), /whole number of columns and rows/);
    for (const [x, y] of [[undefined, 0], [0, undefined], [Number.NaN, 0], ['3', 0], [0, null]]) {
        assert.throws(() => snapBackdrop(master, grid, { cell: 3.2, x, y, columns: 10, rows: 10 }), /needs the master pixel where it starts, as numbers x and y/, `x ${x}, y ${y}: not an all-black plate`);
    }
});

test('a backdrop must be opaque, because it is the ground of the banner', async () => {
    const dir = tempDir('sb-github-backdrop-');
    await writeRaster(join(dir, 'ok.png'), PALE_PLATE());
    const loaded = await loadBackdrop(join(dir, 'ok.png'));
    assert.deepEqual([loaded.width, loaded.height], [240, 160]);
    const holed = PALE_PLATE();
    setPixel(holed, 3, 3, [0, 0, 0, 0]);
    await writeRaster(join(dir, 'holed.png'), holed);
    await assert.rejects(loadBackdrop(join(dir, 'holed.png')), /must be opaque/);
});

test('the moon is fitted as the circle of its rim, and an edited plate is found to be where it was or shifted by the number of pixels it moved', () => {
    const scene = (moonX, moonY, shift = [0, 0], recolour = 0) => plateOf(400, 300, (x, y) => {
        const sx = x - shift[0];
        const sy = y - shift[1];
        const inMoon = Math.hypot(sx - moonX, sy - moonY) <= 40;
        const stripe = (Math.floor(sx / 17) + Math.floor(sy / 23)) % 2 === 0;
        const base = inMoon ? [240, 235, 200] : stripe ? [120, 110, 180] : [90, 85, 150];
        return base.map((channel) => Math.max(0, channel - recolour));
    });
    const moon = fitMoon(scene(200, 150), { x: 190, y: 140, width: 21, height: 21 }, { min: 35, max: 45 });
    assert.ok(Math.abs(moon.x - 200) <= 1 && Math.abs(moon.y - 150) <= 1 && Math.abs(moon.radius - 40) <= 1, `moon at ${moon.x},${moon.y} r ${moon.radius}`);

    const day = scene(200, 150);
    const box = { x: 40, y: 40, width: 300, height: 200 };
    const same = findPlateShift(day, scene(200, 150, [0, 0], 60), box, { maxShift: 5 });
    assert.deepEqual([same.dx, same.dy], [0, 0]);
    assert.ok(same.overlapAtZero > 0.9, `edges coincide where nothing moved (${same.overlapAtZero})`);
    const moved = findPlateShift(day, scene(200, 150, [3, -2], 60), box, { maxShift: 5 });
    assert.deepEqual([moved.dx, moved.dy], [3, -2]);
    assert.ok(moved.overlapAtZero < moved.overlap);

    const compared = comparePlates(day, scene(200, 150, [0, 0], 60), { boxes: { middle: box }, moonCentres: { x: 190, y: 140, width: 21, height: 21 }, moonRadii: { min: 35, max: 45 } });
    assert.deepEqual(compared.regions.map(({ name, dx, dy }) => [name, dx, dy]), [['middle', 0, 0]]);
    assert.ok(Math.abs(compared.moon.dx) <= 1 && Math.abs(compared.moon.dy) <= 1 && Math.abs(compared.moon.dradius) <= 1, `the moon of an edit is where it was (shift ${compared.moon.dx},${compared.moon.dy})`);
});

test('the day and the night plate of the mansion have the same crops, and a plate that is an edit of the other snaps to them with a grid of its own', SLOW, async () => {
    const config = loadBackdropConfig(REAL_ROOT);
    assert.deepEqual(Object.keys(config.plates), ['mansion-day', 'mansion-night']);
    assert.equal(config.plates['mansion-night'].like, 'mansion-day', 'the night plate is an edit of the day plate and takes its crops');
    const { detect, variants } = resolvePlate(config, 'mansion-night');
    assert.deepEqual(detect, config.plates['mansion-day'].detect);
    assert.deepEqual(variants, config.plates['mansion-day'].variants);
    assert.deepEqual(Object.keys(variants), ['banner', 'social']);
    const canvases = { banner: [2560, 800], social: [1280, 640] };
    for (const [name, variant] of Object.entries(variants)) {
        const [width, height] = canvases[name];
        assert.ok(variant.at.left <= 0 && variant.at.top <= 0, `${name} starts at or before the canvas corner`);
        assert.ok(variant.at.left + variant.columns * variant.step >= width && variant.at.top + variant.rows * variant.step >= height, `${name} covers the whole canvas`);
        assert.equal(variant.bleed === true, variant.at.left < 0 || variant.at.top < 0 || variant.at.left + variant.columns * variant.step > width || variant.at.top + variant.rows * variant.step > height, `${name} bleeds exactly when it runs past the canvas`);
        assert.ok(variant.x + variant.columns * variant.cell <= 1536 + 1e-6 && variant.y + variant.rows * variant.cell <= 1024 + 1e-6, `${name} is inside the 1536x1024 plate`);
        assert.ok(Math.abs(variant.step / variant.cell - width / 1536) < 0.3, `${name} scales the plate to about the width of the canvas`);
    }
    const { compare } = config.plates['mansion-night'];
    assert.equal(compare.against, 'mansion-day');
    assert.ok(Object.keys(compare.boxes).length >= 6, 'the edit is compared in every part of the plate');
    const rootDir = tempDir('sb-github-plates-');
    const cells = (offset) => plateOf(1536, 1024, (x, y) => {
        const cellX = Math.floor(x / 3.2);
        const cellY = Math.floor((y - 0.5) / 4);
        return [(cellX * 37 + cellY * 11 + offset) % 256, (cellX * 53 + cellY * 29) % 256, (cellX * 7 + cellY * 71) % 256];
    });
    mkdirSync(join(rootDir, 'raw'), { recursive: true });
    await writeRaster(join(rootDir, 'raw/day.png'), cells(0));
    const result = await snapPlate({ rootDir, plate: 'mansion-day', config: { plates: { 'mansion-day': { ...config.plates['mansion-day'], master: 'raw/day.png' } } } });
    assert.ok(Math.abs(result.grid.across.cell - 3.2) < 0.02 && Math.abs(result.grid.down.cell - 4) < 0.02);
    assert.deepEqual(result.variants.map(({ variant, file, columns, rows }) => [variant, file, columns, rows]), [
        ['banner', `out/github/snapped/${backdropName('mansion-day', 'banner')}.png`, 427, 134],
        ['social', `out/github/snapped/${backdropName('mansion-day', 'social')}.png`, 427, 214],
    ]);
    const written = await loadBackdrop(join(rootDir, result.variants[0].file));
    assert.deepEqual([written.width, written.height], [427, 134]);
    assert.equal(existsSync(join(rootDir, 'log')), false);
});

test('the contrast of text is read against the pixels it lies on: a picture that is too close in tone is refused, a surface of its own is not', async () => {
    const title = { type: 'title', title: 'credits', size: 24, colour: 'plum', at: { left: 120, top: 100 } };
    const darkPlate = plateOf(240, 160, (x) => (x < 80 ? [235, 225, 250] : [90, 60, 107]));
    await assert.doesNotReject(buildLayout(layoutOf({ elements: [BACKDROP, title] }), contextOf()), 'plum text on a pale picture');
    await assert.rejects(buildLayout(layoutOf({ elements: [BACKDROP, title] }), contextOf({ plate: darkPlate })), /the title in plum has a contrast under 4.5 against \d+\.\d% of the pixels it lies on \(the worst is 1.00 at/);
    const bar = { ...BAR, at: { left: 30, top: 90 }, heightCells: 14 };
    const onTheFill = { ...title, at: { left: 120, top: 130 } };
    await assert.doesNotReject(buildLayout(layoutOf({ elements: [BACKDROP, bar, onTheFill] }), contextOf({ plate: darkPlate })), 'a bar of its own pale colour under the text is what is measured');

    // The plate pixels under the first ink pixels of the text, a few of them and then a good many.
    const ink = await drawTitle({ title: 'credits', size: 24, colour: '#5b3c6b' });
    const inkAt = [];
    for (let y = 0; y < ink.height; y++) {
        for (let x = 0; x < ink.width; x++) {
            if (getPixel(ink, x, y)[3] >= 128) {
                inkAt.push([x, y]);
            }
        }
    }
    const darkenUnder = (count) => {
        const plate = PALE_PLATE();
        for (const [x, y] of inkAt.slice(0, count)) {
            plate.data.set([90, 60, 107, 255], (Math.floor((100 + y) / 2) * plate.width + Math.floor((120 + x) / 2)) * 4);
        }
        return plate;
    };
    await assert.doesNotReject(buildLayout(layoutOf({ elements: [BACKDROP, title] }), contextOf({ plate: darkenUnder(2) })), 'a few dark pixels under the text are let through');
    await assert.rejects(buildLayout(layoutOf({ elements: [BACKDROP, title] }), contextOf({ plate: darkenUnder(Math.ceil(inkAt.length * 0.15)) })), /contrast under 4.5/);
    const icon = { type: 'icon', icon: 'leaf', palette: 'light', unit: 4, at: { left: 40, top: 100 } };
    await assert.rejects(buildLayout(layoutOf({ elements: [BACKDROP, icon] }), contextOf({ plate: plateOf(240, 160, () => [90, 60, 107]) })), /the outline of the leaf icon has a contrast under 3/);
    await assert.rejects(buildLayout(layoutOf({ elements: [BACKDROP, { type: 'emblem', height: 40, at: { left: 40, top: 100 } }] }), contextOf({ plate: plateOf(240, 160, () => [139, 100, 170]) })), /the emblem has a contrast under 3/);
});

test('nothing but the backdrop may touch the frame, and the frame is painted last', async () => {
    const art = { type: 'art', source: 'day', step: 4, at: { left: 120, top: 40 } };
    const inside = await buildLayout(layoutOf({ elements: [BACKDROP, art, FRAME] }), contextOf());
    assert.deepEqual(inside.placements.map(({ type }) => type), ['backdrop', 'art', 'frame']);
    const crossing = { ...art, at: { left: 120, top: 4 } };
    await assert.rejects(buildLayout(layoutOf({ elements: [BACKDROP, crossing, FRAME] }), contextOf()), /the (frame and the art|art and the frame) overlap/);
    await assert.rejects(buildLayout(layoutOf({ elements: [BACKDROP, { ...BAR, at: { left: 2, top: 112 } }, FRAME] }), contextOf()), /overlap/);
    await assert.rejects(buildLayout(layoutOf({ elements: [BACKDROP, { type: 'wordmark', size: 20, colour: 'plum', at: { left: 0, top: 0 } }, FRAME] }), contextOf()), /overlap/);
    await assert.rejects(buildLayout(layoutOf({ width: 482, height: 322, elements: [FRAME] }), contextOf()), /blocks of 8 pixels, which do not divide the 482x322 canvas/);
    const { raster } = inside;
    assert.deepEqual(pixelOf(raster, 240, 3), [...hexOf(COLOURS.plum), 255], 'the frame band lies over the backdrop');
    assert.deepEqual(pixelOf(raster, 240, 200).slice(0, 3), [235, 225, 250], 'and the inside is the backdrop');
});

test('a backdrop is whole blocks of its step, may be mirrored, and may run past the canvas only where it says so', async () => {
    const stripes = plateOf(240, 160, (x) => (x < 120 ? [200, 30, 30] : [30, 30, 200]));
    const plain = await buildLayout(layoutOf({ elements: [BACKDROP] }), contextOf({ plate: stripes }));
    assert.deepEqual(pixelOf(plain.raster, 4, 4).slice(0, 3), [200, 30, 30]);
    assert.deepEqual(pixelOf(plain.raster, 476, 4).slice(0, 3), [30, 30, 200]);
    const mirrored = await buildLayout(layoutOf({ elements: [{ ...BACKDROP, mirror: true }] }), contextOf({ plate: stripes }));
    assert.deepEqual(pixelOf(mirrored.raster, 4, 4).slice(0, 3), [30, 30, 200], 'the mirrored plate has its right side on the left');
    assert.deepEqual(pixelOf(mirrored.raster, 476, 4).slice(0, 3), [200, 30, 30]);
    const wide = plateOf(165, 110, () => [235, 225, 250]);
    const bigger = { ...BACKDROP, step: 3, at: { left: -5, top: -3 } };
    await assert.rejects(buildLayout(layoutOf({ elements: [bigger] }), contextOf({ plate: wide })), /leaves the 480x320 canvas/);
    const { placements } = await buildLayout(layoutOf({ elements: [{ ...bigger, bleed: true }] }), contextOf({ plate: wide }));
    assert.deepEqual([placements[0].x, placements[0].y, placements[0].width, placements[0].height, placements[0].step], [-5, -3, 495, 330, 3]);
});

test('a backdrop must cover the canvas, so that no strip of the bare background shows: a step that is too small, a crop that starts late or ends early is refused', async () => {
    const plate = plateOf(240, 160, () => [235, 225, 250]);
    const covering = { ...BACKDROP, step: 2, at: { left: 0, top: 0 } };
    const { placements } = await buildLayout(layoutOf({ elements: [covering] }), contextOf({ plate }));
    assert.deepEqual([placements[0].width, placements[0].height], [480, 320], 'a plate that is exactly the canvas covers it');
    const refused = /the backdrop at -?\d+,-?\d+ \(\d+x\d+\) does not cover the 480x320 canvas, so a strip of the bare background would show/;
    for (const element of [
        { ...covering, step: 1 },
        { ...covering, step: 2, at: { left: 1, top: 0 }, bleed: true },
        { ...covering, step: 2, at: { left: 0, top: 1 }, bleed: true },
        { ...covering, step: 2, at: { left: -1, top: -1 }, bleed: true },
        { ...covering, step: 2, at: { left: -2, top: -2 }, bleed: true, mirror: true },
    ]) {
        const covers = element.at.left <= 0 && element.at.top <= 0 && element.at.left + 240 * element.step >= 480 && element.at.top + 160 * element.step >= 320;
        if (covers) {
            await assert.doesNotReject(buildLayout(layoutOf({ elements: [element] }), contextOf({ plate })), JSON.stringify(element));
            continue;
        }
        await assert.rejects(buildLayout(layoutOf({ elements: [element] }), contextOf({ plate })), refused, JSON.stringify(element));
    }
    await assert.rejects(buildLayout(layoutOf({ elements: [{ ...covering, step: 3, at: { left: -1, top: 5 }, bleed: true }] }), contextOf({ plate: plateOf(165, 110, () => [235, 225, 250]) })), refused, 'a step that covers across but not down');
    await assert.doesNotReject(buildLayout(layoutOf({ elements: [{ ...BAR, at: { left: 56, top: 112 } }] }), contextOf({ plate })), 'a bar is a surface too, but it is not a ground and need not cover the canvas');
});

test('the same layout is the same bytes every time', async () => {
    const elements = [BACKDROP, BAR, { type: 'icon', icon: 'leaf', palette: 'light', unit: 4, at: { left: 130, lineY: 160 } }, { type: 'art', source: 'day', step: 4, at: { left: 260, top: 40 } }, FRAME];
    const first = await buildLayout(layoutOf({ elements }), contextOf());
    const second = await buildLayout(layoutOf({ elements }), contextOf());
    assert.equal(Buffer.compare(first.png, second.png), 0);
});

const realLayouts = () => loadGithubConfig(REAL_ROOT).layouts;
const SECTION_ORDER = ['main', 'features', 'install', 'contributing', 'credits', 'community'];

test('every grove banner is 2560x800 in a frame, the plate first and the frame last, on the plate of its theme, with the pair mirrored to the side its plate is mirrored to', () => {
    const backdrops = loadBackdropConfig(REAL_ROOT);
    const plateOfTheme = { light: 'mansion-day', dark: 'mansion-night' };
    for (const layout of realLayouts().filter(({ asset }) => asset === 'banner')) {
        const [, section, theme] = layout.id.split('-');
        assert.equal([layout.width, layout.height].join('x'), '2560x800');
        const types = layout.elements.map(({ type }) => type);
        assert.equal(types[0], 'backdrop');
        assert.equal(types.at(-1), 'frame', `${layout.id}: the frame is the last element`);
        const [backdrop] = layout.elements;
        const { banner } = resolvePlate(backdrops, plateOfTheme[theme]).variants;
        assert.equal(backdrop.source, backdropName(plateOfTheme[theme], 'banner'), `${layout.id}: the plate of its theme`);
        assert.equal(backdrop.step, banner.step);
        assert.deepEqual({ ...backdrop.at }, banner.at);
        const art = layout.elements.find(({ type }) => type === 'art');
        assert.equal(art.step, 2, `${layout.id}: the pair keeps its step`);
        assert.equal(art.source, `banner-${section}`);
        const onTheLeft = 'left' in art.at;
        assert.equal(backdrop.mirror === true, onTheLeft, `${layout.id}: the plate is mirrored exactly when the pair is on the left`);
        assert.ok(SECTION_ORDER.includes(section));
    }
});

test('a section plaque is drawn like the frame: the same blocks and the same three layers, with the title and its icon inside and the icon of its own section', () => {
    const sections = realLayouts().filter(({ id }) => /^banner-(?!main)/.test(id));
    assert.equal(sections.length, 10);
    for (const layout of sections) {
        const frame = layout.elements.at(-1);
        const plaque = layout.elements.find(({ type }) => type === 'bar');
        assert.equal(plaque.unit, frame.unit, `${layout.id}: blocks of one size`);
        frame.layers.forEach((edge, at) => assert.equal(plaque.layers[at].colour, edge.colour, `${layout.id}: layer ${at} of the plaque is the frame's`));
        assert.ok(plaque.layers.length > frame.layers.length, `${layout.id}: and a fill inside the edge`);
        assert.ok(plaque.studs && plaque.studs.cells >= 1, `${layout.id}: a stud in each corner`);
        const icon = layout.elements.find(({ type }) => type === 'icon');
        const title = layout.elements.find(({ type }) => type === 'title');
        assert.equal(icon.icon, title.title, `${layout.id}: the icon of the section`);
        assert.equal(icon.palette, layout.id.endsWith('-light') ? 'light' : 'dark');
        assert.ok(plaque.unit >= MIN_BLOCK_UNIT && icon.unit >= MIN_ICON_UNIT);
    }
});

test('the logo plate and the wordmark are in a plaque drawn like the others, with no outline on the text, and no emblem of its own', () => {
    const config = loadGithubConfig(REAL_ROOT);
    for (const id of LOCKUPS) {
        const layout = config.layouts.find((candidate) => candidate.id === id);
        const frame = layout.elements.at(-1);
        const plaque = layout.elements.find(({ type }) => type === 'bar');
        assert.equal(plaque.unit, frame.unit, `${id}: blocks of one size`);
        frame.layers.forEach((edge, at) => assert.equal(plaque.layers[at].colour, edge.colour, `${id}: layer ${at} of the plaque is the frame's`));
        for (const element of layout.elements.filter(({ type }) => ['wordmark', 'subtitle'].includes(type))) {
            assert.equal('edge' in element, false, `${id}: the plaque is the surface, so the ${element.type} has no outline`);
        }
        assert.equal(layout.elements.some(({ type }) => type === 'emblem'), false, `${id}: the plate holds the emblem`);
        const wordmark = layout.elements.find(({ type }) => type === 'wordmark');
        assert.equal(wordmark.colour, id.includes('dark') ? 'pale' : 'plum');
        assert.equal(layout.elements.indexOf(plaque) < layout.elements.indexOf(wordmark), true, `${id}: the plaque is under the logo`);
    }
});

test('the social preview is the grove style at 1280x640: the day plate at step 3, the Welcome scene at step 2 on the right filling the frame, a frame at half the size of the banners', () => {
    for (const id of ['social-grove']) {
        const layout = realLayouts().find((candidate) => candidate.id === id);
        assert.deepEqual([layout.width, layout.height], [1280, 640]);
        const [backdrop] = layout.elements;
        assert.deepEqual([backdrop.source, backdrop.step], [backdropName('mansion-day', 'social'), 3]);
        const art = layout.elements.find(({ type }) => type === 'art');
        assert.deepEqual([art.source, art.step, 'right' in art.at, 'shadow' in art], ['social-welcome', 2, true, true]);
        const frame = layout.elements.at(-1);
        assert.deepEqual([frame.type, frame.unit], ['frame', 4]);
    }
});

test('every banner has the pair at step 2 with a contact shadow, and the social preview too', () => {
    for (const layout of realLayouts().filter(({ asset }) => asset !== 'avatar')) {
        const art = layout.elements.find(({ type }) => type === 'art');
        assert.ok(art.shadow && art.shadow.tint === 'plum' && art.shadow.bands >= 2, layout.id);
        assert.equal(art.step, 2, layout.id);
    }
});

test('the sheets are the avatars, the README page of each theme with a banner for each section in config order, and each social preview at full size and at the width of a link card', SLOW, async () => {
    const pngOf = (width, height, [r, g, b]) => sharp({ create: { width, height, channels: 3, background: { r, g, b } } }).png().toBuffer();
    const entry = async (id, asset, width, height, colour) => [id, { layout: { id, asset, note: `note of ${id}`, width, height }, png: await pngOf(width, height, colour), placeholders: [] }];
    const built = new Map([await entry('avatar-fill', 'avatar', 500, 500, [185, 155, 242])]);
    // Each section has its own colour, and the dark page's banners differ from the light page's, so the order and the theme can be read off the sheets.
    const colourOf = (section, theme) => [20 + 30 * SECTION_ORDER.indexOf(section), theme === 'light' ? 200 : 100, 90];
    for (const theme of ['light', 'dark']) {
        for (const section of SECTION_ORDER) {
            built.set(...await entry(`banner-${section}-${theme}`, 'banner', 2560, 800, colourOf(section, theme)));
        }
    }
    built.set(...await entry('social-grove', 'social', 1280, 640, [10, 20, 30]));
    const sheets = await buildSheets(built);
    assert.deepEqual([...sheets.keys()].sort(), ['avatars.png', 'readme-dark.png', 'readme-light.png', 'social-grove-400.png', 'social-grove-full.png']);
    const light = await sharp(sheets.get('readme-light.png')).metadata();
    assert.equal(light.width, README_WIDTH + 80);
    const sections = SECTION_ORDER.length;
    assert.equal(light.height, sections * 275 + (sections - 1) * 40 + 80, 'one banner of 880x275 for each section, with a gap between them and a margin round them');
    const sample = async (name, x, y) => [...await sharp(sheets.get(name)).extract({ left: x, top: y, width: 1, height: 1 }).raw().toBuffer()].slice(0, 3);
    assert.deepEqual(await sample('readme-dark.png', 2, 2), hexOf('#0d1117'), 'the dark page is the dark page of GitHub');
    assert.deepEqual(await sample('readme-light.png', 2, 2), hexOf('#ffffff'), 'and the light page is white');
    for (const theme of ['light', 'dark']) {
        for (const [at, section] of SECTION_ORDER.entries()) {
            assert.deepEqual(await sample(`readme-${theme}.png`, 440, 40 + at * (275 + 40) + 137), colourOf(section, theme), `${theme} page, banner ${at + 1}: ${section}`);
        }
    }
    const card = await sharp(sheets.get('social-grove-400.png')).metadata();
    assert.deepEqual([card.width, card.height], [400, 200]);
    assert.deepEqual([(await sharp(sheets.get('social-grove-full.png')).metadata()).width], [1280]);
});

test('the shadow sheet shows the feet of each scene twice at 2x, with the contacts outlined by kind and as painted, and is left out when no layout has contacts', SLOW, async () => {
    const pngOf = (width, height, [r, g, b]) => sharp({ create: { width, height, channels: 3, background: { r, g, b } } }).png().toBuffer();
    const avatar = ['avatar-fill', { layout: { id: 'avatar-fill', asset: 'avatar', note: 'avatar', width: 500, height: 500 }, png: await pngOf(500, 500, [185, 155, 242]), placeholders: [] }];
    const banner = async (placements) => ['banner-main-light', { layout: { id: 'banner-main-light', asset: 'banner', note: 'main', width: 2560, height: 800 }, png: await pngOf(2560, 800, [200, 190, 230]), placements, placeholders: [] }];
    assert.equal((await buildSheets(new Map([avatar, await banner([{ type: 'art', x: 1700, y: 28, width: 692, height: 724, step: 2 }])]))).has('shadows.png'), false, 'a layout whose art has no contacts has nothing to show');
    const contacts = [{ kind: 'contact', x0: 100, x1: 119, y: 300 }, { kind: 'footprint', x0: 10, x1: 200, y: 280 }, { kind: 'raised', x0: 250, x1: 270, y: 300 }];
    const sheet = (await buildSheets(new Map([avatar, await banner([{ type: 'art', x: 1700, y: 28, width: 692, height: 724, step: 2, contacts }])]))).get('shadows.png');
    const { width, height } = await sharp(sheet).metadata();
    const tile = { width: (692 + 2 * 120) * 2, height: (200 + 24 + 24) * 2 };
    assert.ok(width >= 2 * tile.width + 3 * 24 && height >= tile.height + 78, `two tiles of ${tile.width}x${tile.height} side by side with a label above (${width}x${height})`);
    const sample = async (x, y) => [...await sharp(sheet).extract({ left: x, top: y, width: 1, height: 1 }).raw().toBuffer()].slice(0, 3);
    const tileTop = 24 + 30 + 24;
    // The contact: columns 100-119 of the art at step 2, 2x zoom, from 120 pixels left of the art; its outline is 6 rows high above row 301.
    const edge = { x: (1700 + 100 * 2 - (1700 - 120)) * 2, y: (28 + 301 * 2 - (28 + 724 - 200)) * 2 - 12 };
    assert.deepEqual(await sample(24 + edge.x - 1, tileTop + edge.y), [255, 47, 208], 'a contact is outlined in magenta on the left tile');
    assert.deepEqual(await sample(24 + tile.width + 24 + edge.x - 1, tileTop + edge.y), [200, 190, 230], 'and the right tile is as painted');
    const raisedEdge = { x: (1700 + 250 * 2 - (1700 - 120)) * 2, y: edge.y };
    assert.deepEqual(await sample(24 + raisedEdge.x - 1, tileTop + raisedEdge.y), [255, 230, 0], 'a raised part in yellow');
    const footprintEdge = { x: (1700 + 10 * 2 - (1700 - 120)) * 2, y: (28 + 281 * 2 - (28 + 724 - 200)) * 2 - 12 };
    assert.deepEqual(await sample(24 + footprintEdge.x - 1, tileTop + footprintEdge.y), [0, 200, 255], 'and a footprint in cyan');
});

test('an outline is the ink grown by whole pixels, and a shadow is bands that are fainter the further they are from it, cast by the outline and the ink together', () => {
    const ink = createRaster(20, 12);
    for (let y = 4; y < 8; y++) {
        for (let x = 6; x < 14; x++) {
            setPixel(ink, x, y, [10, 10, 10, 255]);
        }
    }
    const { picture, reach, ring } = paintEdge(ink, {
        outline: { colour: '#ffffff', width: 2 },
        shadow: { colour: '#000000', alpha: 0.6, offset: { x: 0, y: 3 }, step: 2, steps: 3 },
    });
    assert.equal(reach, 2 + 3 * 2 + 3);
    assert.deepEqual([picture.width, picture.height], [20 + 2 * reach, 12 + 2 * reach]);
    const at = (x, y) => pixelOf(picture, x + reach, y + reach);
    assert.deepEqual(at(7, 5), [10, 10, 10, 255], 'the ink is as it was');
    assert.deepEqual(at(5, 5), [255, 255, 255, 255], 'one pixel out is the outline');
    assert.deepEqual(at(4, 5), [255, 255, 255, 255], 'two pixels out is the outline');
    assert.equal(getPixel(picture, 3 + reach, 5 + reach)[3] > 0 && getPixel(picture, 3 + reach, 5 + reach)[3] < 255, true, 'then the first band of the shadow, partly clear');
    const bands = [3, 5, 7].map((distance) => getPixel(picture, 6 - distance + reach, 5 + reach)[3]);
    assert.ok(bands[0] > bands[1] && bands[1] > bands[2] && bands[2] > 0, `each band is fainter than the one inside it: ${bands}`);
    assert.equal(getPixel(picture, 6 - 9 + reach, 5 + reach)[3], 0, 'past the last band nothing');
    assert.equal(ring[(5 + reach) * picture.width + 5 + reach], 1, 'the ring is the outline outside the ink');
    assert.equal(ring[(5 + reach) * picture.width + 7 + reach], 0);
    const none = paintEdge(ink, { outline: { colour: '#ffffff', width: 1 } });
    assert.equal(none.reach, 1, 'an outline alone reaches as far as it is wide');
});

test('an outlined text is read against its outline, not against the picture under it, and the outline is measured and reported against that picture', async () => {
    const dark = plateOf(240, 160, () => [90, 60, 107]);
    const title = { type: 'wordmark', size: 40, colour: 'plum', at: { left: 40, top: 100 } };
    const outline = { outline: { colour: 'pale', width: 4 } };
    await assert.rejects(buildLayout(layoutOf({ elements: [BACKDROP, title] }), contextOf({ plate: dark })), /the wordmark in plum has a contrast under 4.5 against/);
    const { placements } = await buildLayout(layoutOf({ elements: [BACKDROP, { ...title, edge: outline }] }), contextOf({ plate: dark }));
    const { contrast } = placements.find(({ type }) => type === 'wordmark');
    assert.ok(contrast.ink.lowShare > 0.9, 'plum on this plate is far under 4.5, and that is reported');
    assert.ok(contrast.outline.pixels > 100 && contrast.outline.median > 5, `the pale outline is measured on the dark plate (median ${contrast.outline.median})`);
    await assert.rejects(buildLayout(layoutOf({ elements: [BACKDROP, { ...title, edge: { outline: { colour: 'lavender', width: 4 } } }] }), contextOf()), /the wordmark in plum has a contrast of \d\.\d+ with its outline in lavender, under 4.5/);
    await assert.rejects(buildLayout(layoutOf({ elements: [BACKDROP, { type: 'emblem', height: 40, edge: { outline: { colour: 'logo', width: 3 } }, at: { left: 40, top: 100 } }] }), contextOf()), /the emblem has a contrast of 1.00 with its outline in logo, under 3/);
});

test('a bar may have a stud in each corner, drawn over its layers', () => {
    const bar = steppedPanel({ widthCells: 20, heightCells: 10, unit: 8, layers: [{ colour: '#5b3c6b', inset: 0, notch: 2 }, { colour: '#fff1dc', inset: 1, notch: 0 }], studs: { colour: '#f3c969', cells: 2, inset: 3 } });
    const stud = [...hexOf('#f3c969'), 255];
    assert.deepEqual(pixelOf(bar, 3 * 8 + 1, 3 * 8 + 1), stud, 'top left');
    assert.deepEqual(pixelOf(bar, (20 - 3 - 2) * 8 + 1, 3 * 8 + 1), stud, 'top right');
    assert.deepEqual(pixelOf(bar, 3 * 8 + 1, (10 - 3 - 2) * 8 + 1), stud, 'bottom left');
    assert.deepEqual(pixelOf(bar, (20 - 3 - 2) * 8 + 8 + 7, (10 - 3 - 2) * 8 + 8 + 7), stud, 'bottom right, to its last pixel');
    assert.deepEqual(pixelOf(bar, 10 * 8, 5 * 8), [...hexOf('#fff1dc'), 255], 'the fill between them is untouched');
});

test('the README image is 880 wide and keeps the banner\'s shape', async () => {
    const banner = createRaster(2560, 800, [245, 233, 255, 255]);
    const png = await sharp(banner.data, { raw: { width: 2560, height: 800, channels: 4 } }).png().toBuffer();
    const meta = await sharp(await readmeImage(png)).metadata();
    assert.deepEqual([meta.width, meta.height], [880, 275]);
});

const WITH_SUBTITLE = LOCKUPS;
const LINE_BREAKS = ['A SillyTavern fork with a Bun runtime,', 'detailed human interface guidelines,', 'and modernised features!'];
const MIN_X_HEIGHT_ON_SCREEN = 7;

test('the main banner and the social preview carry the maintainer\'s subtitle in three lines, set in the config, inside the logo plaque', async () => {
    const config = loadGithubConfig(REAL_ROOT);
    for (const layout of config.layouts) {
        const subtitle = layout.elements.find(({ type }) => type === 'subtitle');
        assert.equal(Boolean(subtitle), WITH_SUBTITLE.includes(layout.id), `${layout.id}: has a subtitle exactly where it is asked for`);
        if (!subtitle) {
            continue;
        }
        assert.deepEqual([...subtitle.lines], LINE_BREAKS, `${layout.id}: the breaks are the phrase breaks`);
        assert.equal(subtitle.lines.join(' '), SUBTITLE_TEXT);
        const { plaque, plate, separator, wordmark, subtitle: box } = await lockupBoxes(layout);
        assert.ok(box.x >= plaque.x + 40 && box.x + box.width <= plaque.x + plaque.width - 40, `${layout.id}: room either side of the subtitle inside the plaque`);
        assert.ok(box.y + box.height <= plaque.y + plaque.height - 28 && box.y > separator.y + separator.height && box.y > plate.y + plate.height && box.y > wordmark.y + wordmark.height, `${layout.id}: under the logo and the separator, with room below`);
        assert.equal(layout.elements.findIndex(({ type }) => type === 'bar') < layout.elements.indexOf(subtitle), true, `${layout.id}: the plaque is under the subtitle`);
    }
});

test('the subtitle is lighter than the wordmark, a step softer in colour, and still passes 4.5:1 on the fill of its plaque', () => {
    const config = loadGithubConfig(REAL_ROOT);
    for (const id of WITH_SUBTITLE) {
        const layout = config.layouts.find((candidate) => candidate.id === id);
        const subtitle = layout.elements.find(({ type }) => type === 'subtitle');
        const wordmark = layout.elements.find(({ type }) => type === 'wordmark');
        const fill = layout.elements.find(({ type }) => type === 'bar').layers.at(-1).colour;
        const against = (name) => contrastRatio(config.colours[name], config.colours[fill]);
        assert.ok(against(subtitle.colour) >= 4.5, `${id}: ${subtitle.colour} on ${fill} is ${against(subtitle.colour).toFixed(2)}`);
        assert.ok(against(subtitle.colour) < against(wordmark.colour), `${id}: a step softer than the wordmark's ${wordmark.colour}`);
    }
});

test('the subtitle is large enough to read where the images are shown small: 7 px of x-height on screen at 880 wide, and at 600 wide for the social preview', () => {
    const config = loadGithubConfig(REAL_ROOT);
    for (const id of WITH_SUBTITLE) {
        const layout = config.layouts.find((candidate) => candidate.id === id);
        const { size } = layout.elements.find(({ type }) => type === 'subtitle');
        const shownAt = layout.asset === 'banner' ? README_WIDTH : 600;
        const onScreen = (subtitleXHeight(size) * shownAt) / layout.width;
        assert.ok(onScreen >= MIN_X_HEIGHT_ON_SCREEN, `${id}: the x-height is ${onScreen.toFixed(1)} px at ${shownAt} wide`);
    }
});

test('the mansion plate has its own crops: the yard along the bottom of the frame, the plate against its right edge, and the moon in the taller social crop', () => {
    const config = loadBackdropConfig(REAL_ROOT);
    const { banner, social } = resolvePlate(config, 'mansion-day').variants;
    const YARD_FROM = 800;
    const YARD_TO = 900;
    const bottomOf = ({ y, rows, cell }) => y + rows * cell;
    assert.ok(bottomOf(banner) >= YARD_FROM + 60 && bottomOf(banner) <= YARD_TO, `the banner crop ends at ${bottomOf(banner).toFixed(0)}, in the yard below the veranda`);
    assert.ok(1536 - (banner.x + banner.columns * banner.cell) < 8, 'the banner crop is against the right edge of the plate, so the veranda is behind the pair');
    assert.equal(banner.cell, 3.2);
    assert.ok(social.y <= 127 && bottomOf(social) > YARD_FROM + 60, `the social crop runs from ${social.y} to ${bottomOf(social).toFixed(0)}: the moon (from about 127) at the top and the yard at the bottom`);
    assert.ok(social.columns * social.cell >= 1536 - 10, 'and nearly the whole width of the plate');
});

test('a plate entry is refused when it has a key that is not known, no crops, crops that have no step, or is like a plate that cannot be', () => {
    const rootDir = tempDir('sb-github-plate-keys-');
    const real = loadBackdropConfig(REAL_ROOT).plates['mansion-day'];
    const write = (plates) => writeFileSync(join(rootDir, 'github-backdrops.json'), JSON.stringify({ plates }));
    write({ day: { ...real, colour: 'blue' } });
    assert.throws(() => loadBackdropConfig(rootDir), /plate "day" has an unknown key "colour"/);
    write({ day: { light: { x: 1 } } });
    assert.throws(() => loadBackdropConfig(rootDir), /plate "day" needs a "master", the path of its picture/);
    write({ day: { master: 'raw/day.png', light: { x: 1 }, detect: real.detect } });
    assert.throws(() => loadBackdropConfig(rootDir), /plate "day" needs "variants", its crops/);
    writeFileSync(join(rootDir, 'github-backdrops.json'), JSON.stringify({ plates: { day: real }, extra: 1 }));
    assert.throws(() => loadBackdropConfig(rootDir), /has an unknown key "extra"\. Known keys: plates/);
    write({ day: { ...real, light: { x: 1, y: 2 } } });
    assert.throws(() => loadBackdropConfig(rootDir), /plate "day" needs "light"/, 'the light has an x and nothing else');
    write({ day: { ...real, variants: { banner: { ...real.variants.banner, colour: 'blue' } } } });
    assert.throws(() => loadBackdropConfig(rootDir), /plate "day": variant "banner" has an unknown key "colour"/);
    write({ day: { master: 'raw/day.png', light: { x: 1 } } });
    assert.throws(() => loadBackdropConfig(rootDir), /plate "day" needs "detect"/);
    write({ day: { ...real, light: undefined } });
    assert.throws(() => loadBackdropConfig(rootDir), /plate "day" needs "light"/, 'a plate says which way its light throws a shadow');
    write({ day: { ...real, light: { x: 0.5 } } });
    assert.throws(() => loadBackdropConfig(rootDir), /plate "day" needs "light"/, 'in whole blocks');
    write({ day: { ...real, variants: { banner: { cell: 3.2, x: 0, y: 0, columns: 1, rows: 1 } } } });
    assert.throws(() => loadBackdropConfig(rootDir), /plate "day": variant "banner" needs a whole step of 1 or more/);
    for (const [key, value] of [['x', undefined], ['y', undefined], ['x', '12'], ['y', null]]) {
        write({ day: { ...real, variants: { banner: { ...real.variants.banner, [key]: value } } } });
        assert.throws(() => loadBackdropConfig(rootDir), /plate "day": variant "banner" needs "x" and "y"/, `${key} = ${value}`);
    }
    write({ night: { master: 'raw/night.png', light: { x: 0 }, like: 'day' } });
    assert.throws(() => loadBackdropConfig(rootDir), /plate "night" is like "day", which must be another plate with crops of its own/);
    write({ day: real, night: { master: 'raw/night.png', light: { x: 0 }, like: 'day', variants: real.variants } });
    assert.throws(() => loadBackdropConfig(rootDir), /a plate that is like another has none/);
    const compare = { against: 'nowhere', boxes: { all: { x: 0, y: 0, width: 10, height: 10 } }, moonCentres: { x: 0, y: 0, width: 1, height: 1 }, moonRadii: { min: 1, max: 2 } };
    write({ day: real, night: { master: 'raw/night.png', light: { x: 0 }, like: 'day', compare } });
    assert.throws(() => loadBackdropConfig(rootDir), /compare\.against "nowhere" is not a plate/);
    write({ day: real, night: { master: 'raw/night.png', light: { x: 0 }, like: 'day', compare: { ...compare, against: 'day', extra: 1 } } });
    assert.throws(() => loadBackdropConfig(rootDir), /plate "night": compare has an unknown key "extra"/);
    write({ day: real, night: { master: 'raw/night.png', light: { x: 0 }, like: 'day', compare: { ...compare, against: 'day', boxes: {} } } });
    assert.throws(() => loadBackdropConfig(rootDir), /compare needs boxes, moonCentres and moonRadii/);
});
