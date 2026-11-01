import { dilateMask, labelComponents, runLengths, splitThinParts } from './shape-ops.mjs';
import { srgbToOklab } from './pixel-colour.mjs';

// What counts as a thin part (the lines and their dots), as a share of the emblem's longer side. The lines are about 2% of it,
// the dots and the ears and dome a good deal more, so the window sits between the two.
export const THIN_SHARE = 0.025;
// Pieces smaller than this are leftovers, not a line with its dot.
const MIN_PART_AREA = 200;
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

/**
 * The tone roles of a three tone logo: the base tone is the one given, the dark one is the darkest of the others and the light
 * one the lightest. Anything but three tones is not a logo this shading knows.
 * @param {{ rgb: number[], hex: string }[]} tones
 * @param {string} baseHex
 * @returns {{ base: number, dark: number, light: number }} indexes into `tones`
 */
export function toneRoles(tones, baseHex) {
    if (tones.length !== 3) {
        throw new Error(`Shading needs a logo of three tones (dark, base, light); this one has ${tones.length}: ${tones.map(({ hex }) => hex).join(' ')}.`);
    }
    const base = tones.findIndex(({ hex }) => hex === baseHex.toLowerCase());
    if (base < 0) {
        throw new Error(`The base tone ${baseHex} is not one of the tones.`);
    }
    const others = tones.map((_, index) => index).filter((index) => index !== base).sort((a, b) => srgbToOklab(tones[a].rgb)[0] - srgbToOklab(tones[b].rgb)[0]);
    return { base, dark: others[0], light: others[1] };
}

/**
 * Finds the lines and their dots: the pieces of the picture that are not the ears and the dome. The picture is opened with a window
 * a little wider than the lines, which leaves the ears and the dome (and the dots, cut off from them once their lines are gone);
 * whatever the opening removes, less the pieces too small to be a line, is the lines. The window is wider than a line, so the line
 * is removed whole, but the dome and ears keep the first few pixels of each line (a stub) where they were rounded back.
 * The `zone` is the lines plus those stubs, so the shading runs right up to the dome.
 * @param {import('./raster.mjs').Raster} raster
 * @param {number} thinWidth
 * @returns {{ zone: Uint8Array, thin: Uint8Array, body: Uint8Array, parts: { area: number, box: { x: number, y: number, width: number, height: number } }[], radius: number }}
 */
export function isolateLines(raster, thinWidth) {
    const { width, height } = raster;
    const { thin, body, core, radius } = splitThinParts(raster, { thinWidth });
    const { labels, areas } = labelComponents(thin, width, height);
    const boxes = areas.map(() => ({ left: width, top: height, right: -1, bottom: -1 }));
    labels.forEach((label, at) => {
        if (label > 0) {
            const box = boxes[label - 1];
            const x = at % width;
            const y = (at - x) / width;
            box.left = Math.min(box.left, x);
            box.right = Math.max(box.right, x);
            box.top = Math.min(box.top, y);
            box.bottom = Math.max(box.bottom, y);
        }
    });
    const parts = areas.flatMap((area, index) => (area >= MIN_PART_AREA ? [{ area, box: { x: boxes[index].left, y: boxes[index].top, width: boxes[index].right - boxes[index].left + 1, height: boxes[index].bottom - boxes[index].top + 1 } }] : []));
    const keptLabels = new Set(areas.flatMap((area, index) => (area >= MIN_PART_AREA ? [index + 1] : [])));
    const lines = Uint8Array.from(labels, (label) => (keptLabels.has(label) ? 1 : 0));
    const nearLines = dilateMask(lines, width, height, radius + 1);
    const zone = Uint8Array.from(lines, (inLine, at) => (inLine === 1 || (body[at] === 1 && core[at] === 0 && nearLines[at] === 1) ? 1 : 0));
    return { zone, thin: lines, body, parts, radius };
}

/**
 * How thick the lines are: for each line pixel the shorter of the horizontal and vertical stretch of picture through it, and the
 * most common of those. The lines run far longer than the dots are wide, so they set the mode, which the dots would pull a median up.
 */
export function lineThickness(lines, mask, width, height) {
    const horizontal = runLengths(mask, width, height, true);
    const vertical = runLengths(mask, width, height, false);
    const thickness = [];
    lines.forEach((inLine, at) => {
        if (inLine === 1) {
            thickness.push(Math.min(horizontal[at], vertical[at]));
        }
    });
    if (thickness.length === 0) {
        throw new Error('There are no lines to measure.');
    }
    const counts = new Map();
    for (const value of thickness) {
        counts.set(value, (counts.get(value) ?? 0) + 1);
    }
    return [...counts].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0][0];
}

