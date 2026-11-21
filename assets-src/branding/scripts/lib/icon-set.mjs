import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { encodeIco, readIco } from './ico.mjs';
import { coverageDraft, platformSvg, reachFromCentre, renderPng } from './icon-render.mjs';
import { formatHex } from './pixel-colour.mjs';
import { applyPixelPatch, listedPixels } from './pixel-patch.mjs';
import { encodePng } from './raster.mjs';

// The emblem's lines show from this size up; below it the no-lines files are used.
export const LINES_FROM = 64;
// These sizes are drawn by hand: an area-coverage draft with a pixel-fix patch on top.
export const HAND_FIXED_SIZES = [16, 32];
// The sizes drafted by area coverage. 24 and 48 are only for comparison.
export const DRAFT_SIZES = [16, 24, 32, 48];
export const ICON_SIZES = [16, 24, 32, 48, 64, 96, 128, 256, 512];
export const APPLE_SIZES = [57, 72, 114, 144, 180, 192, 512];
export const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];
export const ICO_FILES = ['favicon.ico', 'st.ico', 'st-launcher.ico'];
export const BRAND_SIZES = [16, 32, 48, 64];
export const BRAND_FOLDER = 'img/sillybunny';
export const LOGO_PNG_SIZE = 256;
export const MASKABLE_SIZE = 512;
export const MASKABLE_PATH = `${BRAND_FOLDER}/maskable-${MASKABLE_SIZE}.png`;

/** Whether an icon of this size draws the emblem's lines. */
export const hasLines = (size) => size >= LINES_FROM;

