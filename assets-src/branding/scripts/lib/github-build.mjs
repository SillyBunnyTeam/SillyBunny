import { contrastRatio, luminance, parseHex } from './github-colour.mjs';
import { drawArt, findArtProblems } from './github-art.mjs';
import { BACKDROP_TYPES, DECOR_TYPES } from './github-config.mjs';
import { drawCells, drawSparkles, moonCells } from './github-decor.mjs';
import { optimisePng } from './github-png.mjs';
import { opticalCentreY } from './github-align.mjs';
import { paintContactShadows } from './github-contact.mjs';
import { paintEdge } from './github-edge.mjs';
import { createRaster } from './raster.mjs';
import { framePicture, iconPicture, steppedPanel } from './github-shapes.mjs';
import { drawSubtitle } from './github-subtitle.mjs';
import { drawTitle } from './github-text.mjs';
import { blendOver, drawEmblem, drawPlate, drawWordmark } from './github-vector.mjs';

/** @typedef {import('./raster.mjs').Raster} Raster */
/** @typedef {{ type: string, x: number, y: number, width: number, height: number, step?: number, source?: string }} Placement */

/** Text must read at the WCAG level for body text, and the logo's body colour at the level for graphics. */
const MIN_TEXT_CONTRAST = 4.5;
const MIN_GRAPHIC_CONTRAST = 3;

/**
 * Where the top left corner of a box is, from the edge or centre it is pinned to. `right` and `bottom` are distances from those edges
 * to the box's edge, so a negative one pushes the box past the canvas (a bleed). `centerX` and `centerY` are the box's centre in canvas
 * pixels, and an odd size is placed so that the extra pixel falls right or down. `lineY` pins the box's optical line, `opticalY` pixels
 * below its top, which is the middle of the capitals of a text and of the lettering of the emblem.
 * @param {{ left?: number, right?: number, centerX?: number, top?: number, bottom?: number, centerY?: number, lineY?: number }} at
 * @param {{ width: number, height: number }} size
 * @param {{ width: number, height: number }} canvas
 * @param {number} [opticalY]
 */
export function placeBox(at, size, canvas, opticalY = size.height / 2) {
    const x = 'left' in at ? at.left : 'right' in at ? canvas.width - at.right - size.width : at.centerX - Math.floor(size.width / 2);
    if ('lineY' in at) {
        return { x, y: at.lineY - Math.round(opticalY) };
    }
    const y = 'top' in at ? at.top : 'bottom' in at ? canvas.height - at.bottom - size.height : at.centerY - Math.floor(size.height / 2);
    return { x, y };
}

const TEXT_TYPES = ['wordmark', 'title', 'subtitle'];
const isDecor = (element) => DECOR_TYPES.includes(element.type);
const isBackdrop = (element) => BACKDROP_TYPES.includes(element.type);

const overlap = (one, two) => one.x < two.x + two.width && two.x < one.x + one.width && one.y < two.y + two.height && two.y < one.y + one.height;
/** Boxes that hold several parts, such as the stars, clash only where a part does. */
const partsOf = (box) => box.parts ?? [box];
const intersects = (one, two) => partsOf(one).some((first) => partsOf(two).some((second) => overlap(first, second)));
const isInside = (box, canvas) => box.x >= 0 && box.y >= 0 && box.x + box.width <= canvas.width && box.y + box.height <= canvas.height;
const covers = (box, canvas) => box.x <= 0 && box.y <= 0 && box.x + box.width >= canvas.width && box.y + box.height >= canvas.height;

function solidCanvas(layout, colours) {
    const canvas = createRaster(layout.width, layout.height);
    if (layout.background !== null) {
        const { r, g, b } = parseHex(colours[layout.background]);
        for (let at = 0; at < canvas.data.length; at += 4) {
            canvas.data.set([r, g, b, 255], at);
        }
    }
    return canvas;
}

