import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { findStrayPieces, loadArt } from '../scripts/lib/github-art.mjs';
import { buildLayout } from '../scripts/lib/github-build.mjs';
import { TITLES } from '../scripts/lib/github-titles.mjs';
import { resolveOutDir } from '../scripts/lib/run.mjs';
import { chooseLayouts, findLimitProblems, loadGithubConfig, loadSources, resolveGithubOutDir, runGithubAssets, slotsOf } from '../scripts/lib/github-run.mjs';
import { loadBackdropConfig, resolvePlate } from '../scripts/lib/github-backdrop-run.mjs';
import { buildSheets } from '../scripts/lib/github-sheets.mjs';
import { drawSubtitle } from '../scripts/lib/github-subtitle.mjs';
import { drawTitle } from '../scripts/lib/github-text.mjs';
import { drawPlate, drawWordmark } from '../scripts/lib/github-vector.mjs';
import { createRaster, readRaster, writeRaster } from '../scripts/lib/raster.mjs';
import { nativeSprite } from '../test-support/synthetic.mjs';
import { tempDir } from '../test-support/temp-dir.mjs';

const REAL_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PNG_SIGNATURE = '89504e470d0a1a0a';
const SPRITE_COLOURS = [[200, 40, 50], [40, 60, 200], [230, 210, 90], [60, 160, 90], [250, 250, 250]];
const SECTIONS = ['features', 'install', 'contributing', 'credits', 'community'];
const NIGHT = '#1c1228';
const SOCIAL = 'social-grove';
// The drawn size, in art pixels, of each snapped scene.
const SCENES = {
    'social-welcome': { width: 224, height: 300 },
    'banner-main': { width: 346, height: 362 },
    'banner-features': { width: 378, height: 362 },
    'banner-install': { width: 361, height: 363 },
    'banner-contributing': { width: 325, height: 363 },
    'banner-credits': { width: 335, height: 362 },
    'banner-community': { width: 293, height: 362 },
};
// A run builds every layout, which can pass bun's default timeout of 5 seconds on a busy machine.
const SLOW = { timeout: 120_000 };

/**
 * A package folder with the approved logo, the real config, and its own log folder and out/. Every scene has a snapped picture of
 * the size the real one has (a transparent margin round a filled drawing), except the scenes named in `standIns`: those have no file
 * and the config gives each a stand-in size, as it did before the scene was drawn.
 */
async function workspace({ standIns = [] } = {}) {
    const rootDir = tempDir('sb-github-assets-');
    mkdirSync(join(rootDir, 'approved', 'pixel'), { recursive: true });
    for (const file of ['logo-plate.svg', 'logo-emblem.svg']) {
        copyFileSync(join(REAL_ROOT, 'approved', file), join(rootDir, 'approved', file));
    }
    const edited = JSON.parse(readFileSync(join(REAL_ROOT, 'github-config.json'), 'utf8'));
    for (const name of standIns) {
        edited.sources.placeholders[name] = { ...SCENES[name] };
    }
    writeFileSync(join(rootDir, 'github-config.json'), JSON.stringify(edited));
    copyFileSync(join(REAL_ROOT, 'github-backdrops.json'), join(rootDir, 'github-backdrops.json'));
    const backdrops = loadBackdropConfig(rootDir);
    for (const [name, path] of Object.entries(edited.sources.backdrops)) {
        const [, plate, variant] = /^backdrop-(.+)-(banner|social)$/.exec(name);
        const { columns, rows } = resolvePlate(backdrops, plate).variants[variant];
        const tone = plate.endsWith('night') ? [40, 30, 80] : [215, 205, 235];
        const picture = createRaster(columns, rows);
        for (let at = 0; at < columns * rows; at++) {
            picture.data.set([...tone.map((channel) => channel + ((at % columns >> 3) + (Math.floor(at / columns) >> 3)) % 2 * 6), 255], at * 4);
        }
        mkdirSync(dirname(join(rootDir, path)), { recursive: true });
        await writeRaster(join(rootDir, path), picture);
    }
    let seed = 1;
    for (const [name, path] of Object.entries(edited.sources.art)) {
        if (standIns.includes(name)) {
            continue;
        }
        mkdirSync(dirname(join(rootDir, path)), { recursive: true });
        await writeRaster(join(rootDir, path), nativeSprite(SCENES[name].width + 6, SCENES[name].height + 6, SPRITE_COLOURS, { seed: seed++, margin: 3 }));
    }
    return rootDir;
}