/** The colours an SVG paints with: every #rrggbb in it, lower case. */
export const svgTones = (svg) => [...new Set((svg.match(/#[0-9a-f]{6}\b/gi) ?? []).map((tone) => tone.toLowerCase()))];

/**
 * The draft of a hand-fixed size with its pixel-fix on top. The fix is a list of absolute colours made against one draft, so it is refused
 * when it no longer fits this one (the logo moved or was redrawn); a mix of the new draft and the old fix would ship as a broken icon.
 * Two things must hold: every pixel the fix lists really changes, and everything but the outer eighth is solid and in a tone of the logo.
 * @param {{ size: number, draft: import('./raster.mjs').Raster, ops: ReturnType<import('./pixel-patch.mjs').parsePixelPatch>, tones: string[] }} fix
 * @returns {{ raster: import('./raster.mjs').Raster, changed: number }}
 */
export function applyHandFix({ size, draft, ops, tones }) {
    const { raster, changed } = applyPixelPatch(draft, ops);
    const listed = listedPixels(ops);
    if (changed !== listed) {
        throw new Error(`The ${size} px pixel-fix lists ${listed} pixels but changes ${changed}, so it was made for another draft. Redo it against the current logo.`);
    }
    const margin = size / 8;
    for (let y = margin; y < size - margin; y++) {
        for (let x = margin; x < size - margin; x++) {
            const at = (y * size + x) * 4;
            const tone = formatHex([...raster.data.subarray(at, at + 3)]);
            if (raster.data[at + 3] !== 255 || !tones.includes(tone)) {
                throw new Error(`The ${size} px icon has ${tone} at alpha ${raster.data[at + 3]} in pixel ${x},${y}, which is not a solid tone of the logo (${tones.join(', ')}). The pixel-fix does not fit the current draft.`);
            }
        }
    }
    return { raster, changed };
}

/**
 * Every file the icon set writes, relative to `public/`, in write order.
 * `plate` is the squircle plate with transparent corners, `platform` is the plate colour edge to edge with no alpha, `svg` is a copy of the plate SVG,
 * and `ico` holds the plate pictures of `ICO_SIZES`. `replaces` marks files that exist already and keep their name and size.
 * @returns {{ path: string, kind: 'svg' | 'plate' | 'platform' | 'ico', size?: number, replaces: boolean }[]}
 */
export function planTargets() {
    const named = (path, kind, size, replaces = true) => ({ path, kind, size, replaces });
    return [
        { path: `${BRAND_FOLDER}/logo.svg`, kind: 'svg', replaces: false },
        ...BRAND_SIZES.map((size) => named(`${BRAND_FOLDER}/logo-${size}.png`, 'plate', size, false)),
        named(MASKABLE_PATH, 'platform', MASKABLE_SIZE, false),
        ...ICO_FILES.map((file) => ({ path: file, kind: 'ico', replaces: true })),
        named('img/logo.png', 'plate', LOGO_PNG_SIZE),
        ...ICON_SIZES.map((size) => named(`img/icon-${size}x${size}.png`, 'plate', size)),
        ...APPLE_SIZES.map((size) => named(`img/apple-icon-${size}x${size}.png`, 'platform', size)),
    ];
}

/**
 * The picture of every target as bytes.
 * @param {{ svgs: { plate: string, plateNolines: string, emblem: string, emblemNolines: string }, patches: Record<number, ReturnType<import('./pixel-patch.mjs').parsePixelPatch>> }} sources
 * @returns {Promise<Map<string, Buffer>>} path (relative to public/) to file bytes
 */
export async function buildIconSet({ svgs, patches }) {
    const missing = HAND_FIXED_SIZES.filter((size) => !patches[size]);
    if (missing.length > 0) {
        throw new Error(`The ${missing.join(' and ')} px icons need a pixel-fix patch each.`);
    }
    const platformSvgs = {
        lines: platformSvg({ plate: svgs.plate, emblem: svgs.emblem, reach: await reachFromCentre(svgs.emblem) }),
        nolines: platformSvg({ plate: svgs.plateNolines, emblem: svgs.emblemNolines, reach: await reachFromCentre(svgs.emblemNolines) }),
    };
    const tones = svgTones(svgs.plateNolines);
    const plateCache = new Map();
    const plateIcon = (size) => {
        if (!plateCache.has(size)) {
            plateCache.set(size, (async () => {
                if (HAND_FIXED_SIZES.includes(size)) {
                    return encodePng(applyHandFix({ size, draft: await coverageDraft(svgs.plateNolines, size), ops: patches[size], tones }).raster);
                }
                return renderPng(hasLines(size) ? svgs.plate : svgs.plateNolines, size);
            })());
        }
        return plateCache.get(size);
    };
    const platformIcon = (size) => renderPng(hasLines(size) ? platformSvgs.lines : platformSvgs.nolines, size, { opaque: true });
    const make = {
        svg: async () => Buffer.from(svgs.plate),
        plate: ({ size }) => plateIcon(size),
        platform: ({ size }) => platformIcon(size),
        ico: async () => encodeIco(await Promise.all(ICO_SIZES.map(async (size) => ({ size, png: await plateIcon(size) })))),
    };
    const files = new Map();
    for (const target of planTargets()) {
        files.set(target.path, await make[target.kind](target));
    }
    return files;
}

/**
 * Compares the files that are replaced in place, and the icons the web manifest names, with what the set will write. Anything that would
 * change a name or a size is a problem, because the pages and the manifest point at these files.
 * @param {string} publicDir
 * @returns {Promise<string[]>} one line per problem; empty when everything matches
 */
export async function findPublicMismatches(publicDir) {
    const problems = [];
    const targets = planTargets();
    for (const target of targets.filter(({ replaces }) => replaces)) {
        const path = join(publicDir, target.path);
        if (!existsSync(path)) {
            problems.push(`${target.path} is missing from ${publicDir}, so there is nothing to replace.`);
            continue;
        }
        if (target.kind === 'ico') {
            const sizes = readIco(readFileSync(path)).map(({ width }) => width).sort((a, b) => a - b);
            if (sizes.join() !== ICO_SIZES.join()) {
                problems.push(`${target.path} holds sizes ${sizes.join(', ')}; the set writes ${ICO_SIZES.join(', ')}.`);
            }
            continue;
        }
        const { width, height } = await sharp(path).metadata();
        if (width !== target.size || height !== target.size) {
            problems.push(`${target.path} is ${width}x${height}; the set writes ${target.size}x${target.size}.`);
        }
    }
    const manifestPath = join(publicDir, 'manifest.json');
    if (!existsSync(manifestPath)) {
        problems.push(`manifest.json is missing from ${publicDir}.`);
        return problems;
    }
    const byPath = new Map(targets.map((target) => [target.path, target]));
    for (const { src, sizes } of JSON.parse(readFileSync(manifestPath, 'utf8')).icons ?? []) {
        const target = byPath.get(src);
        if (!target) {
            problems.push(`manifest.json names ${src}, which the set does not write.`);
        } else if (target.kind !== 'ico' && `${target.size}x${target.size}` !== sizes) {
            problems.push(`manifest.json says ${src} is ${sizes}; the set writes ${target.size}x${target.size}.`);
        }
    }
    return problems;
}