/**
 * The picture of one element, before it is placed. Stars are the one element that carries its own position, because they are
 * pinned by their points and not by an `at`.
 * @returns {Promise<{ picture: Raster, origin?: { x: number, y: number }, parts?: { x: number, y: number, width: number, height: number }[] }>}
 */
async function drawElement(element, context) {
    const drawn = await drawPicture(element, context);
    if (!element.edge) {
        return drawn;
    }
    const { colours } = context;
    const { outline, shadow } = element.edge;
    const edge = paintEdge(drawn.picture, {
        outline: outline ? { colour: colours[outline.colour], width: outline.width } : undefined,
        shadow: shadow ? { ...shadow, colour: colours[shadow.colour] } : undefined,
    });
    return { ...drawn, edge };
}

async function drawPicture(element, { sources, colours, icons, ornaments, canvas }) {
    switch (element.type) {
        case 'plate':
            return { picture: await drawPlate(sources.plateSvg, { size: element.size }) };
        case 'emblem':
            return { picture: await drawEmblem(sources.emblemSvg, { height: element.height }) };
        case 'wordmark':
            return { picture: await drawWordmark({ size: element.size, colour: colours[element.colour] }) };
        case 'title':
            return { picture: await drawTitle({ title: element.title, size: element.size, colour: colours[element.colour], maxWidth: element.maxWidth }) };
        case 'subtitle':
            return { picture: await drawSubtitle({ lines: element.lines, size: element.size, colour: colours[element.colour], align: element.align }) };
        case 'moon':
            return { picture: drawCells(moonCells(element.diameter, { bite: element.bite, lift: element.lift }), { unit: element.unit, colour: colours[element.colour] }) };
        case 'sparkles': {
            const { picture, x, y, boxes } = drawSparkles({ colour: colours[element.colour], unit: element.unit, points: element.points });
            return { picture, origin: { x, y }, parts: boxes };
        }
        case 'backdrop': {
            const plate = sources.backdrops[element.source];
            return { picture: element.mirror ? mirrorHorizontally(plate) : plate };
        }
        case 'frame': {
            const unit = element.unit;
            if (canvas.width % unit !== 0 || canvas.height % unit !== 0) {
                throw new Error(`The frame is built of blocks of ${unit} pixels, which do not divide the ${canvas.width}x${canvas.height} canvas.`);
            }
            const { picture, boxes } = framePicture({
                widthCells: canvas.width / unit,
                heightCells: canvas.height / unit,
                unit,
                layers: element.layers.map((layer) => ({ colour: colours[layer.colour], cells: layer.cells })),
                boss: {
                    ...element.boss,
                    outside: colours[element.boss.outside],
                    ornaments: element.boss.ornaments.map((name) => ({ rows: ornaments[name].rows, colours: Object.fromEntries(Object.entries(ornaments[name].colours).map(([symbol, colour]) => [symbol, colours[colour]])) })),
                },
            });
            return { picture, origin: { x: 0, y: 0 }, parts: boxes };
        }
        case 'bar': {
            const layers = element.layers.map((layer) => ({ ...layer, colour: colours[layer.colour] }));
            const studs = element.studs ? { ...element.studs, colour: colours[element.studs.colour] } : undefined;
            return { picture: steppedPanel({ widthCells: element.widthCells, heightCells: element.heightCells, unit: element.unit, layers, studs }) };
        }
        case 'icon': {
            const { rows, accent } = icons.shapes[element.icon];
            const palette = icons.palettes[element.palette];
            const symbols = { o: colours[palette.o], l: colours[palette.l], c: colours[palette.c], ...(accent ? { a: colours[accent] } : {}) };
            return { picture: iconPicture({ rows, colours: symbols, unit: element.unit }) };
        }
        default:
            return { picture: sources.art[element.source] };
    }
}

