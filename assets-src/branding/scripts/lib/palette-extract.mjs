import { formatHex, oklabToLinear, srgbToOklab } from './pixel-colour.mjs';
import { createRaster } from './raster.mjs';

const MIN_COLOURS = 24;
const MAX_COLOURS = 32;
const RESERVED = [
    { rgb: [255, 255, 255], role: 'sticker outline' },
    { rgb: [217, 212, 232], role: 'sticker rim' },
];
const RAMP_SIZE = 3;
const ITERATIONS = 15;
// Direction (OKLab hue, degrees) a ramp leans towards in its shadows and in its highlights, per the pixel style guide.
const SHADOW_TINT = { degrees: 285, strength: 0.03, lightness: -0.13 };
const HIGHLIGHT_TINT = { degrees: 95, strength: 0.025, lightness: 0.1 };
// The page is lavender-tinted near white; the sticker outline is white. Neither is a colour of the character.
const BACKGROUND_LIGHTNESS = 0.955;
const BACKGROUND_CHROMA = 0.035;

const lab = (rgb) => srgbToOklab(rgb);
const squared = (a, b) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;

/** Pulls the colour towards grey, keeping its lightness and hue, until it fits in sRGB. */
function fitGamut([lightness, a, b]) {
    let scale = 1;
    for (let step = 0; step < 24; step++) {
        const linear = oklabToLinear([lightness, a * scale, b * scale]);
        if (linear.every((channel) => channel >= -0.0005 && channel <= 1.0005)) {
            break;
        }
        scale *= 0.92;
    }
    return oklabToLinear([lightness, a * scale, b * scale]).map((linear) => {
        const clamped = Math.min(Math.max(linear, 0), 1);
        return Math.round(255 * (clamped <= 0.0031308 ? 12.92 * clamped : 1.055 * clamped ** (1 / 2.4) - 0.055));
    });
}

/** A lighter or darker tone of `base` that also leans towards a hue, which also shifts hue when the base is nearly grey. */
function tone(base, { degrees, strength, lightness }) {
    const radians = (degrees * Math.PI) / 180;
    const target = Math.min(0.98, Math.max(0.06, base[0] + lightness));
    return fitGamut([target, base[1] + strength * Math.cos(radians), base[2] + strength * Math.sin(radians)]);
}

/** Groups the sheet's colours: 5-bit bins first, then weighted k-means in OKLab, started from far-apart colours. */
function clusterColours(raster, wanted) {
    const bins = new Map();
    for (let at = 0; at < raster.data.length; at += 4) {
        if (raster.data[at + 3] < 128) {
            continue;
        }
        const rgb = [raster.data[at], raster.data[at + 1], raster.data[at + 2]];
        const [lightness, a, b] = lab(rgb);
        if (lightness > BACKGROUND_LIGHTNESS && Math.hypot(a, b) < BACKGROUND_CHROMA) {
            continue;
        }
        const key = ((rgb[0] >> 3) << 10) | ((rgb[1] >> 3) << 5) | (rgb[2] >> 3);
        const bin = bins.get(key) ?? { count: 0, sum: [0, 0, 0] };
        bin.count++;
        rgb.forEach((channel, c) => {
            bin.sum[c] += channel;
        });
        bins.set(key, bin);
    }
    const points = [...bins.entries()].sort((x, y) => x[0] - y[0]).map(([, bin]) => ({
        count: bin.count,
        weight: Math.sqrt(bin.count),
        lab: lab(bin.sum.map((total) => total / bin.count)),
    }));
    if (points.length === 0) {
        return [];
    }

    const centres = [points.reduce((best, point) => (point.count > best.count ? point : best)).lab];
    while (centres.length < Math.min(wanted, points.length)) {
        let next;
        let nextScore = -1;
        for (const point of points) {
            const score = Math.min(...centres.map((centre) => squared(centre, point.lab))) * point.count ** 0.1;
            if (score > nextScore) {
                next = point;
                nextScore = score;
            }
        }
        centres.push(next.lab);
    }

    let assignment = [];
    for (let round = 0; round < ITERATIONS; round++) {
        assignment = points.map((point) => centres.reduce((best, centre, index) => (squared(centre, point.lab) < squared(centres[best], point.lab) ? index : best), 0));
        centres.forEach((_, index) => {
            const members = points.filter((_point, at) => assignment[at] === index);
            const weight = members.reduce((sum, member) => sum + member.weight, 0);
            if (weight > 0) {
                centres[index] = [0, 1, 2].map((c) => members.reduce((sum, member) => sum + member.lab[c] * member.weight, 0) / weight);
            }
        });
    }
    return centres
        .map((centre, index) => ({ centre, pixels: points.reduce((sum, point, at) => sum + (assignment[at] === index ? point.count : 0), 0) }))
        .filter((cluster) => cluster.pixels > 0)
        .sort((x, y) => y.pixels - x.pixels);
}