const hashOf = (bytes) => createHash('sha256').update(bytes).digest('hex');
const readLogLines = (rootDir) => readFileSync(join(rootDir, 'log', 'generations.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
const everyFile = (directory) => readdirSync(directory, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => join(entry.parentPath, entry.name).slice(directory.length + 1)).sort();

const root = await workspace();
const config = loadGithubConfig(root);
const sources = await loadSources(root, config);
const built = new Map();
for (const layout of config.layouts) {
    built.set(layout.id, { layout, ...(await buildLayout(layout, { colours: config.colours, sources, icons: config.icons, ornaments: config.ornaments })) });
}
const banner = (section, theme) => built.get(`banner-${section}-${theme}`);
const artOf = ({ layout }) => layout.elements.find(({ type }) => type === 'art');
const titleOf = ({ layout }) => layout.elements.find(({ type }) => type === 'title');
const sideOf = ({ layout, placements }) => {
    const { x, width } = placements.find(({ type }) => type === 'art');
    return x + width / 2 < layout.width / 2 ? 'left' : 'right';
};

test('every layout is a PNG of the size its asset asks for, and under the cap in bytes', async () => {
    for (const { layout, png } of built.values()) {
        assert.equal(png.subarray(0, 8).toString('hex'), PNG_SIGNATURE);
        assert.deepEqual(await findLimitProblems(layout, png, config), []);
        const decoded = await readRaster(png);
        assert.deepEqual([decoded.width, decoded.height], [layout.width, layout.height]);
        assert.ok(png.length < 1_000_000, `${layout.id} is ${png.length} bytes`);
    }
    const sizes = (asset) => new Set(config.layouts.filter((layout) => layout.asset === asset).map((layout) => `${layout.width}x${layout.height}`));
    assert.deepEqual([...sizes('avatar')], ['500x500']);
    assert.deepEqual([...sizes('social')], ['1280x640']);
    assert.deepEqual([...sizes('banner')], ['2560x800']);
});

test('the main banner and every section banner are 2560x800', async () => {
    for (const theme of ['light', 'dark']) {
        for (const section of ['main', ...SECTIONS]) {
            const decoded = await readRaster(banner(section, theme).png);
            assert.deepEqual([decoded.width, decoded.height], [2560, 800], `${section} ${theme}`);
        }
    }
});

/**
 * The frame is 24 px thick on a banner and 12 px on the social preview. The pair stands with its top at the top border (a few pixels of
 * air at most), and leaves ground below its lowest foot or base for the shadows to show on: three of the 8 pixel blocks on a banner, and
 * half that on the social preview.
 */
const FRAME_THICKNESS = { banner: 24, social: 12 };
const GROUND_BELOW = { banner: 24, social: 12 };
const MAX_AIR_ABOVE = 8;

/** From the bottom of the sticker round the lowest part that stands on the ground (a raised one does not) to the inner edge of the frame. */
function groundBelow({ layout, placements }) {
    const art = placements.find(({ type }) => type === 'art');
    const { shadow } = artOf({ layout });
    const lowestOnGround = Math.max(...art.contacts.filter(({ kind }) => kind !== 'raised').map(({ y }) => y));
    return layout.height - FRAME_THICKNESS[layout.asset] - (art.y + (lowestOnGround + 1 + shadow.inset) * art.step);
}

const sceneLayouts = () => [...built.values()].filter(({ layout }) => layout.asset !== 'avatar');

test('every scene is at step 2 with its top at the top border and the ground to read its shadows on below its lowest foot or base', () => {
    for (const entry of sceneLayouts()) {
        const { layout, placements } = entry;
        const art = placements.find(({ type }) => type === 'art');
        assert.equal(art.step, 2, layout.id);
        const above = art.y - FRAME_THICKNESS[layout.asset];
        assert.ok(above >= 0 && above <= MAX_AIR_ABOVE, `${layout.id}: ${above} px of air between the top of the pair and the frame`);
        const below = groundBelow(entry);
        assert.ok(below >= GROUND_BELOW[layout.asset], `${layout.id}: ${below} px of ground under the lowest contact, ${GROUND_BELOW[layout.asset]} wanted`);
        const inkBelow = layout.height - FRAME_THICKNESS[layout.asset] - (art.y + art.height);
        assert.ok(inkBelow >= GROUND_BELOW[layout.asset], `${layout.id}: the lowest sticker is ${inkBelow} px above the frame`);
    }
    for (const section of ['main', ...SECTIONS]) {
        for (const theme of ['light', 'dark']) {
            const { layout, placements } = banner(section, theme);
            const text = placements.find(({ type }) => type === (section === 'main' ? 'plate' : 'title'));
            const centre = text.x + text.width / 2;
            assert.equal(centre < layout.width / 2 ? 'left' : 'right', sideOf(banner(section, theme)) === 'left' ? 'right' : 'left', `${section} ${theme}`);
        }
    }
});

test('the ground under the lowest contact is measured from the lowest part on the ground: lower art has less of it, and a raised part does not count', () => {
    const entry = built.get('banner-main-light');
    const art = entry.placements.find(({ type }) => type === 'art');
    const lowered = { ...entry, placements: entry.placements.map((place) => (place.type === 'art' ? { ...place, y: art.y + 10 } : place)) };
    assert.equal(groundBelow(lowered), groundBelow(entry) - 10);
    const raisedOnly = { ...entry, placements: entry.placements.map((place) => (place.type === 'art' ? { ...place, contacts: [...place.contacts, { kind: 'raised', x0: 1, x1: 9, y: 400 }] } : place)) };
    assert.equal(groundBelow(raisedOnly), groundBelow(entry), 'a raised part is not on the ground, so it does not set the gap');
});

test('the pair is clear of the corner bosses of the frame, which it would otherwise run into where it is as tall as the frame', () => {
    for (const { layout, placements } of built.values()) {
        if (layout.asset === 'avatar') {
            continue;
        }
        const art = placements.find(({ type }) => type === 'art');
        const boss = 13 * layout.elements.at(-1).unit;
        assert.ok(art.x >= boss && art.x + art.width <= layout.width - boss, `${layout.id}: the pair is ${art.x} px from the left edge and ${layout.width - art.x - art.width} from the right, and a boss is ${boss} wide`);
    }
});

test('the art alternates sides from one section to the next, in README order, starting from the main banner', () => {
    const order = ['main', ...SECTIONS];
    for (const theme of ['light', 'dark']) {
        const sides = order.map((section) => sideOf(banner(section, theme)));
        assert.deepEqual(sides, ['right', 'left', 'right', 'left', 'right', 'left'], theme);
        sides.slice(1).forEach((side, at) => assert.notEqual(side, sides[at], `${order[at + 1]} sits on the other side from ${order[at]}`));
    }
});

test('the title, or the logo of the main banner, sits on the side that the art is not on', () => {
    for (const section of ['main', ...SECTIONS]) {
        for (const theme of ['light', 'dark']) {
            const { layout, placements } = banner(section, theme);
            const text = placements.find(({ type }) => type === (section === 'main' ? 'plate' : 'title'));
            const centre = text.x + text.width / 2;
            assert.equal(centre < layout.width / 2 ? 'left' : 'right', sideOf(banner(section, theme)) === 'left' ? 'right' : 'left', `${section} ${theme}`);
        }
    }
});

test('a light banner and its dark one share one geometry and one picture, and differ in colour and in the plate', () => {
    const geometry = (entry) => entry.placements.map(({ contrast, source, shadowCells, ...place }) => (place.type === 'backdrop' ? place : { ...place, source }));
    const withoutLight = (art) => ({ ...art, shadow: { ...art.shadow, offset: undefined } });
    for (const section of ['main', ...SECTIONS]) {
        const light = banner(section, 'light');
        const dark = banner(section, 'dark');
        assert.deepEqual(geometry(light), geometry(dark), `${section}: where the plate, the logo, the text and the art are`);
        assert.deepEqual(withoutLight(artOf(light)), withoutLight(artOf(dark)), `${section}: the same art at the same step, with the same shadows but for the light`);
        assert.equal(light.layout.background, 'pale');
        assert.equal(dark.layout.background, 'night');
        assert.equal(config.colours.night, NIGHT, 'deep plum, not the page colour of GitHub\'s dark theme');
        const plate = (entry) => entry.layout.elements.find(({ type }) => type === 'backdrop');
        assert.equal(plate(light).source, 'backdrop-mansion-day-banner');
        assert.equal(plate(dark).source, 'backdrop-mansion-night-banner');
        assert.equal(plate(light).mirror === true, plate(dark).mirror === true);
        assert.equal(plate(light).mirror === true, sideOf(light) === 'left', `${section}: the plate is mirrored when the pair is on the left, so the moon stays behind them`);
        const text = (entry) => entry.layout.elements.find(({ type }) => type === 'title' || type === 'wordmark');
        assert.equal(text(light).colour, 'plum');
        assert.equal(text(dark).colour, 'pale');
    }
});

test('every scene lists its contacts in the config: at least one contact, inside its art, with a kind and a ground row, and every layout draws its scene with a shadow', () => {
    assert.deepEqual(Object.keys(config.contacts).sort(), Object.keys(SCENES).sort(), 'a contact list for every scene and for nothing else');
    for (const [name, entries] of Object.entries(config.contacts)) {
        assert.ok(entries.some(({ kind }) => kind === 'contact'), `${name}: something stands on the ground`);
        for (const { kind, x0, x1, y } of entries) {
            assert.ok(['contact', 'footprint', 'raised'].includes(kind), `${name}: ${kind}`);
            assert.ok(x1 >= x0 && x0 >= 0 && x1 < SCENES[name].width && y < SCENES[name].height, `${name}: ${kind} ${x0}-${x1}@${y} lies inside the ${SCENES[name].width}x${SCENES[name].height} art`);
        }
    }
    for (const { layout } of sceneLayouts()) {
        assert.ok(artOf({ layout }).shadow, `${layout.id} casts contact shadows`);
    }
    for (const { layout, placements } of sceneLayouts()) {
        assert.deepEqual(placements.find(({ type }) => type === 'art').contacts, config.contacts[artOf({ layout }).source], `${layout.id} paints the contacts of its scene as the config lists them`);
    }
});

test('the bases and the lifted parts are listed as they are in the scenes: footprints under the bench, desk, mortar and box, and raised parts where a foot or a shoe is in the air', () => {
    const kinds = (name) => config.contacts[name].map(({ kind }) => kind);
    for (const name of ['banner-main', 'banner-install', 'banner-contributing', 'banner-features']) {
        assert.ok(kinds(name).includes('footprint'), `${name}: the bench, the desk, the mortar and the box have a footprint`);
    }
    for (const name of ['banner-main', 'banner-install', 'banner-contributing', 'banner-features', 'social-welcome']) {
        assert.ok(kinds(name).includes('raised'), `${name}: a swinging foot, a raised shoe or a foot bent back is raised`);
    }
    for (const name of ['banner-credits', 'banner-community']) {
        assert.equal(kinds(name).every((kind) => kind === 'contact'), true, `${name}: every foot is on the ground`);
    }
    const mainRaised = config.contacts['banner-main'].filter(({ kind }) => kind === 'raised');
    const mainContact = config.contacts['banner-main'].filter(({ kind }) => kind === 'contact');
    assert.ok(mainRaised.length === 2 && mainRaised.every(({ x0 }) => x0 > 190), 'the two swinging feet of Tewi on the main banner are raised, on the right');
    assert.ok(mainContact.some(({ x0 }) => x0 < 40) && mainContact.some(({ x0 }) => x0 > 300), 'the two legs of the bench are contacts, one each side');
});

test('every scene has the one look: the same tint, bands, ring and strengths, with a contact darker than a footprint or a raised part', () => {
    const looks = sceneLayouts().map(({ layout }) => {
        return JSON.stringify({ ...artOf({ layout }).shadow, offset: undefined });
    });
    assert.equal(new Set(looks).size, 1, 'one look everywhere, but for the light');
    const { strengths, bands, inset } = artOf(sceneLayouts()[0]).shadow;
    assert.ok(strengths.contact > strengths.footprint && strengths.contact > strengths.raised, 'contacts are the darkest');
    assert.ok(strengths.raised <= strengths.contact / 2 + 0.001 && strengths.raised > 0, 'a raised part is about half a contact');
    assert.ok(bands >= 3 && inset === 4);
});

test('the light of a plate moves the shadows of the day to the right and leaves those of the night straight down, and a mirrored plate has its light on the other side', () => {
    const backdrops = loadBackdropConfig(REAL_ROOT);
    assert.deepEqual({ day: backdrops.plates['mansion-day'].light, night: backdrops.plates['mansion-night'].light }, { day: { x: 1 }, night: { x: 0 } });
    for (const { layout } of sceneLayouts()) {
        const plate = layout.elements.find(({ type }) => type === 'backdrop');
        const [, name] = /^backdrop-(.+)-(?:banner|social)$/.exec(plate.source);
        const { offset } = artOf({ layout }).shadow;
        const expected = (plate.mirror === true ? -1 : 1) * backdrops.plates[name].light.x;
        assert.deepEqual({ ...offset }, { x: expected + 0, y: 0 }, `${layout.id}: shadows move ${expected} blocks sideways`);
    }
    const offsetOf = (id) => artOf(built.get(id)).shadow.offset.x;
    assert.deepEqual([offsetOf('banner-main-light'), offsetOf('banner-features-light'), offsetOf('banner-main-dark'), offsetOf('banner-features-dark')], [1, -1, 0, 0]);
});

test('each section banner draws its own title in the maintainer\'s words and no other text; the main banner draws the wordmark', () => {
    for (const section of SECTIONS) {
        for (const theme of ['light', 'dark']) {
            const entry = banner(section, theme);
            assert.equal(TITLES[titleOf(entry).title], { features: 'Features and Project Philosophy', install: 'Installation and Getting Started', contributing: 'Contributing', credits: 'Credits', community: 'Community and Support' }[section]);
            assert.equal(titleOf(entry).title, section);
            assert.equal(entry.layout.elements.filter(({ type }) => ['title', 'wordmark'].includes(type)).length, 1);
            assert.equal(entry.layout.elements.some(({ type }) => type === 'emblem' || type === 'plate'), false, 'a section banner has no logo');
            assert.equal(entry.layout.elements.filter(({ type }) => type === 'icon').length, 1, 'one icon beside the title');
            assert.equal(artOf(entry).source, `banner-${section}`);
        }
    }
    for (const theme of ['light', 'dark']) {
        const { layout } = banner('main', theme);
        assert.deepEqual(layout.elements.filter(({ type }) => ['title', 'wordmark', 'emblem', 'plate', 'subtitle'].includes(type)).map(({ type }) => type), ['plate', 'wordmark', 'subtitle']);
    }
});

test('the longer titles wrap onto two lines and the short ones stay on one', () => {
    const height = (section) => banner(section, 'light').placements.find(({ type }) => type === 'title').height;
    for (const section of ['features', 'install', 'community']) {
        assert.ok(height(section) > 200, `${section} has two lines`);
    }
    for (const section of ['contributing', 'credits']) {
        assert.ok(height(section) < 160, `${section} has one line`);
    }
});

test('in the files that were written, every art pixel is an even block of a whole step, nearest-neighbour', async () => {
    let checked = 0;
    for (const { layout, png, placements } of built.values()) {
        const decoded = await readRaster(png);
        for (const placement of placements.filter(({ type }) => type === 'art')) {
            const art = sources.art[placement.source];
            assert.ok(Number.isInteger(placement.step) && placement.step >= 1, `${layout.id} step`);
            assert.equal(placement.width, art.width * placement.step);
            assert.equal(placement.height, art.height * placement.step);
            const wrong = [];
            for (let row = 0; row < art.height; row++) {
                for (let column = 0; column < art.width; column++) {
                    const source = art.data.subarray((row * art.width + column) * 4, (row * art.width + column) * 4 + 4);
                    if (source[3] === 0) {
                        continue;
                    }
                    for (let dy = 0; dy < placement.step; dy++) {
                        for (let dx = 0; dx < placement.step; dx++) {
                            const at = ((placement.y + row * placement.step + dy) * decoded.width + placement.x + column * placement.step + dx) * 4;
                            if (decoded.data.compare(source, 0, 3, at, at + 3) !== 0) {
                                wrong.push(`${column},${row}`);
                            }
                        }
                    }
                }
            }
            assert.deepEqual(wrong.slice(0, 5), [], `${layout.id}: art pixels that are not even blocks`);
            checked += 1;
        }
    }
    assert.equal(checked, config.layouts.filter(({ elements }) => elements.some(({ type }) => type === 'art')).length, 'every layout that draws a scene was checked');
});

test('the art keeps its own colours: nothing is smoothed, so the file holds only the art pixels it was given', async () => {
    const { png, placements } = banner('main', 'light');
    const decoded = await readRaster(png);
    const art = sources.art['banner-main'];
    const { x, y, step } = placements.find(({ type }) => type === 'art');
    const inArt = new Set();
    for (let at = 0; at < art.data.length; at += 4) {
        inArt.add(art.data.readUInt32BE(at) >>> 0);
    }
    for (let row = 0; row < art.height; row += 7) {
        for (let column = 0; column < art.width; column += 5) {
            if (art.data[(row * art.width + column) * 4 + 3] === 0) {
                continue;
            }
            const word = decoded.data.readUInt32BE(((y + row * step) * decoded.width + x + column * step) * 4) >>> 0;
            assert.ok(inArt.has(word), `pixel ${column},${row} is a colour the art does not have`);
        }
    }
});

test('the same input is the same bytes, run after run', SLOW, async () => {
    for (const id of ['avatar-fill', SOCIAL, 'banner-main-dark', 'banner-features-dark', 'banner-credits-light']) {
        const { layout } = built.get(id);
        const again = await buildLayout(layout, { colours: config.colours, sources, icons: config.icons, ornaments: config.ornaments });
        assert.equal(Buffer.compare(again.png, built.get(id).png), 0, `${id} changed between two builds`);
    }
});

test('the logo, the wordmark and the titles are drawn from vectors at their own size: every fully inked pixel of a fresh drawing is in the file', async () => {
    const inkIsThere = async (entry, place, fresh) => {
        const decoded = await readRaster(entry.png);
        let checked = 0;
        for (let y = 0; y < fresh.height; y++) {
            for (let x = 0; x < fresh.width; x++) {
                const from = (y * fresh.width + x) * 4;
                if (fresh.data[from + 3] !== 255) {
                    continue;
                }
                const to = ((place.y + y) * decoded.width + place.x + x) * 4;
                assert.equal(decoded.data.compare(fresh.data, from, from + 3, to, to + 3), 0, `${place.type} of ${entry.layout.id} differs from a fresh drawing at ${x},${y}`);
                checked += 1;
            }
        }
        assert.ok(checked > 1000, `${place.type} has ink to check`);
    };
    for (const theme of ['light', 'dark']) {
        const main = banner('main', theme);
        const plate = main.placements.find(({ type }) => type === 'plate');
        const wordmark = main.placements.find(({ type }) => type === 'wordmark');
        const subtitle = main.placements.find(({ type }) => type === 'subtitle');
        const wordmarkElement = main.layout.elements.find(({ type }) => type === 'wordmark');
        const subtitleElement = main.layout.elements.find(({ type }) => type === 'subtitle');
        await inkIsThere(main, plate, await drawPlate(sources.plateSvg, { size: plate.height }));
        await inkIsThere(main, wordmark, await drawWordmark({ size: wordmarkElement.size, colour: config.colours[wordmarkElement.colour] }));
        await inkIsThere(main, subtitle, await drawSubtitle({ lines: subtitleElement.lines, size: subtitleElement.size, colour: config.colours[subtitleElement.colour], align: subtitleElement.align }));
    }
    const features = banner('features', 'dark');
    const element = titleOf(features);
    await inkIsThere(features, features.placements.find(({ type }) => type === 'title'), await drawTitle({ title: element.title, size: element.size, colour: config.colours[element.colour], maxWidth: element.maxWidth }));
});

test('a preview run writes only under out/ and nothing to the log, and flags every scene that is still a stand-in', SLOW, async () => {
    const standIns = ['banner-install', 'banner-contributing'];
    const rootDir = await workspace({ standIns });
    const result = await runGithubAssets({ rootDir, outDir: 'out/github', sheet: buildSheets });
    assert.equal(result.wrote, false);
    assert.deepEqual(result.finals, []);
    assert.equal(result.files.length, config.layouts.length);
    assert.equal(existsSync(join(rootDir, 'log')), false, 'no log folder, so no log line');
    const files = everyFile(rootDir).filter((path) => !path.startsWith('approved'));
    assert.deepEqual(files.filter((path) => !path.startsWith('out/')), ['github-backdrops.json', 'github-config.json']);
    assert.ok(files.includes(`out/github/${SOCIAL}.png`) && files.includes('out/github/banner-credits-dark.png') && files.includes('out/github/sheets/readme-dark.png'));
    assert.equal(files.some((path) => path.startsWith('out/github/final')), false);
    assert.deepEqual(result.sheets.sort(), ['avatars.png', 'readme-dark.png', 'readme-light.png', 'shadows.png', 'social-grove-400.png', 'social-grove-full.png']);
    for (const file of result.files) {
        const scene = config.layouts.find(({ id }) => id === file.id).elements.find(({ type }) => type === 'art')?.source;
        assert.deepEqual(file.placeholders, standIns.includes(scene) ? [scene] : [], `${file.id} stand-in flag`);
    }
});

test('a write run refuses a layout that still draws a stand-in, before it writes or logs anything', SLOW, async () => {
    const rootDir = await workspace({ standIns: ['banner-install'] });
    await assert.rejects(runGithubAssets({ rootDir, outDir: 'out/github', write: true }), /cannot ship a stand-in: banner-install-light \(banner-install-light\), banner-install-dark \(banner-install-dark\) draw art that is not in the package yet \(banner-install\)/);
    assert.equal(existsSync(join(rootDir, 'log')), false);
    assert.deepEqual(everyFile(rootDir).filter((path) => path.startsWith('out/') && !path.startsWith('out/github/snapped/')), [], 'not even a preview was written');
});

test('a run needs the art file or a stand-in size for every scene', async () => {
    const rootDir = await workspace({ standIns: ['banner-install'] });
    const configPath = join(rootDir, 'github-config.json');
    const edited = JSON.parse(readFileSync(configPath, 'utf8'));
    delete edited.sources.placeholders['banner-install'];
    writeFileSync(configPath, JSON.stringify(edited));
    await assert.rejects(runGithubAssets({ rootDir, outDir: 'out/github' }), /The art "banner-install" is not at approved\/pixel\/banner-install\.png, and the config has no placeholder size for it/);
});

test('the slots are the final names, the avatar is chosen in the config, and the banners are chosen by their own ids', () => {
    assert.deepEqual(Object.keys(slotsOf(config)), Object.keys(config.final), 'the slots are the keys of final');
    assert.throws(() => chooseLayouts({ ...config, chosen: { avatar: 'avatar-fill' } }), /needs a layout for social:/);
    const chosen = chooseLayouts(config);
    assert.equal(chosen.avatar.id, 'avatar-fill');
    assert.equal(chosen.social.id, SOCIAL);
    assert.equal(chosen['banner-features-dark'].id, 'banner-features-dark');
    assert.equal(chosen['banner-main-dark'].id, 'banner-main-dark');
    assert.deepEqual(Object.keys(chosen), Object.keys(config.final), 'a layout is chosen for every slot');
    assert.throws(() => chooseLayouts(config, { avatar: SOCIAL }), /avatar must be an avatar layout, and "social-grove" is a social layout/);
    assert.throws(() => chooseLayouts(config, { social: 'nowhere' }), /social must be a social layout, and "nowhere" is not a layout/);
});

test('a write run logs once and writes one file for each final name, and refuses a slot that does not exist', SLOW, async () => {
    const rootDir = await workspace();
    await assert.rejects(runGithubAssets({ rootDir, outDir: 'out/github', write: true, choose: { 'banner-extras-light': 'banner-main-light' } }), /banner-extras-light, which is not a slot/);
    assert.equal(existsSync(join(rootDir, 'log')), false, 'a refused write run logs nothing');

    const result = await runGithubAssets({ rootDir, outDir: 'out/github', write: true, now: () => new Date('2026-11-04T10:00:00Z') });
    const names = Object.values(config.final);
    assert.deepEqual(result.finals.map(({ name }) => name), names);
    assert.deepEqual(everyFile(join(rootDir, 'out/github/final')), [...names].sort());
    assert.ok(names.includes('social-preview.png') && names.includes('banner-community-dark.png') && names.includes('avatar.png'));
    const lines = readLogLines(rootDir);
    assert.equal(lines.length, 1);
    assert.equal(lines[0].stage, 's8');
    assert.equal(lines[0].model, 'github-assets');
    assert.equal(lines[0].estimatedUsd, 0);
    assert.equal(lines[0].outputs.length, Object.keys(config.final).length);
    assert.equal(lines[0].vars.layouts.social, SOCIAL);
    assert.equal(lines[0].vars.layouts['banner-main-dark'], 'banner-main-dark');
    assert.equal(lines[0].vars.layouts.avatar, 'avatar-fill');
    const sourcePaths = [config.sources.plate, config.sources.emblem, ...Object.values(config.sources.art), ...Object.values(config.sources.backdrops)];
    assert.deepEqual(lines[0].refs, sourcePaths.map((path) => hashOf(readFileSync(join(rootDir, path)))), 'the logo, the emblem, every scene and every plate, by the hash of the file');
    assert.deepEqual(lines[0].vars.config, { file: 'github-config.json', sha256: hashOf(readFileSync(join(rootDir, 'github-config.json'))) });
    assert.deepEqual(lines[0].outputs.map(({ file }) => file), names.map((name) => `out/github/final/${name}`), 'the path from the package root, with slashes');
    for (const { file, sha256 } of lines[0].outputs) {
        assert.equal(hashOf(readFileSync(resolve(rootDir, file))), sha256, `${file} is where the log says, and is what the log says`);
    }

    await runGithubAssets({ rootDir, outDir: 'out/elsewhere', write: true, now: () => new Date('2026-11-04T11:00:00Z') });
    const [, second] = readLogLines(rootDir);
    assert.deepEqual(second.outputs.map(({ file }) => file), names.map((name) => `out/elsewhere/final/${name}`), 'the log follows --out-dir');
    assert.deepEqual(second.outputs.map(({ sha256 }) => sha256), lines[0].outputs.map(({ sha256 }) => sha256), 'the same input gives the same files');
});

test('a source that changes while a run is building is logged as it was read, because the hash is of the bytes that were drawn from', SLOW, async () => {
    const rootDir = await workspace();
    const path = join(rootDir, config.sources.art['banner-main']);
    const bytes = readFileSync(path);
    let swapped = false;
    const swapAfterRead = () => {
        if (!swapped) {
            swapped = true;
            writeFileSync(path, Buffer.concat([bytes, Buffer.from('changed after the read')]));
        }
        return new Date('2026-11-04T12:00:00Z');
    };
    await runGithubAssets({ rootDir, outDir: 'out/github', write: true, now: swapAfterRead });
    const [line] = readLogLines(rootDir);
    assert.ok(swapped, 'the file was changed once the run had read it');
    assert.ok(line.refs.includes(hashOf(bytes)), 'the log has the hash of what was read');
    assert.equal(line.refs.includes(hashOf(readFileSync(path))), false, 'and not the hash of what is on disk now');
});

test('a config that changes while a run is building is logged as it was read, because the hash is of the bytes that were parsed', SLOW, async () => {
    const rootDir = await workspace();
    const path = join(rootDir, 'github-config.json');
    const bytes = readFileSync(path);
    let swapped = false;
    const swapAfterRead = () => {
        if (!swapped) {
            swapped = true;
            writeFileSync(path, Buffer.concat([bytes, Buffer.from('\n')]));
        }
        return new Date('2026-11-04T13:00:00Z');
    };
    await runGithubAssets({ rootDir, outDir: 'out/github', write: true, now: swapAfterRead });
    const [line] = readLogLines(rootDir);
    assert.ok(swapped, 'the config was changed once the run had read it');
    assert.notEqual(hashOf(readFileSync(path)), hashOf(bytes), 'and it is not the file that was read any more');
    assert.deepEqual(line.vars.config, { file: 'github-config.json', sha256: hashOf(bytes) }, 'the log has the hash of what was parsed, not of what is on disk now');
});

test('the out folder is kept inside out/, and the output is only ever written there', () => {
    assert.throws(() => resolveGithubOutDir(REAL_ROOT, '../elsewhere'), /inside out\//);
    assert.throws(() => resolveGithubOutDir(REAL_ROOT, '/tmp/github'), /inside out\//);
    assert.equal(resolveGithubOutDir(REAL_ROOT, 'out/github'), join(REAL_ROOT, 'out', 'github'));
    assert.equal(resolveGithubOutDir(REAL_ROOT, join(REAL_ROOT, 'out', 'github')), join(REAL_ROOT, 'out', 'github'), 'an absolute path inside out/ is fine');
    assert.equal(resolveGithubOutDir(REAL_ROOT, 'out/github/../other'), join(REAL_ROOT, 'out', 'other'), 'a path that goes up and stays inside out/ is fine');
    assert.equal(resolveGithubOutDir(REAL_ROOT, `${REAL_ROOT}/out/github/../other`), join(REAL_ROOT, 'out', 'other'), 'an absolute path that goes up and stays inside out/ is fine');
    // Raw strings on purpose: join() and resolve() would remove the ".." before the guard saw it, and the guard would never be tried.
    for (const escape of ['out/../..', 'out/../../../../tmp/x', `${REAL_ROOT}/out/../../x`, `${REAL_ROOT}/out/../../../../tmp/x`, `${REAL_ROOT}/out/../raw`, 'out/../out-other', `${REAL_ROOT}/out-other`, `${REAL_ROOT}/out/github/../../../x`]) {
        assert.throws(() => resolveGithubOutDir(REAL_ROOT, escape), /inside out\//, escape);
    }
});

test('a write run whose out folder leads out of out/ by way of ".." is refused before anything is written or logged, on a package of its own', SLOW, async () => {
    const rootDir = await workspace();
    // The path leads into a scratch folder of its own, so that a guard that lets it through writes into a folder the test run removes.
    const scratch = tempDir('sb-github-escape-');
    const target = join(scratch, 'made');
    const outDir = `${rootDir}/out/../../${basename(scratch)}/made`;
    assert.equal(resolve(outDir), target, 'the raw path leads out of the package, to a folder beside it');
    await assert.rejects(runGithubAssets({ rootDir, outDir, write: true }), /--out-dir must be inside out\//);
    assert.equal(existsSync(target), false, 'nothing was made where the path leads');
    assert.equal(existsSync(join(rootDir, 'log')), false, 'and nothing was logged');
    assert.equal(everyFile(rootDir).some((path) => path.startsWith('out/')), false, 'not even a preview was written');
});

test('the shared out folder guard of the other tools is also checked as the place a path leads to', () => {
    assert.equal(resolveOutDir(REAL_ROOT, 'raw/x'), join(REAL_ROOT, 'raw', 'x'));
    assert.equal(resolveOutDir(REAL_ROOT, join(REAL_ROOT, 'out', 'x')), join(REAL_ROOT, 'out', 'x'));
    assert.equal(resolveOutDir(REAL_ROOT, `${REAL_ROOT}/raw/a/../b`), join(REAL_ROOT, 'raw', 'b'), 'an absolute path that goes up and stays inside raw/ is fine');
    for (const escape of ['out/../..', 'raw/../../tmp', `${REAL_ROOT}/out/../../x`, `${REAL_ROOT}/out/../../../../tmp/x`, `${REAL_ROOT}/raw/../approved`, `${REAL_ROOT}/raw/../out-other`, `${REAL_ROOT}/out-other`, '/tmp/x']) {
        assert.throws(() => resolveOutDir(REAL_ROOT, escape), /inside raw\/ or out\//, escape);
    }
});

test('the layout notes name no third party, and no layout holds a caption or a label', () => {
    const text = JSON.stringify(config.layouts.map(({ elements }) => elements));
    assert.doesNotMatch(text, /"text"|"label"|"caption"/);
    for (const layout of config.layouts) {
        assert.doesNotMatch(layout.note, /touhou|project|reimu|marisa|nintendo|disney/i);
    }
});

test('every scene that is in the package is a whole snapped sticker, and the layouts that draw it hold it', SLOW, async () => {
    const realConfig = loadGithubConfig(REAL_ROOT);
    const landed = Object.entries(realConfig.sources.art).filter(([, path]) => existsSync(join(REAL_ROOT, path)));
    assert.equal(landed.length, Object.keys(realConfig.sources.art).length, 'every scene of the config is snapped');
    assert.deepEqual({ ...realConfig.sources.placeholders }, {}, 'and none is a stand-in');
    const realSources = await loadSources(REAL_ROOT, realConfig);
    for (const [name, path] of landed) {
        const art = await loadArt(join(REAL_ROOT, path));
        assert.deepEqual(findStrayPieces(art), [], `${name} has no speck outside the sticker`);
        assert.equal(realSources.placeholders.includes(name), false, `${name} is the real picture, not a stand-in`);
        for (const layout of realConfig.layouts.filter(({ elements }) => elements.some((element) => element.source === name))) {
            const { placements, placeholders } = await buildLayout(layout, { colours: realConfig.colours, sources: realSources, icons: realConfig.icons, ornaments: realConfig.ornaments });
            const placed = placements.find(({ type }) => type === 'art');
            assert.deepEqual([placed.width, placed.height], [art.width * placed.step, art.height * placed.step], layout.id);
            assert.deepEqual(placeholders, [], layout.id);
            const frame = layout.elements.at(-1).unit * 3;
            const above = placed.y - frame;
            const below = layout.height - frame - (placed.y + placed.height);
            assert.ok(above >= 0 && above <= MAX_AIR_ABOVE, `${layout.id}: ${above} px of air between the top of the pair and the frame`);
            assert.ok(below >= GROUND_BELOW[layout.asset], `${layout.id}: ${below} px of ground under the pair`);
        }
    }
});