function mirrorHorizontally(picture) {
    const mirrored = createRaster(picture.width, picture.height);
    for (let y = 0; y < picture.height; y++) {
        for (let x = 0; x < picture.width; x++) {
            mirrored.data.set(picture.data.subarray((y * picture.width + x) * 4, (y * picture.width + x) * 4 + 4), (y * picture.width + picture.width - 1 - x) * 4);
        }
    }
    return mirrored;
}

/** True when the layout has a picture or a panel under its text, so that the background colour is not what the text is read against. */
const hasSurface = (layout) => layout.elements.some(isBackdrop);

function checkContrast(layout, element, { colours, icons }) {
    if (layout.background === null || hasSurface(layout)) {
        return;
    }
    const background = colours[layout.background];
    const fail = (what, ratio, minimum, advice = '') => {
        throw new Error(`Layout "${layout.id}": ${what} on ${layout.background} has a contrast of ${ratio.toFixed(2)}, under ${minimum}.${advice}`);
    };
    if (TEXT_TYPES.includes(element.type) && contrastRatio(colours[element.colour], background) < MIN_TEXT_CONTRAST) {
        fail(`the ${element.type} in ${element.colour}`, contrastRatio(colours[element.colour], background), MIN_TEXT_CONTRAST);
    }
    if (element.type === 'emblem' && contrastRatio(colours.logo, background) < MIN_GRAPHIC_CONTRAST) {
        fail('the emblem', contrastRatio(colours.logo, background), MIN_GRAPHIC_CONTRAST, ' Put it on a plate or on another background.');
    }
    if (element.type === 'icon') {
        const outline = colours[icons.palettes[element.palette].o];
        if (contrastRatio(outline, background) < MIN_GRAPHIC_CONTRAST) {
            fail(`the outline of the ${element.icon} icon`, contrastRatio(outline, background), MIN_GRAPHIC_CONTRAST);
        }
    }
}

/** The colour that a text or an emblem is drawn in, and the contrast that it needs against what is next to it. */
const inkColourAndMinimum = (element, colours) => (element.type === 'emblem'
    ? { colour: colours.logo, minimum: MIN_GRAPHIC_CONTRAST, what: 'the emblem' }
    : { colour: colours[element.colour], minimum: MIN_TEXT_CONTRAST, what: `the ${element.type} in ${element.colour}` });

/**
 * The ink touches its outline all along its edge, so the two must contrast with each other at the level that the ink needs. The logo plate
 * has a picture and no ink colour; its keyline is held to its contrast by test/github-layouts.test.mjs.
 */
function checkEdgeContrast(layout, element, colours) {
    if (!element.edge?.outline || element.type === 'plate') {
        return;
    }
    const { colour, minimum, what } = inkColourAndMinimum(element, colours);
    const ratio = contrastRatio(colour, colours[element.edge.outline.colour]);
    if (ratio < minimum) {
        throw new Error(`Layout "${layout.id}": ${what} has a contrast of ${ratio.toFixed(2)} with its outline in ${element.edge.outline.colour}, under ${minimum}.`);
    }
}

/** At most this share of the pixels that text or a graphic lies on may be below the contrast it needs, so a speck in a picture is let through. */
const MAX_LOW_CONTRAST_SHARE = 0.02;

/** What a text, an emblem or an icon is drawn in and how much contrast it needs, or undefined for an element that is neither. */
function inkRule(element, { colours, icons }) {
    if (TEXT_TYPES.includes(element.type)) {
        return { colour: colours[element.colour], minimum: MIN_TEXT_CONTRAST, what: `the ${element.type} in ${element.colour}` };
    }
    if (element.type === 'emblem') {
        return { colour: colours.logo, minimum: MIN_GRAPHIC_CONTRAST, what: 'the emblem' };
    }
    if (element.type === 'icon') {
        return { colour: colours[icons.palettes[element.palette].o], minimum: MIN_GRAPHIC_CONTRAST, what: `the outline of the ${element.icon} icon`, onlyColour: true };
    }
    return undefined;
}

