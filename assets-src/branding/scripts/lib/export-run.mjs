import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import sharp from 'sharp';
import { DENSITIES, assertSnapped, chooseEncoding, encodeNative, frameBox, outputSize, renderFrame, resizeFrame } from './export-art.mjs';
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
 * A pixel asset (`"pixel": true`) is not resized: its snapped master is framed in art pixels and stored at its own size as lossless
 * PNG or WebP, whichever is smaller, as `<id>@native.png` or `.webp`, and the manifest records its native size.
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
        if (asset.pixel) {
            assertSnapped(master, `${asset.id}: the master ${asset.master}`);
        }
        const frame = frameBox(master, { crop: asset.crop, margin: asset.margin, square: asset.square, alphaThreshold: spec.alphaThreshold });
        const framed = renderFrame(master, frame);
        if (asset.pixel) {
            results.push(await pixelResult({ rootDir, asset, masterPath, frame, framed }));
            continue;
        }
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
            src: `${asset.id}@${asset.src.css}x${asset.src.density}.webp`,
            variants: sizes.map((size, index) => ({
                file: `${asset.id}@${size.css}x${size.density}.webp`,
                src: size.css === asset.src.css && size.density === asset.src.density,
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
        for (const stale of readdirSync(absoluteOut).filter((name) => name.startsWith(`${result.id}@`) && (name.endsWith('.webp') || name.endsWith('.png')))) {
            unlinkSync(join(absoluteOut, stale));
        }
        for (const variant of result.variants) {
            writeFileSync(join(absoluteOut, variant.file), variant.buffer);
        }
    }
    writeManifest(absoluteOut, results);
    return { assets: results, outDir: absoluteOut };
}

/** The export result of a pixel asset: one variant, the framed snapped picture at its own size. */
async function pixelResult({ rootDir, asset, masterPath, frame, framed }) {
    const encoded = await encodeNative(framed);
    const file = `${asset.id}@native.${encoded.format}`;
    return {
        id: asset.id,
        character: asset.character,
        focus: asset.focus,
        master: toPosix(rootDir, masterPath),
        masterSha256: sha256(readFileSync(masterPath)),
        frame,
        pixel: true,
        native: { width: framed.width, height: framed.height },
        encoding: { mode: 'lossless', format: encoded.format, quality: undefined, totals: { png: encoded.candidates.png.bytes, webp: encoded.candidates.webp.bytes } },
        src: file,
        variants: [{ file, src: true, native: true, format: encoded.format, width: framed.width, height: framed.height, bytes: encoded.buffer.length, mode: 'lossless', quality: undefined, candidates: encoded.candidates, buffer: encoded.buffer }],
    };
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
            ...(result.pixel ? { pixel: true, native: result.native } : { fit: result.fit }),
            src: result.src,
            encoding: { mode: result.encoding.mode, quality: result.encoding.quality, ...(result.pixel ? { format: result.encoding.format } : {}) },
            totalsBytes: result.encoding.totals,
            variants: result.variants.map(({ buffer, ...variant }) => variant),
        };
    }
    writeFileSync(path, `${JSON.stringify({ assets }, null, 2)}\n`);
}

/** The label of one variant for the sheet and the report: what it is, its pixel size, and the real size of the file. */
export function variantLines(asset, variant) {
    if (variant.native) {
        return [`${asset.id}@native`, `${variant.width}x${variant.height} native (shown at whole-number steps)`, `${kilobytes(variant.bytes)}, lossless ${variant.format}`];
    }
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
