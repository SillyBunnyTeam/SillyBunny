import { formatHex, srgbToOklab } from './pixel-colour.mjs';

const OPAQUE = 128;
const BIN_SHIFT = 2;
// Two colours this close in OKLab are one tone: the antialiasing between two tones, or a level of jitter inside one.
const SAME_TONE = 0.09;
// Only pixels this close to a tone's seed give its value, so antialiasing never drags a tone sideways.
const CORE = 0.03;
// A tone must cover at least this share of the opaque pixels, or it is a speck of antialiasing, not a tone.
const MIN_SHARE = 0.005;

const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

/**
 * The flat tones a picture is drawn in: the colours that most opaque pixels sit on, with near-duplicates merged.
 * Pixels that are at least half opaque count; the rest are background.
 * @param {import('./raster.mjs').Raster} raster
 * @param {{ maxTones?: number }} [options]
 * @returns {{ rgb: number[], hex: string, count: number, share: number }[]} the tones, most used first
 */
export function findTones(raster, { maxTones = 8 } = {}) {
    const bins = new Map();
    let opaque = 0;
    for (let at = 0; at < raster.data.length; at += 4) {
        if (raster.data[at + 3] < OPAQUE) {
            continue;
        }
        opaque++;
        const key = ((raster.data[at] >> BIN_SHIFT) << 16) | ((raster.data[at + 1] >> BIN_SHIFT) << 8) | (raster.data[at + 2] >> BIN_SHIFT);
        const bin = bins.get(key) ?? { count: 0, rgb: [(raster.data[at] >> BIN_SHIFT) << BIN_SHIFT, (raster.data[at + 1] >> BIN_SHIFT) << BIN_SHIFT, (raster.data[at + 2] >> BIN_SHIFT) << BIN_SHIFT] };
        bin.count++;
        bins.set(key, bin);
    }
    if (opaque === 0) {
        throw new Error('The picture has no opaque pixels, so it has no tones.');
    }

    const remaining = [...bins.values()].map((bin) => ({ ...bin, lab: srgbToOklab(bin.rgb) })).sort((a, b) => b.count - a.count);
    const clusters = [];
    while (remaining.length > 0) {
        const seed = remaining.shift();
        const members = [seed];
        for (let at = remaining.length - 1; at >= 0; at--) {
            if (distance(remaining[at].lab, seed.lab) < SAME_TONE) {
                members.push(...remaining.splice(at, 1));
            }
        }
        clusters.push({ seed, count: members.reduce((total, member) => total + member.count, 0) });
    }

    const kept = clusters.filter(({ count }) => count / opaque >= MIN_SHARE).sort((a, b) => b.count - a.count).slice(0, maxTones);
    const seeds = kept.map(({ seed }) => seed.lab);
    const sums = kept.map(() => ({ count: 0, channels: [[], [], []] }));
    for (let at = 0; at < raster.data.length; at += 4) {
        if (raster.data[at + 3] < OPAQUE) {
            continue;
        }
        const rgb = [raster.data[at], raster.data[at + 1], raster.data[at + 2]];
        const lab = srgbToOklab(rgb);
        const nearest = nearestIndex(seeds, lab);
        sums[nearest].count++;
        if (distance(seeds[nearest], lab) < CORE) {
            rgb.forEach((channel, index) => sums[nearest].channels[index].push(channel));
        }
    }
    return kept.map(({ seed }, index) => {
        const core = sums[index].channels[0].length > 0 ? sums[index].channels.map(median) : seed.rgb;
        return { rgb: core, hex: formatHex(core), count: sums[index].count, share: sums[index].count / opaque };
    }).sort((a, b) => b.count - a.count);
}

function nearestIndex(labs, lab) {
    let best = 0;
    let bestDistance = Infinity;
    for (const [index, candidate] of labs.entries()) {
        const gap = distance(candidate, lab);
        if (gap < bestDistance) {
            best = index;
            bestDistance = gap;
        }
    }
    return best;
}

/**
 * Puts the tone nearest to `hex` at exactly `hex`, so the brand colour is the brand colour and not the model's drift from it.
 * A tone that is not close to it is not the brand colour at all, so that is an error.
 * @param {{ rgb: number[], hex: string }[]} tones
 * @param {string} hex like #8b64aa
 * @param {number} [reach] how far in OKLab the nearest tone may be
 */
export function pinTone(tones, hex, reach = 0.08) {
    if (!/^#[0-9a-f]{6}$/i.test(hex)) {
        throw new Error(`The base tone must be a colour like #8b64aa, got "${hex}".`);
    }
    const rgb = [1, 3, 5].map((start) => parseInt(hex.slice(start, start + 2), 16));
    const pinned = srgbToOklab(rgb);
    const labs = tones.map((tone) => srgbToOklab(tone.rgb));
    const index = nearestIndex(labs, pinned);
    if (distance(labs[index], pinned) > reach) {
        throw new Error(`No tone of the picture is near ${hex}; the nearest is ${tones[index].hex}. Check that this is the right picture.`);
    }
    return tones.map((tone, at) => (at === index ? { ...tone, rgb, hex: hex.toLowerCase() } : tone));
}

/**
 * The picture redrawn in its tones only: each opaque pixel takes the nearest tone at full opacity, and every other pixel is
 * fully transparent. Antialiasing between two tones lands on one of them, and the near-transparent noise around a shape is gone.
 * @param {import('./raster.mjs').Raster} raster
 * @param {{ rgb: number[] }[]} tones
 * @returns {{ raster: import('./raster.mjs').Raster, toneIndex: Int8Array }} `toneIndex` is the tone of each pixel, -1 for background
 */
export function snapToTones(raster, tones) {
    if (tones.length === 0) {
        throw new Error('There are no tones to snap to.');
    }
    const labs = tones.map((tone) => srgbToOklab(tone.rgb));
    const data = Buffer.alloc(raster.data.length);
    const toneIndex = new Int8Array(raster.width * raster.height).fill(-1);
    const cache = new Map();
    for (let at = 0; at < raster.data.length; at += 4) {
        if (raster.data[at + 3] < OPAQUE) {
            continue;
        }
        const key = (raster.data[at] << 16) | (raster.data[at + 1] << 8) | raster.data[at + 2];
        if (!cache.has(key)) {
            cache.set(key, nearestIndex(labs, srgbToOklab([raster.data[at], raster.data[at + 1], raster.data[at + 2]])));
        }
        const index = cache.get(key);
        toneIndex[at / 4] = index;
        data.set([...tones[index].rgb, 255], at);
    }
    return { raster: { width: raster.width, height: raster.height, data }, toneIndex };
}