/** The contrast of one colour against each of a list of canvas pixels, as the share of them under `minimum`, the median, and the worst one. */
function measureAgainstCanvas(canvas, colour, spots, minimum) {
    const colourLuminance = luminance(colour);
    const cache = new Map();
    const ratios = [];
    let low = 0;
    let worst = { ratio: Infinity, x: 0, y: 0 };
    for (const [x, y] of spots) {
        const under = (y * canvas.width + x) * 4;
        const key = (canvas.data[under] << 16) | (canvas.data[under + 1] << 8) | canvas.data[under + 2];
        if (!cache.has(key)) {
            const [light, dark] = [colourLuminance, luminance({ r: canvas.data[under], g: canvas.data[under + 1], b: canvas.data[under + 2] })].sort((one, two) => two - one);
            cache.set(key, (light + 0.05) / (dark + 0.05));
        }
        const ratio = cache.get(key);
        ratios.push(ratio);
        if (ratio < minimum) {
            low += 1;
            worst = ratio < worst.ratio ? { ratio, x, y } : worst;
        }
    }
    ratios.sort((one, two) => one - two);
    return { pixels: spots.length, lowShare: spots.length > 0 ? low / spots.length : 0, median: ratios[Math.floor(ratios.length / 2)] ?? 0, worst };
}

/**
 * Reads the contrast of a text, an emblem or an icon against the pixels it is about to be drawn over (the picture, the panel, whatever
 * is under it), not against a flat colour. Throws when more than MAX_LOW_CONTRAST_SHARE of its ink lies on pixels that are too close in tone.
 * An outline is measured the same way against the pixels under it, and reported, but not held to a level: its job is to part the ink
 * from a busy picture, and a light outline on a light sky is not needed there.
 * @returns {{ ink: ReturnType<typeof measureAgainstCanvas>, outline?: ReturnType<typeof measureAgainstCanvas> } | undefined}
 */
function checkContrastOverPixels(layout, element, { canvas, picture, box, colours, icons, edge }) {
    const rule = inkRule(element, { colours, icons });
    if (!rule || !hasSurface(layout)) {
        return undefined;
    }
    const ink = parseHex(rule.colour);
    const onCanvas = (x, y) => x >= 0 && y >= 0 && x < canvas.width && y < canvas.height;
    const inkSpots = [];
    for (let y = 0; y < picture.height; y++) {
        for (let x = 0; x < picture.width; x++) {
            const at = (y * picture.width + x) * 4;
            const isInk = rule.onlyColour ? picture.data[at + 3] === 255 && picture.data[at] === ink.r && picture.data[at + 1] === ink.g && picture.data[at + 2] === ink.b : picture.data[at + 3] >= 128;
            if (isInk && onCanvas(box.x + x, box.y + y)) {
                inkSpots.push([box.x + x, box.y + y]);
            }
        }
    }
    const inkReading = measureAgainstCanvas(canvas, ink, inkSpots, rule.minimum);
    // With an outline, the ink is read against the outline all along its edge (checked beside the colours), not against the picture under it.
    if (!element.edge?.outline && inkReading.pixels > 0 && inkReading.lowShare > MAX_LOW_CONTRAST_SHARE) {
        throw new Error(`Layout "${layout.id}": ${rule.what} has a contrast under ${rule.minimum} against ${(100 * inkReading.lowShare).toFixed(1)}% of the pixels it lies on (the worst is ${inkReading.worst.ratio.toFixed(2)} at ${inkReading.worst.x},${inkReading.worst.y}). Put it on a surface of its own.`);
    }
    if (!edge || !element.edge.outline) {
        return { ink: inkReading };
    }
    const outlineSpots = [];
    for (let y = 0; y < edge.picture.height; y++) {
        for (let x = 0; x < edge.picture.width; x++) {
            const underX = box.x - edge.reach + x;
            const underY = box.y - edge.reach + y;
            if (edge.ring[y * edge.picture.width + x] && onCanvas(underX, underY)) {
                outlineSpots.push([underX, underY]);
            }
        }
    }
    return { ink: inkReading, outline: measureAgainstCanvas(canvas, parseHex(colours[element.edge.outline.colour]), outlineSpots, MIN_GRAPHIC_CONTRAST) };
}

