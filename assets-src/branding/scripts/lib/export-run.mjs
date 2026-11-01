import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import sharp from 'sharp';
import { DENSITIES, chooseEncoding, frameBox, outputSize, renderFrame, resizeFrame } from './export-art.mjs';
import { sha256 } from './log.mjs';
import { readRaster } from './raster.mjs';
import { resolveOutDir } from './run.mjs';

const MANIFEST = 'manifest.json';
const toPosix = (rootDir, path) => relative(rootDir, path).split(sep).join('/');
const kilobytes = (bytes) => `${(bytes / 1024).toFixed(1)} KB`;

/** Masters are looked up from the package root, like the other tools' inputs. */
const resolveMaster = (rootDir, path) => (isAbsolute(path) ? path : resolve(rootDir, path));

/**
 * Exports every asset of a parsed spec: frames the subject in its master, resizes the frame with Lanczos3 to each CSS size at 1x, 2x
 * and 3x, encodes WebP, and writes `<id>@<css>x<density>.webp` plus manifest.json into `outDir` (inside raw/ or out/).
 * Everything is read, resized and encoded before the first file is written, so a bad master or a size the master cannot supply
 * leaves the folder as it was. Files of an exported asset from an earlier run are removed; other assets in the manifest are kept.
 * @param {{ rootDir: string, spec: ReturnType<typeof import('./export-art.mjs').parseExportSpec>, outDir: string, only?: string[] }} request
 */
export async function exportAssets({ rootDir, spec, outDir, only }) {
    const absoluteOut = resolveOutDir(rootDir, outDir);
    const chosen = only ? spec.assets.filter(({ id }) => only.includes(id)) : spec.assets;
    for (const id of only ?? []) {
        if (!spec.assets.some((asset) => asset.id === id)) {
            throw new Error(`--only names "${id}", which the spec does not have. It has: ${spec.assets.map(({ id: known }) => known).join(', ')}.`);
        }
    }

    const results = [];
    for (const asset of chosen) {
        const masterPath = resolveMaster(rootDir, asset.master);
        if (!existsSync(masterPath)) {
            throw new Error(`${asset.id}: the master ${asset.master} does not exist.`);
        }
        const master = await readRaster(masterPath);
        const frame = frameBox(master, { crop: asset.crop, margin: asset.margin, square: asset.square, alphaThreshold: spec.alphaThreshold });
        const framed = renderFrame(master, frame);
        const sizes = asset.css.flatMap((css) => DENSITIES.map((density) => ({ css, density, ...outputSize(frame, { css, density, fit: asset.fit }) })));
        const rasters = [];
        for (const size of sizes) {
            rasters.push(await resizeFrame(framed, size));
        }
        const encoding = await chooseEncoding(rasters, { webp: asset.webp });
        results.push({
            id: asset.id,
            character: asset.character,
            focus: asset.focus,
            master: toPosix(rootDir, masterPath),
            masterSha256: sha256(readFileSync(masterPath)),
            frame,
            fit: asset.fit,
            encoding: { mode: encoding.mode, quality: encoding.quality, totals: encoding.totals },
            variants: sizes.map((size, index) => ({
                file: `${asset.id}@${size.css}x${size.density}.webp`,
                css: size.css,
                density: size.density,
                width: size.width,
                height: size.height,
                bytes: encoding.files[index].bytes,
                mode: encoding.files[index].mode,
                quality: encoding.files[index].quality,
                candidates: encoding.files[index].candidates,
                buffer: encoding.files[index].buffer,
            })),
        });
    }

    mkdirSync(absoluteOut, { recursive: true });
    for (const result of results) {
        for (const stale of readdirSync(absoluteOut).filter((name) => name.startsWith(`${result.id}@`) && name.endsWith('.webp'))) {
            unlinkSync(join(absoluteOut, stale));
        }
        for (const variant of result.variants) {
            writeFileSync(join(absoluteOut, variant.file), variant.buffer);
        }
    }
    writeManifest(absoluteOut, results);
    return { assets: results, outDir: absoluteOut };
}

/** Writes manifest.json: this run's assets in spec order, after the entries of other assets that were already there. */
function writeManifest(outDir, results) {
    const path = join(outDir, MANIFEST);
    const previous = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')).assets : {};
    const assets = Object.fromEntries(Object.entries(previous).filter(([id]) => !results.some((result) => result.id === id)));
    for (const result of results) {
        assets[result.id] = {
            master: result.master,
            masterSha256: result.masterSha256,
            frame: result.frame,
            fit: result.fit,
            encoding: { mode: result.encoding.mode, quality: result.encoding.quality },
            totalsBytes: result.encoding.totals,
            variants: result.variants.map(({ buffer, ...variant }) => variant),
        };
    }
    writeFileSync(path, `${JSON.stringify({ assets }, null, 2)}\n`);
}

/** The label of one variant for the sheet and the report: what it is, its pixel size, and the real size of the file. */
export function variantLines(asset, variant) {
    const encoding = variant.mode === 'lossless' ? 'lossless' : `${variant.mode} q${variant.quality}`;
    return [
        `${asset.id}@${variant.css}x${variant.density}`,
        `${variant.width}x${variant.height} (${variant.density}x of ${variant.css} CSS px)`,
        `${kilobytes(variant.bytes)}, ${encoding}`,
    ];
}

/** Decodes a variant's own bytes, so a sheet shows what the browser will get. */
export async function decodeVariant(variant) {
    const { data, info } = await sharp(variant.buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    return { width: info.width, height: info.height, data };
}
