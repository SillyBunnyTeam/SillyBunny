import { existsSync, readFileSync } from 'node:fs';
import { sameCardText } from './card.js';
import { unlistedFiles } from './check.js';
import { decode, encoderMismatches, encoderVersions } from './codec.js';
import { deriveAsset, isDerived, staleLayerBoxes } from './derive.js';
import { readIco } from './ico.js';
import { outputFile, outputsOf } from './manifest.js';
import { ArtProblem } from './problem.js';
import { samePixels, sha256, upscaleNearest } from './raster.js';

/**
 * Derives the art again in memory and compares it with what ships. By bytes, every derived file must equal the file on
 * disk and the sha256 the manifest records. With `pixels`, an encoded picture is compared by its decoded pixels only, for
 * a platform whose encoder gives other bytes; data files are still compared by their bytes. Nothing is written.
 * @param {string} root
 * @param {any} manifest A manifest that passed `validateManifest`.
 * @param {{ only?: string[], pixels?: boolean }} [options]
 */
export async function proveArt(root, manifest, { only, pixels = false } = {}) {
    const problems = [];
    const encoder = { expected: manifest.encoder, actual: encoderVersions() };
    const mode = pixels ? 'pixels' : 'bytes';
    const byteComparison = pixels ? 'skipped for encoded pictures, which were compared by their decoded pixels' : 'done';
    const summary = { assets: 0, derived: 0, pinned: 0, outputs: 0, proven: 0, pinnedFiles: 0 };
    if (!pixels) {
        for (const mismatch of encoderMismatches(manifest.encoder)) {
            problems.push({
                code: 'encoder-mismatch',
                ...mismatch,
                message: `This install has ${mismatch.library} ${mismatch.actual}, but the shipped bytes were made with ${mismatch.expected}. Run npm ci --prefix scripts/art, or prove with --pixels.`,
            });
        }
        if (problems.length > 0) {
            return { mode, byteComparison: 'not started', encoder, summary, problems };
        }
    }
    const selected = Object.entries(manifest.assets).filter(([id]) => !only || only.includes(id));
    for (const [id, asset] of selected) {
        summary.assets++;
        if (!isDerived(asset)) {
            summary.pinned++;
            summary.pinnedFiles += asset.outputs.length;
            problems.push(...await provePinned(root, id, asset));
            continue;
        }
        summary.derived++;
        let files;
        try {
            files = await deriveAsset(root, id, asset, manifest);
        } catch (error) {
            if (!(error instanceof ArtProblem)) {
                throw error;
            }
            problems.push({ asset: id, ...error.toJSON() });
            continue;
        }
        for (const { layer, recorded, box } of staleLayerBoxes(asset, files)) {
            problems.push({ code: 'manifest-stale', asset: id, expected: box, actual: recorded, message: `The manifest records the box [${recorded.join(', ')}] for the layer ${layer}, but the derive measures [${box.join(', ')}] on the placement grid. Run derive --write.` });
        }
        const recorded = new Map(outputsOf(asset).map(({ path, sha256: digest }) => [path, digest]));
        for (const file of files) {
            summary.outputs++;
            const problem = await proveFile(root, id, file, recorded.get(file.path), pixels);
            if (problem) {
                problems.push(problem);
            } else {
                summary.proven++;
            }
        }
    }
    if (!only) {
        problems.push(...unlistedFiles(root, manifest));
    }
    return { mode, byteComparison, encoder, summary, problems };
}

async function proveFile(root, id, file, recorded, pixels) {
    const path = outputFile(root, file.path);
    if (!existsSync(path)) {
        return { code: 'output-missing', asset: id, path: file.path, message: `${file.path} does not exist.` };
    }
    const shipped = readFileSync(path);
    if (pixels && file.kind !== 'data') {
        return await showSamePixels(file.kind, shipped, file.bytes)
            ? null
            : { code: 'output-stale', asset: id, path: file.path, message: `${file.path} does not show the pixels its master gives${file.kind === 'card' ? ', or does not carry the card text its text source gives' : ''}.` };
    }
    const digest = sha256(shipped);
    if (digest !== file.sha256) {
        return { code: 'output-stale', asset: id, path: file.path, expected: file.sha256, actual: digest, message: `${file.path} is not the file its master gives. Run derive --write.` };
    }
    if (recorded !== file.sha256) {
        return { code: 'manifest-stale', asset: id, path: file.path, expected: file.sha256, actual: recorded, message: `The manifest records another sha256 for ${file.path}. Run derive --write.` };
    }
    return null;
}

/**
 * An ICO holds PNG pictures, so two ICOs show the same pixels when their entries, taken in order, do. A card is a picture
 * that carries text, so two cards are the same only when their text is too.
 */
async function showSamePixels(kind, one, two) {
    if (kind === 'picture' || kind === 'card') {
        return samePixels(await decode(one), await decode(two)) && (kind === 'picture' || await sameCardText(one, two));
    }
    const [first, second] = [readIco(one), readIco(two)];
    if (first.length !== second.length) {
        return false;
    }
    for (let at = 0; at < first.length; at++) {
        if (!samePixels(await decode(first[at]), await decode(second[at]))) {
            return false;
        }
    }
    return true;
}

async function provePinned(root, id, asset) {
    const problems = [];
    const pictures = [];
    for (const output of asset.outputs) {
        const path = outputFile(root, output.path);
        if (!existsSync(path)) {
            problems.push({ code: 'output-missing', asset: id, path: output.path, message: `${output.path} does not exist.` });
            continue;
        }
        const bytes = readFileSync(path);
        pictures.push(bytes);
        if (sha256(bytes) !== output.sha256) {
            problems.push({ code: 'pinned-changed', asset: id, path: output.path, message: `${output.path} is not the pinned file, and it has no master to derive it from.` });
        }
    }
    if (asset.checks?.includes('nearest-pair') && pictures.length === 2) {
        const [one, two] = await Promise.all(pictures.map(decode));
        if (!samePixels(upscaleNearest(one, 2), two)) {
            problems.push({ code: 'pair-mismatch', asset: id, path: asset.outputs[1].path, message: `${asset.outputs[1].path} is not ${asset.outputs[0].path} with every pixel drawn as 2 by 2.` });
        }
    }
    return problems;
}