/**
 * Decoration may sit behind the art and beside other decoration, but never under the logo or the text. A backdrop picture or a bar is the
 * surface that all of those are set on, so it may lie under anything. The frame is the one thing that nothing may touch: it surrounds all
 * the contents, and only the backdrop picture, which runs under it, may overlap it.
 */
function mayOverlap(one, two) {
    if (one.type === 'frame' || two.type === 'frame') {
        return one.type === 'backdrop' || two.type === 'backdrop';
    }
    return isBackdrop(one) || isBackdrop(two) || (isDecor(one) && (isDecor(two) || two.type === 'art')) || (isDecor(two) && one.type === 'art');
}

/** The pictures that are copied in whole blocks of `step` pixels, and checked to be even blocks afterwards. */
const BLOCK_TYPES = ['art', 'backdrop'];

/**
 * The backdrop picture first, then bars, then decoration, then logo, text and icons, then the art so that its sticker outline lies over
 * all of it, and the frame last.
 */
const paintOrder = (element) => (element.type === 'backdrop' ? 0 : element.type === 'bar' ? 1 : isDecor(element) ? 2 : element.type === 'art' ? 4 : element.type === 'frame' ? 5 : 3);

/**
 * Darkens the ground under the feet and the props of an art element from the contacts that the config lists for the scene. The blocks of
 * the shadow are those of the backdrop (or, with none, of the art's own pixels). A shadow multiplies whatever is under it, so it is cast
 * on the ground alone, before a bar, a text or the logo is painted, and cannot darken any of them.
 */
function castContactShadows(canvas, { layout, element, picture, box, backdrop, colours, contacts }) {
    const { shadow } = element;
    const listed = contacts?.[element.source];
    if (!listed) {
        throw new Error(`Layout "${layout.id}": the art "${element.source}" has a contact shadow but no contacts are listed for it.`);
    }
    const outside = listed.find(({ x1, y }) => x1 >= picture.width || y >= picture.height);
    if (outside) {
        throw new Error(`Layout "${layout.id}": the contact of "${element.source}" at columns ${outside.x0}-${outside.x1}, row ${outside.y} is outside the ${picture.width}x${picture.height} art.`);
    }
    const grid = backdrop ? { x: backdrop.box.x, y: backdrop.box.y, step: backdrop.element.step } : { x: box.x, y: box.y, step: element.step };
    const { cells } = paintContactShadows(canvas, { contacts: listed, box, step: element.step, grid, tint: colours[shadow.tint], strengths: shadow.strengths, bands: shadow.bands, inset: shadow.inset, offset: shadow.offset });
    return { contacts: listed, cells };
}

/**
 * Builds one asset: a solid canvas, the vector layers drawn crisp at their own pixel size, then the snapped art copied in whole blocks.
 * Throws when a layout puts two things on each other, leaves the canvas without saying it bleeds, reads badly against what lies under its
 * text, or ends with an art pixel that is not an even block. A backdrop must cover the canvas, so that no strip of the bare background
 * shows. Art listed in `sources.placeholders` is a stand-in; the names of those the layout draws come back as `placeholders`.
 * @param {import('./github-config.mjs').Layout} layout a layout of the parsed config
 * @param {{ colours: Record<string, string>, icons?: { palettes: object, shapes: object }, ornaments?: Record<string, object>, sources: { plateSvg: string, emblemSvg: string, art: Record<string, Raster>, contacts?: Record<string, import('./github-contact.mjs').Shadowed[]>, backdrops?: Record<string, Raster>, placeholders?: string[] } }} context
 * @returns {Promise<{ raster: Raster, png: Buffer, placements: Placement[], placeholders: string[] }>}
 */
