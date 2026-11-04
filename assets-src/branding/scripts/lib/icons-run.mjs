import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { buildIconSet, DRAFT_SIZES, findPublicMismatches, HAND_FIXED_SIZES, LINES_FROM, MASKABLE_PATH, planTargets } from './icon-set.mjs';
import { coverageDraft } from './icon-render.mjs';
import { draftSheet, patchSheet, sizesSheet } from './icon-sheets.mjs';
import { appendLogEntry, makeLogEntry, sha256 } from './log.mjs';
import { applyPixelPatch, parsePixelPatch } from './pixel-patch.mjs';
import { encodePng } from './raster.mjs';
import { resolveOutDir } from './run.mjs';
import { checkFinalSvg } from './svg-checks.mjs';

const SOURCE_FILES = { plate: 'logo-plate.svg', plateNolines: 'logo-plate-nolines.svg', emblem: 'logo-emblem.svg', emblemNolines: 'logo-emblem-nolines.svg' };

function readText(path, what) {
    try {
        return readFileSync(path, 'utf8');
    } catch (error) {
        throw new Error(`${what} could not be read from ${path}: ${error.message}`);
    }
}

function readPatch(path, picture) {
    const text = readText(path, 'The pixel-fix patch');
    try {
        return { ops: parsePixelPatch(JSON.parse(text), picture), sha256: sha256(Buffer.from(text)) };
    } catch (error) {
        throw new Error(`${path}: ${error.message}`);
    }
}

function writeAll(root, files) {
    for (const [path, bytes] of files) {
        const absolute = join(root, path);
        mkdirSync(dirname(absolute), { recursive: true });
        writeFileSync(absolute, bytes);
    }
}

/**
 * Builds the favicon and app icon set from the approved logo SVGs.
 *
 * Drafts (area coverage) and contact sheets go under `outDir`, together with the whole set as it would be written (`outDir/public/`).
 * Only a `write` run puts the files into `publicDir` and appends a line to the log; without it nothing outside `out/` changes.
 * Files that are replaced in place must already exist in `publicDir` at the size the set writes, and the web manifest may only name files the set writes.
 * @param {{ rootDir: string, publicDir: string, outDir: string, write?: boolean, now?: () => Date }} request
 */
export async function runIcons({ rootDir, publicDir, outDir, write = false, now = () => new Date() }) {
    const out = resolveOutDir(rootDir, outDir);
    const svgs = {};
    for (const [key, name] of Object.entries(SOURCE_FILES)) {
        svgs[key] = readText(join(rootDir, 'approved', name), 'The approved logo');
        checkFinalSvg(svgs[key], name);
    }

    const drafts = new Map(await Promise.all(DRAFT_SIZES.map(async (size) => [size, await coverageDraft(svgs.plateNolines, size)])));
    const patches = {};
    const patched = {};
    for (const size of HAND_FIXED_SIZES) {
        patches[size] = readPatch(join(rootDir, 'fixes', `logo-${size}.json`), drafts.get(size));
        patched[size] = applyPixelPatch(drafts.get(size), patches[size].ops);
    }

    const mismatches = await findPublicMismatches(publicDir);
    if (mismatches.length > 0) {
        throw new Error(`The icon set does not match ${publicDir}:\n${mismatches.map((line) => `  ${line}`).join('\n')}`);
    }

    const files = await buildIconSet({ svgs, patches: Object.fromEntries(HAND_FIXED_SIZES.map((size) => [size, patches[size].ops])) });

    const draftPngs = await Promise.all(DRAFT_SIZES.map(async (size) => ({ size, png: await encodePng(drafts.get(size)) })));
    const patchedPngs = Object.fromEntries(await Promise.all(HAND_FIXED_SIZES.map(async (size) => [size, await encodePng(patched[size].raster)])));
    const pictures = new Map([
        ...draftPngs.map(({ size, png }) => [join('drafts', `draft-${size}.png`), png]),
        ...HAND_FIXED_SIZES.map((size) => [join('drafts', `patched-${size}.png`), patchedPngs[size]]),
    ]);
    const sheets = new Map([
        [join('sheets', 'drafts.png'), await draftSheet(draftPngs)],
        [join('sheets', 'patches.png'), await patchSheet(HAND_FIXED_SIZES.map((size) => ({ size, draft: draftPngs.find((draft) => draft.size === size).png, patched: patchedPngs[size], edits: patches[size].ops.length, changed: patched[size].changed })))],
        [join('sheets', 'sizes.png'), await sizesSheet(sheetIcons(files))],
    ]);
    writeAll(out, pictures);
    writeAll(out, sheets);
    writeAll(join(out, 'public'), files);

    if (write) {
        writeAll(publicDir, files);
        appendLogEntry(join(rootDir, 'log', 'generations.jsonl'), makeLogEntry({
            time: now().toISOString(),
            stage: 's4',
            provider: 'local',
            model: 'icons',
            template: 'icons',
            vars: {
                linesFrom: LINES_FROM,
                patches: Object.fromEntries(HAND_FIXED_SIZES.map((size) => [`fixes/logo-${size}.json`, patches[size].sha256])),
            },
            refHashes: Object.values(svgs).map((svg) => sha256(Buffer.from(svg))),
            size: '16-512',
            outputs: [...files].map(([path, bytes]) => ({ file: `public/${path}`, sha256: sha256(bytes) })),
            estimatedUsd: 0,
        }));
    }
    return {
        files: [...files].map(([path, bytes]) => ({ path, bytes: bytes.length })),
        drafts: [...pictures.keys()],
        sheets: [...sheets.keys()],
        patches: Object.fromEntries(HAND_FIXED_SIZES.map((size) => [size, { edits: patches[size].ops.length, changed: patched[size].changed }])),
        wrote: write,
    };
}

/** The plate icons, apple icons and the maskable icon out of a built set, for the sizes sheet. */
function sheetIcons(files) {
    const of = (prefix) => planTargets().filter(({ path }) => path.startsWith(prefix)).map(({ path, size }) => ({ size, png: files.get(path) }));
    return { plates: of('img/icon-'), apples: of('img/apple-icon-'), maskable: files.get(MASKABLE_PATH) };
}
