import { circleCommands, transformCommands } from './geometry.mjs';
import { formatHex, oklabToLinear, srgbToOklab } from './pixel-colour.mjs';
import { formatNumber, serialisePath } from './vector-path.mjs';

/** @typedef {import('./geometry.mjs').PathCommand} PathCommand */

export const PLATE_SIDE = 1024;
// The lip is this share of the plate's height.
export const LIP_SHARE = 0.03;
// A superellipse |x|^n + |y|^n = 1 with n = 5 is the squircle that app icon shapes are drawn from: rounder than a rounded square
// with the same corner, and with no point where the curve starts to bend.
export const SQUIRCLE_EXPONENT = 5;
// The emblem fills this much of the plate: all but a 10% margin on each side of the square, and up to 94% of the circle's radius.
export const SQUARE_FILL = 0.8;
export const CIRCLE_FILL = 0.94;
// The plate colours in OKLCH, where lightness is 0 to 1 and chroma is how far from grey. The lip is a shade darker than the plate.
export const PLATE_STYLES = {
    L: { name: 'pale lavender', plate: { lightness: 0.95, chroma: 0.035 }, lip: { lightness: 0.89, chroma: 0.05 } },
    D: { name: 'deep plum', plate: { lightness: 0.22, chroma: 0.07 }, lip: { lightness: 0.17, chroma: 0.06 } },
};

const SEGMENTS_PER_QUADRANT = 16;

/** The hue of a colour in OKLCH, in degrees. */
export function hueOf(hex) {
    const rgb = [1, 3, 5].map((start) => Number.parseInt(hex.slice(start, start + 2), 16));
    const [, a, b] = srgbToOklab(rgb);
    return ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360;
}

/** An OKLCH colour as hex. A colour that sRGB cannot show keeps its lightness and hue and gets the most chroma that fits. */
export function oklchToHex(lightness, chroma, hue) {
    const radians = (hue * Math.PI) / 180;
    const inGamut = (c) => oklabToLinear([lightness, c * Math.cos(radians), c * Math.sin(radians)]).every((value) => value >= -0.0005 && value <= 1.0005);
    let [low, high] = [0, chroma];
    if (!inGamut(high)) {
        for (let round = 0; round < 30; round++) {
            const middle = (low + high) / 2;
            [low, high] = inGamut(middle) ? [middle, high] : [low, middle];
        }
    } else {
        low = chroma;
    }
    const linear = oklabToLinear([lightness, low * Math.cos(radians), low * Math.sin(radians)]);
    const gamma = (value) => 255 * (value <= 0.0031308 ? 12.92 * value : 1.055 * Math.max(value, 0) ** (1 / 2.4) - 0.055);
    return formatHex(linear.map((value) => Math.min(255, Math.max(0, gamma(Math.min(1, Math.max(0, value)))))));
}

/** The colours of each plate style, from the hue of `brandHex`. */
export function plateColours(brandHex) {
    const hue = hueOf(brandHex);
    return Object.fromEntries(Object.entries(PLATE_STYLES).map(([id, style]) => [id, {
        name: style.name,
        plate: oklchToHex(style.plate.lightness, style.plate.chroma, hue),
        lip: oklchToHex(style.lip.lightness, style.lip.chroma, hue),
    }]));
}

/**
 * A squircle centred on (cx, cy) whose edges are `half` from the centre, as one closed clockwise path of cubic curves. Each quadrant is
 * sixteen curves through exact points of the superellipse, with the tangent taken from its gradient, so the curve is within a few hundredths of a pixel on a 1024 plate.
 * @returns {PathCommand[]}
 */
export function squirclePath(cx, cy, half, exponent = SQUIRCLE_EXPONENT) {
    // Points go round by angle from the centre: the radius at an angle follows from |cos|^n + |sin|^n, which stays smooth at the four flat tops.
    const at = (angle) => {
        const [c, s] = [Math.cos(angle), Math.sin(angle)];
        const radius = half / (Math.abs(c) ** exponent + Math.abs(s) ** exponent) ** (1 / exponent);
        const [x, y] = [radius * c, radius * s];
        // The tangent runs along the curve, at right angles to the gradient (sign(x)|x|^(n-1), sign(y)|y|^(n-1)), clockwise on screen.
        const [gx, gy] = [Math.sign(x) * Math.abs(x / half) ** (exponent - 1), Math.sign(y) * Math.abs(y / half) ** (exponent - 1)];
        const length = Math.hypot(gx, gy);
        return { point: [cx + x, cy + y], tangent: [-gy / length, gx / length] };
    };
    const count = SEGMENTS_PER_QUADRANT * 4;
    const commands = [{ command: 'M', points: [at(0).point] }];
    for (let index = 0; index < count; index++) {
        const [from, to] = [at((index * 2 * Math.PI) / count), at(((index + 1) * 2 * Math.PI) / count)];
        // The handle length of the cubic that is exact for a circular arc between the two tangents, which a superellipse is close to over a short piece.
        const chord = Math.hypot(to.point[0] - from.point[0], to.point[1] - from.point[1]);
        const turn = Math.acos(Math.min(1, from.tangent[0] * to.tangent[0] + from.tangent[1] * to.tangent[1]));
        const handle = turn < 1e-9 ? chord / 3 : ((2 / 3) * Math.tan(turn / 4) * chord) / Math.sin(turn / 2);
        commands.push({
            command: 'C',
            points: [
                [from.point[0] + from.tangent[0] * handle, from.point[1] + from.tangent[1] * handle],
                [to.point[0] - to.tangent[0] * handle, to.point[1] - to.tangent[1] * handle],
                to.point,
            ],
        });
    }
    commands.push({ command: 'Z', points: [] });
    return commands;
}

