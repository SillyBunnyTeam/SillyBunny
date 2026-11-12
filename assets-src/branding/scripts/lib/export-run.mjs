import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import sharp from 'sharp';
import { DENSITIES, assertSnapped, chooseEncoding, encodeNative, frameBox, outputSize, renderFrame, resizeFrame } from './export-art.mjs';
import { sha256 } from './log.mjs';
import { opaqueBox, readRaster } from './raster.mjs';
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
 * PNG or WebP, whichever is smaller, as `<id>@native.png` or `.webp`, and the manifest records its native size. The `frames` of a pixel asset
 * (the later pictures of an animation) are cut with the base's frame, so they line up pixel for pixel, are stored in the base's format as
 * `<id>--<frame id>@native`, and are listed after the base, in order, under `frames` in the manifest. A frame must be the size of the base
 * with the same opaque box, or the export is refused.
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
            results.push(await pixelResult({ rootDir, asset, master, masterPath, frame, framed, alphaThreshold: spec.alphaThreshold }));
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
    const previous = readManifest(absoluteOut);
    for (const result of results) {
        const earlierFrames = (previous[result.id]?.frames ?? []).map(({ file }) => file);
        for (const stale of readdirSync(absoluteOut).filter((name) => (name.startsWith(`${result.id}@`) && (name.endsWith('.webp') || name.endsWith('.png'))) || earlierFrames.includes(name))) {
            unlinkSync(join(absoluteOut, stale));
        }
        for (const { buffer, file } of [...result.variants, ...(result.frames ?? []).map(({ variant }) => variant)]) {
            writeFileSync(join(absoluteOut, file), buffer);
        }
    }
    writeManifest(absoluteOut, results);
    return { assets: results, outDir: absoluteOut };
}

/**
 * The export result of a pixel asset: one variant, the framed snapped picture at its own size, and a `frames` entry for each later picture of
 * its animation, cut with the same frame. Every frame is checked against the base before anything is encoded.
 */
async function pixelResult({ rootDir, asset, master, masterPath, frame, framed, alphaThreshold }) {
    const encoded = await encodeNative(framed);
    const file = `${asset.id}@native.${encoded.format}`;
    const frames = [];
    for (const { id, master: framePath } of asset.frames) {
        frames.push(await frameResult({ rootDir, asset, frameId: id, framePath, master, frame, alphaThreshold, format: encoded.format }));
    }
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
        frames,
    };
}

/** One later picture of an animation, cut with the base's frame and stored in the base's format; it must be the base's size with the base's opaque box. */
async function frameResult({ rootDir, asset, frameId, framePath, master, frame, alphaThreshold, format }) {
    const name = `${asset.id}--${frameId}`;
    const path = resolveMaster(rootDir, framePath);
    if (!existsSync(path)) {
        throw new Error(`${name}: the frame picture ${framePath} does not exist.`);
    }
    const picture = await readRaster(path);
    assertSnapped(picture, `${name}: the frame picture ${framePath}`);
    if (picture.width !== master.width || picture.height !== master.height) {
        throw new Error(`${name}: the frame picture ${framePath} is ${picture.width}x${picture.height} art pixels and the base ${asset.master} is ${master.width}x${master.height}. Frames of one animation are the same size.`);
    }
    const [one, other] = [opaqueBox(master, alphaThreshold), opaqueBox(picture, alphaThreshold)];
    if (['x', 'y', 'width', 'height'].some((key) => one?.[key] !== other?.[key])) {
        throw new Error(`${name}: the figure of ${framePath} is at ${boxText(other)} and the base's is at ${boxText(one)}. A frame is cut with the base's frame, so it would sit differently on the page; snap it with snap.mjs --grid-from.`);
    }
    const framed = renderFrame(picture, frame);
    const encoded = await encodeNative(framed, { format });
    const file = `${name}@native.${encoded.format}`;
    return {
        id: name,
        master: toPosix(rootDir, path),
        masterSha256: sha256(readFileSync(path)),
        variant: { file, src: true, native: true, format: encoded.format, width: framed.width, height: framed.height, bytes: encoded.buffer.length, mode: 'lossless', quality: undefined, candidates: encoded.candidates, buffer: encoded.buffer },
    };
}

const boxText = (box) => (box ? `${box.width}x${box.height} at ${box.x},${box.y}` : 'nowhere');

const readManifest = (outDir) => {
    const path = join(outDir, MANIFEST);
    return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')).assets : {};
};

/** Writes manifest.json: this run's assets in spec order, after the entries of other assets that were already there. */
function writeManifest(outDir, results) {
    const path = join(outDir, MANIFEST);
    const previous = readManifest(outDir);
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
            ...(result.frames?.length > 0 ? { frames: framesOfManifest(result) } : {}),
        };
    }
    writeFileSync(path, `${JSON.stringify({ assets }, null, 2)}\n`);
}

/** The pictures of an animation in the order they play: the base first, then each frame, with the id and the file of each. */
function framesOfManifest(result) {
    const [base] = result.variants;
    const entry = (id, master, masterSha256, { file, format, bytes }) => ({ id, file, format, bytes, master, masterSha256 });
    return [entry(result.id, result.master, result.masterSha256, base), ...result.frames.map(({ id, master, masterSha256, variant }) => entry(id, master, masterSha256, variant))];
}

/** The label of one variant for the sheet and the report: what it is, its pixel size, and the real size of the file. */
export function variantLines(asset, variant) {
    if (variant.native) {
        return [variant.file.replace(/\.\w+$/, ''), `${variant.width}x${variant.height} native (shown at whole-number steps)`, `${kilobytes(variant.bytes)}, lossless ${variant.format}`];
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