/**
 * Proposes a draft palette from an approved illustrated sheet: the colour families it contains, each as a hue-shifted ramp
 * (shadow leaning towards violet, highlight towards warm yellow), plus the white outline and soft rim of the sticker look.
 * It is a starting point for the person who locks the palette, not a locked palette.
 * @param {import('./raster.mjs').Raster} raster
 * @param {{ colours?: number }} [options] 24 to 32 colours
 */
export function proposePalette(raster, { colours = 28 } = {}) {
    if (!Number.isInteger(colours) || colours < MIN_COLOURS || colours > MAX_COLOURS) {
        throw new Error(`A palette has ${MIN_COLOURS} to ${MAX_COLOURS} colours, got ${colours}.`);
    }
    const warnings = [];
    const familyCount = Math.floor((colours - RESERVED.length) / RAMP_SIZE);
    const clusters = clusterColours(raster, familyCount);

    const used = new Set(RESERVED.map(({ rgb }) => formatHex(rgb)));
    const unique = (labColour, shiftLightness) => {
        for (let attempt = 0; attempt < 12; attempt++) {
            const rgb = fitGamut([labColour[0] + shiftLightness * attempt * 0.01, labColour[1], labColour[2]]);
            if (!used.has(formatHex(rgb))) {
                used.add(formatHex(rgb));
                return rgb;
            }
        }
        return undefined;
    };
    const families = clusters.map(({ centre, pixels }, index) => {
        const base = unique(centre, 1);
        const shadowLab = lab(tone(centre, SHADOW_TINT));
        return {
            name: `family ${index + 1}`,
            pixels,
            base,
            shadow: unique(shadowLab, -1),
            highlight: unique(lab(tone(centre, HIGHLIGHT_TINT)), 1),
            deep: undefined,
            shadowLab,
        };
    });
    // Colours left over after the ramps become a deeper shade for the biggest families, which is the outline colour of that area.
    const spare = colours - RESERVED.length - families.length * RAMP_SIZE;
    for (const family of families.slice(0, Math.max(0, spare))) {
        family.deep = unique(lab(tone(family.shadowLab, SHADOW_TINT)), -1);
    }
    if (families.length < familyCount) {
        warnings.push(`The sheet holds only ${families.length} distinct colour families, so the palette has fewer colours than the ${colours} asked for.`);
    }

    const entries = RESERVED.map(({ rgb, role }) => ({ rgb, hex: formatHex(rgb), role }));
    for (const family of families) {
        for (const [part, rgb] of [['deep', family.deep], ['shadow', family.shadow], ['base', family.base], ['highlight', family.highlight]]) {
            if (rgb) {
                entries.push({ rgb, hex: formatHex(rgb), role: `${family.name} ${part}`, family: family.name });
            }
        }
    }
    return { colours: entries, families, warnings };
}

export const paletteToHex = (entries) => `${entries.map(({ hex }) => hex.slice(1)).join('\n')}\n`;

/** GIMP palette text; each colour carries its role as its name so the person locking the palette can see what it is for. */
export function paletteToGpl(name, entries) {
    const lines = entries.map(({ rgb, role }) => `${rgb.map((channel) => String(channel).padStart(3)).join(' ')} ${role}`);
    return `GIMP Palette\nName: ${name}\nColumns: 4\n#\n${lines.join('\n')}\n`;
}

/** One row of swatches for the reserved colours, then one row per family, so ramps can be judged by eye. */
export function renderPalettePreview({ colours, families }, { swatch = 16, gap = 4 } = {}) {
    const rows = [colours.slice(0, RESERVED.length), ...families.map((family) => colours.filter((entry) => entry.family === family.name))];
    const width = gap + 4 * (swatch + gap);
    const height = gap + rows.length * (swatch + gap);
    const raster = createRaster(width, height);
    for (let at = 0; at < raster.data.length; at += 4) {
        raster.data.set([58, 58, 66, 255], at);
    }
    rows.forEach((row, rowIndex) => {
        row.forEach((entry, column) => {
            const left = gap + column * (swatch + gap);
            const top = gap + rowIndex * (swatch + gap);
            for (let y = top; y < top + swatch; y++) {
                for (let x = left; x < left + swatch; x++) {
                    raster.data.set([...entry.rgb, 255], (y * width + x) * 4);
                }
            }
        });
    });
    return raster;
}