export async function buildLayout(layout, { colours, sources, icons = { palettes: {}, shapes: {} }, ornaments = {} }) {
    const canvas = solidCanvas(layout, colours);
    const drawn = [];
    for (const element of layout.elements) {
        checkContrast(layout, element, { colours, icons });
        checkEdgeContrast(layout, element, colours);
        const { picture, origin, parts, edge } = await drawElement(element, { sources, colours, icons, ornaments, canvas });
        // The box of a snapped picture is its scaled size, which the picture itself does not have yet.
        const size = BLOCK_TYPES.includes(element.type) ? { width: picture.width * element.step, height: picture.height * element.step } : picture;
        const box = { ...(origin ?? placeBox(element.at, size, canvas, 'lineY' in (element.at ?? {}) ? opticalCentreY(element, picture) : undefined)), width: size.width, height: size.height, ...(parts ? { parts } : {}) };
        if (!element.bleed && !isInside(box, canvas)) {
            throw new Error(`Layout "${layout.id}": the ${element.type} at ${box.x},${box.y} (${box.width}x${box.height}) leaves the ${canvas.width}x${canvas.height} canvas. Set "bleed": true on a picture that is meant to run off an edge.`);
        }
        if (element.type === 'backdrop' && !covers(box, canvas)) {
            throw new Error(`Layout "${layout.id}": the backdrop at ${box.x},${box.y} (${box.width}x${box.height}) does not cover the ${canvas.width}x${canvas.height} canvas, so a strip of the bare background would show. Crop the plate larger or change its step.`);
        }
        const clash = drawn.find((other) => !mayOverlap(other.element, element) && intersects(other.box, box));
        if (clash) {
            throw new Error(`Layout "${layout.id}": the ${element.type} and the ${clash.element.type} overlap.`);
        }
        drawn.push({ element, picture, box, edge });
    }

    const placements = [];
    const shadowed = new Map();
    const paint = ({ element, picture, box, edge }) => {
        if (BLOCK_TYPES.includes(element.type)) {
            // Art may lie over what is already painted, so a transparent art pixel must show whatever lay there, not only the background.
            const before = { width: canvas.width, height: canvas.height, data: Buffer.from(canvas.data) };
            const placement = drawArt(canvas, picture, { step: element.step, x: box.x, y: box.y });
            const problems = findArtProblems(canvas, placement, picture, before);
            if (problems.length > 0) {
                throw new Error(`Layout "${layout.id}": ${problems.join('; ')}`);
            }
            const cast = shadowed.get(element);
            placements.push({ type: element.type, source: element.source, ...placement, ...(cast ? { contacts: cast.contacts, shadowCells: cast.cells } : {}) });
            return;
        }
        const contrast = checkContrastOverPixels(layout, element, { canvas, picture, box, colours, icons, edge });
        blendOver(canvas, edge ? edge.picture : picture, box.x - (edge?.reach ?? 0), box.y - (edge?.reach ?? 0));
        placements.push({ type: element.type, x: box.x, y: box.y, width: box.width, height: box.height, ...(contrast ? { contrast } : {}) });
    };
    const ordered = [...drawn].sort((one, two) => paintOrder(one.element) - paintOrder(two.element));
    const isGround = ({ element }) => element.type === 'backdrop';
    ordered.filter(isGround).forEach(paint);
    const ground = drawn.find(isGround);
    for (const { element, picture, box } of drawn.filter(({ element: candidate }) => candidate.shadow)) {
        shadowed.set(element, castContactShadows(canvas, { layout, element, picture, box, backdrop: ground, colours, contacts: sources.contacts }));
    }
    ordered.filter((entry) => !isGround(entry)).forEach(paint);
    const placeholders = [...new Set(layout.elements.filter(({ type, source }) => type === 'art' && sources.placeholders?.includes(source)).map(({ source }) => source))];
    return { raster: canvas, png: await optimisePng(canvas), placements, placeholders };
}