/**
 * The shading the picture already has, in source pixels: the dark band along the dome's lower edge, the light band along its top,
 * and the light highlight along the outer edge of the tall ear (across the edge, not along the row).
 * @param {{ toneIndex: Int8Array, width: number, height: number, roles: { base: number, dark: number, light: number }, dome: { left: number, right: number } }} picture
 */
export function measureShading({ toneIndex, width, height, roles, dome }) {
    const at = (x, y) => toneIndex[y * width + x];
    let top = height;
    let bottom = -1;
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            if (at(x, y) >= 0) {
                top = Math.min(top, y);
                bottom = y;
            }
        }
    }
    if (bottom < 0) {
        throw new Error('The picture is empty.');
    }
    const emblemHeight = bottom - top + 1;
    const runFrom = (x, y0, step, tone) => {
        let count = 0;
        for (let y = y0; y >= 0 && y < height && at(x, y) === tone; y += step) {
            count++;
        }
        return count;
    };
    const dark = [];
    const light = [];
    for (let x = dome.left + 30; x < dome.right - 30; x++) {
        let columnTop = -1;
        let columnBottom = -1;
        for (let y = 0; y < height; y++) {
            if (at(x, y) >= 0) {
                columnTop = columnTop < 0 ? y : columnTop;
                columnBottom = y;
            }
        }
        if (columnBottom < 0) {
            continue;
        }
        dark.push(runFrom(x, columnBottom, -1, roles.dark));
        // Under an ear the top of the column is the ear, not the dome.
        if (columnTop > bottom - 0.4 * emblemHeight) {
            light.push(runFrom(x, columnTop, 1, roles.light));
        }
    }

    const ear = [];
    const edgeOf = (y) => {
        let x = 0;
        while (x < width && at(x, y) < 0) {
            x++;
        }
        while (x < width - 1 && at(x + 1, y) >= 0) {
            x++;
        }
        return x;
    };
    for (let y = Math.round(top + 0.15 * emblemHeight); y <= top + 0.33 * emblemHeight; y += 4) {
        const edge = edgeOf(y);
        const across = (edgeOf(y + 8) - edgeOf(y - 8)) / 16;
        let run = 0;
        for (let x = edge; x >= 0 && at(x, y) === roles.light; x--) {
            run++;
        }
        ear.push(run / Math.sqrt(1 + across * across));
    }
    return { domeDark: median(dark), domeLight: median(light), earLight: median(ear), samples: { dark: dark.length, light: light.length, ear: ear.length } };
}

/**
 * Shades the lines and dots in the logo's own tones, light from above like the dome. In `zone`, a base tone pixel becomes dark when
 * the pixel `kDark` rows below it is not drawn (the line minus the line shifted up by kDark: the lower edge), and, with `kLight`,
 * light when the pixel `kLight` rows above it is not drawn (the upper edge). Dark wins where the two meet.
 * @param {{ toneIndex: Int8Array, width: number, height: number, zone: Uint8Array, roles: { base: number, dark: number, light: number }, kDark: number, kLight?: number }} request
 * @returns {{ toneIndex: Int8Array, darkened: number, lightened: number }}
 */
export function shadeLines({ toneIndex, width, height, zone, roles, kDark, kLight = 0 }) {
    if (!Number.isInteger(kDark) || kDark < 1 || !Number.isInteger(kLight) || kLight < 0) {
        throw new Error(`The band widths must be whole numbers of pixels (dark 1 or more, light 0 or more); got ${kDark} and ${kLight}.`);
    }
    const out = Int8Array.from(toneIndex);
    const drawn = (x, y) => y >= 0 && y < height && toneIndex[y * width + x] >= 0;
    let darkened = 0;
    let lightened = 0;
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const at = y * width + x;
            if (zone[at] === 0 || toneIndex[at] !== roles.base) {
                continue;
            }
            if (!drawn(x, y + kDark)) {
                out[at] = roles.dark;
                darkened++;
            } else if (kLight > 0 && !drawn(x, y - kLight)) {
                out[at] = roles.light;
                lightened++;
            }
        }
    }
    return { toneIndex: out, darkened, lightened };
}

/** The picture redrawn from a tone index: each pixel in its tone at full opacity, background transparent. */
export function rasterFromTones(toneIndex, width, height, tones) {
    const data = Buffer.alloc(width * height * 4);
    toneIndex.forEach((tone, at) => {
        if (tone >= 0) {
            data.set([...tones[tone].rgb, 255], at * 4);
        }
    });
    return { width, height, data };
}