/** The outline of a plate shape ('square' for the squircle, 'circle') filling a `side` square. */
export function plateOutline(shape, side = PLATE_SIDE) {
    if (shape === 'square') {
        return squirclePath(side / 2, side / 2, side / 2);
    }
    if (shape === 'circle') {
        return circleCommands({ cx: side / 2, cy: side / 2, r: side / 2 });
    }
    throw new Error(`Unknown plate shape "${shape}"; use square or circle.`);
}

/** The smallest radius of a circle around (`x`, y) that holds every point, for the best y, and that y. */
export function enclosingCircle(points, x) {
    if (points.length === 0) {
        throw new Error('There are no points to put a circle round.');
    }
    const radiusAt = (y) => Math.sqrt(points.reduce((farthest, [px, py]) => Math.max(farthest, (px - x) ** 2 + (py - y) ** 2), 0));
    let [low, high] = points.reduce(([lowest, highest], [, py]) => [Math.min(lowest, py), Math.max(highest, py)], [Infinity, -Infinity]);
    // The radius is convex in y, so the best y is found by narrowing the range.
    for (let round = 0; round < 60; round++) {
        const [a, b] = [low + (high - low) / 3, high - (high - low) / 3];
        [low, high] = radiusAt(a) < radiusAt(b) ? [low, b] : [a, high];
    }
    const y = (low + high) / 2;
    return { y, radius: radiusAt(y) };
}

/**
 * How big the emblem is on a plate and where. The dome's centre line goes on the plate's vertical axis. On the squircle the emblem's
 * larger side (its height, or twice its reach from the dome's axis) is 80% of the plate and its box is centred up and down; on the circle
 * the emblem's smallest enclosing circle about the dome's axis has 94% of the plate's radius. Both are moved up by half the lip, so the
 * emblem sits in the middle of the front face.
 * @param {{ shape: 'square' | 'circle', box: { x: number, y: number, width: number, height: number }, domeX: number, edge: number[][], side?: number }} request
 * `edge` is points on the emblem's outline (any that reach furthest are enough)
 * @returns {{ scale: number, x: number, y: number, centreY: number, radius?: number, lip: number }} `scale` is plate units per source pixel, (`x`, `y`) the source point that goes at the centre of the front face
 */
export function placeEmblem({ shape, box, domeX, edge, side = PLATE_SIDE }) {
    const lip = side * LIP_SHARE;
    const centreY = side / 2 - lip / 2;
    if (shape === 'square') {
        const reach = Math.max(domeX - box.x, box.x + box.width - domeX);
        const extent = Math.max(2 * reach, box.height);
        return { scale: (SQUARE_FILL * side) / extent, x: domeX, y: box.y + box.height / 2, centreY, lip };
    }
    if (shape === 'circle') {
        const { y, radius } = enclosingCircle(edge, domeX);
        return { scale: (CIRCLE_FILL * side) / 2 / radius, x: domeX, y, centreY, radius, lip };
    }
    throw new Error(`Unknown plate shape "${shape}"; use square or circle.`);
}

const pathElement = (fill, commands) => `<path fill="${fill}" d="${serialisePath(commands)}"/>`;

/**
 * A plate with the emblem on it as an SVG, `side` units square. The plate is drawn in its lip colour, and over it the same outline moved
 * up by the lip and cut to the first, in the plate colour, so the lip is a crescent along the bottom edge. The SB cut-outs show the plate colour.
 * The outline is written once and used three times, which keeps the file small. The cut is on a group of its own, because a clip is in the
 * coordinates of the element that uses it and the raised outline has moved.
 * @param {{ shape: 'square' | 'circle', colours: { plate: string, lip: string }, layers: { fill: string, commands: PathCommand[] }[], placement: ReturnType<typeof placeEmblem>, side?: number }} request
 */
export function plateSvg({ shape, colours, layers, placement, side = PLATE_SIDE }) {
    const outline = serialisePath(plateOutline(shape, side));
    const emblem = layers.map(({ fill, commands }) => pathElement(fill, transformCommands(commands, placement.scale, side / 2 - placement.x * placement.scale, placement.centreY - placement.y * placement.scale)));
    const lift = formatNumber(-placement.lip, 2);
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${side} ${side}"><defs><path id="o" d="${outline}"/><clipPath id="c"><use href="#o"/></clipPath></defs><use href="#o" fill="${colours.lip}"/><g clip-path="url(#c)"><use href="#o" fill="${colours.plate}" y="${lift}"/></g>${emblem.join('')}</svg>\n`;
}
